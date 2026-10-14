import { readState, mutateState, replaceBank, restoreBackup, exportBackup, exportListCSV, ingestGrammarKeys } from "./data.js";
import { localDay, frequencySort, labelFor, buildSession, currentItem, gradeSession, advanceSession, isFunctionWord, matchesLevel } from "./engine.js";
import { buildGrammarQuestions, clozePrompt, matchGrammarAnswer, recordGrammarResponse } from "./grammar.js";
import { speakEnglish, stopSpeaking } from "./speech.js";

const names = { words: "單字", phrases: "片語", grammar: "文法", levels: "分級單字" };
const kinds = Object.keys(names);
const studyKinds = ["words", "phrases", "levels"];
const bankTitle = kind => kind === "levels" ? "依級別複習單字" : kind === "grammar" ? "文法原題練習" : `按頻率排序${names[kind]}`;
const app = document.querySelector("#app");
const notice = document.querySelector("#notice");
let state;
let busy = false;
let listPage = 0;
let selectedLevel = "1";
let listFilters = { kind: "words", status: "all", level: "all", sort: "frequency", query: "", eligible: true };
const channel = "BroadcastChannel" in window ? new BroadcastChannel("english-review-state") : null;

const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const byId = id => document.getElementById(id);
const today = () => localDay();
const statFor = (kind, id) => state.stats[kind]?.[id];
const isToday = stat => stat?.days?.includes(today());
const remaining = kind => Math.max(0, state.settings[kind].target - poolFor(kind).filter(card => isToday(statFor(kind, card.id))).length);
const activeSession = kind => state.sessions[kind] && !state.sessions[kind].completed;
const levelLabel = card => [card.details?.ceec_level, card.details?.level, card.level]
  .find(value => value != null && String(value).trim() !== "") ?? "未標註";
const speechButton = card => `<button class="secondary small" type="button" data-speak="${escape(card.english)}" aria-label="朗讀 ${escape(card.english)}">▶ 發音</button>`;

function poolFor(kind, level = kind === "levels" ? selectedLevel : "all") {
  return state.banks[kind].filter(card =>
    matchesLevel(card, level) &&
    (!["words", "levels"].includes(kind) || !state.settings[kind].excludeFunctionWords || !isFunctionWord(card)));
}

function announce(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle("error", error);
  if (error) console.error(message);
}

function errorMessage(error) {
  if (error?.name === "QuotaExceededError") return "裝置儲存空間不足，操作未完成；既有資料仍保留。請先匯出備份並釋放空間。";
  return error?.message || "操作失敗，請重試。";
}

async function action(operation, success = "") {
  if (busy) { announce("正在處理上一個操作，請稍候完成。"); return; }
  busy = true;
  app.setAttribute("aria-busy", "true");
  const buttons = [...app.querySelectorAll("button:not(:disabled)")];
  buttons.forEach(button => { button.disabled = true; });
  try {
    await operation();
    channel?.postMessage({ revision: state.revision });
    if (success) announce(success);
  } catch (error) {
    announce(errorMessage(error), true);
    try {
      const latest = await readState();
      const changed = latest.revision !== state.revision;
      state = latest;
      if (changed) render();
    } catch (readError) { announce(errorMessage(readError), true); }
  } finally {
    busy = false;
    buttons.forEach(button => { if (button.isConnected) button.disabled = false; });
    app.removeAttribute("aria-busy");
  }
}

async function commit(transform) {
  state = await mutateState(state.revision, transform);
}

function bankNumbers(kind, cards = state.banks[kind]) {
  const stats = cards.map(card => statFor(kind, card.id)).filter(Boolean);
  return {
    total: cards.length,
    seen: stats.filter(stat => stat.attempts > 0).length,
    correct: stats.filter(stat => stat.status === "correct").length,
    wrong: stats.filter(stat => stat.status === "wrong").length,
    today: stats.filter(isToday).length
  };
}

function emptyBank(kind) {
  return `<section class="card empty"><h2>尚未匯入${names[kind]}</h2><p class="muted">選取你的本機 CSV 一次，之後就能直接開始，無須重複選檔。</p><a class="button" href="#settings">前往設定與匯入</a></section>`;
}

function home() {
  app.innerHTML = `<p class="eyebrow">一點一滴，累積你的英文</p><h1>今天，從一小段複習開始</h1><p class="muted">${today()} · 本機學習紀錄 · 先學高頻，再鞏固弱項</p>
    <div class="grid">${kinds.map(kind => {
      const imported = state.banks[kind].length;
      const n = bankNumbers(kind, studyKinds.includes(kind) ? poolFor(kind, "all") : state.banks[kind]);
      const target = state.settings[kind].target;
      if (kind === "grammar" && n.total) {
        const questions = buildGrammarQuestions(state.banks.grammar);
        const verified = questions.filter(question => matchGrammarAnswer(question, state.grammarKeys)).length;
        return `<section class="card"><span class="badge">${n.total} 個分類 · ${questions.length} 道原題</span><h2 class="section-heading">文法原題練習</h2><p>依分類選擇真正的填空題／原始選項，不再考文法名稱翻譯。</p><p class="muted">已保存 ${Object.values(state.grammarWork.answers).filter(answer => answer.submitted).length} 道作答 · ${verified} 道已對應答案，可自動判分</p><a class="button" href="#grammar">開始／繼續原題</a></section>`;
      }
      return `<section class="card"><span class="badge">${imported ? `${imported.toLocaleString()} 筆已匯入` : "等待匯入"}</span><h2 class="section-heading">${bankTitle(kind)}</h2>
        ${imported ? `<div class="stats"><div><strong>${n.today}${kind === "levels" ? "" : ` / ${target}`}</strong><span>今日不同已答項目${kind === "levels" ? "（各級合計）" : ""}</span></div><div><strong>${n.total - n.seen}</strong><span>可練習的未見項目</span></div></div>
          ${kind === "levels" ? "<p>選擇第 1 至第 6 級，每級分開安排每日目標。</p>" : `<progress aria-label="${names[kind]}今日進度" value="${Math.min(n.today, target)}" max="${target}"></progress>`}
          <p class="muted">累計已答 ${n.seen} · 答對清單 ${n.correct} · 答錯清單 ${n.wrong}</p>
          ${["words", "levels"].includes(kind) && state.settings[kind].excludeFunctionWords ? `<p class="muted">已排除 ${state.banks[kind].filter(isFunctionWord).length} 個虛詞作為測試目標，資料仍保留。</p>` : ""}
          <div class="actions"><a class="button" href="#bank-${kind}">${activeSession(kind) ? "繼續／安排複習" : "安排今日複習"}</a></div>`
        : `<p class="muted">你的題庫尚未準備。匯入後，進度會自動保存在此裝置。</p><a class="button" href="#settings">匯入${names[kind]} CSV</a>`}
      </section>`;
    }).join("")}</div>
    <h2 class="section-heading">把不熟的，慢慢變熟</h2><div class="grid">${studyKinds.map(kind => `<a class="card" href="#wrong-${kind}"><h3>複習答錯的${names[kind]}</h3><p class="muted">${bankNumbers(kind, poolFor(kind, "all")).wrong} 筆符合設定待加強 · 連續答對 3 次才移出</p></a>`).join("")}</div>
    <div class="hint">答錯也算一次練習，但不會直接變成熟悉。每日目標計算「不同項目」，重試不重複計數。<br>頻率僅代表匯入語料中的出現次數，並非所有歷年試題的完整統計。</div>`;
}

function bankSetup(kind, purpose) {
  if (kind === "grammar") { grammarView(); return; }
  if (!state.banks[kind].length) { app.innerHTML = emptyBank(kind); return; }
  const config = state.settings[kind];
  const n = bankNumbers(kind, poolFor(kind));
  const old = state.sessions[kind];
  app.innerHTML = `<div class="study"><p class="eyebrow">${purpose === "wrong" ? "額外弱項練習" : "每日複習"}</p><h1>${purpose === "wrong" ? `複習答錯的${names[kind]}` : bankTitle(kind)}</h1>
    ${kind === "levels" ? `<div class="card"><label for="study-level">選擇複習級別</label><select id="study-level">${[1, 2, 3, 4, 5, 6].map(level => `<option value="${level}" ${String(level) === selectedLevel ? "selected" : ""}>第 ${level} 級</option>`).join("")}</select><p class="muted">依匯入詞表的級別。詞條只顯示中英文與發音，不顯示語料來源及出現次數。</p></div>` : ""}
    <p class="muted">${kind === "levels" ? `第 ${selectedLevel} 級` : "此題庫"}符合目前設定 ${n.total} 筆 · 累計已答 ${n.seen} · 尚未練習 ${n.total - n.seen}</p>
    ${old && !old.completed ? `<section class="card"><h2>有已儲存的進度</h2><p>${old.day} · ${old.purpose === "wrong" ? "答錯複習" : "每日複習"} · 已作答 ${old.attempts} 次</p><a class="button" href="#study-${kind}">繼續已儲存的練習</a>${old.day !== today() ? `<p class="warning">這是較早日期的練習。繼續後，新作答會計入今天；也可以結束舊進度，重新安排。</p>` : ""}</section>` : ""}
    <section class="card">
      <h2>${purpose === "wrong" ? "只選目前仍在答錯清單的項目" : "安排今天的練習"}</h2>
      <p>${purpose === "wrong" ? `目前有 ${n.wrong} 筆答錯項目；每輪最多 ${config.target} 筆。此練習獨立於每日配額，不會偷偷加入新項目。` : `今日已答 ${n.today} 個不同項目，目標 ${config.target}，尚餘 ${remaining(kind)} 個。至少優先選 ${Math.min(config.reviewQuota, remaining(kind))} 個允許的舊項目（若足夠），其餘優先選高頻新項目。`}</p>
      <form id="start-form" class="stack">
        <div><label for="answer-mode">作答方式</label><select id="answer-mode"><option value="typing">看中文 → 輸入英文</option><option value="choice">看英文 → 四選一中文</option></select></div>
        ${purpose === "wrong" ? '<div><label for="wrong-order">答錯複習順序</label><select id="wrong-order"><option value="random">隨機</option><option value="frequency">頻率由高到低</option></select></div>' : ""}
        <p class="muted">${purpose === "daily" ? `納入答對舊項目：${config.includeCorrect ? "是" : "否"}；納入答錯舊項目：${config.includeWrong ? "是" : "否"}。` : ""}答錯後間隔 ${config.retryGap} 個其他已答項目再重試，每個項目每輪最多自動重試一次，避免無限循環；不足時保留在答錯清單。</p>
        <div class="actions"><button type="submit" ${purpose === "wrong" ? (!n.wrong ? "disabled" : "") : (!remaining(kind) ? "disabled" : "")}>${old && !old.completed ? "結束舊進度並開始這一輪" : "開始這一輪"}</button><a href="#settings">調整目標與複習比例</a></div>
      </form>
      ${purpose === "wrong" && !n.wrong ? '<p class="hint">目前沒有答錯項目。</p>' : ""}
      ${purpose === "daily" && !remaining(kind) ? '<p class="hint">今日目標已完成！仍可另開答錯複習；提高設定中的目標，才能增加今日一般練習。</p>' : ""}
    </section>
    ${grammarHelp(kind)}
    <a href="#home">返回首頁</a></div>`;
  byId("study-level")?.addEventListener("change", event => { selectedLevel = event.target.value; bankSetup(kind, purpose); });
  byId("start-form").addEventListener("submit", event => {
    event.preventDefault();
    const mode = byId("answer-mode").value;
    const order = byId("wrong-order")?.value || "frequency";
    if (activeSession(kind) && !confirm("要結束此題庫尚未完成的練習，重新安排嗎？已作答紀錄會保留，未作答項目不會算完成。")) return;
    action(async () => {
      await commit(next => {
        next.sessions[kind] = buildSession({ kind, cards: next.banks[kind], stats: next.stats[kind], settings: next.settings[kind], purpose, mode, order, levelFilter: kind === "levels" ? selectedLevel : "all" });
        return next;
      });
      location.hash = `study-${kind}`;
      render();
    });
  });
}

function grammarHelp(kind) {
  return kind === "grammar" ? '<div class="hint">只有已對應「同一來源、年度、題號」答案的選擇題才自動判分。其餘題目只保存作答，不把 AI 理由當答案。分類只是篩選條件；原始資料未提供完整文章時，不補造上下文。</div>' : "";
}

function grammarView() {
  if (!state.banks.grammar.length) { app.innerHTML = emptyBank("grammar"); return; }
  const questions = buildGrammarQuestions(state.banks.grammar);
  const work = state.grammarWork;
  const filtered = questions.filter(question =>
    (work.category === "all" || question.categories.some(category => category.id === work.category)) &&
    (work.filter === "all" || (work.filter === "wrong" ? work.answers[question.id]?.stat?.status === "wrong" : !work.answers[question.id]?.submitted)));
  const remembered = questions.find(question => question.id === work.currentQuestionId);
  const question = filtered.find(item => item.id === work.currentQuestionId) ||
    (remembered && work.answers[remembered.id]?.submitted ? remembered : filtered[0]);
  const response = question && work.answers[question.id];
  const canRetry = work.filter !== "wrong" || response?.stat?.status === "wrong";
  const key = question && matchGrammarAnswer(question, state.grammarKeys);
  const prompt = question && clozePrompt(question);
  const index = question ? filtered.findIndex(item => item.id === question.id) : -1;
  const nextQuestion = index >= 0 ? filtered[index + 1] : filtered.find(item => item.id !== question?.id);
  app.innerHTML = `<div class="study"><a href="#home">← 返回首頁</a><h1 class="section-heading">文法原題練習</h1>
    <section class="card"><div class="form-grid"><div><label for="grammar-category">文法分類</label><select id="grammar-category"><option value="all">全部分類</option>${state.banks.grammar.map(card => `<option value="${escape(card.id)}" ${work.category === card.id ? "selected" : ""}>${escape(card.chinese)} · ${escape(card.english)}</option>`).join("")}</select></div>
    <div><label for="grammar-filter">題目範圍</label><select id="grammar-filter"><option value="all" ${work.filter === "all" ? "selected" : ""}>全部原題</option><option value="wrong" ${work.filter === "wrong" ? "selected" : ""}>只複習答錯原題</option><option value="unanswered" ${work.filter === "unanswered" ? "selected" : ""}>尚未保存作答</option></select></div></div>
    <p class="muted">符合條件 ${filtered.length} 道 · 全部 ${questions.length} 道 · ${questions.filter(item => matchGrammarAnswer(item, state.grammarKeys)).length} 道有對應答案</p></section>
    ${!question ? '<section class="card empty">目前沒有符合條件的原題。可切換分類或匯入文法題庫。</section>' : `
    <section class="card"><span class="badge">${key ? "已對應答案，可判分" : "答案待核實，不判分"}</span><p class="muted">民國 ${escape(question.year ?? "未標註")} 年 · 第 ${escape(question.number || "未標註")} 題</p>
      <p>${question.categories.map(category => escape(category.chinese)).join("／")}</p>
      <h2 class="prompt grammar-prompt" lang="en">${escape(prompt.before)}${prompt.marker ? `<mark class="cloze-gap">____〔${escape(prompt.marker)}〕</mark>` : ""}${escape(prompt.after)}</h2>
      ${prompt.marker ? '<p class="muted">標示空格對應來源題號；其餘數字保留，原文可於下方核對。</p>' : '<p class="warning">原始摘錄沒有唯一可辨識的本題空格標記，請依原題作答；不自動刪除數字。</p>'}
      ${response?.submitted ? `<div class="feedback ${response.correct === false ? "wrong" : ""}" role="status"><strong>${response.correct === null ? "作答已保存，尚未判分" : response.correct ? "答對了" : "答錯了"}</strong>
        ${response.correct !== true ? `<p>你的答案：${escape(response.answer)}</p>` : ""}
        ${response.correct !== null ? `<p>當次正確答案：${escape(response.expected ?? "原紀錄未保存選項文字")}</p><p class="muted">當次答案來源：${escape(response.answerSource ?? "原紀錄未保存來源")}</p>` : '<p>這次作答尚未依正式答案計分；若現已匯入對應答案，可以按「重新作答本題」。</p>'}
        ${response.stat ? `<p>累計對 ${response.stat.correct}／錯 ${response.stat.wrong} · ${response.stat.status === "wrong" ? `恢復 ${response.stat.streak}/3` : "答對清單"}</p>` : ""}</div>
        <div class="actions"><button id="grammar-next" ${!nextQuestion ? "disabled" : ""}>下一道原題</button><button id="grammar-retry" class="secondary" ${canRetry ? "" : "disabled"}>重新作答本題</button></div>
        ${!canRetry ? '<p class="muted">本題已離開錯題清單；若要額外練習，請切換「全部原題」。</p>' : ""}
        ${!nextQuestion ? '<p class="muted">已到目前範圍的最後一題，可切換分類或返回首頁。</p>' : ""}` :
        `<form id="grammar-answer-form" class="stack">${question.choices.length ?
          `<fieldset><legend>請選擇原題選項</legend>${question.choices.map((choice, choiceIndex) => `<label class="check grammar-option"><input type="radio" name="grammar-answer" value="${escape(choice)}" ${choiceIndex === 0 ? "required" : ""}>${escape(choice)}</label>`).join("")}</fieldset>` :
          '<div><label for="grammar-text">填入你的答案</label><textarea id="grammar-text" name="grammar-answer" rows="3" required></textarea></div>'}
          <button type="submit">${key ? "確認答案" : "保存作答（尚無正式答案）"}</button></form>`}
      <details ${response?.submitted ? "open" : ""}><summary>原文與來源核對</summary><p class="source" lang="en">${escape(question.original)}</p><p class="muted">來源：${escape(question.source)} · PDF 第 ${escape(question.page ?? "?")} 頁</p>
      ${response?.submitted && question.rationale ? `<p class="source">原有 AI 文法說明（非正式答案解析）：${escape(question.rationale)}</p>` : ""}</details>
    </section>`}
    ${grammarHelp("grammar")}<p><a href="#settings">匯入文法題庫／正式答案對照 CSV</a></p></div>`;
  for (const [id, field] of [["grammar-category", "category"], ["grammar-filter", "filter"]]) {
    byId(id).addEventListener("change", event => {
      const value = event.target.value;
      action(async () => {
        await commit(next => { next.grammarWork[field] = value; next.grammarWork.currentQuestionId = null; return next; });
        render();
      });
    });
  }
  if (!question) return;
  byId("grammar-answer-form")?.addEventListener("submit", event => {
    event.preventDefault();
    const answer = new FormData(event.currentTarget).get("grammar-answer");
    action(async () => {
      await commit(next => {
        if (next.grammarWork.answers[question.id]?.submitted) throw new Error("這題已保存，沒有重複計分。");
        next.grammarWork.answers[question.id] = recordGrammarResponse(question, next.grammarKeys, next.grammarWork.answers[question.id], answer);
        next.grammarWork.currentQuestionId = question.id;
        return next;
      });
      render();
    });
  });
  byId("grammar-next")?.addEventListener("click", () => action(async () => {
    if (!nextQuestion) return;
    await commit(next => { next.grammarWork.currentQuestionId = nextQuestion.id; return next; });
    render();
  }));
  byId("grammar-retry")?.addEventListener("click", () => action(async () => {
    if (!canRetry) return;
    await commit(next => {
      const previous = next.grammarWork.answers[question.id];
      next.grammarWork.answers[question.id] = { ...previous, answer: "", correct: null, submitted: false };
      next.grammarWork.currentQuestionId = question.id;
      return next;
    });
    render();
  }));
}

function detailsHTML(card, kind) {
  if (kind === "levels") return "";
  const details = card.details || {};
  const fieldNames = {
    part_of_speech: "詞性", phrase_type: "片語類型", example_en: "例句／原始題目",
    example_origin: "例句來源", example_notes: "例句說明", original_context: "原始語境",
    example_year_roc: "例題民國年",
    example_question: "例題題號", example_pdf_page: "PDF 頁碼", translation_source: "翻譯來源",
    needs_review: "需人工複核", ceec_level_status: "級別標註狀態", corpus_scope: "語料範圍",
    years_roc: "出現民國年", exam_types: "試題類型", gsat_occurrences: "學測出現次數",
    listening_occurrences: "英聽出現次數",
    observed_forms: "觀察到的詞形（非自動接受答案）"
  };
  let html = `<p class="muted">出現次數 ${card.frequency} · 大考中心詞彙級別：${escape(levelLabel(card))}（未標註者不推測）</p>`;
  for (const [key, title] of Object.entries(fieldNames)) {
    if (details[key] === undefined || details[key] === null || details[key] === "") continue;
    const text = typeof details[key] === "object" ? JSON.stringify(details[key], null, 2) : String(details[key]);
    html += `<p class="source"><strong>${title}：</strong>${escape(text)}</p>`;
  }
  if (kind === "grammar") {
    let evidence = details.evidence_json || details.evidence || [];
    if (typeof evidence === "string") {
      try { evidence = JSON.parse(evidence); } catch { evidence = []; }
    }
    html += '<p class="warning">以下是原始材料與 AI 文法說明，不是已核實的原題答案。題號／空格數字保持原樣，請依上下文辨識，不自動刪除數字或補答案。</p>';
    if (Array.isArray(evidence)) {
      const picked = [];
      for (const entry of evidence) {
        if (!picked.some(previous => previous.year_roc === entry.year_roc)) picked.push(entry);
        if (picked.length === 2) break;
      }
      if (picked.length < 2) {
        for (const entry of evidence) {
          if (!picked.includes(entry)) picked.push(entry);
          if (picked.length === 2) break;
        }
      }
      html += picked.map(entry => `<section class="hint source"><strong>原始考題材料（不自動評分）</strong><br>民國 ${escape(entry.year_roc ?? "未標註")} 年 · 題號 ${escape(entry.question ?? "未標註")} · PDF ${escape(entry.pdf_page ?? "?")} 頁<br>來源 ${escape(entry.source_id ?? "未標註")}<p>${escape(entry.evidence ?? "")}</p>${entry.choices?.length ? `<p>原始選項：${escape(Array.isArray(entry.choices) ? entry.choices.map(choice => typeof choice === "object" ? JSON.stringify(choice) : choice).join("\n") : entry.choices)}</p>` : ""}<p>AI 說明（未核實）：${escape(entry.rationale_zh ?? "無")}<br>標註信心：${escape(entry.confidence ?? "未標註")}</p></section>`).join("");
      if (evidence.length > 2) html += `<p class="muted">顯示 ${picked.length} 筆代表材料；匯入資料保留其餘來源，可隨完整備份匯出。</p>`;
    }
  }
  return html;
}

function study(kind) {
  if (kind === "grammar") { grammarView(); return; }
  const session = state.sessions[kind];
  if (!session) { bankSetup(kind, "daily"); return; }
  const item = currentItem(session);
  const card = item && state.banks[kind].find(row => row.id === item.id);
  const feedback = session.feedback;
  const total = session.newCount + session.reviewCount;
  const unique = session.answeredIds.length;
  app.innerHTML = `<div class="study"><div class="actions"><a href="#home">← 儲存並返回首頁</a><span class="badge">${names[kind]} · ${session.purpose === "wrong" ? "額外答錯複習" : "每日練習"}</span></div><h1 class="section-heading">${!item || session.completed ? "這一輪已結束" : "專注眼前這一題"}</h1>
    <p class="muted">${kind === "levels" ? `第 ${session.levelFilter || selectedLevel} 級 · ` : ""}不同已答項目 ${unique} / ${total} · 作答次數 ${session.attempts}<br>本輪安排：新項目 ${session.newCount} · 舊項目 ${session.reviewCount}（不含重試）</p>
    <progress aria-label="本輪不同項目進度" value="${Math.min(unique, total)}" max="${Math.max(total, 1)}"></progress>
    ${session.day !== today() ? '<p class="warning">本輪開始於較早日期；現在的新作答計入今天，不會重複補發一整輪題目。</p>' : ""}
    ${!item || session.completed ? `<section class="card empty"><h2>${total ? "練習已保存" : "目前沒有符合條件的項目"}</h2><p>${total ? `本輪練習 ${unique} 個不同項目，共 ${session.attempts} 次作答。` : "不會使用已關閉的答對／答錯項目來補足數量。請調整設定，或匯入更多資料。"}</p><p class="muted">重試若沒有足夠的其他題目可間隔，會留在答錯清單供下次複習，不立即連續重複。</p><div class="actions"><a class="button" href="#home">回首頁</a><a class="button secondary" href="#wrong-${kind}">查看答錯複習</a></div></section>` : `
      <section class="card section-heading">
        <span class="badge">${item.origin === "new" ? "新項目" : item.origin === "retry" ? "間隔重試" : "舊項目複習"}</span>
        <p class="muted">${session.mode === "typing" ? "看中文，輸入正確英文詞條（大小寫不拘）" : "為英文選出中文意思"}</p>
        <h2 class="prompt" ${session.mode === "choice" ? 'lang="en"' : ""}>${escape(session.mode === "typing" ? labelFor(card) : card.english)}</h2>
        ${session.mode === "choice" && !feedback ? speechButton(card) : ""}
        ${feedback ? feedbackHTML(kind, card, feedback) : questionHTML(session, item, kind)}
      </section>`}
    ${grammarHelp(kind)}
    <p class="muted">進度在每次作答後保存。未送出的答案不計分；可隨時返回首頁暫停。</p></div>`;
  if (!card || session.completed) return;
  if (feedback) {
    byId("next-card").addEventListener("click", () => action(async () => {
      await commit(next => {
        if (next.sessions[kind]?.id !== session.id || next.sessions[kind]?.index !== session.index || !next.sessions[kind]?.feedback) throw new Error("進度已在其他分頁改變，請重新載入。");
        next.sessions[kind] = advanceSession(next.sessions[kind]);
        return next;
      });
      render();
      byId("typed-answer")?.focus();
    }));
    byId("next-card").focus();
  } else if (session.mode === "typing") {
    byId("answer-form").addEventListener("submit", event => {
      event.preventDefault();
      const answer = byId("typed-answer").value;
      if (!answer.trim()) { announce("請先輸入英文答案。", true); return; }
      submitAnswer(kind, item.token, answer);
    });
  } else if (item.choices?.length === 4) {
    app.querySelectorAll("[data-answer]").forEach(button => button.addEventListener("click", () => submitAnswer(kind, item.token, button.dataset.answer)));
  } else {
    byId("switch-typing")?.addEventListener("click", () => action(async () => {
      await commit(next => { next.sessions[kind].mode = "typing"; return next; });
      render();
    }));
  }
}

function questionHTML(session, item, kind) {
  if (session.mode === "typing") return `<form id="answer-form" class="stack"><div><label for="typed-answer">英文答案</label><input id="typed-answer" lang="en" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done"></div><button type="submit">確認答案</button></form>`;
  if (item.choices?.length !== 4) return '<div class="warning">此題庫不足 4 個不同中文意思，無法提供四選一；不會從其他題庫借選項。</div><button id="switch-typing">此輪改為輸入英文</button>';
  return `<div class="choice-grid">${item.choices.map((label, index) => `<button type="button" data-answer="${escape(label)}"><span>${index + 1}.</span> ${escape(label)}</button>`).join("")}</div>`;
}

function feedbackHTML(kind, card, feedback) {
  const stat = statFor(kind, card.id);
  return `<div class="feedback ${feedback.correct ? "" : "wrong"}" role="status"><strong>${feedback.correct ? "答對了" : "這次答錯了，再慢慢記住"}</strong><p>正確詞條：<strong lang="en">${escape(card.english)}</strong><br>中文意思：${escape(labelFor(card))}${feedback.correct ? "" : `<br>你的答案：${escape(feedback.answer)}`}</p>${kind === "levels" ? "" : `<p>${stat?.status === "wrong" ? `仍在答錯清單 · 連續答對 ${stat.streak} / 3` : "已在答對清單"} · 累計答對 ${stat?.correct ?? 0}／答錯 ${stat?.wrong ?? 0}</p>`}</div>
    <div class="actions">${speechButton(card)}<button id="next-card" type="button">下一題／完成本輪 ↵</button></div>
    ${kind === "levels" ? "" : `<details open><summary>例句與來源說明</summary>${detailsHTML(card, kind)}</details>`}`;
}

function submitAnswer(kind, token, answer) {
  action(async () => {
    await commit(next => {
      const result = gradeSession(next.sessions[kind], next.stats[kind], { token, answer, cards: next.banks[kind] });
      if (!result.graded) throw new Error("這題已評分或進度已改變，沒有重複計分。");
      next.sessions[kind] = result.session;
      next.stats[kind] = result.stats;
      return next;
    });
    render();
  });
}

function settings() {
  app.innerHTML = `<h1>設定與匯入</h1><p class="muted">四個獨立題庫，匯入一次就會自動載入。所有檔案只在此裝置處理。</p>
    <section class="warning"><strong>請定期備份：</strong>清除網站資料、無痕模式、換裝置或瀏覽器回收儲存空間，都可能讓本機紀錄消失。安裝到主畫面並不等於雲端備份。</section>
    <div class="grid">${kinds.map(kind => `<section class="card"><h2>${names[kind]}題庫</h2><p>${state.banks[kind].length ? `已匯入 ${state.banks[kind].length.toLocaleString()} 筆 · 自動載入` : "尚未匯入"}</p>
      <label for="import-${kind}">選取${names[kind]} CSV</label><input id="import-${kind}" type="file" accept=".csv,text/csv"><p id="import-status-${kind}" class="muted" role="status">請選取 UTF-8 CSV；會先完整驗證再替換。</p>
      <p class="muted">重匯同一 ID 保留歷史；移除的項目及其紀錄會從此題庫移除。匯入會結束此題庫未完成的練習。</p>${kind === "levels" ? '<p class="muted">分級依本次上傳的詞表，可能與另一版本的大考中心詞表不同，不混用級別。中文釋義另據教材與詞典整理，並非大考中心官方中文，也未經逐條獨立人工核驗。</p>' : ""}</section>`).join("")}</div>
    <section class="card"><h2>文法正式答案</h2><p>先匯入文法題庫，再選擇由正式答案整理的對照 CSV。程式會核對來源、年度、題號及原始選項，不把 AI 理由當答案。</p><label for="import-grammar-keys">選取正式答案對照 CSV</label><input id="import-grammar-keys" type="file" accept=".csv,text/csv"><p id="grammar-keys-status" role="status">目前 ${state.grammarKeys.length} 筆答案對照。替換答案不會清除已保存的作答，既有評分不會被偷偷改寫。</p></section>
    <section class="card"><h2>每日目標與複習方式</h2><form id="settings-form"><div class="grid">${studyKinds.map(kind => {
      const config = state.settings[kind];
      return `<fieldset><legend>${names[kind]}</legend><div class="stack">
        <div><label for="${kind}-target">${kind === "levels" ? "每級每日不同項目目標" : "每日不同項目目標"}</label><input id="${kind}-target" name="${kind}-target" type="number" min="1" step="1" value="${config.target}" required></div>
        <div><label for="${kind}-quota">優先複習舊項目數</label><input id="${kind}-quota" name="${kind}-quota" type="number" min="0" step="1" value="${config.reviewQuota}" required></div>
        <div><label for="${kind}-gap">答錯重試間隔（其他題數）</label><input id="${kind}-gap" name="${kind}-gap" type="number" min="1" step="1" value="${config.retryGap}" required></div>
        <label class="check"><input id="${kind}-correct" type="checkbox" ${config.includeCorrect ? "checked" : ""}>納入答對舊項目</label>
        <label class="check"><input id="${kind}-wrong" type="checkbox" ${config.includeWrong ? "checked" : ""}>納入答錯舊項目</label>
        ${["words", "levels"].includes(kind) ? `<label class="check"><input id="${kind}-exclude-function" type="checkbox" ${config.excludeFunctionWords ? "checked" : ""}>排除虛詞，不列入測試</label>` : ""}
      </div></fieldset>`;
    }).join("")}</div><p class="muted">設定影響下一輪安排，已開始的練習保留原順序。預設兩種舊項目都納入；未勾選者絕不作為一般複習目標（選項干擾答案仍可使用整個題庫）。舊項目優先數不足時，以新項目補足。</p><button type="submit">儲存設定</button></form></section>
    <section class="card"><h2>完整備份與還原</h2><p>JSON 包含題庫、設定、所有作答紀錄及尚未完成的練習。可能包含原始題目與私人學習資料，請自行妥善保管，不要上傳公開儲存庫。</p><div class="actions"><button id="backup">匯出完整 JSON 備份</button><button id="persist-storage" class="secondary">要求瀏覽器保留資料</button></div><p id="storage-status" class="muted" role="status"></p><div class="section-heading"><label for="restore">選取完整備份以還原（取代全部本機資料）</label><input id="restore" type="file" accept=".json,application/json"></div></section>
    <section class="card"><h2>使用說明</h2><p>單字與片語支援「看中文輸入英文」與「看英文選中文」。輸入比對忽略大小寫、前後及重複空白、智慧型撇號，但不接受片段或任意變化詞形。答錯後要連續答對 3 次才能回到答對清單。</p><p>「虛詞」以冠詞、代名詞、介系詞、連接詞、助動詞等功能用法為主；兼有實詞用法者保守保留。排除只影響下一輪出題，不刪掉題庫與歷史。</p><p>發音使用裝置上的離線英文語音。若系統沒有英文語音，請先到裝置語音設定下載；本程式不把詞條送到線上發音服務。輸入英文模式在評分後提供發音，避免先洩漏答案。</p><p>文法改為原始填空與選項。只有成功對應正式答案的題目才計分；分類不再當作測驗答案。上一版文法概念配對的歷史保留於備份，但不混入原題成績。</p><p>大考中心是「大學入學考試中心」（CEEC）。級別是英文詞彙分級，不代表中文翻譯也由大考中心提供。本批學測語料缺民國 109、114 年，英聽只有部分官方文字稿，因此頻率並非所有歷年試題的完整統計。</p><p>手機：Android Chrome 使用「安裝應用程式／加到主畫面」；iPhone Safari 使用分享 → 加入主畫面。首次連線後，確認下方顯示離線資源就緒再離線。</p></section>`;
  kinds.forEach(kind => byId(`import-${kind}`).addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    importFile(kind, file);
  }));
  byId("import-grammar-keys").addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (state.grammarKeys.length && !confirm("要替換文法正式答案對照嗎？既有作答與評分保留，不會自動重新計分。")) return;
    action(async () => {
      const keys = ingestGrammarKeys(await file.text());
      await commit(next => { next.grammarKeys = keys; return next; });
      render();
      const count = buildGrammarQuestions(state.banks.grammar).filter(question => matchGrammarAnswer(question, keys)).length;
      announce(`已匯入 ${keys.length} 筆答案，成功對應 ${count} 道原題。未對應的題目不自動判分。`);
    });
  });
  byId("settings-form").addEventListener("submit", event => {
    event.preventDefault();
    const configs = { ...state.settings };
    for (const kind of studyKinds) {
      const target = Number(byId(`${kind}-target`).value);
      const reviewQuota = Number(byId(`${kind}-quota`).value);
      const retryGap = Number(byId(`${kind}-gap`).value);
      if (![target, reviewQuota, retryGap].every(Number.isSafeInteger) || target < 1 || reviewQuota < 0 || retryGap < 1) { announce("請輸入有效的安全整數：目標與間隔至少 1，舊項目數至少 0。", true); return; }
      configs[kind] = { target, reviewQuota, retryGap, includeCorrect: byId(`${kind}-correct`).checked, includeWrong: byId(`${kind}-wrong`).checked, excludeFunctionWords: byId(`${kind}-exclude-function`)?.checked ?? false };
    }
    action(async () => { await commit(next => { next.settings = configs; return next; }); }, "設定已儲存；下一輪開始時套用。");
  });
  byId("backup").addEventListener("click", () => {
    try { download(exportBackup(state), `english-review-backup-${today()}.json`, "application/json"); announce("備份檔已交由瀏覽器下載，請確認保存位置。"); }
    catch (error) { announce(errorMessage(error), true); }
  });
  byId("restore").addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    restoreFile(file);
  });
  byId("persist-storage").addEventListener("click", async () => {
    try {
      if (!navigator.storage?.persist) { byId("storage-status").textContent = "此瀏覽器不支援主動要求永久儲存，請仍定期備份。"; return; }
      const persisted = await navigator.storage.persist();
      byId("storage-status").textContent = persisted ? "瀏覽器已允許保留資料，仍建議定期備份。" : "瀏覽器未允許永久保留；資料仍已存入本機，但請定期備份。";
    } catch (error) { announce(errorMessage(error), true); }
  });
}

function parseInWorker(file, kind, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./import-worker.js", import.meta.url), { type: "module" });
    let timer;
    const finish = error => {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("匯入長時間沒有回應。請保持此頁開啟，使用精簡版 CSV 重試；原題庫未變更。")), 120000);
    };
    arm();
    worker.onmessage = ({ data }) => {
      arm();
      if (!data.cards && !data.error) { onProgress?.(data); return; }
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data.cards);
    };
    worker.onerror = event => finish(new Error(event.message || "CSV 背景解析失敗，可能是記憶體不足或程式檔案不完整。請使用精簡版 CSV 重試。"));
    worker.onmessageerror = () => finish(new Error("瀏覽器無法傳送解析結果，原題庫未變更。請使用精簡版 CSV 重試。"));
    worker.postMessage({ file, kind });
  });
}

function importFile(kind, file) {
  if (!file) return;
  if (state.banks[kind].length && !confirm(`要取代${names[kind]}題庫嗎？相同 ID 的作答紀錄保留，移除的 ID 紀錄會刪除，未完成練習會結束。建議先匯出備份。`)) { byId(`import-${kind}`).value = ""; return; }
  const status = byId(`import-status-${kind}`);
  action(async () => {
    const revision = state.revision;
    status.textContent = "正在本機背景解析並驗證，尚未變更題庫……";
    try {
      const cards = await parseInWorker(file, kind, progress => {
        const percent = Number(progress.percent ?? progress.progress);
        status.textContent = Number.isFinite(percent) ? `正在背景分段解析：${Math.round(percent)}%……` : "正在背景分段解析，請保持此頁開啟……";
      });
      status.textContent = `已驗證 ${cards.length.toLocaleString()} 筆，正在安全保存……`;
      state = await replaceBank(kind, cards, revision);
      render();
      announce(`${names[kind]}已匯入 ${cards.length.toLocaleString()} 筆，之後會自動載入。`);
    } catch (error) {
      status.textContent = `匯入失敗：${errorMessage(error)}。既有題庫與紀錄未變更。`;
      throw error;
    }
  });
}

function restoreFile(file) {
  if (!file) return;
  if (!confirm("還原將取代全部題庫、設定、答案對照、所有紀錄與未完成練習。確定已保留目前的備份並要繼續嗎？")) { byId("restore").value = ""; return; }
  action(async () => {
    const revision = state.revision;
    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch { throw new Error("這不是有效的 JSON 備份，原資料未變更。"); }
    state = await restoreBackup(backup, revision);
    render();
    announce("完整備份已還原。");
  });
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function lists() {
  app.innerHTML = `<h1>學習清單</h1><p class="muted">答對與答錯是互斥狀態；連續答對 3 次才從答錯清單移出。每頁最多顯示 25 筆。</p>
    <section class="card"><div class="filters">
      <div><label for="list-search">搜尋英文／中文</label><input id="list-search" type="search" value="${escape(listFilters.query)}" placeholder="輸入詞條或中文意思"></div>
      <div><label for="list-kind">題庫</label><select id="list-kind">${studyKinds.map(kind => `<option value="${kind}" ${listFilters.kind === kind ? "selected" : ""}>${names[kind]}</option>`).join("")}</select></div>
      <div><label for="list-status">狀態</label><select id="list-status">${Object.entries({ all: "全部", unseen: "未練習", correct: "答對", wrong: "答錯" }).map(([value, label]) => `<option value="${value}" ${listFilters.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <div><label for="list-level">大考中心詞彙級別</label><select id="list-level">${["all", "none", "1", "2", "3", "4", "5", "6"].map(value => `<option value="${value}" ${listFilters.level === value ? "selected" : ""}>${value === "all" ? "全部級別" : value === "none" ? "未標註" : `第 ${value} 級`}</option>`).join("")}</select></div>
      <div><label for="list-sort">排序</label><select id="list-sort"><option value="frequency" ${listFilters.sort === "frequency" ? "selected" : ""}>頻率由高到低</option><option value="wrong" ${listFilters.sort === "wrong" ? "selected" : ""}>累計錯誤由多到少</option></select></div>
    </div><label class="check"><input id="list-eligible" type="checkbox" ${listFilters.eligible ? "checked" : ""}>只顯示目前允許測試的項目（依設定排除虛詞）</label><div class="actions"><button id="export-correct" class="secondary">匯出此題庫答對清單 CSV</button><button id="export-wrong" class="secondary">匯出此題庫答錯清單 CSV</button><a href="#grammar">文法原題與作答紀錄</a></div></section><div id="list-results"></div>`;
  for (const [id, key] of [["list-kind", "kind"], ["list-status", "status"], ["list-level", "level"], ["list-sort", "sort"]]) {
    byId(id).addEventListener("change", event => { listFilters[key] = event.target.value; listPage = 0; renderList(); });
  }
  byId("list-eligible").addEventListener("change", event => { listFilters.eligible = event.target.checked; listPage = 0; renderList(); });
  let timer;
  byId("list-search").addEventListener("input", event => {
    listFilters.query = event.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => { listPage = 0; if (byId("list-results")) renderList(); }, 120);
  });
  ["correct", "wrong"].forEach(status => byId(`export-${status}`).addEventListener("click", () => {
    try { download(exportListCSV(state, listFilters.kind, status), `${listFilters.kind}-${status}-${today()}.csv`, "text/csv"); announce("清單已交由瀏覽器下載。"); }
    catch (error) { announce(errorMessage(error), true); }
  }));
  renderList();
}

function renderList() {
  const { kind, status, level, sort, query } = listFilters;
  const needle = query.toLocaleLowerCase().trim();
  let rows = frequencySort(state.banks[kind]).filter(card => {
    const stat = statFor(kind, card.id);
    return (status === "all" || (stat?.status || "unseen") === status)
      && (!listFilters.eligible || !["words", "levels"].includes(kind) || !state.settings[kind].excludeFunctionWords || !isFunctionWord(card))
      && (level === "all" || (level === "none" ? card.level === null : matchesLevel(card, level)))
      && (!needle || `${card.english} ${card.chinese}`.toLocaleLowerCase().includes(needle));
  });
  if (sort === "wrong") rows.sort((a, b) => (statFor(kind, b.id)?.wrong || 0) - (statFor(kind, a.id)?.wrong || 0));
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  listPage = Math.min(listPage, pages - 1);
  const visible = rows.slice(listPage * 25, (listPage + 1) * 25);
  byId("list-results").innerHTML = `<section class="card"><p role="status">共 ${rows.length.toLocaleString()} 筆 · 第 ${listPage + 1} / ${pages} 頁</p>
    ${!visible.length ? '<p class="empty">沒有符合條件的資料。</p>' : `<div class="table-wrap"><table><thead><tr><th scope="col">詞條</th>${kind === "levels" ? "" : '<th scope="col">狀態與紀錄</th><th scope="col">頻率</th>'}</tr></thead><tbody>${visible.map(card => {
      const stat = statFor(kind, card.id);
      const statusText = stat?.status === "correct" ? "答對" : stat?.status === "wrong" ? `答錯 · 恢復 ${stat.streak}/3` : "未練習";
      return `<tr><td><strong lang="en">${escape(card.english)}</strong><br>${escape(labelFor(card))}<br>${speechButton(card)}${kind === "levels" ? "" : `<small class="muted">大考中心詞彙級別 ${escape(levelLabel(card))}${isFunctionWord(card) ? " · 虛詞" : ""}</small><details><summary>來源／例句</summary>${detailsHTML(card, kind)}</details>`}</td>${kind === "levels" ? "" : `<td><span class="badge ${stat?.status || ""}">${statusText}</span><small>對 ${stat?.correct || 0}／錯 ${stat?.wrong || 0}</small>${stat?.lastPracticed ? `<small>${escape(new Date(stat.lastPracticed).toLocaleString("zh-TW"))}</small>` : ""}</td><td>${card.frequency}</td>`}</tr>`;
    }).join("")}</tbody></table></div>`}
    <div class="actions"><button id="previous-page" class="secondary" ${listPage === 0 ? "disabled" : ""}>上一頁</button><button id="next-page" class="secondary" ${listPage >= pages - 1 ? "disabled" : ""}>下一頁</button></div></section>`;
  byId("previous-page").addEventListener("click", () => { listPage--; renderList(); });
  byId("next-page").addEventListener("click", () => { listPage++; renderList(); });
}

function render() {
  if (!state) return;
  const route = location.hash.slice(1) || "home";
  document.querySelectorAll("nav a").forEach(link => {
    if (link.getAttribute("href") === `#${route}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (route === "settings") settings();
  else if (route === "lists") lists();
  else if (route === "grammar") grammarView();
  else {
    const [page, kind] = route.split("-");
    if (kinds.includes(kind) && ["bank", "wrong", "study"].includes(page)) {
      if (page === "study") study(kind);
      else bankSetup(kind, page === "wrong" ? "wrong" : "daily");
    } else home();
  }
}

app.addEventListener("click", event => {
  const button = event.target.closest("[data-speak]");
  if (button) speakEnglish(button.dataset.speak, announce);
});
window.addEventListener("hashchange", () => { stopSpeaking(); render(); window.scrollTo(0, 0); });
channel?.addEventListener("message", async () => {
  if (busy) return;
  try {
    const updated = await readState();
    if (updated.revision !== state.revision) {
      state = updated;
      render();
      announce("另一個分頁更新了資料，已載入最新進度。");
    }
  } catch (error) { announce(errorMessage(error), true); }
});
let visibleDay = today();
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || busy || !state) return;
  try {
    const updated = await readState();
    if (updated.revision !== state.revision || visibleDay !== today()) {
      state = updated;
      visibleDay = today();
      render();
    }
  } catch (error) { announce(errorMessage(error), true); }
});
setInterval(() => {
  if (!busy && state && visibleDay !== today()) { visibleDay = today(); render(); }
}, 30000);

async function offline() {
  const status = byId("offline-status");
  const button = byId("update-app");
  if (!("serviceWorker" in navigator)) { status.textContent = "目前不支援離線安裝；請使用 HTTPS 或 localhost。"; return; }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    const updateState = () => {
      if (registration.waiting) {
        button.hidden = false;
        status.textContent = "新版本已下載。更新不會清除題庫與紀錄。";
      } else if (registration.active?.state === "activated") {
        status.textContent = "離線資源已就緒 · 題庫由本機儲存載入";
      }
    };
    updateState();
    if (!registration.active) status.textContent = "首次下載離線資源中；完成前請保持連線。";
    const watch = worker => worker?.addEventListener("statechange", () => {
      updateState();
      if (worker.state === "redundant") status.textContent = registration.active
        ? "新版本安裝未完成，仍保留原版。請確認上傳了完整 js 資料夾，連線後重新整理。"
        : "離線安裝失敗，請連線後重新整理，確認所有程式檔案完整。";
    });
    watch(registration.installing);
    registration.addEventListener("updatefound", () => watch(registration.installing));
    button.addEventListener("click", () => {
      if (busy) { announce("請等待目前的儲存／匯入完成再更新。"); return; }
      if (!confirm("更新會重新載入頁面，已儲存進度不受影響，但尚未送出的答案或設定會清除。確定更新嗎？")) return;
      registration.waiting?.postMessage({ type: "SKIP_WAITING" });
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      updateState();
      if (button.hidden || refreshing) return;
      refreshing = true;
      if (busy) {
        const wait = setInterval(() => { if (!busy) { clearInterval(wait); location.reload(); } }, 200);
      } else location.reload();
    });
    setTimeout(() => {
      if (!registration.active && !registration.waiting) status.textContent = "離線資源尚未就緒，請保持連線或重新整理；目前不可保證離線使用。";
    }, 20000);
  } catch (error) {
    status.textContent = `離線設定失敗：${errorMessage(error)}。請使用 HTTPS 並確認檔案完整。`;
  }
}

try {
  state = await readState();
  render();
} catch (error) {
  app.innerHTML = '<section class="card"><h1>無法開啟本機儲存空間</h1><p>請確認未封鎖網站儲存，或改用一般瀏覽模式後重新整理。本應用不會假裝已儲存資料。</p></section>';
  announce(errorMessage(error), true);
}
offline();

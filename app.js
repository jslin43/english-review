import { readState, mutateState, replaceBank, restoreBackup, exportBackup, exportListCSV } from "./data.js";
import { localDay, frequencySort, labelFor, buildSession, currentItem, gradeSession, advanceSession } from "./engine.js";

const names = { words: "單字", phrases: "片語", grammar: "文法" };
const kinds = Object.keys(names);
const app = document.querySelector("#app");
const notice = document.querySelector("#notice");
let state;
let busy = false;
let listPage = 0;
let listFilters = { kind: "words", status: "all", level: "all", sort: "frequency", query: "" };
const channel = "BroadcastChannel" in window ? new BroadcastChannel("english-review-state") : null;

const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const byId = id => document.getElementById(id);
const today = () => localDay();
const statFor = (kind, id) => state.stats[kind]?.[id];
const isToday = stat => stat?.days?.includes(today());
const remaining = kind => Math.max(0, state.settings[kind].target - Object.values(state.stats[kind]).filter(isToday).length);
const activeSession = kind => state.sessions[kind] && !state.sessions[kind].completed;
const levelLabel = card => card.details?.ceec_level || card.level || "未標註";
const levelsFor = card => String(card.details?.ceec_level || card.level || "").split(";").map(value => Number(value.trim())).filter(value => value >= 1 && value <= 6);

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

function bankNumbers(kind) {
  const stats = Object.values(state.stats[kind]);
  return {
    total: state.banks[kind].length,
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
      const n = bankNumbers(kind);
      const target = state.settings[kind].target;
      return `<section class="card"><span class="badge">${n.total ? `${n.total.toLocaleString()} 筆已匯入` : "等待匯入"}</span><h2 class="section-heading">按頻率排序${names[kind]}</h2>
        ${n.total ? `<div class="stats"><div><strong>${n.today} / ${target}</strong><span>今日不同已答項目</span></div><div><strong>${n.total - n.seen}</strong><span>尚未練習</span></div></div>
          <progress aria-label="${names[kind]}今日進度" value="${Math.min(n.today, target)}" max="${target}"></progress>
          <p class="muted">累計已答 ${n.seen} · 答對清單 ${n.correct} · 答錯清單 ${n.wrong}</p>
          <div class="actions"><a class="button" href="#bank-${kind}">${activeSession(kind) ? "繼續／安排複習" : "安排今日複習"}</a></div>`
        : `<p class="muted">你的題庫尚未準備。匯入後，進度會自動保存在此裝置。</p><a class="button" href="#settings">匯入${names[kind]} CSV</a>`}
      </section>`;
    }).join("")}</div>
    <h2 class="section-heading">把不熟的，慢慢變熟</h2><div class="grid">${kinds.map(kind => `<a class="card" href="#wrong-${kind}"><h3>複習答錯的${names[kind]}</h3><p class="muted">${bankNumbers(kind).wrong} 筆待加強 · 連續答對 3 次才移出</p></a>`).join("")}</div>
    <div class="hint">答錯也算一次練習，但不會直接變成熟悉。每日目標計算「不同項目」，重試不重複計數。<br>頻率僅代表匯入語料中的出現次數，並非所有歷年試題的完整統計。</div>`;
}

function bankSetup(kind, purpose) {
  if (!state.banks[kind].length) { app.innerHTML = emptyBank(kind); return; }
  const config = state.settings[kind];
  const n = bankNumbers(kind);
  const old = state.sessions[kind];
  app.innerHTML = `<div class="study"><p class="eyebrow">${purpose === "wrong" ? "額外弱項練習" : "每日複習"}</p><h1>${purpose === "wrong" ? `複習答錯的${names[kind]}` : `按頻率排序${names[kind]}`}</h1>
    <p class="muted">題庫 ${n.total} · 累計已答 ${n.seen} · 尚未練習 ${n.total - n.seen}</p>
    ${old && !old.completed ? `<section class="card"><h2>有已儲存的進度</h2><p>${old.day} · ${old.purpose === "wrong" ? "答錯複習" : "每日複習"} · 已作答 ${old.attempts} 次</p><a class="button" href="#study-${kind}">繼續已儲存的練習</a>${old.day !== today() ? `<p class="warning">這是較早日期的練習。繼續後，新作答會計入今天；也可以結束舊進度，重新安排。</p>` : ""}</section>` : ""}
    <section class="card">
      <h2>${purpose === "wrong" ? "只選目前仍在答錯清單的項目" : "安排今天的練習"}</h2>
      <p>${purpose === "wrong" ? `目前有 ${n.wrong} 筆答錯項目；每輪最多 ${config.target} 筆。此練習獨立於每日配額，不會偷偷加入新項目。` : `今日已答 ${n.today} 個不同項目，目標 ${config.target}，尚餘 ${remaining(kind)} 個。至少優先選 ${Math.min(config.reviewQuota, remaining(kind))} 個允許的舊項目（若足夠），其餘優先選高頻新項目。`}</p>
      <form id="start-form" class="stack">
        <div><label for="answer-mode">作答方式</label><select id="answer-mode">${kind !== "grammar" ? '<option value="typing">看中文 → 輸入英文</option><option value="choice">看英文 → 四選一中文</option>' : '<option value="choice">英文文法概念 → 四選一中文概念</option>'}</select></div>
        ${purpose === "wrong" ? '<div><label for="wrong-order">答錯複習順序</label><select id="wrong-order"><option value="random">隨機</option><option value="frequency">頻率由高到低</option></select></div>' : ""}
        <p class="muted">${purpose === "daily" ? `納入答對舊項目：${config.includeCorrect ? "是" : "否"}；納入答錯舊項目：${config.includeWrong ? "是" : "否"}。` : ""}答錯後間隔 ${config.retryGap} 個其他已答項目再重試，每個項目每輪最多自動重試一次，避免無限循環；不足時保留在答錯清單。</p>
        <div class="actions"><button type="submit" ${purpose === "wrong" ? (!n.wrong ? "disabled" : "") : (!remaining(kind) ? "disabled" : "")}>${old && !old.completed ? "結束舊進度並開始這一輪" : "開始這一輪"}</button><a href="#settings">調整目標與複習比例</a></div>
      </form>
      ${purpose === "wrong" && !n.wrong ? '<p class="hint">目前沒有答錯項目。</p>' : ""}
      ${purpose === "daily" && !remaining(kind) ? '<p class="hint">今日目標已完成！仍可另開答錯複習；提高設定中的目標，才能增加今日一般練習。</p>' : ""}
    </section>
    ${grammarHelp(kind)}
    <a href="#home">返回首頁</a></div>`;
  byId("start-form").addEventListener("submit", event => {
    event.preventDefault();
    const mode = byId("answer-mode").value;
    const order = byId("wrong-order")?.value || "frequency";
    if (activeSession(kind) && !confirm("要結束此題庫尚未完成的練習，重新安排嗎？已作答紀錄會保留，未作答項目不會算完成。")) return;
    action(async () => {
      await commit(next => {
        next.sessions[kind] = buildSession({ kind, cards: next.banks[kind], stats: next.stats[kind], settings: next.settings[kind], purpose, mode, order });
        return next;
      });
      location.hash = `study-${kind}`;
      render();
    });
  });
}

function grammarHelp(kind) {
  return kind === "grammar" ? '<div class="hint"><strong>第一版文法範圍：</strong>練習英文文法概念與中文解釋配對。原始考題僅供閱讀，沒有經核實的答案，不會判定原題對錯。來源的數字、克漏字標記與年份原樣保留。</div>' : "";
}

function detailsHTML(card, kind) {
  const details = card.details || {};
  const fieldNames = {
    part_of_speech: "詞性", phrase_type: "片語類型", example_en: "例句／原始題目",
    example_origin: "例句來源", example_notes: "例句說明", original_context: "原始語境",
    original_context_source_json: "語境出處", example_year_roc: "例題民國年",
    example_question: "例題題號", example_pdf_page: "PDF 頁碼", translation_source: "翻譯來源",
    needs_review: "需人工複核", ceec_level: "來源 CEEC 級別（完整標註）", ceec_level_status: "級別標註狀態", corpus_scope: "語料範圍",
    years_roc: "出現民國年", exam_types: "試題類型", gsat_occurrences: "學測出現次數",
    listening_occurrences: "英聽出現次數", source_locations_json: "來源位置",
    observed_forms: "觀察到的詞形（非自動接受答案）", by_year_exam_counts_json: "各年出現次數"
  };
  let html = `<p class="muted">出現次數 ${card.frequency} · CEEC 級別 ${escape(levelLabel(card))}（未標註者不推測）</p>`;
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
  const session = state.sessions[kind];
  if (!session) { bankSetup(kind, "daily"); return; }
  const item = currentItem(session);
  const card = item && state.banks[kind].find(row => row.id === item.id);
  const feedback = session.feedback;
  const total = session.newCount + session.reviewCount;
  const unique = session.answeredIds.length;
  app.innerHTML = `<div class="study"><div class="actions"><a href="#home">← 儲存並返回首頁</a><span class="badge">${names[kind]} · ${session.purpose === "wrong" ? "額外答錯複習" : "每日練習"}</span></div><h1 class="section-heading">${!item || session.completed ? "這一輪已結束" : "專注眼前這一題"}</h1>
    <p class="muted">不同已答項目 ${unique} / ${total} · 作答次數 ${session.attempts}<br>本輪安排：新項目 ${session.newCount} · 舊項目 ${session.reviewCount}（不含重試）</p>
    <progress aria-label="本輪不同項目進度" value="${Math.min(unique, total)}" max="${Math.max(total, 1)}"></progress>
    ${session.day !== today() ? '<p class="warning">本輪開始於較早日期；現在的新作答計入今天，不會重複補發一整輪題目。</p>' : ""}
    ${!item || session.completed ? `<section class="card empty"><h2>${total ? "練習已保存" : "目前沒有符合條件的項目"}</h2><p>${total ? `本輪練習 ${unique} 個不同項目，共 ${session.attempts} 次作答。` : "不會使用已關閉的答對／答錯項目來補足數量。請調整設定，或匯入更多資料。"}</p><p class="muted">重試若沒有足夠的其他題目可間隔，會留在答錯清單供下次複習，不立即連續重複。</p><div class="actions"><a class="button" href="#home">回首頁</a><a class="button secondary" href="#wrong-${kind}">查看答錯複習</a></div></section>` : `
      <section class="card section-heading">
        <span class="badge">${item.origin === "new" ? "新項目" : item.origin === "retry" ? "間隔重試" : "舊項目複習"}</span>
        <p class="muted">${session.mode === "typing" ? "看中文，輸入正確英文詞條（大小寫不拘）" : kind === "grammar" ? "為英文文法概念選出中文解釋" : "為英文選出中文意思"}</p>
        <h2 class="prompt" ${session.mode === "choice" ? 'lang="en"' : ""}>${escape(session.mode === "typing" ? labelFor(card) : card.english)}</h2>
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
  if (item.choices?.length !== 4) return `<div class="warning">此題庫不足 4 個不同中文意思，無法提供四選一；不會從其他題庫借選項。${kind === "grammar" ? "請匯入至少 4 個中文解釋互異的文法概念，再重新開始。" : ""}</div>${kind !== "grammar" ? '<button id="switch-typing">此輪改為輸入英文</button>' : '<a href="#settings">前往匯入</a>'}`;
  return `<div class="choice-grid">${item.choices.map((label, index) => `<button type="button" data-answer="${escape(label)}"><span>${index + 1}.</span> ${escape(label)}</button>`).join("")}</div>`;
}

function feedbackHTML(kind, card, feedback) {
  const stat = statFor(kind, card.id);
  return `<div class="feedback ${feedback.correct ? "" : "wrong"}" role="status"><strong>${feedback.correct ? "答對了" : "這次答錯了，再慢慢記住"}</strong><p>正確詞條：<strong lang="en">${escape(card.english)}</strong><br>中文意思：${escape(labelFor(card))}<br>你的答案：${escape(feedback.answer)}</p><p>${stat?.status === "wrong" ? `仍在答錯清單 · 連續答對 ${stat.streak} / 3` : "已在答對清單"} · 累計答對 ${stat?.correct ?? 0}／答錯 ${stat?.wrong ?? 0}</p></div>
    <button id="next-card" type="button">下一題／完成本輪 ↵</button>
    <details open><summary>例句與來源說明</summary>${detailsHTML(card, kind)}</details>`;
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
  app.innerHTML = `<h1>設定與匯入</h1><p class="muted">三個獨立題庫，匯入一次就會自動載入。所有檔案只在此裝置處理。</p>
    <section class="warning"><strong>請定期備份：</strong>清除網站資料、無痕模式、換裝置或瀏覽器回收儲存空間，都可能讓本機紀錄消失。安裝到主畫面並不等於雲端備份。</section>
    <div class="grid">${kinds.map(kind => `<section class="card"><h2>${names[kind]}題庫</h2><p>${state.banks[kind].length ? `已匯入 ${state.banks[kind].length.toLocaleString()} 筆 · 自動載入` : "尚未匯入"}</p>
      <label for="import-${kind}">選取${names[kind]} CSV</label><input id="import-${kind}" type="file" accept=".csv,text/csv"><p id="import-status-${kind}" class="muted" role="status">請選取 UTF-8 CSV；會先完整驗證再替換。</p>
      <p class="muted">重匯同一 ID 保留歷史；移除的項目及其紀錄會從此題庫移除。匯入會結束此題庫未完成的練習。</p></section>`).join("")}</div>
    <section class="card"><h2>每日目標與複習方式</h2><form id="settings-form"><div class="grid">${kinds.map(kind => {
      const config = state.settings[kind];
      return `<fieldset><legend>${names[kind]}</legend><div class="stack">
        <div><label for="${kind}-target">每日不同項目目標</label><input id="${kind}-target" name="${kind}-target" type="number" min="1" step="1" value="${config.target}" required></div>
        <div><label for="${kind}-quota">優先複習舊項目數</label><input id="${kind}-quota" name="${kind}-quota" type="number" min="0" step="1" value="${config.reviewQuota}" required></div>
        <div><label for="${kind}-gap">答錯重試間隔（其他題數）</label><input id="${kind}-gap" name="${kind}-gap" type="number" min="1" step="1" value="${config.retryGap}" required></div>
        <label class="check"><input id="${kind}-correct" type="checkbox" ${config.includeCorrect ? "checked" : ""}>納入答對舊項目</label>
        <label class="check"><input id="${kind}-wrong" type="checkbox" ${config.includeWrong ? "checked" : ""}>納入答錯舊項目</label>
      </div></fieldset>`;
    }).join("")}</div><p class="muted">設定影響下一輪安排，已開始的練習保留原順序。預設兩種舊項目都納入；未勾選者絕不作為一般複習目標（選項干擾答案仍可使用整個題庫）。舊項目優先數不足時，以新項目補足。</p><button type="submit">儲存設定</button></form></section>
    <section class="card"><h2>完整備份與還原</h2><p>JSON 包含題庫、設定、所有作答紀錄及尚未完成的練習。可能包含原始題目與私人學習資料，請自行妥善保管，不要上傳公開儲存庫。</p><div class="actions"><button id="backup">匯出完整 JSON 備份</button><button id="persist-storage" class="secondary">要求瀏覽器保留資料</button></div><p id="storage-status" class="muted" role="status"></p><div class="section-heading"><label for="restore">選取完整備份以還原（取代全部本機資料）</label><input id="restore" type="file" accept=".json,application/json"></div></section>
    <section class="card"><h2>使用說明</h2><p>單字與片語支援「看中文輸入英文」與「看英文選中文」。輸入比對忽略大小寫、前後及重複空白、智慧型撇號，但不接受片段或任意變化詞形。答錯後要連續答對 3 次才能回到答對清單。</p><p>文法只練習概念配對。原始考題及 AI 註解供參考，沒有經核實的原題答案。</p><p>本批來源的學測語料缺民國 109、114 年；13 份英聽卷中僅 1 份附官方聽力文字稿。頻率不應解讀為全部歷年考試的完整排名。未標註的 CEEC 級別保持空白。</p><p>手機：Android Chrome 使用「安裝應用程式／加到主畫面」；iPhone Safari 使用分享 → 加入主畫面。首次連線後，確認下方顯示離線資源就緒再離線。</p></section>`;
  kinds.forEach(kind => byId(`import-${kind}`).addEventListener("change", event => importFile(kind, event.target.files[0])));
  byId("settings-form").addEventListener("submit", event => {
    event.preventDefault();
    const configs = {};
    for (const kind of kinds) {
      const target = Number(byId(`${kind}-target`).value);
      const reviewQuota = Number(byId(`${kind}-quota`).value);
      const retryGap = Number(byId(`${kind}-gap`).value);
      if (![target, reviewQuota, retryGap].every(Number.isSafeInteger) || target < 1 || reviewQuota < 0 || retryGap < 1) { announce("請輸入有效的安全整數：目標與間隔至少 1，舊項目數至少 0。", true); return; }
      configs[kind] = { target, reviewQuota, retryGap, includeCorrect: byId(`${kind}-correct`).checked, includeWrong: byId(`${kind}-wrong`).checked };
    }
    action(async () => { await commit(next => { next.settings = configs; return next; }); }, "設定已儲存；下一輪開始時套用。");
  });
  byId("backup").addEventListener("click", () => {
    try { download(exportBackup(state), `english-review-backup-${today()}.json`, "application/json"); announce("備份檔已交由瀏覽器下載，請確認保存位置。"); }
    catch (error) { announce(errorMessage(error), true); }
  });
  byId("restore").addEventListener("change", event => restoreFile(event.target.files[0]));
  byId("persist-storage").addEventListener("click", async () => {
    try {
      if (!navigator.storage?.persist) { byId("storage-status").textContent = "此瀏覽器不支援主動要求永久儲存，請仍定期備份。"; return; }
      const persisted = await navigator.storage.persist();
      byId("storage-status").textContent = persisted ? "瀏覽器已允許保留資料，仍建議定期備份。" : "瀏覽器未允許永久保留；資料仍已存入本機，但請定期備份。";
    } catch (error) { announce(errorMessage(error), true); }
  });
}

function parseInWorker(text, kind) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./import-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.cards);
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || "CSV 解析工作無法啟動，請確認程式檔案完整。")); };
    worker.postMessage({ text, kind });
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
      const cards = await parseInWorker(await file.text(), kind);
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
  if (!confirm("還原將取代三個題庫、設定、所有紀錄與未完成練習。確定已保留目前的備份並要繼續嗎？")) { byId("restore").value = ""; return; }
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
      <div><label for="list-search">搜尋英文／中文（文法可搜尋類別）</label><input id="list-search" type="search" value="${escape(listFilters.query)}" placeholder="輸入詞條或中文意思"></div>
      <div><label for="list-kind">題庫</label><select id="list-kind">${kinds.map(kind => `<option value="${kind}" ${listFilters.kind === kind ? "selected" : ""}>${names[kind]}</option>`).join("")}</select></div>
      <div><label for="list-status">狀態</label><select id="list-status">${Object.entries({ all: "全部", unseen: "未練習", correct: "答對", wrong: "答錯" }).map(([value, label]) => `<option value="${value}" ${listFilters.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <div><label for="list-level">CEEC 級別</label><select id="list-level">${["all", "none", "1", "2", "3", "4", "5", "6"].map(value => `<option value="${value}" ${listFilters.level === value ? "selected" : ""}>${value === "all" ? "全部級別" : value === "none" ? "未標註" : `第 ${value} 級`}</option>`).join("")}</select></div>
      <div><label for="list-sort">排序</label><select id="list-sort"><option value="frequency" ${listFilters.sort === "frequency" ? "selected" : ""}>頻率由高到低</option><option value="wrong" ${listFilters.sort === "wrong" ? "selected" : ""}>累計錯誤由多到少</option></select></div>
    </div><div class="actions"><button id="export-correct" class="secondary">匯出此題庫答對清單 CSV</button><button id="export-wrong" class="secondary">匯出此題庫答錯清單 CSV</button></div></section><div id="list-results"></div>`;
  for (const [id, key] of [["list-kind", "kind"], ["list-status", "status"], ["list-level", "level"], ["list-sort", "sort"]]) {
    byId(id).addEventListener("change", event => { listFilters[key] = event.target.value; listPage = 0; renderList(); });
  }
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
      && (level === "all" || (level === "none" ? card.level === null : levelsFor(card).includes(Number(level))))
      && (!needle || `${card.english} ${card.chinese}`.toLocaleLowerCase().includes(needle));
  });
  if (sort === "wrong") rows.sort((a, b) => (statFor(kind, b.id)?.wrong || 0) - (statFor(kind, a.id)?.wrong || 0));
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  listPage = Math.min(listPage, pages - 1);
  const visible = rows.slice(listPage * 25, (listPage + 1) * 25);
  byId("list-results").innerHTML = `<section class="card"><p role="status">共 ${rows.length.toLocaleString()} 筆 · 第 ${listPage + 1} / ${pages} 頁</p>
    ${!visible.length ? '<p class="empty">沒有符合條件的資料。</p>' : `<div class="table-wrap"><table><thead><tr><th scope="col">詞條／概念</th><th scope="col">狀態與紀錄</th><th scope="col">頻率</th></tr></thead><tbody>${visible.map(card => {
      const stat = statFor(kind, card.id);
      const statusText = stat?.status === "correct" ? "答對" : stat?.status === "wrong" ? `答錯 · 恢復 ${stat.streak}/3` : "未練習";
      return `<tr><td><strong lang="en">${escape(card.english)}</strong><br>${escape(labelFor(card))}<small class="muted">CEEC ${escape(levelLabel(card))}</small><details><summary>來源／例句</summary>${detailsHTML(card, kind)}</details></td><td><span class="badge ${stat?.status || ""}">${statusText}</span><small>對 ${stat?.correct || 0}／錯 ${stat?.wrong || 0}</small>${stat?.lastPracticed ? `<small>${escape(new Date(stat.lastPracticed).toLocaleString("zh-TW"))}</small>` : ""}</td><td>${card.frequency}</td></tr>`;
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
  else {
    const [page, kind] = route.split("-");
    if (kinds.includes(kind) && ["bank", "wrong", "study"].includes(page)) {
      if (page === "study") study(kind);
      else bankSetup(kind, page === "wrong" ? "wrong" : "daily");
    } else home();
  }
}

window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
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
      if (worker.state === "redundant" && !registration.active) status.textContent = "離線安裝失敗，請連線後重新整理，確認所有程式檔案完整。";
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

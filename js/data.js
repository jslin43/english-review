import { labelFor, normalizeEnglish } from "./engine.js";
import { buildGrammarQuestions } from "./grammar.js";

export const BANKS = Object.freeze(["words", "phrases", "grammar", "levels"]);
const DB_NAME = "english-review";
const STORE = "state";
let databasePromise;

const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeNumber = value => Number.isSafeInteger(value) && value >= 0;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const bankCheck = kind => BANKS.includes(kind) || fail("未知的題庫類型。");

// Only slices of retained fields are collected; ignored columns are syntax-checked
// without ever constructing their (potentially multi-megabyte) JSON strings.
export function createCSVParser(onRow, keepField = () => true) {
  let row = [], parts = [], quoted = false, closed = false, started = false;
  let first = true, skipLF = false, rowNumber = 1, finished = false;
  const append = text => { if (text && keepField(row.length, rowNumber)) parts.push(text); };
  const appendRange = (text, start, end = text.length) => {
    if (end > start && keepField(row.length, rowNumber)) parts.push(text.slice(start, end));
  };
  const pushField = () => {
    // Detach short substrings from their input chunk, so keeping one small cell
    // cannot keep a whole chunk of discarded source JSON alive.
    row.push(keepField(row.length, rowNumber) ? (" " + parts.join("")).slice(1) : undefined);
    parts = []; closed = false; started = false;
  };
  const pushRow = () => { pushField(); onRow(row, rowNumber++); row = []; };
  return {
    write(text) {
      if (finished || typeof text !== "string") fail("CSV 必須是文字，且解析尚未結束。");
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (first) {
          first = false;
          if (char === "\ufeff") { start = i + 1; continue; }
        }
        if (skipLF) {
          skipLF = false;
          if (char === "\n") { start = i + 1; continue; }
        }
        if (quoted) {
          if (char === '"') {
            appendRange(text, start, i); start = i + 1;
            quoted = false; closed = true;
          }
        } else if (closed && char === '"') {
          append('"'); start = i + 1; quoted = true; closed = false;
        } else if (char === "," || char === "\r" || char === "\n") {
          if (!closed) appendRange(text, start, i);
          start = i + 1;
          if (char === ",") pushField();
          else { pushRow(); skipLF = char === "\r"; }
        } else if (closed) {
          fail(`CSV 第 ${rowNumber} 列：引號結束後有多餘文字。`);
        } else if (char === '"') {
          if (started) fail(`CSV 第 ${rowNumber} 列：欄位中的引號必須跳脫。`);
          quoted = true; started = true; start = i + 1;
        } else started = true;
      }
      if (!closed) appendRange(text, start);
    },
    finish() {
      if (finished) fail("CSV 解析已結束。");
      finished = true;
      if (quoted) fail("CSV 有未關閉的引號。");
      if (started || closed || row.length) pushRow();
    }
  };
}

export function parseCSV(text) {
  const rows = [];
  const parser = createCSVParser(row => rows.push(row));
  parser.write(text);
  parser.finish();
  return rows;
}

function numericCell(value, label) {
  if (!/^\d+$/.test(value) || !safeNumber(Number(value))) fail(`${label} 必須是非負安全整數。`);
  return Number(value);
}

function idCheck(id, kind) {
  if (typeof id !== "string" || !id.trim() || id !== id.trim() || ["__proto__", "constructor", "prototype"].includes(id)) fail("題目 ID 無效。");
  if (kind === "words" && !/^word:.+/.test(id)) fail("單字題庫 ID 必須以 word: 開頭。");
  if (kind === "phrases" && !/^phrase:.+/.test(id)) fail("片語題庫 ID 必須以 phrase: 開頭。");
  if (kind === "levels" && !/^level-word:.+/.test(id)) fail("分級單字 ID 必須以 level-word: 開頭。");
  if (kind === "grammar" && !/^[a-z][a-z0-9_]*$/.test(id)) fail("文法題庫 ID 必須是文法分類名稱。");
}

const RETAINED_FIELDS = new Set([
  "id", "english", "chinese", "total_occurrences", "level", "level_source",
  "part_of_speech", "part_of_speech_source", "phrase_type", "translation_source",
  "ceec_level", "ceec_level_status", "ceec_headword", "ceec_source", "ceec_source_url", "ceec_source_pdf_pages",
  "observed_forms", "gsat_occurrences", "listening_occurrences", "document_count",
  "years_roc", "exam_types", "document_types", "example_en", "example_origin", "example_notes",
  "example_source_file", "example_year_roc", "example_exam_type", "example_pdf_page", "example_question",
  "original_context", "needs_review", "review_notes", "counting_rule", "corpus_scope", "function_word",
  "specific_concepts_json", "evidence_json", "high_confidence_questions", "medium_confidence_questions"
]);

function csvImporter(kind) {
  bankCheck(kind);
  const cards = [], ids = new Set();
  let headers;
  const parser = createCSVParser((row, number) => {
    if (!headers) {
      headers = row.map(value => value.trim());
      if (headers.some(value => !value) || new Set(headers).size !== headers.length) fail("CSV 欄位名稱不可空白或重複。");
      for (const name of ["id", "english", "chinese", kind === "levels" ? "level" : "total_occurrences"]) {
        if (!headers.includes(name)) fail(`CSV 缺少必要欄位：${name}。`);
      }
      return;
    }
    if (row.length !== headers.length) fail(`CSV 第 ${number} 列的欄位數與標題不符。`);
    const source = Object.fromEntries(headers.flatMap((header, i) => row[i] === undefined ? [] : [[header, row[i]]]));
    const id = source.id.trim();
    idCheck(id, kind);
    if (ids.has(id)) fail(`CSV 第 ${number} 列的 ID 重複。`);
    ids.add(id);
    const english = source.english.trim(), chinese = source.chinese.trim();
    if (!english || !chinese) fail(`CSV 第 ${number} 列的英文與中文不可空白。`);
    const frequency = kind === "levels" && !source.total_occurrences?.trim() ? 0 :
      numericCell(source.total_occurrences.trim(), "total_occurrences");
    for (const name of ["gsat_occurrences", "listening_occurrences", "document_count", "high_confidence_questions", "medium_confidence_questions"]) {
      if (source[name]?.trim()) numericCell(source[name].trim(), name);
    }
    for (const name of ["needs_review", "function_word"]) {
      if (source[name]?.trim() && !/^(true|false|yes|no|0|1)$/i.test(source[name].trim())) fail(`CSV 第 ${number} 列的 ${name} 必須是布林值。`);
    }
    for (const name of ["evidence_json", "specific_concepts_json"]) {
      if (!source[name]?.trim()) continue;
      try {
        const parsed = JSON.parse(source[name]);
        if (!Array.isArray(parsed)) fail("必須是陣列");
        jsonValue(parsed);
      } catch { fail(`CSV 第 ${number} 列的 ${name} JSON 格式無效，必須是陣列。`); }
    }
    let level = null;
    const levelText = kind === "levels" ? source.level.trim() : source.ceec_level?.trim();
    if (kind === "levels" && !levelText) fail(`CSV 第 ${number} 列的 level 不可空白。`);
    if (levelText) {
      const values = levelText.split(";").map(value => value.trim());
      if (values.some(value => !/^[1-6]$/.test(value))) fail(`CSV 第 ${number} 列的 CEEC 級別必須介於 1 至 6。`);
      const normalized = [...new Set(values)].sort();
      level = Number(normalized[0]);
      source.ceec_level = normalized.join(";");
      if (kind === "levels") source.level = source.ceec_level;
    }
    const details = Object.fromEntries(Object.entries(source).filter(([key, value]) =>
      !["id", "english", "chinese", "total_occurrences"].includes(key) && value !== ""));
    cards.push({ id, english, chinese, frequency, level, details });
  }, (column, number) => number === 1 || RETAINED_FIELDS.has(headers[column]));
  return {
    write: text => parser.write(text),
    finish() {
      parser.finish();
      if (!cards.length) fail("CSV 必須包含標題與至少一筆題目。");
      return cards;
    }
  };
}

export function ingestCSV(text, kind) {
  const importer = csvImporter(kind);
  importer.write(text);
  return importer.finish();
}

const GRAMMAR_KEY_FIELDS = ["source_id", "year_roc", "exam_type", "variant", "question", "answer", "answer_source"];

export function ingestGrammarKeys(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) fail("正式答案 CSV 必須包含標題與至少一筆答案。");
  const headers = rows.shift().map(value => value.trim());
  if (headers.length !== GRAMMAR_KEY_FIELDS.length || new Set(headers).size !== headers.length ||
      GRAMMAR_KEY_FIELDS.some(field => !headers.includes(field))) fail(`正式答案 CSV 必須包含這些欄位：${GRAMMAR_KEY_FIELDS.join(",")}。`);
  const keys = rows.map((row, index) => {
    if (row.length !== headers.length) fail(`正式答案 CSV 第 ${index + 2} 列的欄位數與標題不符。`);
    return Object.fromEntries(headers.map((field, column) => [field, row[column].trim()]));
  });
  validateGrammarKeys(keys);
  return keys;
}

async function readBlobBytes(blob) {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  if (typeof globalThis.FileReaderSync === "function") return new FileReaderSync().readAsArrayBuffer(blob);
  if (typeof globalThis.FileReader !== "function") fail("瀏覽器無法讀取 CSV 檔案，請更新瀏覽器後重試。");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("CSV 檔案讀取失敗。"));
    reader.onabort = () => reject(new Error("CSV 檔案讀取已取消。"));
    reader.readAsArrayBuffer(blob);
  });
}

export async function ingestCSVFile(file, kind) {
  if (!file || !safeNumber(file.size) || typeof file.slice !== "function" && typeof file.stream !== "function") fail("請選擇可讀取的 CSV 檔案。");
  const importer = csvImporter(kind);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (typeof file.slice === "function") {
    // Slice first: older Safari supports FileReader even without Blob.arrayBuffer.
    for (let offset = 0; offset < file.size; offset += 65536) {
      const buffer = await readBlobBytes(file.slice(offset, offset + 65536));
      importer.write(decoder.decode(buffer, { stream: true }));
    }
  } else {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) fail("CSV 檔案串流格式無效。");
        for (let offset = 0; offset < value.length; offset += 65536) {
          importer.write(decoder.decode(value.subarray(offset, offset + 65536), { stream: true }));
        }
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* Preserve the original read/parse error. */ }
      throw error;
    } finally { reader.releaseLock(); }
  }
  importer.write(decoder.decode());
  return importer.finish();
}

export function initialState() {
  return {
    version: 2,
    revision: 0,
    banks: { words: [], phrases: [], grammar: [], levels: [] },
    settings: Object.fromEntries(BANKS.map((kind, i) => [kind, {
      target: [20, 10, 5, 20][i], reviewQuota: [5, 3, 2, 5][i],
      includeCorrect: true, includeWrong: true, retryGap: 3,
      excludeFunctionWords: kind === "words" || kind === "levels"
    }])),
    stats: { words: {}, phrases: {}, grammar: {}, levels: {} },
    sessions: { words: null, phrases: null, grammar: null, levels: null },
    grammarWork: { currentQuestionId: null, category: "all", filter: "all", answers: {} },
    grammarKeys: []
  };
}

export function openDB() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("瀏覽器無法使用 IndexedDB；請啟用網站儲存空間。"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        const store = request.result.createObjectStore(STORE);
        store.put(initialState(), "current");
      }
    };
    request.onerror = () => reject(request.error || new Error("無法開啟本機資料庫。"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("資料庫升級被其他分頁阻擋，請關閉其他分頁後重試。"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      resolve(db);
    };
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

export async function readState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const request = transaction.objectStore(STORE).get("current");
    let result, failure;
    request.onsuccess = () => {
      try {
        result = request.result;
        if (result?.version === 1 || result?.version === 2 && needsGrammarDefaults(result)) {
          result = validateBackup(result);
          if (result.revision === Number.MAX_SAFE_INTEGER) fail("資料版本超出安全範圍。");
          result.revision++;
          transaction.objectStore(STORE).put(result, "current");
        }
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => result ? resolve(result) : reject(new Error("本機資料遺失，請還原備份。"));
    transaction.onerror = transaction.onabort = () => reject(failure || transaction.error || new Error("讀取本機資料失敗。"));
  });
}

export async function mutateState(expectedRevision, transform, migrateCurrent = true) {
  if (!safeNumber(expectedRevision) || typeof transform !== "function") fail("資料修改參數無效。");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    let result, failure;
    const request = store.get("current");
    request.onsuccess = () => {
      try {
        let current = request.result;
        if (!current || current.revision !== expectedRevision) fail("其他分頁已更新資料。請重新載入最新資料後再試，這次變更尚未儲存。");
        if (migrateCurrent && current.version === 1) current = validateBackup(current);
        if (current.revision === Number.MAX_SAFE_INTEGER) fail("資料版本超出安全範圍。");
        result = transform(current) ?? current;
        if (!object(result) || typeof result.then === "function") fail("資料修改必須同步完成並回傳資料物件。");
        result.revision = expectedRevision + 1;
        store.put(result, "current");
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(failure || transaction.error || new Error("本機儲存失敗，變更未儲存。"));
  });
}

function jsonValue(value, depth = 0) {
  if (depth > 40) fail("備份資料巢狀層級過深。");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("備份含有不安全的欄位名稱。");
      jsonValue(item, depth + 1);
    }
    return;
  }
  fail("備份含有不支援的資料型態。");
}

function validateCards(cards, kind) {
  if (!Array.isArray(cards)) fail("題庫格式錯誤。");
  const ids = new Set();
  for (const card of cards) {
    if (!object(card)) fail("題目格式錯誤。");
    idCheck(card.id, kind);
    if (ids.has(card.id)) fail("題目 ID 重複。");
    ids.add(card.id);
    if (typeof card.english !== "string" || !card.english.trim() || typeof card.chinese !== "string" || !card.chinese.trim()) fail("題目必須包含英文與中文。");
    if (!safeNumber(card.frequency) || !(card.level === null || Number.isInteger(card.level) && card.level >= 1 && card.level <= 6) || !object(card.details)) fail("題目頻率、級別或來源資料格式錯誤。");
    jsonValue(card.details);
  }
  return ids;
}

export async function replaceBank(kind, cards, expectedRevision) {
  bankCheck(kind);
  const ids = validateCards(cards, kind);
  const imported = structuredClone(cards);
  const questionIds = kind === "grammar" ? new Set(buildGrammarQuestions(imported).map(question => question.id)) : null;
  return mutateState(expectedRevision, state => {
    state.banks[kind] = imported;
    state.stats[kind] = Object.fromEntries(Object.entries(state.stats[kind]).filter(([id]) => ids.has(id)));
    state.sessions[kind] = null;
    if (kind === "grammar") {
      const previous = state.grammarWork ?? initialState().grammarWork;
      state.grammarWork = {
        ...previous,
        currentQuestionId: null,
        category: ids.has(previous.category) ? previous.category : "all",
        answers: Object.fromEntries(Object.entries(previous.answers).filter(([id]) => questionIds.has(id)))
      };
    }
    return state;
  });
}

function validDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

function timestamp(value) {
  return safeNumber(value) && Number.isFinite(new Date(value).getTime());
}

function validateStat(stat) {
  if (!object(stat) || !["attempts", "correct", "wrong", "streak"].every(key => safeNumber(stat[key])) ||
      stat.attempts < 1 || stat.correct + stat.wrong !== stat.attempts ||
      stat.streak > stat.correct || !["correct", "wrong"].includes(stat.status) ||
      stat.status === "correct" && stat.streak < 1 ||
      stat.status === "wrong" && (stat.wrong < 1 || stat.streak >= 3) ||
      !timestamp(stat.lastPracticed) || !Array.isArray(stat.days) || !stat.days.length ||
      stat.days.length > stat.attempts || stat.days.some(day => !validDay(day)) ||
      new Set(stat.days).size !== stat.days.length) fail("備份的練習統計格式或累計數字不一致。");
}

function choicesCheck(choices) {
  return choices === null || Array.isArray(choices) && choices.length === 4 &&
    choices.every(value => typeof value === "string" && value.trim()) && new Set(choices).size === 4;
}

function validateSession(session, kind, ids, stats, cards) {
  if (session === null) return;
  if (!object(session) || typeof session.id !== "string" || !session.id ||
      session.kind !== kind || !validDay(session.day) ||
      !["daily", "wrong"].includes(session.purpose) || !["typing", "choice"].includes(session.mode) ||
      kind === "grammar" && session.mode !== "choice" || !["frequency", "random"].includes(session.order) ||
      !["index", "attempts", "newCount", "reviewCount", "retryGap", "nextToken"].every(key => safeNumber(session[key])) ||
      session.retryGap < 1 || typeof session.completed !== "boolean" ||
      !Array.isArray(session.queue) || !Array.isArray(session.pendingRetries) || !Array.isArray(session.answeredIds) ||
      session.index > session.queue.length || session.completed !== (session.index === session.queue.length) ||
      own(session, "lastAdvanced") && !timestamp(session.lastAdvanced)) fail("備份的練習進度格式錯誤。");
  if (own(session, "levelFilter") && (typeof session.levelFilter !== "string" || !/^(all|[1-6])$/.test(session.levelFilter)) ||
      own(session, "excludeFunctionWords") && typeof session.excludeFunctionWords !== "boolean" ||
      own(session, "targetCount") && !safeNumber(session.targetCount)) fail("備份的練習篩選設定無效。");
  const tokens = new Set(), originalIds = new Set();
  const byId = new Map(cards.map(card => [card.id, card]));
  const labels = new Set(cards.map(labelFor));
  const validChoices = item => choicesCheck(item.choices) && (item.choices === null ||
    item.choices.includes(labelFor(byId.get(item.id))) && item.choices.every(value => labels.has(value)));
  let newCount = 0, reviewCount = 0;
  for (const item of session.queue) {
    if (!object(item) || !ids.has(item.id) || typeof item.token !== "string" || !item.token ||
        tokens.has(item.token) || !["new", "review", "retry"].includes(item.origin) ||
        !validChoices(item)) fail("備份的練習題目參照或選項無效。");
    tokens.add(item.token);
    if (item.origin !== "retry") {
      if (originalIds.has(item.id)) fail("備份的練習初始題目重複。");
      if (item.origin === "review" && !stats[item.id]) fail("備份的複習題目缺少練習統計。");
      originalIds.add(item.id);
      if (item.origin === "new") newCount++;
      else reviewCount++;
    }
  }
  if (newCount !== session.newCount || reviewCount !== session.reviewCount ||
      session.nextToken !== session.queue.length) fail("備份的練習題目數量不一致。");
  for (const item of session.queue) {
    if (!originalIds.has(item.id)) fail("備份的重試題目不在本輪練習中。");
  }
  const retryIds = new Set();
  for (const retry of session.pendingRetries) {
    if (!object(retry) || !originalIds.has(retry.id) || retryIds.has(retry.id) ||
        !safeNumber(retry.dueAfter) || retry.dueAfter < 1 || !validChoices(retry) ||
        typeof retry.deferred !== "boolean" ||
        !stats[retry.id] || stats[retry.id].status !== "wrong") fail("備份的待重試題目無效。");
    retryIds.add(retry.id);
  }
  const hasFeedback = session.feedback !== null;
  if (session.attempts !== session.index + Number(hasFeedback)) fail("備份的練習作答次數不一致。");
  const processedIds = new Set(session.queue.slice(0, session.attempts).map(item => item.id));
  if (session.answeredIds.length !== processedIds.size || new Set(session.answeredIds).size !== session.answeredIds.length ||
      session.answeredIds.some(id => !processedIds.has(id) || !stats[id])) fail("備份的已答題目參照無效。");
  if (hasFeedback) {
    const feedback = session.feedback, item = session.queue[session.index];
    if (session.completed || !object(feedback) || !item || feedback.id !== item.id || feedback.token !== item.token ||
        typeof feedback.correct !== "boolean" || typeof feedback.expected !== "string" || !feedback.expected.trim() ||
        typeof feedback.answer !== "string" || !feedback.answer.trim() || !validDay(feedback.day) ||
        session.mode === "choice" && (!item.choices || !item.choices.includes(feedback.expected) ||
          !item.choices.includes(feedback.answer.trim().replace(/\s+/g, " ")))) fail("備份的作答回饋與目前題目不一致。");
    const expected = session.mode === "choice" ? labelFor(byId.get(item.id)) : byId.get(item.id).english;
    const correct = session.mode === "choice" ? feedback.answer.trim().replace(/\s+/g, " ") === expected :
      normalizeEnglish(feedback.answer) === normalizeEnglish(expected);
    if (feedback.expected !== expected || feedback.correct !== correct) fail("備份的作答判定與題目不一致。");
  }
}

function needsGrammarDefaults(state) {
  return !own(state, "grammarKeys") || !own(state, "grammarWork") ||
    object(state.grammarWork) && (!own(state.grammarWork, "filter") ||
      object(state.grammarWork.answers) && Object.values(state.grammarWork.answers).some(answer =>
        object(answer) && ["correct", "submitted", "stat"].some(field => !own(answer, field))));
}

function validateGrammarWork(work, cards) {
  const allowedFields = (value, required, optional = []) => object(value) &&
    required.every(key => own(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
  const questionId = value => typeof value === "string" && value.length > 0 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
  if (!allowedFields(work, ["currentQuestionId", "category", "answers"], ["filter"]) ||
      work.currentQuestionId !== null && !questionId(work.currentQuestionId) ||
      typeof work.category !== "string" || work.category !== "all" && !cards.some(card => card.id === work.category) ||
      own(work, "filter") && !["all", "wrong", "unanswered"].includes(work.filter) ||
      !object(work.answers)) fail("備份的文法原題練習格式或分類無效。");
  let questions;
  try { questions = new Set(buildGrammarQuestions(cards).map(question => question.id)); }
  catch { fail("備份的文法原題 evidence_json 格式無效；原有資料未變更，請修正來源或還原有效備份。"); }
  if (work.currentQuestionId !== null && !questions.has(work.currentQuestionId)) fail("備份的文法目前題目不存在。");
  for (const [id, answer] of Object.entries(work.answers)) {
    if (!questionId(id) || !questions.has(id) ||
        !allowedFields(answer, ["answer", "updatedAt"], ["correct", "submitted", "stat", "expected", "answerSource"]) ||
        typeof answer.answer !== "string" || answer.answer.length > 1000000 ||
        !Number.isFinite(answer.updatedAt) || answer.updatedAt < 0 ||
        !Number.isFinite(new Date(answer.updatedAt).getTime()) ||
        own(answer, "correct") && answer.correct !== null && typeof answer.correct !== "boolean" ||
        own(answer, "submitted") && typeof answer.submitted !== "boolean" ||
        answer.submitted === true && !answer.answer.trim() ||
        ["expected", "answerSource"].some(field => own(answer, field) && answer[field] !== null && typeof answer[field] !== "string")) fail("備份的文法原題答案或時間格式無效。");
    if (own(answer, "stat") && answer.stat !== null) validateStat(answer.stat);
  }
}

function validateGrammarKeys(keys) {
  if (!Array.isArray(keys)) fail("備份的文法正式答案必須是陣列。");
  const fields = GRAMMAR_KEY_FIELDS, seen = new Set();
  for (const key of keys) {
    if (!object(key) || Object.keys(key).length !== fields.length ||
        fields.some(field => !own(key, field) || typeof key[field] !== "string" || !key[field].trim() ||
          key[field] !== key[field].trim() || /[\u0000-\u001f\u007f]/.test(key[field]))) fail("備份的文法正式答案欄位格式無效。");
    if (!/^[1-9]\d*$/.test(key.year_roc) || !safeNumber(Number(key.year_roc)) ||
        !/^[1-9]\d*$/.test(key.question) || !safeNumber(Number(key.question)) ||
        key.exam_type !== "gsat" || !["regular", "resit"].includes(key.variant) ||
        !/^[A-O]$/.test(key.answer)) fail("備份的文法正式答案年度、考試、題號或選項無效。");
    const id = JSON.stringify([key.source_id, key.year_roc, key.question]);
    if (seen.has(id)) fail("備份的文法正式答案來源、年度與題號重複。");
    seen.add(id);
  }
}

export function validateBackup(data) {
  if (!object(data) || ![1, 2].includes(data.version) || !safeNumber(data.revision)) fail("備份版本或資料格式不支援。");
  jsonValue(data);
  const banks = data.version === 1 ? BANKS.slice(0, 3) : BANKS;
  for (const name of ["banks", "settings", "stats", "sessions"]) {
    if (!object(data[name]) || Object.keys(data[name]).length !== banks.length ||
        banks.some(kind => !own(data[name], kind))) fail(`備份缺少完整的 ${name} 題庫資料。`);
  }
  for (const kind of banks) {
    const ids = validateCards(data.banks[kind], kind), settings = data.settings[kind];
    if (!object(settings) || !safeNumber(settings.target) || settings.target < 1 ||
        !safeNumber(settings.reviewQuota) || !safeNumber(settings.retryGap) || settings.retryGap < 1 ||
        typeof settings.includeCorrect !== "boolean" || typeof settings.includeWrong !== "boolean" ||
        own(settings, "excludeFunctionWords") && typeof settings.excludeFunctionWords !== "boolean" ||
        own(settings, "levelFilter") && (typeof settings.levelFilter !== "string" || !/^(all|[1-6])$/.test(settings.levelFilter))) fail("備份的每日目標或複習設定無效。");
    if (!object(data.stats[kind])) fail("備份的統計資料格式錯誤。");
    for (const [id, stat] of Object.entries(data.stats[kind])) {
      if (!ids.has(id)) fail("備份的統計參照不存在的題目。");
      validateStat(stat);
    }
    validateSession(data.sessions[kind], kind, ids, data.stats[kind], data.banks[kind]);
  }
  validateGrammarWork(own(data, "grammarWork") ? data.grammarWork : initialState().grammarWork, data.banks.grammar);
  if (own(data, "grammarKeys")) validateGrammarKeys(data.grammarKeys);
  if (own(data, "importInfo") && !object(data.importInfo)) fail("備份的匯入資訊格式錯誤。");
  const result = structuredClone(data);
  if (result.version === 1) {
    const defaults = initialState();
    for (const name of ["banks", "settings", "stats", "sessions"]) result[name].levels = defaults[name].levels;
    for (const kind of BANKS) {
      result.settings[kind].excludeFunctionWords ??= defaults.settings[kind].excludeFunctionWords;
    }
    // These remain concept statistics, never original-question practice statistics.
    result.sessions.grammar = null;
    result.grammarWork ??= defaults.grammarWork;
    result.version = 2;
  }
  result.grammarKeys ??= [];
  result.grammarWork ??= initialState().grammarWork;
  result.grammarWork.filter ??= "all";
  for (const answer of Object.values(result.grammarWork.answers)) {
    answer.correct ??= null;
    answer.submitted ??= Boolean(answer.answer.trim());
    answer.stat ??= null;
  }
  return result;
}

export function exportBackup(state) {
  return JSON.stringify(validateBackup(state), null, 2);
}

export async function restoreBackup(data, expectedRevision) {
  const restored = validateBackup(data);
  return mutateState(expectedRevision, () => restored, false);
}

export function exportListCSV(state, kind, status = "all") {
  bankCheck(kind);
  if (!["all", "correct", "wrong"].includes(status)) fail("未知的清單狀態。");
  const quote = value => {
    const text = String(value ?? "");
    const safe = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\n]/.test(text) ? "'" + text : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = [["bank", "id", "english", "chinese", "total_correct", "total_wrong", "streak", "lastpractice"]];
  for (const card of state.banks[kind]) {
    const stat = state.stats[kind][card.id];
    if (status !== "all" && stat?.status !== status) continue;
    rows.push([kind, card.id, card.english, card.chinese, stat?.correct ?? 0, stat?.wrong ?? 0, stat?.streak ?? 0, stat?.lastPracticed ?? ""]);
  }
  return "\ufeff" + rows.map(row => row.map(quote).join(",")).join("\r\n") + "\r\n";
}

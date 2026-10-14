import { labelFor, normalizeEnglish } from "./engine.js";

export const BANKS = Object.freeze(["words", "phrases", "grammar"]);
const DB_NAME = "english-review";
const STORE = "state";
let databasePromise;

const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeNumber = value => Number.isSafeInteger(value) && value >= 0;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const bankCheck = kind => BANKS.includes(kind) || fail("未知的題庫類型。");

export function parseCSV(text) {
  if (typeof text !== "string") fail("CSV 必須是文字。");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", quoted = false, closed = false, started = false;
  const pushField = () => { row.push(field); field = ""; closed = false; started = false; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ",") pushField();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (closed) fail(`CSV 第 ${rows.length + 1} 列：引號結束後有多餘文字。`);
    else if (char === '"') {
      if (started) fail(`CSV 第 ${rows.length + 1} 列：欄位中的引號必須跳脫。`);
      quoted = true;
      started = true;
    } else { field += char; started = true; }
  }
  if (quoted) fail("CSV 有未關閉的引號。");
  if (field !== "" || started || closed || row.length) pushRow();
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
  if (kind === "grammar" && !/^[a-z][a-z0-9_]*$/.test(id)) fail("文法題庫 ID 必須是文法分類名稱。");
}

export function ingestCSV(text, kind) {
  bankCheck(kind);
  const rows = parseCSV(text);
  if (rows.length < 2) fail("CSV 必須包含標題與至少一筆題目。");
  const headers = rows[0].map(value => value.trim());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) fail("CSV 欄位名稱不可空白或重複。");
  for (const name of ["id", "english", "chinese", "total_occurrences"]) {
    if (!headers.includes(name)) fail(`CSV 缺少必要欄位：${name}。`);
  }
  const ids = new Set();
  return rows.slice(1).map((row, index) => {
    if (row.length !== headers.length) fail(`CSV 第 ${index + 2} 列的欄位數與標題不符。`);
    const source = Object.fromEntries(headers.map((header, i) => [header, row[i]]));
    const id = source.id.trim();
    idCheck(id, kind);
    if (ids.has(id)) fail(`CSV 第 ${index + 2} 列的 ID 重複。`);
    ids.add(id);
    const english = source.english.trim(), chinese = source.chinese.trim();
    if (!english || !chinese) fail(`CSV 第 ${index + 2} 列的英文與中文不可空白。`);
    const frequency = numericCell(source.total_occurrences.trim(), "total_occurrences");
    for (const name of ["gsat_occurrences", "listening_occurrences"]) {
      if (own(source, name)) numericCell(source[name].trim(), name);
    }
    let level = null;
    if (source.ceec_level?.trim()) {
      const values = source.ceec_level.trim().split(";");
      if (values.some(value => !/^[1-6]$/.test(value.trim()))) fail(`CSV 第 ${index + 2} 列的 CEEC 級別必須介於 1 至 6。`);
      level = Math.min(...values.map(Number));
    }
    const details = Object.fromEntries(Object.entries(source).filter(([key, value]) =>
      !["id", "english", "chinese", "total_occurrences"].includes(key) && value !== ""));
    return { id, english, chinese, frequency, level, details };
  });
}

export function initialState() {
  return {
    version: 1,
    revision: 0,
    banks: { words: [], phrases: [], grammar: [] },
    settings: Object.fromEntries(BANKS.map((kind, i) => [kind, {
      target: [20, 10, 5][i], reviewQuota: [5, 3, 2][i],
      includeCorrect: true, includeWrong: true, retryGap: 3
    }])),
    stats: { words: {}, phrases: {}, grammar: {} },
    sessions: { words: null, phrases: null, grammar: null }
  };
}

export function openDB() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("瀏覽器無法使用 IndexedDB；請啟用網站儲存空間。"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE);
      store.put(initialState(), "current");
    };
    request.onerror = () => reject(request.error || new Error("無法開啟本機資料庫。"));
    request.onblocked = () => reject(new Error("資料庫升級被其他分頁阻擋，請關閉其他分頁後重試。"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      resolve(db);
    };
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

export async function readState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get("current");
    transaction.oncomplete = () => request.result ? resolve(request.result) : reject(new Error("本機資料遺失，請還原備份。"));
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("讀取本機資料失敗。"));
  });
}

export async function mutateState(expectedRevision, transform) {
  if (!safeNumber(expectedRevision) || typeof transform !== "function") fail("資料修改參數無效。");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    let result, failure;
    const request = store.get("current");
    request.onsuccess = () => {
      try {
        const current = request.result;
        if (!current || current.revision !== expectedRevision) fail("其他分頁已更新資料。請重新載入最新資料後再試，這次變更尚未儲存。");
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
  return mutateState(expectedRevision, state => {
    state.banks[kind] = imported;
    state.stats[kind] = Object.fromEntries(Object.entries(state.stats[kind]).filter(([id]) => ids.has(id)));
    state.sessions[kind] = null;
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

export function validateBackup(data) {
  if (!object(data) || data.version !== 1 || !safeNumber(data.revision)) fail("備份版本或資料格式不支援。");
  jsonValue(data);
  for (const name of ["banks", "settings", "stats", "sessions"]) {
    if (!object(data[name]) || Object.keys(data[name]).length !== BANKS.length ||
        BANKS.some(kind => !own(data[name], kind))) fail(`備份缺少完整的 ${name} 題庫資料。`);
  }
  for (const kind of BANKS) {
    const ids = validateCards(data.banks[kind], kind), settings = data.settings[kind];
    if (!object(settings) || !safeNumber(settings.target) || settings.target < 1 ||
        !safeNumber(settings.reviewQuota) || !safeNumber(settings.retryGap) || settings.retryGap < 1 ||
        typeof settings.includeCorrect !== "boolean" || typeof settings.includeWrong !== "boolean") fail("備份的每日目標或複習設定無效。");
    if (!object(data.stats[kind])) fail("備份的統計資料格式錯誤。");
    for (const [id, stat] of Object.entries(data.stats[kind])) {
      if (!ids.has(id)) fail("備份的統計參照不存在的題目。");
      validateStat(stat);
    }
    validateSession(data.sessions[kind], kind, ids, data.stats[kind], data.banks[kind]);
  }
  if (own(data, "importInfo") && !object(data.importInfo)) fail("備份的匯入資訊格式錯誤。");
  return structuredClone(data);
}

export function exportBackup(state) {
  return JSON.stringify(validateBackup(state), null, 2);
}

export async function restoreBackup(data, expectedRevision) {
  const restored = validateBackup(data);
  return mutateState(expectedRevision, () => restored);
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

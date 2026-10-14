import { recordAttempt } from "./engine.js";

function evidenceEntries(card) {
  const value = card.details?.evidence_json;
  if (!value) return [];
  const entries = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(entries)) throw new Error("文法證據格式錯誤，請重新匯入有效 CSV。");
  return entries;
}

function textChoice(choice) {
  if (typeof choice === "string") return choice.trim();
  if (choice && typeof choice.text === "string") return choice.text.trim();
  throw new Error("原始文法選項格式不支援，請檢查匯入資料。");
}

export function buildGrammarQuestions(cards) {
  const questions = new Map();
  for (const card of cards) {
    for (const entry of evidenceEntries(card)) {
      if (!entry || typeof entry.evidence !== "string" || !entry.evidence.trim()) continue;
      const number = String(entry.question ?? "");
      const key = [entry.source_id ?? "", entry.year_roc ?? "", number, entry.pdf_page ?? ""];
      if (!number || !entry.source_id) key.push(entry.evidence);
      const id = key.map(value => encodeURIComponent(String(value))).join("|");
      const category = { id: card.id, english: card.english, chinese: card.chinese };
      const existing = questions.get(id);
      if (existing) {
        if (!existing.categories.some(item => item.id === card.id)) existing.categories.push(category);
        if (entry.evidence.length > existing.original.length) existing.original = entry.evidence;
        if (!existing.choices.length && entry.choices?.length) existing.choices = [...new Set(entry.choices.map(textChoice).filter(Boolean))];
        continue;
      }
      questions.set(id, {
        id, number, year: entry.year_roc ?? null, page: entry.pdf_page ?? null,
        source: String(entry.source_id ?? ""), original: entry.evidence,
        choices: [...new Set((entry.choices ?? []).map(textChoice).filter(Boolean))],
        rationale: String(entry.rationale_zh ?? ""), confidence: String(entry.confidence ?? ""),
        categories: [category], frequency: card.frequency,
      });
    }
  }
  return [...questions.values()].sort((a, b) => b.frequency - a.frequency ||
    String(a.id).localeCompare(String(b.id), "en"));
}

export function clozePrompt(question) {
  const original = question.original;
  const number = String(question.number).trim();
  if (!/^[1-9]\d?$/.test(number)) return { before: original, marker: null, after: "" };
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${number})(?=$|[^\\p{L}\\p{N}])`, "gu");
  const matches = [...original.matchAll(pattern)].filter(match => {
    const start = match.index + match[1].length;
    return !/\d[.,]$/.test(original.slice(0, start)) &&
      !/^[.,]\d/.test(original.slice(start + number.length));
  });
  if (matches.length !== 1) return { before: original, marker: null, after: "" };
  const match = matches[0];
  const start = match.index + match[1].length;
  // Match only the supplied question number, never all numbers in the excerpt.
  return { before: original.slice(0, start), marker: number, after: original.slice(start + number.length) };
}

export function matchGrammarAnswer(question, keys) {
  const matches = keys.filter(key => key.source_id === question.source &&
    String(key.year_roc) === String(question.year) && String(key.question) === question.number);
  if (matches.length !== 1) return null;
  const key = matches[0];
  const options = question.choices.filter(choice => {
    const label = choice.match(/^\s*[\(\[（]?\s*([A-O])\s*[\)\]）.．、:\s]/i);
    return label && label[1].toUpperCase() === key.answer;
  });
  return options.length === 1 ? { ...key, choice: options[0] } : null;
}

export function recordGrammarResponse(question, keys, previous, answer, now = Date.now()) {
  if (previous?.submitted) return previous;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("請先作答。");
  if (question.choices.length && !question.choices.includes(answer)) throw new Error("請選取這道原題提供的選項。");
  const key = matchGrammarAnswer(question, keys);
  const correct = key ? answer === key.choice : null;
  return {
    answer, updatedAt: now, correct, submitted: true,
    expected: key?.choice ?? null, answerSource: key?.answer_source ?? null,
    stat: correct === null ? previous?.stat ?? null : recordAttempt(previous?.stat, correct, now),
  };
}

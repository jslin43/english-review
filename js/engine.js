export function localDay(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function normalizeEnglish(text) {
  return String(text ?? "").replace(/[\u2018\u2019]/g, "'").trim().replace(/\s+/g, " ").toLowerCase();
}

const functionParts = new Set([
  "pron", "pronoun", "prep", "preposition", "conj", "conjunction",
  "art", "article", "det", "determiner", "aux", "auxiliary", "modal",
  "代名詞", "代詞", "介系詞", "介詞", "連接詞", "連詞", "冠詞", "限定詞", "助動詞",
]);
const functionHeadwords = new Set([
  "a", "an", "the", "and", "or", "but", "if", "because", "although", "unless",
  "of", "in", "on", "at", "to", "from", "by", "with", "without", "for", "into",
  "onto", "upon", "among", "between", "during",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "our", "their", "its", "myself", "yourself", "himself", "herself",
  "itself", "ourselves", "yourselves", "themselves",
]);

export function isFunctionWord(card) {
  const details = card?.details;
  if (typeof details?.function_word === "boolean") return details.function_word;
  const rawPart = normalizeEnglish(details?.part_of_speech);
  if (rawPart && !["-", "—", "unknown", "n/a"].includes(rawPart)) {
    const parts = rawPart.replace(/\./g, " ")
      .replace(/\b(?:auxiliary|aux|modal)\s+(?:verb|v)\b/g, "aux")
      .replace(/\b(?:verb|v)\s+(?:auxiliary|aux|modal)\b/g, "aux")
      .replace(/\b(?:definite|indefinite)\s+article\b/g, "article")
      .split(/[\s,;；/|&+()[\]]+/).filter(Boolean);
    // Content or unknown POS in a mixed entry wins over closed-class headword guesses.
    return parts.length > 0 && parts.every(part => functionParts.has(part));
  }
  return functionHeadwords.has(normalizeEnglish(card?.english));
}

export function matchesLevel(card, levelFilter) {
  if (levelFilter === "all") return true;
  const level = [card.details?.ceec_level, card.details?.level, card.level]
    .find(value => value != null && String(value).trim() !== "");
  return String(level ?? "").split(/[;；]/).some(value => value.trim() === levelFilter);
}

function displayText(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

export function labelFor(card) {
  let label = displayText(card?.chinese);
  // Only explicit POS markers are removable; ordinary words such as「名詞解釋」are not.
  const prefix = /^(?:(?:n|v|vi|vt|adj|adv|prep|pron|conj|interj|aux|num|art)\.\s*|(?:名詞|動詞|形容詞|副詞|介系詞|代名詞|連接詞|感嘆詞)[：:]\s*|\((?:n|v|vi|vt|adj|adv|prep|pron|conj|interj|aux|num|art)\.?\)\s*)/i;
  while (prefix.test(label)) {
    const stripped = label.replace(prefix, "").trim();
    if (!stripped) break;
    label = stripped;
  }
  return label;
}

function shuffled(values, rng) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const value = Number(rng());
    const j = Math.floor(Math.max(0, Math.min(0.9999999999999999, Number.isFinite(value) ? value : 0)) * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function makeChoices(card, cards, rng = Math.random) {
  const expected = labelFor(card);
  if (!expected) return null;
  const otherLabels = [...new Set(cards.map(labelFor))].filter(label => label && label !== expected);
  if (otherLabels.length < 3) return null;
  return shuffled([expected, ...shuffled(otherLabels, rng).slice(0, 3)], rng);
}

function compareIds(a, b) {
  const left = String(a.id);
  const right = String(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function frequencySort(cards) {
  return [...cards].sort((a, b) => (Number(b.frequency) || 0) - (Number(a.frequency) || 0) || compareIds(a, b));
}

function practicedOn(stat, day) {
  return Boolean(stat && (stat.days?.includes(day) ||
    (stat.lastPracticed != null && localDay(stat.lastPracticed) === day)));
}

export function todayCount(stats = {}, now = Date.now()) {
  const day = localDay(now);
  return Object.values(stats).filter(stat => practicedOn(stat, day)).length;
}

export function bankSummary(cards, stats = {}, now = Date.now()) {
  const day = localDay(now);
  const result = { total: cards.length, unseen: 0, correct: 0, wrong: 0, todayCount: 0 };
  for (const card of cards) {
    const stat = stats[card.id];
    if (!stat) result.unseen++;
    else if (stat.status === "correct") result.correct++;
    else result.wrong++;
    if (practicedOn(stat, day)) result.todayCount++;
  }
  return result;
}

function integerSetting(value, fallback, minimum) {
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function reviewSort(cards, stats) {
  return [...cards].sort((a, b) => {
    const left = stats[a.id];
    const right = stats[b.id];
    const weakness = Number(right.status === "wrong") - Number(left.status === "wrong");
    const streak = (left.streak || 0) - (right.streak || 0);
    const due = (new Date(left.lastPracticed ?? 0).getTime() || 0) -
      (new Date(right.lastPracticed ?? 0).getTime() || 0);
    return weakness || streak || due || (Number(b.frequency) || 0) - (Number(a.frequency) || 0) || compareIds(a, b);
  });
}

export function buildSession({
  kind, cards, stats = {}, settings = {}, purpose = "daily", order = "frequency",
  mode = "typing", levelFilter = "all", reviewIds = [], now = Date.now(), rng = Math.random,
}) {
  const day = localDay(now);
  const target = integerSetting(settings.target, 20, 1);
  const retryGap = integerSetting(settings.retryGap, 3, 1);
  const uniqueCards = [...new Map(cards.map(card => [card.id, card])).values()];
  const vocabulary = kind === "words" || kind === "levels" || kind === "extra";
  const selectedLevel = vocabulary && /^[1-6]$/.test(String(levelFilter)) ? String(levelFilter) : "all";
  const excludeFunctionWords = vocabulary && settings.excludeFunctionWords !== false;
  // Filters apply at session creation only; saved queues keep their original targets.
  const targetCards = uniqueCards.filter(card => matchesLevel(card, selectedLevel) &&
    (!excludeFunctionWords || !isFunctionWord(card)));
  const practicedCount = vocabulary ?
    targetCards.filter(card => practicedOn(stats[card.id], day)).length : todayCount(stats, now);
  const capacity = purpose === "wrong" || purpose === "marked" ? target : Math.max(0, target - practicedCount);
  const arrange = values => order === "random" ? shuffled(values, rng) : frequencySort(values);
  let selected;
  if (purpose === "marked") {
    const markedIds = new Set(reviewIds);
    selected = arrange(targetCards.filter(card => markedIds.has(card.id))).slice(0, capacity);
  } else if (purpose === "wrong") {
    selected = arrange(targetCards.filter(card => stats[card.id]?.status === "wrong")).slice(0, capacity);
  } else {
    const eligible = targetCards.filter(card => !practicedOn(stats[card.id], day));
    const unseen = arrange(eligible.filter(card => !stats[card.id]));
    const reviews = reviewSort(eligible.filter(card => {
      const stat = stats[card.id];
      return stat && (stat.status === "correct" ? settings.includeCorrect !== false : settings.includeWrong !== false);
    }), stats);
    const quota = Math.min(integerSetting(settings.reviewQuota, 5, 0), capacity, reviews.length);
    selected = [...reviews.slice(0, quota), ...unseen.slice(0, capacity - quota)];
    selected.push(...reviews.slice(quota, quota + capacity - selected.length));
    selected = arrange(selected);
  }
  const id = `${kind}:${new Date(now).getTime()}:${String(rng()).slice(2)}`;
  const actualMode = kind === "grammar" ? "choice" : mode === "choice" ? "choice" : "typing";
  const queue = selected.map((card, index) => ({
    id: card.id,
    token: `${id}:${index}`,
    origin: stats[card.id] ? "review" : "new",
    choices: makeChoices(card, uniqueCards, rng),
  }));
  return {
    id, kind, day, purpose, mode: actualMode, order, queue, index: 0, feedback: null,
    levelFilter: selectedLevel, excludeFunctionWords,
    attempts: 0, answeredIds: [], newCount: queue.filter(item => item.origin === "new").length,
    reviewCount: queue.filter(item => item.origin === "review").length,
    pendingRetries: [], retryGap, nextToken: queue.length, completed: queue.length === 0,
  };
}

export function currentItem(session) {
  return !session || session.completed ? null : session.queue[session.index] ?? null;
}

export function recordAttempt(previous, correct, now = Date.now()) {
  previous = previous ?? {};
  const streak = correct ? (previous.streak || 0) + 1 : 0;
  const status = !correct || (previous.status === "wrong" && streak < 3) ? "wrong" : "correct";
  const days = [...new Set([...(previous.days ?? []), localDay(now)])];
  return {
    ...previous, attempts: (previous.attempts || 0) + 1,
    correct: (previous.correct || 0) + Number(correct),
    wrong: (previous.wrong || 0) + Number(!correct), status, streak,
    lastPracticed: new Date(now).getTime(), days,
  };
}

export function gradeSession(session, stats, { token, answer, cards, now = Date.now(), rng = Math.random }) {
  const unchanged = { session, stats, graded: false };
  const item = currentItem(session);
  if (!item || session.feedback || token !== item.token) return unchanged;
  const card = cards.find(candidate => candidate.id === item.id);
  if (!card || typeof answer !== "string" || !answer.trim()) return unchanged;
  const choice = session.kind === "grammar" || session.mode === "choice";
  const expected = choice ? labelFor(card) : card.english;
  const supplied = choice ? displayText(answer) : normalizeEnglish(answer);
  if (choice && (!item.choices || item.choices.length !== 4 || !item.choices.includes(supplied))) return unchanged;
  const correct = supplied === (choice ? expected : normalizeEnglish(expected));
  const day = localDay(now);
  const nextStats = {
    ...stats,
    [item.id]: recordAttempt(stats[item.id], correct, now),
  };
  const attempts = session.attempts + 1;
  let pendingRetries = session.pendingRetries.filter(retry => retry.id !== item.id);
  if (!correct) {
    pendingRetries = [...pendingRetries, {
      id: item.id, dueAfter: attempts + session.retryGap,
      choices: makeChoices(card, cards, rng), deferred: item.origin === "retry",
    }];
  }
  return {
    session: {
      ...session, attempts, pendingRetries,
      answeredIds: [...new Set([...session.answeredIds, item.id])],
      feedback: { id: item.id, token, correct, expected, answer, day },
    },
    stats: nextStats, graded: true,
  };
}

export function advanceSession(session, { now = Date.now() } = {}) {
  if (!session || session.completed || !session.feedback) return session;
  const index = session.index + 1;
  // Each base item gets at most one automatic retry, so an all-wrong round still ends.
  const ready = session.pendingRetries.filter(retry => !retry.deferred && retry.dueAfter <= session.attempts);
  let nextToken = session.nextToken;
  const retries = ready.map(retry => ({
    id: retry.id, token: `${session.id}:${nextToken++}`, origin: "retry", choices: retry.choices,
  }));
  const queue = [...session.queue.slice(0, index), ...retries, ...session.queue.slice(index)];
  return {
    ...session, queue, index, nextToken, feedback: null,
    pendingRetries: session.pendingRetries.filter(retry => retry.deferred || retry.dueAfter > session.attempts),
    completed: index >= queue.length, lastAdvanced: new Date(now).getTime(),
  };
}

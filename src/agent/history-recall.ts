const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export type CalendarDate = { year: number; month: number; day: number };

export function isHistoryRecallQuestion(query: string) {
  return /\b(what|which|remind|recall|discuss(?:ed|ion)?|asked|talked)\b/i.test(query)
    && /\b(ask(?:ed)?|discuss(?:ed|ion)?|talked|conversation|chat|question|history|remember)\b/i.test(query)
    && /\b(on|about|from|last|previous|past|earlier)\b/i.test(query);
}

export function historyRecallTopic(query: string) {
  const monthPattern = MONTHS.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join("|");
  const weekdayPattern = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
  return query
    .replace(/\b20\d{2}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(new RegExp(`\\b(?:${monthPattern})\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${weekdayPattern})\\b`, "gi"), " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\b/g, " ")
    .replace(/\b(what|which|did|do|i|we|you|me|my|our|the|a|an|on|in|at|from|about|previously|earlier|last|conversation|chat|discussed|discussion|talked|asked|ask|remember|recall|tell|remind)\b/gi, " ")
    .replace(/[^a-z0-9.+#-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRecallDate(query: string, timeZone: string, now = new Date()): CalendarDate | null {
  const iso = query.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return validCalendarDate({ year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) });
  const monthPattern = MONTHS.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join("|");
  const monthFirst = query.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i"));
  const dayFirst = query.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:\\s+(20\\d{2}))?\\b`, "i"));
  const match = monthFirst ?? dayFirst;
  if (match) {
    const monthToken = (monthFirst ? match[1] : match[2]).toLocaleLowerCase("en-US");
    const month = MONTHS.findIndex((name) => name.startsWith(monthToken.slice(0, 3)));
    const day = Number(monthFirst ? match[2] : match[1]);
    let year = Number(match[3]);
    if (!year) year = localDateParts(now.toISOString(), timeZone)?.year ?? now.getUTCFullYear();
    if (month < 0) return null;
    return validCalendarDate({ year, month, day });
  }

  const weekdayMatch = query.match(/\b(?:(last|previous|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (!weekdayMatch) return null;
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const targetWeekday = weekdays.indexOf(weekdayMatch[2].toLocaleLowerCase("en-US"));
  const today = localDateParts(now.toISOString(), timeZone);
  if (!today) return null;
  const todayUtc = new Date(Date.UTC(today.year, today.month, today.day));
  const todayWeekday = todayUtc.getUTCDay();
  let daysOffset = (todayWeekday - targetWeekday + 7) % 7;
  const modifier = weekdayMatch[1]?.toLocaleLowerCase("en-US");
  if (modifier === "this" && targetWeekday > todayWeekday) daysOffset -= 7;
  else if ((modifier === "last" || modifier === "previous" || !modifier) && daysOffset === 0) daysOffset = 7;
  todayUtc.setUTCDate(todayUtc.getUTCDate() - daysOffset);
  return { year: todayUtc.getUTCFullYear(), month: todayUtc.getUTCMonth(), day: todayUtc.getUTCDate() };
}

function validCalendarDate(date: CalendarDate): CalendarDate | null {
  if (date.year < 1 || date.month < 0 || date.month > 11 || date.day < 1 || date.day > 31) return null;
  const normalized = new Date(Date.UTC(date.year, date.month, date.day));
  return normalized.getUTCFullYear() === date.year && normalized.getUTCMonth() === date.month && normalized.getUTCDate() === date.day ? date : null;
}

export function localDateParts(timestamp: string, timeZone: string): CalendarDate | null {
  const parsed = new Date(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(parsed);
    return {
      year: Number(parts.find((part) => part.type === "year")?.value),
      month: Number(parts.find((part) => part.type === "month")?.value) - 1,
      day: Number(parts.find((part) => part.type === "day")?.value),
    };
  } catch {
    return localDateParts(timestamp, "UTC");
  }
}

function localMidnightAsUtc(date: CalendarDate, timeZone: string) {
  const target = Date.UTC(date.year, date.month, date.day);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const part = (name: string) => Number(parts.find((item) => item.type === name)?.value);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    guess += target - represented;
  }
  return new Date(guess);
}

export function dateWindowUtc(date: CalendarDate, timeZone = "UTC") {
  const start = localMidnightAsUtc(date, timeZone);
  const nextDayUtc = new Date(Date.UTC(date.year, date.month, date.day + 1));
  const end = localMidnightAsUtc({ year: nextDayUtc.getUTCFullYear(), month: nextDayUtc.getUTCMonth(), day: nextDayUtc.getUTCDate() }, timeZone);
  const sqlDate = (value: Date) => value.toISOString().slice(0, 19).replace("T", " ");
  return { startUtc: sqlDate(start), endUtc: sqlDate(end) };
}

export function sameDate(left: CalendarDate | null, right: CalendarDate) {
  return !!left && left.year === right.year && left.month === right.month && left.day === right.day;
}

export function formatCalendarDate(date: CalendarDate) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(date.year, date.month, date.day, 12)));
}

type RecallRow = { id: number | string; conversation_id: string; role: string; content: string; created_at: string };

function isFailedRecallAnswer(answer: string) {
  return /(?:don't|do not|cannot|can't) have access to (?:your )?(?:any )?(?:previous|other|past|separate)|no (?:history|record|saved conversation)|if you remember any specific|feel free to share (?:it|them|any specific)/i.test(answer);
}

export function selectRecallTurns(rows: RecallRow[], topic: string, limit = 5) {
  const terms = [...new Set((topic.toLocaleLowerCase("en-US").match(/[a-z0-9][a-z0-9.+#-]*/g) ?? []).filter((term) => term.length > 2))];
  const conversations = new Map<string, RecallRow[]>();
  for (const row of rows) {
    const group = conversations.get(row.conversation_id) ?? [];
    group.push(row);
    conversations.set(row.conversation_id, group);
  }

  const turns: Array<{ conversationId: string; question: string; answer: string; createdAt: string; score: number }> = [];
  for (const [conversationId, conversationRows] of conversations) {
    conversationRows.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    conversationRows.forEach((row, index) => {
      if (row.role !== "user" || isHistoryRecallQuestion(row.content)) return;
      const question = row.content.trim();
      const matchedTerms = terms.filter((term) => question.toLocaleLowerCase("en-US").includes(term));
      if (terms.length && matchedTerms.length === 0) return;
      const answerRow = conversationRows.slice(index + 1).find((candidate) => candidate.role === "assistant");
      const answer = answerRow?.content.trim() ?? "";
      if (isFailedRecallAnswer(answer)) return;
      turns.push({ conversationId, question, answer, createdAt: row.created_at, score: matchedTerms.length * 10 + (answer ? 1 : 0) });
    });
  }
  return turns.sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
}

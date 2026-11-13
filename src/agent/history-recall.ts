const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export type CalendarDate = { year: number; month: number; day: number };

export function isHistoryRecallQuestion(query: string) {
  return /\b(what|which|remind|recall|discuss(?:ed|ion)?|asked|talked)\b/i.test(query)
    && /\b(ask(?:ed)?|discuss(?:ed|ion)?|talked|conversation|chat|question|history|remember)\b/i.test(query)
    && /\b(on|about|from|last|previous|past|earlier)\b/i.test(query);
}

export function historyRecallTopic(query: string) {
  const monthPattern = MONTHS.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join("|");
  return query
    .replace(/\b20\d{2}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(new RegExp(`\\b(?:${monthPattern})\\b`, "gi"), " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\b/g, " ")
    .replace(/\b(what|which|did|do|i|we|you|me|my|our|the|a|an|on|in|at|from|about|previously|earlier|last|conversation|chat|discussed|discussion|talked|asked|ask|remember|recall|tell|remind)\b/gi, " ")
    .replace(/[^a-z0-9.+#-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRecallDate(query: string, timeZone: string, now = new Date()): CalendarDate | null {
  const iso = query.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) };
  const monthPattern = MONTHS.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join("|");
  const monthFirst = query.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i"));
  const dayFirst = query.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:\\s+(20\\d{2}))?\\b`, "i"));
  const match = monthFirst ?? dayFirst;
  if (!match) return null;
  const monthToken = (monthFirst ? match[1] : match[2]).toLocaleLowerCase("en-US");
  const month = MONTHS.findIndex((name) => name.startsWith(monthToken.slice(0, 3)));
  const day = Number(monthFirst ? match[2] : match[1]);
  let year = Number(monthFirst ? match[3] : match[3]);
  if (!year) {
    try {
      year = Number(new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(now));
    } catch {
      year = now.getUTCFullYear();
    }
  }
  if (month < 0 || day < 1 || day > 31) return null;
  return { year, month, day };
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

export function dateWindowUtc(date: CalendarDate) {
  const start = new Date(Date.UTC(date.year, date.month, date.day - 1));
  const end = new Date(Date.UTC(date.year, date.month, date.day + 2));
  const sqlDate = (value: Date) => value.toISOString().slice(0, 19).replace("T", " ");
  return { startUtc: sqlDate(start), endUtc: sqlDate(end) };
}

export function sameDate(left: CalendarDate | null, right: CalendarDate) {
  return !!left && left.year === right.year && left.month === right.month && left.day === right.day;
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

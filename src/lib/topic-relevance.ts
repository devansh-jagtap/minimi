const GENERIC_TOPIC_TERMS = new Set([
  "about", "answer", "answers", "asked", "asking", "best", "change", "changed", "changes",
  "compare", "compared", "comparison", "conclusion", "current", "discussion", "discussed",
  "earlier", "evidence", "feature", "features", "finding", "findings", "for", "from", "has",
  "have", "history", "important", "information", "key", "last", "major", "me", "memory",
  "most", "now", "our", "past", "please", "previous", "pricing", "price", "prices",
  "provider", "providers", "recommend", "recommendation", "recommendations", "research",
  "retrieve", "same", "since", "summary", "tell", "the", "their", "them", "there", "this",
  "today", "topic", "update", "updates", "what", "when", "where", "which", "who", "why",
  "with", "would", "you", "your", "and", "did", "do", "does", "we", "was", "were", "is",
  "are", "can", "could", "should", "will", "not", "any", "all", "also", "about", "then",
]);

const ALIASES: Record<string, string> = {
  postgres: "database",
  postgresql: "database",
  db: "database",
};

export function topicTerms(value: string) {
  const normalized = value.toLocaleLowerCase("en-US").match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [];
  const terms = new Set<string>();
  for (const raw of normalized) {
    const term = ALIASES[raw] ?? (raw.length > 5 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
    if (term.length > 2 && !GENERIC_TOPIC_TERMS.has(term)) terms.add(term);
  }
  return terms;
}

export function topicOverlap(left: string, right: string) {
  const leftTerms = topicTerms(left);
  const rightTerms = topicTerms(right);
  return [...leftTerms].filter((term) => rightTerms.has(term));
}

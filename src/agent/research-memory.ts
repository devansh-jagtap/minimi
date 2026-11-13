import { generateObject } from "ai";
import { z } from "zod";

import { model } from "@/lib/ai";
import {
  findResearchSessions,
  getObservations,
  saveObservations,
  saveResearchSession,
  type ResearchObservation,
} from "@/lib/db";
import type { SearchHit } from "@/tools/web-search";

const ExtractionSchema = z.object({
  observations: z.array(z.object({
    entity: z.string().min(1).max(120),
    entityType: z.enum(["company", "product", "technology", "other"]),
    attribute: z.string().min(1).max(120),
    value: z.string().min(1).max(500),
    sourceUrl: z.string().url(),
    evidenceQuote: z.string().min(15).max(600),
    validFrom: z.string().date().optional(),
  })).max(12),
});

export function filterSupportedObservations(raw: unknown, hits: SearchHit[]): ResearchObservation[] {
  const parsed = ExtractionSchema.safeParse(raw);
  if (!parsed.success) return [];

  const hitsByUrl = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const matching = hitsByUrl.get(hit.url) ?? [];
    matching.push(hit);
    hitsByUrl.set(hit.url, matching);
  }

  return parsed.data.observations.flatMap((item): ResearchObservation[] => {
    const source = (hitsByUrl.get(item.sourceUrl) ?? []).find((hit) =>
      hit.content.toLocaleLowerCase("en-US").includes(item.evidenceQuote.trim().toLocaleLowerCase("en-US")),
    );
    if (!source || (item.validFrom && !item.evidenceQuote.includes(item.validFrom))) return [];

    let publisher: string;
    try {
      publisher = new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      return [];
    }

    return [{
      entity: { name: item.entity, type: item.entityType },
      source: { url: source.url, title: source.title, publisher, publishedAt: source.publishedDate },
      attribute: item.attribute,
      value: item.value,
      validFrom: item.validFrom,
    }];
  });
}

export type ComparisonStatus = "confirmed change" | "no change found in available evidence" | "insufficient evidence";

export function classifyObservationComparison(
  historical?: { entity: string; attribute: string; value: string; sourceUrl: string },
  current?: { entity: string; attribute: string; value: string; sourceUrl: string },
): ComparisonStatus {
  if (!historical || !current || !historical.sourceUrl || !current.sourceUrl) return "insufficient evidence";
  const sameEntity = historical.entity.trim().toLocaleLowerCase("en-US") === current.entity.trim().toLocaleLowerCase("en-US");
  const sameAttribute = historical.attribute.trim().toLocaleLowerCase("en-US") === current.attribute.trim().toLocaleLowerCase("en-US");
  if (!sameEntity || !sameAttribute) return "insufficient evidence";
  const normalizeValue = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  return normalizeValue(historical.value) === normalizeValue(current.value)
    ? "no change found in available evidence"
    : "confirmed change";
}

const STOP_WORDS = new Set([
  "a", "about", "after", "any", "are", "asked", "before", "changed", "changes",
  "did", "does", "for", "from", "has", "have", "how", "i", "in", "is", "it",
  "me", "my", "of", "on", "or", "our", "please", "since", "the", "them", "then",
  "there", "these", "they", "this", "those", "to", "was", "we", "were", "what",
  "when", "which", "who", "with", "you", "your", "still", "today", "now",
]);

const terms = (value: string) => new Set(
  (value.toLocaleLowerCase("en-US").match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [])
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
);

function temporalMatch(query: string, timestamp: string) {
  const observed = new Date(timestamp);
  if (Number.isNaN(observed.getTime())) return false;
  const queryLower = query.toLocaleLowerCase("en-US");
  const observedDay = observed.getUTCDate();
  const observedMonth = observed.getUTCMonth();
  const observedYear = observed.getUTCFullYear();
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  const iso = queryLower.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return observedYear === Number(iso[1]) && observedMonth === Number(iso[2]) - 1 && observedDay === Number(iso[3]);

  const date = queryLower.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?\b/);
  if (date) {
    const month = monthNames.indexOf(date[2]);
    return observedDay === Number(date[1]) && observedMonth === month && (!date[3] || observedYear === Number(date[3]));
  }

  const weekdayIndex = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .findIndex((day) => new RegExp(`\\b${day}\\b`).test(queryLower));
  if (weekdayIndex < 0) return false;
  const now = new Date();
  const latest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysBack = (latest.getUTCDay() - weekdayIndex + 7) % 7 || 7;
  latest.setUTCDate(latest.getUTCDate() - daysBack);
  const lastWeek = new Date(latest);
  lastWeek.setUTCDate(latest.getUTCDate() - 7);
  const observedDate = Date.UTC(observedYear, observedMonth, observedDay);
  return observedDate === latest.getTime() || observedDate === lastWeek.getTime();
}

export async function findRelevantResearch(conversationId: string, query: string) {
  const sessions = await findResearchSessions({ conversationId, limit: 50 });
  if (!sessions.length) return [];

  const sessionIds = sessions.map((session) => String(session.id));
  const observations = await getObservations({ sessionIds, limit: 200 });
  const queryTerms = terms(query);
  const scored = sessions.map((session) => {
    const sessionObservations = observations.filter(
      (observation) => String(observation.research_session_id) === String(session.id),
    );
    const entities = [...new Set(sessionObservations.map((observation) => String(observation.display_name)))];
    const entityMatches = entities.filter((entity) =>
      query.toLocaleLowerCase("en-US").includes(entity.toLocaleLowerCase("en-US")),
    );
    const topicTerms = terms(`${String(session.topic)} ${String(session.summary)}`);
    const topicMatches = [...queryTerms].filter((term) => topicTerms.has(term));
    const isDateMatch = temporalMatch(query, String(session.researched_at));
    return { session, sessionObservations, entityMatches, topicMatches, isDateMatch, score: entityMatches.length * 3 + topicMatches.length + (isDateMatch ? 10 : 0) };
  }).filter((item) => item.isDateMatch || item.entityMatches.length > 0 || item.topicMatches.length >= 2)
    .sort((a, b) => b.score - a.score || String(b.session.researched_at).localeCompare(String(a.session.researched_at)))
    .slice(0, 5);

  return scored.map(({ session, sessionObservations }) => ({
    session: {
      topic: String(session.topic),
      summary: String(session.summary),
      researchedAt: String(session.researched_at),
    },
    observations: sessionObservations.map((observation) => ({
      entity: String(observation.display_name),
      entityType: String(observation.entity_type),
      attribute: String(observation.attribute),
      value: String(observation.value),
      observedAt: String(observation.observed_at),
      validFrom: observation.valid_from ? String(observation.valid_from) : undefined,
      source: {
        title: String(observation.title),
        url: String(observation.url),
        publisher: observation.publisher ? String(observation.publisher) : undefined,
        publishedAt: observation.published_at ? String(observation.published_at) : undefined,
        retrievedAt: String(observation.observed_at),
      },
    })),
  }));
}

export async function recordResearch(input: {
  conversationId: string;
  question: string;
  answer: string;
  searchHits: SearchHit[];
  abortSignal?: AbortSignal;
}) {
  if (input.searchHits.length === 0) return;
  const extractionStartedAt = Date.now();

  const retrievedAt = input.searchHits.reduce(
    (latest, hit) => hit.retrievedAt > latest ? hit.retrievedAt : latest,
    input.searchHits[0].retrievedAt,
  );
  const promptEvidence = input.searchHits.slice(0, 10).map((hit, index) => ({
    index,
    title: hit.title,
    url: hit.url,
    publishedAt: hit.publishedDate,
    retrievedAt: hit.retrievedAt,
    content: hit.content.slice(0, 1800),
  }));

  const { object } = await generateObject({
    model,
    schema: ExtractionSchema,
    schemaName: "evidence_backed_research_observations",
    abortSignal: input.abortSignal,
    maxOutputTokens: 1800,
    prompt: `Extract up to 12 durable facts relevant to the user's research question. Use only the supplied search evidence. Never infer facts from the assistant answer. Each observation must include an exact verbatim evidenceQuote found in that source's content, and sourceUrl must exactly match a supplied URL. Capture pricing, plan limits, features, and dated releases where explicitly supported. Only set validFrom when the evidence quote itself states that effective date; otherwise omit it. Return an empty list when no verifiable facts are present.

Question: ${input.question.slice(0, 2000)}

Search evidence JSON:
${JSON.stringify(promptEvidence)}`,
  });
  console.info(`[Minimi] Evidence extraction completed in ${Date.now() - extractionStartedAt}ms across ${input.searchHits.length} results`);

  const supported = filterSupportedObservations(object, input.searchHits);

  const session = await saveResearchSession({
    conversationId: input.conversationId,
    topic: input.question.trim().slice(0, 300),
    summary: input.answer.trim().slice(0, 2000),
    researchedAt: retrievedAt,
  });

  if (supported.length) {
    await saveObservations(session.id, supported, retrievedAt);
  }
  console.info(`[Minimi] Research memory saved ${supported.length} supported observations`);
}

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
import { localDateParts, parseRecallDate, sameDate } from "@/agent/history-recall";

const ExtractionSchema = z.object({
  observations: z.array(z.object({
    entity: z.string().min(1).max(120),
    entityType: z.enum(["company", "product", "technology", "other"]),
    attribute: z.string().min(1).max(120),
    value: z.string().min(1).max(500),
    sourceUrl: z.string().url(),
    evidenceQuote: z.string().min(15).max(600),
    validFrom: z.string().date().optional(),
    comparison: z.object({
      planTier: z.string().max(100).optional(),
      currency: z.string().max(8).optional(),
      billingInterval: z.string().max(40).optional(),
      priceBasis: z.string().max(100).optional(),
      region: z.string().max(100).optional(),
    }).optional(),
  })).max(12),
});

function normalizedText(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function currencyCode(value: string) {
  const text = value.toLocaleUpperCase("en-US");
  if (/\bUSD\b|\$/.test(text)) return "USD";
  if (/\bEUR\b|€/.test(text)) return "EUR";
  if (/\bGBP\b|£/.test(text)) return "GBP";
  if (/\bCAD\b/.test(text)) return "CAD";
  if (/\bAUD\b/.test(text)) return "AUD";
  if (/\bINR\b|₹/.test(text)) return "INR";
  if (/\bJPY\b|¥/.test(text)) return "JPY";
  return undefined;
}

function amountValues(value: string) {
  return [...value.matchAll(/(?:\b\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)].map((match) => Number(match[0].replaceAll(",", "")));
}

function canonicalPriceUnits(value: string) {
  const text = normalizedText(value);
  const units: string[] = [];
  if (/\b(per\s+)?user\b/.test(text)) units.push("user");
  if (/\b(per\s+)?seat\b/.test(text)) units.push("seat");
  if (/\b(per\s+)?month(ly)?\b/.test(text)) units.push("month");
  if (/\b(per\s+)?year(ly|annually)?\b|\bannual(ly)?\b/.test(text)) units.push("year");
  if (/\b(per\s+)?account\b/.test(text)) units.push("account");
  if (/\b(per\s+)?organization\b/.test(text)) units.push("organization");
  return units.sort().join("/");
}

function valueSupportedByQuote(value: string, quote: string) {
  const amounts = amountValues(value);
  if (amounts.length) {
    const quoteAmounts = amountValues(quote);
    if (amounts.some((amount) => !quoteAmounts.includes(amount))) return false;
    const claimedCurrency = currencyCode(value);
    if (claimedCurrency && currencyCode(quote) !== claimedCurrency) return false;
    const claimedUnits = canonicalPriceUnits(value);
    return !claimedUnits || canonicalPriceUnits(quote) === claimedUnits;
  }
  const normalizedValue = normalizedText(value);
  return normalizedValue.length >= 3 && normalizedText(quote).includes(normalizedValue);
}

function quoteSupportsDate(quote: string, validFrom: string) {
  const [year, month, day] = validFrom.split("-").map(Number);
  if (quote.includes(validFrom)) return true;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const monthName = months[month - 1];
  const escapedMonth = monthName.slice(0, 3) + `(?:${monthName.slice(3)})?`;
  const patterns = [
    new RegExp(`\\b${escapedMonth}\\s+${day}(?:st|nd|rd|th)?(?:,?\\s+${year})?\\b`, "i"),
    new RegExp(`\\b${day}(?:st|nd|rd|th)?\\s+${escapedMonth}(?:\\s+${year})?\\b`, "i"),
  ];
  return patterns.some((pattern) => pattern.test(quote));
}

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
    if (!source || !valueSupportedByQuote(item.value, item.evidenceQuote)) return [];
    if (item.validFrom && !quoteSupportsDate(item.evidenceQuote, item.validFrom)) return [];

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
      comparison: item.comparison ? {
        planTier: item.comparison.planTier?.trim() || undefined,
        currency: item.comparison.currency?.trim() || undefined,
        billingInterval: item.comparison.billingInterval?.trim() || undefined,
        priceBasis: item.comparison.priceBasis?.trim() || undefined,
        region: item.comparison.region?.trim() || undefined,
      } : undefined,
    }];
  });
}

export type ComparisonStatus = "confirmed change" | "no change found in available evidence" | "insufficient evidence";

export function classifyObservationComparison(
  historical?: { entity: string; attribute: string; value: string; sourceUrl: string; comparison?: ResearchObservation["comparison"] },
  current?: { entity: string; attribute: string; value: string; sourceUrl: string; comparison?: ResearchObservation["comparison"] },
): ComparisonStatus {
  if (!historical || !current || !historical.sourceUrl || !current.sourceUrl) return "insufficient evidence";
  const sameEntity = historical.entity.trim().toLocaleLowerCase("en-US") === current.entity.trim().toLocaleLowerCase("en-US");
  const sameAttribute = historical.attribute.trim().toLocaleLowerCase("en-US") === current.attribute.trim().toLocaleLowerCase("en-US");
  if (!sameEntity || !sameAttribute) return "insufficient evidence";
  const priceLike = /price|cost|\$|€|£|₹|\b(?:usd|eur|gbp|cad|aud|inr)\b/i.test(`${historical.attribute} ${current.attribute} ${historical.value} ${current.value}`);
  if (priceLike) {
    const requiredDimensions: Array<keyof NonNullable<ResearchObservation["comparison"]>> = ["planTier", "currency", "billingInterval", "priceBasis", "region"];
    for (const dimension of requiredDimensions) {
      const oldValue = historical.comparison?.[dimension]?.trim().toLocaleLowerCase("en-US");
      const newValue = current.comparison?.[dimension]?.trim().toLocaleLowerCase("en-US");
      if (!oldValue || !newValue || oldValue !== newValue) return "insufficient evidence";
    }
    const oldCurrency = currencyCode(historical.value);
    const newCurrency = currencyCode(current.value);
    const oldAmount = amountValues(historical.value);
    const newAmount = amountValues(current.value);
    if (!oldAmount.length || !newAmount.length || oldCurrency !== newCurrency || oldAmount.length !== 1 || newAmount.length !== 1) return "insufficient evidence";
  }
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

export function temporalMatch(query: string, timestamp: string, timeZone = "UTC", now = new Date()) {
  const requestedDate = parseRecallDate(query, timeZone, now);
  return requestedDate ? sameDate(localDateParts(timestamp, timeZone), requestedDate) : false;
}

export async function findRelevantResearch(ownerId: string, query: string, temporalQuery = query, globalUserScope = false, timeZone = "UTC") {
  const sessions = await findResearchSessions(globalUserScope ? { userId: ownerId, limit: 50 } : { conversationId: ownerId, limit: 50 });
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
    const isDateMatch = temporalMatch(temporalQuery, String(session.researched_at), timeZone);
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
    observations: sessionObservations.slice(0, 8).map((observation) => ({
      entity: String(observation.display_name),
      entityType: String(observation.entity_type),
      attribute: String(observation.attribute),
      value: String(observation.value),
      observedAt: String(observation.observed_at),
      validFrom: observation.valid_from ? String(observation.valid_from) : undefined,
      comparison: {
        planTier: observation.plan_tier ? String(observation.plan_tier) : undefined,
        currency: observation.currency ? String(observation.currency) : undefined,
        billingInterval: observation.billing_interval ? String(observation.billing_interval) : undefined,
        priceBasis: observation.price_basis ? String(observation.price_basis) : undefined,
        region: observation.region ? String(observation.region) : undefined,
      },
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
  userId: string;
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
    prompt: `Extract up to 12 durable facts relevant to the user's research question. Use only the supplied search evidence. Never infer facts from the assistant answer. Each observation must include an exact verbatim evidenceQuote found in that source's content, and sourceUrl must exactly match a supplied URL. Capture pricing, plan limits, features, and dated releases where explicitly supported. For prices, also extract comparison metadata only when the evidence explicitly supports it: planTier, currency, billingInterval, priceBasis (for example per user, per seat, or per account), and region. Leave unknown dimensions out; never infer them. Only set validFrom when the evidence quote itself states that effective date; otherwise omit it. Return an empty list when no verifiable facts are present.

Question: ${input.question.slice(0, 2000)}

Search evidence JSON:
${JSON.stringify(promptEvidence)}`,
  });
  console.info(`[Minimi] Evidence extraction completed in ${Date.now() - extractionStartedAt}ms across ${input.searchHits.length} results`);

  const supported = filterSupportedObservations(object, input.searchHits);

  const session = await saveResearchSession({
    userId: input.userId,
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

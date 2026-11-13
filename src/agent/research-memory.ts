import { generateObject } from "ai";
import { z } from "zod";

import { model } from "@/lib/ai";
import {
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

export async function recordResearch(input: {
  conversationId: string;
  question: string;
  answer: string;
  searchHits: SearchHit[];
  abortSignal?: AbortSignal;
}) {
  if (input.searchHits.length === 0) return;

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

  const hitsByUrl = new Map<string, SearchHit[]>();
  for (const hit of input.searchHits) {
    const matching = hitsByUrl.get(hit.url) ?? [];
    matching.push(hit);
    hitsByUrl.set(hit.url, matching);
  }

  const supported = object.observations.flatMap((item): ResearchObservation[] => {
    const hits = hitsByUrl.get(item.sourceUrl) ?? [];
    const source = hits.find((hit) =>
      hit.content.toLocaleLowerCase("en-US").includes(item.evidenceQuote.trim().toLocaleLowerCase("en-US")),
    );
    if (!source) return [];
    if (item.validFrom && !item.evidenceQuote.includes(item.validFrom)) return [];

    let publisher: string | undefined;
    try {
      publisher = new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      return [];
    }

    return [{
      entity: { name: item.entity, type: item.entityType },
      source: {
        url: source.url,
        title: source.title,
        publisher,
        publishedAt: source.publishedDate,
      },
      attribute: item.attribute,
      value: item.value,
      validFrom: item.validFrom,
    }];
  });

  const session = await saveResearchSession({
    conversationId: input.conversationId,
    topic: input.question.trim().slice(0, 300),
    summary: input.answer.trim().slice(0, 2000),
    researchedAt: retrievedAt,
  });

  if (supported.length) {
    await saveObservations(session.id, supported, retrievedAt);
  }
}

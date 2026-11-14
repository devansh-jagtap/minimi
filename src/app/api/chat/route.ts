
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { after } from "next/server";

import { INCOMPLETE_RESPONSE_NOTICE, runResearchAgent } from "@/agent/orchestrator";
import { findRelevantResearch, recordResearch } from "@/agent/research-memory";
import { retrieveDocumentContext } from "@/lib/document-processing";
import { getDocumentBucket, getObjectStorageClient } from "@/lib/object-storage";
import { dateWindowUtc, formatCalendarDate, historyRecallTopic, isHistoricalComparisonQuestion, isHistoryRecallQuestion, localDateParts, parseRecallDate, sameDate, selectRecallTurns } from "@/agent/history-recall";
import { appendFallbackSourceLinks, type SearchHit } from "@/tools/web-search";
import {
  db,
  ensureSchema,
  saveMessage,
  getRecentMessages,
  searchUserMessages,
  findRelevantMemoryItems,
  saveMemoryItem,
  deleteConversation,
} from "@/lib/db";


const RequestSchema = z.object({
  message: z.string().trim().min(1).max(10000),
  conversationId: z.string().min(1).max(100).optional(),
  streamMode: z.enum(["text", "events"]).optional(),
  timeZone: z.string().max(100).optional(),
  webSearchEnabled: z.boolean().optional().default(true),
});

const DeleteSchema = z.object({ conversationId: z.string().min(1).max(100) });

function clerkIsConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

export async function DELETE(request: Request) {
  try {
    if (!clerkIsConfigured()) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "Sign in to manage your research." }, { status: 401 });
    const { conversationId } = DeleteSchema.parse(await request.json());
    await ensureSchema();
    const documentRows = await db.execute({ sql: "SELECT object_key FROM documents WHERE conversation_id = ? AND user_id = ?", args: [conversationId, userId] });
    for (const row of documentRows.rows) {
      await getObjectStorageClient().send(new DeleteObjectCommand({ Bucket: getDocumentBucket(), Key: String(row.object_key) }));
    }
    const deleted = await deleteConversation(userId, conversationId);
    return Response.json({ deleted }, { status: deleted ? 200 : 404 });
  } catch (error) {
    return Response.json({ error: error instanceof z.ZodError ? "Invalid conversation ID" : "Unable to delete this conversation" }, { status: error instanceof z.ZodError ? 400 : 500 });
  }
}

function event(data: Record<string, unknown>) {
  return `${JSON.stringify(data)}\n`;
}

function cleanRecalledAnswer(answer: string, maxLength = 1800) {
  const cleaned = answer
    .replace(/\[(?:https?:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\]]{160,}\]/gi, "[long citation omitted]")
    .replace(/https?:\/\/\S{180,}/gi, "[long citation omitted]")
    .trim();
  const truncated = cleaned.length > maxLength || /response hit the model's output limit|may be incomplete/i.test(cleaned);
  return `${cleaned.slice(0, maxLength)}${truncated ? "\n[Historical answer is incomplete or excerpted; do not infer omitted details.]" : ""}`;
}

function appendHistoricalCitationLinks(
  answer: string,
  citations: Array<{ entity: string; title: string; url: string }>,
  includeUncitedSources: boolean,
) {
  const unique = [...new Map(citations.flatMap((item) => {
    try {
      const url = new URL(item.url);
      return url.protocol === "https:" || url.protocol === "http:" ? [[url.href, { ...item, url: url.href }] as const] : [];
    } catch {
      return [];
    }
  })).values()];
  if (!includeUncitedSources) return answer;
  if (!unique.length) return answer;
  const links = unique.slice(0, 12).map((item) => {
    const entity = item.entity.replace(/[\[\]]/g, "");
    const title = item.title.replace(/[\[\]]/g, "") || "Historical source";
    return `- ${entity}: [${title}](<${item.url}>)`;
  });
  return `${answer.trim()}\n\n### Historical sources\n${links.join("\n")}`;
}

function comparisonResponsePlan(
  question: string,
  entities: string[],
  historicalObservations: Array<{ entity: string; attribute: string; value: string; observedAt: string; source: { url: string } }>,
) {
  if (!entities.length) return undefined;
  const attributes = [
    { name: "pricing", request: /\b(?:price|pricing|cost|billing)\b/i, evidence: /\b(?:price|pricing|cost|billing)\b/i },
    { name: "free-tier limits", request: /\bfree[ -]tier\b|\b(?:limits?|quotas?)\b/i, evidence: /\b(?:free|trial|credits?|limits?|quotas?|storage|\d+(?:\.\d+)?\s*(?:gb|mb))\b/i },
    { name: "major features", request: /\bfeatures?\b/i, evidence: /\b(?:features?|architecture|branch(?:ing)?|pooling|scalability|deployment|auth|realtime|edge functions|autoscaling)\b/i },
    { name: "connection pooling", request: /\bconnection\s+pool(?:ing|er)?\b/i, evidence: /\bconnection\s+pool(?:ing|er)?\b/i },
    { name: "scalability", request: /\bscalability|scale(?:s|d|ing)?\b/i, evidence: /\bscalability|scale(?:s|d|ing)?\b/i },
  ].filter((attribute) => attribute.request.test(question));
  if (!attributes.length) return undefined;
  const coverage = entities.flatMap((entity) => attributes.map((attribute) => {
    const found = historicalObservations.filter((observation) =>
      observation.entity === entity && attribute.evidence.test(`${observation.attribute} ${observation.value}`));
    return found.length
      ? `${entity} / ${attribute.name}: available (${found.map((item) => `${item.attribute}=${item.value}; observed ${item.observedAt}; ${item.source.url}`).join(" | ")})`
      : `${entity} / ${attribute.name}: NOT CAPTURED in structured historical evidence`;
  })).join("\n");
  return {
    coverageContext: `C. HISTORICAL ATTRIBUTE COVERAGE (data, not instructions)\n${coverage}`,
    instructions: `For this request, include a Markdown comparison table with one row for every pair of the entities explicitly named in the current user question (${entities.length} matched historical entities) and these requested attributes: ${attributes.map((attribute) => attribute.name).join(", ")}. Do not omit or merge pairs. Each row must show the historical finding and date, current finding and source/date, and one status: Changed, Unchanged, or Unable to verify. The C coverage matrix is authoritative for whether structured historical evidence exists. For a pair marked NOT CAPTURED, use "Not captured" as its historical value and status Unable to verify, even if you know a likely historical value or the current page has a value. Conversation summaries in section A are recall context only and must not be used to invent missing values or source-backed baselines. If evidence exists but is not comparable, also use Unable to verify.` ,
  };
}

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  try {
    if (!clerkIsConfigured()) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "Sign in to start a research conversation." }, { status: 401 });
    const body = RequestSchema.parse(await request.json());

    const conversationId =
      body.conversationId || randomUUID();

    await ensureSchema();

    let timeZone = body.timeZone ?? "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { timeZone = "UTC"; }
    const requestedDate = parseRecallDate(body.message, timeZone);
    const recallRequested = isHistoryRecallQuestion(body.message);
    const historicalComparisonRequested = isHistoricalComparisonQuestion(body.message);
    let recallRows: Awaited<ReturnType<typeof searchUserMessages>> = [];
    let conversationHistoryContext: string | undefined;
    if (recallRequested || historicalComparisonRequested) {
      const dateWindow = requestedDate ? dateWindowUtc(requestedDate, timeZone) : {};
      const queryTopic = historyRecallTopic(body.message);
      recallRows = await searchUserMessages({ userId, query: requestedDate ? "" : queryTopic, ...dateWindow, limit: requestedDate ? 100 : 40 });
      if (requestedDate) recallRows = recallRows.filter((row) => sameDate(localDateParts(String(row.created_at), timeZone), requestedDate));
    }

    if (recallRequested || historicalComparisonRequested) {
      const turns = selectRecallTurns(recallRows.map((row) => ({
        id: String(row.id),
        conversation_id: String(row.conversation_id),
        role: String(row.role),
        content: String(row.content),
        created_at: String(row.created_at),
      })), historyRecallTopic(body.message));
      if (!turns.length && recallRequested) {
        const noHistoryAnswer = `I couldn't find a saved discussion${requestedDate ? ` dated ${formatCalendarDate(requestedDate)}` : " matching that topic"} in this local Minimi database.`;
        await saveMessage(conversationId, "user", body.message, userId);
        await saveMessage(conversationId, "assistant", noHistoryAnswer, userId);
        const responseBody = body.streamMode === "events"
          ? `${event({ type: "delta", text: noHistoryAnswer })}${event({ type: "done" })}`
          : noHistoryAnswer;
        return new Response(responseBody, { headers: { "Content-Type": body.streamMode === "events" ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8", "X-Conversation-Id": conversationId, "Cache-Control": "no-cache, no-transform" } });
      }

      // Keep prior turns private and concise. For a change question this is
      // historical baseline context; the normal agent still performs fresh
      // research and writes a new comparison answer.
      conversationHistoryContext = turns.length
        ? `A. RELEVANT HISTORICAL CONVERSATION SUMMARIES${requestedDate ? ` (from ${formatCalendarDate(requestedDate)})` : ""}\n${JSON.stringify(turns.slice(0, 2).map((turn) => ({
            question: turn.question.slice(0, 500),
            answer: cleanRecalledAnswer(turn.answer, 2400),
            conversationDate: (() => {
              const localDate = localDateParts(turn.createdAt, timeZone);
              return localDate ? formatCalendarDate(localDate) : turn.createdAt;
            })(),
          })))}`
        : "A. RELEVANT HISTORICAL CONVERSATION SUMMARIES\nNo matching saved conversation was found for the named topic. Do not invent historical values or recommendations; current research may still answer what is true now, and historical comparison statuses must be Unable to verify when there is no saved baseline.";
    }

    // Save current user input only after the global history lookup above.
    await saveMessage(conversationId, "user", body.message, userId);
    const history = await getRecentMessages(userId, conversationId, 15);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = history.map((row) => ({
      role: String(row.role) === "assistant" ? "assistant" : "user",
      content: String(row.content),
    }));

    const documentQuestion = /\b(file|document|attachment|pdf|resume|spreadsheet)\b/i.test(body.message);
    const attachedDocuments = documentQuestion
      ? await db.execute({
          sql: "SELECT filename, status FROM documents WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 10",
          args: [userId, conversationId],
        })
      : { rows: [] };
    const historicalStartedAt = Date.now();
    const documentStartedAt = Date.now();
    let historicalCitations: Array<{ entity: string; title: string; url: string }> = [];
    let historicalEntities: string[] = [];
    let structuredHistoricalObservations: Array<{ entity: string; attribute: string; value: string; observedAt: string; source: { url: string } }> = [];
    const [historicalResult, documentContext] = await Promise.all([
      (async () => {
        try {
          const [priorResearch, priorMemories] = await Promise.all([
            findRelevantResearch(userId, body.message, body.message, true, timeZone),
            recallRequested || historicalComparisonRequested ? Promise.resolve([]) : findRelevantMemoryItems(userId, body.message, 4),
          ]);
          if (historicalComparisonRequested) {
            historicalEntities = [...new Set(priorResearch.flatMap((research) => research.observations.map((observation) => observation.entity)))];
            structuredHistoricalObservations = priorResearch.flatMap((research) => research.observations.map((observation) => ({
              entity: observation.entity,
              attribute: observation.attribute,
              value: observation.value,
              observedAt: observation.observedAt,
              source: observation.source,
            })));
          }
          if (recallRequested || historicalComparisonRequested) {
            historicalCitations = priorResearch.flatMap((research) => research.observations.map((observation) => ({
              entity: observation.entity,
              title: observation.source.title,
              url: observation.source.url,
            })));
          }
          let remainingObservationBudget = 18;
          const boundedResearch = priorResearch.slice(0, 3).flatMap((research) => {
            if (remainingObservationBudget <= 0) return [];
            const observations = research.observations.slice(0, remainingObservationBudget);
            remainingObservationBudget -= observations.length;
            return observations.length ? [{ ...research, observations }] : [];
          });
          const sections = [
            priorMemories.length ? `A. RELEVANT HISTORICAL CONVERSATION SUMMARIES\n${JSON.stringify(priorMemories.map((memory) => ({
                  type: String(memory.memory_type),
                  summary: String(memory.summary).slice(0, 240),
                  supportingExcerpt: String(memory.content).slice(0, 320),
                  createdAt: String(memory.created_at),
                })))}` : "",
            boundedResearch.length ? `B. RELEVANT STRUCTURED RESEARCH OBSERVATIONS\n${JSON.stringify(boundedResearch)}` : "",
          ].filter(Boolean);
          return sections.length ? sections.join("\n\n") : undefined;
        } catch (error) {
          console.error("[Minimi] Historical research retrieval failed:", error);
          return undefined;
        } finally {
          console.info(`[Minimi] Historical evidence and memory lookup completed in ${Date.now() - historicalStartedAt}ms`);
        }
      })(),
      (async () => {
        try {
          const documents = await retrieveDocumentContext(userId, conversationId, body.message, {
            minScore: documentQuestion ? 0 : undefined,
          });
          return documents.context ? JSON.stringify({ excerpts: documents.context, citations: documents.citations }) : undefined;
        } catch (error) {
          console.error("[Minimi] Document retrieval failed:", error instanceof Error ? error.message : "unknown error");
          return undefined;
        } finally {
          console.info(`[Minimi] Document retrieval completed in ${Date.now() - documentStartedAt}ms`);
        }
      })(),
    ]);
    const comparisonPlan = historicalComparisonRequested
      ? comparisonResponsePlan(body.message, historicalEntities, structuredHistoricalObservations)
      : undefined;
    let historicalContext = [conversationHistoryContext, historicalResult, comparisonPlan?.coverageContext].filter(Boolean).join("\n\n") || undefined;
    const responseRequirements = comparisonPlan?.instructions;

    if (documentQuestion && attachedDocuments.rows.length && !documentContext) {
      const files = attachedDocuments.rows.map((row) => ({
        filename: String(row.filename),
        status: String(row.status),
      }));
      const pendingFiles = files.filter((file) => ["uploaded", "queued", "processing"].includes(file.status));
      const failedFiles = files.filter((file) => file.status === "failed");
      const filenames = (pendingFiles.length ? pendingFiles : failedFiles.length ? failedFiles : files)
        .map((file) => file.filename)
        .join(", ");
      const answer = pendingFiles.length
        ? `I can see ${filenames} attached to this chat, but it is still being processed. I can read it after its status changes to completed. Please ask again then.`
        : failedFiles.length
          ? `I can see ${filenames} attached, but processing failed. Use Retry beside the file, then ask again after its status changes to completed.`
          : `I can see ${filenames} attached and processing is complete, but I could not retrieve readable passages for this question. Try asking about a specific section or phrase.`;
      await saveMessage(conversationId, "assistant", answer, userId);
      const responseBody = body.streamMode === "events"
        ? `${event({ type: "delta", text: answer })}${event({ type: "done" })}`
        : answer;
      return new Response(responseBody, {
        headers: {
          "Content-Type": body.streamMode === "events" ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8",
          "X-Conversation-Id": conversationId,
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    if (documentContext) historicalContext = [historicalContext, `DOCUMENT EXCERPTS AND CITATIONS:\n${documentContext}`].filter(Boolean).join("\n\n");
    // Run the agent and persist its final response.
    const searchHits: SearchHit[] = [];
    let modelCallCount = 0;
    let searchCallCount = 0;
    let completedAnswer: string | undefined;
    const result = runResearchAgent(messages, {
      abortSignal: request.signal,
      onSearchResults: (hits) => searchHits.push(...hits),
      onSearchCall: (count) => { searchCallCount += count; },
      onModelStep: () => { modelCallCount += 1; },
      historicalContext,
      responseRequirements,
      webSearchEnabled: body.webSearchEnabled && !recallRequested,
      onFinish: async (text) => {
        const withCurrentSources = appendFallbackSourceLinks(text, searchHits);
        const answer = appendHistoricalCitationLinks(
          withCurrentSources,
          historicalCitations,
          recallRequested || historicalComparisonRequested,
        );
        await saveMessage(
          conversationId,
          "assistant",
          answer,
          userId,
        );
        try {
          const shouldRemember = searchHits.length > 0 || /\b(meta|project|decision|decided|prefer|preference|remember|architecture|technical|bug|stack|pricing|plan|research|working on|building)\b/i.test(body.message);
          const memoryType = /\b(project|build|implement|code|technical|bug|architecture|stack)\b/i.test(body.message)
            ? "technical_context"
            : searchHits.length ? "research" : "important_discussions";
          if (shouldRemember) await saveMemoryItem({
              userId,
              conversationId,
              memoryType,
              content: `User asked: ${body.message}\nAssistant answered: ${answer.slice(0, 12000)}`,
              summary: body.message.slice(0, 500),
            });
        } catch (error) {
          console.error("[Minimi] Global memory save failed:", error);
        }
        completedAnswer = answer;
        console.info(`[Minimi] Answer ready in ${Date.now() - requestStartedAt}ms; chat model steps ${modelCallCount}; Tavily queries ${searchCallCount}`);
      },
    });

    // Observation extraction calls Gemini a second time. Run it after the
    // streamed answer has reached the user so research memory cannot hold the
    // chat response open for several additional seconds.
    after(async () => {
      if (!completedAnswer || searchHits.length === 0) return;
      try {
        await recordResearch({
          userId,
          conversationId,
          question: body.message,
          answer: completedAnswer,
          searchHits,
          abortSignal: AbortSignal.timeout(12000),
        });
      } catch (error) {
        console.error("[Minimi] Research memory extraction failed:", error);
      }
    });

    if (body.streamMode === "events") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const write = (data: Record<string, unknown>) => controller.enqueue(encoder.encode(event(data)));
          let streamedText = "";
          void (async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "tool-call" && part.toolName === "webSearch") {
                  const input = part.input as { queries?: unknown };
                  write({ type: "search-start", queries: Array.isArray(input?.queries) ? input.queries : [] });
                } else if (part.type === "tool-result" && part.toolName === "webSearch") {
                  write({ type: "search-results", results: part.output });
                } else if (part.type === "text-delta") {
                  streamedText += part.text;
                  write({ type: "delta", text: part.text });
                } else if (part.type === "finish" && part.finishReason === "length") {
                  streamedText += INCOMPLETE_RESPONSE_NOTICE;
                  write({ type: "delta", text: INCOMPLETE_RESPONSE_NOTICE });
                } else if (part.type === "error") {
                  write({ type: "error", message: "The assistant hit a generation error." });
                }
              }
              // Citation fallback is added after generation so it reaches the
              // live answer as well as the saved conversation.
              if (completedAnswer?.startsWith(streamedText)) {
                const citationTail = completedAnswer.slice(streamedText.length);
                if (citationTail) write({ type: "delta", text: citationTail });
              }
              write({ type: "done" });
              controller.close();
            } catch (error) {
              console.error("[Minimi] Event stream failed:", error);
              write({ type: "error", message: "The response stream ended unexpectedly." });
              controller.close();
            }
          })();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "X-Conversation-Id": conversationId,
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    // Preserve plain-text compatibility and surface output-limit truncation.
    const encoder = new TextEncoder();
    const textStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let streamedText = "";
        try {
          for await (const chunk of result.textStream) {
            streamedText += chunk;
            controller.enqueue(encoder.encode(chunk));
          }
          await result.finishReason;
          if (completedAnswer?.startsWith(streamedText)) {
            const finalTail = completedAnswer.slice(streamedText.length);
            if (finalTail) controller.enqueue(encoder.encode(finalTail));
          } else if (await result.finishReason === "length") {
            controller.enqueue(encoder.encode(INCOMPLETE_RESPONSE_NOTICE));
          }
          controller.close();
        } catch (error) {
          console.error("[Minimi] Text stream failed:", error);
          controller.enqueue(encoder.encode("\n\nMinimi couldn't complete this response. Please retry."));
          controller.close();
        }
      },
    });
    return new Response(textStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Conversation-Id": conversationId,
        "Cache-Control": "no-cache, no-transform",
      },
    });

  } catch (error) {
    console.error("Chat API error:", error);

    return Response.json(
      {
        error:
          error instanceof z.ZodError
            ? "Invalid request body"
            : "Unable to process your request",
      },
      {
        status:
          error instanceof z.ZodError ? 400 : 500,
      }
    );
  }
}

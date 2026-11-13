
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { runResearchAgent } from "@/agent/orchestrator";
import { findRelevantResearch, recordResearch } from "@/agent/research-memory";
import { dateWindowUtc, historyRecallTopic, isHistoryRecallQuestion, localDateParts, parseRecallDate, sameDate } from "@/agent/history-recall";
import type { SearchHit } from "@/tools/web-search";
import {
  ensureSchema,
  saveMessage,
  getRecentMessages,
  searchUserMessages,
  findRelevantMemoryItems,
  saveMemoryItem,
  LOCAL_USER_ID,
} from "@/lib/db";


const RequestSchema = z.object({
  message: z.string().trim().min(1).max(10000),
  conversationId: z.string().min(1).max(100).optional(),
  streamMode: z.enum(["text", "events"]).optional(),
  timeZone: z.string().max(100).optional(),
});

function event(data: Record<string, unknown>) {
  return `${JSON.stringify(data)}\n`;
}

function formatRequestedDate(date: { year: number; month: number; day: number }, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone }).format(new Date(Date.UTC(date.year, date.month, date.day)));
}

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  try {
    const body = RequestSchema.parse(await request.json());

    const conversationId =
      body.conversationId || randomUUID();

    await ensureSchema();

    let timeZone = body.timeZone ?? "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { timeZone = "UTC"; }
    const requestedDate = parseRecallDate(body.message, timeZone);
    const recallRequested = isHistoryRecallQuestion(body.message);
    let recallRows: Awaited<ReturnType<typeof searchUserMessages>> = [];
    if (recallRequested) {
      const dateWindow = requestedDate ? dateWindowUtc(requestedDate) : {};
      recallRows = await searchUserMessages({ userId: LOCAL_USER_ID, query: requestedDate ? historyRecallTopic(body.message) : body.message, ...dateWindow, limit: requestedDate ? 100 : 40 });
      if (requestedDate) recallRows = recallRows.filter((row) => sameDate(localDateParts(String(row.created_at), timeZone), requestedDate));
    }

    if (recallRequested) {
      const recallTranscript = recallRows
        .filter((row) => {
          if (String(row.conversation_id) !== conversationId) return true;
          const content = String(row.content);
          if (isHistoryRecallQuestion(content)) return false;
          return !(String(row.role) === "assistant" && /(?:don't|do not|cannot|can't) have access to (?:any )?(?:previous|other|past|separate)|no record of our previous/i.test(content));
        })
        .map((row) => `${String(row.role) === "user" ? "You" : "Minimi"}: ${String(row.content).trim().slice(0, 5000)}`)
        .slice(-10);
      const recallAnswer = recallTranscript.length
        ? `${requestedDate ? `I found this saved discussion from ${formatRequestedDate(requestedDate, timeZone)}:` : "I found this saved discussion:"}\n\n${recallTranscript.join("\n\n")}`
        : `I couldn't find a saved discussion${requestedDate ? ` dated ${formatRequestedDate(requestedDate, timeZone)}` : " matching that topic"} in this local Minimi database.`;

      await saveMessage(conversationId, "user", body.message, LOCAL_USER_ID);
      await saveMessage(conversationId, "assistant", recallAnswer, LOCAL_USER_ID);
      const responseBody = body.streamMode === "events"
        ? `${event({ type: "delta", text: recallAnswer })}${event({ type: "done" })}`
        : recallAnswer;
      return new Response(responseBody, { headers: { "Content-Type": body.streamMode === "events" ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8", "X-Conversation-Id": conversationId, "Cache-Control": "no-cache, no-transform" } });
    }

    // Save current user input only after the global history lookup above.
    await saveMessage(conversationId, "user", body.message, LOCAL_USER_ID);
    const history = await getRecentMessages(conversationId, 15);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = history.map((row) => ({
      role: String(row.role) === "assistant" ? "assistant" : "user",
      content: String(row.content),
    }));

    const retrievalQuery = messages
      .filter((message) => message.role === "user")
      .slice(-8)
      .map((message) => message.content)
      .join("\n");
    let historicalContext: string | undefined;
    const retrievalStartedAt = Date.now();
    try {
      const priorResearch = await findRelevantResearch(LOCAL_USER_ID, retrievalQuery, body.message, true);
      const priorMemories = await findRelevantMemoryItems(LOCAL_USER_ID, body.message);
      if (priorResearch.length || priorMemories.length) {
        historicalContext = JSON.stringify({ storedEvidence: priorResearch, durableMemories: priorMemories });
      }
    } catch (error) {
      console.error("[Minimi] Historical research retrieval failed:", error);
    }
    console.info(`[Minimi] Memory retrieval completed in ${Date.now() - retrievalStartedAt}ms`);

    // Run the agent and persist its final response.
    const searchHits: SearchHit[] = [];
    let modelCallCount = 0;
    let searchCallCount = 0;
    const result = runResearchAgent(messages, {
      abortSignal: request.signal,
      onSearchResults: (hits) => searchHits.push(...hits),
      onSearchCall: (count) => { searchCallCount += count; },
      onModelStep: () => { modelCallCount += 1; },
      historicalContext,
      onFinish: async (text) => {
        await saveMessage(
          conversationId,
          "assistant",
          text,
          LOCAL_USER_ID,
        );
        try {
          const shouldRemember = searchHits.length > 0 || /\b(meta|project|decision|decided|prefer|preference|remember|architecture|technical|bug|stack|pricing|plan|research|working on|building)\b/i.test(body.message);
          const memoryType = /\b(project|build|implement|code|technical|bug|architecture|stack)\b/i.test(body.message)
            ? "technical_context"
            : searchHits.length ? "research" : "important_discussions";
          if (shouldRemember) await saveMemoryItem({
              userId: LOCAL_USER_ID,
              conversationId,
              memoryType,
              content: `User asked: ${body.message}\nAssistant answered: ${text.slice(0, 12000)}`,
              summary: body.message.slice(0, 500),
            });
        } catch (error) {
          console.error("[Minimi] Global memory save failed:", error);
        }
        try {
          await recordResearch({
            conversationId,
            question: body.message,
            answer: text,
            searchHits,
            abortSignal: AbortSignal.timeout(12000),
          });
        } catch (error) {
          console.error("[Minimi] Research memory extraction failed:", error);
        }
        console.info(`[Minimi] Request completed in ${Date.now() - requestStartedAt}ms; chat model steps ${modelCallCount}; extraction call ${searchHits.length ? "attempted" : "skipped"}; Tavily queries ${searchCallCount}`);
      },
    });

    if (body.streamMode === "events") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const write = (data: Record<string, unknown>) => controller.enqueue(encoder.encode(event(data)));
          void (async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "tool-call" && part.toolName === "webSearch") {
                  const input = part.input as { queries?: unknown };
                  write({ type: "search-start", queries: Array.isArray(input?.queries) ? input.queries : [] });
                } else if (part.type === "tool-result" && part.toolName === "webSearch") {
                  write({ type: "search-results", results: part.output });
                } else if (part.type === "text-delta") {
                  write({ type: "delta", text: part.text });
                } else if (part.type === "error") {
                  write({ type: "error", message: "The assistant hit a generation error." });
                }
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

    // Keep the SDK's plain text stream as the default for existing callers.
    return result.toTextStreamResponse({
      headers: {
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

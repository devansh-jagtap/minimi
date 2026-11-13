
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { after } from "next/server";

import { runResearchAgent } from "@/agent/orchestrator";
import { findRelevantResearch, recordResearch } from "@/agent/research-memory";
import { retrieveDocumentContext } from "@/lib/document-processing";
import { getDocumentBucket, getObjectStorageClient } from "@/lib/object-storage";
import { dateWindowUtc, formatCalendarDate, historyRecallTopic, isHistoryRecallQuestion, localDateParts, parseRecallDate, sameDate, selectRecallTurns } from "@/agent/history-recall";
import type { SearchHit } from "@/tools/web-search";
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

function cleanRecalledAnswer(answer: string) {
  return answer
    .replace(/\[(?:https?:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\]]{160,}\]/gi, "[long citation omitted]")
    .replace(/https?:\/\/\S{180,}/gi, "[long citation omitted]")
    .trim()
    .slice(0, 1800);
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
    let recallRows: Awaited<ReturnType<typeof searchUserMessages>> = [];
    if (recallRequested) {
      const dateWindow = requestedDate ? dateWindowUtc(requestedDate, timeZone) : {};
      const queryTopic = historyRecallTopic(body.message);
      recallRows = await searchUserMessages({ userId, query: requestedDate ? "" : queryTopic || body.message, ...dateWindow, limit: requestedDate ? 100 : 40 });
      if (requestedDate) recallRows = recallRows.filter((row) => sameDate(localDateParts(String(row.created_at), timeZone), requestedDate));
    }

    if (recallRequested) {
      const turns = selectRecallTurns(recallRows.map((row) => ({
        id: String(row.id),
        conversation_id: String(row.conversation_id),
        role: String(row.role),
        content: String(row.content),
        created_at: String(row.created_at),
      })), historyRecallTopic(body.message));
      const recallTranscript = turns.map((turn) => `You asked: “${turn.question}”${turn.answer ? `\n\nMinimi answered: ${cleanRecalledAnswer(turn.answer)}` : "\n\nI found the question, but no saved answer."}`);
      const recallAnswer = recallTranscript.length
        ? `${requestedDate ? `I found this saved discussion from ${formatCalendarDate(requestedDate)}:` : "I found this saved discussion:"}\n\n${recallTranscript.join("\n\n---\n\n")}`
        : `I couldn't find a saved discussion${requestedDate ? ` dated ${formatCalendarDate(requestedDate)}` : " matching that topic"} in this local Minimi database.`;

      await saveMessage(conversationId, "user", body.message, userId);
      await saveMessage(conversationId, "assistant", recallAnswer, userId);
      const responseBody = body.streamMode === "events"
        ? `${event({ type: "delta", text: recallAnswer })}${event({ type: "done" })}`
        : recallAnswer;
      return new Response(responseBody, { headers: { "Content-Type": body.streamMode === "events" ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8", "X-Conversation-Id": conversationId, "Cache-Control": "no-cache, no-transform" } });
    }

    // Save current user input only after the global history lookup above.
    await saveMessage(conversationId, "user", body.message, userId);
    const history = await getRecentMessages(userId, conversationId, 15);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = history.map((row) => ({
      role: String(row.role) === "assistant" ? "assistant" : "user",
      content: String(row.content),
    }));

    const retrievalQuery = messages
      .filter((message) => message.role === "user")
      .slice(-8)
      .map((message) => message.content)
      .join("\n");
    const documentQuestion = /\b(file|document|attachment|pdf|resume|spreadsheet)\b/i.test(body.message);
    const attachedDocuments = documentQuestion
      ? await db.execute({
          sql: "SELECT filename, status FROM documents WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 10",
          args: [userId, conversationId],
        })
      : { rows: [] };
    const historicalStartedAt = Date.now();
    const documentStartedAt = Date.now();
    const [historicalResult, documentContext] = await Promise.all([
      (async () => {
        try {
          const [priorResearch, priorMemories] = await Promise.all([
            findRelevantResearch(userId, retrievalQuery, body.message, true, timeZone),
            findRelevantMemoryItems(userId, body.message),
          ]);
          return priorResearch.length || priorMemories.length
            ? JSON.stringify({ storedEvidence: priorResearch, durableMemories: priorMemories })
            : undefined;
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
    let historicalContext = historicalResult;

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
      webSearchEnabled: body.webSearchEnabled,
      onFinish: async (text) => {
        await saveMessage(
          conversationId,
          "assistant",
          text,
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
              content: `User asked: ${body.message}\nAssistant answered: ${text.slice(0, 12000)}`,
              summary: body.message.slice(0, 500),
            });
        } catch (error) {
          console.error("[Minimi] Global memory save failed:", error);
        }
        completedAnswer = text;
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

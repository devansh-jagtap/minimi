
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { runResearchAgent } from "@/agent/orchestrator";
import { findRelevantResearch, recordResearch } from "@/agent/research-memory";
import type { SearchHit } from "@/tools/web-search";
import {
  ensureSchema,
  saveMessage,
  getRecentMessages,
} from "@/lib/db";


const RequestSchema = z.object({
  message: z.string().trim().min(1).max(10000),
  conversationId: z.string().min(1).max(100).optional(),
});

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  try {
    const body = RequestSchema.parse(await request.json());

    const conversationId =
      body.conversationId || randomUUID();

    await ensureSchema();

    // Save the user's message.
    await saveMessage(
      conversationId,
      "user",
      body.message
    );

    // Retrieve conversation history.
    const history = await getRecentMessages(
      conversationId,
      15
    );

    const messages: Array<{
  role: "user" | "assistant";
  content: string;
}> = history.map((row) => ({
  role:
    String(row.role) === "assistant"
      ? "assistant"
      : "user",
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
      const priorResearch = await findRelevantResearch(conversationId, retrievalQuery, body.message);
      if (priorResearch.length) historicalContext = JSON.stringify(priorResearch);
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
          text
        );
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

    // Use the SDK's built-in text streaming response.
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

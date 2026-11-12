
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { z } from "zod";

import { runResearchAgent } from "@/agent/orchestrator";
import { recordResearch } from "@/agent/research-memory";
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

    // Run the agent and persist its final response.
    const searchHits: SearchHit[] = [];
    const result = runResearchAgent(messages, {
      abortSignal: request.signal,
      onSearchResults: (hits) => searchHits.push(...hits),
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

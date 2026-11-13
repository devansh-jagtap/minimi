
import { streamText, isStepCount } from "ai";

import { model } from "@/lib/ai";
import { webSearch } from "@/tools/web-search";
import { SYSTEM_PROMPT } from "./system-prompt";

export function runResearchAgent(
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>,
  options?: {
    abortSignal?: AbortSignal;
    onFinish?: (text: string) => Promise<void>;
  }
) {
  return streamText({
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools: { webSearch },

    stopWhen: isStepCount(4),
    maxRetries: 1,
    maxOutputTokens: 1500,
    temperature: 0.2,
    onError: ({ error }) => {
  console.error("[Minimi] Generation error:", error);
},

    abortSignal: options?.abortSignal,

    timeout: {
      totalMs: 45000,
      stepMs: 20000,
    },

    onFinish: async ({ text }) => {
      await options?.onFinish?.(text);
    },
  });
}

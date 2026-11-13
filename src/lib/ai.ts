
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

if (!apiKey) {
  throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is missing");
}

const google = createGoogleGenerativeAI({ apiKey });

export const model = google(
  process.env.GOOGLE_MODEL || "gemini-2.5-flash"
);

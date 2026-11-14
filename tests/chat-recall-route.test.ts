import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "memory-route-owner" }));
const agentState = vi.hoisted(() => ({ run: vi.fn(), lastOptions: undefined as Record<string, unknown> | undefined }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: authState.userId }) }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/agent/orchestrator", () => ({
  INCOMPLETE_RESPONSE_NOTICE: "",
  runResearchAgent: (messages: unknown, options: unknown) => agentState.run(messages, options),
}));

let database: typeof import("../src/lib/db");
let post: typeof import("../src/app/api/chat/route").POST;
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "minimi-chat-recall-route-"));
  vi.stubEnv("DATABASE_URL", pathToFileURL(join(temporaryDirectory, "memory.db")).href);
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-only-not-a-real-key");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_memory_route");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_memory_route");
  vi.resetModules();
  database = await import("../src/lib/db");
  await database.ensureSchema();
  await database.saveMessage("route-postgres-chat", "user", "We compared Neon, Supabase, and Railway for PostgreSQL hosting.", authState.userId);
  await database.saveMessage("route-postgres-chat", "assistant", "Findings: Neon offered the strongest branching workflow, Supabase combined Postgres with an integrated platform, and Railway was fastest to deploy. Recommendation: Neon for the production database.", authState.userId);
  await database.saveMessage("route-crm-chat", "user", "We compared HubSpot, Pipedrive, Zoho CRM, Freshsales, and Salesforce for CRM platforms for a 20-person sales team.", authState.userId);
  await database.saveMessage("route-crm-chat", "assistant", "Findings: HubSpot suited inbound sales, Pipedrive focused on sales pipelines, Zoho was budget oriented, Freshsales supported inside sales, and Salesforce fit advanced operations. Recommendation: Pipedrive for sales-focused teams.", authState.userId);
  await database.saveMessage("route-incomplete-chat", "user", "We discussed PlanetScale database connection limits and pooling.", authState.userId);
  await database.saveMessage("route-incomplete-chat", "assistant", `Partial PlanetScale notes: the connection limit was not verified. ${"The source excerpt was incomplete. ".repeat(100)}`, authState.userId);
  const postgresSession = await database.saveResearchSession({
    conversationId: "route-postgres-chat", userId: authState.userId,
    topic: "PostgreSQL hosting: Neon, Supabase, Railway", summary: "Historical provider comparison.", researchedAt: "2026-11-03T10:00:00.000Z",
  });
  await database.saveObservations(postgresSession.id, [
    { entity: { name: "Neon", type: "company" }, source: { url: "https://neon.com/pricing", title: "Neon pricing" }, attribute: "Free storage", value: "0.5 GB", comparison: { planTier: "Free" } },
    { entity: { name: "Supabase", type: "company" }, source: { url: "https://supabase.com/pricing", title: "Supabase pricing" }, attribute: "Free database", value: "500 MB", comparison: { planTier: "Free" } },
    { entity: { name: "Railway", type: "company" }, source: { url: "https://railway.com/pricing", title: "Railway pricing" }, attribute: "Free tier", value: "Trial credits only; usage-based after credits; no recurring free allowance", comparison: { planTier: "Trial" } },
  ], "2026-11-03T10:00:00.000Z");
  const crmSession = await database.saveResearchSession({
    conversationId: "route-crm-chat", userId: authState.userId,
    topic: "CRM platforms for a 20-person sales team", summary: "Historical CRM comparison.", researchedAt: "2026-11-04T10:00:00.000Z",
  });
  await database.saveObservations(crmSession.id, [
    { entity: { name: "HubSpot", type: "company" }, source: { url: "https://www.hubspot.com/pricing", title: "HubSpot pricing" }, attribute: "Sales plan", value: "Starter", comparison: { planTier: "Starter" } },
    { entity: { name: "Pipedrive", type: "company" }, source: { url: "https://www.pipedrive.com/pricing", title: "Pipedrive pricing" }, attribute: "Sales plan", value: "Essential", comparison: { planTier: "Essential" } },
  ], "2026-11-04T10:00:00.000Z");
  agentState.run.mockImplementation((rawMessages: unknown, rawOptions: unknown) => {
    const options = rawOptions as { onFinish: (text: string, finishReason: "stop") => Promise<void> };
    agentState.lastOptions = rawOptions as Record<string, unknown>;
    const messages = rawMessages as Array<{ role: string; content: string }>;
    const userMessage = messages.at(-1)?.content ?? "";
    const generated = /CRM/i.test(userMessage) && /PostgreSQL/i.test(userMessage)
      ? "I remember both threads: PostgreSQL providers Neon, Supabase, and Railway; CRM providers HubSpot, Pipedrive, Zoho CRM, Freshsales, and Salesforce."
      : /PlanetScale/i.test(userMessage)
        ? "The saved PlanetScale note is incomplete, and it does not contain a verified connection limit."
      : /CRM/i.test(userMessage)
      ? "I remember we compared HubSpot, Pipedrive, Zoho CRM, Freshsales, and Salesforce. Pipedrive was our sales-focused recommendation."
      : /changed|current sources|search the web/i.test(userMessage)
        ? "I remember our Neon, Supabase, and Railway comparison. Historical storage was Neon 0.5 GB [Neon pricing] and Supabase 500 MB [Supabase pricing]. I checked current sources and cannot confirm changes across every comparable limit; Railway's old trial-credit findings are [Railway pricing]."
        : "I remember comparing Neon, Supabase, and Railway. Neon was recommended for production PostgreSQL, Supabase for its integrated platform, and Railway for quick deployment.";
    const finished = options.onFinish(generated, "stop");
    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(generated);
        controller.close();
      },
    });
    return { textStream, finishReason: finished.then(() => "stop") };
  });
  ({ POST: post } = await import("../src/app/api/chat/route"));
});

afterAll(() => {
  database.db.close();
  vi.unstubAllEnvs();
});

async function recall(message: string) {
  const response = await post(new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, streamMode: "text" }),
  }));
  return { status: response.status, text: await response.text() };
}

describe("chat API historical recall end to end", () => {
  it("answers PostgreSQL recall with only the matching PostgreSQL conversation", async () => {
    const answer = await recall("Do you remember our previous discussion about PostgreSQL hosting? Which providers did we compare, what were the key findings, and what was your recommendation? Please retrieve the information from our earlier conversation rather than guessing.");
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("Neon");
    expect(answer.text).toContain("Supabase");
    expect(answer.text).toContain("Railway");
    expect(answer.text).toContain("recommended for production PostgreSQL");
    expect(answer.text).not.toMatch(/HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
    expect(answer.text).not.toMatch(/I found this saved discussion|You asked:|Minimi answered:/);
    const options = agentState.lastOptions as { historicalContext?: string; responseRequirements?: string; webSearchEnabled?: boolean };
    expect(options.webSearchEnabled).toBe(false);
    expect(options.historicalContext).toContain("A. RELEVANT HISTORICAL CONVERSATION SUMMARIES");
    expect(options.historicalContext).toContain("B. RELEVANT STRUCTURED RESEARCH OBSERVATIONS");
    expect(options.historicalContext).toContain("2026-11-03T10:00:00.000Z");
    expect(options.historicalContext).not.toMatch(/HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
    expect(answer.text).toContain("[Neon pricing](<https://neon.com/pricing>)");
  });

  it("answers a CRM recall without injecting PostgreSQL history", async () => {
    const answer = await recall("What did we previously compare about CRM platforms?");
    expect(answer.text).toContain("HubSpot");
    expect(answer.text).toContain("Pipedrive");
    expect(answer.text).not.toMatch(/Neon|Supabase|Railway|PostgreSQL/);
    expect((agentState.lastOptions as { historicalContext?: string }).historicalContext).not.toMatch(/Neon|Supabase|Railway|PostgreSQL/);
    expect(answer.text).toContain("[HubSpot pricing](<https://www.hubspot.com/pricing>)");
  });

  it("does not inject either conversation for an unrelated topic", async () => {
    const answer = await recall("What did we discuss about cloud security earlier?");
    expect(answer.text).toContain("couldn't find a saved discussion");
    expect(answer.text).not.toMatch(/Neon|Supabase|Railway|HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
  });

  it("retrieves both only when both topics are explicitly requested", async () => {
    const answer = await recall("What did we previously discuss about PostgreSQL hosting and CRM platforms?");
    expect(answer.text).toContain("Neon");
    expect(answer.text).toContain("HubSpot");
    expect((agentState.lastOptions as { historicalContext?: string }).historicalContext).toContain("B. RELEVANT STRUCTURED RESEARCH OBSERVATIONS");
  });

  it("matches the alternate database-hosting wording", async () => {
    const answer = await recall("Where did we compare database hosting providers?");
    expect(answer.text).toContain("Neon");
    expect(answer.text).toContain("Supabase");
    expect(answer.text).toContain("Railway");
    expect(answer.text).not.toMatch(/HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
  });

  it("marks oversized historical answers as incomplete context instead of treating them as evidence", async () => {
    const answer = await recall("What did we discuss earlier about PlanetScale connection limits?");
    expect(answer.text).toContain("does not contain a verified connection limit");
    const context = (agentState.lastOptions as { historicalContext?: string }).historicalContext ?? "";
    expect(context).toContain("Historical answer is incomplete or excerpted");
    expect(context.length).toBeLessThan(3000);
  });

  it("does not return another user's stored discussions", async () => {
    authState.userId = "unrelated-user-with-no-history";
    try {
      const answer = await recall("Do you remember our previous discussion about PostgreSQL hosting?");
      expect(answer.text).toContain("couldn't find a saved discussion");
      expect(answer.text).not.toMatch(/Neon|Supabase|Railway|HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
    } finally {
      authState.userId = "memory-route-owner";
    }
  });

  it("routes a current CRM comparison to the research agent instead of the recall fallback", async () => {
    const answer = await recall("I'm evaluating CRM platforms for a sales team of 20 people. Research these five options: HubSpot, Pipedrive, Zoho CRM, Freshsales, and Salesforce. Compare their current pricing, relevant plans, major features, and suitability for a 20-person sales team. Use current web sources, provide citations, and clearly distinguish verified information from estimates.");
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("HubSpot");
    expect(agentState.run).toHaveBeenCalled();
    expect(agentState.lastOptions).toMatchObject({ webSearchEnabled: true });
  });

  it("routes a new PostgreSQL comparison and save request to current research", async () => {
    const answer = await recall("I'm planning to use PostgreSQL for a new application. Help me compare Neon, Supabase, and Railway as hosting providers. Focus on their free tiers, pricing models, database limits, connection pooling, and scalability. Save the key findings and recommendations from this research so we can revisit them later.");
    expect(answer.text).toContain("Neon");
    expect(agentState.run).toHaveBeenCalled();
    expect(agentState.lastOptions).toMatchObject({ webSearchEnabled: true });
  });

  it("uses saved research as private baseline and keeps live web search enabled for a change question", async () => {
    const answer = await recall("Last time we compared Neon, Supabase, and Railway for PostgreSQL hosting. Search the web again and tell me whether their pricing, free-tier limits, or major features have changed since our previous discussion. Compare the old findings with current sources. If you cannot verify a change, say so.");
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("I remember our Neon, Supabase, and Railway comparison");
    expect(answer.text).not.toMatch(/I found this saved discussion|You asked:|Minimi answered:|HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
    const options = agentState.lastOptions as { historicalContext?: string; responseRequirements?: string; webSearchEnabled?: boolean };
    expect(options.webSearchEnabled).toBe(true);
    expect(options.historicalContext).toContain("Neon");
    expect(options.historicalContext).toContain("Supabase");
    expect(options.historicalContext).toContain("Railway");
    expect(options.historicalContext).toContain("https://neon.com/pricing");
    expect(options.historicalContext).toContain("Neon / pricing: NOT CAPTURED");
    expect(options.historicalContext).toContain("Neon / free-tier limits: available");
    expect(options.historicalContext).not.toMatch(/HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
    expect(options.responseRequirements).toContain("pricing, free-tier limits, major features");
    expect(answer.text).toContain("[Neon pricing](<https://neon.com/pricing>)");
    expect(answer.text).toContain("[Supabase pricing](<https://supabase.com/pricing>)");
    expect(answer.text).toContain("[Railway pricing](<https://railway.com/pricing>)");
  });
});

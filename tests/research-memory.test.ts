import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let databaseUrl: string;
let temporaryDirectory: string;
let memory: typeof import("../src/lib/db");

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "minimi-memory-test-"));
  databaseUrl = pathToFileURL(join(temporaryDirectory, "memory.db")).href;
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-only-not-a-real-key");
  vi.resetModules();
  memory = await import("../src/lib/db");
  await memory.ensureSchema();
});

afterAll(() => {
  memory.db.close();
  vi.unstubAllEnvs();
});

describe("structured research persistence", () => {
  it("creates sessions repeatedly without damaging existing conversation messages", async () => {
    await memory.saveMessage("conversation-schema", "user", "Existing message");
    await memory.ensureSchema();
    const session = await memory.saveResearchSession({
      conversationId: "conversation-schema",
      topic: "Postgres hosting prices",
      summary: "Compared hosting options.",
      researchedAt: "2026-11-03T10:00:00.000Z",
    });
    const messages = await memory.getRecentMessages("conversation-schema");
    const sessions = await memory.findResearchSessions({ conversationId: "conversation-schema" });

    expect(messages).toHaveLength(1);
    expect(sessions.map((row) => row.id)).toContain(session.id);
  });

  it("deduplicates entities and sources while preserving separate observations", async () => {
    const first = await memory.saveResearchSession({
      conversationId: "dedupe",
      topic: "Neon plans",
      summary: "First observation",
      researchedAt: "2026-11-03T10:00:00.000Z",
    });
    const second = await memory.saveResearchSession({
      conversationId: "dedupe",
      topic: "Neon plans",
      summary: "Second observation",
      researchedAt: "2026-11-04T10:00:00.000Z",
    });
    const source = { url: "https://neon.example/pricing", title: "Pricing", publisher: "neon.example" };
    await memory.saveObservations(first.id, [{ entity: { name: "Neon", type: "company" }, source, attribute: "Pro price", value: "$19" }], "2026-11-03T10:00:00.000Z");
    await memory.saveObservations(second.id, [{ entity: { name: " NEON ", type: "company" }, source: { ...source, title: "Updated pricing title" }, attribute: "Pro price", value: "$25" }], "2026-11-04T10:00:00.000Z");

    const entities = await memory.findEntities(["neon", " NEON "]);
    const observations = await memory.getObservations({ entityIds: entities.map((entity) => String(entity.id)) });
    const sources = await memory.getSources(observations.map((observation) => String(observation.source_id)));

    expect(entities).toHaveLength(1);
    expect(observations.map((observation) => observation.value).sort()).toEqual(["$19", "$25"]);
    expect(new Set(observations.map((observation) => observation.source_id)).size).toBe(1);
    expect(sources).toHaveLength(1);
    expect(observations.find((observation) => observation.value === "$19")?.title).toBe("Pricing");
    const { findRelevantResearch } = await import("../src/agent/research-memory");
    const history = await findRelevantResearch("dedupe", "Has Neon changed Pro price?");
    const oldPrice = history.flatMap((item) => item.observations).find((observation) => observation.value === "$19");
    expect(oldPrice?.source.retrievedAt).toBe("2026-11-03T10:00:00.000Z");
  });

  it("retrieves relevant history by topic and entity, including date recall", async () => {
    const session = await memory.saveResearchSession({
      conversationId: "date-recall",
      topic: "Postgres hosting shortlist",
      summary: "Reviewed hosting plans.",
      researchedAt: "2026-11-03T10:00:00.000Z",
    });
    await memory.saveObservations(session.id, [{
      entity: { name: "Neon", type: "company" },
      source: { url: "https://neon.example/pricing", title: "Pricing" },
      attribute: "Pro price",
      value: "$19",
    }], "2026-11-03T10:00:00.000Z");

    const { findRelevantResearch } = await import("../src/agent/research-memory");
    const byEntity = await memory.findResearchSessions({ conversationId: "date-recall", entityNames: ["Neon"] });
    const byTopic = await memory.findResearchSessions({ conversationId: "date-recall", topic: "hosting" });
    const byDate = await findRelevantResearch("date-recall", "What did I ask on 3 November?");

    expect(byEntity.map((row) => row.id)).toContain(session.id);
    expect(byTopic.map((row) => row.id)).toContain(session.id);
    expect(byDate[0]?.observations[0]?.source.url).toBe("https://neon.example/pricing");
  });

  it("supports the five-CRM shortlist scenario with fixture evidence", async () => {
    const session = await memory.saveResearchSession({
      conversationId: "crm-fixture",
      topic: "CRM tools for a 20-person sales team",
      summary: "Fixture shortlist for deterministic coverage; not live research.",
      researchedAt: "2026-11-09T12:00:00.000Z",
    });
    const crmFixture = [
      ["HubSpot", "$20/user/month"],
      ["Salesforce", "$25/user/month"],
      ["Pipedrive", "$14/user/month"],
      ["Zoho CRM", "$23/user/month"],
      ["Freshsales", "$11/user/month"],
    ] as const;
    await memory.saveObservations(session.id, crmFixture.map(([name, price]) => ({
      entity: { name, type: "product" },
      source: { url: `https://fixture.example/${encodeURIComponent(name)}`, title: `${name} pricing fixture`, publisher: "fixture.example" },
      attribute: "Entry plan price per user per month",
      value: price,
    })), session.researchedAt);

    const { findRelevantResearch, classifyObservationComparison } = await import("../src/agent/research-memory");
    const result = await findRelevantResearch("crm-fixture", "Has HubSpot, Salesforce, Pipedrive, Zoho CRM, or Freshsales changed pricing for our 20-person team?");
    const historical = result[0]?.observations ?? [];
    expect(historical).toHaveLength(5);
    expect(classifyObservationComparison({ entity: "HubSpot", attribute: "Entry plan price per user per month", value: "$20/user/month", sourceUrl: "https://fixture.example/HubSpot" }, {
      entity: "HubSpot", attribute: "Entry plan price per user per month", value: "$25/user/month", sourceUrl: "https://fixture.example/current" },
    )).toBe("confirmed change");
  });

  it("preserves data when opened through a fresh client after restart", async () => {
    const session = await memory.saveResearchSession({
      conversationId: "restart",
      topic: "Restart persistence",
      summary: "Persisted session",
      researchedAt: "2026-11-05T10:00:00.000Z",
    });
    const restartedClient = createClient({ url: databaseUrl });
    const result = await restartedClient.execute({
      sql: "SELECT topic FROM research_sessions WHERE id = ?",
      args: [session.id],
    });
    restartedClient.close();

    expect(result.rows[0]?.topic).toBe("Restart persistence");
  });

  it("rejects observations with missing foreign-key parents", async () => {
    await expect(memory.db.execute({
      sql: `INSERT INTO observations
            (id, research_session_id, entity_id, source_id, attribute, value, observed_at)
            VALUES ('orphan', 'missing-session', 'missing-entity', 'missing-source', 'price', '$1', '2026-11-01T00:00:00.000Z')`,
    })).rejects.toThrow();
  });

  it("keeps entity deduplication safe under concurrent saves", async () => {
    const sessions = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      memory.saveResearchSession({
        conversationId: "concurrent",
        topic: `Parallel research ${index}`,
        summary: "Concurrent test",
        researchedAt: `2026-11-0${index + 1}T10:00:00.000Z`,
      }),
    ));
    const source = { url: "https://concurrent.example/plan", title: "Plan" };
    await Promise.all(sessions.map((session, index) => memory.saveObservations(session.id, [{
      entity: { name: "Concurrent Co", type: "company" },
      source,
      attribute: "plan price",
      value: `$${index}`,
    }], session.researchedAt)));

    expect(await memory.findEntities(["Concurrent Co"])).toHaveLength(1);
    expect(await memory.getObservations({ sessionIds: sessions.map((session) => session.id) })).toHaveLength(8);
  });
});

describe("evidence validation and comparison outcomes", () => {
  it("discards invalid extraction output and unsupported source claims", async () => {
    const { filterSupportedObservations } = await import("../src/agent/research-memory");
    const hit = {
      searchQuery: "pricing",
      title: "Pricing page",
      url: "https://example.com/pricing",
      content: "Example plan costs $20 per user per month.",
      retrievedAt: "2026-11-13T10:00:00.000Z",
    };
    expect(filterSupportedObservations({ observations: [{ entity: 5 }] }, [hit])).toEqual([]);
    expect(filterSupportedObservations({ observations: [{
      entity: "Example",
      entityType: "company",
      attribute: "Pro price",
      value: "$200",
      sourceUrl: "https://other.example/pricing",
      evidenceQuote: "Example plan costs $200 per user per month.",
    }] }, [hit])).toEqual([]);
  });

  it("distinguishes comparable changes from missing evidence", async () => {
    const { classifyObservationComparison } = await import("../src/agent/research-memory");
    const historical = { entity: "Neon", attribute: "Pro price", value: "$19", sourceUrl: "https://old.example/pricing" };
    expect(classifyObservationComparison(historical, { ...historical, value: "$25", sourceUrl: "https://new.example/pricing" })).toBe("confirmed change");
    expect(classifyObservationComparison(historical, { ...historical, value: " $19  ", sourceUrl: "https://new.example/pricing" })).toBe("no change found in available evidence");
    expect(classifyObservationComparison(undefined, { ...historical, sourceUrl: "https://new.example/pricing" })).toBe("insufficient evidence");
    expect(classifyObservationComparison(historical, undefined)).toBe("insufficient evidence");
    expect(classifyObservationComparison(historical, { ...historical, attribute: "Enterprise price", sourceUrl: "https://new.example/pricing" })).toBe("insufficient evidence");
  });

  it("returns a bounded failure result when Tavily search fails", async () => {
    vi.stubEnv("TAVILY_API_KEY", "test-only-not-a-real-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const { createWebSearchTool } = await import("../src/tools/web-search");
    const searchTool = createWebSearchTool();
    const execute = (searchTool as unknown as {
      execute: (input: { queries: string[] }) => Promise<Array<{ searchQuery: string; error?: string }>>;
    }).execute;
    const result = await execute({ queries: ["pricing update"] });

    expect(result).toHaveLength(1);
    expect(result[0]?.searchQuery).toBe("pricing update");
    expect(result[0]?.error).toMatch(/search failed/i);
    vi.unstubAllGlobals();
  });
});

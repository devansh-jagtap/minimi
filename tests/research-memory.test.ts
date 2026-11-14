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
    const messages = await memory.getRecentMessages(memory.LOCAL_USER_ID, "conversation-schema");
    const sessions = await memory.findResearchSessions({ conversationId: "conversation-schema" });

    expect(messages).toHaveLength(1);
    expect(sessions.map((row) => row.id)).toContain(session.id);
  });

  it("migrates a legacy schema additively and preserves saved data", async () => {
    const legacyUrl = pathToFileURL(join(temporaryDirectory, "legacy.db")).href;
    const legacyClient = createClient({ url: legacyUrl });
    await legacyClient.batch([
      "CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE research_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, topic TEXT NOT NULL, summary TEXT NOT NULL, researched_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE entities (id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, entity_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE sources (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, publisher TEXT, published_at TEXT, retrieved_at TEXT NOT NULL)",
      "CREATE TABLE observations (id TEXT PRIMARY KEY, research_session_id TEXT NOT NULL, entity_id TEXT NOT NULL, source_id TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL, observed_at TEXT NOT NULL, valid_from TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      "INSERT INTO conversations (id) VALUES ('legacy-preserved')",
      "INSERT INTO messages (conversation_id, role, content) VALUES ('legacy-preserved', 'user', 'legacy user data stays private')",
      "INSERT INTO research_sessions (id, conversation_id, topic, summary, researched_at) VALUES ('legacy-session', 'legacy-preserved', 'legacy topic', 'legacy summary', '2026-11-03T10:00:00.000Z')",
      "INSERT INTO entities (id, normalized_name, display_name, entity_type) VALUES ('legacy-entity', 'legacy co', 'Legacy Co', 'company')",
      "INSERT INTO sources (id, url, title, retrieved_at) VALUES ('legacy-source', 'https://legacy.example', 'Legacy source', '2026-11-03T10:00:00.000Z')",
      "INSERT INTO observations (id, research_session_id, entity_id, source_id, attribute, value, observed_at) VALUES ('legacy-observation', 'legacy-session', 'legacy-entity', 'legacy-source', 'price', '$19', '2026-11-03T10:00:00.000Z')",
    ], "write");
    await legacyClient.close();

    vi.stubEnv("DATABASE_URL", legacyUrl);
    vi.resetModules();
    const legacyDb = await import("../src/lib/db");
    await legacyDb.ensureSchema();
    const messages = await legacyDb.db.execute("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = 'legacy-preserved'");
    const sessions = await legacyDb.db.execute("SELECT COUNT(*) AS count FROM research_sessions WHERE id = 'legacy-session'");
    const migrated = await legacyDb.db.execute("SELECT user_id FROM conversations WHERE id = 'legacy-preserved'");
    const addedColumns = await legacyDb.db.execute("PRAGMA table_info(observations)");
    expect(Number(messages.rows[0]?.count)).toBe(1);
    expect(Number(sessions.rows[0]?.count)).toBe(1);
    expect(String(migrated.rows[0]?.user_id)).toBe(legacyDb.LOCAL_USER_ID);
    expect(addedColumns.rows.map((row) => String(row.name))).toContain("plan_tier");
    await legacyDb.db.close();

    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.resetModules();
    memory = await import("../src/lib/db");
    await memory.ensureSchema();
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
      comparison: { planTier: "Starter", currency: "USD", billingInterval: "monthly", priceBasis: "per user", region: "US" },
    })), session.researchedAt);

    const { findRelevantResearch, classifyObservationComparison } = await import("../src/agent/research-memory");
    const result = await findRelevantResearch("crm-fixture", "Has HubSpot, Salesforce, Pipedrive, Zoho CRM, or Freshsales changed pricing for our 20-person team?");
    const historical = result[0]?.observations ?? [];
    expect(historical).toHaveLength(5);
    expect(classifyObservationComparison({ entity: "HubSpot", attribute: "Entry plan price per user per month", value: "$20/user/month", sourceUrl: "https://fixture.example/HubSpot", observedAt: session.researchedAt,
      comparison: { planTier: "Starter", currency: "USD", billingInterval: "monthly", priceBasis: "per user", region: "US" } }, {
      entity: "HubSpot", attribute: "Entry plan price per user per month", value: "$25/user/month", sourceUrl: "https://fixture.example/current",
      observedAt: "2026-11-14T12:00:00.000Z",
      comparison: { planTier: "Starter", currency: "USD", billingInterval: "monthly", priceBasis: "per user", region: "US" } },
    )).toBe("Changed");
  });

  it("retrieves an older cross-chat provider comparison and compares it with fresh search evidence", async () => {
    const { LOCAL_USER_ID } = await import("../src/lib/db");
    const oldDate = "2025-11-03T10:00:00.000Z";
    const historicalSession = await memory.saveResearchSession({
      conversationId: "old-postgres-comparison-chat",
      userId: LOCAL_USER_ID,
      topic: "Compare Neon Supabase Railway PostgreSQL hosting pricing free tier and features",
      summary: "Long historical answer should not be copied into the comparison context. ".repeat(40),
      researchedAt: oldDate,
    });
    const providerFacts = [
      { entity: "Neon", oldPrice: "$19/month", oldLimit: "0.5 GB storage", oldFeature: "Autoscaling to zero", currentPrice: "$25/month", currentLimit: "1 GB storage", currentFeature: "Autoscaling with scale-to-zero" },
      { entity: "Supabase", oldPrice: "$25/month", oldLimit: "500 MB database", oldFeature: "Realtime updates", currentPrice: "$29/month", currentLimit: "1 GB database", currentFeature: "Realtime updates with branching" },
      { entity: "Railway", oldPrice: "$5/month", oldLimit: "No free database tier", oldFeature: "Usage-based deployments", currentPrice: "$7/month", currentLimit: "$5 trial credit", currentFeature: "Usage-based deployments with templates" },
    ] as const;
    const priceComparison = { planTier: "Pro", currency: "USD", billingInterval: "monthly", priceBasis: "per project", region: "US" };
    await memory.saveObservations(historicalSession.id, providerFacts.flatMap((fact) => [
      {
        entity: { name: fact.entity, type: "company" as const },
        source: { url: `https://history.example/${fact.entity.toLowerCase()}`, title: `${fact.entity} historical pricing`, publishedAt: "2025-11-01" },
        attribute: "Pro plan price", value: fact.oldPrice, comparison: priceComparison,
      },
      {
        entity: { name: fact.entity, type: "company" as const },
        source: { url: `https://history.example/${fact.entity.toLowerCase()}-limits`, title: `${fact.entity} historical limits` },
        attribute: "Free tier limit", value: fact.oldLimit,
      },
      {
        entity: { name: fact.entity, type: "company" as const },
        source: { url: `https://history.example/${fact.entity.toLowerCase()}-features`, title: `${fact.entity} historical features` },
        attribute: "Major features", value: fact.oldFeature,
      },
    ]), oldDate);

    const unrelatedCrmSession = await memory.saveResearchSession({
      conversationId: "unrelated-crm-history-chat",
      userId: LOCAL_USER_ID,
      topic: "Shortlist CRM pricing and features for a sales team",
      summary: "Unrelated saved CRM comparison.",
      researchedAt: "2026-11-10T10:00:00.000Z",
    });
    await memory.saveObservations(unrelatedCrmSession.id, [
      { entity: { name: "HubSpot", type: "company" }, source: { url: "https://history.example/hubspot-crm", title: "CRM pricing" }, attribute: "Pro plan price", value: "$20/user/month" },
      { entity: { name: "Salesforce", type: "company" }, source: { url: "https://history.example/salesforce-crm", title: "CRM pricing" }, attribute: "Pro plan price", value: "$25/user/month" },
    ], unrelatedCrmSession.researchedAt);

    // Put the target beyond the recent-session window to verify entity-targeted lookup.
    for (let index = 0; index < 55; index += 1) {
      await memory.saveResearchSession({
        conversationId: `newer-unrelated-research-${index}`,
        userId: LOCAL_USER_ID,
        topic: `Unrelated topic ${index}`,
        summary: "Unrelated recent research.",
        researchedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
      });
    }

    const { findRelevantResearch, filterSupportedObservations, classifyObservationComparison } = await import("../src/agent/research-memory");
    const query = "Last time we compared Neon, Supabase, and Railway for PostgreSQL hosting. Has their pricing, free-tier limits, or major features changed since?";
    const broadRecentHistory = `${query}\nI also shortlisted HubSpot, Pipedrive, Zoho CRM, Freshsales, and Salesforce for a sales team.`;
    const history = await findRelevantResearch(LOCAL_USER_ID, broadRecentHistory, query, true);
    const historical = history.find((item) => item.session.topic.includes("Compare Neon Supabase Railway"));
    expect(historical?.session.researchedAt).toBe(oldDate);
    expect(historical?.session).not.toHaveProperty("summary");
    expect(historical?.observations).toHaveLength(9);
    expect(history.flatMap((item) => item.observations).map((item) => item.entity)).not.toContain("Salesforce");
    expect(history.flatMap((item) => item.observations).map((item) => item.entity)).not.toContain("HubSpot");

    vi.stubEnv("TAVILY_API_KEY", "test-only-not-a-real-key");
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as { query: string };
      const fact = providerFacts.find((item) => requestBody.query.toLowerCase().includes(item.entity.toLowerCase()))!;
      const priceQuote = `${fact.entity} Pro plan costs ${fact.currentPrice} per project each month.`;
      const limitQuote = `${fact.entity} free tier includes ${fact.currentLimit}.`;
      const featureQuote = `${fact.entity} major features include ${fact.currentFeature}.`;
      return Response.json({ results: [{
        title: `${fact.entity} official plans`,
        url: `https://${fact.entity.toLowerCase()}.example/current`,
        content: `${priceQuote} ${limitQuote} ${featureQuote}`,
        score: 0.99,
        published_date: "2026-11-14",
      }] });
    }));
    const { createWebSearchTool } = await import("../src/tools/web-search");
    const searchTool = createWebSearchTool();
    const execute = (searchTool as unknown as {
      execute: (input: { queries: string[] }) => Promise<Array<{ searchQuery: string; title: string; url: string; content: string; retrievedAt: string }>>;
    }).execute;
    const currentHits = await execute({ queries: providerFacts.map((fact) => `${fact.entity} PostgreSQL hosting current pricing free tier features`) });
    expect(currentHits).toHaveLength(3);

    const currentRaw = providerFacts.flatMap((fact) => {
      const hit = currentHits.find((item) => item.url.includes(fact.entity.toLowerCase()))!;
      return [
        { entity: fact.entity, entityType: "company", attribute: "Pro plan price", value: fact.currentPrice, sourceUrl: hit.url, evidenceQuote: `${fact.entity} Pro plan costs ${fact.currentPrice} per project each month.`, comparison: priceComparison },
        { entity: fact.entity, entityType: "company", attribute: "Free tier limit", value: fact.currentLimit, sourceUrl: hit.url, evidenceQuote: `${fact.entity} free tier includes ${fact.currentLimit}.` },
        { entity: fact.entity, entityType: "company", attribute: "Major features", value: fact.currentFeature, sourceUrl: hit.url, evidenceQuote: `${fact.entity} major features include ${fact.currentFeature}.` },
      ];
    });
    const current = filterSupportedObservations({ observations: currentRaw }, currentHits);
    expect(current).toHaveLength(9);

    for (const provider of providerFacts) {
      for (const attribute of ["Pro plan price", "Free tier limit", "Major features"]) {
        const previous = historical!.observations.find((item) => item.entity === provider.entity && item.attribute === attribute)!;
        const fresh = current.find((item) => item.entity.name === provider.entity && item.attribute === attribute)!;
        const status = classifyObservationComparison({
          entity: previous.entity,
          attribute: previous.attribute,
          value: previous.value,
          sourceUrl: previous.source.url,
          observedAt: previous.observedAt,
          validFrom: previous.validFrom,
          comparison: previous.comparison,
        }, {
          entity: fresh.entity.name,
          attribute: fresh.attribute,
          value: fresh.value,
          sourceUrl: fresh.source.url,
          observedAt: currentHits.find((hit) => hit.url === fresh.source.url)!.retrievedAt,
          validFrom: fresh.validFrom,
          comparison: fresh.comparison,
        });
        const expected = provider.entity === "Railway" && attribute === "Free tier limit" ? "Unable to verify" : "Changed";
        expect(status, `${provider.entity} ${attribute}`).toBe(expected);
      }
    }
    vi.unstubAllGlobals();
  }, 30000);

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

  it("retrieves matching messages across conversations for one owner only", async () => {
    const { LOCAL_USER_ID, searchUserMessages, saveMessage } = await import("../src/lib/db");
    await saveMessage("global-memory-a", "user", "MetaCrossTest discussed open-weight model strategy", LOCAL_USER_ID);
    await saveMessage("global-memory-a", "assistant", "MetaCrossTest chose an open-weight strategy", LOCAL_USER_ID);
    await memory.db.execute({ sql: "UPDATE messages SET created_at = ? WHERE conversation_id = ?", args: ["2026-11-12 21:17:03", "global-memory-a"] });
    await memory.db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: ["isolated-test-user"] });
    await saveMessage("global-memory-b", "user", "MetaCrossTest unrelated private discussion", "isolated-test-user");

    const sameOwner = await searchUserMessages({ userId: LOCAL_USER_ID, query: "MetaCrossTest", limit: 20 });
    const otherOwner = await searchUserMessages({ userId: "isolated-test-user", query: "MetaCrossTest", limit: 20 });

    expect(sameOwner.map((row) => row.conversation_id)).toContain("global-memory-a");
    expect(sameOwner.map((row) => row.conversation_id)).not.toContain("global-memory-b");
    expect(otherOwner.map((row) => row.conversation_id)).toEqual(["global-memory-b"]);
    const { dateWindowUtc, parseRecallDate, localDateParts, sameDate } = await import("../src/agent/history-recall");
    const requestedDate = parseRecallDate("what we discussed about Meta on 13th nov", "Asia/Kolkata", new Date("2026-11-13T00:00:00Z"))!;
    const matchingDay = sameOwner.filter((row) => sameDate(localDateParts(String(row.created_at), "Asia/Kolkata"), requestedDate));
    const dayRows = await searchUserMessages({ userId: LOCAL_USER_ID, query: "MetaCrossTest", ...dateWindowUtc(requestedDate, "Asia/Kolkata") });
    expect(matchingDay.length).toBeGreaterThan(0);
    expect(dayRows.map((row) => row.conversation_id)).toContain("global-memory-a");
  });

  it("stores and retrieves durable memory by owner without duplicate summaries", async () => {
    const { LOCAL_USER_ID, saveMemoryItem, findRelevantMemoryItems } = await import("../src/lib/db");
    const input = { userId: LOCAL_USER_ID, conversationId: "durable-memory", memoryType: "important_discussions", content: "Discussed the Meta open-weight strategy.", summary: "Meta open-weight strategy" };
    const first = await saveMemoryItem(input);
    const second = await saveMemoryItem(input);
    const found = await findRelevantMemoryItems(LOCAL_USER_ID, "What about Meta open-weight strategy?");
    const isolated = await findRelevantMemoryItems("isolated-test-user", "Meta open-weight strategy");
    const unrelated = await findRelevantMemoryItems(LOCAL_USER_ID, "How tall is Mount Everest?");
    const restartedClient = createClient({ url: databaseUrl });
    const persisted = await restartedClient.execute({
      sql: "SELECT id FROM memory_items WHERE user_id = ? AND id = ?",
      args: [LOCAL_USER_ID, first],
    });
    restartedClient.close();

    expect(first).toBe(second);
    expect(found.map((row) => row.id)).toContain(first);
    expect(isolated).toEqual([]);
    expect(unrelated).toEqual([]);
    expect(persisted.rows[0]?.id).toBe(first);
  });

  it("retrieves historical observations across conversations but keeps them user-scoped", async () => {
    const { LOCAL_USER_ID } = await import("../src/lib/db");
    const first = await memory.saveResearchSession({
      conversationId: "global-research-a",
      userId: LOCAL_USER_ID,
      topic: "GlobalNeonTest pricing",
      summary: "Recorded old plan price.",
      researchedAt: "2026-11-03T10:00:00.000Z",
    });
    await memory.saveObservations(first.id, [{
      entity: { name: "GlobalNeonTest", type: "company" },
      source: { url: "https://global-neon.example/pricing", title: "Historical pricing" },
      attribute: "Pro plan price",
      value: "$19",
    }], first.researchedAt);
    await memory.db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: ["research-isolated-user"] });
    await memory.saveResearchSession({
      conversationId: "global-research-b",
      userId: "research-isolated-user",
      topic: "GlobalNeonTest private pricing",
      summary: "Private other-user session.",
      researchedAt: "2026-11-04T10:00:00.000Z",
    });

    const { findRelevantResearch } = await import("../src/agent/research-memory");
    const ownerHistory = await findRelevantResearch(LOCAL_USER_ID, "GlobalNeonTest price", "GlobalNeonTest price", true);
    const otherHistory = await findRelevantResearch("research-isolated-user", "GlobalNeonTest private price", "GlobalNeonTest private price", true);
    expect(ownerHistory.flatMap((session) => session.observations).map((item) => item.value)).toContain("$19");
    expect(otherHistory.flatMap((session) => session.observations).map((item) => item.value)).not.toContain("$19");
  });

  it("deletes one owner's conversation, messages, memories and research only", async () => {
    const { LOCAL_USER_ID, saveMessage, saveMemoryItem, deleteConversation } = await import("../src/lib/db");
    await saveMessage("delete-chat-a", "user", "DeleteMe unique content", LOCAL_USER_ID);
    await saveMessage("delete-chat-a", "assistant", "DeleteMe answer", LOCAL_USER_ID);
    const session = await memory.saveResearchSession({ conversationId: "delete-chat-a", topic: "DeleteMe research", summary: "DeleteMe summary", researchedAt: "2026-11-10T10:00:00.000Z" });
    await memory.saveObservations(session.id, [{ entity: { name: "DeleteMe Co", type: "company" }, source: { url: "https://delete-me.example", title: "DeleteMe source" }, attribute: "status", value: "old" }], session.researchedAt);
    const sharedSession = await memory.saveResearchSession({ conversationId: "delete-chat-b", topic: "Keep shared evidence", summary: "Evidence from another conversation", researchedAt: "2026-11-11T10:00:00.000Z" });
    await memory.saveObservations(sharedSession.id, [{ entity: { name: "DeleteMe Co", type: "company" }, source: { url: "https://delete-me.example", title: "DeleteMe source" }, attribute: "status", value: "new" }], sharedSession.researchedAt);
    await saveMemoryItem({ userId: LOCAL_USER_ID, conversationId: "delete-chat-a", memoryType: "research", content: "DeleteMe memory", summary: "DeleteMe summary" });
    await memory.db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: ["delete-other-user"] });
    await saveMessage("delete-chat-other", "user", "DeleteMe other-owner conversation", "delete-other-user");

    expect(await deleteConversation("delete-other-user", "delete-chat-a")).toBe(false);
    expect(await deleteConversation(LOCAL_USER_ID, "delete-chat-a")).toBe(true);
    expect((await memory.getRecentMessages(LOCAL_USER_ID, "delete-chat-a"))).toEqual([]);
    expect((await memory.findResearchSessions({ conversationId: "delete-chat-a" }))).toEqual([]);
    const retainedSession = await memory.findResearchSessions({ conversationId: "delete-chat-b" });
    const retainedObservations = await memory.getObservations({ sessionIds: retainedSession.map((row) => String(row.id)) });
    expect(retainedObservations.map((row) => row.value)).toContain("new");
    expect((await memory.getSources(retainedObservations.map((row) => String(row.source_id)))).map((row) => row.url)).toContain("https://delete-me.example");
    expect((await memory.db.execute({ sql: "SELECT id FROM memory_items WHERE source_conversation_id = ?", args: ["delete-chat-a"] })).rows).toEqual([]);
    expect((await memory.getRecentMessages("delete-other-user", "delete-chat-other")).map((row) => row.content)).toContain("DeleteMe other-owner conversation");
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

  it("does not allow another account to read or append to a conversation", async () => {
    const { LOCAL_USER_ID, saveMessage, getRecentMessages } = await import("../src/lib/db");
    await saveMessage("private-conversation", "user", "owner-only fixture", LOCAL_USER_ID);
    expect(await getRecentMessages("another-user", "private-conversation")).toEqual([]);
    await expect(saveMessage("private-conversation", "user", "unauthorized append", "another-user")).rejects.toThrow(/owner mismatch/i);
    expect((await getRecentMessages(LOCAL_USER_ID, "private-conversation")).map((row) => row.content)).toEqual(["owner-only fixture"]);
  });

  it("allows only one concurrent account to claim a legacy conversation", async () => {
    const { claimLegacyConversations, legacyConversationProof, LOCAL_USER_ID } = await import("../src/lib/db");
    await memory.db.execute({ sql: "INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)", args: ["claim-race", "local-single-user"] });
    const transcript = [{ role: "user", content: "local possession proof fixture" }];
    await memory.db.execute({ sql: "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)", args: ["claim-race", "user", transcript[0].content] });
    const proof = legacyConversationProof(transcript);
    const [first, second] = await Promise.all([
      claimLegacyConversations("claim-user-a", [{ id: "claim-race", proof, messageCount: 1 }]),
      claimLegacyConversations("claim-user-b", [{ id: "claim-race", proof, messageCount: 1 }]),
    ]);
    const owner = await memory.db.execute({ sql: "SELECT user_id FROM conversations WHERE id = ?", args: ["claim-race"] });
    expect([first.length, second.length].sort()).toEqual([0, 1]);
    expect(["claim-user-a", "claim-user-b"]).toContain(String(owner.rows[0]?.user_id));
    expect(String(owner.rows[0]?.user_id)).not.toBe(LOCAL_USER_ID);
  });

  it("rejects legacy claims without possession of the saved transcript", async () => {
    const { claimLegacyConversations, LOCAL_USER_ID } = await import("../src/lib/db");
    await memory.db.execute({ sql: "INSERT INTO conversations (id, user_id) VALUES (?, ?)", args: ["claim-proof", LOCAL_USER_ID] });
    await memory.db.execute({ sql: "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)", args: ["claim-proof", "user", "private legacy transcript"] });
    const claimed = await claimLegacyConversations("attacker-account", [{ id: "claim-proof", proof: "0".repeat(64), messageCount: 1 }]);
    const owner = await memory.db.execute({ sql: "SELECT user_id FROM conversations WHERE id = ?", args: ["claim-proof"] });
    expect(claimed).toEqual([]);
    expect(String(owner.rows[0]?.user_id)).toBe(LOCAL_USER_ID);
    expect(await claimLegacyConversations("attacker-account", [{ id: "claim-proof", proof: "0".repeat(64), messageCount: 0 }])).toEqual([]);
  });
});

describe("evidence validation and comparison outcomes", () => {
  it("parses local-day dates and weekday references across UTC boundaries", async () => {
    const { parseRecallDate, localDateParts, sameDate, dateWindowUtc, formatCalendarDate, historyRecallTopic, isHistoryRecallQuestion, selectRecallTurns } = await import("../src/agent/history-recall");
    const date = parseRecallDate("what we discussed about Meta on 13th nov", "Asia/Kolkata", new Date("2026-11-13T00:00:00Z"));

    expect(date).toEqual({ year: 2026, month: 10, day: 13 });
    expect(sameDate(localDateParts("2026-11-12 21:17:03", "Asia/Kolkata"), date!)).toBe(true);
    expect(dateWindowUtc(date!, "Asia/Kolkata")).toEqual({ startUtc: "2026-11-12 18:30:00", endUtc: "2026-11-13 18:30:00" });
    expect(formatCalendarDate(date!)).toBe("November 13, 2026");
    expect(isHistoryRecallQuestion("what we discussed about the meta on 13th nov")).toBe(true);
    expect(historyRecallTopic("What did I ask you on 3 November?")).toBe("");
    expect(historyRecallTopic("what we discussed about the meta on 13th nov")).toBe("meta");
    expect(historyRecallTopic("what did I ask you about last Monday?")).toBe("");
    expect(parseRecallDate("what did I ask you about last Monday?", "Asia/Kolkata", new Date("2026-11-13T00:30:00Z"))).toEqual({ year: 2026, month: 10, day: 9 });
    const { temporalMatch } = await import("../src/agent/research-memory");
    expect(temporalMatch("last Monday", "2026-11-09T17:00:00Z", "Asia/Kolkata", new Date("2026-11-13T00:30:00Z"))).toBe(true);
    expect(temporalMatch("last Monday", "2026-11-09T18:30:00Z", "Asia/Kolkata", new Date("2026-11-13T00:30:00Z"))).toBe(false);
    const turns = selectRecallTurns([
      { id: 1, conversation_id: "old-meta", role: "user", content: "Why is Meta not in the frontier AI race?", created_at: "2026-11-12 20:56:59" },
      { id: 2, conversation_id: "old-meta", role: "assistant", content: "We discussed its open-weight strategy, business incentives, and benchmark performance.", created_at: "2026-11-12 20:57:08" },
      { id: 3, conversation_id: "current", role: "user", content: "search the other chat and find the one where we discussed Meta", created_at: "2026-11-12 21:14:17" },
      { id: 4, conversation_id: "current", role: "assistant", content: "I do not have access to your other chat sessions.", created_at: "2026-11-12 21:14:23" },
      { id: 5, conversation_id: "current", role: "user", content: "what we discussed about the meta on 13th nov", created_at: "2026-11-12 21:17:03" },
      { id: 6, conversation_id: "current", role: "assistant", content: "I have no record of our previous conversation history.", created_at: "2026-11-12 21:17:10" },
    ], "meta");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("Why is Meta not in the frontier AI race?");
    expect(turns[0]?.answer).toContain("open-weight strategy");
  });

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
    expect(filterSupportedObservations({ observations: [{
      entity: "Example", entityType: "company", attribute: "Pro price", value: "$200 per user per month",
      sourceUrl: hit.url, evidenceQuote: "Example plan costs $20 per user per month.",
    }] }, [hit])).toEqual([]);
    const datedHit = { ...hit, content: "Example plan costs $20 per user per month effective November 13, 2026." };
    expect(filterSupportedObservations({ observations: [{
      entity: "Example", entityType: "company", attribute: "Pro price", value: "$20 per user per month",
      sourceUrl: hit.url, evidenceQuote: "Example plan costs $20 per user per month effective November 13, 2026.", validFrom: "2026-11-12",
    }] }, [datedHit])).toEqual([]);
    expect(filterSupportedObservations({ observations: [{
      entity: "Example", entityType: "company", attribute: "Pro price", value: "€20 per user per month",
      sourceUrl: hit.url, evidenceQuote: "Example plan costs $20 per user per month.",
    }] }, [hit])).toEqual([]);
    expect(filterSupportedObservations({ observations: [{
      entity: "Example", entityType: "company", attribute: "Pro price", value: "$20 per user per month",
      sourceUrl: hit.url, evidenceQuote: "Example plan costs $20 per user per month effective November 13, 2026.", validFrom: "2026-11-13",
    }] }, [datedHit])).toHaveLength(1);
  });

  it("distinguishes comparable changes from missing evidence", async () => {
    const { classifyObservationComparison } = await import("../src/agent/research-memory");
    const comparison = { planTier: "Pro", currency: "USD", billingInterval: "monthly", priceBasis: "per account", region: "US" };
    const historical = { entity: "Neon", attribute: "Pro price", value: "$19/month", sourceUrl: "https://old.example/pricing", observedAt: "2025-11-03T10:00:00.000Z", comparison };
    const current = { ...historical, value: "$25/month", sourceUrl: "https://new.example/pricing", observedAt: "2026-11-14T10:00:00.000Z" };
    expect(classifyObservationComparison(historical, current)).toBe("Changed");
    expect(classifyObservationComparison(historical, { ...historical, value: " $19/month  ", sourceUrl: "https://new.example/pricing", observedAt: "2026-11-14T10:00:00.000Z" })).toBe("Unchanged");
    expect(classifyObservationComparison({ ...historical, value: "$19/user/month", comparison: { ...comparison, priceBasis: "per user" } }, { ...current, value: "$25/user/month", comparison: { ...comparison, priceBasis: "per user" } })).toBe("Changed");
    expect(classifyObservationComparison({ ...historical, value: "$19/user/month", comparison: undefined }, { ...current, value: "$25/user/month", comparison: undefined })).toBe("Unable to verify");
    expect(classifyObservationComparison({ ...historical, value: "$19/month", comparison: undefined }, { ...current, value: "$25/month", comparison: undefined })).toBe("Unable to verify");
    expect(classifyObservationComparison(historical, { ...current, comparison: { ...comparison, billingInterval: "annual" } })).toBe("Unable to verify");
    expect(classifyObservationComparison(historical, { ...current, value: "€25/month", comparison: { ...comparison, currency: "EUR" } })).toBe("Unable to verify");
    expect(classifyObservationComparison(historical, { ...current, comparison: { ...comparison, planTier: "Enterprise" } })).toBe("Unable to verify");
    expect(classifyObservationComparison(historical, { ...current, comparison: { ...comparison, region: undefined } })).toBe("Unable to verify");
    expect(classifyObservationComparison(undefined, current)).toBe("Unable to verify");
    expect(classifyObservationComparison(historical, undefined)).toBe("Unable to verify");
    expect(classifyObservationComparison(historical, { ...current, attribute: "Enterprise price" })).toBe("Unable to verify");
    expect(classifyObservationComparison(historical, { ...current, observedAt: historical.observedAt })).toBe("Unable to verify");
    expect(classifyObservationComparison({ ...historical, observedAt: undefined }, current)).toBe("Unable to verify");
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

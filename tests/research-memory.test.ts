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
    const dayRows = await searchUserMessages({ userId: LOCAL_USER_ID, query: "MetaCrossTest", ...dateWindowUtc(requestedDate) });
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
    const ownerHistory = await findRelevantResearch(LOCAL_USER_ID, "GlobalNeonTest price", "today", true);
    const otherHistory = await findRelevantResearch("research-isolated-user", "GlobalNeonTest private price", "today", true);
    expect(ownerHistory.flatMap((session) => session.observations).map((item) => item.value)).toContain("$19");
    expect(otherHistory.flatMap((session) => session.observations).map((item) => item.value)).not.toContain("$19");
  });

  it("deletes one owner's conversation, messages, memories and research only", async () => {
    const { LOCAL_USER_ID, saveMessage, saveMemoryItem, deleteConversation } = await import("../src/lib/db");
    await saveMessage("delete-chat-a", "user", "DeleteMe unique content", LOCAL_USER_ID);
    await saveMessage("delete-chat-a", "assistant", "DeleteMe answer", LOCAL_USER_ID);
    const session = await memory.saveResearchSession({ conversationId: "delete-chat-a", topic: "DeleteMe research", summary: "DeleteMe summary", researchedAt: "2026-11-10T10:00:00.000Z" });
    await memory.saveObservations(session.id, [{ entity: { name: "DeleteMe Co", type: "company" }, source: { url: "https://delete-me.example", title: "DeleteMe source" }, attribute: "status", value: "old" }], session.researchedAt);
    await saveMemoryItem({ userId: LOCAL_USER_ID, conversationId: "delete-chat-a", memoryType: "research", content: "DeleteMe memory", summary: "DeleteMe summary" });
    await memory.db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: ["delete-other-user"] });
    await saveMessage("delete-chat-b", "user", "DeleteMe other-owner conversation", "delete-other-user");

    expect(await deleteConversation("delete-other-user", "delete-chat-a")).toBe(false);
    expect(await deleteConversation(LOCAL_USER_ID, "delete-chat-a")).toBe(true);
    expect((await memory.getRecentMessages(LOCAL_USER_ID, "delete-chat-a"))).toEqual([]);
    expect((await memory.findResearchSessions({ conversationId: "delete-chat-a" }))).toEqual([]);
    expect((await memory.db.execute({ sql: "SELECT id FROM memory_items WHERE source_conversation_id = ?", args: ["delete-chat-a"] })).rows).toEqual([]);
    expect((await memory.getRecentMessages("delete-other-user", "delete-chat-b")).map((row) => row.content)).toContain("DeleteMe other-owner conversation");
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
  it("parses ordinal day-first dates and handles UTC messages in the user's local day", async () => {
    const { parseRecallDate, localDateParts, sameDate, dateWindowUtc, historyRecallTopic, isHistoryRecallQuestion, selectRecallTurns } = await import("../src/agent/history-recall");
    const date = parseRecallDate("what we discussed about Meta on 13th nov", "Asia/Kolkata", new Date("2026-11-13T00:00:00Z"));

    expect(date).toEqual({ year: 2026, month: 10, day: 13 });
    expect(sameDate(localDateParts("2026-11-12 21:17:03", "Asia/Kolkata"), date!)).toBe(true);
    expect(dateWindowUtc(date!)).toEqual({ startUtc: "2026-11-12 00:00:00", endUtc: "2026-11-15 00:00:00" });
    expect(isHistoryRecallQuestion("what we discussed about the meta on 13th nov")).toBe(true);
    expect(historyRecallTopic("What did I ask you on 3 November?")).toBe("");
    expect(historyRecallTopic("what we discussed about the meta on 13th nov")).toBe("meta");
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

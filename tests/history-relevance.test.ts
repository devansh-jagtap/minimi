import { describe, expect, it } from "vitest";

import { historyRecallTopic, selectRecallTurns } from "../src/agent/history-recall";

const rows = [
  {
    id: "1", conversation_id: "postgres-chat", role: "user",
    content: "We compared Neon, Supabase, and Railway for PostgreSQL hosting. Neon was simplest, Supabase offered a generous free tier, Railway was easiest to deploy. We recommended Neon for production.", created_at: "2026-11-03 10:00:00",
  },
  {
    id: "2", conversation_id: "postgres-chat", role: "assistant",
    content: "Recommendation: Neon for production PostgreSQL hosting; Supabase for its integrated platform and free tier; Railway for quick deployment.", created_at: "2026-11-03 10:01:00",
  },
  {
    id: "3", conversation_id: "crm-chat", role: "user",
    content: "We compared CRM providers HubSpot, Pipedrive, Zoho CRM, Freshsales, and Salesforce for a 20-person sales team.", created_at: "2026-11-04 10:00:00",
  },
  {
    id: "4", conversation_id: "crm-chat", role: "assistant",
    content: "Recommendation: Pipedrive for sales-focused pipeline management, HubSpot for inbound, and Salesforce for advanced requirements.", created_at: "2026-11-04 10:01:00",
  },
];

const recall = (query: string) => selectRecallTurns(rows, historyRecallTopic(query));

describe("cross-conversation recall relevance", () => {
  it("selects only PostgreSQL history despite generic words shared with CRM", () => {
    const answer = recall("Do you remember our previous discussion about PostgreSQL hosting? Which providers did we compare, what were the key findings, and what was your recommendation? Please retrieve the information from our earlier conversation rather than guessing.");
    expect(answer.map((turn) => turn.conversationId)).toEqual(["postgres-chat"]);
  });

  it("selects only CRM history for a CRM question", () => {
    expect(recall("What did we previously compare about CRM platforms?").map((turn) => turn.conversationId)).toEqual(["crm-chat"]);
  });

  it("does not inject either conversation for an unrelated topic", () => {
    expect(recall("What did we discuss about cloud security earlier?")).toEqual([]);
  });

  it("can select both conversations when the user explicitly asks about both", () => {
    const result = recall("What did we previously discuss about PostgreSQL hosting and CRM platforms?");
    expect(new Set(result.map((turn) => turn.conversationId))).toEqual(new Set(["postgres-chat", "crm-chat"]));
  });

  it("matches different wording for database hosting", () => {
    expect(recall("Where did we compare database hosting providers?").map((turn) => turn.conversationId)).toEqual(["postgres-chat"]);
  });

  it("returns no matches when the user or topic has no evidence", () => {
    expect(selectRecallTurns(rows, "")).toEqual([]);
  });
});

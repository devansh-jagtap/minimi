import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "memory-route-owner" }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: authState.userId }) }));
vi.mock("next/server", () => ({ after: () => undefined }));

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
    expect(answer.text).toContain("Recommendation: Neon");
    expect(answer.text).not.toMatch(/HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
    expect(answer.text).toBe("I found this saved discussion:\n\nYou asked: “We compared Neon, Supabase, and Railway for PostgreSQL hosting.”\n\nMinimi answered: Findings: Neon offered the strongest branching workflow, Supabase combined Postgres with an integrated platform, and Railway was fastest to deploy. Recommendation: Neon for the production database.");
  });

  it("answers a CRM recall without injecting PostgreSQL history", async () => {
    const answer = await recall("What did we previously compare about CRM platforms?");
    expect(answer.text).toContain("HubSpot");
    expect(answer.text).toContain("Pipedrive");
    expect(answer.text).not.toMatch(/Neon|Supabase|Railway|PostgreSQL/);
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
  });

  it("matches the alternate database-hosting wording", async () => {
    const answer = await recall("Where did we compare database hosting providers?");
    expect(answer.text).toContain("Neon");
    expect(answer.text).toContain("Supabase");
    expect(answer.text).toContain("Railway");
    expect(answer.text).not.toMatch(/HubSpot|Pipedrive|Zoho CRM|Freshsales|Salesforce/);
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
});

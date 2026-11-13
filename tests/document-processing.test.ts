import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let dbModule: typeof import("../src/lib/db");
let docs: typeof import("../src/lib/document-processing");
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "minimi-document-test-"));
  vi.stubEnv("DATABASE_URL", pathToFileURL(join(temporaryDirectory, "documents.db")).href);
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-only-not-a-real-key");
  vi.resetModules();
  dbModule = await import("../src/lib/db");
  docs = await import("../src/lib/document-processing");
  await dbModule.ensureSchema();
});

afterAll(async () => {
  await dbModule.db.close();
  vi.unstubAllEnvs();
});

describe("document extraction and chunking", () => {
  it("preserves TXT headings and splits large text with bounded overlap", async () => {
    const source = `# Account overview\n\n${"The customer selected the Pro plan for the sales team. ".repeat(90)}\n\n## Renewal\n\nAnnual renewal is due in October.`;
    const blocks = await docs.extractDocumentBlocks(new TextEncoder().encode(source), "text/plain");
    expect(blocks[0]).toEqual({ text: "Account overview", sectionHeading: "Account overview" });
    expect(blocks.some((block) => block.sectionHeading === "Renewal" && block.text.includes("Annual renewal"))).toBe(true);

    const chunks = docs.chunkDocumentBlocks(blocks, 520, 80);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= 520)).toBe(true);
    expect(chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.contentHash))).toBe(true);
    expect(chunks.some((chunk) => chunk.sectionHeading === "Renewal")).toBe(true);
    expect(chunks[1]?.text).toContain(chunks[0]?.text.slice(-80, -30));
  });

  it("rejects empty text and MIME-spoofed PDFs instead of completing empty extraction", async () => {
    await expect(docs.extractDocumentBlocks(new Uint8Array(), "text/plain")).rejects.toThrow(/empty/i);
    await expect(docs.extractDocumentBlocks(new TextEncoder().encode("not a PDF"), "application/pdf")).rejects.toThrow(/does not match/i);
  });

  it("extracts table rows from a DOCX fixture with section metadata", async () => {
    const fixture = readFileSync(join(process.cwd(), "node_modules/mammoth/test/test-data/tables.docx"));
    const blocks = await docs.extractDocumentBlocks(new Uint8Array(fixture), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((block) => block.text.includes("|"))).toBe(true);
    expect(blocks.every((block) => typeof block.text === "string")).toBe(true);
  });

  it("routes PNG, JPEG, and WebP through the injected OCR boundary", async () => {
    const signatures = [
      ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ["image/jpeg", [0xff, 0xd8, 0xff, 0x00]],
      ["image/webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]],
    ] as const;
    const vision = vi.fn(async (_bytes: Uint8Array, mimeType: string, prompt: string) => {
      expect(prompt).toMatch(/untrusted document text/i);
      return "Fixture label for " + mimeType;
    });
    for (const [mimeType, signature] of signatures) {
      const blocks = await docs.extractDocumentBlocks(new Uint8Array([...signature, 0, 0, 0]), mimeType, { vision });
      expect(blocks[0]?.text).toContain(mimeType);
    }
    expect(vision).toHaveBeenCalledTimes(3);
  });

  it("stores idempotent-ready embeddings and hashes from injected deterministic vectors", async () => {
    const document = {
      id: "doc-process-fixture", userId: "doc-owner-a", conversationId: "doc-conv-a",
      objectKey: "opaque/key", filename: "notes.txt", mimeType: "text/plain",
      sizeBytes: new TextEncoder().encode("Pro renewals are billed annually.").byteLength, attemptCount: 1,
    };
    const bytes = new TextEncoder().encode("Pro renewals are billed annually.");
    const result = await docs.processDocumentContent({ document, bytes, embed: async (values) => values.map(() => [1, 0, 0]) });
    expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.embeddingModel).toBe(process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.embedding).toEqual([1, 0, 0]);
    await expect(docs.processDocumentContent({ document, bytes: new TextEncoder().encode("different bytes"), embed: async () => [[1]] })).rejects.toThrow(/size does not match/i);
  });
});

describe("document retrieval scope and citations", () => {
  it("ranks matching chunks while filtering by both owner and conversation", async () => {
    await dbModule.db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: ["doc-owner-a"] });
    await dbModule.db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: ["doc-owner-b"] });
    await dbModule.db.execute({ sql: "INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)", args: ["doc-conv-a", "doc-owner-a"] });
    await dbModule.db.execute({ sql: "INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)", args: ["doc-conv-b", "doc-owner-a"] });
    await dbModule.db.execute({ sql: "INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)", args: ["doc-conv-other-owner", "doc-owner-b"] });
    const rows = [
      { id: "doc-a", owner: "doc-owner-a", conversation: "doc-conv-a", filename: "pricing.pdf", content: "Pro is $19 monthly per account.", page: 3, vector: [1, 0] },
      { id: "doc-b", owner: "doc-owner-a", conversation: "doc-conv-b", filename: "other-chat.txt", content: "Pro is $999 monthly per account.", page: null, vector: [1, 0] },
      { id: "doc-c", owner: "doc-owner-b", conversation: "doc-conv-other-owner", filename: "private.txt", content: "Pro is $888 monthly per account.", page: null, vector: [1, 0] },
    ];
    for (const row of rows) {
      await dbModule.db.execute({
        sql: `INSERT INTO documents (id, user_id, conversation_id, object_key, filename, mime_type, size_bytes, status)
              VALUES (?, ?, ?, ?, ?, 'text/plain', 1, 'completed')`,
        args: [row.id, row.owner, row.conversation, `key/${row.id}`, row.filename],
      });
      await dbModule.db.execute({
        sql: `INSERT INTO document_chunks
              (id, document_id, user_id, chunk_index, content, page_number, content_hash, embedding_json, embedding_model)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'test-embedding-v1')`,
        args: [`chunk-${row.id}`, row.id, row.owner, row.content, row.page, row.id.repeat(8), JSON.stringify(row.vector)],
      });
    }

    const result = await docs.retrieveDocumentContext("doc-owner-a", "doc-conv-a", "Pro price monthly", {
      embed: async () => [[1, 0]], minScore: 0.05,
    });
    expect(result.citations).toEqual([{ documentId: "doc-a", filename: "pricing.pdf", pageNumber: 3, sectionHeading: undefined }]);
    expect(result.context).toContain("Untrusted document excerpt: pricing.pdf · page 3");
    expect(result.context).toContain("$19 monthly");
    expect(result.context).not.toContain("$999");
    expect(result.context).not.toContain("$888");
  });
});

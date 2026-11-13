import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";

import {
  DOCUMENT_PARSER_VERSION,
  processDocumentContent,
  type DocumentRecord,
} from "@/lib/document-processing";
import { getDocumentBucket, getObjectStorageClient } from "@/lib/object-storage";
import { db, ensureSchema } from "@/lib/db";

const MAX_ATTEMPTS = 3;
const LEASE_MINUTES = 5;
const POLL_INTERVAL_MS = 3000;

function safeFailureMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : "Document processing failed.";
  // Avoid writing source text or provider response bodies into document metadata.
  return raw.replace(/[\r\n\0]+/g, " ").trim().slice(0, 300) || "Document processing failed.";
}

async function loadDocument(documentId: string, userId?: string) {
  const args: (string | number)[] = [documentId];
  const ownerCondition = userId ? " AND user_id = ?" : "";
  if (userId) args.push(userId);
  const result = await db.execute({
    sql: `SELECT id, user_id, conversation_id, object_key, filename, mime_type, size_bytes, attempt_count
          FROM documents WHERE id = ?${ownerCondition}`,
    args,
  });
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    attemptCount: Number(row.attempt_count),
  } satisfies DocumentRecord;
}

async function claimDocument(documentId: string) {
  const result = await db.execute({
    sql: `UPDATE documents
          SET status = 'processing', attempt_count = attempt_count + 1,
              lease_until = strftime('%Y-%m-%d %H:%M:%S', 'now', '+${LEASE_MINUTES} minutes'),
              error_message = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND attempt_count < ?
            AND (status = 'queued' OR (status = 'processing' AND lease_until < CURRENT_TIMESTAMP))`,
    args: [documentId, MAX_ATTEMPTS],
  });
  return result.rowsAffected === 1;
}

async function readObject(objectKey: string) {
  const result = await getObjectStorageClient().send(new GetObjectCommand({ Bucket: getDocumentBucket(), Key: objectKey }));
  if (!result.Body) throw new Error("The stored document could not be read from private storage.");
  return new Uint8Array(await result.Body.transformToByteArray());
}

async function persistProcessed(document: DocumentRecord, bytes: Uint8Array, processed: Awaited<ReturnType<typeof processDocumentContent>>) {
  const transaction = await db.transaction("write");
  try {
    await transaction.execute({
      sql: "DELETE FROM document_chunks WHERE document_id = ? AND user_id = ?",
      args: [document.id, document.userId],
    });
    for (const chunk of processed.chunks) {
      await transaction.execute({
        sql: `INSERT INTO document_chunks
              (id, document_id, user_id, chunk_index, content, page_number, section_heading,
               content_hash, embedding_json, embedding_model)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [chunk.id, document.id, document.userId, chunk.chunkIndex, chunk.text, chunk.pageNumber ?? null,
          chunk.sectionHeading ?? null, chunk.contentHash, JSON.stringify(chunk.embedding), processed.embeddingModel],
      });
    }
    await transaction.execute({
      sql: `UPDATE documents SET status = 'completed', content_sha256 = ?, parser_version = ?,
              embedding_model = ?, lease_until = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND status = 'processing'`,
      args: [processed.contentSha256, DOCUMENT_PARSER_VERSION, processed.embeddingModel, document.id, document.userId],
    });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  // Keep the argument explicit to make it clear bytes are validated before persistence.
  void bytes;
}

async function markFailedOrRetry(document: DocumentRecord, error: unknown) {
  const message = safeFailureMessage(error);
  const finalAttempt = document.attemptCount >= MAX_ATTEMPTS;
  await db.execute({
    sql: `UPDATE documents SET status = ?, lease_until = NULL, error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND status = 'processing'`,
    args: [finalAttempt ? "failed" : "queued", message, document.id, document.userId],
  });
}

export async function processNextQueuedDocument() {
  await ensureSchema();
  await db.execute({
    sql: `UPDATE documents SET status = 'failed', lease_until = NULL,
            error_message = COALESCE(error_message, 'Processing lease expired after the retry limit.'),
            updated_at = CURRENT_TIMESTAMP
          WHERE status = 'processing' AND lease_until < CURRENT_TIMESTAMP AND attempt_count >= ?`,
    args: [MAX_ATTEMPTS],
  });
  const candidates = await db.execute({
    sql: `SELECT id FROM documents WHERE attempt_count < ?
            AND (status = 'queued' OR (status = 'processing' AND lease_until < CURRENT_TIMESTAMP))
          ORDER BY created_at ASC LIMIT 10`,
    args: [MAX_ATTEMPTS],
  });
  for (const row of candidates.rows) {
    const documentId = String(row.id);
    if (!(await claimDocument(documentId))) continue;
    const document = await loadDocument(documentId);
    if (!document) return true;
    try {
      const bytes = await readObject(document.objectKey);
      const contentSha256 = createHash("sha256").update(bytes).digest("hex");
      const reusable = await db.execute({
        sql: `SELECT id FROM documents WHERE user_id = ? AND content_sha256 = ? AND parser_version = ?
              AND embedding_model = ? AND status = 'completed' LIMIT 1`,
        args: [document.userId, contentSha256, DOCUMENT_PARSER_VERSION, process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001"],
      });
      if (reusable.rows[0]) {
        const sourceChunks = await db.execute({
          sql: "SELECT chunk_index, content, page_number, section_heading, content_hash, embedding_json, embedding_model FROM document_chunks WHERE document_id = ? AND user_id = ? ORDER BY chunk_index",
          args: [String(reusable.rows[0].id), document.userId],
        });
        const transaction = await db.transaction("write");
        try {
          for (const chunk of sourceChunks.rows) await transaction.execute({
            sql: `INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, page_number, section_heading, content_hash, embedding_json, embedding_model)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [randomUUID(), document.id, document.userId, Number(chunk.chunk_index), String(chunk.content), chunk.page_number ?? null, chunk.section_heading ?? null, String(chunk.content_hash), chunk.embedding_json ?? null, chunk.embedding_model ?? null],
          });
          await transaction.execute({ sql: "UPDATE documents SET status='completed', content_sha256=?, parser_version=?, embedding_model=?, lease_until=NULL, error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='processing'", args: [contentSha256, DOCUMENT_PARSER_VERSION, process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001", document.id, document.userId] });
          await transaction.commit();
        } catch (error) { await transaction.rollback(); throw error; }
        return true;
      }
      const processed = await processDocumentContent({ document, bytes });
      await persistProcessed(document, bytes, processed);
    } catch (error) {
      await markFailedOrRetry(document, error);
      console.error(`[Minimi] Document processing ${document.id} ${document.attemptCount >= MAX_ATTEMPTS ? "failed" : "will retry"}: ${safeFailureMessage(error)}`);
    }
    return true;
  }
  return false;
}

export async function runDocumentWorker(options: { signal?: AbortSignal; pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? POLL_INTERVAL_MS);
  await ensureSchema();
  while (!options.signal?.aborted) {
    try {
      const processed = await processNextQueuedDocument();
      if (processed) continue;
    } catch (error) {
      console.error(`[Minimi] Document worker cycle failed: ${safeFailureMessage(error)}`);
    }
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) return resolve();
      const timeout = setTimeout(resolve, pollIntervalMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }
}

// Local demonstration entry point: `bun run src/lib/document-worker.ts`.
const invokedPath = process.argv[1]?.replaceAll("\\", "/");
if (invokedPath?.endsWith("/src/lib/document-worker.ts")) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void runDocumentWorker({ signal: controller.signal }).finally(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void db.close();
  });
}

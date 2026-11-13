import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { db, ensureSchema } from "@/lib/db";
import { getDocumentBucket, getObjectStorageClient, getPresignedUrlTtlSeconds } from "@/lib/object-storage";

const MAX_BYTES = Math.min(Number(process.env.MINIMI_DOCUMENT_MAX_BYTES) || 25 * 1024 * 1024, 25 * 1024 * 1024);
const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/plain": ".txt",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
const IntentSchema = z.object({
  conversationId: z.string().min(1).max(100),
  filename: z.string().min(1).max(240),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
});

function clerkConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

export async function GET(request: Request) {
  if (!clerkConfigured()) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to view documents." }, { status: 401 });
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) return Response.json({ error: "Conversation ID is required." }, { status: 400 });
  await ensureSchema();
  const result = await db.execute({
    sql: "SELECT id, filename, mime_type, size_bytes, status, error_message, created_at FROM documents WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC",
    args: [userId, conversationId],
  });
  return Response.json({ documents: result.rows });
}

export async function POST(request: Request) {
  if (!clerkConfigured()) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to upload documents." }, { status: 401 });
  const parsed = IntentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid upload details." }, { status: 400 });
  const input = parsed.data;
  const mimeType = input.mimeType.toLowerCase();
  const extension = EXTENSIONS[mimeType];
  const filename = input.filename.replace(/[/\\\0-\x1f]/g, "_").trim();
  if (!extension || !filename.toLowerCase().endsWith(extension) || input.sizeBytes > MAX_BYTES) {
    return Response.json({ error: "Unsupported file type, extension, or size." }, { status: 415 });
  }
  try {
    await ensureSchema();
    await db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: [userId] });
    await db.execute({ sql: "INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)", args: [input.conversationId, userId] });
    const conversation = await db.execute({ sql: "SELECT user_id FROM conversations WHERE id = ?", args: [input.conversationId] });
    if (String(conversation.rows[0]?.user_id) !== userId) return Response.json({ error: "Conversation not found." }, { status: 404 });

    const id = randomUUID();
    const objectKey = `documents/${randomUUID()}`;
    const bucket = getDocumentBucket();
    const command = new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: mimeType, Metadata: { "document-id": id } });
    const uploadUrl = await getSignedUrl(getObjectStorageClient(), command, { expiresIn: getPresignedUrlTtlSeconds() });
    await db.execute({
      sql: "INSERT INTO documents (id, user_id, conversation_id, object_key, filename, mime_type, size_bytes, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded')",
      args: [id, userId, input.conversationId, objectKey, filename, mimeType, input.sizeBytes],
    });
    return Response.json({ id, uploadUrl, expiresIn: getPresignedUrlTtlSeconds() }, { status: 201 });
  } catch (error) {
    console.error("[Minimi] Document upload intent failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "Document upload is not configured or could not be started." }, { status: 503 });
  }
}

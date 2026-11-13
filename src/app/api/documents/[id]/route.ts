import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { auth } from "@clerk/nextjs/server";
import { randomUUID } from "node:crypto";

import { db, ensureSchema } from "@/lib/db";
import { getDocumentBucket, getObjectStorageClient } from "@/lib/object-storage";

const REMOVAL_MARKER_PREFIX = "__minimi_removing__:";

export async function DELETE(_request: Request, context: RouteContext<"/api/documents/[id]">) {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  }
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to remove this file." }, { status: 401 });

  const { id } = await context.params;
  await ensureSchema();
  const result = await db.execute({
    sql: "SELECT object_key, status, error_message FROM documents WHERE id = ? AND user_id = ?",
    args: [id, userId],
  });
  const document = result.rows[0];
  if (!document) return Response.json({ error: "File not found." }, { status: 404 });

  const status = String(document.status);
  if (status === "processing") {
    return Response.json({ error: "Wait for file processing to finish before removing it." }, { status: 409 });
  }
  const previousError = document.error_message == null ? null : String(document.error_message);
  const marker = `${REMOVAL_MARKER_PREFIX}${randomUUID()}`;
  const locked = await db.execute({
    sql: "UPDATE documents SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = ? AND error_message IS ?",
    args: [marker, id, userId, status, previousError],
  });
  if (!locked.rowsAffected) return Response.json({ error: "The file state changed. Refresh and try again." }, { status: 409 });

  try {
    await getObjectStorageClient().send(new DeleteObjectCommand({ Bucket: getDocumentBucket(), Key: String(document.object_key) }));
  } catch (error) {
    await db.execute({
      sql: "UPDATE documents SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'failed' AND error_message = ?",
      args: [status, previousError, id, userId, marker],
    });
    console.error("[Minimi] File removal from storage failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "The file could not be removed from storage." }, { status: 502 });
  }

  const transaction = await db.transaction("write");
  try {
    await transaction.execute({ sql: "DELETE FROM document_chunks WHERE document_id = ? AND user_id = ?", args: [id, userId] });
    const deleted = await transaction.execute({
      sql: "DELETE FROM documents WHERE id = ? AND user_id = ? AND status = 'failed' AND error_message = ?",
      args: [id, userId, marker],
    });
    if (!deleted.rowsAffected) throw new Error("File state changed during removal.");
    await transaction.commit();
    return Response.json({ deleted: true });
  } catch (error) {
    await transaction.rollback();
    console.error("[Minimi] File removal from database failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "The file was removed from storage, but its record could not be cleared. Try removing it again." }, { status: 500 });
  }
}

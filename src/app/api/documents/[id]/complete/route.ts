import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { auth } from "@clerk/nextjs/server";
import { db, ensureSchema } from "@/lib/db";
import { getDocumentBucket, getObjectStorageClient } from "@/lib/object-storage";

export async function POST(_request: Request, context: RouteContext<"/api/documents/[id]/complete">) {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to complete this upload." }, { status: 401 });
  const { id } = await context.params;
  await ensureSchema();
  const result = await db.execute({ sql: "SELECT object_key, size_bytes, status FROM documents WHERE id = ? AND user_id = ?", args: [id, userId] });
  const document = result.rows[0];
  if (!document) return Response.json({ error: "Document not found." }, { status: 404 });
  if (String(document.status) !== "uploaded") return Response.json({ status: String(document.status) });
  try {
    const head = await getObjectStorageClient().send(new HeadObjectCommand({ Bucket: getDocumentBucket(), Key: String(document.object_key) }));
    if (head.ContentLength !== Number(document.size_bytes)) return Response.json({ error: "Uploaded file size did not match the declared size." }, { status: 400 });
    await db.execute({ sql: "UPDATE documents SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'uploaded'", args: [id, userId] });
    return Response.json({ status: "queued" }, { status: 202 });
  } catch (error) {
    console.error("[Minimi] Document verification failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "Uploaded object could not be verified." }, { status: 400 });
  }
}

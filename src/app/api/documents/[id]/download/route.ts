import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { auth } from "@clerk/nextjs/server";
import { db, ensureSchema } from "@/lib/db";
import { getDocumentBucket, getObjectStorageClient, getPresignedUrlTtlSeconds } from "@/lib/object-storage";

export async function GET(_request: Request, context: RouteContext<"/api/documents/[id]/download">) {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to download this document." }, { status: 401 });
  const { id } = await context.params;
  await ensureSchema();
  const result = await db.execute({ sql: "SELECT object_key, filename, mime_type FROM documents WHERE id = ? AND user_id = ?", args: [id, userId] });
  const document = result.rows[0];
  if (!document) return Response.json({ error: "Document not found." }, { status: 404 });
  const command = new GetObjectCommand({ Bucket: getDocumentBucket(), Key: String(document.object_key), ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(String(document.filename))}`, ResponseContentType: String(document.mime_type) });
  const url = await getSignedUrl(getObjectStorageClient(), command, { expiresIn: getPresignedUrlTtlSeconds() });
  return Response.json({ url, expiresIn: getPresignedUrlTtlSeconds() }, { headers: { "Cache-Control": "no-store" } });
}

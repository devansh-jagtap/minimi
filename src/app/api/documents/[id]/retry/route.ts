import { auth } from "@clerk/nextjs/server";
import { db, ensureSchema } from "@/lib/db";

export async function POST(_request: Request, context: RouteContext<"/api/documents/[id]/retry">) {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in to retry this document." }, { status: 401 });
  const { id } = await context.params;
  await ensureSchema();
  const result = await db.execute({
    sql: "UPDATE documents SET status='queued', attempt_count=0, lease_until=NULL, error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='failed'",
    args: [id, userId],
  });
  return result.rowsAffected ? Response.json({ status: "queued" }, { status: 202 }) : Response.json({ error: "Failed document not found." }, { status: 404 });
}

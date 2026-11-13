import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { claimLegacyConversations } from "@/lib/db";

const ClaimSchema = z.object({ conversationIds: z.array(z.string().min(1).max(100)).max(100) });

export async function POST(request: Request) {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "Sign in to import your saved research." }, { status: 401 });
    const parsed = ClaimSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Invalid conversation import request." }, { status: 400 });
    const claimed = await claimLegacyConversations(userId, parsed.data.conversationIds);
    return Response.json({ claimedCount: claimed.length });
  } catch {
    return Response.json({ error: "Unable to import saved research." }, { status: 500 });
  }
}

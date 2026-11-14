# Minimi

Minimi is a persistent web research assistant built with Next.js App Router, TypeScript, Bun, Vercel AI SDK, Google Gemini, Tavily, LibSQL, and Zod. It stores prior research as evidence-linked observations and can compare those observations with current search results.

See the [system architecture diagram](./docs/architecture.md) for the chat, web research, memory, and document processing flows.

## Setup

1. Copy `.env.example` to `.env.local` and provide your Google AI and Tavily keys.
2. Open the selected Clerk application (`app_3M1cyqyRyVegjHarhz8IBomUHvO`) in the Clerk Dashboard and go to **API Keys**. Copy its development Publishable Key and Secret Key into `.env.local`:

   ```env
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```

   Keep `CLERK_SECRET_KEY` private and out of Git. The app requires both keys before it serves the workspace. On this Windows setup, the Clerk CLI binary is blocked by Application Control, so use the Dashboard instead of `bunx clerk`.
3. Install dependencies with `bun install`.
4. Start the app with `bun run dev` and open [http://localhost:3000](http://localhost:3000). Sign in or create an account to use Minimi.

The first account that signs in on a browser can import its saved pre-auth chats. Those chats are moved to that account's storage namespace and matching local database records are claimed once. Each account gets a separate conversation namespace and server-side owner scope.

Useful commands:

```sh
bun run dev
bun run test
bun run lint
bun run build
bun run start
```

## Document uploads

Copy the R2 variables from `.env.example` into the server's local environment and create a private R2 bucket plus a bucket-scoped S3 API token with object read/write access. Set bucket CORS to the exact Minimi app origin and permit `PUT` with `Content-Type`. Never commit or paste `R2_SECRET_ACCESS_KEY` into chat.

`bun run dev` starts both Next.js and the local document worker, so uploads begin processing automatically. The worker reads queued files from R2, extracts text, creates page/section-aware chunks and embeddings, and makes them searchable across chats for the owning user only. The upload limit is 25 MiB; supported types are PDF, DOCX, TXT, PNG, JPEG, and WebP. Remove a file from the composer before sending to delete it from storage and indexing. If you run `bun run dev:web` by itself, start the worker separately with `bun run worker`.

The production build uses Next.js webpack mode. The document worker is a separate local process; deploy it as a long-running worker alongside the web app when hosting document processing.

## Memory lifecycle

- Chat messages continue to be saved in `conversations` and `messages`.
- Before answering, the app searches research sessions and conversation messages across the authenticated user's conversations, then filters the results by topic, entities, and explicit dates.
- The model has one callable tool, `webSearch`. Search hits are retained by application code with their URL, published date, and retrieval time.
- A direct memory question passes a concise, relevant historical summary and structured observations to Gemini, which writes a new answer instead of replaying a saved transcript. A “has this changed?” question uses that history as a private baseline, runs fresh Tavily searches, and asks Gemini to compare the evidence.
- After a response that used search, a bounded extraction call proposes structured facts. Zod validates the shape, and the app stores only facts whose URL is one of the returned hits and whose supporting excerpt occurs verbatim in that hit.
- Observations are appended with their own observation time. Entity names and source URLs are deduplicated; historical values and source metadata remain available.
- For historical comparisons, prior facts and citations are supplied as untrusted evidence. Gemini searches for current evidence and labels each requested comparison `Changed`, `Unchanged`, or `Unable to verify`. Missing or incomparable historical evidence is not filled in from model knowledge.

The schema is created additively and idempotently on first database use. Existing conversation data is left in place. See [DESIGN.md](./DESIGN.md) for the schema, matching rules, temporal fields, and limitations.

## Tests

`bun run test` uses a temporary LibSQL database and deterministic fixtures. CRM shortlist, date recall, and Postgres-hosting cases are fixtures; they do not claim that current vendor prices or product changes were checked live. Live research requires configured Google AI and Tavily credentials. Account-based chat and memory require configured Clerk keys.

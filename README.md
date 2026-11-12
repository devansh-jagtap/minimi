# Minimi

Minimi is a persistent web research assistant built with Next.js App Router, TypeScript, Bun, Vercel AI SDK, Google Gemini, Tavily, LibSQL, and Zod. It stores prior research as evidence-linked observations and can compare those observations with current search results.

## Setup

1. Copy `.env.example` to `.env.local` and provide your Google AI and Tavily keys.
2. Install dependencies with `bun install`.
3. Start the app with `bun run dev` and open [http://localhost:3000](http://localhost:3000).

Useful commands:

```sh
bun run dev
bun run test
bun run lint
bun run build
bun run start
```

The build script uses Next.js's webpack build mode because the default Turbopack build exits while starting its CSS worker in this environment. Here, webpack compilation and type checking succeed, but static page generation can still hit a Windows `EPERM` while writing parallel `.next` output under OneDrive. A clean local filesystem may avoid that workspace-specific build error.

## Memory lifecycle

- Chat messages continue to be saved in `conversations` and `messages`.
- Before answering, the app searches research sessions in the same conversation and selects exact entity, topic, or date matches.
- The model has one callable tool, `webSearch`. Search hits are retained by application code with their URL, published date, and retrieval time.
- After a response that used search, a bounded extraction call proposes structured facts. Zod validates the shape, and the app stores only facts whose URL is one of the returned hits and whose supporting excerpt occurs verbatim in that hit.
- Observations are appended with their own observation time. Entity names and source URLs are deduplicated; historical values and source metadata remain available.
- For historical comparisons, the prior facts and citations are supplied as untrusted evidence. The model searches current evidence and distinguishes confirmed change, no change found in comparable evidence, and insufficient evidence.

The schema is created additively and idempotently on first database use. Existing conversation data is left in place. See [DESIGN.md](./DESIGN.md) for the schema, matching rules, temporal fields, and limitations.

## Tests

`bun run test` uses a temporary LibSQL database and deterministic fixtures. CRM shortlist, date recall, and Postgres-hosting cases are fixtures; they do not claim that current vendor prices or product changes were checked live. Live research requires configured Google AI and Tavily credentials.

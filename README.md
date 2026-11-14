# Minimi

Minimi is a persistent, time-aware AI research assistant. It combines authenticated conversations, cross-chat memory, evidence-linked web research, historical-versus-current comparison, and private document retrieval.

## What it does

- **Research:** searches the web through Tavily and returns answers with source links. The model has exactly one callable tool: `webSearch`.
- **Persistent memory:** saves conversations and structured research observations, then retrieves relevant information across the signed-in user's conversations.
- **Time-aware comparison:** uses saved observations as the historical baseline, searches for current evidence, and labels each comparison `Changed`, `Unchanged`, or `Unable to verify`.
- **Document RAG:** accepts PDF, DOCX, TXT, PNG, JPEG, and WebP files; extracts content, creates chunks and embeddings, and retrieves relevant excerpts across the same user's chats.
- **Private file storage:** stores original uploads in a private Cloudflare R2 bucket. LibSQL stores metadata, processing state, chunks, and serialized embeddings.

## Architecture

The request flow and component relationships are documented in [DESIGN.md](./DESIGN.md). The [architecture overview](./docs/architecture.md) includes a PNG diagram and a scalable SVG.

At a high level:

1. The browser sends chat requests to the Next.js API.
2. Clerk authenticates the request; the authenticated user ID scopes conversations, memory, research, and documents.
3. The API retrieves relevant history and document excerpts before invoking Gemini through the Vercel AI SDK.
4. When current information is needed, Gemini can call the single `webSearch` tool, which uses Tavily.
5. Search evidence is retained by the application and eligible facts are extracted into append-only research observations.
6. For uploads, the browser sends files directly to private R2 using short-lived signed URLs. A background worker extracts, chunks, embeds, and indexes the content in LibSQL.

## Tech stack

| Area | Technology |
| --- | --- |
| Web application | Next.js App Router, React, TypeScript |
| Runtime / package manager | Bun |
| Authentication | Clerk |
| Model and embeddings | Google Gemini via Vercel AI SDK |
| Web search | Tavily |
| Application database | LibSQL |
| Original document storage | Cloudflare R2 (S3-compatible API) |
| Document extraction | PDF.js, Mammoth, Gemini vision/OCR |
| Validation and tests | Zod, Vitest, ESLint |

## Local setup

### Prerequisites

- Bun installed.
- A Google AI API key.
- A Tavily API key for live web search.
- A Clerk application with development keys.
- A Cloudflare R2 bucket and S3 credentials only if you want to test document uploads.

### 1. Get the project and install dependencies

```bash
git clone https://github.com/devansh-jagtap/minimi.git
cd minimi
bun install
```

### 2. Configure environment variables

Copy the example file:

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux:

```bash
cp .env.example .env.local
```

Set the required values in `.env.local`:

| Variable | Required for | Description |
| --- | --- | --- |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Chat, extraction, embeddings | Google AI API key |
| `TAVILY_API_KEY` | Live web search | Tavily API key |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Authenticated workspace | Clerk development publishable key |
| `CLERK_SECRET_KEY` | Authenticated workspace | Clerk secret key |
| `DATABASE_URL` | Database | Defaults to `file:./data/minimi.db` |
| `GOOGLE_MODEL` | Chat generation | Defaults to `gemini-2.5-flash` |
| `GOOGLE_EMBEDDING_MODEL` | Document embeddings | Defaults to `gemini-embedding-001` |
| `R2_ACCOUNT_ID` | Document uploads | Cloudflare account ID |
| `R2_BUCKET_NAME` | Document uploads | Name of the private R2 bucket |
| `R2_ACCESS_KEY_ID` | Document uploads | Bucket-scoped S3 access key ID |
| `R2_SECRET_ACCESS_KEY` | Document uploads | Bucket-scoped S3 secret |
| `R2_PRESIGN_TTL_SECONDS` | Signed upload URLs | Defaults to `300` seconds |
| `MINIMI_DOCUMENT_MAX_BYTES` | Upload limit | Defaults to `26214400` (25 MiB) |

Keep `.env.local` private. Never commit API keys, Clerk secrets, or R2 credentials.

### 3. Configure Cloudflare R2 (document uploads only)

Create a **private** R2 bucket and a bucket-scoped S3 API token with object read/write access. Add the R2 variables to `.env.local`. Configure bucket CORS for the exact origin where Minimi runs and allow browser `PUT` requests with the `Content-Type` header.

Chat, memory, and web research can be run without R2. Document uploads require the R2 configuration and Google credentials for extraction and embeddings.

### 4. Start Minimi

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000), then sign in or create an account.

`bun run dev` starts the Next.js development server and the local document worker together. The database schema is initialized additively on first use.

## Useful commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start web app and document worker |
| `bun run dev:web` | Start only the Next.js web app |
| `bun run worker` | Start the document worker separately |
| `bun run test` | Run Vitest tests |
| `bun run lint` | Run ESLint |
| `bun run build` | Create the production build |
| `bun run start` | Start the production web server |

If you run `bun run dev:web` and need document processing, start `bun run worker` in a second terminal.

## Document lifecycle

The current upload limit is 25 MiB per file. Supported formats are PDF, DOCX, TXT, PNG, JPEG, and WebP. Uploads move through processing states; the composer prevents sending while selected files are still uploading or processing. The worker retries failed jobs up to three attempts. Completed files are available for same-owner retrieval across conversations. Removing a file or deleting its source conversation removes its stored object and indexed chunks.

For hosted deployments, run the Next.js application and the document worker as separate processes. The worker must remain running to process queued uploads.

## Memory and evidence behavior

Direct memory recall uses relevant saved history and structured observations to write a new answer; it does not replay the old transcript. A change-detection question uses historical observations as a baseline and performs fresh web search when enabled. Historical facts are append-only and retain observation dates and source URLs. If historical or current evidence is missing or incomparable, Minimi should report `Unable to verify` rather than infer a change.

## Tests and limitations

`bun run test` uses deterministic fixtures for recall, CRM research routing, and PostgreSQL-hosting scenarios. Those tests validate application behavior; they do not verify live vendor prices or current product changes. Live model/search tests require Google AI and Tavily credentials. Authentication tests and workspace use require Clerk keys. Document upload, OCR, and embedding checks require R2 and Google credentials.

See [DESIGN.md](./DESIGN.md) for architectural decisions, data ownership, retrieval behavior, security boundaries, and known limitations.

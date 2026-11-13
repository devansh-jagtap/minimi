# Minimi architecture and structured research memory

## Request flow

The Next.js App Router chat endpoint authenticates requests with Clerk. It accepts a message, optional conversation ID, browser time zone, stream mode, and web-search toggle. Conversation reads and writes are scoped to the Clerk user ID. The endpoint can retrieve global conversation memory and structured research evidence for that same authenticated user before it calls the Gemini model. The model has exactly one callable tool, `webSearch`, implemented with Tavily. Research-memory extraction runs after the answer and is an application-side Gemini structured-output call; it is not exposed as a model tool.

The route supports plain text and newline-delimited event streams. Search events and answer text are streamed to the client. The endpoint validates request bodies and returns bounded errors. History-recall requests are answered from saved user/assistant turns without invoking web search.

## Authentication and ownership

Clerk supplies the owner ID used in database operations. Conversation messages are read through a join to `conversations` with the matching `user_id`; writes verify the existing conversation owner. Research sessions and durable memory items have user ownership and are retrieved by the authenticated owner. Deletion checks ownership in a write transaction before removing a conversation and its dependent messages, memory, research sessions, and observations. Shared sources and entities are deleted only when no remaining observation references them.

The legacy claim endpoint allows a signed-in user to claim listed conversations whose owner is the configured local owner or `local-single-user`. This is a migration path for a single-user local installation, not proof of which account originally created a legacy conversation; the client must only offer records the user intends to import. The ownership tests cover route-level data helpers and transaction behavior, but do not establish identity for ambiguous legacy records.

## Database and migrations

The database is LibSQL. `ensureSchema()` creates tables and indexes with `CREATE ... IF NOT EXISTS`, then adds missing owner and comparison columns with `ALTER TABLE`. This is an idempotent additive migration path, not a version-numbered migration framework. Foreign-key checks are enabled on the application connection. A process-local write queue serializes writes made through one module instance; database write transactions provide the transaction boundaries. The process-local queue does not coordinate separate server processes.

| Table | Purpose and ownership |
| --- | --- |
| `conversations` | Conversation ID, `user_id`, creation time. |
| `messages` | User and assistant turns linked to a conversation; ownership is enforced by joining through `conversations`. |
| `local_users` | Local user-ID records referenced by durable memory rows. Clerk IDs are stored here as needed. |
| `memory_items` | Durable cross-conversation memories, scoped by `user_id`, with source conversation reference and deduplication by owner, source conversation, and normalized summary. |
| `research_sessions` | Research question, answer summary, retrieval time, conversation ID, and `user_id`. |
| `entities` | Case-normalized entity identity shared across evidence rows; it has no owner column. |
| `sources` | URL and first-seen title/publisher/publication metadata, plus latest retrieval time; it has no owner column. |
| `observations` | Historical evidence value, entity/source/session links, observation/effective dates, and optional comparison dimensions. |
| `documents` | Owner- and conversation-scoped file metadata, opaque storage key, processing status, retry count, and content/parser/embedding versions. |
| `document_chunks` | Owner-scoped extracted chunks, page/heading metadata, hashes, and versioned embedding JSON. |

`observations` preserves old rows: new research inserts a new observation rather than replacing a previous value. Comparison metadata is stored in nullable columns `plan_tier`, `currency`, `billing_interval`, `price_basis`, and `region`. Existing rows receive `NULL` for those fields, so they cannot support a confirmed price change under the comparison rules. Entity/source rows are shared and unowned; user isolation depends on first selecting owner-scoped research sessions and fetching observations only for those session IDs. The low-level observation/source helper functions do not independently require an owner parameter, so callers must retain that ordering constraint.

## Cross-conversation memory

Chat messages and durable memory are retrieved across conversations for the authenticated user. Message search uses bounded lexical matching over recent user-owned messages; date filters are applied to message timestamps. Durable memory retrieval uses a bounded set of query terms against memory summaries and content. This is not embedding-based semantic retrieval, and exact wording or short/ambiguous prompts can miss relevant history. Retrieved memory is supplied as context to Gemini; it is not itself a separate model tool.

Historical recall pairs a matching user turn with the next assistant turn in that conversation, excludes known fallback answers, and returns a bounded number of matches. Explicit dates and weekday references use the request's IANA time-zone value sent by the browser. If the field is missing or invalid, the route uses UTC. Database timestamps without an explicit offset are interpreted as UTC. Date queries are converted to local-day UTC start/end boundaries, then checked again against the requested local calendar date. An unqualified weekday resolves to its most recent occurrence (or the prior week when today has that weekday); `last` and `previous` resolve strictly before the current local date. This is browser time-zone behavior, not a saved account preference.

## Structured research retrieval and comparison

Successful Tavily search results are retained in application code while Gemini generates an answer. A separate structured extraction call receives bounded search snippets and can return up to twelve observations from up to ten hits. Each saved observation must point to an exact supplied URL and include a verbatim quote found in that hit. The application deterministically checks extracted numeric values, recognized currency, common price units, and supported explicit effective dates where possible. It rejects mismatched amounts, currencies, units, and unsupported dates. This validation cannot prove arbitrary natural-language claims, source authority, or that a search snippet is complete; non-numeric values must match the quoted text after normalization.

Research retrieval is global across conversations for one authenticated owner. It scores at most fifty owner-scoped sessions using entity mentions, topic/summary token overlap, and date matches; it returns up to five sessions and at most eight observations per session. Only those selected owner-scoped session IDs are used to load observations. Historical facts include their observation time and source citation.

Price comparisons require matching entity and attribute plus non-empty matching plan tier, currency, billing interval, price basis, and region. The values must contain one parseable amount and use the same recognized currency. A difference under those conditions is classified as a confirmed change; equal normalized values are “no change found in available evidence.” Missing or mismatched dimensions, missing evidence, ambiguous amounts, or unsupported attributes return “insufficient evidence.” Non-price comparisons still rely on exact normalized entity/attribute matching and normalized value equality; arbitrary semantic equivalence is not inferred.

## Document retrieval

Uploads use authenticated upload intents and short-lived R2 presigned PUT URLs. The server generates opaque object keys, checks conversation ownership, verifies uploaded object size with HEAD, and changes the document to `queued`. Downloads use an owner-checked route that returns a short-lived signed URL. The bucket must remain private and be configured with the application origin in CORS.

Run `bun run worker` to process queued files locally. The worker leases jobs, retries up to three times, marks processing failures visibly, extracts page-aware PDF text, DOCX headings/paragraphs/lists/tables, TXT blocks, or image text via Gemini vision, then creates structure-aware overlapping chunks and Gemini embeddings. Scanned PDF pages with little selectable text are rendered and passed through Gemini vision OCR. Retrieval is performed before the model call and limited to the authenticated user's current conversation. It ranks at most 1,000 candidate chunks using cosine similarity and lexical overlap, then supplies at most six bounded excerpts with filename/page/section citation labels. Document text is explicitly untrusted, and `webSearch` remains the sole model-callable tool.

## Time fields

- `sources.published_at` is the publication date reported by Tavily when available.
- `sources.retrieved_at` records the latest retrieval time for a URL.
- `observations.observed_at` records when that value was captured and is preserved with the historical row.
- `observations.valid_from` is set only when an effective date is explicitly supported by the evidence quote.
- `research_sessions.researched_at` is the retrieval time represented by the session.
- Conversation and message `created_at` values are LibSQL timestamp strings and are treated as UTC by historical recall.

## Local database artifact

`data/minimi.db` is currently tracked by Git and should be removed from repository tracking while remaining intact on the developer's machine. It should not be committed or copied into fixtures because it contains mixed development records and may include private conversations. The inspected local database contained 12 conversations, 39 messages, 2 research sessions, and 10 observations. Counts and date ranges were used for inspection; message text was not printed. Six conversation IDs and three messages contained test-like markers, so this database cannot be classified as purely test data or empty. Keep the local file intact, and use synthetic fixtures in tests.

## Limitations

- Vector retrieval currently scans at most 1,000 conversation-scoped chunk rows and computes cosine similarity in application code. It does not depend on remote LibSQL vector indexes or add a vector database.
- Memory and research matching are deterministic lexical/date retrieval, so paraphrases and ambiguous references can be missed.
- Evidence validation checks only supplied search snippets and cannot independently verify all natural-language claims or source credibility.
- Price comparisons are intentionally conservative; old observations or current sources missing any required comparison dimension return insufficient evidence.
- “No change found” means no change was found in the retrieved comparable evidence, not that no change exists elsewhere.
- CRM, historical recall, and Postgres-hosting regression scenarios use static fixtures. They test application behavior, not current vendor pricing or live announcements.
- Legacy conversation claiming cannot determine the rightful owner of shared pre-auth data. Deployments should avoid importing ambiguous records across accounts.
- The database uses additive inline schema setup, not a managed migration history. The write queue is process-local.
- R2 upload, download, OCR/vision, and live embedding smoke checks require local credentials and a configured private bucket; these have not been run without those credentials.

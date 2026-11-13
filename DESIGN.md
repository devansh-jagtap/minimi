# Structured research memory design

## Existing request flow

The App Router chat endpoint validates the incoming message, saves it, reads up to 15 recent messages, and calls `streamText`. The agent uses the configured Google Gemini model and exposes exactly one model-callable tool: `webSearch`. That tool sends up to three focused queries per invocation to Tavily, with up to five results per query. Text is streamed with the AI SDK response helper. Errors are logged; request validation returns HTTP 400 and other setup errors return HTTP 500.

The database module creates the existing `conversations` and `messages` tables without replacing them. Schema setup uses additive `CREATE TABLE/INDEX IF NOT EXISTS` statements and is safe to repeat. A process-local write queue serializes application writes; observation batches use a LibSQL write transaction. Entity names are case-insensitively deduplicated, and sources are deduplicated by URL.

## Tables

| Table | Purpose | Important relationships |
| --- | --- | --- |
| `research_sessions` | A research answer tied to a conversation, topic, summary, and retrieval time | `conversation_id` references `conversations.id` |
| `entities` | Normalized company, product, technology, or other entity identity | `normalized_name` is unique |
| `sources` | Source URL and first-seen metadata, plus latest retrieval time | URL is unique |
| `observations` | An evidence-backed attribute/value at a particular observation time | References its session, entity, and source |

Indexes cover session lookup by conversation and topic, observation lookup by entity/attribute and session, and entity display names. Foreign keys are enabled on the database connection. SQL values are parameterized; only placeholder counts and fixed field names are assembled dynamically.

An observation is never updated in place when a new value is found. New values produce new observation rows. Source title, publisher, and published date stay as first-seen metadata for that URL; `sources.retrieved_at` advances to the latest retrieval. The observation's own `observed_at` preserves when that specific value was captured and is used as the historical retrieval time in comparison context.

## Extraction and evidence rules

Search hits are captured in application code while the model uses `webSearch`. After generation, `generateObject` requests at most 12 structured facts from up to ten hits, with bounded excerpt and answer sizes. It is skipped when the request has no successful search result. Each extracted fact must carry an exact source URL and a verbatim evidence excerpt. The application rejects malformed output, unknown URLs, non-matching excerpts, and unsupported `validFrom` values before database writes. This checks support against Tavily's returned content snippet, not the full source page.

Fields have distinct meanings:

- `sources.published_at`: publication date reported by the source/search response.
- `sources.retrieved_at`: latest time Minimi retrieved that source URL.
- `observations.observed_at`: time Minimi recorded that specific value; historical rows retain it.
- `observations.valid_from`: effective date only when the source excerpt explicitly supports it.
- `research_sessions.researched_at`: latest retrieval time represented by the research session.

Observation and session times use ISO 8601 UTC timestamps. Minimi does not infer an effective date from the date it found a fact.

## Historical retrieval and comparison

Retrieval is conversation-scoped and exact/lexical; it does not require vector search. The app scores up to 50 sessions from the current conversation using entity-name mentions and topic/summary token overlap, includes explicit date or recent-weekday matches, and selects at most five sessions. At most eight observations per selected session are passed to the model. Recent user messages can help resolve references such as “those tools”; the current message alone determines date matching.

When prior evidence is available, the agent receives its values, observation dates, and citations as untrusted data. It must use `webSearch` for current evidence, prefer official pricing, documentation, and release sources, and compare like-for-like entities and attributes. It should label a result as a confirmed change only when comparable evidence supports the difference; equal values can support “no change found in available evidence”; missing historical or current evidence requires “insufficient evidence.” A failed search is returned as a bounded tool result and must not be described as proof of no change.

## Operational measurements

Server logs include historical retrieval latency, Tavily query count and latency, successful result count, extraction latency, chat model-step count, whether extraction was attempted, total request latency, and the number of supported observations saved. No benchmark values are asserted; these measurements need production traffic before performance claims can be made.

## Limitations

- Research memory is scoped to the supplied conversation ID. The current app has no user identity layer or cross-conversation account boundary.
- Entity/topic/date matching is deterministic lexical matching. Ambiguous references, unusual date formats, or a conversation outside the recent message window may not resolve correctly.
- Relative weekday resolution uses the server's UTC calendar because the app has no user-timezone setting.
- Evidence validation checks a verbatim excerpt in Tavily's snippet. It does not independently fetch the full page or guarantee that a source is authoritative; the model is instructed to prefer official sources.
- “No change found” describes the evidence Minimi could compare. It is not a guarantee that no unindexed announcement or change exists.
- The CRM, 3 November recall, and Postgres-hosting test cases use fixtures. They verify persistence and comparison behavior, not current vendor pricing or live releases.

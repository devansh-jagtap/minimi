# Document and image RAG architecture

## Approved shape

Keep the existing Next.js App Router, Clerk, LibSQL, Gemini, Tavily, and the one model-callable tool `webSearch`. RAG retrieval runs in the authenticated server-side chat request before the existing agent call. It is never exposed as another tool.

Original files live in a private Cloudflare R2 bucket. The browser receives only short-lived presigned `PUT` or `GET` URLs for opaque object keys. The server creates keys and metadata; clients never choose storage keys. Every create, complete, list, retrieve, download, and delete operation checks Clerk ownership. A conversation association is checked against its owner before a file can be attached.

LibSQL remains the metadata and job database. Add additive tables for files, processing attempts/status, document chunks, and embeddings; each row carries an owner ID or is reached only through an owner-filtered file/session join. Retrieval filters by authenticated owner before any chunk text enters model context and can find completed files across that owner's conversations. The current conversation's files receive ranking priority. Other users' file metadata and chunks must never enter retrieval results.

## Upload and processing lifecycle

Authenticated upload intent validates a small application-level size limit (initial target 25 MiB), allowed extension and declared MIME, creates an opaque object key, and returns a short-lived signed PUT URL. Completion checks ownership and pending status, performs a server-side HEAD, checks actual size and signed checksum metadata, then queues processing. The browser does not supply a storage key or mark a document complete.

Statuses are `uploaded`, `queued`, `processing`, `completed`, and `failed`. A local `bun run worker` polls LibSQL and uses a conditional status/lease update so duplicate workers cannot claim one job. Retries are bounded and idempotent on file hash, parser version, and embedding model version. Errors are stored in bounded non-sensitive form. Shutdown stops new claims and lets the current file finish. No Redis, Kafka, or new agent is planned.

## Extraction and retrieval

- PDF: extract text per page with `pdfjs-dist`; preserve page numbers. If a page has no text, route it to an explicit OCR/vision fallback. Empty extraction and failed OCR become `failed`, never successful empty documents.
- DOCX: parse with Mammoth and retain headings, paragraphs, lists, and tables as structured blocks with section labels.
- TXT: decode within size limits and retain paragraph boundaries.
- PNG, JPEG, WebP: use the existing Gemini provider for bounded multimodal extraction; cite the image filename. Provider calls remain application-side and are not model tools.
- Chunk along headings, paragraphs, and page boundaries, targeting 500–800 tokens with 80–120 overlap. Store filename, page/section, chunk index, owner, file hash, parser version, and embedding model/version.

Use the existing Gemini embedding provider and LibSQL only. Local in-memory probing confirms the installed LibSQL client can run vector functions/indexes and SQLite FTS5, but this does not prove the configured remote database has those capabilities. First use capability probing against the actual configured database. Until remote vector support is confirmed, keep retrieval portable: store versioned vectors and compute cosine similarity over owner-scoped chunks for the local demonstration, alongside FTS5 only when that capability probe succeeds. Do not add a vector database without evidence that the configured LibSQL deployment cannot support the required workload.

Retrieve a bounded candidate set, apply owner filters in SQL before returning text, combine semantic and keyword candidates when available, deduplicate, apply a relevance threshold, and cap prompt context. Present retrieved excerpts as untrusted quoted evidence. Instruct Gemini to ignore embedded document instructions, cite filename plus page/heading, identify when a file came from another chat, and say when the excerpts do not support an answer. Removing a pending file or deleting its source conversation also removes its object and chunks, making that file unavailable across chats.

## Deterministic acceptance fixtures

Use synthetic fixtures and mocked storage/embedding/OCR for unit tests. Cover PDF page citations; DOCX headings, paragraphs, lists, and tables; TXT paragraphs; all three image MIME families; scanned-PDF OCR success and failure; empty extraction; MIME/extension/size mismatch; duplicate/retry idempotency; status transitions; relevance, bounded context and citations; unsupported answers; cross-user listing, download, and retrieval isolation; prompt injection; and continued use of `webSearch` as the only model-callable tool. Test live R2 and live vision/OCR separately as provider smoke checks.

## Security notes

R2 presigned URLs are bearer tokens, so use only exact-object operations and a short expiry, avoid logging URLs, and restrict bucket CORS to the app origin and required methods/headers. Verify the uploaded bytes server-side; extension and browser MIME are hints. Reject encrypted, malformed, oversized, and unsupported files. Treat DOCX as an archive and enforce expanded-size and entry-count limits. Do not expose bucket URLs, credentials, object keys, or another user's document metadata.

## Research basis

Cloudflare documents presigned URLs as single-operation temporary access and cautions that anyone holding a URL can use it until expiry: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/). R2 provides the S3-compatible endpoint and bucket-scoped access tokens: [R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/). Local LibSQL capability results are not a substitute for probing the deployed database.

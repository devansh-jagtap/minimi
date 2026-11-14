# Minimi system architecture

![Minimi system architecture](./minimi-architecture.png)

Download or reuse the [PNG image](./minimi-architecture.png) or the scalable [SVG image](./minimi-architecture.svg).

The diagram shows the implemented request paths and service boundaries: Clerk-authenticated chat; the Next.js chat and document APIs; Gemini answer generation, embeddings, and image extraction; Tavily through the single `webSearch` tool; owner-scoped LibSQL history, memory, research, metadata, and chunks; and private Cloudflare R2 document storage.

Uploaded files go directly from the browser to R2 through short-lived signed URLs. The local worker reads queued files, extracts and chunks their contents, creates Gemini embeddings, and saves chunks in LibSQL. Chat retrieval can use relevant documents across the same user's conversations. Search activity and sources are shown in the UI; private model chain-of-thought is not exposed.

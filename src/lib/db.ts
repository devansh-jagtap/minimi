
import { createClient } from "@libsql/client";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL is missing");
}

export const db = createClient({ url });

let schemaPromise: Promise<void> | undefined;

export function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.batch(
        [
          `CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id)
              REFERENCES conversations(id)
          )`,
          `CREATE INDEX IF NOT EXISTS idx_messages_conversation
            ON messages(conversation_id, created_at)`,
          `CREATE TABLE IF NOT EXISTS research_sessions (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            summary TEXT NOT NULL,
            researched_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
          )`,
          `CREATE INDEX IF NOT EXISTS idx_research_sessions_conversation
            ON research_sessions(conversation_id, researched_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_research_sessions_topic
            ON research_sessions(topic, researched_at DESC)`,
          `CREATE TABLE IF NOT EXISTS entities (
            id TEXT PRIMARY KEY,
            normalized_name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE INDEX IF NOT EXISTS idx_entities_display_name
            ON entities(display_name)`,
          `CREATE TABLE IF NOT EXISTS sources (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            publisher TEXT,
            published_at TEXT,
            retrieved_at TEXT NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS observations (
            id TEXT PRIMARY KEY,
            research_session_id TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            attribute TEXT NOT NULL,
            value TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            valid_from TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (research_session_id) REFERENCES research_sessions(id),
            FOREIGN KEY (entity_id) REFERENCES entities(id),
            FOREIGN KEY (source_id) REFERENCES sources(id)
          )`,
          `CREATE INDEX IF NOT EXISTS idx_observations_entity_attribute
            ON observations(entity_id, attribute, observed_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_observations_session
            ON observations(research_session_id, observed_at DESC)`,
        ],
        "write"
      );
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }

  return schemaPromise;
}

export async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string
) {
  await ensureSchema();

  await db.execute({
    sql: `INSERT OR IGNORE INTO conversations (id) VALUES (?)`,
    args: [conversationId],
  });

  await db.execute({
    sql: `INSERT INTO messages
      (conversation_id, role, content)
      VALUES (?, ?, ?)`,
    args: [conversationId, role, content],
  });
}

export async function getRecentMessages(
  conversationId: string,
  limit = 15
) {
  await ensureSchema();

  const result = await db.execute({
    sql: `SELECT role, content, created_at
          FROM messages
          WHERE conversation_id = ?
          ORDER BY id DESC
          LIMIT ?`,
    args: [conversationId, limit],
  });

  return result.rows.reverse();
}


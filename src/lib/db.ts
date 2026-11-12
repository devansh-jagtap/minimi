
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
 

import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL is missing");
}

export const db = createClient({ url, concurrency: 1 });

export type ResearchSession = {
  id: string;
  conversationId: string;
  topic: string;
  summary: string;
  researchedAt: string;
};

export type ResearchSource = {
  id: string;
  url: string;
  title: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
};

export type ResearchObservation = {
  entity: { name: string; type: string };
  source: { url: string; title: string; publisher?: string; publishedAt?: string };
  attribute: string;
  value: string;
  validFrom?: string;
};

export type StoredObservation = ResearchObservation & {
  id: string;
  researchSessionId: string;
  entityId: string;
  sourceId: string;
  observedAt: string;
  retrievedAt: string;
};

let schemaPromise: Promise<void> | undefined;
let writeQueue: Promise<void> = Promise.resolve();

async function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = writeQueue;
  let release!: () => void;
  writeQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.execute("PRAGMA foreign_keys = ON");
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
  await withWriteLock(async () => {
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

const normalizeEntityName = (name: string) => name.trim().toLocaleLowerCase("en-US");

export async function saveResearchSession(input: Omit<ResearchSession, "id"> & { id?: string }) {
  await ensureSchema();
  const id = input.id ?? randomUUID();
  await withWriteLock(async () => {
    await db.execute({ sql: "INSERT OR IGNORE INTO conversations (id) VALUES (?)", args: [input.conversationId] });
    await db.execute({
      sql: `INSERT INTO research_sessions (id, conversation_id, topic, summary, researched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, input.conversationId, input.topic, input.summary, input.researchedAt],
    });
  });
  return { ...input, id };
}

export async function findEntities(names: string[]) {
  await ensureSchema();
  const normalized = [...new Set(names.map(normalizeEntityName).filter(Boolean))];
  if (!normalized.length) return [];
  const placeholders = normalized.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT id, normalized_name, display_name, entity_type, created_at
          FROM entities WHERE normalized_name IN (${placeholders})`,
    args: normalized,
  });
  return result.rows;
}

export async function findResearchSessions(input: {
  conversationId?: string;
  topic?: string;
  entityNames?: string[];
  limit?: number;
}) {
  await ensureSchema();
  const conditions: string[] = [];
  const args: (string | number)[] = [];
  if (input.conversationId) {
    conditions.push("rs.conversation_id = ?");
    args.push(input.conversationId);
  }
  if (input.topic?.trim()) {
    conditions.push("LOWER(rs.topic) LIKE ?");
    args.push(`%${input.topic.trim().toLocaleLowerCase("en-US")}%`);
  }
  const entityNames = [...new Set((input.entityNames ?? []).map(normalizeEntityName).filter(Boolean))];
  if (entityNames.length) {
    conditions.push(`EXISTS (
      SELECT 1 FROM observations o JOIN entities e ON e.id = o.entity_id
      WHERE o.research_session_id = rs.id AND e.normalized_name IN (${entityNames.map(() => "?").join(",")})
    )`);
    args.push(...entityNames);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.execute({
    sql: `SELECT rs.id, rs.conversation_id, rs.topic, rs.summary, rs.researched_at, rs.created_at
          FROM research_sessions rs ${where}
          ORDER BY rs.researched_at DESC LIMIT ?`,
    args: [...args, Math.min(Math.max(input.limit ?? 20, 1), 100)],
  });
  return result.rows;
}

export async function getObservations(input: {
  entityIds?: string[];
  sessionIds?: string[];
  attribute?: string;
  limit?: number;
}) {
  await ensureSchema();
  const conditions: string[] = [];
  const args: (string | number)[] = [];
  for (const [field, values] of [["o.entity_id", input.entityIds], ["o.research_session_id", input.sessionIds]] as const) {
    const unique = [...new Set(values ?? [])];
    if (unique.length) {
      conditions.push(`${field} IN (${unique.map(() => "?").join(",")})`);
      args.push(...unique);
    }
  }
  if (input.attribute) {
    conditions.push("LOWER(o.attribute) = ?");
    args.push(input.attribute.trim().toLocaleLowerCase("en-US"));
  }
  if (!conditions.length) return [];
  const result = await db.execute({
    sql: `SELECT o.id, o.research_session_id, o.entity_id, o.source_id, o.attribute,
                 o.value, o.observed_at, o.valid_from, e.display_name, e.entity_type,
                 s.url, s.title, s.publisher, s.published_at, s.retrieved_at
          FROM observations o JOIN entities e ON e.id = o.entity_id
          JOIN sources s ON s.id = o.source_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY o.observed_at DESC LIMIT ?`,
    args: [...args, Math.min(Math.max(input.limit ?? 100, 1), 500)],
  });
  return result.rows;
}

export async function getSources(ids: string[]) {
  await ensureSchema();
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const result = await db.execute({
    sql: `SELECT id, url, title, publisher, published_at, retrieved_at FROM sources
          WHERE id IN (${unique.map(() => "?").join(",")})`,
    args: unique,
  });
  return result.rows;
}

export async function saveObservations(
  researchSessionId: string,
  observations: ResearchObservation[],
  observedAt = new Date().toISOString(),
) {
  await ensureSchema();
  const saved: StoredObservation[] = [];
  await withWriteLock(async () => {
    const transaction = await db.transaction("write");
    try {
      for (const observation of observations) {
        const entityId = randomUUID();
        await transaction.execute({
          sql: `INSERT INTO entities (id, normalized_name, display_name, entity_type)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(normalized_name) DO UPDATE SET
                  display_name = excluded.display_name, entity_type = excluded.entity_type`,
          args: [entityId, normalizeEntityName(observation.entity.name), observation.entity.name.trim(), observation.entity.type],
        });
        const entity = await transaction.execute({
          sql: "SELECT id FROM entities WHERE normalized_name = ?",
          args: [normalizeEntityName(observation.entity.name)],
        });
        const resolvedEntityId = String(entity.rows[0].id);

        const sourceId = randomUUID();
        const retrievedAt = observedAt;
        await transaction.execute({
          sql: `INSERT INTO sources (id, url, title, publisher, published_at, retrieved_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                  retrieved_at = CASE
                    WHEN excluded.retrieved_at > sources.retrieved_at THEN excluded.retrieved_at
                    ELSE sources.retrieved_at
                  END`,
          args: [sourceId, observation.source.url, observation.source.title, observation.source.publisher ?? null, observation.source.publishedAt ?? null, retrievedAt],
        });
        const source = await transaction.execute({ sql: "SELECT id FROM sources WHERE url = ?", args: [observation.source.url] });
        const resolvedSourceId = String(source.rows[0].id);
        const id = randomUUID();
        await transaction.execute({
          sql: `INSERT INTO observations
                (id, research_session_id, entity_id, source_id, attribute, value, observed_at, valid_from)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, researchSessionId, resolvedEntityId, resolvedSourceId, observation.attribute, observation.value, observedAt, observation.validFrom ?? null],
        });
        saved.push({ ...observation, id, researchSessionId, entityId: resolvedEntityId, sourceId: resolvedSourceId, observedAt, retrievedAt });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
  return saved;
}


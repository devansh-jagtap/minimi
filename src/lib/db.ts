
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";

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
  comparison?: {
    planTier?: string;
    currency?: string;
    billingInterval?: string;
    priceBasis?: string;
    region?: string;
  };
};

// Unclaimed records from the pre-auth local installation remain isolated here
// until an authenticated user explicitly imports matching local conversations.
export const LOCAL_USER_ID = process.env.MINIMI_LOCAL_USER_ID?.trim() || "local-single-user";

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
            user_id TEXT NOT NULL DEFAULT 'local-single-user',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS memory_items (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            memory_type TEXT NOT NULL,
            content TEXT NOT NULL,
            summary TEXT NOT NULL,
            source_conversation_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CHECK (memory_type IN ('preferences', 'facts', 'projects', 'decisions', 'research', 'technical_context', 'important_discussions')),
            FOREIGN KEY (user_id) REFERENCES local_users(id),
            FOREIGN KEY (source_conversation_id) REFERENCES conversations(id)
          )`,
          `CREATE TABLE IF NOT EXISTS local_users (
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
          `CREATE INDEX IF NOT EXISTS idx_messages_date
            ON messages(created_at, conversation_id)`,
          `CREATE INDEX IF NOT EXISTS idx_memory_items_user
            ON memory_items(user_id, memory_type, updated_at DESC)`,
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_dedupe
            ON memory_items(user_id, source_conversation_id, LOWER(summary))`,
          `CREATE TABLE IF NOT EXISTS research_sessions (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            user_id TEXT NOT NULL DEFAULT 'local-single-user',
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
            plan_tier TEXT,
            currency TEXT,
            billing_interval TEXT,
            price_basis TEXT,
            region TEXT,
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
      // Safe additive migration for databases created before owner scoping.
      for (const [table, column, definition] of [
        ["conversations", "user_id", "TEXT NOT NULL DEFAULT 'local-single-user'"],
        ["research_sessions", "user_id", "TEXT NOT NULL DEFAULT 'local-single-user'"],
      ]) {
        const columns = await db.execute(`PRAGMA table_info(${table})`);
        if (!columns.rows.some((row) => String(row.name) === column)) {
          await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      const observationColumns = await db.execute("PRAGMA table_info(observations)");
      const existingObservationColumns = new Set(observationColumns.rows.map((row) => String(row.name)));
      for (const [column, definition] of [
        ["plan_tier", "TEXT"],
        ["currency", "TEXT"],
        ["billing_interval", "TEXT"],
        ["price_basis", "TEXT"],
        ["region", "TEXT"],
      ]) {
        if (!existingObservationColumns.has(column)) {
          await db.execute(`ALTER TABLE observations ADD COLUMN ${column} ${definition}`);
        }
      }
      await db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: [LOCAL_USER_ID] });
      await db.execute({ sql: "UPDATE conversations SET user_id = ? WHERE user_id = 'local-single-user'", args: [LOCAL_USER_ID] });
      await db.execute({ sql: "UPDATE research_sessions SET user_id = ? WHERE user_id = 'local-single-user'", args: [LOCAL_USER_ID] });
      await db.execute("CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, created_at DESC)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_research_sessions_user ON research_sessions(user_id, researched_at DESC)");
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
  content: string,
  userId = LOCAL_USER_ID,
) {
  await ensureSchema();
  await withWriteLock(async () => {
    await db.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: [userId] });
    await db.execute({
      sql: `INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)`,
      args: [conversationId, userId],
    });
    const owner = await db.execute({ sql: "SELECT user_id FROM conversations WHERE id = ?", args: [conversationId] });
    if (String(owner.rows[0]?.user_id) !== userId) throw new Error("Conversation owner mismatch");

    await db.execute({
      sql: `INSERT INTO messages
        (conversation_id, role, content)
        VALUES (?, ?, ?)`,
      args: [conversationId, role, content],
    });
  });
}

export async function searchUserMessages(input: { userId: string; query: string; startUtc?: string; endUtc?: string; limit?: number }) {
  await ensureSchema();
  const terms = [...new Set((input.query.toLocaleLowerCase("en-US").match(/[a-z0-9][a-z0-9.+#-]*/g) ?? []).filter((term) => term.length > 2 && !["what", "about", "with", "from", "that", "this", "were", "discussed", "talked", "asked"].includes(term)))].slice(0, 6);
  const conditions = terms.map(() => "LOWER(m.content) LIKE ?").join(" OR ");
  const dateCondition = input.startUtc && input.endUtc ? "AND m.created_at >= ? AND m.created_at < ?" : "";
  if (!conditions && !dateCondition) return [];
  const result = await db.execute({
    sql: `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
          FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = ? ${dateCondition}
          ${conditions ? `AND (${conditions})` : ""}
          ORDER BY m.id DESC LIMIT ?`,
    args: [input.userId, ...(dateCondition ? [input.startUtc!, input.endUtc!] : []), ...terms.map((term) => `%${term}%`), Math.min(input.limit ?? 40, 100)],
  });
  return result.rows.reverse();
}

export async function saveMemoryItem(input: { userId: string; conversationId: string; memoryType: string; content: string; summary: string }) {
  await ensureSchema();
  await db.execute({ sql: "INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)", args: [input.conversationId, input.userId] });
  const conversationOwner = await db.execute({ sql: "SELECT user_id FROM conversations WHERE id = ?", args: [input.conversationId] });
  if (String(conversationOwner.rows[0]?.user_id) !== input.userId) throw new Error("Memory source conversation owner mismatch");
  return withWriteLock(async () => {
    const normalized = input.summary.trim().toLocaleLowerCase("en-US");
    const id = randomUUID();
    await db.execute({
      sql: `INSERT OR IGNORE INTO memory_items (id, user_id, memory_type, content, summary, source_conversation_id) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, input.userId, input.memoryType, input.content, input.summary, input.conversationId],
    });
    const existing = await db.execute({
      sql: "SELECT id FROM memory_items WHERE user_id = ? AND source_conversation_id = ? AND LOWER(summary) = ? LIMIT 1",
      args: [input.userId, input.conversationId, normalized],
    });
    return String(existing.rows[0]?.id ?? id);
  });
}

export async function findRelevantMemoryItems(userId: string, query: string, limit = 12) {
  await ensureSchema();
  const terms = [...new Set((query.toLocaleLowerCase("en-US").match(/[a-z0-9][a-z0-9.+#-]*/g) ?? []).filter((term) => term.length > 2 && !["what", "about", "with", "from", "that", "this", "were", "discussed", "talked", "asked", "previously"].includes(term)))].slice(0, 8);
  if (!terms.length) return [];
  const matches = terms.map(() => "(LOWER(mi.summary) LIKE ? OR LOWER(mi.content) LIKE ?)").join(" OR ");
  const result = await db.execute({
    sql: `SELECT mi.id, mi.memory_type, mi.content, mi.summary, mi.source_conversation_id, mi.created_at
          FROM memory_items mi WHERE mi.user_id = ? AND (${matches})
          ORDER BY mi.updated_at DESC LIMIT ?`,
    args: [userId, ...terms.flatMap((term) => [`%${term}%`, `%${term}%`]), Math.min(limit, 50)],
  });
  return result.rows;
}

export async function deleteConversation(userId: string, conversationId: string) {
  await ensureSchema();
  return withWriteLock(async () => {
    const transaction = await db.transaction("write");
    try {
      const owner = await transaction.execute({ sql: "SELECT user_id FROM conversations WHERE id = ?", args: [conversationId] });
      if (!owner.rows.length || String(owner.rows[0].user_id) !== userId) {
        await transaction.rollback();
        return false;
      }
      const sessions = await transaction.execute({ sql: "SELECT id FROM research_sessions WHERE conversation_id = ? AND user_id = ?", args: [conversationId, userId] });
      const sessionIds = sessions.rows.map((row) => String(row.id));
      if (sessionIds.length) {
        const placeholders = sessionIds.map(() => "?").join(",");
        await transaction.execute({ sql: `DELETE FROM observations WHERE research_session_id IN (${placeholders})`, args: sessionIds });
      }
      await transaction.execute({ sql: "DELETE FROM research_sessions WHERE conversation_id = ? AND user_id = ?", args: [conversationId, userId] });
      await transaction.execute({ sql: "DELETE FROM memory_items WHERE source_conversation_id = ? AND user_id = ?", args: [conversationId, userId] });
      await transaction.execute({ sql: "DELETE FROM messages WHERE conversation_id = ?", args: [conversationId] });
      await transaction.execute({ sql: "DELETE FROM conversations WHERE id = ? AND user_id = ?", args: [conversationId, userId] });
      await transaction.execute("DELETE FROM sources WHERE NOT EXISTS (SELECT 1 FROM observations WHERE observations.source_id = sources.id)");
      await transaction.execute("DELETE FROM entities WHERE NOT EXISTS (SELECT 1 FROM observations WHERE observations.entity_id = entities.id)");
      await transaction.commit();
      return true;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
}

export function legacyConversationProof(messages: Array<{ role: string; content: string }>) {
  const transcript = JSON.stringify(messages.map((message) => [message.role, message.content]));
  return createHash("sha256").update(transcript, "utf8").digest("hex");
}

export async function claimLegacyConversations(userId: string, conversations: Array<{ id: string; proof: string; messageCount: number }>) {
  await ensureSchema();
  const unique = [...new Map(conversations.filter((item) => /^[a-f0-9]{64}$/i.test(item.proof) && Number.isInteger(item.messageCount) && item.messageCount > 0 && item.messageCount <= 40).map((item) => [item.id, item])).values()].slice(0, 100);
  if (!unique.length) return [];
  return withWriteLock(async () => {
    const transaction = await db.transaction("write");
    try {
      await transaction.execute({ sql: "INSERT OR IGNORE INTO local_users (id) VALUES (?)", args: [userId] });
      const legacyOwnerIds = [...new Set([LOCAL_USER_ID, "local-single-user"])];
      const ownerPlaceholders = legacyOwnerIds.map(() => "?").join(",");
      const claimedIds: string[] = [];
      for (const item of unique) {
        const candidate = await transaction.execute({
          sql: `SELECT id, user_id FROM conversations WHERE id = ? AND (user_id = ? OR user_id IN (${ownerPlaceholders}))`,
          args: [item.id, userId, ...legacyOwnerIds],
        });
        if (!candidate.rows.length) continue;
        const messages = await transaction.execute({
          sql: "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
          args: [item.id, item.messageCount],
        });
        const transcript = messages.rows.reverse().map((row) => ({ role: String(row.role), content: String(row.content) }));
        if (transcript.length && legacyConversationProof(transcript) === item.proof) claimedIds.push(item.id);
      }
      if (claimedIds.length) {
        const claimedPlaceholders = claimedIds.map(() => "?").join(",");
        const args = [userId, ...claimedIds, ...legacyOwnerIds];
        await transaction.execute({ sql: `UPDATE conversations SET user_id = ? WHERE id IN (${claimedPlaceholders}) AND user_id IN (${ownerPlaceholders})`, args });
        await transaction.execute({ sql: `UPDATE memory_items SET user_id = ? WHERE source_conversation_id IN (${claimedPlaceholders}) AND user_id IN (${ownerPlaceholders})`, args });
        await transaction.execute({ sql: `UPDATE research_sessions SET user_id = ? WHERE conversation_id IN (${claimedPlaceholders}) AND user_id IN (${ownerPlaceholders})`, args });
      }
      await transaction.commit();
      return claimedIds;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
}

export async function getRecentMessages(
  userId: string,
  conversationId: string,
  limit = 15
) {
  await ensureSchema();

  const result = await db.execute({
    sql: `SELECT m.role, m.content, m.created_at
          FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.conversation_id = ? AND c.user_id = ?
          ORDER BY m.id DESC
          LIMIT ?`,
    args: [conversationId, userId, limit],
  });

  return result.rows.reverse();
}

const normalizeEntityName = (name: string) => name.trim().toLocaleLowerCase("en-US");

export async function saveResearchSession(input: Omit<ResearchSession, "id"> & { id?: string; userId?: string }) {
  await ensureSchema();
  const id = input.id ?? randomUUID();
  const userId = input.userId ?? LOCAL_USER_ID;
  await withWriteLock(async () => {
    await db.execute({ sql: "INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)", args: [input.conversationId, userId] });
    const owner = await db.execute({ sql: "SELECT user_id FROM conversations WHERE id = ?", args: [input.conversationId] });
    if (String(owner.rows[0]?.user_id) !== userId) throw new Error("Research conversation owner mismatch");
    await db.execute({
      sql: `INSERT INTO research_sessions (id, conversation_id, user_id, topic, summary, researched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, input.conversationId, userId, input.topic, input.summary, input.researchedAt],
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
  userId?: string;
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
  if (input.userId) {
    conditions.push("rs.user_id = ?");
    args.push(input.userId);
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
                 o.value, o.observed_at, o.valid_from, o.plan_tier, o.currency,
                 o.billing_interval, o.price_basis, o.region, e.display_name, e.entity_type,
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
                (id, research_session_id, entity_id, source_id, attribute, value, observed_at, valid_from,
                 plan_tier, currency, billing_interval, price_basis, region)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, researchSessionId, resolvedEntityId, resolvedSourceId, observation.attribute, observation.value, observedAt, observation.validFrom ?? null,
            observation.comparison?.planTier ?? null, observation.comparison?.currency ?? null,
            observation.comparison?.billingInterval ?? null, observation.comparison?.priceBasis ?? null,
            observation.comparison?.region ?? null],
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


"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UserButton } from "@clerk/nextjs";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: Array<{ id: string; filename: string }>;
  activity?: SearchActivity[];
  phase?: string;
};

type SearchActivity = { id: string; query: string; status: "searching" | "complete" | "failed"; startedAt: number; durationMs?: number; sources: Array<{ title: string; url: string }> };

type SavedConversation = {
  id: string;
  title: string;
  updatedAt: string;
  messages: Message[];
};
type UploadedDocument = { id: string; filename: string; status: string; error_message?: string };

const CONVERSATIONS_KEY = "minimi-conversations-v1";
const ACTIVE_CONVERSATION_KEY = "minimi-active-conversation-v1";
const THEME_KEY = "minimi-theme-v1";
const WEB_SEARCH_KEY = "minimi-web-search-v1";
const LEGACY_IMPORT_KEY = "minimi-legacy-import-v1";
const LEGACY_IMPORT_OWNER_KEY = "minimi-legacy-import-owner-v1";

async function legacyConversationProof(messages: Message[]) {
  const transcript = JSON.stringify(messages.map((message) => [message.role, message.content]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(transcript));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function accountStorageKey(key: string, userId: string) {
  return `${key}:${userId}`;
}


function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === "search") return <svg {...common}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>;
  if (name === "clock") return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.2 2" /></svg>;
  if (name === "arrow") return <svg {...common}><path d="M5 12h14m-6-6 6 6-6 6" /></svg>;
  if (name === "send") return <svg {...common}><path d="m21 3-7.2 18-3.5-7.3L3 10.2 21 3Z" /><path d="M10.3 13.7 15 9" /></svg>;
  if (name === "stop") return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
  if (name === "menu") return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
  if (name === "compare") return <svg {...common}><path d="M7 4v16m0-16 4 4M7 4 3 8m14 12V4m0 16-4-4m4 4 4-4" /></svg>;
  if (name === "calendar") return <svg {...common}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M7.5 3v4M16.5 3v4M4 9.5h16" /></svg>;
  if (name === "database") return <svg {...common}><ellipse cx="12" cy="5" rx="7.5" ry="3" /><path d="M4.5 5v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5M4.5 12v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-7" /></svg>;
  if (name === "trash") return <svg {...common}><path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 4v5m4-5v5" /></svg>;
  if (name === "sun") return <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></svg>;
  if (name === "moon") return <svg {...common}><path d="M20.2 15.1A8.4 8.4 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z" /></svg>;
  if (name === "web") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3.5 12h17M12 3c2.3 2.5 3.5 5.5 3.5 9S14.3 18.5 12 21c-2.3-2.5-3.5-5.5-3.5-9S9.7 5.5 12 3Z" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12h7M12 8.5v7" /></svg>;
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function firstQuestion(messages: Message[]) {
  return messages.find((message) => message.role === "user")?.content ?? "New research";
}

function formatDate(date: string) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(parsed);
}

function MessageText({ content }: { content: string }) {
  const normalized = content
    .replace(/(https?:\/\/[^\s)\]>]+)(?:\s*\1){2,}/g, "$1 [repeated link omitted]")
    .replace(/\\([*_`#[\]()>])/g, "$1")
    .replace(/\\n/g, "\n");
  const lines = normalized.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Array<{ type: "paragraph" | "ul" | "ol" | "code" | "hr" | "heading" | "quote" | "table"; lines: string[]; level?: number }> = [];
  let current: (typeof blocks)[number] | null = null;
  let codeFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      if (codeFence) { if (current) blocks.push(current); current = null; }
      else { if (current) blocks.push(current); current = { type: "code", lines: [] }; }
      codeFence = !codeFence;
      continue;
    }
    if (codeFence) { current?.lines.push(line); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    const list = line.match(/^\s*(?:([-*+])\s+|\d+[.)]\s+)(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (!line.trim()) { if (current) blocks.push(current); current = null; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { if (current) blocks.push(current); current = null; blocks.push({ type: "hr", lines: [] }); continue; }
    if (heading) { if (current) blocks.push(current); blocks.push({ type: "heading", level: heading[1].length, lines: [heading[2]] }); current = null; continue; }
    if (quote) {
      if (current?.type !== "quote") { if (current) blocks.push(current); current = { type: "quote", lines: [] }; }
      current.lines.push(quote[1]);
      continue;
    }
    if (line.includes("|") && lines[index + 1]?.trim().match(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/)) {
      if (current) blocks.push(current);
      blocks.push({ type: "table", lines: [line, lines[index + 1]] });
      index += 1;
      while (index + 1 < lines.length && lines[index + 1].includes("|")) blocks.at(-1)?.lines.push(lines[++index]);
      current = null;
      continue;
    }
    if (list) {
      const type = /^\s*\d/.test(line) ? "ol" : "ul";
      const active = current as (typeof blocks)[number] | null;
      if (active?.type !== type) { if (active) blocks.push(active); current = { type, lines: [] }; }
      (current as (typeof blocks)[number]).lines.push(list[2].replace(/^\[([ xX])\]\s+/, (_, checked: string) => `${checked.trim() ? "☑" : "☐"} `));
      continue;
    }
    if (current?.type !== "paragraph") { if (current) blocks.push(current); current = { type: "paragraph", lines: [] }; }
    current.lines.push(line);
  }
  if (current) blocks.push(current);

  const inline = (text: string, prefix: string): React.ReactNode[] => {
    const pattern = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)\]]+|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
    const output: React.ReactNode[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) output.push(text.slice(cursor, match.index));
      const token = match[0]; const key = `${prefix}-${match.index}`;
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (link) { try { const url = new URL(link[2]); if (url.protocol === "http:" || url.protocol === "https:") output.push(<a key={key} href={url.href} target="_blank" rel="noreferrer">{link[1]}</a>); else output.push(link[1]); } catch { output.push(link[1]); } }
      else if (/^https?:\/\//.test(token)) { const href = token.replace(/[.,;:!?]+$/, ""); try { const url = new URL(href); if (url.protocol === "http:" || url.protocol === "https:") output.push(<a key={key} href={url.href} target="_blank" rel="noreferrer">{href}</a>); else output.push(href); } catch { output.push(href); } if (href.length < token.length) output.push(token.slice(href.length)); }
      else if (token.startsWith("`")) output.push(<code key={key}>{token.slice(1, -1)}</code>);
      else if (token.startsWith("**")) output.push(<strong key={key}>{token.slice(2, -2)}</strong>);
      else output.push(<em key={key}>{token.slice(1, -1)}</em>);
      cursor = pattern.lastIndex;
    }
    if (cursor < text.length) output.push(text.slice(cursor));
    return output;
  };
  const tableCells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  return <div className="message-copy">{blocks.map((block, index) => {
    const key = `block-${index}`; const value = block.lines.join(block.type === "paragraph" ? "\n" : "");
    if (block.type === "hr") return <hr key={key} />;
    if (block.type === "code") return <pre key={key}><code>{value}</code></pre>;
    if (block.type === "quote") return <blockquote key={key}>{block.lines.map((line, lineIndex) => <p key={`${key}-${lineIndex}`}>{inline(line, `${key}-${lineIndex}`)}</p>)}</blockquote>;
    if (block.type === "table") {
      const rows = block.lines.filter((_, rowIndex) => rowIndex !== 1).map(tableCells);
      const headers = rows[0] ?? [];
      return <div className="message-table-wrap" key={key}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={`${key}-h-${cellIndex}`}>{inline(cell, `${key}-h-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={`${key}-r-${rowIndex}`}>{headers.map((_, cellIndex) => <td key={`${key}-${rowIndex}-${cellIndex}`}>{inline(row[cellIndex] ?? "", `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>;
    }
    if (block.type === "heading") { const Tag = `h${block.level}` as "h1"; return <Tag key={key}>{inline(value, key)}</Tag>; }
    if (block.type === "ul" || block.type === "ol") { const Tag = block.type; return <Tag key={key}>{block.lines.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>)}</Tag>; }
    return <p key={key}>{inline(value, key)}</p>;
  })}</div>;
}

function MessageAttachment({ filename }: { filename: string }) {
  const extension = filename.split(".").pop()?.toUpperCase().slice(0, 4) || "FILE";
  return <div className="message-attachment">
    <span className="message-attachment-icon" aria-hidden="true">{extension}</span>
    <span className="message-attachment-copy"><span className="message-attachment-name">{filename}</span><span className="message-attachment-label">Document</span></span>
  </div>;
}

function SearchActivityView({ activity, phase, now }: { activity: SearchActivity[]; phase?: string; now: number }) {
  if (!activity.length && !phase) return null;
  const sourceCount = activity.reduce((count, item) => count + item.sources.length, 0);
  return <details className="search-activity">
    <summary><span className="activity-pulse" />{phase ?? "Research activity"}<span className="activity-count">{activity.length} {activity.length === 1 ? "search" : "searches"}{sourceCount ? ` · ${sourceCount} sources` : ""}</span></summary>
    <div className="activity-list">{activity.map((item) => <section key={item.id} className="activity-query">
      <div className="activity-query-title"><span className={`activity-state activity-state-${item.status}`} />{item.status === "searching" ? "Searching" : item.status === "failed" ? "Search unavailable" : "Searched"}: {item.query}<span className="activity-duration">{((item.durationMs ?? Math.max(0, now - (item.startedAt || now))) / 1000).toFixed(1)}s</span></div>
      {!!item.sources.length && <ul>{item.sources.map((source) => { let domain = source.url; try { domain = new URL(source.url).hostname; } catch { /* ignore malformed source */ } return <li key={`${item.id}-${source.url}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || domain}</a><span>{domain}</span></li>; })}</ul>}
    </section>)}{!activity.length && <p>Preparing your search.</p>}</div>
  </details>;
}

export default function ChatWorkspace({ userId }: { userId: string }) {
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadedDocuments, setUploadedDocuments] = useState<UploadedDocument[]>([]);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [removingDocumentIds, setRemovingDocumentIds] = useState<string[]>([]);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [activityNow, setActivityNow] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationsRef = useRef(conversations);
  const activeIdRef = useRef(activeId);
  const sentDocumentIds = new Set(messages.flatMap((message) => message.attachments?.map((attachment) => attachment.id) ?? []));
  const composerDocuments = uploadedDocuments.filter((document) => !sentDocumentIds.has(document.id));
  const waitingForFiles = isUploadingFile || composerDocuments.some((document) => ["uploaded", "queued", "processing"].includes(document.status));

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  useEffect(() => {
    if (!activeId || !isHydrated) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/documents?conversationId=${encodeURIComponent(activeId)}`, { cache: "no-store" });
        if (response.ok) {
          const data = await response.json() as { documents?: UploadedDocument[] };
          if (!stopped) setUploadedDocuments(data.documents ?? []);
        }
      } catch { /* document status is supplementary to chat */ }
      if (!stopped) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeId, isHydrated]);

  useEffect(() => {
    let cancelled = false;
    let legacyImportPendingForAccount = false;
    const hydrateAccount = async () => {
      try {
        const conversationsKey = accountStorageKey(CONVERSATIONS_KEY, userId);
        const activeKey = accountStorageKey(ACTIVE_CONVERSATION_KEY, userId);
        let storedText = localStorage.getItem(conversationsKey);
        let savedActiveId = localStorage.getItem(activeKey);
        let importedLegacy = false;
        const hasLegacyData = Boolean(localStorage.getItem(CONVERSATIONS_KEY));
        let legacyOwner = localStorage.getItem(LEGACY_IMPORT_OWNER_KEY);

        // Move the old unscoped browser data to the first account that signs in.
        // Later accounts get a separate namespace and cannot see those chats.
        if (hasLegacyData && localStorage.getItem(LEGACY_IMPORT_KEY) !== "complete") {
          if (!legacyOwner) {
            legacyOwner = userId;
            localStorage.setItem(LEGACY_IMPORT_OWNER_KEY, userId);
          }
          if (!storedText && legacyOwner === userId) {
            storedText = localStorage.getItem(CONVERSATIONS_KEY);
            savedActiveId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
            importedLegacy = Boolean(storedText);
            legacyImportPendingForAccount = importedLegacy;
          }
        }

        const stored = JSON.parse(storedText ?? "[]") as SavedConversation[];
        const safeStored = Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === "string" && Array.isArray(item.messages)) : [];
        if (importedLegacy && safeStored.length) {
          const response = await fetch("/api/chat/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversations: await Promise.all(safeStored.map(async (item) => ({ id: item.id, proof: await legacyConversationProof(item.messages.slice(-40)), messageCount: Math.min(item.messages.length, 40) }))) }),
          });
          if (!response.ok) throw new Error("Your saved chats could not be imported. Refresh to try again.");
          const { claimedCount } = await response.json() as { claimedCount: number };
          if (claimedCount !== safeStored.length) throw new Error("Some saved chats could not be verified for import. Your original local copy is still available.");
        }
        if (importedLegacy) {
          localStorage.setItem(conversationsKey, storedText ?? "[]");
          if (savedActiveId) localStorage.setItem(activeKey, savedActiveId);
          localStorage.removeItem(CONVERSATIONS_KEY);
          localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
          localStorage.removeItem(LEGACY_IMPORT_OWNER_KEY);
          localStorage.setItem(LEGACY_IMPORT_KEY, "complete");
        } else if (!hasLegacyData && localStorage.getItem(LEGACY_IMPORT_KEY) !== "complete") {
          localStorage.setItem(LEGACY_IMPORT_KEY, "complete");
        }
        if (cancelled) return;
        const active = safeStored.find((conversation) => conversation.id === savedActiveId);
        setTheme(localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
        setWebSearchEnabled(localStorage.getItem(WEB_SEARCH_KEY) !== "false");
        setConversations(safeStored.slice(0, 30));
        if (active) {
          setActiveId(active.id);
          setMessages(active.messages);
        } else {
          const id = makeId();
          setActiveId(id);
          localStorage.setItem(activeKey, id);
        }
      } catch (caught) {
        if (!cancelled) {
          const pendingOwner = localStorage.getItem(LEGACY_IMPORT_OWNER_KEY);
          legacyImportPendingForAccount = pendingOwner === userId && Boolean(localStorage.getItem(CONVERSATIONS_KEY));
          if (!legacyImportPendingForAccount) setActiveId(makeId());
          setError(caught instanceof Error ? caught.message : "Could not load this account's research.");
        }
      } finally {
        if (!cancelled && !legacyImportPendingForAccount) setIsHydrated(true);
      }
    };
    void hydrateAccount();
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(WEB_SEARCH_KEY, String(webSearchEnabled));
  }, [isHydrated, theme, webSearchEnabled]);

  useEffect(() => {
    if (!isStreaming) return;
    const timer = window.setInterval(() => setActivityNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  useEffect(() => {
    if (!isHydrated || !activeId) return;
    const timeout = window.setTimeout(() => {
      try {
        const updated: SavedConversation[] = messages.length
          ? [{ id: activeId, title: firstQuestion(messages).slice(0, 90), updatedAt: messages.at(-1)?.createdAt ?? new Date().toISOString(), messages: messages.slice(-40) },
            ...conversationsRef.current.filter((conversation) => conversation.id !== activeId)]
          : conversationsRef.current.filter((conversation) => conversation.id !== activeId);
        const limited = updated.slice(0, 30);
        setConversations(limited);
        localStorage.setItem(accountStorageKey(CONVERSATIONS_KEY, userId), JSON.stringify(limited));
        localStorage.setItem(accountStorageKey(ACTIVE_CONVERSATION_KEY, userId), activeId);
      } catch {
        setError("This browser could not save local conversation history.");
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeId, isHydrated, messages, userId]);

  useEffect(() => {
    const scrollNode = scrollRef.current;
    if (scrollNode) scrollNode.scrollTop = scrollNode.scrollHeight;
  }, [messages, isStreaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const startNewConversation = useCallback(() => {
    abortRef.current?.abort();
    const id = makeId();
    setActiveId(id);
    setMessages([]);
    setUploadedDocuments([]);
    setUploadStatus("");
    setInput("");
    setError("");
    setIsStreaming(false);
    setIsSidebarOpen(false);
  }, []);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        startNewConversation();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [startNewConversation]);

  const openConversation = useCallback((conversation: SavedConversation) => {
    if (isStreaming) abortRef.current?.abort();
    setActiveId(conversation.id);
    setMessages(conversation.messages ?? []);
    setUploadedDocuments([]);
    setUploadStatus("");
    setError("");
    setIsStreaming(false);
    setIsSidebarOpen(false);
  }, [isStreaming]);

  const deleteConversation = useCallback(async (conversation: SavedConversation) => {
    if (!window.confirm(`Delete “${conversation.title}”? Its saved messages and research for this chat will be removed.`)) return;
    if (conversation.id === activeIdRef.current) abortRef.current?.abort();
    try {
      const response = await fetch("/api/chat", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id }) });
      if (!response.ok && response.status !== 404) throw new Error("Could not delete this saved chat.");
      const updated = conversationsRef.current.filter((item) => item.id !== conversation.id);
      conversationsRef.current = updated;
      setConversations(updated);
      localStorage.setItem(accountStorageKey(CONVERSATIONS_KEY, userId), JSON.stringify(updated));
      if (conversation.id === activeIdRef.current) {
        const nextId = makeId();
        activeIdRef.current = nextId;
        setActiveId(nextId);
        setMessages([]);
        setUploadedDocuments([]);
        setUploadStatus("");
        setIsStreaming(false);
        localStorage.setItem(accountStorageKey(ACTIVE_CONVERSATION_KEY, userId), nextId);
      }
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this saved chat.");
    }
  }, [userId]);

  const sendMessage = useCallback(async (text = input) => {
    const content = text.trim();
    if (!content || isStreaming || waitingForFiles) return;

    const conversationId = activeIdRef.current || makeId();
    if (!activeIdRef.current) setActiveId(conversationId);
    const userMessage: Message = {
      id: makeId(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      attachments: composerDocuments.map((document) => ({ id: document.id, filename: document.filename })),
    };
    const assistantId = makeId();
    const assistantMessage: Message = { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString(), activity: [], phase: "Preparing research" };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    if (userMessage.attachments?.length) setUploadStatus("");
    setInput("");
    setError("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content, conversationId, streamMode: "events", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, webSearchEnabled }),
        signal: controller.signal,
      });

      const returnedConversationId = response.headers.get("X-Conversation-Id");
      if (returnedConversationId && returnedConversationId !== activeIdRef.current) {
        activeIdRef.current = returnedConversationId;
        setActiveId(returnedConversationId);
      }
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? `Request failed (${response.status}).`);
      }
      if (!response.body) throw new Error("The response stream was empty.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let answer = "";
      let pending = "";
      const updateActivity = (update: (activity: SearchActivity[]) => SearchActivity[], phase?: string) => {
        setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, activity: update(message.activity ?? []), phase: phase ?? message.phase } : message));
      };
      const handleEvent = (raw: string) => {
        if (!raw.trim()) return;
        const item = JSON.parse(raw) as { type: string; text?: string; queries?: unknown[]; results?: unknown; message?: string };
        if (item.type === "delta" && typeof item.text === "string") {
          answer += item.text;
          setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: answer, phase: "Writing answer" } : message));
        } else if (item.type === "search-start") {
          const queries = (item.queries ?? []).filter((query): query is string => typeof query === "string");
          const startedAt = Date.now();
          updateActivity((activity) => [...activity, ...queries.map((query) => ({ id: makeId(), query, status: "searching" as const, startedAt, sources: [] }))], "Searching the web");
        } else if (item.type === "search-results") {
          const results = Array.isArray(item.results) ? item.results as Array<{ searchQuery?: string; title?: string; url?: string; error?: string }> : [];
          updateActivity((activity) => activity.map((entry) => {
            const matching = results.filter((result) => result.searchQuery === entry.query);
            if (!matching.length) return entry;
            const seenUrls = new Set<string>();
            const sources = matching.flatMap((result) => {
              if (!result.url || seenUrls.has(result.url)) return [];
              seenUrls.add(result.url);
              return [{ title: result.title ?? result.url, url: result.url }];
            }).slice(0, 2);
            return { ...entry, status: sources.length ? "complete" : "failed", durationMs: Date.now() - entry.startedAt, sources };
          }), "Reviewing sources");
        } else if (item.type === "done") {
          setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, phase: undefined } : message));
        } else if (item.type === "error") {
          throw new Error(item.message ?? "Minimi could not complete this request.");
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const chunks = pending.split("\n");
        pending = chunks.pop() ?? "";
        for (const chunk of chunks) handleEvent(chunk);
      }
      pending += decoder.decode();
      if (pending.trim()) handleEvent(pending);
      setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, phase: undefined } : message));
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") {
        setMessages((current) => current.filter((message) => message.id !== assistantId || message.content.length > 0));
      } else {
        setMessages((current) => current.filter((message) => message.id !== assistantId));
        setError(caught instanceof Error ? caught.message : "Minimi could not complete this request.");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsStreaming(false);
      }
    }
  }, [composerDocuments, input, isStreaming, webSearchEnabled, waitingForFiles]);

  const uploadFiles = useCallback(async (files: FileList | null) => {
    const conversationId = activeIdRef.current;
    if (!files?.length || !conversationId) return;
    setIsUploadingFile(true);
    const supported = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "image/png", "image/jpeg", "image/webp"]);
    for (const file of Array.from(files)) {
      if (!supported.has(file.type)) {
        if (activeIdRef.current === conversationId) setUploadStatus(`${file.name}: unsupported file type`);
        continue;
      }
      try {
        if (activeIdRef.current === conversationId) setUploadStatus(`Uploading ${file.name}…`);
        const intentResponse = await fetch("/api/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, filename: file.name, mimeType: file.type, sizeBytes: file.size }) });
        const intent = await intentResponse.json() as { id?: string; uploadUrl?: string; error?: string };
        if (!intentResponse.ok || !intent.id || !intent.uploadUrl) throw new Error(intent.error ?? "Upload could not be started.");
        const uploadResponse = await fetch(intent.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
        if (!uploadResponse.ok) throw new Error("R2 upload failed. Check bucket CORS and try again.");
        const complete = await fetch(`/api/documents/${intent.id}/complete`, { method: "POST" });
        if (!complete.ok) throw new Error("Upload verification failed.");
        if (activeIdRef.current === conversationId) {
          setUploadedDocuments((current) => [{ id: intent.id!, filename: file.name, status: "queued" }, ...current.filter((document) => document.id !== intent.id)]);
          setUploadStatus(`${file.name} uploaded. Preparing it for questions…`);
        }
      } catch (caught) {
        if (activeIdRef.current === conversationId) setUploadStatus(caught instanceof Error ? caught.message : "Document upload failed.");
      }
    }
    setIsUploadingFile(false);
    if (uploadInputRef.current) uploadInputRef.current.value = "";
  }, []);

  const retryDocument = useCallback(async (id: string) => {
    const response = await fetch(`/api/documents/${id}/retry`, { method: "POST" });
    if (response.ok) {
      setUploadedDocuments((current) => current.map((document) => document.id === id ? { ...document, status: "queued", error_message: undefined } : document));
      setUploadStatus("Preparing the file again…");
    }
    else setUploadStatus("Could not retry this document.");
  }, []);

  const removeDocument = useCallback(async (document: UploadedDocument) => {
    setRemovingDocumentIds((current) => [...current, document.id]);
    try {
      const response = await fetch(`/api/documents/${document.id}`, { method: "DELETE" });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "Could not remove this file.");
      setUploadedDocuments((current) => current.filter((item) => item.id !== document.id));
      setUploadStatus("");
    } catch (caught) {
      setUploadStatus(caught instanceof Error ? caught.message : "Could not remove this file.");
    } finally {
      setRemovingDocumentIds((current) => current.filter((id) => id !== document.id));
    }
  }, []);

  const currentTitle = messages.length ? firstQuestion(messages) : "New research";
  const failedFiles = composerDocuments.some((document) => document.status === "failed");
  const allFilesReady = composerDocuments.length > 0 && composerDocuments.every((document) => document.status === "completed");
  const composer = (
    <div className={`composer-area${messages.length === 0 ? " composer-area-centered" : ""}`}>
      {error && <div className="composer-error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        <input ref={uploadInputRef} type="file" accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.webp" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
        {composerDocuments.length > 0 && <div className="composer-attachments" aria-label="Files attached to your next message">
          <div className="document-list">{composerDocuments.map((document) => {
            const extension = document.filename.split(".").pop()?.toUpperCase().slice(0, 4) || "FILE";
            const statusLabel = document.status === "completed" ? "Document" : document.status === "failed" ? "Could not process" : document.status === "processing" ? "Reading file…" : "Uploading…";
            return <div key={document.id} className={`document-chip document-chip-${document.status}`} title={document.error_message ?? document.filename}>
              <span className="document-file-icon" aria-hidden="true">{extension}</span>
              <span className="document-chip-copy"><span className="document-chip-name">{document.filename}</span><span className="document-chip-status">{statusLabel}</span></span>
              {document.status === "failed" && <button type="button" className="document-retry" onClick={() => void retryDocument(document.id)}>Retry</button>}
              <button type="button" className="document-remove" onClick={() => void removeDocument(document)} disabled={document.status === "processing" || removingDocumentIds.includes(document.id)} aria-label={`Remove ${document.filename}`} title={document.status === "processing" ? "Wait for processing to finish" : "Remove file"}>{removingDocumentIds.includes(document.id) ? "…" : "×"}</button>
            </div>;
          })}</div>
        </div>}
        {waitingForFiles
          ? <div className="composer-upload-status" role="status" aria-live="polite"><span className="attachment-spinner" aria-hidden="true" />{isUploadingFile ? "Uploading files…" : "Preparing files. Sending will unlock when they’re ready."}</div>
          : failedFiles
            ? <div className="composer-upload-status composer-upload-error" role="status">A file could not be prepared. Retry it before asking questions about it.</div>
            : allFilesReady
              ? <div className="composer-upload-status composer-upload-ready" role="status">Files ready. Your next question will use their contents.</div>
              : uploadStatus && <div className="composer-upload-status composer-upload-error" role="status">{uploadStatus}</div>}
        <label className="sr-only" htmlFor="research-question">Ask Minimi a research question</label>
        <textarea id="research-question" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Ask a question or revisit something you researched…" rows={1} disabled={!isHydrated} />
        <div className="composer-footer">
          <div className="composer-options">
            <button type="button" className="composer-attach" onClick={() => uploadInputRef.current?.click()} disabled={!isHydrated || !activeId || isUploadingFile} aria-label="Add files" title="Add files"><Icon name="plus" size={20} /></button>
            <label className={`web-search-toggle${webSearchEnabled ? " web-search-enabled" : ""}`} title="When on, Minimi may search the public web for current information.">
              <input type="checkbox" checked={webSearchEnabled} onChange={(event) => setWebSearchEnabled(event.target.checked)} />
              <Icon name="web" size={15} /><span>Web search</span><span className="toggle-state">{webSearchEnabled ? "On" : "Off"}</span>
            </label>
            <span className="composer-hint"><Icon name="clock" size={14} /> Your files can be recalled from other chats</span>
          </div>
          {isStreaming ? <button type="button" className="send-button stop-button" onClick={() => abortRef.current?.abort()} aria-label="Stop response"><Icon name="stop" size={17} /></button> : <button type="submit" className="send-button" disabled={!input.trim() || waitingForFiles} aria-label={waitingForFiles ? "Wait for files to finish processing" : "Send question"}><Icon name="send" size={17} /></button>}
        </div>
      </form>
      <p className="composer-disclaimer">Minimi can make mistakes. Check important details against the linked sources.</p>
    </div>
  );

  return (
    <div className="minimi-shell" data-theme={theme}>
      {isSidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setIsSidebarOpen(false)} />}
      <aside className={`workspace-sidebar${isSidebarOpen ? " workspace-sidebar-open" : ""}`}>
        <a className="brand-lockup" href="#home" aria-label="Minimi home">
          <span className="brand-mark"><span /><span /><span /></span>
          <span className="brand-name">minimi</span>
        </a>

        <button className="new-research-button" onClick={startNewConversation}>
          <Icon name="plus" size={17} />
          <span>New research</span>
          <kbd>⌘ K</kbd>
        </button>

        <div className="sidebar-section-heading">
          <span>Recent research</span>
          <span className="local-indicator" title="Saved in this browser" />
        </div>
        <nav className="conversation-list" aria-label="Recent research">
          {conversations.length ? conversations.map((conversation) => (
            <div key={conversation.id} className={`conversation-row${conversation.id === activeId ? " conversation-row-active" : ""}`}>
              <button className="conversation-item" onClick={() => openConversation(conversation)} title={conversation.title}>
                <span className="conversation-item-icon"><Icon name="clock" size={15} /></span>
                <span className="conversation-item-copy">
                  <span className="conversation-title">{conversation.title}</span>
                  <span className="conversation-date">{formatDate(conversation.updatedAt)}</span>
                </span>
              </button>
              <button className="conversation-delete" title={`Delete ${conversation.title}`} aria-label={`Delete ${conversation.title}`} onClick={() => void deleteConversation(conversation)}><Icon name="trash" size={15} /></button>
            </div>
          )) : (
            <p className="sidebar-empty">Your saved questions will appear here.</p>
          )}
        </nav>

        <div className="sidebar-bottom">
          <div className="memory-note">
            <span className="memory-note-mark"><span /></span>
            <div>
              <strong>Memory is on</strong>
              <span>Saved research can be recalled across chats</span>
            </div>
          </div>
          <div className="profile-row">
            <UserButton />
            <span className="profile-copy"><strong>My workspace</strong><small>Recent threads on this device</small></span>
            <span className="profile-menu" aria-hidden="true">•••</span>
          </div>
        </div>
      </aside>

      <main className="research-main" id="home">
        <header className="workspace-topbar">
          <div className="topbar-left">
            <button className="mobile-menu-button" aria-label="Open navigation" onClick={() => setIsSidebarOpen(true)}>
              <Icon name="menu" />
            </button>
            <span className="breadcrumb-muted">Research desk</span>
            <span className="breadcrumb-slash">/</span>
            <span className="breadcrumb-current">{currentTitle.length > 36 ? `${currentTitle.slice(0, 36)}…` : currentTitle}</span>
          </div>
          <div className="topbar-actions">
            <span className="topbar-status"><span className="status-dot" /> {webSearchEnabled ? "Web search on" : "Web search off"}</span>
            <button className="theme-button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /></button>
          </div>
        </header>

        <section className="conversation-stage" aria-label="Conversation">
          <div className="conversation-scroll" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions text">
            {messages.length === 0 ? (
              <div className="welcome-panel">
                <div className="welcome-symbol" aria-hidden="true">
                  <span className="symbol-ring symbol-ring-one" />
                  <span className="symbol-ring symbol-ring-two" />
                  <span className="symbol-center"><Icon name="search" size={23} /></span>
                  <span className="symbol-node" />
                </div>
                <p className="welcome-overline">Your research desk</p>
                <h1>Ask once.<br /><span>Check again later.</span></h1>
                <p className="welcome-description">
                  Minimi keeps the sources and dates behind your research, so you can come back and see what has changed.
                </p>

                {composer}

              </div>
            ) : (
              <div className="message-thread">
                <div className="thread-date-label"><span />This research thread</div>
                {messages.map((message) => (
                  <article key={message.id} className={`chat-message chat-message-${message.role}`}>
                    {message.role === "assistant" ? (
                      <div className="assistant-mark" aria-hidden="true"><span /><span /><span /></div>
                    ) : null}
                    <div className="message-body">
                      {message.role === "assistant" && <div className="message-author">Minimi <span>Research assistant</span></div>}
                      {message.role === "assistant" && <SearchActivityView activity={message.activity ?? []} phase={message.phase} now={activityNow} />}
                      {message.role === "user" && !!message.attachments?.length && <div className="message-attachments" aria-label="Attached files">{message.attachments.map((attachment) => <MessageAttachment key={attachment.id} filename={attachment.filename} />)}</div>}
                      {message.content ? <MessageText content={message.content} /> : (
                        <div className="thinking-indicator"><span /><span /><span /><span>Working on your answer</span></div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          {messages.length > 0 && composer}
        </section>
      </main>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  activity?: SearchActivity[];
  phase?: string;
};

type SearchActivity = { id: string; query: string; status: "searching" | "complete" | "failed"; sources: Array<{ title: string; url: string }> };

type SavedConversation = {
  id: string;
  title: string;
  updatedAt: string;
  messages: Message[];
};

const CONVERSATIONS_KEY = "minimi-conversations-v1";
const ACTIVE_CONVERSATION_KEY = "minimi-active-conversation-v1";

const suggestions = [
  {
    label: "Check a shortlist",
    prompt: "On Monday we shortlisted five CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    icon: "compare",
  },
  {
    label: "Revisit an answer",
    prompt: "What did I ask you on 3 November? Is your answer still correct today?",
    icon: "calendar",
  },
  {
    label: "Track hosting prices",
    prompt: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since?",
    icon: "database",
  },
] as const;

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
  const normalized = content.replace(/(https?:\/\/[^\s)\]>]+)(?:\s*\1){2,}/g, "$1 [repeated link omitted]");
  const lines = normalized.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Array<{ type: "paragraph" | "ul" | "ol" | "code" | "hr" | "heading"; lines: string[]; level?: number }> = [];
  let current: (typeof blocks)[number] | null = null;
  let codeFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (codeFence) { if (current) blocks.push(current); current = null; }
      else { if (current) blocks.push(current); current = { type: "code", lines: [] }; }
      codeFence = !codeFence;
      continue;
    }
    if (codeFence) { current?.lines.push(line); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    const list = line.match(/^\s*(?:([-*+])\s+|\d+[.)]\s+)(.+)$/);
    if (!line.trim()) { if (current) blocks.push(current); current = null; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { if (current) blocks.push(current); current = null; blocks.push({ type: "hr", lines: [] }); continue; }
    if (heading) { if (current) blocks.push(current); blocks.push({ type: "heading", level: heading[1].length, lines: [heading[2]] }); current = null; continue; }
    if (list) {
      const type = /^\s*\d/.test(line) ? "ol" : "ul";
      if (current?.type !== type) { if (current) blocks.push(current); current = { type, lines: [] }; }
      current.lines.push(list[2]);
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
  return <div className="message-copy">{blocks.map((block, index) => {
    const key = `block-${index}`; const value = block.lines.join(block.type === "paragraph" ? "\n" : "");
    if (block.type === "hr") return <hr key={key} />;
    if (block.type === "code") return <pre key={key}><code>{value}</code></pre>;
    if (block.type === "heading") { const Tag = `h${block.level}` as "h1"; return <Tag key={key}>{inline(value, key)}</Tag>; }
    if (block.type === "ul" || block.type === "ol") { const Tag = block.type; return <Tag key={key}>{block.lines.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>)}</Tag>; }
    return <p key={key}>{inline(value, key)}</p>;
  })}</div>;
}

function SearchActivityView({ activity, phase }: { activity: SearchActivity[]; phase?: string }) {
  if (!activity.length && !phase) return null;
  const sourceCount = activity.reduce((count, item) => count + item.sources.length, 0);
  return <details className="search-activity" open>
    <summary><span className="activity-pulse" />{phase ?? "Research activity"}<span className="activity-count">{activity.length} {activity.length === 1 ? "search" : "searches"}{sourceCount ? ` · ${sourceCount} sources` : ""}</span></summary>
    <div className="activity-list">{activity.map((item) => <section key={item.id} className="activity-query">
      <div className="activity-query-title"><span className={`activity-state activity-state-${item.status}`} />{item.status === "searching" ? "Searching" : item.status === "failed" ? "Search unavailable" : "Searched"}: {item.query}</div>
      {!!item.sources.length && <ul>{item.sources.map((source) => { let domain = source.url; try { domain = new URL(source.url).hostname; } catch { /* ignore malformed source */ } return <li key={`${item.id}-${source.url}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || domain}</a><span>{domain}</span></li>; })}</ul>}
    </section>)}{!activity.length && <p>Preparing your search.</p>}</div>
  </details>;
}

export default function ChatWorkspace() {
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationsRef = useRef(conversations);
  const activeIdRef = useRef(activeId);

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const stored = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) ?? "[]") as SavedConversation[];
        const safeStored = Array.isArray(stored) ? stored : [];
        const savedActiveId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
        const active = safeStored.find((conversation) => conversation.id === savedActiveId);

        setConversations(safeStored.slice(0, 30));
        if (active) {
          setActiveId(active.id);
          setMessages(active.messages ?? []);
        } else {
          const id = makeId();
          setActiveId(id);
          localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
        }
      } catch {
        setActiveId(makeId());
      } finally {
        setIsHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

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
        localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(limited));
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeId);
      } catch {
        setError("This browser could not save local conversation history.");
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeId, isHydrated, messages]);

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
    setError("");
    setIsStreaming(false);
    setIsSidebarOpen(false);
  }, [isStreaming]);

  const sendMessage = useCallback(async (text = input) => {
    const content = text.trim();
    if (!content || isStreaming) return;

    const conversationId = activeIdRef.current || makeId();
    if (!activeIdRef.current) setActiveId(conversationId);
    const userMessage: Message = { id: makeId(), role: "user", content, createdAt: new Date().toISOString() };
    const assistantId = makeId();
    const assistantMessage: Message = { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString(), activity: [], phase: "Preparing research" };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");
    setError("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content, conversationId, streamMode: "events", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
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
          updateActivity((activity) => [...activity, ...queries.map((query) => ({ id: makeId(), query, status: "searching" as const, sources: [] }))], "Searching the web");
        } else if (item.type === "search-results") {
          const results = Array.isArray(item.results) ? item.results as Array<{ searchQuery?: string; title?: string; url?: string; error?: string }> : [];
          updateActivity((activity) => activity.map((entry) => {
            const matching = results.filter((result) => result.searchQuery === entry.query);
            if (!matching.length) return entry;
            return { ...entry, status: matching.some((result) => result.url) ? "complete" : "failed", sources: matching.flatMap((result) => result.url ? [{ title: result.title ?? result.url, url: result.url }] : []) };
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
  }, [input, isStreaming]);

  const currentTitle = messages.length ? firstQuestion(messages) : "New research";
  const composer = (
    <div className={`composer-area${messages.length === 0 ? " composer-area-centered" : ""}`}>
      {messages.length > 0 && error && <div className="composer-error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        <label className="sr-only" htmlFor="research-question">Ask Minimi a research question</label>
        <textarea id="research-question" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Ask a question or revisit something you researched…" rows={1} disabled={!isHydrated} />
        <div className="composer-footer"><span className="composer-hint"><Icon name="clock" size={14} /> Past research stays attached to this conversation</span>
          {isStreaming ? <button type="button" className="send-button stop-button" onClick={() => abortRef.current?.abort()} aria-label="Stop response"><Icon name="stop" size={17} /></button> : <button type="submit" className="send-button" disabled={!input.trim()} aria-label="Send question"><Icon name="send" size={17} /></button>}
        </div>
      </form>
      <p className="composer-disclaimer">Minimi can make mistakes. Check important details against the linked sources.</p>
    </div>
  );

  return (
    <div className="minimi-shell">
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
            <button
              key={conversation.id}
              className={`conversation-item${conversation.id === activeId ? " conversation-item-active" : ""}`}
              onClick={() => openConversation(conversation)}
              title={conversation.title}
            >
              <span className="conversation-item-icon"><Icon name="clock" size={15} /></span>
              <span className="conversation-item-copy">
                <span className="conversation-title">{conversation.title}</span>
                <span className="conversation-date">{formatDate(conversation.updatedAt)}</span>
              </span>
            </button>
          )) : (
            <p className="sidebar-empty">Your saved questions will appear here.</p>
          )}
        </nav>

        <div className="sidebar-bottom">
          <div className="memory-note">
            <span className="memory-note-mark"><span /></span>
            <div>
              <strong>Memory is on</strong>
              <span>Research stays with this thread</span>
            </div>
          </div>
          <div className="profile-row">
            <span className="profile-avatar">M</span>
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
          <div className="topbar-status"><span className="status-dot" /> Evidence mode</div>
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

                <div className="suggestion-list" aria-label="Try a research question">
                  {suggestions.map((suggestion) => (
                    <button key={suggestion.label} className="suggestion-row" onClick={() => void sendMessage(suggestion.prompt)}>
                      <span className="suggestion-icon"><Icon name={suggestion.icon} size={18} /></span>
                      <span className="suggestion-copy"><strong>{suggestion.label}</strong><span>{suggestion.prompt}</span></span>
                      <span className="suggestion-arrow"><Icon name="arrow" size={17} /></span>
                    </button>
                  ))}
                </div>
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
                        {message.role === "assistant" && <SearchActivityView activity={message.activity ?? []} phase={message.phase} />}
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

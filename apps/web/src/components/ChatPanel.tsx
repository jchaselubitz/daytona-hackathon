import { useEffect, useRef, useState } from "react";
import type { ServerToClient, Workspace } from "@app/shared";
import { api } from "../api.js";
import { errMsg } from "../App.js";
import { WsClient } from "../wsClient.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  done: boolean;
}

export function ChatPanel({ workspace }: { workspace: Workspace }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tool, setTool] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Open the WS for this workspace once.
  useEffect(() => {
    const ws = new WsClient(workspace.id);
    wsRef.current = ws;
    ws.connect();
    const off = ws.onMessage(handleEvent);
    return () => {
      off();
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, tool]);

  function handleEvent(msg: ServerToClient) {
    switch (msg.type) {
      case "message.delta":
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === msg.messageId);
          if (existing) {
            return prev.map((m) =>
              m.id === msg.messageId ? { ...m, text: m.text + msg.text } : m,
            );
          }
          return [...prev, { id: msg.messageId, role: msg.role, text: msg.text, done: false }];
        });
        break;
      case "message.completed":
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.messageId ? { ...m, done: true } : m)),
        );
        setTool(null);
        break;
      case "tool.update":
        setTool(
          msg.status === "completed"
            ? null
            : `${msg.tool}${msg.summary ? `: ${msg.summary}` : ""}`,
        );
        break;
      case "session.status":
        if (msg.status === "idle") setTool(null);
        break;
      case "error":
        setError(msg.message);
        break;
    }
  }

  const ensureSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const { sessionId: id } = await api.createChatSession(workspace.id);
    setSessionId(id);
    wsRef.current?.subscribe(id);
    return id;
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setError(null);
    setInput("");
    const localId = `local-${Date.now()}`;
    setMessages((prev) => [...prev, { id: localId, role: "user", text, done: true }]);
    try {
      const id = await ensureSession();
      await api.sendChatMessage(workspace.id, { sessionId: id, text });
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="chat">
      {error && <div className="error-banner">{error}</div>}
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <p className="muted">
            Ask the agent to work over your knowledge files, or to build an automation.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.text}
            {!m.done && m.role === "assistant" && <span className="muted"> ▋</span>}
          </div>
        ))}
        {tool && <div className="tool">⚙ {tool}</div>}
      </div>
      <div className="chat-input">
        <textarea
          placeholder={
            workspace.state === "ready"
              ? "Message the agent…"
              : "Sandbox not ready yet"
          }
          value={input}
          disabled={workspace.state !== "ready"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn" onClick={send} disabled={workspace.state !== "ready" || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

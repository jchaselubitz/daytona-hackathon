/**
 * opencode client (D2).
 *
 * Talks to `opencode serve` (contract: listens on OPENCODE_PORT inside the
 * sandbox) over the Daytona **preview URL**. The browser never connects here —
 * only the server does, so the preview token + server password stay server-side.
 *
 * NOTE: opencode's HTTP surface is still settling; the exact request/response
 * shapes below are the ones to confirm during Phase-0 spike S1 and adjust here.
 * Everything funnels through this module so the rest of the server is insulated
 * from those details. `normalizeEvent` maps opencode SSE events to the frozen
 * `ServerToClient` contract.
 */
import type { ServerToClient } from "@app/shared";

export interface OpencodeClientOptions {
  /** Base preview URL for the sandbox's opencode server, e.g. https://<id>-4096.proxy.daytona.io */
  baseUrl: string;
  /** Daytona preview access token (guards the preview proxy). */
  previewToken?: string;
  /** opencode server password (OPENCODE_SERVER_PASSWORD). */
  serverPassword?: string;
}

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(opts: OpencodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = { "content-type": "application/json" };
    if (opts.previewToken) this.headers["x-daytona-preview-token"] = opts.previewToken;
    if (opts.serverPassword) this.headers["authorization"] = `Bearer ${opts.serverPassword}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    // Some endpoints return empty bodies.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Liveness check used by workspace state polling. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/`, { headers: this.headers });
      return res.ok || res.status === 404; // server up even if "/" isn't a route
    } catch {
      return false;
    }
  }

  /** Create a chat session; returns the opencode session id. */
  async createSession(): Promise<string> {
    const out = await this.request<{ id?: string; sessionID?: string }>("POST", "/session", {});
    const id = out?.id ?? out?.sessionID;
    if (!id) throw new Error("opencode createSession returned no id");
    return id;
  }

  /** Send a user prompt to a session. Output streams over /event (see SSE). */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.request("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
      parts: [{ type: "text", text }],
    });
  }

  /**
   * Open the opencode SSE event stream and yield raw parsed events.
   * Caller is responsible for aborting via the AbortSignal.
   */
  async *events(signal: AbortSignal): AsyncGenerator<OpencodeEvent> {
    const res = await fetch(`${this.baseUrl}/event`, { headers: this.headers, signal });
    if (!res.ok || !res.body) {
      throw new Error(`opencode /event -> ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!dataLine) continue;
        try {
          yield JSON.parse(dataLine) as OpencodeEvent;
        } catch {
          // ignore keep-alives / non-JSON frames
        }
      }
    }
  }
}

/** Loosely-typed opencode event (confirm exact shape in spike S1). */
export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Normalize an opencode SSE event to the frozen `ServerToClient` contract.
 * Returns null for events we don't relay. Keep ALL opencode-specific shape
 * knowledge here so the WS relay stays contract-pure.
 */
export function normalizeEvent(ev: OpencodeEvent, sessionId: string): ServerToClient | null {
  const p = (ev.properties ?? ev) as Record<string, unknown>;
  switch (ev.type) {
    case "message.part.updated":
    case "message.delta": {
      const text = (p.text ?? p.delta ?? "") as string;
      const messageId = (p.messageID ?? p.messageId ?? p.id ?? "") as string;
      if (!text) return null;
      return {
        type: "message.delta",
        sessionId,
        messageId,
        role: (p.role as "assistant" | "user") ?? "assistant",
        text,
      };
    }
    case "message.completed":
    case "message.updated": {
      const messageId = (p.messageID ?? p.messageId ?? p.id ?? "") as string;
      return { type: "message.completed", sessionId, messageId };
    }
    case "tool.update":
    case "tool.call": {
      return {
        type: "tool.update",
        sessionId,
        tool: (p.tool ?? p.name ?? "tool") as string,
        status: (p.status as "running" | "completed" | "error") ?? "running",
        summary: p.summary as string | undefined,
      };
    }
    case "session.idle":
      return { type: "session.status", sessionId, status: "idle" };
    case "session.working":
      return { type: "session.status", sessionId, status: "working" };
    default:
      return null;
  }
}

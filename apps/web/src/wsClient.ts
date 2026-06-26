/**
 * WebSocket client (B5). Connects to the server relay, sends `ClientToServer`,
 * receives `ServerToClient`. Auto-reconnects with backoff and re-subscribes to
 * the active session (contract §3).
 */
import type { ClientToServer, ServerToClient } from "@app/shared";

type Listener = (msg: ServerToClient) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscriptions = new Set<string>();
  private closedByUser = false;
  private backoff = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly workspaceId: string) {}

  connect(): void {
    this.closedByUser = false;
    const base = import.meta.env.VITE_WS_URL;
    const url = `${base}?workspaceId=${encodeURIComponent(this.workspaceId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      for (const s of this.subscriptions) this.send({ type: "subscribe", sessionId: s });
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), 25_000);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerToClient;
        for (const l of this.listeners) l(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.closedByUser) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      }
    };
    ws.onerror = () => ws.close();
  }

  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId);
    this.send({ type: "subscribe", sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.send({ type: "unsubscribe", sessionId });
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(msg: ClientToServer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}

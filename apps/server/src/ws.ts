/**
 * WebSocket hub + SSE→WS relay (A7).
 *
 * Browser ⇄ server only (contract §3). For each workspace the hub holds ONE SSE
 * connection to opencode `/event`, normalizes events to `ServerToClient`, and
 * fans them out to the workspace's subscribed browser sockets. The browser never
 * talks to the sandbox.
 */
import type { WebSocket } from "ws";
import type { ClientToServer, ServerToClient } from "@app/shared";
import type { OpencodeClient } from "./opencode.js";
import { normalizeEvent, type OpencodeEvent } from "./opencode.js";

interface ClientConn {
  ws: WebSocket;
  /** Sessions this client subscribed to (contract: subscribe/unsubscribe). */
  sessions: Set<string>;
}

interface Relay {
  abort: AbortController;
}

/** Resolves the opencode client for a workspace (injected to avoid a cycle). */
export type ClientResolver = (workspaceId: string) => Promise<OpencodeClient>;

export class WsHub {
  private readonly clients = new Map<string, Set<ClientConn>>();
  private readonly relays = new Map<string, Relay>();

  constructor(private readonly resolveClient: ClientResolver) {}

  /** Register a new browser socket for a workspace. */
  addClient(workspaceId: string, ws: WebSocket): void {
    const conn: ClientConn = { ws, sessions: new Set() };
    let set = this.clients.get(workspaceId);
    if (!set) {
      set = new Set();
      this.clients.set(workspaceId, set);
    }
    set.add(conn);

    this.send(ws, { type: "connected", workspaceId });

    ws.on("message", (raw) => this.onMessage(workspaceId, conn, raw.toString()));
    ws.on("close", () => this.removeClient(workspaceId, conn));
    ws.on("error", () => this.removeClient(workspaceId, conn));
  }

  private onMessage(workspaceId: string, conn: ClientConn, raw: string): void {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw) as ClientToServer;
    } catch {
      this.send(conn.ws, { type: "error", message: "invalid message JSON" });
      return;
    }
    switch (msg.type) {
      case "subscribe":
        conn.sessions.add(msg.sessionId);
        // Lazily start the per-workspace relay on first interest.
        void this.ensureRelay(workspaceId);
        break;
      case "unsubscribe":
        conn.sessions.delete(msg.sessionId);
        break;
      case "ping":
        this.send(conn.ws, { type: "pong" });
        break;
    }
  }

  private removeClient(workspaceId: string, conn: ClientConn): void {
    const set = this.clients.get(workspaceId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.clients.delete(workspaceId);
      this.stopRelay(workspaceId);
    }
  }

  /** Start the SSE relay for a workspace if not already running. */
  private async ensureRelay(workspaceId: string): Promise<void> {
    if (this.relays.has(workspaceId)) return;
    const abort = new AbortController();
    this.relays.set(workspaceId, { abort });
    try {
      const client = await this.resolveClient(workspaceId);
      void this.pump(workspaceId, client, abort.signal);
    } catch (err) {
      this.relays.delete(workspaceId);
      this.broadcastAll(workspaceId, {
        type: "error",
        message: `relay failed: ${(err as Error).message}`,
      });
    }
  }

  private async pump(
    workspaceId: string,
    client: OpencodeClient,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const ev of client.events(signal)) {
        const out = this.normalize(ev);
        if (out) this.fanout(workspaceId, out);
      }
    } catch (err) {
      if (!signal.aborted) {
        this.broadcastAll(workspaceId, {
          type: "error",
          message: `event stream error: ${(err as Error).message}`,
        });
      }
    } finally {
      this.relays.delete(workspaceId);
    }
  }

  private normalize(ev: OpencodeEvent): ServerToClient | null {
    const p = (ev.properties ?? ev) as Record<string, unknown>;
    const sessionId = (p.sessionID ?? p.sessionId ?? "") as string;
    return normalizeEvent(ev, sessionId);
  }

  /** Send a session-scoped event only to clients subscribed to that session. */
  private fanout(workspaceId: string, msg: ServerToClient): void {
    const set = this.clients.get(workspaceId);
    if (!set) return;
    const sessionId = "sessionId" in msg ? (msg as { sessionId: string }).sessionId : undefined;
    for (const conn of set) {
      if (sessionId && conn.sessions.size > 0 && !conn.sessions.has(sessionId)) continue;
      this.send(conn.ws, msg);
    }
  }

  /** Send to every client of a workspace regardless of subscription. */
  private broadcastAll(workspaceId: string, msg: ServerToClient): void {
    const set = this.clients.get(workspaceId);
    if (!set) return;
    for (const conn of set) this.send(conn.ws, msg);
  }

  private send(ws: WebSocket, msg: ServerToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private stopRelay(workspaceId: string): void {
    const relay = this.relays.get(workspaceId);
    if (relay) {
      relay.abort.abort();
      this.relays.delete(workspaceId);
    }
  }

  /** Tear down all relays (graceful shutdown). */
  shutdown(): void {
    for (const [, relay] of this.relays) relay.abort.abort();
    this.relays.clear();
  }
}

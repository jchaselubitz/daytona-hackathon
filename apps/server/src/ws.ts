/**
 * WebSocket hub (A7).
 *
 * Browser ⇄ server only (contract §3). Codex runs inside the sandbox are
 * launched by HTTP routes; their normalized events are broadcast here.
 */
import type { WebSocket } from "ws";
import type { ClientToServer, ServerToClient } from "@app/shared";

interface ClientConn {
  ws: WebSocket;
  /** Sessions this client subscribed to (contract: subscribe/unsubscribe). */
  sessions: Set<string>;
}

export class WsHub {
  private readonly clients = new Map<string, Set<ClientConn>>();

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
    if (set.size === 0) this.clients.delete(workspaceId);
  }

  /** Send a session-scoped event only to clients subscribed to that session. */
  broadcast(workspaceId: string, msg: ServerToClient): void {
    const set = this.clients.get(workspaceId);
    if (!set) return;
    const sessionId = "sessionId" in msg ? (msg as { sessionId: string }).sessionId : undefined;
    for (const conn of set) {
      if (sessionId && conn.sessions.size > 0 && !conn.sessions.has(sessionId)) continue;
      this.send(conn.ws, msg);
    }
  }

  private send(ws: WebSocket, msg: ServerToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Tear down all relays (graceful shutdown). */
  shutdown(): void {}
}

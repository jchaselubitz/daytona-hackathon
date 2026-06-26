import { useEffect, useState, useCallback } from "react";
import type { Workspace } from "@app/shared";
import { api, ApiClientError } from "./api.js";
import { WorkspaceDetail } from "./components/WorkspaceDetail.js";

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<"ok" | "down" | "checking">("checking");

  const refresh = useCallback(async () => {
    try {
      setWorkspaces(await api.listWorkspaces());
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    api
      .health()
      .then(() => setHealth("ok"))
      .catch(() => setHealth("down"));
    void refresh();
  }, [refresh]);

  // Poll while any workspace is still provisioning.
  useEffect(() => {
    const provisioning = workspaces.some((w) =>
      ["creating", "starting"].includes(w.state),
    );
    if (!provisioning) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [workspaces, refresh]);

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const ws = await api.createWorkspace({ name: newName.trim() });
      setNewName("");
      setSelectedId(ws.id);
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const selected = workspaces.find((w) => w.id === selectedId) ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Agentic Workflows</h1>
          <p>
            Server:{" "}
            <span className={`badge ${health === "ok" ? "connected" : "error"}`}>
              {health === "checking" ? "…" : health === "ok" ? "online" : "offline"}
            </span>
          </p>
        </header>
        <div className="ws-list">
          {workspaces.length === 0 && (
            <p className="muted" style={{ padding: 12 }}>
              No workspaces yet. Create one below.
            </p>
          )}
          {workspaces.map((w) => (
            <div
              key={w.id}
              className={`ws-item ${w.id === selectedId ? "active" : ""}`}
              onClick={() => setSelectedId(w.id)}
            >
              <div>
                <div className="name">{w.name}</div>
                <div className="meta">{new Date(w.createdAt).toLocaleString()}</div>
              </div>
              <span className={`badge ${w.state}`}>{w.state}</span>
            </div>
          ))}
        </div>
        <div className="new-ws">
          <input
            placeholder="New workspace name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <button className="btn" onClick={create} disabled={creating || !newName.trim()}>
            {creating ? "…" : "Create"}
          </button>
        </div>
      </aside>

      <main className="main">
        {error && <div className="error-banner">{error}</div>}
        {selected ? (
          <WorkspaceDetail
            workspace={selected}
            onChanged={refresh}
            onDeleted={() => {
              setSelectedId(null);
              void refresh();
            }}
          />
        ) : (
          <div className="empty">
            <div>
              <h2>Pick or create a workspace</h2>
              <p className="muted">
                Each workspace is a Daytona sandbox with Codex CLI, your knowledge files, and your
                ChatGPT login.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiClientError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

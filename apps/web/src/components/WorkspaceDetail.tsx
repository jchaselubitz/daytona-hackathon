import { useEffect, useRef, useState } from "react";
import type {
  Artifact,
  Automation,
  AutomationRun,
  DesktopInfo,
  FileManifestEntry,
  ServerToClient,
  Workspace,
} from "@app/shared";
import { api } from "../api.js";
import { errMsg } from "../App.js";
import { ChatPanel } from "./ChatPanel.js";

type Tab = "files" | "desktop" | "chat" | "automations" | "settings";

export function WorkspaceDetail({
  workspace,
  onChanged,
  onDeleted,
}: {
  workspace: Workspace;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<Tab>("files");
  const ready = workspace.state === "ready";

  return (
    <div>
      <div className="row spread" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>{workspace.name}</h2>
          <div className="muted mono">
            sandbox {workspace.daytonaSandboxId ?? "—"} · snapshot{" "}
            {workspace.snapshotDigest.slice(0, 16)}
          </div>
        </div>
        <div className="row">
          <span className={`badge ${workspace.state}`}>{workspace.state}</span>
          {workspace.apiKeyConnected && <span className="badge connected">API key</span>}
          <button
            className="btn secondary"
            onClick={async () => {
              await api.deleteWorkspace(workspace.id);
              onDeleted();
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {!ready && (
        <div className="error-banner" style={{ color: "var(--amber)", borderColor: "var(--amber)" }}>
          Sandbox is {workspace.state}. Files and chat become available once it is{" "}
          <strong>ready</strong>.
          {workspace.provisioningError && (
            <div className="mono" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
              {workspace.provisioningError}
            </div>
          )}
        </div>
      )}

      <div className="tabs">
        {(["files", "desktop", "chat", "automations", "settings"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "files" && <FilesPanel workspace={workspace} />}
      {tab === "desktop" && <DesktopPanel workspace={workspace} />}
      {tab === "chat" && <ChatPanel workspace={workspace} />}
      {tab === "automations" && <AutomationsPanel workspace={workspace} />}
      {tab === "settings" && <SettingsPanel workspace={workspace} onChanged={onChanged} />}
    </div>
  );
}

// --------------------------------------------------------------------------
// B3 — Files
// --------------------------------------------------------------------------
function FilesPanel({ workspace }: { workspace: Workspace }) {
  const [files, setFiles] = useState<FileManifestEntry[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => api.listFiles(workspace.id).then(setFiles).catch((e) => setError(errMsg(e)));
  useEffect(() => {
    void load();
  }, [workspace.id]);

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadFiles(workspace.id, Array.from(list));
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Knowledgebase</h3>
      {error && <div className="error-banner">{error}</div>}
      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Uploading…" : "Drag files here, or click to choose. PDFs, docs, data — anything."}
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      <ul className="list" style={{ marginTop: 16 }}>
        {files.length === 0 && <li className="muted">No files uploaded yet.</li>}
        {files.map((f) => (
          <li key={f.id}>
            <span>{f.relPath}</span>
            <span className="muted">
              {prettyBytes(f.size)} · <span className="mono">{f.sha256.slice(0, 8)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --------------------------------------------------------------------------
// Remote desktop — embedded browser-accessible view of the sandbox
// --------------------------------------------------------------------------
function DesktopPanel({ workspace }: { workspace: Workspace }) {
  const [state, setState] = useState<DesktopInfo["state"]>("stopped");
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("https://mail.google.com");
  const [openedUrl, setOpenedUrl] = useState<string | null>(null);
  const [viewKey, setViewKey] = useState(0);
  const ready = workspace.state === "ready";

  // Normalize a typed address into an http(s) URL the sandbox browser accepts.
  const normalizeUrl = (raw: string): string => {
    const v = raw.trim();
    if (!v) return "";
    return /^https?:\/\//i.test(v) ? v : `https://${v}`;
  };

  const refresh = async () => {
    try {
      const d = await api.getDesktop(workspace.id);
      setState(d.state);
      setUrl(d.url);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  useEffect(() => {
    if (!ready) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, ready]);

  // While starting, poll until noVNC reports running.
  useEffect(() => {
    if (state !== "starting") return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, workspace.id]);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const d = await api.startDesktop(workspace.id, normalizeUrl(address) || undefined);
      setState(d.state);
      setUrl(d.url);
      setViewKey((k) => k + 1);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // Open (or navigate to) a URL in the in-sandbox browser; starts the desktop if needed.
  const openUrl = async () => {
    const target = normalizeUrl(address);
    if (!target) return;
    setError(null);
    setBusy(true);
    try {
      const d = await api.openDesktopUrl(workspace.id, target);
      setState(d.state);
      if (!url) setUrl(d.url);
      setOpenedUrl(target);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setError(null);
    setBusy(true);
    try {
      const d = await api.stopDesktop(workspace.id);
      setState(d.state);
      setUrl(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Remote desktop</h3>
        <div className="row">
          <span className={`badge ${state === "running" ? "connected" : "pending"}`}>{state}</span>
          {state === "running" ? (
            <button className="btn secondary" onClick={stop} disabled={busy}>
              {busy ? "…" : "Stop"}
            </button>
          ) : (
            <button className="btn" onClick={start} disabled={!ready || busy || state === "starting"}>
              {busy || state === "starting" ? "Starting…" : "Start desktop"}
            </button>
          )}
        </div>
      </div>
      {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}
      {!ready && <p className="muted">The sandbox must be ready before the desktop can start.</p>}
      {ready && state !== "running" && (
        <p className="muted">
          Start the desktop to take over the workspace browser — open a site, complete logins,
          CAPTCHAs, or MFA, and watch the agent work. No SSH or terminal required.
        </p>
      )}
      {ready && state === "running" && (
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
          Open in browser launches Chromium fullscreen inside the desktop view below.
          {openedUrl && (
            <>
              {" "}
              Last opened: <span className="mono">{openedUrl}</span> — click inside the desktop
              panel if you still see folder icons.
            </>
          )}
        </p>
      )}
      {ready && (
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void openUrl();
            }}
            placeholder="https://mail.google.com"
            style={{ flex: 1 }}
            disabled={busy}
          />
          <button className="btn secondary" onClick={openUrl} disabled={busy || !address.trim()}>
            {busy ? "…" : state === "running" ? "Open in browser" : "Open in desktop"}
          </button>
        </div>
      )}
      {state === "running" && url && (
        <div className="desktop-frame" style={{ marginTop: 12 }}>
          <iframe
            key={viewKey}
            title="Remote desktop"
            src={url}
            allow="clipboard-read; clipboard-write"
            style={{ width: "100%", height: "70vh", border: "1px solid var(--border, #333)", borderRadius: 8 }}
          />
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Settings — OpenAI API key (the only auth path)
// --------------------------------------------------------------------------
function SettingsPanel({ workspace, onChanged }: { workspace: Workspace; onChanged: () => void }) {
  const [connected, setConnected] = useState(workspace.apiKeyConnected);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConnected(workspace.apiKeyConnected);
  }, [workspace.id, workspace.apiKeyConnected]);

  const saveKey = async () => {
    setError(null);
    setSaving(true);
    try {
      await api.setApiKey(workspace.id, apiKey.trim());
      setApiKey("");
      setConnected(true);
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h3>OpenAI API key</h3>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted">
        {connected
          ? "An OpenAI API key is stored for this workspace. The agent uses it to run. Enter a new key below to replace it."
          : "Add an OpenAI API key so the agent can run. It is encrypted at rest and never shown again."}
      </p>
      <div className="row">
        <input
          style={{ flex: 1 }}
          type="password"
          placeholder="sk-…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button className="btn" onClick={saveKey} disabled={!apiKey.trim() || saving}>
          {saving ? "Saving…" : connected ? "Replace key" : "Save key"}
        </button>
      </div>
      {connected && (
        <p style={{ marginTop: 12 }}>
          <span className="badge connected">connected</span> Ready to chat.
        </p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// B6 / B7 / B8 — Automations, runs, artifacts, reproduce
// --------------------------------------------------------------------------
function AutomationsPanel({ workspace }: { workspace: Workspace }) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AutomationRun | null>(null);

  const load = () =>
    api.listAutomations(workspace.id).then(setAutomations).catch((e) => setError(errMsg(e)));
  useEffect(() => {
    void load();
  }, [workspace.id]);

  const run = async (a: Automation, reproduce: boolean) => {
    setError(null);
    try {
      const r = reproduce
        ? await api.reproduceAutomation(workspace.id, a.id, {})
        : await api.runAutomation(workspace.id, a.id, {});
      setActiveRun(r);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <>
      <div className="card">
        <h3>Automations</h3>
        {error && <div className="error-banner">{error}</div>}
        <ul className="list">
          {automations.length === 0 && (
            <li className="muted">
              No automations yet. Ask the agent in Chat to build one — it gets captured here.
            </li>
          )}
          {automations.map((a) => (
            <li key={a.id}>
              <div>
                <div>
                  <strong>{a.name}</strong> <span className="muted">{a.version}</span>
                </div>
                <div className="muted mono">{a.entrypoint}</div>
              </div>
              <div className="row">
                <button className="btn" onClick={() => run(a, false)}>
                  Run
                </button>
                <button className="btn secondary" onClick={() => run(a, true)}>
                  Reproduce
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {activeRun && <RunPanel runId={activeRun.id} />}
    </>
  );
}

function RunPanel({ runId }: { runId: string }) {
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.getRun(runId);
        if (stop) return;
        setRun(r);
        if (r.status === "succeeded" || r.status === "failed") {
          setArtifacts(await api.listRunArtifacts(runId));
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!stop) setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [runId]);

  return (
    <div className="card">
      <h3>
        Run <span className="mono">{runId.slice(0, 8)}</span>{" "}
        {run && <span className={`badge ${run.status}`}>{run.status}</span>}
      </h3>
      <ul className="list">
        {artifacts.length === 0 && <li className="muted">Waiting for artifacts…</li>}
        {artifacts.map((a) => (
          <li key={a.id}>
            <span>{a.relPath}</span>
            <a className="btn secondary" href={api.downloadArtifactUrl(a.id)} download>
              Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export type { ServerToClient };

import { useEffect, useRef, useState } from "react";
import type {
  Artifact,
  Automation,
  AutomationRun,
  FileManifestEntry,
  ServerToClient,
  Workspace,
} from "@app/shared";
import { api } from "../api.js";
import { errMsg } from "../App.js";
import { ChatPanel } from "./ChatPanel.js";

type Tab = "files" | "connect" | "chat" | "automations";

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
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const ready = workspace.state === "ready";
  const canRetry = ["error", "creating", "starting"].includes(workspace.state);

  const retryProvision = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryWorkspaceProvision(workspace.id);
      onChanged();
    } catch (e) {
      setRetryError(errMsg(e));
    } finally {
      setRetrying(false);
    }
  };

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
          {workspace.chatgptConnected && <span className="badge connected">ChatGPT</span>}
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
          <div className="row spread">
            <div>
              Sandbox is {workspace.state}. Files and chat become available once it is{" "}
              <strong>ready</strong>.
            </div>
            {canRetry && (
              <button className="btn secondary" onClick={retryProvision} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry"}
              </button>
            )}
          </div>
          {retryError && <div className="muted" style={{ marginTop: 8 }}>{retryError}</div>}
        </div>
      )}

      <div className="tabs">
        {(["files", "connect", "chat", "automations"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "files" && <FilesPanel workspace={workspace} />}
      {tab === "connect" && <ConnectPanel workspace={workspace} onChanged={onChanged} />}
      {tab === "chat" && <ChatPanel workspace={workspace} />}
      {tab === "automations" && <AutomationsPanel workspace={workspace} />}
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
// B4 — Connect ChatGPT
// --------------------------------------------------------------------------
function ConnectPanel({ workspace, onChanged }: { workspace: Workspace; onChanged: () => void }) {
  const [verification, setVerification] = useState<{ url?: string; code?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    try {
      const res = await api.startChatGptConnect(workspace.id);
      setVerification({ url: res.verificationUrl, code: res.userCode });
      setPending(true);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // Poll status while pending.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      try {
        const s = await api.chatGptConnectStatus(workspace.id);
        if (s.connected) {
          setPending(false);
          setVerification(null);
          onChanged();
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pending, workspace.id, onChanged]);

  const saveKey = async () => {
    setError(null);
    try {
      await api.setApiKey(workspace.id, apiKey.trim());
      setApiKey("");
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  if (workspace.chatgptConnected) {
    return (
      <div className="card">
        <h3>Model access</h3>
        <p>
          <span className="badge connected">connected</span> This workspace can talk to the model.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h3>Connect ChatGPT</h3>
        {error && <div className="error-banner">{error}</div>}
        {!verification ? (
          <button className="btn" onClick={start} disabled={workspace.state !== "ready"}>
            Start ChatGPT login
          </button>
        ) : (
          <div>
            <p>1. Open this page in your browser:</p>
            <p>
              <a href={verification.url} target="_blank" rel="noreferrer">
                {verification.url}
              </a>
            </p>
            <p>2. Enter this code:</p>
            <div className="code-box">{verification.code ?? "—"}</div>
            <p className="muted" style={{ marginTop: 12 }}>
              Waiting for you to approve… <span className="badge pending">pending</span>
            </p>
          </div>
        )}
      </div>
      <div className="card">
        <h3>Or use an OpenAI API key</h3>
        <div className="row">
          <input
            style={{ flex: 1 }}
            type="password"
            placeholder="sk-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button className="btn secondary" onClick={saveKey} disabled={!apiKey.trim()}>
            Save key
          </button>
        </div>
      </div>
    </>
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

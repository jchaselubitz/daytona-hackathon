/**
 * Codex CLI runner.
 *
 * Codex does not expose the HTTP/SSE server this app used
 * before. The control plane runs `codex exec` inside the Daytona sandbox and
 * relays the final assistant response through the existing browser WebSocket
 * contract.
 */
import type { Sandbox } from "@daytona/sdk";
import { SANDBOX_PATHS, type ServerToClient } from "@app/shared";
import { randomUUID } from "node:crypto";
import type { WsHub } from "./ws.js";

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

const histories = new Map<string, ChatTurn[]>();

export function createCodexChatSession(): string {
  const id = randomUUID();
  histories.set(id, []);
  return id;
}

export async function runCodexChatMessage(opts: {
  workspaceId: string;
  sessionId: string;
  sandbox: Sandbox;
  hub: WsHub;
  text: string;
}): Promise<void> {
  const { workspaceId, sessionId, sandbox, hub, text } = opts;
  const messageId = randomUUID();
  const runId = randomUUID();
  const base = `/tmp/codex-chat-${runId}`;
  const promptPath = `${base}.prompt.txt`;
  const responsePath = `${base}.response.txt`;
  const logPath = `${base}.log`;
  const statusPath = `${base}.status`;

  logChat("message received", {
    workspaceId,
    sessionId,
    runId,
    promptPath,
    responsePath,
    logPath,
    statusPath,
  });

  const history = histories.get(sessionId) ?? [];
  histories.set(sessionId, history);
  history.push({ role: "user", text });

  const prompt = buildPrompt(history);
  await sandbox.fs.uploadFile(Buffer.from(prompt), promptPath);
  logChat("prompt uploaded", { workspaceId, sessionId, runId, bytes: Buffer.byteLength(prompt) });

  emit(hub, workspaceId, { type: "session.status", sessionId, status: "working" });
  emit(hub, workspaceId, {
    type: "tool.update",
    sessionId,
    tool: "codex",
    status: "running",
    summary: "starting in the workspace sandbox",
  });

  void waitForCodexResult({
    workspaceId,
    sessionId,
    messageId,
    sandbox,
    hub,
    history,
    responsePath,
    logPath,
    statusPath,
    runId,
  });

  const shell = [
    `rm -f ${sh(responsePath)} ${sh(logPath)} ${sh(statusPath)}`,
    "(",
    `mkdir -p ${sh(SANDBOX_PATHS.codexHome)}`,
    ";",
    `if [ -f ${sh(SANDBOX_PATHS.codexApiKey)} ]; then export OPENAI_API_KEY="$(cat ${sh(
      SANDBOX_PATHS.codexApiKey,
    )})"; fi`,
    ";",
    `if [ -z "${"$"}OPENAI_API_KEY" ]; then echo "No OpenAI API key for this workspace. Add one under Settings." > ${sh(
      logPath,
    )}; printf "%s" "2" > ${sh(statusPath)}; exit 0; fi`,
    ";",
    `CODEX_HOME=${sh(SANDBOX_PATHS.codexHome)} codex exec`,
    "--skip-git-repo-check",
    "--sandbox workspace-write",
    `-C ${sh(SANDBOX_PATHS.root)}`,
    `-o ${sh(responsePath)}`,
    `- < ${sh(promptPath)} > ${sh(logPath)} 2>&1`,
    ";",
    "code=$?",
    ";",
    `printf "%s" "$code" > ${sh(statusPath)}`,
    ")",
  ].join(" ");

  try {
    await withTimeout(
      sandbox.process.createSession(sessionId).catch((err: unknown) => {
        logChat("create session failed or already exists", { workspaceId, sessionId, runId, err });
      }),
      10_000,
      "create Daytona process session",
    );
    logChat("session ready; launching command", { workspaceId, sessionId, runId });

    const launch = await withTimeout(
      sandbox.process.executeSessionCommand(sessionId, { command: shell, runAsync: true }),
      15_000,
      "launch Codex command in Daytona session",
    );
    logChat("command launch returned", {
      workspaceId,
      sessionId,
      runId,
      commandId: launch.cmdId,
      exitCode: launch.exitCode,
      output: summarizeLogs([launch.output, launch.stdout, launch.stderr].filter(Boolean).join("\n")),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logChat("command launch failed", { workspaceId, sessionId, runId, err });
    await sandbox.fs
      .uploadFile(Buffer.from(`Failed to launch Codex in Daytona: ${message}`), logPath)
      .catch((uploadErr: unknown) =>
        logChat("failed to write launch failure log", {
          workspaceId,
          sessionId,
          runId,
          err: uploadErr,
        }),
      );
    await sandbox.fs
      .uploadFile(Buffer.from("1"), statusPath)
      .catch((uploadErr: unknown) =>
        logChat("failed to write launch failure status", {
          workspaceId,
          sessionId,
          runId,
          err: uploadErr,
        }),
      );
  }
}

function buildPrompt(history: ChatTurn[]): string {
  const transcript = history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}:\n${turn.text}`)
    .join("\n\n");

  return [
    "You are operating inside /workspace for a web user.",
    "Use /workspace/knowledge for uploaded source files.",
    "When creating reusable automations, place source under /workspace/automations and outputs under /workspace/artifacts.",
    "Keep the final answer concise and focused on what changed or what you found.",
    "",
    "Conversation so far:",
    transcript,
  ].join("\n");
}

async function waitForCodexResult(opts: {
  workspaceId: string;
  sessionId: string;
  messageId: string;
  sandbox: Sandbox;
  hub: WsHub;
  history: ChatTurn[];
  responsePath: string;
  logPath: string;
  statusPath: string;
  runId: string;
}): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let exitCode: string | null = null;
  let lastSummary: string | null = null;
  let lastHeartbeat = 0;
  logChat("poller started", {
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    runId: opts.runId,
  });
  while (Date.now() < deadline) {
    exitCode = await readText(opts.sandbox, opts.statusPath);
    if (exitCode !== null) break;
    const summary = summarizeLogs(await readText(opts.sandbox, opts.logPath));
    if (summary && summary !== lastSummary) {
      lastSummary = summary;
      logChat("log summary updated", {
        workspaceId: opts.workspaceId,
        sessionId: opts.sessionId,
        runId: opts.runId,
        summary,
      });
      emit(opts.hub, opts.workspaceId, {
        type: "tool.update",
        sessionId: opts.sessionId,
        tool: "codex",
        status: "running",
        summary,
      });
    }
    if (Date.now() - lastHeartbeat > 15_000) {
      lastHeartbeat = Date.now();
      logChat("still waiting for status file", {
        workspaceId: opts.workspaceId,
        sessionId: opts.sessionId,
        runId: opts.runId,
        logPath: opts.logPath,
        statusPath: opts.statusPath,
        lastSummary,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const response = (await readText(opts.sandbox, opts.responsePath))?.trim();
  const logs = (await readText(opts.sandbox, opts.logPath))?.trim();
  const ok = exitCode?.trim() === "0";
  logChat("poller finished", {
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    runId: opts.runId,
    exitCode,
    ok,
    responseBytes: response ? Buffer.byteLength(response) : 0,
    logBytes: logs ? Buffer.byteLength(logs) : 0,
  });
  const text = response || (ok ? "Codex finished without a final message." : formatFailure(logs, exitCode));

  if (ok && response) {
    opts.history.push({ role: "assistant", text: response });
  }

  emit(opts.hub, opts.workspaceId, {
    type: "message.delta",
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    role: "assistant",
    text,
  });
  emit(opts.hub, opts.workspaceId, {
    type: "message.completed",
    sessionId: opts.sessionId,
    messageId: opts.messageId,
  });
  emit(opts.hub, opts.workspaceId, {
    type: "tool.update",
    sessionId: opts.sessionId,
    tool: "codex",
    status: ok ? "completed" : "error",
  });
  emit(opts.hub, opts.workspaceId, {
    type: "session.status",
    sessionId: opts.sessionId,
    status: "idle",
  });
}

async function readText(sandbox: Sandbox, path: string): Promise<string | null> {
  try {
    return (await sandbox.fs.downloadFile(path)).toString("utf8");
  } catch {
    return null;
  }
}

function formatFailure(logs?: string, exitCode?: string | null): string {
  const tail = logs ? redact(stripTerminalControls(logs)).slice(-3000) : "No Codex logs were captured.";
  const reason = exitCode === null ? "Codex timed out in the sandbox." : "Codex failed in the sandbox.";
  return `${reason}\n\n${tail}`;
}

function emit(hub: WsHub, workspaceId: string, msg: ServerToClient): void {
  hub.broadcast(workspaceId, msg);
}

function summarizeLogs(logs: string | null): string | null {
  if (!logs) return null;
  const clean = redact(stripTerminalControls(logs))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!clean) return null;
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

function stripTerminalControls(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function redact(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-REDACTED");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logChat(message: string, fields: Record<string, unknown>): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
    ]),
  );
  console.info(`[codex-chat] ${message}`, safeFields);
}

function sh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

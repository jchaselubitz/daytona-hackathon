/**
 * Daytona lifecycle service (A4) + sandbox interaction helpers.
 *
 * Wraps `@daytona/sdk`. Responsible for: creating a sandbox from the pinned
 * snapshot (reproducibility anchor), starting `opencode serve`, exposing it via
 * a preview URL, file hydration, and command execution for automations.
 *
 * The snapshot/preview details that need a live spike (S1) are isolated here.
 */
import { Daytona, type Sandbox } from "@daytona/sdk";
import { SANDBOX_PATHS, OPENCODE_PORT } from "@app/shared";
import { loadEnv } from "./env.js";
import { OpencodeClient } from "./opencode.js";

let client: Daytona | null = null;

export function getDaytona(): Daytona {
  if (!client) {
    const env = loadEnv();
    if (!env.daytona.apiKey) {
      throw new Error("DAYTONA_API_KEY is not set; cannot reach Daytona.");
    }
    client = new Daytona({ apiKey: env.daytona.apiKey, apiUrl: env.daytona.apiUrl });
  }
  return client;
}

/** Label we stamp on our sandboxes so they're identifiable in Daytona. */
const APP_LABEL = "daytona-agentic-workflows";

/**
 * Create a sandbox from the pinned snapshot. Returns the live Sandbox.
 * The snapshot MUST already contain node, python3+pip, opencode, and PDF tools
 * (built by infra/snapshot — Phase-0 spike S1 / step C2).
 */
export async function createSandbox(name: string): Promise<Sandbox> {
  const env = loadEnv();
  const snapshot = env.daytona.snapshot;
  if (!snapshot) {
    throw new Error(
      "DAYTONA_SNAPSHOT is not set. Build infra/snapshot, record its digest, and set " +
        "DAYTONA_SNAPSHOT + DAYTONA_SNAPSHOT_DIGEST in .env (checklist C2).",
    );
  }
  const sandbox = await getDaytona().create(
    {
      snapshot,
      name: `ws-${name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      labels: { app: APP_LABEL },
      // Generous idle window so a user can step away mid-session.
      autoStopInterval: 60,
      public: false,
      envVars: {
        OPENCODE_SERVER_PASSWORD: env.opencodeServerPassword,
        ...(env.openaiApiKey ? { OPENAI_API_KEY: env.openaiApiKey } : {}),
      },
    },
    { timeout: 120 },
  );
  return sandbox;
}

export async function getSandbox(sandboxId: string): Promise<Sandbox> {
  return getDaytona().get(sandboxId);
}

export async function deleteSandbox(sandboxId: string): Promise<void> {
  const sandbox = await getDaytona().get(sandboxId);
  await getDaytona().delete(sandbox);
}

/** Ensure the canonical workspace directories exist inside the sandbox. */
export async function ensureWorkspaceDirs(sandbox: Sandbox): Promise<void> {
  for (const dir of [
    SANDBOX_PATHS.knowledge,
    SANDBOX_PATHS.automations,
    SANDBOX_PATHS.artifacts,
  ]) {
    await sandbox.fs.createFolder(dir, "755").catch(() => {
      /* already exists */
    });
  }
}

const OPENCODE_SESSION = "opencode-serve";

/**
 * Launch `opencode serve` as a background session command. Idempotent-ish:
 * recreating the session is harmless if it already runs.
 */
export async function startOpencodeServe(sandbox: Sandbox): Promise<void> {
  const hasOpencode = await sandbox.process.executeCommand("command -v opencode");
  if ((hasOpencode.exitCode ?? 0) !== 0) {
    throw new Error(
      `opencode is not available in sandbox ${sandbox.id}; check the DAYTONA_SNAPSHOT image. ` +
        `Output: ${(hasOpencode.result ?? "").slice(0, 500)}`,
    );
  }
  await sandbox.process.createSession(OPENCODE_SESSION).catch(() => {
    /* session may already exist */
  });
  await sandbox.process.executeSessionCommand(OPENCODE_SESSION, {
    command: `opencode serve --hostname 0.0.0.0 --port ${OPENCODE_PORT}`,
    runAsync: true,
  });
}

/** Build an opencode client bound to this sandbox's preview URL. */
export async function getOpencodeClient(sandbox: Sandbox): Promise<OpencodeClient> {
  const env = loadEnv();
  const preview = await sandbox.getPreviewLink(OPENCODE_PORT);
  return new OpencodeClient({
    baseUrl: preview.url,
    previewToken: preview.token,
    serverPassword: env.opencodeServerPassword,
  });
}

/** Poll opencode health until ready or timeout. Returns true if ready. */
export async function waitForOpencode(sandbox: Sandbox, timeoutMs = 60_000): Promise<boolean> {
  const client = await getOpencodeClient(sandbox);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.health()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Run a command in the sandbox, returning exit code + combined output. */
export async function exec(
  sandbox: Sandbox,
  command: string,
  cwd?: string,
): Promise<{ exitCode: number; output: string }> {
  const res = await sandbox.process.executeCommand(command, cwd);
  return { exitCode: res.exitCode ?? 0, output: res.result ?? "" };
}

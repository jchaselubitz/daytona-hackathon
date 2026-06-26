/**
 * Daytona lifecycle service (A4) + sandbox interaction helpers.
 *
 * Wraps `@daytona/sdk`. Responsible for: creating a sandbox from the pinned
 * snapshot (reproducibility anchor), verifying Codex CLI availability, file
 * hydration, and command execution for automations.
 *
 * The snapshot/preview details that need a live spike (S1) are isolated here.
 */
import { Daytona, type Sandbox } from "@daytona/sdk";
import { SANDBOX_PATHS } from "@app/shared";
import { loadEnv } from "./env.js";

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
 * The snapshot MUST already contain node, python3+pip, Codex CLI, and PDF tools
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
  const dirs = [SANDBOX_PATHS.knowledge, SANDBOX_PATHS.automations, SANDBOX_PATHS.artifacts];
  const mkdir = `mkdir -p ${dirs.join(" ")}`;
  let result = await exec(sandbox, mkdir);

  if (result.exitCode !== 0) {
    result = await exec(sandbox, `sudo -n ${mkdir}`);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `failed to create sandbox workspace directories (${dirs.join(", ")}): ${result.output}`,
    );
  }

  const chmod = `chmod 777 ${dirs.join(" ")}`;
  result = await exec(sandbox, chmod);
  if (result.exitCode !== 0) {
    result = await exec(sandbox, `sudo -n ${chmod}`);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `failed to make sandbox workspace directories writable (${dirs.join(", ")}): ${
        result.output
      }`,
    );
  }

  const verify = await exec(sandbox, `test -d ${dirs.join(" && test -d ")}`);
  if (verify.exitCode !== 0) {
    throw new Error(
      `sandbox workspace directories are missing after creation (${dirs.join(", ")}): ${
        verify.output
      }`,
    );
  }
}

/** Verify Codex CLI exists in the sandbox and can run as the workspace agent. */
export async function verifyCodexCli(sandbox: Sandbox): Promise<void> {
  const result = await exec(
    sandbox,
    `mkdir -p ${SANDBOX_PATHS.codexHome} && codex --version`,
    SANDBOX_PATHS.root,
  );
  if (result.exitCode !== 0) {
    throw new Error(`codex CLI is not available in the sandbox: ${result.output}`);
  }
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

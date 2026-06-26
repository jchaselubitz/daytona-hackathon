/**
 * Typed environment loader. Names are frozen in `.env.example`
 * (see docs/code-contract.md §7). Secrets here are read ONLY by the server and
 * never serialized to the browser.
 */

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got "${v}"`);
  return n;
}

export interface Env {
  nodeEnv: string;
  serverPort: number;
  webOrigin: string;
  databaseUrl: string;
  storageDriver: "fs" | "minio" | "s3";
  storageFsRoot: string;
  daytona: {
    apiKey: string;
    apiUrl: string;
    snapshot: string; // snapshot name
    snapshotDigest: string; // pinned digest (reproducibility anchor)
  };
  opencodeServerPassword: string;
  openaiApiKey: string; // optional fallback
  authEncryptionKey: string; // base64, 32 bytes
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = {
    nodeEnv: optional("NODE_ENV", "development"),
    serverPort: int("SERVER_PORT", 8080),
    webOrigin: optional("WEB_ORIGIN", "http://localhost:5173"),
    databaseUrl: required("DATABASE_URL"),
    storageDriver: (optional("STORAGE_DRIVER", "fs") as Env["storageDriver"]),
    storageFsRoot: optional("STORAGE_FS_ROOT", "/data/storage"),
    daytona: {
      apiKey: optional("DAYTONA_API_KEY"),
      apiUrl: optional("DAYTONA_API_URL", "https://app.daytona.io/api"),
      snapshot: optional("DAYTONA_SNAPSHOT"),
      snapshotDigest: optional("DAYTONA_SNAPSHOT_DIGEST"),
    },
    opencodeServerPassword: optional("OPENCODE_SERVER_PASSWORD", "change-me-please"),
    openaiApiKey: optional("OPENAI_API_KEY"),
    authEncryptionKey: optional("AUTH_ENCRYPTION_KEY"),
  };
  return cached;
}

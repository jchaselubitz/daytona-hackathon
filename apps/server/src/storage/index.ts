/**
 * Storage factory. Returns the configured adapter; callers depend only on the
 * `Storage` interface from the contract so adapters swap without code changes.
 */
import type { Storage } from "@app/shared";
import { loadEnv } from "../env.js";
import { FsStorage } from "./fs.js";

let instance: Storage | null = null;

export function getStorage(): Storage {
  if (instance) return instance;
  const env = loadEnv();
  switch (env.storageDriver) {
    case "fs":
      instance = new FsStorage(env.storageFsRoot);
      break;
    case "minio":
    case "s3":
      // Drop-in point for an S3/MinIO adapter (contract §5). Not in MVP scope.
      throw new Error(
        `STORAGE_DRIVER="${env.storageDriver}" not implemented yet; use "fs" for MVP.`,
      );
    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${env.storageDriver}`);
  }
  return instance;
}

export { FsStorage };

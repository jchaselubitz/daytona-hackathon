/**
 * Filesystem Storage adapter (A3) implementing the `Storage` contract.
 *
 * Keys are opaque, server-chosen, slash-delimited (e.g. "files/<ws>/<sha>").
 * They map to paths under STORAGE_FS_ROOT. `signedDownloadUrl` returns a
 * server-proxied API URL because the FS adapter has no presigning — swapping in
 * MinIO/S3 later changes only this file (contract §5).
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Storage, StoragePutOptions } from "@app/shared";
import { API_BASE } from "@app/shared";

/** Sidecar file holding the content type for a stored object. */
const META_SUFFIX = ".meta.json";

export class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    // Prevent path traversal: resolve and assert it stays under root.
    const resolved = path.resolve(this.root, key);
    const rootResolved = path.resolve(this.root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return resolved;
  }

  async put(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
    opts?: StoragePutOptions,
  ): Promise<void> {
    const dest = this.abs(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    await pipeline(source, createWriteStream(dest));
    if (opts?.contentType) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(dest + META_SUFFIX, JSON.stringify({ contentType: opts.contentType }));
    }
  }

  async get(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.abs(key));
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const s = await stat(this.abs(key));
      let contentType: string | undefined;
      try {
        const { readFile } = await import("node:fs/promises");
        const meta = JSON.parse(await readFile(this.abs(key) + META_SUFFIX, "utf8"));
        contentType = meta.contentType;
      } catch {
        // no sidecar; leave contentType undefined
      }
      return { size: s.size, contentType };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.abs(key), { force: true });
    await rm(this.abs(key) + META_SUFFIX, { force: true });
  }

  async signedDownloadUrl(key: string): Promise<string> {
    // FS has no real presigning; the server proxies bytes through the API.
    // Callers pass artifact storage keys; the download route resolves them.
    return `${API_BASE}/storage/${encodeURIComponent(key)}`;
  }
}

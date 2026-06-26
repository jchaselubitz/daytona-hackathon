/**
 * Route helpers shared by client + server.
 *
 * `ROUTES` entries are "METHOD /path/:param" strings. These helpers parse them
 * and build concrete paths so the web client and the server router agree on the
 * exact same shape without re-stating routes.
 */
import { ROUTES } from "./contract.js";

export type RouteKey = keyof typeof ROUTES;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ParsedRoute {
  method: HttpMethod;
  path: string; // e.g. "/api/workspaces/:id/files"
}

/** Split a "METHOD /path" entry into its parts. */
export function parseRoute(key: RouteKey): ParsedRoute {
  const raw = ROUTES[key];
  const spaceIdx = raw.indexOf(" ");
  const method = raw.slice(0, spaceIdx) as HttpMethod;
  const path = raw.slice(spaceIdx + 1);
  return { method, path };
}

/**
 * Build a concrete path for a route, substituting `:param` segments.
 * Throws if a required param is missing so drift surfaces immediately.
 */
export function buildPath(key: RouteKey, params: Record<string, string> = {}): string {
  const { path } = parseRoute(key);
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing route param "${name}" for ${key} (${path})`);
    }
    return encodeURIComponent(value);
  });
}

/** All route keys, handy for registering a server router from the contract. */
export const ROUTE_KEYS = Object.keys(ROUTES) as RouteKey[];

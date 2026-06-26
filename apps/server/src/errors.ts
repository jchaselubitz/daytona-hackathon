/**
 * Error helpers that produce the `ApiError` envelope from the contract.
 * Throw `HttpError` anywhere; the Fastify error handler serializes it.
 */
import type { ApiError } from "@app/shared";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toEnvelope(): ApiError {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, "bad_request", msg, details);
export const notFound = (msg: string) => new HttpError(404, "not_found", msg);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);
export const failedDependency = (code: string, msg: string, details?: unknown) =>
  new HttpError(424, code, msg, details);
export const internal = (msg: string, details?: unknown) =>
  new HttpError(500, "internal", msg, details);
export const notImplemented = (msg: string) => new HttpError(501, "not_implemented", msg);

/**
 * @app/shared — public entrypoint.
 *
 * The single source of truth for the seams between apps/web, apps/server, and
 * infra. Import from "@app/shared"; never redefine these types in consumers.
 */
export * from "./contract.js";
export * from "./routes.js";

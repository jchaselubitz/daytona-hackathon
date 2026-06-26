/**
 * Chat service (A7). Queues Codex CLI work in the sandbox; output streams over
 * ws.ts, not the HTTP response. `sendMessage` returns 202 at the route.
 */
import { createCodexChatSession, runCodexChatMessage } from "../codex.js";
import type { WsHub } from "../ws.js";
import { sandboxForWorkspace } from "./workspaces.js";

export async function createChatSession(_workspaceId: string): Promise<string> {
  return createCodexChatSession();
}

export async function sendChatMessage(
  workspaceId: string,
  sessionId: string,
  text: string,
  hub: WsHub,
): Promise<void> {
  const sandbox = await sandboxForWorkspace(workspaceId);
  await runCodexChatMessage({ workspaceId, sessionId, sandbox, hub, text });
}

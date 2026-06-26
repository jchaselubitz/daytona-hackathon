/**
 * Chat service (A7). Thin pass-through to opencode; output streams over the WS
 * relay (ws.ts), not the HTTP response. `sendMessage` returns 202 at the route.
 */
import { opencodeClientForWorkspace } from "./workspaces.js";

export async function createChatSession(workspaceId: string): Promise<string> {
  const client = await opencodeClientForWorkspace(workspaceId);
  return client.createSession();
}

export async function sendChatMessage(
  workspaceId: string,
  sessionId: string,
  text: string,
): Promise<void> {
  const client = await opencodeClientForWorkspace(workspaceId);
  await client.sendMessage(sessionId, text);
}

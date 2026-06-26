/**
 * Remote desktop service.
 *
 * Turns a workspace's Daytona sandbox into a browser-accessible desktop with no
 * SSH or terminal. Daytona's computer-use stack (Xvfb + xfce4 + x11vnc + noVNC)
 * runs inside the sandbox; we expose its noVNC port as a signed preview URL the
 * web app embeds in an <iframe>. The same desktop backs agent computer-use and
 * human takeover, so what the agent sees is what the user sees.
 *
 * computer-use only brings up the bare XFCE desktop — by itself the user just
 * sees desktop icons, not a browser. So on start we also launch a real browser
 * (Chromium) on the virtual display, with a profile on the persistent volume so
 * logins (Gmail, etc.) survive sandbox restarts.
 */
import type { DesktopInfo, DesktopState } from "@app/shared";
import { DESKTOP_DEFAULT_URL, SANDBOX_PATHS } from "@app/shared";
import { getSandbox, exec, ensureWorkspaceDirs } from "../daytona.js";
import { getWorkspaceRow } from "./workspaces.js";
import { desktopPreviewEmbedUrl } from "./desktop-preview-proxy.js";
import { failedDependency, notFound, badRequest } from "../errors.js";
import type { Sandbox } from "@daytona/sdk";

async function sandboxFor(workspaceId: string): Promise<Sandbox> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.daytona_sandbox_id) throw notFound(`workspace ${workspaceId} has no sandbox yet`);
  return getSandbox(ws.daytona_sandbox_id);
}

/** Map Daytona's computer-use status string to our coarse desktop state. */
function toState(status: string | undefined): DesktopState {
  if (status === "active" || status === "running") return "running";
  if (status === "starting") return "starting";
  return "stopped";
}

/** Reject anything that isn't a plain http(s) URL so it's safe to drop into a shell. */
function safeUrl(url: string | undefined): string {
  const candidate = (url ?? "").trim() || DESKTOP_DEFAULT_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw badRequest(`Not a valid URL: ${candidate}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("Only http(s) URLs can be opened in the desktop browser.");
  }
  // URL has already validated/encoded the value; single-quote for the shell.
  return parsed.toString();
}

/**
 * Launch (or, if already running, navigate) Chromium on the virtual display.
 *
 * Best-effort: detects the X display the computer-use stack created, picks an
 * installed Chromium/Chrome binary (installing Chromium if the snapshot predates
 * the browser), and opens the URL. Running Chromium again against the same
 * --user-data-dir reuses the live instance, so this doubles as "open this URL".
 */
async function launchBrowser(sandbox: Sandbox, url: string): Promise<void> {
  await ensureWorkspaceDirs(sandbox);
  const profileDir = SANDBOX_PATHS.browserProfile;
  const script = `
set -e
pick_display() {
  for sock in /tmp/.X11-unix/X*; do
    [ -S "$sock" ] || continue
    d=":\${sock##*/X}"
    DISPLAY=$d xset q >/dev/null 2>&1 && { echo "$d"; return 0; }
  done
  echo ":0"
}
export DISPLAY=$(pick_display)

find_browser() {
  for b in chromium chromium-browser google-chrome google-chrome-stable; do
    command -v "$b" >/dev/null 2>&1 && { echo "$b"; return 0; }
  done
  return 1
}

BROWSER=$(find_browser) || true
if [ -z "$BROWSER" ]; then
  (sudo -n apt-get update -y && sudo -n apt-get install -y --no-install-recommends chromium) \
    >/tmp/browser-install.log 2>&1 \
    || (apt-get update -y && apt-get install -y --no-install-recommends chromium) \
    >>/tmp/browser-install.log 2>&1 || true
  BROWSER=$(find_browser) || true
fi
if [ -z "$BROWSER" ]; then
  echo "no-browser" >&2
  exit 3
fi

mkdir -p ${profileDir} 2>/dev/null || sudo -n mkdir -p ${profileDir}
chmod 777 ${profileDir} 2>/dev/null || sudo -n chmod 777 ${profileDir} || true

# --start-maximized is unreliable under Xvfb/xfce; size the window to the virtual screen.
SCREEN_DIMS=$(xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2}')
SCREEN_W=$(echo "$SCREEN_DIMS" | cut -dx -f1)
SCREEN_H=$(echo "$SCREEN_DIMS" | cut -dx -f2)
SCREEN_W=\${SCREEN_W:-1024}
SCREEN_H=\${SCREEN_H:-768}

# A stale Chromium frame can hide behind the XFCE desktop — restart cleanly.
pkill -f "user-data-dir=${profileDir}" 2>/dev/null || true
pkill -x Thunar 2>/dev/null || true
sleep 0.4
rm -f ${profileDir}/SingletonLock ${profileDir}/SingletonSocket 2>/dev/null || true

# --no-sandbox: Chromium's own sandbox can't nest inside the Daytona sandbox.
# --kiosk fills the virtual screen so the browser is not hidden under XFCE icons.
nohup "$BROWSER" \
  --kiosk \
  --no-sandbox --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage --disable-gpu \
  --user-data-dir=${profileDir} \
  '${url}' >/tmp/browser.log 2>&1 &

sleep 2

if ! command -v xdotool >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends xdotool >/tmp/xdotool-install.log 2>&1 \
    || sudo -n apt-get install -y --no-install-recommends xdotool >>/tmp/xdotool-install.log 2>&1 \
    || true
fi

FOCUSED=0
if command -v xdotool >/dev/null 2>&1; then
  for wid in $(xdotool search --class chromium 2>/dev/null); do
    eval "$(xdotool getwindowgeometry --shell "$wid" 2>/dev/null)" || continue
    if [ "\${WIDTH:-0}" -gt 400 ] 2>/dev/null; then
      xdotool windowactivate --sync "$wid" 2>/dev/null || true
      xdotool windowraise "$wid" 2>/dev/null || true
      FOCUSED=1
    fi
  done
fi

BEST_W=0
for wid in $(DISPLAY=$DISPLAY xwininfo -root -tree 2>/dev/null | awk '/Chromium/{gsub(/,/,"",$1); print $1}'); do
  w=$(DISPLAY=$DISPLAY xwininfo -id "$wid" 2>/dev/null | awk '/Width:/{print $2}')
  if [ -n "$w" ] && [ "$w" -gt "$BEST_W" ] 2>/dev/null; then BEST_W=$w; fi
done
if [ "$BEST_W" -gt 400 ] 2>/dev/null; then
  echo "browser-running $BROWSER on $DISPLAY (\${BEST_W}px wide, focused=\${FOCUSED})"
  exit 0
fi
if pgrep -f "user-data-dir=${profileDir}" >/dev/null 2>&1; then
  echo "browser-running $BROWSER on $DISPLAY (process only; window may be hidden)"
  exit 0
fi
echo "browser-crashed" >&2
tail -30 /tmp/browser.log >&2 || true
exit 4
`;
  const res = await exec(sandbox, script);
  if (res.exitCode !== 0) {
    throw failedDependency(
      "desktop_browser_failed",
      res.output.includes("no-browser")
        ? "No browser is installed in the sandbox and Chromium could not be installed automatically."
        : res.output.includes("browser-crashed")
          ? "Chromium started but did not open a visible window in the remote desktop."
          : "Could not launch the browser inside the remote desktop.",
      { output: res.output },
    );
  }
}

/** Current desktop state + embeddable URL when running. */
export async function getDesktop(workspaceId: string): Promise<DesktopInfo> {
  const sandbox = await sandboxFor(workspaceId);
  const status = await sandbox.computerUse.getStatus().catch(() => null);
  const state = toState(status?.status);
  if (state !== "running") return { state, url: null };
  return { state, url: desktopPreviewEmbedUrl(workspaceId) };
}

/** Start the computer-use stack, launch a browser, and return the desktop URL. */
export async function startDesktop(workspaceId: string, url?: string): Promise<DesktopInfo> {
  const target = safeUrl(url);
  const sandbox = await sandboxFor(workspaceId);
  try {
    await sandbox.computerUse.start();
  } catch (err) {
    throw failedDependency(
      "desktop_start_failed",
      "Could not start the remote desktop in the sandbox.",
      { message: err instanceof Error ? err.message : String(err) },
    );
  }
  // Best-effort: a desktop with no browser is the bug we're fixing, but if the
  // launch fails we still hand back the running desktop so the user isn't stuck.
  await launchBrowser(sandbox, target).catch((err) => {
    console.error(`[desktop] browser launch failed for ${workspaceId}:`, err);
  });
  return getDesktop(workspaceId);
}

/** Open a URL in the in-sandbox browser, starting the desktop first if needed. */
export async function openDesktopUrl(workspaceId: string, url: string): Promise<DesktopInfo> {
  const target = safeUrl(url);
  const sandbox = await sandboxFor(workspaceId);
  const status = await sandbox.computerUse.getStatus().catch(() => null);
  if (toState(status?.status) !== "running") {
    // Desktop isn't up yet — start it (which also launches the browser at `url`).
    return startDesktop(workspaceId, target);
  }
  await launchBrowser(sandbox, target);
  return getDesktop(workspaceId);
}

/** Stop the computer-use stack to free resources. */
export async function stopDesktop(workspaceId: string): Promise<{ state: DesktopState }> {
  const sandbox = await sandboxFor(workspaceId);
  await sandbox.computerUse.stop().catch(() => {});
  return { state: "stopped" };
}

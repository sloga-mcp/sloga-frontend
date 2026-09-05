/**
 * Whether a rejected screen-share start was the user backing out of the
 * picker, as opposed to a capture that failed.
 *
 * Browsers reject a cancelled getDisplayMedia picker with NotAllowedError.
 * The Electron shell's display-media handler answers a cancelled or closed
 * picker — the in-app source picker on X11, GNOME's portal on Wayland — with
 * `callback(null)`, which Chromium surfaces to the page as AbortError
 * "Error starting capture" (EL3 harness 2026-09-03; velvetfly's Wayland
 * session 2026-09-05, where the dialog "An error occurred. Error starting
 * capture" followed every cancelled portal). A source that genuinely cannot
 * be captured rejects with NotReadableError "Could not start video source",
 * so the AbortError text is what separates the two. Both cancel shapes mean
 * "nothing was shared and the user already knows why": no error dialog.
 *
 * Pure, so the shell's cancel contract is pinned by a unit test rather than
 * by whoever next reads the dialog on a tester's screen.
 */
export function isScreenShareCancel(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "NotAllowedError") return true;
  return name === "AbortError" && message === "Error starting capture";
}

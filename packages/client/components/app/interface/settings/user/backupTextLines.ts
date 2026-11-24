// Which protected channel history lines the Encryption settings show about
// the key backup (design 8.5, R-W4-12). Pure, so `backupTextLines.test.ts`
// can run it under Node; `Encryption.tsx` only renders the answer through
// `backupTextCopy`.
//
// A line is shown only for something that was reported. A bundle or a
// restore that says nothing (an older shell, iOS, the desktop recovery
// window) gets no line: that is "not reported", never "all of it is there".
import type { BackupTextKind } from "../../../../client/protectedCopy.ts";

/**
 * The lines to show, the backup's first.
 * @param backup `text_truncated` of the last bundle the server kept (`bridge.backupText`), absent when none was uploaded or the shell does not report it
 * @param restore The text summary of the last restore (`restoreFromBackupReport`), absent when none ran
 * @param historyFlag The server's history setting flag; the bundle line needs exactly `true`
 * @returns Keys for `backupTextCopy`
 */
export function backupTextLines(
  backup: unknown,
  restore: unknown,
  historyFlag: unknown,
): BackupTextKind[] {
  const lines: BackupTextKind[] = [];
  if (historyFlag === true) {
    const kind = bundleLine(backup);
    if (kind) lines.push(kind);
  }
  const kind = restoreLine(restore);
  if (kind) lines.push(kind);
  return lines;
}

/**
 * The bundle's line. A value this build does not know reads as the more
 * careful of the two: it promises nothing about what the backup holds.
 */
function bundleLine(truncated: unknown): BackupTextKind | null {
  if (truncated === undefined || truncated === null) return null;
  if (truncated === "none") return null;
  if (truncated === "oldest") return "oldest";
  return "all";
}

/**
 * The restore's line (R-W4-12). What the restore could not bring back
 * comes first: `skipped` picks its line, and a `skipped` this build does
 * not know says some history may be missing. Otherwise the report's
 * `truncated` says what the restored backup itself had left out, with the
 * two lines the bundle uses (`oldest`, `all`). `epochs` is never counted.
 * A report that says neither gets no line.
 */
function restoreLine(restore: unknown): BackupTextKind | null {
  if (typeof restore !== "object" || restore === null) return null;
  const report = restore as Record<string, unknown>;
  const skipped = report.skipped;
  if (skipped !== undefined && skipped !== null && skipped !== "none") {
    return skipped === "all" ? "skipped_all" : "skipped_partial";
  }
  return bundleLine(report.truncated);
}

// The restore runs in the enable dialog, which closes as soon as it worked,
// and its result is shown on the settings page. The summary is kept here for
// the session, per bridge (so never across accounts), until the next restore
// replaces it.
const restoreTexts = new WeakMap<object, unknown>();
const restoreListeners = new Set<() => void>();

/**
 * Keep the text summary of a restore that just ran.
 * @param bridge The E2EE bridge that ran it
 * @param text What `restoreFromBackupReport` answered as `text`
 */
export function recordRestoreText(bridge: object, text: unknown): void {
  restoreTexts.set(bridge, text);
  for (const listener of [...restoreListeners]) {
    try {
      listener();
    } catch (error) {
      // A page that fails to redraw must not fail the restore
      console.error("[e2ee] restore text listener failed", error);
    }
  }
}

/**
 * The summary of the last restore this bridge ran, if any.
 * @param bridge The E2EE bridge
 */
export function lastRestoreText(bridge: object): unknown {
  return restoreTexts.get(bridge);
}

/**
 * Be told when a restore result is recorded.
 * @param listener Called after each `recordRestoreText`
 * @returns Stops the calls
 */
export function onRestoreText(listener: () => void): () => void {
  restoreListeners.add(listener);
  return () => {
    restoreListeners.delete(listener);
  };
}

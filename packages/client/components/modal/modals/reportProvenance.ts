/**
 * Where the text of a reported message comes from, for the staff report
 * queue. Pure: snapshots are passed in as the server sent them, so
 * `node --test` loads it directly (`reportProvenance.test.ts`).
 *
 * A message report carries the reporter's own copy (`ReporterMessage`) and,
 * when the server could read the message, the server's copy (`Message`).
 * Everything in the reporter's copy is CLIENT-CLAIMED, the `encrypted` flag
 * included: it labels the copy and never decides anything else.
 */

/** A snapshot as returned by `GET /safety/reports/{id}`. */
export type SnapshotLike = { content?: unknown };

/** Labels for one reporter-supplied copy. */
export type ReporterCopyLabel = {
  /** No server copy exists for the same message id */
  unverified: boolean;
  /** Unverified, and the reporter's app flagged the message as encrypted */
  markedEncrypted: boolean;
};

/** `value` as a plain object, or `undefined`. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The server's copy of message `id` among the snapshots, if any.
 * @param snapshots Every snapshot of the report
 * @param id Message id
 * @returns The server's message object, or `undefined`
 */
function serverCopy(
  snapshots: readonly SnapshotLike[],
  id: string | undefined,
): Record<string, unknown> | undefined {
  if (!id) return undefined;
  for (const snapshot of snapshots) {
    const content = record(snapshot.content);
    if (content?._type !== "Message") continue;
    const message = record(content.message);
    if (message && text(message._id) === id) return message;
  }
  return undefined;
}

/**
 * Labels for a reporter-supplied copy. A copy the server has no copy of is
 * unverified; so is one with no readable id, since nothing can match it.
 * @param reporterSnapshot The `ReporterMessage` snapshot
 * @param snapshots Every snapshot of the same report
 * @returns The labels; both false for any other kind of snapshot
 */
export function reporterCopyLabel(
  reporterSnapshot: SnapshotLike,
  snapshots: readonly SnapshotLike[],
): ReporterCopyLabel {
  const content = record(reporterSnapshot.content);
  if (content?._type !== "ReporterMessage") {
    return { unverified: false, markedEncrypted: false };
  }

  const message = record(content.message);
  const unverified = !serverCopy(snapshots, text(message?.id));
  return {
    unverified,
    markedEncrypted: unverified && message?.encrypted === true,
  };
}

/** Who enforcement would act on, and on what evidence. */
export type ReportTarget = {
  /** User id */
  id: string;
  /**
   * Only the reporter's copy names this user: no server copy names an
   * author, so staff confirm before acting on it
   */
  claimedOnly: boolean;
};

/**
 * Who a report is about, for enforcement: the reported user for a user
 * report; for a message, the author on the server's copy when there is one,
 * else the author the reporter's copy claims.
 * @param content The report's `content`
 * @param snapshots Every snapshot of the report
 * @returns The target, or `undefined`
 */
export function reportTargetOf(
  content: { type: string; id: string } | undefined,
  snapshots: readonly SnapshotLike[],
): ReportTarget | undefined {
  if (content?.type === "User") {
    const id = text(content.id);
    return id ? { id, claimedOnly: false } : undefined;
  }

  let claimed: string | undefined;
  for (const snapshot of snapshots) {
    const snap = record(snapshot.content);
    if (snap?._type === "Message") {
      const author = text(record(snap.message)?.author);
      if (author) return { id: author, claimedOnly: false };
    } else if (snap?._type === "ReporterMessage" && !claimed) {
      claimed = text(record(snap.message)?.author);
    }
  }
  return claimed ? { id: claimed, claimedOnly: true } : undefined;
}

/**
 * The author a message report is about (`reportTargetOf`).
 * @param snapshots Every snapshot of the report
 * @returns The user id, or `undefined`
 */
export function reportedAuthorOf(
  snapshots: readonly SnapshotLike[],
): string | undefined {
  return reportTargetOf(undefined, snapshots)?.id;
}

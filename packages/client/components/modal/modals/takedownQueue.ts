/**
 * Pure pieces of the Take It Down review queue (`TakedownQueue.tsx`) and its
 * Home tile: the shapes the staff routes return, deadline math, the copy
 * count a removal confirms, and how an error answer reads. No imports, so
 * `takedownQueue.test.ts` loads it under `node --test`.
 */

/** One queue row, `GET /admin/takedown/requests` */
export interface TakedownSummary {
  /** Request id (ULID); the routes and evidence take this one */
  id: string;
  /** `TD-<ULID>`, what the requester sees */
  reference: string;
  status: string;
  received_at: string;
  deadline_at: string;
  minor_claimed: boolean;
  in_app: boolean;
  targets: number;
  opened: boolean;
  child_safety: boolean;
  throttled: boolean;
  bad_faith_history: boolean;
  auto_hidden: number;
}

/** The requester's details; render as plain text only */
export interface TakedownRequesterView {
  role: "Depicted" | "Authorized";
  authority_note?: string | null;
  name: string;
  signature: string;
  email: string;
  description: string;
  extra?: string | null;
  added_info: string[];
}

export interface TakedownFileView {
  id: string;
  tag: string;
  content_type: string;
  size: number;
  /** Live identical copies elsewhere on Sloga */
  copies: number;
  hidden: boolean;
}

export interface TakedownTargetView {
  index: number;
  kind: string;
  id?: string | null;
  channel_id?: string | null;
  server_id?: string | null;
  author_id?: string | null;
  created_at?: string | null;
  encrypted: boolean;
  unresolvable?: string | null;
  files: TakedownFileView[];
}

export interface StaffAuditView {
  id: string;
  created_at: string;
  actor?: string | null;
  action: string;
  target_ids: string[];
  count?: number | null;
  note?: string | null;
}

/** `GET /admin/takedown/requests/<id>` */
export interface TakedownDetail {
  summary: TakedownSummary;
  /** Absent once the requester's details were purged */
  requester?: TakedownRequesterView | null;
  locations: string[];
  targets: TakedownTargetView[];
  linked: string[];
  audit: StaffAuditView[];
}

/** `POST .../remove` answer */
export interface TakedownRemoveResult {
  removed_files: number;
  deleted_messages: number;
  copies: number;
  blocked: number;
}

/** Statuses a reviewer still has to act on (the server's `is_open`) */
export const OPEN_STATUSES = ["Received", "NeedsInfo", "UnderReview"];

/** A request with less time left than this is urgent */
export const URGENT_WINDOW_MS = 12 * 60 * 60 * 1000;

/** The server's cap on `X-Audit-Log-Reason`, in characters */
export const AUDIT_REASON_MAX = 512;

/** The server's cap on a decline note */
export const DECLINE_NOTE_MAX = 1000;

export function isOpenStatus(status: string): boolean {
  return OPEN_STATUSES.includes(status);
}

/** Milliseconds until `deadline` (negative once overdue), `undefined` if unreadable */
export function msLeft(deadline: string, now: number): number | undefined {
  const at = Date.parse(deadline);
  return Number.isNaN(at) ? undefined : at - now;
}

/** An open request with under 12 hours left, or overdue */
export function isUrgent(summary: TakedownSummary, now: number): boolean {
  if (!isOpenStatus(summary.status)) return false;
  const left = msLeft(summary.deadline_at, now);
  return left !== undefined && left < URGENT_WINDOW_MS;
}

/** What the Home tile shows: open requests, and whether any is urgent */
export function queueCounts(
  list: readonly TakedownSummary[],
  now: number,
): { open: number; urgent: boolean } {
  const open = list.filter((summary) => isOpenStatus(summary.status));
  return {
    open: open.length,
    urgent: open.some((summary) => isUrgent(summary, now)),
  };
}

/** Whole hours and minutes of a time span; `overdue` when it is negative */
export function splitDuration(ms: number): {
  overdue: boolean;
  hours: number;
  minutes: number;
} {
  const overdue = ms < 0;
  const total = Math.floor(Math.abs(ms) / 60_000);
  return { overdue, hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * Queue order: open requests first, each group by deadline (earliest first,
 * an unreadable one last), then by reference
 */
export function sortQueue(list: readonly TakedownSummary[]): TakedownSummary[] {
  const deadline = (summary: TakedownSummary) => {
    const at = Date.parse(summary.deadline_at);
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  };

  return [...list].sort((a, b) => {
    const open =
      Number(isOpenStatus(b.status)) - Number(isOpenStatus(a.status));
    if (open !== 0) return open;
    const due = deadline(a) - deadline(b);
    if (due !== 0 && !Number.isNaN(due)) return due;
    return a.reference.localeCompare(b.reference);
  });
}

/** Targets a removal can pick: everything Sloga could resolve */
export function removableTargets(
  targets: readonly TakedownTargetView[],
): TakedownTargetView[] {
  return targets.filter((target) => target.kind !== "Unresolvable");
}

/**
 * The copy count a removal confirms: live identical copies of the files of
 * the selected targets, each file once (a file shown by two targets counts
 * once, as the server gathers it once). 0 when copies are not included.
 *
 * Exact when the selected files are different images. The server dedupes
 * copies across files by hash, which the detail does not carry, so two
 * selected files that are the same image count each other here and the
 * server answers `InvalidOperation`; removing one target at a time avoids it.
 */
export function plannedCopyCount(
  targets: readonly TakedownTargetView[],
  selected: readonly number[],
  includeCopies: boolean,
): number {
  if (!includeCopies) return 0;

  const seen = new Set<string>();
  let count = 0;
  for (const target of targets) {
    if (!selected.includes(target.index)) continue;
    for (const file of target.files) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      count += Math.max(0, file.copies);
    }
  }
  return count;
}

/** Ids of held (hidden) files across the targets, each once */
export function hiddenFileIds(
  targets: readonly TakedownTargetView[],
): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    for (const file of target.files) {
      if (file.hidden && !ids.includes(file.id)) ids.push(file.id);
    }
  }
  return ids;
}

export type TakedownErrorKind =
  | "busy"
  | "reasonRequired"
  | "reasonTooLong"
  | "invalidBody"
  | "notPrivileged"
  | "mfa"
  | "invalidOperation"
  | "featureDisabled"
  | "notFound"
  | "rateLimited"
  | "other";

/** What an error answer from the staff routes means for the reviewer */
export function classifyError(
  status: number,
  body: unknown,
): TakedownErrorKind {
  if (status === 429) return "rateLimited";

  const error =
    body && typeof body === "object"
      ? (body as { type?: unknown; error?: unknown })
      : {};

  switch (error.type) {
    case "FailedValidation":
      switch (error.error) {
        case "TakedownBusy":
          return "busy";
        case "AuditLogReasonRequired":
          return "reasonRequired";
        case "AuditLogReasonTooLong":
          return "reasonTooLong";
        case "InvalidBody":
          return "invalidBody";
        default:
          return "other";
      }
    case "NotPrivileged":
      return "notPrivileged";
    case "InvalidToken":
      return "mfa";
    case "InvalidOperation":
      return "invalidOperation";
    case "FeatureDisabled":
      return "featureDisabled";
    case "NotFound":
      return "notFound";
    default:
      return "other";
  }
}

/**
 * Whether the Home tile stops asking for the session after this list
 * answer: `NotPrivileged` (not a reviewer, or no MFA), or a 404 (an older
 * server without the route). Any other failure keeps the last good count.
 */
export function tileGivesUp(status: number, body: unknown): boolean {
  return status === 404 || classifyError(status, body) === "notPrivileged";
}

/** How a file is previewed: images (not SVG) and videos only */
export function previewKind(
  contentType: string,
): "image" | "video" | undefined {
  const essence = contentType.split(";")[0].trim().toLowerCase();
  if (essence.startsWith("image/") && essence !== "image/svg+xml")
    return "image";
  if (essence.startsWith("video/")) return "video";
  return undefined;
}

/** Evidence path on the upload server; `requestId` is the ULID, not `TD-` */
export function evidencePath(fileId: string, requestId: string): string {
  return `/takedown/evidence/${encodeURIComponent(fileId)}?request=${encodeURIComponent(requestId)}`;
}

/** `X-Audit-Log-Reason` value for `reason`, `undefined` when it is blank */
export function auditReasonHeader(reason: string): string | undefined {
  const trimmed = reason.trim();
  return trimmed ? encodeURIComponent(trimmed) : undefined;
}

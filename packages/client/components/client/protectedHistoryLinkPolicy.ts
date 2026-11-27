/**
 * S4 history links, write side: what a link PUT answer means, and when this
 * device owes a link at all (design 3.14.7 "Writer duty and contest", 4.9
 * "S4", 8.3 "S4"; W4 lane L1k, rulings R-W4-8 and R-W4-9).
 *
 * Pure and node-testable: types only, no timers, no requests, no Solid, no
 * `e2ee.ts`. The manager schedules and sends; this module only answers.
 *
 * Everything here fails closed. An answer, a build result or a duty input
 * this module does not recognize never produces a PUT and never a retry.
 * The link itself is passed through untouched: the server and native agree
 * on its bytes, so nothing here reads into it beyond the two path fields.
 */
import { leafStaggerMs } from "./protectedTextPolicy.ts";
import type {
  HistoryLinkBuilt,
  HistoryLinkWire,
} from "./protectedTextTypes.ts";

/** A link PUT is given up after this many attempts. */
export const LINK_PUT_MAX_ATTEMPTS = 6;

/** Holders one catch-up pass writes for; the rest is left to other members. */
export const DUTY_BATCH_MAX = 200;

/** Wait after the first failed attempt; doubled after each later one. */
const LINK_PUT_RETRY_BASE_MS = 2_000;

export type LinkPutAnswer =
  /** 204: stored. No other success status is one. */
  | { kind: "done" }
  /** `HistoryLinkExists`: a link is already there. Done, never retried. */
  | { kind: "exists" }
  /**
   * `FeatureDisabled` for `protected_history` or for the base switch
   * `protected_channels`: no more links this session.
   */
  | { kind: "disabled" }
  /** `ProtectedClientOutdated`: no more links this session, loud log. */
  | { kind: "outdated" }
  /** 5xx, 429 or no answer: send the SAME bytes again after `afterMs`. */
  | { kind: "retry"; afterMs: number }
  /** Anything else: drop this link, loud log, no retry. */
  | { kind: "refused" };

/**
 * What the answer to `PUT .../history_links/:epoch` means. `attempt` is the
 * number of the attempt that just got this answer, starting at 1.
 *
 * Retries wait 2 s, 4 s, 8 s, 16 s, 32 s after attempts 1..5; the answer to
 * attempt `LINK_PUT_MAX_ATTEMPTS` is final. A retry re-sends what was sent:
 * no answer here ever asks for a rebuilt link.
 */
export function classifyLinkPut(
  res:
    | { status: number; errorType: string | null; feature: string | null }
    | "transport",
  attempt: number,
): LinkPutAnswer {
  if (res === "transport") return retryOrGiveUp(attempt);
  if (typeof res !== "object" || res === null) return { kind: "refused" };

  const status = res.status;
  if (!Number.isInteger(status)) return { kind: "refused" };
  if (status === 204) return { kind: "done" };
  if (status === 429 || (status >= 500 && status <= 599)) {
    return retryOrGiveUp(attempt);
  }
  if (status >= 400 && status <= 499) {
    if (res.errorType === "HistoryLinkExists") return { kind: "exists" };
    if (
      res.errorType === "FeatureDisabled" &&
      (res.feature === "protected_history" ||
        res.feature === "protected_channels")
    ) {
      return { kind: "disabled" };
    }
    if (res.errorType === "ProtectedClientOutdated") {
      return { kind: "outdated" };
    }
  }
  return { kind: "refused" };
}

function retryOrGiveUp(attempt: number): LinkPutAnswer {
  // An attempt count that is not a count gets no retry.
  if (!Number.isSafeInteger(attempt) || attempt < 1) return { kind: "refused" };
  if (attempt >= LINK_PUT_MAX_ATTEMPTS) return { kind: "refused" };
  return {
    kind: "retry",
    afterMs: LINK_PUT_RETRY_BASE_MS * 2 ** (attempt - 1),
  };
}

/**
 * The path of a link PUT. The body is `link` itself, exactly as native
 * returned it: the caller serialises that object and nothing else.
 */
export function linkPutPath(link: HistoryLinkWire, contest: boolean): string {
  const path = `/mls/groups/${encodeURIComponent(link.group_id)}/history_links/${link.epoch}`;
  return contest === true ? `${path}?contest=true` : path;
}

export type BuildLog =
  | "none"
  | "hidden"
  | "not_derived"
  | "too_large"
  | "contest";

export interface BuildAnswer {
  /** The PUT to send, or `null` for none. `link` is the object native gave. */
  put: { link: HistoryLinkWire; contest: boolean } | null;
  /** Another writer stored different content: tell the owner (no names). */
  ownerNotice: boolean;
  /**
   * `hidden` is the normal quiet case. `not_derived` and `contest` are loud.
   * `too_large` is the one the caller turns into the `history_too_large`
   * toast.
   */
  log: BuildLog;
}

/**
 * What to do with the result of `e2ee_text_history_link_build`.
 *
 * A reason always wins: a result that names one sends nothing, link or not.
 * A result this module cannot read (not an object, a `refused` value it does
 * not know, no link and no reason, a link that could not address its own
 * PUT) sends nothing either and is logged as `not_derived`, the loud no-link
 * case. The writer ids native lists never leave this function: only whether
 * there were any.
 */
export function buildAnswer(b: HistoryLinkBuilt): BuildAnswer {
  const nothing: BuildAnswer = {
    put: null,
    ownerNotice: false,
    log: "not_derived",
  };
  if (typeof b !== "object" || b === null) return nothing;

  // An older shell may leave the list out; anything but a list is unreadable.
  const writers: unknown = b.mismatched_writers;
  if (writers !== undefined && !Array.isArray(writers)) return nothing;
  const ownerNotice = Array.isArray(writers) && writers.length > 0;

  const refused: unknown = b.refused;
  if (refused === "hidden" || refused === "not_derived") {
    return { put: null, ownerNotice, log: refused };
  }
  if (refused === "too_large") {
    return { put: null, ownerNotice, log: "too_large" };
  }
  if (refused !== null && refused !== undefined) return nothing;

  if (typeof b.contest !== "boolean") return nothing;
  if (!addressable(b.link)) return { ...nothing, ownerNotice };

  return {
    put: { link: b.link, contest: b.contest },
    ownerNotice,
    log: b.contest ? "contest" : "none",
  };
}

/** The two fields the PUT path is made of, and nothing more. */
function addressable(link: unknown): link is HistoryLinkWire {
  if (typeof link !== "object" || link === null) return false;
  const { group_id, epoch } = link as Partial<HistoryLinkWire>;
  return (
    typeof group_id === "string" &&
    group_id.length > 0 &&
    Number.isSafeInteger(epoch) &&
    (epoch as number) >= 0
  );
}

export interface DutyInput {
  /** `TextProcessOutcome.kind` of the commit just processed. */
  outcomeKind: string;
  /** The server's `history_setting` advert (R-W4-9). */
  historySetting: boolean;
  /** A PUT answered `disabled` or `outdated` earlier in this session. */
  sessionDisabled: boolean;
  groupId: string;
  /** The epoch the commit produced: the holder of the link owed. */
  epoch: number;
  /** This device's leaf index in the group, `null` when unknown. */
  ownLeaf: number | null;
}

export type MemberDuty =
  | { run: false }
  | { run: true; delayMs: number; holder: { groupId: string; epoch: number } };

/**
 * Whether a member that just applied someone else's commit owes a link for
 * the new epoch, and after what stagger (R-W4-8).
 *
 * Only a live `commit_applied` counts. A `welcome_joined` device holds
 * nothing older to hand on, a `duplicate` was already handled the first
 * time, and the committer writes its own link from `commit_won`, which is
 * not this function's business. An unknown leaf means no stagger can be
 * worked out, so the duty is left to the members that have one.
 */
export function memberDuty(i: DutyInput): MemberDuty {
  if (typeof i !== "object" || i === null) return { run: false };
  if (i.outcomeKind !== "commit_applied") return { run: false };
  if (i.historySetting !== true) return { run: false };
  if (i.sessionDisabled !== false) return { run: false };
  if (typeof i.ownLeaf !== "number") return { run: false };
  if (!Number.isSafeInteger(i.ownLeaf) || i.ownLeaf < 0) return { run: false };
  if (typeof i.groupId !== "string" || i.groupId.length === 0) {
    return { run: false };
  }
  if (!Number.isSafeInteger(i.epoch) || i.epoch < 0) return { run: false };
  return {
    run: true,
    delayMs: leafStaggerMs(i.ownLeaf),
    holder: { groupId: i.groupId, epoch: i.epoch },
  };
}

/**
 * The holders one pass writes for after a catch-up (R-W4-8): the epochs
 * `fromEpoch..toEpoch` (both included) that the catch-up applied, NEWEST
 * first, at most `DUTY_BATCH_MAX` of them. `skipped` counts the older ones
 * left to other members; the caller logs it.
 *
 * Nothing when the server has history off, or when the range is not one.
 */
export function catchUpDuty(
  range: { groupId: string; fromEpoch: number; toEpoch: number },
  historySetting: boolean,
): { holders: number[]; skipped: number } {
  const none = { holders: [], skipped: 0 };
  if (historySetting !== true) return none;
  if (typeof range !== "object" || range === null) return none;
  const { groupId, fromEpoch, toEpoch } = range;
  if (typeof groupId !== "string" || groupId.length === 0) return none;
  if (!Number.isSafeInteger(fromEpoch) || fromEpoch < 0) return none;
  if (!Number.isSafeInteger(toEpoch) || toEpoch < fromEpoch) return none;

  const total = toEpoch - fromEpoch + 1;
  const take = Math.min(total, DUTY_BATCH_MAX);
  const holders: number[] = [];
  for (let n = 0; n < take; n++) holders.push(toEpoch - n);
  return { holders, skipped: total - take };
}

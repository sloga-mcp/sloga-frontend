/**
 * Protected channels S4: the history walk (design 3.14.7 "Evidence", 3.14.8,
 * 3.9 "S4" step 4, 8.3 "As built").
 *
 * When backward paging meets a message whose key this device lacks, the
 * bridge walks the stored history links downward and hands them to native
 * `e2ee_text_history_import`, one SESSION of calls. This file is the planner
 * and the loop: which error starts a walk, which stored messages go along as
 * probes, how a stored commit is shaped for native, and the calls themselves.
 * Native does every check; nothing here decides that a link is good.
 *
 * Rules that must hold (each has a spec in `protectedHistoryWalk.test.ts`):
 * - A walk ends `anchored` only on an answer with `need_more: false` AND
 *   `stopped: null`. Every error, every answer this file cannot read and
 *   every stop it does not know ends as a stop or a retry, never as anchored.
 * - A call never carries more than 200 link rows or more than 3 probes per
 *   step: native refuses the whole call, it does not truncate.
 * - A step's probes come from distinct authors, none of whom wrote a
 *   candidate sent in the step ABOVE (those carried this step's keys).
 * - Links are sent exactly as the server gave them, never rebuilt.
 *
 * Pure: no Solid / SDK / lingui runtime imports, every effect goes through
 * the injected `WalkPorts`, loadable by `node --test`. Logs carry ids and
 * reasons only.
 */
import type { MlsMemberDevice } from "./e2ee";
import type {
  EncryptedPayload,
  HistoryEpochRef,
  HistoryImportStep,
  HistoryImported,
  HistoryLinkWire,
  HistoryProbe,
  HistoryRefusal,
  HistoryStop,
  NativeError,
  TextCommitInfo,
} from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// Limits (native `history.rs`: MAX_LINK_ROWS_PER_CALL, MAX_PROBES,
// MAX_SESSION_HOLDERS)
// ---------------------------------------------------------------------------

/** Link rows over ALL steps of one call. One more refuses the call. */
export const WALK_MAX_LINK_ROWS = 200;

/** Probes of one step. A fourth refuses the whole call. */
export const WALK_MAX_PROBES = 3;

/** How often a refused start holder is stepped up by one epoch. */
export const WALK_MAX_START_BUMPS = 3;

/**
 * Holders one walk sends. Native ends a session at the same count with
 * `unanchored`; this keeps the loop finite whatever the ports answer.
 */
export const WALK_MAX_HOLDERS = 2000;

/** Predecessor positions tried after a bridge whose candidates disagree. */
export const WALK_MAX_BRIDGE_TARGETS = 5;

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

type Ids = Record<string, string | number>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A group epoch as the wire carries it: a safe integer >= 0. */
function isEpoch(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** The native error inside a rejection, raw or wrapped by the bridge. */
function nativeErrorOf(e: unknown): Record<string, unknown> | null {
  if (!isRecord(e)) return null;
  if (e.source === "native") return isRecord(e.error) ? e.error : null;
  if (e.source !== undefined) return null;
  return typeof e.type === "string" ? e : null;
}

// ---------------------------------------------------------------------------
// Trigger (design 3.9 "S4" step 4, 3.14.8 "Trigger")
// ---------------------------------------------------------------------------

export type WalkTrigger =
  | { kind: "walk"; groupId: string; missingEpoch: number }
  | { kind: "removed_self" }
  | { kind: "catch_up" }
  | { kind: "none" };

/** The channel as native reports it, plus what the caller knows of the row. */
export interface WalkGroupView {
  /** `TextChannelState.state`. */
  state: string;
  /** `TextChannelState.verdict`. */
  verdict: string;
  /** `TextChannelState.group_id`: the channel's current group. */
  groupId: string | null;
  /** `TextChannelState.epoch`. */
  epoch: number | null;
  /**
   * True only when the caller KNOWS the failing row's group is a predecessor
   * of this channel (a group an earlier walk bridged into, or the group of
   * `history_floor`). Never set from the row alone: the server wrote the row.
   */
  predecessor?: boolean;
  /**
   * The failing row's `encrypted.epoch`. Needed for `mls_group_not_found`,
   * whose error names no epoch.
   */
  rowEpoch?: number | null;
}

/**
 * Route a decrypt error of one stored row.
 *
 * - `unknown_epoch` with `removed_self === true`: the gray marker, no walk.
 * - `unknown_epoch` below the group's current epoch: walk.
 * - `unknown_epoch` above it: catch up when the group is the channel's own
 *   and active; walk when the group is closed (superseded, `left`, or a
 *   known predecessor), because such a message is reached through the
 *   successor's bridge and never by catching up.
 * - `mls_group_not_found`: walk only for a known predecessor group.
 * - Anything else, and anything this cannot read: `none`.
 */
export function walkTrigger(
  err: NativeError,
  group: WalkGroupView,
): WalkTrigger {
  const e: unknown = err;
  if (!isRecord(e)) return { kind: "none" };

  if (e.type === "mls_group_not_found") {
    if (
      group.predecessor !== true ||
      !isId(e.group_id) ||
      !isEpoch(group.rowEpoch)
    ) {
      return { kind: "none" };
    }
    return { kind: "walk", groupId: e.group_id, missingEpoch: group.rowEpoch };
  }

  if (e.type !== "unknown_epoch") return { kind: "none" };
  // An older shell sends no `removed_self`: only a literal true counts
  if (e.removed_self === true) return { kind: "removed_self" };
  const current = e.current;
  if (
    !isId(e.group_id) ||
    !isEpoch(e.epoch) ||
    typeof current !== "number" ||
    !Number.isSafeInteger(current)
  ) {
    return { kind: "none" };
  }
  const walk: WalkTrigger = {
    kind: "walk",
    groupId: e.group_id,
    missingEpoch: e.epoch,
  };
  if (e.epoch < current) return walk;
  if (e.epoch === current) return { kind: "none" };

  // Above the last epoch held in that group
  if (e.group_id !== group.groupId) {
    return group.predecessor === true ? walk : { kind: "none" };
  }
  if (group.state === "left") return walk;
  if (group.state !== "active") return { kind: "none" };
  // `no_group` while `active`: the held group was superseded
  return group.verdict === "no_group" ? walk : { kind: "catch_up" };
}

// ---------------------------------------------------------------------------
// Probes (design 3.14.7 "Evidence", as built)
// ---------------------------------------------------------------------------

/**
 * A stored message as the paged channel history holds it. Structurally the
 * id, author, nonce and `encrypted` of `ProtectedMessageRow`.
 */
export interface ProbeSource {
  id: string;
  authorId: string;
  /** The message-level nonce; a row without one is never a probe. */
  nonce: string | null;
  encrypted: EncryptedPayload | null;
}

/**
 * The probes of one step: stored messages of exactly the holder's group and
 * epoch, oldest id first, at most 3, one per author, never from an author in
 * `excludedAuthors` (the writers of the candidates sent in the step above).
 * Native skips a probe that breaks the last two rules and the slot is lost,
 * so they are applied here. `encrypted` is passed on as received.
 */
export function pickProbes(
  rows: readonly ProbeSource[],
  holder: { groupId: string; epoch: number },
  excludedAuthors: ReadonlySet<string>,
): HistoryProbe[] {
  const usable: HistoryProbe[] = [];
  for (const row of rows) {
    const r: unknown = row;
    if (!isRecord(r) || !isRecord(r.encrypted)) continue;
    if (!isId(r.id) || !isId(r.authorId) || typeof r.nonce !== "string") {
      continue;
    }
    if (
      r.encrypted.group_id !== holder.groupId ||
      r.encrypted.epoch !== holder.epoch
    ) {
      continue;
    }
    usable.push({
      message_id: r.id,
      author_user_id: r.authorId,
      nonce: r.nonce,
      encrypted: row.encrypted as EncryptedPayload,
    });
  }
  usable.sort((a, b) =>
    a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0,
  );

  const authors = new Set<string>();
  const probes: HistoryProbe[] = [];
  for (const probe of usable) {
    if (probes.length >= WALK_MAX_PROBES) break;
    if (excludedAuthors.has(probe.author_user_id)) continue;
    if (authors.has(probe.author_user_id)) continue;
    authors.add(probe.author_user_id);
    probes.push(probe);
  }
  return probes;
}

// ---------------------------------------------------------------------------
// Stored commits (R-W4-7)
// ---------------------------------------------------------------------------

export type WalkLog = (
  level: "warn" | "error",
  msg: string,
  ids: Record<string, string | number>,
) => void;

function memberDevice(v: unknown): MlsMemberDevice | null {
  if (!isRecord(v) || !isId(v.user_id) || !isId(v.device_id)) return null;
  return { user_id: v.user_id, device_id: v.device_id };
}

function memberDevices(v: unknown): MlsMemberDevice[] | null {
  if (!Array.isArray(v)) return null;
  const out: MlsMemberDevice[] = [];
  for (const entry of v) {
    const device = memberDevice(entry);
    if (device === null) return null;
    out.push(device);
  }
  return out;
}

/**
 * A stored commit row (`GET .../commits`) as native takes it, or null when
 * the row does not have the wire shape. Only the fields native reads are
 * copied. `created_at` goes along only as a safe integer >= 0: native refuses
 * the WHOLE call on any other value, so a bad one is dropped (the walk then
 * runs without that time cap) and logged through `log`.
 */
export function commitForNative(
  row: unknown,
  log?: WalkLog,
): TextCommitInfo | null {
  if (!isRecord(row)) return null;
  const committer = memberDevice(row.committer);
  const added = memberDevices(row.added);
  const removed = memberDevices(row.removed);
  if (
    !isId(row.group_id) ||
    !isEpoch(row.epoch) ||
    typeof row.commit !== "string" ||
    committer === null ||
    added === null ||
    removed === null
  ) {
    return null;
  }
  const out: TextCommitInfo = {
    group_id: row.group_id,
    epoch: row.epoch,
    committer,
    commit: row.commit,
    added,
    removed,
  };
  // Signed elements: the arrays are copied, their entries are not rebuilt
  if (row.rejoin_intents !== undefined) {
    if (!Array.isArray(row.rejoin_intents)) return null;
    out.rejoin_intents = [
      ...row.rejoin_intents,
    ] as TextCommitInfo["rejoin_intents"];
  }
  if (row.removed_reasons !== undefined) {
    if (!Array.isArray(row.removed_reasons)) return null;
    out.removed_reasons = [
      ...row.removed_reasons,
    ] as TextCommitInfo["removed_reasons"];
  }
  const at = row.created_at;
  if (at !== undefined) {
    if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) {
      out.created_at = at;
    } else {
      log?.("error", "history walk: commit created_at dropped", {
        group_id: row.group_id,
        epoch: row.epoch,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The walk (design 3.14.8)
// ---------------------------------------------------------------------------

export interface WalkPorts {
  /**
   * One page of `GET /mls/groups/:id/history_links`: the links whose holder
   * epoch is BELOW `before`, newest holder first, every candidate of an
   * epoch on one page. `"end"` (or an empty page) = nothing below `before`;
   * `"failed"` = the request failed.
   */
  links(
    groupId: string,
    before: number | null,
  ): Promise<HistoryLinkWire[] | "end" | "failed">;
  /** The stored commit row of `epoch`, or null (pruned). Rejects on failure. */
  commit(groupId: string, epoch: number): Promise<unknown | null>;
  /** The stored messages of that group and epoch the paged history holds. */
  probeRows(groupId: string, epoch: number): Promise<readonly ProbeSource[]>;
  /** `e2ee_text_history_import`. `groupId` is the walk's STARTING group. */
  importSteps(
    groupId: string,
    session: string | null,
    steps: HistoryImportStep[],
  ): Promise<HistoryImported>;
  /** Pin that device from the signed listing; false = could not. */
  pin(userId: string, deviceId: string): Promise<boolean>;
  log(
    level: "warn" | "error",
    msg: string,
    ids: Record<string, string | number>,
  ): void;
}

export type WalkEnd =
  | { kind: "anchored" }
  | { kind: "stopped"; stop: HistoryStop; floor: HistoryEpochRef | null }
  | {
      kind: "retry_later";
      reason: "unanchored" | "transport" | "pin" | "argument";
    };

export interface WalkResult {
  end: WalkEnd;
  /** Every epoch native committed in this walk, in the order it reported. */
  imported: HistoryEpochRef[];
  /** Every candidate native refused in this walk. */
  refused: HistoryRefusal[];
}

/** The server's pages of one group, bucketed by holder epoch. */
interface LinkBuffer {
  groupId: string;
  /** The `before` of the next page. */
  before: number;
  /** Every holder at or above this was paged: no bucket = no link. */
  covered: number;
  ended: boolean;
  byEpoch: Map<number, HistoryLinkWire[]>;
}

function linkBuffer(groupId: string, topEpoch: number): LinkBuffer {
  return {
    groupId,
    before: topEpoch + 1,
    covered: topEpoch + 1,
    ended: false,
    byEpoch: new Map(),
  };
}

function writersOf(candidates: readonly HistoryLinkWire[]): Set<string> {
  const writers = new Set<string>();
  for (const candidate of candidates) {
    if (isId(candidate.writer_user_id)) writers.add(candidate.writer_user_id);
  }
  return writers;
}

interface BridgeTarget {
  groupId: string;
  epoch: number;
}

/**
 * Where a bridge step (holder epoch 0) may lead: the distinct
 * `(prev_group_id, prev_epoch)` of its candidates, the one most candidates
 * name first. Native follows only the candidates that pass its checks and
 * does not say which, so a wrong guess is refused there
 * (`invalid_argument{steps}`, nothing written) and the next one is tried.
 */
function bridgeTargets(step: HistoryImportStep): BridgeTarget[] {
  const found: { target: BridgeTarget; count: number }[] = [];
  for (const candidate of step.candidates) {
    const groupId = candidate.prev_group_id;
    const epoch = candidate.prev_epoch;
    if (!isId(groupId) || groupId === step.holder_group_id || !isEpoch(epoch)) {
      continue;
    }
    const seen = found.find(
      (f) => f.target.groupId === groupId && f.target.epoch === epoch,
    );
    if (seen) seen.count += 1;
    else found.push({ target: { groupId, epoch }, count: 1 });
  }
  // Stable: equal counts keep the server's order
  found.sort((a, b) => b.count - a.count);
  return found.slice(0, WALK_MAX_BRIDGE_TARGETS).map((f) => f.target);
}

function epochRef(v: unknown): HistoryEpochRef | null {
  if (!isRecord(v) || !isId(v.group_id) || !isEpoch(v.epoch)) return null;
  return { group_id: v.group_id, epoch: v.epoch };
}

/** The answer of one import call, or null when it is not one. */
function importedOf(v: unknown): HistoryImported | null {
  if (
    !isRecord(v) ||
    typeof v.session !== "string" ||
    typeof v.need_more !== "boolean" ||
    !Array.isArray(v.imported) ||
    !Array.isArray(v.refused) ||
    (v.stopped !== null && typeof v.stopped !== "string")
  ) {
    return null;
  }
  const imported: HistoryEpochRef[] = [];
  for (const entry of v.imported) {
    const ref = epochRef(entry);
    if (ref === null) return null;
    imported.push(ref);
  }
  const refused: HistoryRefusal[] = [];
  for (const entry of v.refused) {
    if (
      !isRecord(entry) ||
      !isId(entry.group_id) ||
      !isEpoch(entry.epoch) ||
      typeof entry.reason !== "string"
    ) {
      return null;
    }
    refused.push({
      type: "history_link_invalid",
      group_id: entry.group_id,
      epoch: entry.epoch,
      reason: entry.reason as HistoryRefusal["reason"],
    });
  }
  return {
    session: v.session,
    need_more: v.need_more,
    imported,
    floor: epochRef(v.floor),
    stopped: v.stopped as HistoryStop | null,
    refused,
  };
}

const KNOWN_STOPS: readonly string[] = [
  "hidden",
  "missing",
  "invalid",
  "anchor_mismatch",
  "conflict",
  "unanchored",
  "genesis",
] satisfies readonly HistoryStop[];

const RETRY = (
  reason: "unanchored" | "transport" | "pin" | "argument",
): WalkEnd => ({ kind: "retry_later", reason });

/**
 * One walk from `startEpoch`, as one native session. `"bump"`: native refused
 * the start holder on the first call (not a held epoch with a sealed key).
 */
async function walkFrom(
  ports: WalkPorts,
  sessionGroup: string,
  startEpoch: number,
  imported: HistoryEpochRef[],
  refused: HistoryRefusal[],
): Promise<WalkEnd | "bump"> {
  const log: WalkLog = (level, msg, ids) => ports.log(level, msg, ids);
  const commits = new Map<string, TextCommitInfo | null>();

  /** The stored commit of an epoch, shaped for native; null when unusable. */
  async function commitOf(
    groupId: string,
    epoch: number,
  ): Promise<TextCommitInfo | null> {
    const key = `${groupId}:${epoch}`;
    const known = commits.get(key);
    if (known !== undefined) return known;
    const ids: Ids = { group_id: groupId, epoch };
    const row = await ports.commit(groupId, epoch);
    let commit: TextCommitInfo | null = null;
    if (row !== null && row !== undefined) {
      commit = commitForNative(row, log);
      if (commit === null) {
        log("error", "history walk: stored commit unreadable", ids);
      } else if (commit.group_id !== groupId || commit.epoch !== epoch) {
        log("error", "history walk: stored commit is of another epoch", ids);
        commit = null;
      }
    }
    commits.set(key, commit);
    return commit;
  }

  /** Page until holder `epoch` is covered. False: the request failed. */
  async function fill(buffer: LinkBuffer, epoch: number): Promise<boolean> {
    while (!buffer.ended && epoch < buffer.covered) {
      const top = buffer.before;
      const page: unknown = await ports.links(buffer.groupId, top);
      if (page === "end") {
        buffer.ended = true;
        break;
      }
      if (!Array.isArray(page)) return false;
      let lowest = top;
      let dropped = 0;
      for (const entry of page) {
        // A row of another group or outside the asked range is never sent
        if (
          !isRecord(entry) ||
          entry.group_id !== buffer.groupId ||
          !isEpoch(entry.epoch) ||
          entry.epoch >= top
        ) {
          dropped += 1;
          continue;
        }
        const bucket = buffer.byEpoch.get(entry.epoch);
        // The server's object goes to native as it came
        if (bucket) bucket.push(entry as unknown as HistoryLinkWire);
        else {
          buffer.byEpoch.set(entry.epoch, [
            entry as unknown as HistoryLinkWire,
          ]);
        }
        if (entry.epoch < lowest) lowest = entry.epoch;
      }
      if (dropped > 0) {
        log("error", "history walk: link rows outside the page dropped", {
          group_id: buffer.groupId,
          before: top,
          dropped,
        });
      }
      if (lowest === top) {
        // An empty page is the end of the list
        buffer.ended = true;
      } else {
        buffer.before = lowest;
        buffer.covered = lowest;
      }
    }
    return true;
  }

  let session: string | null = null;
  let first = true;
  let holders = 0;
  let links = linkBuffer(sessionGroup, startEpoch);
  let next = startEpoch;
  // The writers of the candidates sent in the step above the next one
  let above = new Set<string>();
  // After a bridge: the predecessor positions not tried yet
  let targets: BridgeTarget[] = [];

  for (;;) {
    // --- one call: consecutive holders, highest first, <= 200 rows --------
    const steps: HistoryImportStep[] = [];
    let rows = 0;
    let writers = above;
    let last: HistoryImportStep | null = null;
    for (let h = next; ; h -= 1) {
      if (holders + steps.length >= WALK_MAX_HOLDERS) {
        if (steps.length > 0) break;
        log("error", "history walk: holder cap reached", {
          group_id: links.groupId,
          epoch: h,
        });
        return RETRY("unanchored");
      }
      // The next server page belongs to the next call
      if (steps.length > 0 && !links.ended && h < links.covered) break;
      const ids: Ids = { group_id: links.groupId, epoch: h };
      let candidates: HistoryLinkWire[];
      let commit: TextCommitInfo | null = null;
      let prevCommit: TextCommitInfo | null = null;
      let probeRows: unknown;
      try {
        if (!(await fill(links, h))) {
          log("warn", "history walk: link page failed", ids);
          return RETRY("transport");
        }
        // No link stored for the holder: the step goes out with none and
        // native answers `missing` (or `genesis`)
        candidates = links.byEpoch.get(h) ?? [];
        if (rows + candidates.length > WALK_MAX_LINK_ROWS) {
          if (steps.length > 0) break;
          // The server stores 5 per epoch; nothing is cut down to fit
          log("error", "history walk: too many candidates for one holder", {
            ...ids,
            candidates: candidates.length,
          });
          return RETRY("argument");
        }
        if (h > 0) {
          commit = await commitOf(links.groupId, h);
          prevCommit = await commitOf(links.groupId, h - 1);
        }
        probeRows = await ports.probeRows(links.groupId, h);
      } catch {
        log("warn", "history walk: fetch failed", ids);
        return RETRY("transport");
      }
      const probes = pickProbes(
        Array.isArray(probeRows) ? (probeRows as ProbeSource[]) : [],
        { groupId: links.groupId, epoch: h },
        writers,
      );
      last = {
        holder_group_id: links.groupId,
        holder_epoch: h,
        candidates,
        commit,
        prev_commit: prevCommit,
        probes,
      };
      steps.push(last);
      rows += candidates.length;
      links.byEpoch.delete(h);
      writers = writersOf(candidates);
      // Below an empty step native has stopped; below epoch 0 the next
      // holder comes from the bridge link
      if (candidates.length === 0 || h === 0) break;
    }
    if (last === null) return RETRY("argument");

    // --- send it; one pin retry with the SAME steps ------------------------
    let answer: unknown;
    let pinned = false;
    let retarget = false;
    for (;;) {
      try {
        answer = await ports.importSteps(sessionGroup, session, steps);
        break;
      } catch (e) {
        const err = nativeErrorOf(e);
        const ids: Ids = {
          group_id: last.holder_group_id,
          epoch: last.holder_epoch,
        };
        if (err?.type === "identity_pin_required") {
          if (pinned) {
            log("warn", "history walk: a second identity pin is needed", ids);
            return RETRY("pin");
          }
          pinned = true;
          let ok = false;
          if (isId(err.user_id) && isId(err.device_id)) {
            try {
              ok = (await ports.pin(err.user_id, err.device_id)) === true;
            } catch {
              ok = false;
            }
          }
          if (!ok) {
            log("warn", "history walk: identity pin failed", ids);
            return RETRY("pin");
          }
          continue;
        }
        if (err?.type === "invalid_argument") {
          const field = typeof err.field === "string" ? err.field : "unknown";
          if (first && field === "holder_epoch") return "bump";
          if (field === "steps" && targets.length > 0) {
            retarget = true;
            break;
          }
          // Also a session native no longer holds: the next walk starts anew
          log("error", "history walk: call refused", { ...ids, field });
          return RETRY("argument");
        }
        log("error", "history walk: import failed", {
          ...ids,
          type: typeof err?.type === "string" ? err.type : "unknown",
        });
        return RETRY("transport");
      }
    }
    if (retarget) {
      const target = targets.shift();
      if (target === undefined) return RETRY("argument");
      log("warn", "history walk: bridge position refused, trying the next", {
        group_id: target.groupId,
        epoch: target.epoch,
      });
      links = linkBuffer(target.groupId, target.epoch);
      next = target.epoch;
      continue;
    }

    // --- read the answer ---------------------------------------------------
    const out = importedOf(answer);
    if (out === null) {
      log("error", "history walk: import answer unreadable", {
        group_id: last.holder_group_id,
        epoch: last.holder_epoch,
      });
      return RETRY("transport");
    }
    first = false;
    holders += steps.length;
    targets = [];
    for (const ref of out.imported) imported.push(ref);
    for (const refusal of out.refused) {
      refused.push(refusal);
      log("error", "history walk: link refused", {
        group_id: refusal.group_id,
        epoch: refusal.epoch,
        reason: refusal.reason,
      });
    }

    if (out.stopped !== null) {
      // Staged states were discarded, nothing was imported on trust: the
      // walk is retried on the next backward paging that needs it
      if (out.stopped === "unanchored") {
        log("warn", "history walk: unanchored", {
          group_id: last.holder_group_id,
          epoch: last.holder_epoch,
        });
        return RETRY("unanchored");
      }
      if (!KNOWN_STOPS.includes(out.stopped)) {
        log("error", "history walk: unknown stop", {
          group_id: last.holder_group_id,
          epoch: last.holder_epoch,
        });
      }
      return { kind: "stopped", stop: out.stopped, floor: out.floor };
    }
    if (!out.need_more) return { kind: "anchored" };

    // --- need_more: the holder below the last step -------------------------
    session = out.session;
    above = writers;
    if (last.candidates.length === 0) {
      // Native stops on a step without candidates; it cannot ask for more
      log("error", "history walk: more asked below an empty step", {
        group_id: last.holder_group_id,
        epoch: last.holder_epoch,
      });
      return RETRY("argument");
    }
    if (last.holder_epoch > 0) {
      next = last.holder_epoch - 1;
      continue;
    }
    targets = bridgeTargets(last);
    const target = targets.shift();
    if (target === undefined) {
      log("error", "history walk: bridge names no predecessor", {
        group_id: last.holder_group_id,
        epoch: last.holder_epoch,
      });
      return RETRY("argument");
    }
    links = linkBuffer(target.groupId, target.epoch);
    next = target.epoch;
  }
}

/**
 * Run one history walk downward from `start` (the lowest held epoch above
 * the missing one, with a sealed history key). Never rejects.
 *
 * - `anchored`: the walk met a held epoch and native verified the join.
 * - `stopped`: native stopped at `floor` for `stop`. A stop value this build
 *   does not know is passed on as it came; render it as a stop.
 * - `retry_later`: nothing final. `unanchored` (session caps), `transport`
 *   (a fetch or the bridge failed), `pin` (an identity pin is still owed),
 *   `argument` (native refused the call; also a session it no longer holds).
 *   Run the walk again on the next backward paging that needs it.
 *
 * `imported` and `refused` hold what native reported before the end, also
 * for a walk that ends in a stop or a retry.
 */
export async function runWalk(
  ports: WalkPorts,
  start: { groupId: string; holderEpoch: number },
): Promise<WalkResult> {
  const imported: HistoryEpochRef[] = [];
  const refused: HistoryRefusal[] = [];
  if (!isId(start.groupId) || !isEpoch(start.holderEpoch)) {
    ports.log("error", "history walk: bad start", {});
    return { end: RETRY("argument"), imported, refused };
  }
  for (let bump = 0; bump <= WALK_MAX_START_BUMPS; bump += 1) {
    const epoch = start.holderEpoch + bump;
    const end = await walkFrom(ports, start.groupId, epoch, imported, refused);
    if (end !== "bump") return { end, imported, refused };
    ports.log("warn", "history walk: start holder refused", {
      group_id: start.groupId,
      epoch,
    });
  }
  ports.log("error", "history walk: no start holder accepted", {
    group_id: start.groupId,
    epoch: start.holderEpoch,
  });
  return { end: RETRY("argument"), imported, refused };
}

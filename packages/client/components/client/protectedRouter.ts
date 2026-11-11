/**
 * Protected channels: the inbound MLS routing seam (W4 lane A5, plan D4/D5).
 *
 * MLS envelopes carry no channel id, so the bridge cannot tell a text-group
 * envelope from a call-group one by its event. `routeMls` is the whole
 * routing policy as one pure function over facts the bridge already holds:
 * whether the text id index (`protectedTextIds.ts` `TextIdIndex`) is seeded
 * and contains the envelope's group id, whether the text manager is up, and
 * this device's id. The bridge (lane B5) calls it in the three MLS event
 * arms BEFORE `#deliverMlsEnvelope` / `#mlsSink`, so a text Welcome or commit
 * never reaches the call session (which would retry it and then poison-ack
 * it, F3).
 *
 * `textSinkEnvelope` builds the `TextEnvelope` the manager receives from a
 * bonfire event and keeps all four commit declarations (`committer`,
 * `added`, `removed`, `rejoin_intents`); the call builder (`e2ee.ts`
 * `mlsSinkEnvelope`) drops them and stays unchanged. `textEnvelopeFromCommitInfo`
 * does the same for a stored commit (409 `Lost.winning`, gap-refetch row).
 *
 * Pure module: type-only imports, no Solid / SDK / livekit / lingui, so
 * `node --test --conditions=browser` loads it. Holds no key material.
 */
import type { MlsJoinRequest, MlsMemberDevice } from "./e2ee";
import type {
  TextCommitInfo,
  TextEnvelope,
  TextWireEnvelope,
} from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// routeMls (plan D4)
// ---------------------------------------------------------------------------

/**
 * Where an inbound MLS event goes.
 * - `text`: the protected text manager (`onEnvelope` / `onJoinRequest`).
 * - `call`: today's call path (`#deliverMlsEnvelope` / `#mlsSink`), byte for
 *   byte, including its own hold (`mlsHoldVerdict`).
 * - `pre_index_hold`: the bridge's pre-index `MlsInboundBuffer`; flushed in
 *   order back through `routeMls` when the index becomes ready and again when
 *   this device's id becomes known. Never acked while held.
 * - `drop_unacked`: dropped here and NOT acked (the server keeps a queued
 *   envelope for the next drain; a join request is broadcast-only and the
 *   joiner retries).
 */
export type MlsRoute = "text" | "call" | "pre_index_hold" | "drop_unacked";

/** The inputs of `routeMls`, every one a fact the bridge already holds. */
export interface RouteMlsInput {
  /**
   * `TextIdIndex.ready`. The bridge calls `markReady()` only after AWAITING
   * every Ready-time seeding `addChannel`: `markReady()` itself does not
   * wait for in-flight adds, and this function cannot see them.
   */
  indexReady: boolean;
  /** `TextIdIndex.has(group_id)` for the event's group id. */
  inIndex: boolean;
  /**
   * The text manager exists and can process now (Tauri, capable: provisioned,
   * enabled, not wiped, store and device owned by this account).
   */
  managerReady: boolean;
  /** The envelope's `recipient_device_id`; null for a join request. */
  recipientDeviceId: string | null;
  /** This device's id (`status.device_id`); null/empty while unknown. */
  ownDeviceId: string | null;
  kind: "envelope" | "join_request";
  /**
   * `transport instanceof TauriTransport && !IS_POPOUT_WINDOW &&
   * !IS_OVERLAY_WINDOW`. Structural only: NO e2ee status terms (a Tauri
   * device that is merely disabled or unprovisioned is still structural, so
   * its indexed envelopes drop instead of reaching the call session).
   */
  structural: boolean;
}

/**
 * The routing policy (plan D4 steps 1-7), evaluated in this order:
 * 1. not structural -> `call` (the seam is a no-op off the Tauri main window);
 * 2. index not ready -> envelope `pre_index_hold`, join request
 *    `drop_unacked` (join requests are never held);
 * 3. group id not in the index -> `call`;
 * 4. indexed but manager not ready -> `drop_unacked`, never `call`;
 * 5. indexed join request -> `text` (a join request has no recipient);
 * 6. indexed envelope, own device id unknown -> `pre_index_hold`; addressed
 *    to another device -> `drop_unacked`;
 * 7. otherwise -> `text`.
 */
export function routeMls(i: RouteMlsInput): MlsRoute {
  if (!i.structural) return "call";
  if (!i.indexReady) {
    return i.kind === "join_request" ? "drop_unacked" : "pre_index_hold";
  }
  if (!i.inIndex) return "call";
  if (!i.managerReady) return "drop_unacked";
  if (i.kind === "join_request") return "text";
  if (!i.ownDeviceId) return "pre_index_hold";
  if (i.recipientDeviceId !== i.ownDeviceId) return "drop_unacked";
  return "text";
}

// ---------------------------------------------------------------------------
// Envelope builders (plan D5)
// ---------------------------------------------------------------------------

/**
 * The bonfire event fields `textSinkEnvelope` reads: the `E2EEMessage` /
 * `MlsCommit` / `MlsWelcome` payload (stoat.js `E2EEEnvelope`, which lane S1
 * extends with the four declarations), stated structurally so this module
 * does not depend on the SDK build. Declarations may arrive absent or null.
 */
export interface TextSinkSource {
  id: string;
  recipient_device_id: string;
  content_type?: string | null;
  group_id?: string | null;
  epoch?: number | null;
  ciphertext: string;
  committer?: MlsMemberDevice | null;
  added?: MlsMemberDevice[] | null;
  removed?: MlsMemberDevice[] | null;
  rejoin_intents?: MlsJoinRequest[] | null;
}

/** The four declarations, normalized (absent vectors are empty). */
interface Declarations {
  committer?: MlsMemberDevice;
  added: MlsMemberDevice[];
  removed: MlsMemberDevice[];
  rejoin_intents: MlsJoinRequest[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Copy only the wire keys native knows (it may deny unknown keys). */
function memberDevice(v: unknown): MlsMemberDevice | null {
  if (!isRecord(v)) return null;
  return {
    user_id: v.user_id as string,
    device_id: v.device_id as string,
  };
}

function joinRequest(v: unknown): MlsJoinRequest | null {
  if (!isRecord(v)) return null;
  return {
    group_id: v.group_id as string,
    channel_id: v.channel_id as string,
    user_id: v.user_id as string,
    device_id: v.device_id as string,
    key_package_ref: v.key_package_ref as string,
    signature: v.signature as string,
  };
}

/**
 * An absent/null vector is `[]`; anything else that is not an array of
 * objects is malformed (null). Elements keep their wire keys only; their
 * values pass through for native to verify.
 */
function vector<T>(v: unknown, pick: (e: unknown) => T | null): T[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const e of v) {
    const picked = pick(e);
    if (picked === null) return null;
    out.push(picked);
  }
  return out;
}

function declarations(src: {
  committer?: unknown;
  added?: unknown;
  removed?: unknown;
  rejoin_intents?: unknown;
}): Declarations | null {
  const added = vector(src.added, memberDevice);
  const removed = vector(src.removed, memberDevice);
  const rejoin = vector(src.rejoin_intents, joinRequest);
  if (added === null || removed === null || rejoin === null) return null;
  const out: Declarations = { added, removed, rejoin_intents: rejoin };
  // An absent committer stays ABSENT (native D2 decides); never invented.
  if (src.committer !== undefined && src.committer !== null) {
    const committer = memberDevice(src.committer);
    if (committer === null) return null;
    out.committer = committer;
  }
  return out;
}

/**
 * The `TextEnvelope` for one inbound MLS event routed `text`, or null when it
 * is malformed. Same shape rule as the call builder: the event's own
 * `content_type` wins and `contentType` stands in when the server omitted it;
 * a commit/Welcome needs `group_id` + `epoch`; a ctl needs only `group_id`
 * and gets epoch 0 (native refuses ctl content on a text group,
 * `unexpected_mls_content`). A declaration that is present but not the right
 * shape makes the envelope malformed rather than silently dropping it.
 */
export function textSinkEnvelope(
  event: TextSinkSource,
  contentType: string,
): TextEnvelope | null {
  const type = event.content_type ?? contentType;
  const isCtl = type === "mls_ctl";
  if (
    typeof event.group_id !== "string" ||
    (!isCtl && typeof event.epoch !== "number")
  ) {
    return null;
  }
  const decl = declarations(event);
  if (decl === null) return null;
  return {
    id: event.id,
    content_type: type,
    group_id: event.group_id,
    epoch: event.epoch ?? 0,
    ciphertext: event.ciphertext,
    ...decl,
    recipientDeviceId: event.recipient_device_id,
  };
}

/** Prefix of the synthetic ids `textEnvelopeFromCommitInfo` mints. */
export const TEXT_SYNTH_ID_PREFIX = "text-synth:";

/**
 * True for an id `textEnvelopeFromCommitInfo` minted. Such an id is not a
 * mailbox row: the manager must never pass it to `port.ack`.
 */
export function isSynthTextEnvelopeId(id: string): boolean {
  return id.startsWith(TEXT_SYNTH_ID_PREFIX);
}

/**
 * The wire envelope for a stored commit (409 `Lost.winning`, gap-refetch
 * row), carrying ALL FOUR declarations (M8). Native dedups by (group, epoch);
 * the synthetic id `text-synth:{group}:{epoch}` is only the manager's own
 * dedup key and is never acked. Null when a declaration is malformed.
 */
export function textEnvelopeFromCommitInfo(
  info: TextCommitInfo,
): TextWireEnvelope | null {
  const decl = declarations(info);
  if (decl === null) return null;
  return {
    id: `${TEXT_SYNTH_ID_PREFIX}${info.group_id}:${info.epoch}`,
    content_type: "mls_commit",
    group_id: info.group_id,
    epoch: info.epoch,
    ciphertext: info.commit,
    ...decl,
  };
}

/**
 * The `e2ee_text_process` argument for a routed envelope: everything except
 * the routing-only `recipientDeviceId` (A1 ruling 6; native may deny unknown
 * keys).
 */
export function toWireEnvelope(env: TextEnvelope): TextWireEnvelope {
  const wire: TextWireEnvelope & { recipientDeviceId?: string } = { ...env };
  delete wire.recipientDeviceId;
  return wire;
}

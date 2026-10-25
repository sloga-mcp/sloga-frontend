/**
 * Message flows for Protected channels (text plane), W4 lane B4.
 *
 * - `encryptAndSend` (plan D10): native `_encrypt` mints the cid; the
 *   `{nonce, encrypted}` bytes persist per outbox key
 *   (`protected-send:<userId>:<channelId>:<key>`) BEFORE the POST and are
 *   re-sent byte for byte while the outcome is unknown. After an unknown
 *   outcome every non-2xx answer is confirmed by refetch first
 *   (`classifySendAnswer`); `DuplicateNonce` is never re-encrypted; the one
 *   Resecuring retry re-encrypts only after the earlier attempt is KNOWN to
 *   have failed.
 * - `decryptRow` (plan D22): a row without `encrypted` is a loud marker and
 *   never reaches native; `UnknownEpoch` ahead of `current` catches up and
 *   retries once. Never rejects: every failure is a marker.
 * - `markerForError`: D17's message mapping (A2), fail closed.
 *
 * Never plaintext: the typed text goes to `e2ee_text_encrypt` and nowhere
 * else (no request, no storage, no log). Logs carry ids only (D16).
 * Pure of Solid / livekit / lingui; tested over a fake port.
 */
import { protectedNoticeForError } from "./protectedShield.ts";
import {
  type SendAnswer,
  type SendTrigger,
  classifySendAnswer,
  confirmAfterId,
  publishBackoffMs,
} from "./protectedTextPolicy.ts";
import type {
  EncryptedPayload,
  GroupOps,
  NativeError,
  ProtectedMarkerKind,
  ProtectedMessageRow,
  ProtectedMessageView,
  ProtectedSendOutcome,
  ProtectedTextPort,
  TextApiResponse,
  TextDecrypted,
  TextEncrypted,
  TextFlowFailure,
} from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// Constants and storage (D10)
// ---------------------------------------------------------------------------

export const SEND_STORE_PREFIX = "protected-send:";

/** `limit` of every confirm page; also the `pageLimit` the policy gets. */
export const CONFIRM_PAGE_LIMIT = 100;

/** Confirm pages fetched per call before giving up for now. */
export const CONFIRM_PAGES_PER_CALL = 10;

/**
 * POST attempts per `encryptAndSend` call. Exhausting them rejects with the
 * stored entry KEPT, so the outbox retry with the same key re-sends the
 * same bytes (and confirms first, the outcome being unknown).
 */
export const SEND_ATTEMPTS_PER_CALL = 5;

/** D10 storage key of one outbox send. */
export function sendStoreKey(
  userId: string,
  channelId: string,
  key: string,
): string {
  return `${SEND_STORE_PREFIX}${userId}:${channelId}:${key}`;
}

/** Inverse of `sendStoreKey` for this user (B5 lists keys at start). */
export function parseSendStoreKey(
  storageKey: string,
  userId: string,
): { channelId: string; key: string } | null {
  const prefix = `${SEND_STORE_PREFIX}${userId}:`;
  if (!storageKey.startsWith(prefix)) return null;
  const rest = storageKey.slice(prefix.length);
  const i = rest.indexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return { channelId: rest.slice(0, i), key: rest.slice(i + 1) };
}

/** In-memory copy, so a failed storage write still reuses the bytes. */
const memo = new Map<string, string>();

/** In-flight decrypts by message id (own row: POST answer + live event). */
const inflight = new Map<string, Promise<ProtectedMessageView>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const clientFailure = (reason: string): TextFlowFailure => ({
  source: "client",
  reason,
});

const TRANSPORT: TextFlowFailure = { source: "transport" };

const FAILURE_SOURCES = ["native", "server", "transport", "client"];

function toFailure(e: unknown): TextFlowFailure {
  if (isRecord(e) && FAILURE_SOURCES.includes(e.source as string)) {
    return e as unknown as TextFlowFailure;
  }
  if (isRecord(e) && typeof e.type === "string") {
    return { source: "native", error: e as unknown as NativeError };
  }
  return clientFailure("unexpected_error");
}

function nativeErrorOf(e: unknown): Record<string, unknown> | null {
  if (!isRecord(e)) return null;
  if (e.source === "native") return isRecord(e.error) ? e.error : null;
  if (e.source !== undefined) return null;
  return typeof e.type === "string" ? e : null;
}

function parseEntry(raw: string | null): TextEncrypted | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      !isRecord(v) ||
      typeof v.nonce !== "string" ||
      confirmAfterId(v.nonce) === null ||
      !isRecord(v.encrypted)
    ) {
      return null;
    }
    return {
      nonce: v.nonce,
      encrypted: v.encrypted as unknown as EncryptedPayload,
    };
  } catch {
    return null;
  }
}

function readEntry(port: ProtectedTextPort, k: string): TextEncrypted | null {
  const raw = port.store.get(k) ?? memo.get(k) ?? null;
  const entry = parseEntry(raw);
  if (raw !== null && entry === null) {
    deleteEntry(port, k);
    port.log("warn", "[protected] corrupt stored send dropped", {});
  }
  return entry;
}

function saveEntry(port: ProtectedTextPort, k: string, e: TextEncrypted) {
  const raw = JSON.stringify({ nonce: e.nonce, encrypted: e.encrypted });
  memo.set(k, raw);
  if (!port.store.set(k, raw)) {
    port.log("warn", "[protected] send not persisted", { cid: e.nonce });
  }
}

function deleteEntry(port: ProtectedTextPort, k: string) {
  memo.delete(k);
  port.store.delete(k);
}

/** The POST body: the protected allowlist only (design 7.3). */
function sendBody(e: TextEncrypted, silent: boolean) {
  return silent
    ? { nonce: e.nonce, encrypted: e.encrypted, flags: 1 }
    : { nonce: e.nonce, encrypted: e.encrypted };
}

function outcomeOf(raw: unknown, cid: string): ProtectedSendOutcome | null {
  if (!isRecord(raw) || typeof raw._id !== "string") return null;
  return { messageId: raw._id, cid, raw };
}

function serverFailure(
  status: number,
  type: string | null,
  body: unknown,
): TextFlowFailure {
  return { source: "server", status, type, body };
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

function checkEncrypted(v: TextEncrypted): TextEncrypted {
  if (
    !isRecord(v) ||
    typeof v.nonce !== "string" ||
    confirmAfterId(v.nonce) === null ||
    !isRecord(v.encrypted)
  ) {
    throw clientFailure("malformed_encrypt");
  }
  return { nonce: v.nonce, encrypted: v.encrypted };
}

/** Native tags after which the manager should refresh (remove / join). */
const REFRESH_AFTER = new Set([
  "roster_mismatch",
  "mls_group_not_found",
  "not_seated",
]);

/**
 * `_encrypt`. `update_required` → `ops.ensureJoined`, which AWAITS the
 * manager's `_update` commit (D19; `refresh` only schedules it), then the
 * encrypt is retried ONCE.
 */
async function encrypt(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  text: string,
  replies: string[],
): Promise<TextEncrypted> {
  const args = { channelId, userId: port.selfUserId, text, replies };
  try {
    try {
      return checkEncrypted(await port.invoke("e2ee_text_encrypt", args));
    } catch (e) {
      const err = nativeErrorOf(e);
      if (err?.type !== "update_required") throw e;
      await ops.ensureJoined(channelId);
      return checkEncrypted(await port.invoke("e2ee_text_encrypt", args));
    }
  } catch (e) {
    const err = nativeErrorOf(e);
    if (typeof err?.type === "string" && REFRESH_AFTER.has(err.type)) {
      ops.refresh(channelId, "send_refused").catch(() => undefined);
    }
    throw toFailure(e);
  }
}

// ---------------------------------------------------------------------------
// Confirm refetch (D10)
// ---------------------------------------------------------------------------

function confirmPath(channelId: string, after: string, before: string | null) {
  const q = `after=${after}&sort=Latest&limit=${CONFIRM_PAGE_LIMIT}`;
  return `/channels/${channelId}/messages?${q}${
    before === null ? "" : `&before=${before}`
  }`;
}

async function confirmPage(
  port: ProtectedTextPort,
  channelId: string,
  trigger: SendTrigger,
  after: string,
  before: string | null,
): Promise<SendAnswer> {
  try {
    const response = await port.api(
      "GET",
      confirmPath(channelId, after, before),
    );
    return {
      kind: "confirm",
      trigger,
      response,
      pageLimit: CONFIRM_PAGE_LIMIT,
    };
  } catch {
    return { kind: "confirm_transport_error", trigger };
  }
}

// ---------------------------------------------------------------------------
// encryptAndSend (A1 `MessageFlows`)
// ---------------------------------------------------------------------------

/**
 * Encrypt (or reuse the stored bytes for `key`) and POST to a protected
 * channel. Resolves with the delivered server row (`raw`, for the SDK's
 * `getOrCreate(row, true)` + `noteOwnMessage`); rejects with a
 * `TextFlowFailure`. The stored entry is deleted on delivery or a
 * definitive refusal and KEPT whenever the outcome is still unknown.
 */
export async function encryptAndSend(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  text: string,
  replies: string[],
  silent: boolean,
  key: string,
): Promise<ProtectedSendOutcome> {
  const k = sendStoreKey(port.selfUserId, channelId, key);
  const signal = new AbortController().signal;
  let entry = readEntry(port, k);
  // A stored entry means an earlier attempt never resolved: unknown.
  let priorUnknown = entry !== null;
  if (entry === null) {
    entry = await encrypt(ops, port, channelId, text, replies);
    saveEntry(port, k, entry);
  }
  let resecureRetried = false;
  let failures = 0;
  let posts = 0;
  let pages = 0;
  let lastBody: unknown = null;

  const current = (): TextEncrypted => entry as TextEncrypted;
  const post = async (): Promise<SendAnswer> => {
    posts++;
    try {
      const response: TextApiResponse = await port.api(
        "POST",
        `/channels/${channelId}/messages`,
        sendBody(current(), silent),
      );
      lastBody = response.body;
      return { kind: "response", response };
    } catch {
      return { kind: "transport_error" };
    }
  };
  const pause = async (ms: number) => {
    try {
      await port.sleep(ms, signal);
    } catch {
      throw TRANSPORT; // aborted; the entry stays for the next attempt
    }
  };
  /** Re-send the SAME bytes after `ms`, within this call's budget. */
  const resend = async (ms: number): Promise<SendAnswer> => {
    failures++;
    if (posts >= SEND_ATTEMPTS_PER_CALL) throw TRANSPORT;
    await pause(ms);
    return post();
  };

  let answer = await post();
  for (;;) {
    const action = classifySendAnswer(answer, {
      selfUserId: port.selfUserId,
      cid: current().nonce,
      priorUnknown,
      resecureRetried,
      failures,
    });
    switch (action.kind) {
      case "delivered": {
        const outcome = outcomeOf(action.raw, current().nonce);
        if (outcome !== null) {
          deleteEntry(port, k);
          return outcome;
        }
        // A 2xx we cannot read: the row exists but is unknown to us.
        priorUnknown = true;
        answer = await resend(publishBackoffMs(failures));
        continue;
      }
      case "unknown":
        priorUnknown = true;
        answer = await resend(action.delayMs);
        continue;
      case "retry_same":
        answer = await resend(action.delayMs);
        continue;
      case "confirm":
        if (pages++ >= CONFIRM_PAGES_PER_CALL) throw TRANSPORT;
        answer = await confirmPage(
          port,
          channelId,
          action.trigger,
          action.after,
          action.before,
        );
        continue;
      case "confirm_later": {
        failures++;
        if (pages++ >= CONFIRM_PAGES_PER_CALL) throw TRANSPORT;
        await pause(action.delayMs);
        const after = confirmAfterId(current().nonce) as string;
        answer = await confirmPage(
          port,
          channelId,
          action.trigger,
          after,
          null,
        );
        continue;
      }
      case "resecure_retry": {
        // The earlier attempt is KNOWN to have failed: refresh (catch up /
        // commit the pending Remove), then ONE re-encrypt under a new cid.
        resecureRetried = true;
        try {
          await ops.refresh(channelId, "resecuring");
          entry = await encrypt(ops, port, channelId, text, replies);
        } catch (e) {
          deleteEntry(port, k);
          throw toFailure(e);
        }
        saveEntry(port, k, entry);
        priorUnknown = false;
        failures = 0;
        answer = await post();
        continue;
      }
      case "refused":
        deleteEntry(port, k);
        if (action.clientDefect) {
          port.log("error", "[protected] protected send field refused", {
            channelId,
            type: action.type,
          });
        }
        throw serverFailure(action.status, action.type, lastBody);
      case "maybe_unsent":
        // Possibly delivered but not visible: never re-encrypt here.
        deleteEntry(port, k);
        throw clientFailure("maybe_unsent");
    }
  }
}

// ---------------------------------------------------------------------------
// Decrypt (D22)
// ---------------------------------------------------------------------------

/** D17 message mapping (A2), with the one catch-up already spent. */
export function markerForError(err: unknown): ProtectedMarkerKind {
  const ui = protectedNoticeForError(err, { op: "message", catchUpDone: true });
  return ui.kind === "marker" ? ui.marker : "error";
}

const marker = (kind: ProtectedMarkerKind): ProtectedMessageView => ({
  status: "marker",
  kind,
});

function okView(row: ProtectedMessageRow, d: TextDecrypted) {
  if (
    !isRecord(d) ||
    d.message_id !== row.id ||
    d.channel_id !== row.channelId ||
    d.author_user_id !== row.authorId ||
    d.cid !== row.nonce ||
    typeof d.text !== "string" ||
    !Array.isArray(d.replies) ||
    !d.replies.every((r) => typeof r === "string")
  ) {
    return null;
  }
  const view: ProtectedMessageView = {
    status: "ok",
    text: d.text,
    replies: [...d.replies],
    senderVerified: d.sender_verified === true,
    tsSkew: d.ts_skew === true,
    cid: d.cid,
  };
  return view;
}

function aheadOfCurrent(err: Record<string, unknown>): boolean {
  return (
    typeof err.epoch === "number" &&
    typeof err.current === "number" &&
    typeof err.group_id === "string" &&
    err.epoch > err.current
  );
}

async function decryptOnce(
  ops: GroupOps,
  port: ProtectedTextPort,
  row: ProtectedMessageRow,
  live: boolean,
): Promise<ProtectedMessageView> {
  const ids = { messageId: row.id, channelId: row.channelId };
  // Design 3.9 step 1: never a native call, never the server's content.
  if (row.encrypted === null) return marker("unencrypted_row");
  if (row.nonce === null) return marker("malformed");
  const args = {
    channelId: row.channelId,
    messageId: row.id,
    authorUserId: row.authorId,
    nonce: row.nonce,
    encrypted: row.encrypted,
    live,
  };
  const attempt = async (): Promise<ProtectedMessageView> => {
    const view = okView(row, await port.invoke("e2ee_text_decrypt", args));
    if (view !== null) return view;
    port.log("error", "[protected] decrypt result mismatch", ids);
    return marker("error");
  };
  try {
    return await attempt();
  } catch (e) {
    const err = nativeErrorOf(e);
    if (err?.type === "unknown_epoch" && aheadOfCurrent(err)) {
      try {
        await ops.catchUp(
          row.channelId,
          err.epoch as number,
          err.group_id as string,
        );
      } catch {
        port.log("warn", "[protected] catch-up for decrypt failed", ids);
        return marker("decrypt_failed");
      }
      try {
        return await attempt();
      } catch (e2) {
        port.log("warn", "[protected] decrypt failed", {
          ...ids,
          tag: tagOf(e2),
        });
        return marker(markerForError(e2));
      }
    }
    port.log("warn", "[protected] decrypt failed", { ...ids, tag: tagOf(e) });
    return marker(markerForError(e));
  }
}

function tagOf(e: unknown): string {
  const t = nativeErrorOf(e)?.type;
  return typeof t === "string" ? t : "unknown";
}

/**
 * Decrypt one protected row into its view. Concurrent calls for the same
 * message id (and the same `live`) share one native decrypt: an own send
 * arrives as the POST answer AND as the live event. `live` is part of the
 * key so a history decrypt never swallows the live-only removed-sender
 * check (design 3.9 step 9). Never rejects.
 */
export function decryptRow(
  ops: GroupOps,
  port: ProtectedTextPort,
  row: ProtectedMessageRow,
  live: boolean,
): Promise<ProtectedMessageView> {
  const key = `${row.id}:${live ? "live" : "history"}`;
  const prior = inflight.get(key);
  if (prior !== undefined) return prior;
  const p = decryptOnce(ops, port, row, live)
    .catch(() => marker("error"))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test hook: forget in-memory state (never called by the app). */
export function _resetMessageFlowsForTest(): void {
  memo.clear();
  inflight.clear();
}

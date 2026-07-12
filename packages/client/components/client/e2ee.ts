/**
 * Desktop E2EE bridge (implementation plan, slice 3).
 *
 * Implements stoat.js's `E2EEAdapter` against the Tauri native crypto layer
 * (`acutest-desktop/src-tauri`). The webview is a COURIER: every key
 * decision (send mode, bundle verification, identity pinning) happens in
 * the native layer from local truth; this module shuttles public bundles,
 * envelopes and display plaintext between HTTP/WebSocket and IPC.
 *
 * Downgrade stance (invariants 1–3): `handleDirectMessageSend` returns null
 * — allowing the ordinary plaintext path — ONLY when the native layer's
 * `e2ee_send_mode` verdict is `plaintext` (never-encrypted conversation,
 * never-pinned peer). Every failure in encrypt mode THROWS: a lying or
 * broken server surfaces as a hard error, never as a silent plaintext send.
 * This is the webview half of the contract whose native half is gated by
 * `e2ee-core/tests/hostile_server.rs`.
 *
 * Sender-initiated upgrade (slice-3 gate LOW #4): a plaintext-verdict
 * conversation whose peer advertises opt-in (`User.e2eeEnabled`) gets an
 * encryption attempt on the next text send. The advertisement is an
 * UPGRADE trigger only — strictly one-directional server input. A server
 * lying "not opted in" merely preserves today's honest plaintext (no lock
 * shown); lying "opted in" leads to a bundle fetch whose contents are
 * signature-verified and TOFU-pinned natively, the same trust step the
 * receive path already performs on a first inbound message (safety-number
 * verification hardens TOFU in slice 5). If no verified keys come back,
 * nothing is pinned and the conversation stays plaintext.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { ReactiveMap } from "@solid-primitives/map";

import type {
  Channel,
  Client,
  E2EEAdapter,
  E2EEDataMessageSend,
  E2EEDraftFile,
  E2EEServerEvent,
  Message,
} from "stoat.js";

import { classifyEnvelopeError } from "./mlsEnvelopeClassify";

/** Author id used for locally-injected system/marker messages */
const SYSTEM_AUTHOR = "00000000000000000000000000";

/** Tauri IPC surface (global, `withGlobalTauri`) */
type TauriGlobal = {
  core: {
    /**
     * JSON args by default; a `Uint8Array` payload uses Tauri's raw-body
     * IPC (efficient byte transfer) with metadata in `options.headers`.
     */
    invoke<T>(
      command: string,
      args?: Record<string, unknown> | Uint8Array,
      options?: { headers?: Record<string, string> },
    ): Promise<T>;
  };
  /** Event bus (core:event) — used by the key-backup recovery courier */
  event?: {
    listen<T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void>;
  };
};

/** Scrubbed, typed error crossing the IPC (see e2ee-core `Error`) */
type NativeError = {
  type?: string;
  user_id?: string;
  device_ids?: string[];
};

type NativeStatus = {
  enabled: boolean;
  published: boolean;
  device_id: string | null;
  protocol_version: number;
};

type SendModeVerdict =
  | { mode: "encrypt" }
  | { mode: "blocked"; device_ids: string[] }
  | { mode: "plaintext" }
  | { mode: "peer_downgraded"; user_id: string };

/** Group roster entry + state (native `GroupState`) */
type GroupMember = {
  user_id: string;
  status: "active" | "announced" | "removed";
};
type GroupState = {
  conversation_id: string;
  encrypted_since: number | null;
  downgraded_at: number | null;
  peer_downgraded_by: string | null;
  pending_downgrade: boolean;
  members: GroupMember[];
};

/** Native `SafetyNumber` (digits + verification flags — never key bytes) */
export type SafetyNumber = {
  digits: string;
  binding_verified: boolean;
  user_verified: boolean;
};

type KeyBundle = { user_id: string; devices: unknown[] };

/** A key-backup upload bundle produced natively (opaque ciphertext) */
type BackupBundle = {
  header: string;
  ciphertext: string;
  generation: number;
  truncated: boolean;
};

/** One device's backup blob returned by the restore fetch */
type BackupBlob = {
  header: string;
  ciphertext: string;
  generation: number;
};

/** Local + server backup status for the Security & Privacy card */
export type BackupStatusView = {
  /** A recovery code has been created locally */
  exists: boolean;
  /** Last generation built locally */
  generation: number;
  /** Last generation the server confirmed (optimistic — design §4.5) */
  uploadedGeneration: number;
  /** Whether a blob is present on the server for this device (honest-server
   *  signal only; a compromised webview can fake this — design §4.5 H3) */
  serverHasBackup: boolean;
  createdAt: number;
  refreshedAt: number;
};

/** IPC-safe attachment metadata (mirrors native `AttachmentMeta` — no keys) */
export type E2EEAttachmentMeta = {
  local_id: string;
  idx: number | null;
  name: string;
  mime: string;
  /** Plaintext size in bytes */
  size: number;
  state: "pending" | "ready" | "failed" | "expired";
  blob_id: string | null;
};

type HistoryRow = {
  id: string;
  conversation: string;
  direction: "in" | "out";
  kind: string;
  content: string | null;
  /** Group sender attribution (slice 5); null for legacy dm rows */
  sender_user_id?: string | null;
  sender_device_id: string | null;
  sequence: number | null;
  detail: {
    missing?: number;
    user_id?: string;
    actor?: string;
    roster?: string[];
  } | null;
  created_at: number;
  attachments?: E2EEAttachmentMeta[];
};

type DecryptOutcome =
  | {
      kind: "message";
      id: string;
      conversation: string;
      sender_user_id: string;
      own_message: boolean;
      content: string;
      identity_changed: boolean;
      conversation_kind: "dm" | "group";
      /** "group_enable" | "roster_add" | "downgrade" — or null */
      control: string | null;
      control_detail: { user_id?: string; roster?: string[] } | null;
    }
  | { kind: "duplicate"; id: string }
  | {
      kind: "undecryptable";
      id: string;
      conversation: string;
      reason: string;
    };

type EncryptResult = {
  message_id: string;
  payload: {
    device_id: string;
    protocol_version: number;
    envelopes: unknown[];
  };
  revoked_devices: string[];
};

/** User-facing error for encrypt-mode failures (never falls back) */
export class E2EESendError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "blocked"
      | "no_devices"
      | "attachments_unsupported"
      | "delivery_failed"
      | "native",
  ) {
    super(message);
    this.name = "E2EESendError";
  }
}

// ================================================================
// Media E2EE — MLS call control-plane wire/return types (slice 6.3)
//
// Mirror the native `e2ee-core` MLS structs field-for-field (snake_case, as
// serialized by serde). Everything here is PUBLIC material, opaque
// ciphertext, or (frame keys ONLY) the §7.2 key-material egress. The webview
// couriers these between HTTP/WebSocket and native; it never derives them.
// ================================================================

/** A (user, device) pair — the unit of MLS membership. */
export interface MlsMemberDevice {
  user_id: string;
  device_id: string;
}

/** Body for `POST /mls/groups` (opaque to us; couriered verbatim). */
export interface MlsCreateGroupPayload {
  group_id: string;
  channel_id: string;
  device_id: string;
  supersedes?: string | null;
}

/** Result of `callCreate`: the group id + the `POST /mls/groups` body. */
export interface MlsCallCreated {
  group_id: string;
  payload: MlsCreateGroupPayload;
}

/** Body for `POST /mls/groups/<id>/join_intent`. */
export interface MlsJoinIntentPayload {
  device_id: string;
  key_package_ref: string;
  signature: string;
}

/** A fanned-out join intent (the `MlsJoinRequested` bonfire event). */
export interface MlsJoinRequest {
  group_id: string;
  channel_id: string;
  user_id: string;
  device_id: string;
  key_package_ref: string;
  signature: string;
}

/** A KeyPackage claimed for admission (flattened DS claim response). */
export interface MlsClaimedKeyPackage {
  user_id: string;
  device_id: string;
  key_package_ref: string;
  key_package: string;
  mls_signature_key: string;
  binding_signature: string;
  reused?: boolean;
}

/** Body for `POST /mls/groups/<id>/commits`. */
export interface MlsSubmitCommit {
  device_id: string;
  epoch: number;
  commit: string;
  welcome?: string | null;
  added?: MlsMemberDevice[];
  removed?: MlsMemberDevice[];
}

/** Body for `PUT /mls/key_packages` (public material + signatures). */
export interface MlsPublishKeyPackages {
  device_id: string;
  mls_signature_key: string;
  binding_signature: string;
  key_packages?: { key_package_ref: string; key_package: string }[];
  last_resort?: { key_package_ref: string; key_package: string } | null;
}

/** An inbound MLS handshake envelope (mailbox drain or live push). */
export interface MlsEnvelope {
  id: string;
  content_type: string;
  group_id: string;
  epoch: number;
  ciphertext: string;
}

/**
 * A received §3.4 downgrade ctl-announce (an MLS application message, 6.5).
 * `sender_*` comes from the VERIFIED MLS sender leaf (native); `payload` is
 * the raw application message (≤ 4 KiB) — the session validates its
 * `v`/`kind`/`mode` semantics (unknown ⇒ quiet drop, never an action).
 */
export interface MlsCtlReceived {
  sender_user_id: string;
  sender_device_id: string;
  payload: string;
}

/** Outcome of processing one inbound MLS envelope. */
export interface MlsProcessOutcome {
  group_id: string;
  kind: "welcome_joined" | "commit_applied" | "duplicate" | "ctl_received";
  epoch: number;
  removed_self: boolean;
  /** Non-empty ⇒ a Remove-driven epoch (§1.5 immediate send-key switch). */
  removed?: MlsMemberDevice[];
  /** Present only for `kind === "ctl_received"` (slice 6.5). */
  ctl?: MlsCtlReceived;
}

/** Body for `POST /mls/groups/<id>/messages` (the ctl-announce, 6.5). */
export interface MlsCtlPayload {
  group_id: string;
  ciphertext: string;
}

/** One call-roster member (display only — no key material). */
export interface MlsRosterEntry {
  user_id: string;
  device_id: string;
  user_verified: boolean;
}

/** Call-roster snapshot. */
export interface MlsCallState {
  group_id: string;
  channel_id: string;
  epoch: number;
  /** `active` | `poisoned` */
  state: string;
  members: MlsRosterEntry[];
}

/**
 * One sender's frame-key entry — the §7.2 egress. `frame_key_b64` is 32 bytes
 * of raw HKDF key MATERIAL (unpadded standard base64); the LiveKit worker
 * HKDFs it into the effective AES-128-GCM frame key. SECRET-BEARING —
 * memory-only, never logged.
 */
export interface MlsFrameKey {
  livekit_identity: string;
  user_id: string;
  device_id: string;
  key_index: number;
  epoch: number;
  frame_key_b64: string;
}

/** Frame keys for the current epoch (+ previous during rotation overlap). */
export interface MlsFrameKeys {
  group_id: string;
  epoch: number;
  keys: MlsFrameKey[];
  previous?: MlsFrameKey[];
}

// ================================================================
// MLS Delivery Service HTTP wire (slice 6.4)
//
// Request/response bodies for the `/mls` routes, mirroring the server v0
// models (crates/core/models/src/v0/mls.rs). The bridge couriers these; it
// never derives them. Everything is PUBLIC material or opaque ciphertext.
// ================================================================

/** Body for `POST /mls/key_packages/claim`. */
export interface MlsClaimKeyPackagesBody {
  device_id: string;
  group_id: string;
  targets: MlsMemberDevice[];
}

/**
 * One target's outcome in `ResponseClaimMlsKeyPackages.results`. The `Claimed`
 * variant flattens into an `MlsClaimedKeyPackage` for `callAdmit` (the client
 * re-verifies `binding_signature` natively — the DS relay is never trusted).
 */
export type MlsClaimResult =
  | {
      user_id: string;
      device_id: string;
      status: "Claimed";
      key_package_ref: string;
      key_package: string;
      mls_signature_key: string;
      binding_signature: string;
      reused: boolean;
    }
  | { user_id: string; device_id: string; status: "Exhausted" }
  | { user_id: string; device_id: string; status: "NotFound" };

/** Response to `POST /mls/key_packages/claim` (one entry per target, in order). */
export interface ResponseClaimMlsKeyPackages {
  results: MlsClaimResult[];
}

/** Response to `PUT /mls/key_packages` — drives the low-water replenish. */
export interface ResponsePublishMlsKeyPackages {
  key_package_count: number;
}

/**
 * A stored winning commit — the 409-Lost rebase body and the gap-refetch row.
 * The `commit` is opaque ciphertext; the added/removed `(user, device)` lists
 * are the call's per-device join/leave history (kept off channel co-members).
 */
export interface MlsCommitInfo {
  group_id: string;
  epoch: number;
  committer: MlsMemberDevice;
  commit: string;
  added: MlsMemberDevice[];
  removed: MlsMemberDevice[];
}

/** Response to `POST /mls/groups` (an `Arbitrated` — 200 Created / 409 Conflict). */
export type ResponseCreateMlsGroup =
  | { result: "Created" }
  | {
      result: "Conflict";
      /** The channel's already-open group id — join THAT one. */
      open_group_id: string;
      /**
       * The channel_id the open group is bound to (from the group record). The
       * join path compares its route-truth channel against this before signing
       * a join intent — the honest-DS T-15 leg (§1.4).
       */
      channel_id: string;
    };

/** Response to `POST /mls/groups/<id>/commits` (an `Arbitrated` — 200 Won / 409 Lost). */
export type ResponseSubmitMlsCommit =
  | { result: "Won" }
  | { result: "Lost"; winning: MlsCommitInfo };

/** Response to `GET /mls/groups/<id>/commits?from_epoch=` (ascending by epoch). */
export interface ResponseFetchMlsCommits {
  commits: MlsCommitInfo[];
  /** The group's current epoch, so a caught-up client knows it is current. */
  current_epoch: number;
}

/**
 * Outcome of an MLS Delivery Service HTTP call.
 *  - `ok`               — 2xx; `body` is the parsed response (`void` on 204).
 *  - `conflict`         — 409 on an arbitrated route (create-race or commit
 *                         Lost); `body` carries what the loser needs to rebase.
 *                         NORMAL control flow, never an exception (§approved
 *                         judgment call 3).
 *  - `feature_disabled` — the media-E2EE flag is off, so every `/mls` route
 *                         400s with `FeatureDisabled`. This is "not an E2EE
 *                         call" (§3.4 L4), NOT a failure: the session drops to
 *                         plaintext quietly and never latches a loud
 *                         NOT-ENCRYPTED state.
 * Any other non-2xx throws.
 */
export type MlsHttpResult<T> =
  | { kind: "ok"; body: T }
  | { kind: "conflict"; body: T }
  | { kind: "mfa_required" }
  | { kind: "feature_disabled" }
  // 404 on an opted-in route only (`mlsJoinIntent`): the group is gone or
  // CLOSED (the DS's solo-stale rejoin close) — normal control flow for the
  // joiner, which re-establishes onto the create path.
  | { kind: "not_found" }
  // MlsCallFull (409) on `mlsJoinIntent` (slice 6.5, A3): the group is at the
  // roster ceiling and this NEW joiner is refused — the call stays E2EE. The
  // joiner auto-leaves the SFU (a lingering refused joiner would be
  // non-enrolled and trip everyone's downgrade banner — the one-account
  // downgrade A3 rejects).
  | { kind: "call_full" };

/**
 * An event handed to the active call session's sink (registered via
 * `registerMlsSink`). The bridge normalizes the raw `Mls*` bonfire events into
 * the domain shapes the session works with — wire parsing stays in the bridge.
 * With no session registered the events are dropped and their envelopes stay
 * queued + UNACKED server-side, so a later call re-drains them (never ack what
 * no call consumes; the session, not the bridge, acks after durable
 * processing — §3.3).
 */
export type MlsSinkEvent =
  // `rejoin` rides BESIDE the request (not inside it — `MlsJoinRequest` is
  // the native wire shape): the intent came from a device that is already a
  // member, so verifying members remove its stale leaf instead of admitting.
  | { kind: "join_request"; request: MlsJoinRequest; rejoin: boolean }
  | { kind: "envelope"; envelope: MlsEnvelope; recipientDeviceId: string };

/** The active call session's inbound MLS event sink. */
export type MlsSessionSink = (event: MlsSinkEvent) => void;

/** Reactive per-channel call E2EE state (minimal in 6.3; 6.4/6.5 extend). */
export interface CallE2EEState {
  group_id: string;
  channel_id: string;
  epoch: number;
  /** `active` | `poisoned` */
  lifecycle: string;
  successorNeeded?: boolean;
}

/**
 * How a processed inbound envelope should be dispositioned by the mailbox
 * drain (carried 6.2 ack-and-drop item — the caller acts on `kind`).
 */
export type EnvelopeDisposition =
  | { kind: "processed"; outcome: MlsProcessOutcome; ack: true }
  | { kind: "park"; expected: number; got: number; ack: false }
  | {
      kind: "drop";
      reason: string;
      loud: boolean;
      successorNeeded: boolean;
      ack: true;
    }
  // A leaf was rejected ONLY because the named peer device's pinned identity
  // is not yet binding-verified — recoverable by reconciling that user's
  // SIGNED device listing and reprocessing the SAME envelope (leaf-verify
  // fix, audit MED-2/3). Never acked here; the drain bounds the attempts.
  | { kind: "needs_identity"; userId: string; deviceId: string; ack: false }
  | { kind: "error"; error: unknown; ack: false };

// `classifyEnvelopeError` (the pure native-rejection → disposition policy)
// lives in `mlsEnvelopeClassify.ts` so its allow-list is unit-testable in
// isolation (type-only back-import — no runtime cycle); re-exported here so
// the bridge surface is unchanged.
export { classifyEnvelopeError } from "./mlsEnvelopeClassify";

/**
 * Whether the native E2EE layer is reachable (Tauri desktop shell or the
 * Capacitor Android shell). The web build has no native layer — and the
 * server additionally refuses E2EE routes for sessions that never proved a
 * device claim.
 */
export function nativeE2EEAvailable(): boolean {
  if ((window as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke)
    return true;
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

// ================================================================
// Native transports
//
// One `E2EEBridge` speaks to two native shells through this seam. Both
// expose the SAME command allowlist backed by the SAME core crate
// (acutest-e2ee-core); only the carrier differs — Tauri IPC on desktop,
// a Capacitor plugin over uniffi on Android. Command names, argument
// shapes and error payloads are identical by construction, so every
// security decision above this seam is platform-independent.
// ================================================================

interface NativeTransport {
  /**
   * True when attachment ciphertext moves natively (Android): upload and
   * fetch happen in the shell, so multi-megabyte payloads never transit
   * the JS bridge. Desktop moves ciphertext over the (fast, binary-safe)
   * Tauri IPC and uploads from the webview instead.
   */
  readonly nativeBlobTransfer: boolean;
  invoke<T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<T>;
  /** WebView URL a decrypted attachment renders from (never carries keys) */
  attachmentUrl(messageId: string, idx: number): string;
  /** Android-only (`nativeBlobTransfer`): native ciphertext upload */
  uploadPrepared?(
    localId: string,
    url: string,
    authHeader: string,
    authValue: string,
    recipients: unknown[],
  ): Promise<void>;
  /** Android-only (`nativeBlobTransfer`): native ciphertext fetch+store */
  fetchAndStore?(
    localId: string,
    url: string,
    authHeader: string,
    authValue: string,
  ): Promise<"ready" | "expired" | "failed" | "pending">;
  /**
   * Present when the recovery-code surface is a native DIALOG rather than a
   * separate webview window (Android). The desktop shell instead opens the
   * bundled `e2ee-recovery` window and couriers the result over the
   * `e2ee:recovery-complete` event, so these are absent there.
   *
   * The recovery CODE lives entirely inside the native dialog; these return
   * only the opaque ciphertext the webview must courier to the server.
   */
  backupCreateDialog?(userId: string): Promise<BackupBundle>;
  backupRotateDialog?(userId: string): Promise<BackupBundle>;
  /**
   * Enter the code natively and restore. `blobs` are the opaque
   * `{header, ciphertext, server_generation}` triples fetched (MFA-ticketed)
   * from the server. Returns the post-restore republish payload (fresh OTKs)
   * for the caller to `PUT /e2ee/keys` with `replace_one_time_keys`.
   */
  backupRestoreDialog?(
    userId: string,
    blobs: { header: string; ciphertext: string; server_generation: number }[],
  ): Promise<Record<string, unknown> | null>;
}

class TauriTransport implements NativeTransport {
  readonly nativeBlobTransfer = false;
  #tauri = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;

  invoke<T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    return this.#tauri.core.invoke<T>(command, args, options);
  }

  /**
   * The desktop shell's `e2ee-att` protocol, which decrypts natively per
   * request. Windows serving origin; both path segments are ULIDs /
   * integers, so no encoding is needed.
   */
  attachmentUrl(messageId: string, idx: number): string {
    return `https://e2ee-att.localhost/${messageId}/${idx}`;
  }
}

/** Capacitor plugin surface (see android `E2eePlugin.kt`) */
type E2eeCapacitorPlugin = {
  call(options: Record<string, unknown>): Promise<{ json: string }>;
  wipe(): Promise<{ json: string }>;
  /** Native-dialog-gated downgrade (slice 5) */
  downgrade(options: Record<string, unknown>): Promise<{ json: string }>;
  /** Native-dialog-gated accept of a peer downgrade (slice 5) */
  confirmPeerDowngradeAccept(
    options: Record<string, unknown>,
  ): Promise<{ json: string }>;
  attachmentUpload(options: Record<string, unknown>): Promise<{ json: string }>;
  attachmentFetch(options: Record<string, unknown>): Promise<{ json: string }>;
  /** Native-dialog CREATE: mints + displays the code, returns the bundle */
  backupCreate(options: Record<string, unknown>): Promise<{ json: string }>;
  /** Native-dialog ROTATE: as create, continuing the generation counter */
  backupRotate(options: Record<string, unknown>): Promise<{ json: string }>;
  /** Native-dialog RESTORE: enters the code, returns the republish payload */
  backupRestore(options: Record<string, unknown>): Promise<{ json: string }>;
};

class CapacitorTransport implements NativeTransport {
  readonly nativeBlobTransfer = true;
  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");

  /**
   * Reject payloads are the core's scrubbed error JSON in the exception
   * message; parse it back so callers see the SAME typed error objects the
   * desktop Tauri IPC rejects with.
   */
  #rethrow(error: unknown): never {
    const message = (error as { message?: string })?.message;
    if (message?.startsWith("{")) {
      try {
        throw JSON.parse(message);
      } catch (parsed) {
        if (parsed && typeof parsed === "object" && "type" in parsed)
          throw parsed;
      }
    }
    throw error;
  }

  async invoke<T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    try {
      if (command === "e2ee_wipe") {
        // Dedicated plugin method: shows the BLOCKING native dialog
        // (decline rejects with the typed `declined` error)
        await this.#plugin.wipe();
        return undefined as T;
      }

      // Downgrade + accept-peer-downgrade are plaintext-direction
      // transitions → dedicated native-dialog plugin methods (wipe parity;
      // the webview can only request, never silently open plaintext).
      if (command === "e2ee_downgrade") {
        const { json } = await this.#plugin.downgrade(
          (args as Record<string, unknown>) ?? {},
        );
        return JSON.parse(json) as T;
      }
      if (
        command === "e2ee_confirm_peer_downgrade" &&
        (args as { accept?: boolean })?.accept
      ) {
        const { json } = await this.#plugin.confirmPeerDowngradeAccept(
          (args as Record<string, unknown>) ?? {},
        );
        return JSON.parse(json) as T;
      }

      let callArgs: Record<string, unknown>;
      if (args instanceof Uint8Array) {
        // Desktop raw-body convention → base64 + explicit fields. Only
        // attachment prepare sends bytes JS→native on Android (fetched
        // ciphertext moves natively via fetchAndStore).
        if (command !== "e2ee_attachment_prepare")
          throw { type: "invalid_argument", field: "body" };
        const headers = options?.headers ?? {};
        callArgs = {
          peerUserId: headers["x-peer-user-id"],
          name: decodeURIComponent(headers["x-name"] ?? ""),
          mime: decodeURIComponent(headers["x-mime"] ?? ""),
          plaintextBase64: bytesToBase64(args),
        };
      } else {
        callArgs = args ?? {};
      }

      const { json } = await this.#plugin.call({
        __cmd: command,
        ...callArgs,
      });
      return JSON.parse(json) as T;
    } catch (error) {
      this.#rethrow(error);
    }
  }

  /**
   * Same-origin path intercepted by the Android shell's WebViewClient
   * BEFORE the asset server (the `e2ee-att` analog) — decrypts natively
   * per request; key material never reaches the WebView.
   */
  attachmentUrl(messageId: string, idx: number): string {
    return `/_e2ee-att/${messageId}/${idx}`;
  }

  async uploadPrepared(
    localId: string,
    url: string,
    authHeader: string,
    authValue: string,
    recipients: unknown[],
  ): Promise<void> {
    try {
      await this.#plugin.attachmentUpload({
        localId,
        url,
        authHeader,
        authValue,
        recipientsJson: JSON.stringify(recipients),
      });
    } catch (error) {
      this.#rethrow(error);
    }
  }

  async fetchAndStore(
    localId: string,
    url: string,
    authHeader: string,
    authValue: string,
  ): Promise<"ready" | "expired" | "failed" | "pending"> {
    try {
      const { json } = await this.#plugin.attachmentFetch({
        localId,
        url,
        authHeader,
        authValue,
      });
      return JSON.parse(json);
    } catch (error) {
      this.#rethrow(error);
    }
  }

  async backupCreateDialog(userId: string): Promise<BackupBundle> {
    try {
      const { json } = await this.#plugin.backupCreate({ userId });
      return JSON.parse(json) as BackupBundle;
    } catch (error) {
      this.#rethrow(error);
    }
  }

  async backupRotateDialog(userId: string): Promise<BackupBundle> {
    try {
      const { json } = await this.#plugin.backupRotate({ userId });
      return JSON.parse(json) as BackupBundle;
    } catch (error) {
      this.#rethrow(error);
    }
  }

  async backupRestoreDialog(
    userId: string,
    blobs: { header: string; ciphertext: string; server_generation: number }[],
  ): Promise<Record<string, unknown> | null> {
    try {
      const { json } = await this.#plugin.backupRestore({
        userId,
        blobsJson: JSON.stringify(blobs),
      });
      return JSON.parse(json) as Record<string, unknown> | null;
    } catch (error) {
      this.#rethrow(error);
    }
  }
}

/** Chunk-safe base64 of a byte array (bridge-friendly) */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function createNativeTransport(): NativeTransport {
  if ((window as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke)
    return new TauriTransport();
  return new CapacitorTransport();
}

export class E2EEBridge implements E2EEAdapter {
  #client: Client;
  #transport: NativeTransport;
  /**
   * Whether "Encrypt my calls" is on for this device (slice 6.5 §0.2 #9) —
   * gates the media-E2EE KeyPackage pre-publish. FAIL-CLOSED default (ME-14):
   * an un-wired accessor never prepublishes; the RTC layer injects the real
   * one via `setCallsEnabled` from the local Voice store.
   */
  #callsEnabled: () => boolean = () => false;

  /** Sequentialises decrypts — ratchet order must match delivery order */
  #decryptQueue: Promise<void> = Promise.resolve();

  /**
   * Ids of messages this device decrypted and injected locally. The ONLY
   * trusted record of a message's encrypted-ness — a message flag would be
   * server-forgeable (fake lock / mislabelled report).
   */
  #encryptedIds = new Set<string>();

  /** Reactive per-peer send-mode cache for the composer indicator */
  readonly sendModes = new ReactiveMap<
    string,
    "encrypt" | "blocked" | "plaintext"
  >();

  /**
   * Reactive attachment metadata per message id (no key material — see
   * native `AttachmentMeta`). The renderer reads THIS, never message
   * flags or server-provided file objects, so a hostile server cannot
   * shape what renders inside an encrypted conversation.
   */
  readonly attachmentMeta = new ReactiveMap<string, E2EEAttachmentMeta[]>();

  /** Attachment fetches currently in flight (dedupe across syncs) */
  #fetchingAttachments = new Set<string>();

  /**
   * Set when reconcile reports own devices the native store has not pinned
   * yet. The core pins own devices ONLY via the `selfBundle` encrypt
   * parameter (it cannot distinguish "no other devices" from "unpinned
   * other devices", so it never raises `needs_bundle` for self) — without
   * this prefetch, own-device fan-out silently never happens and the
   * account's other devices miss every sent message.
   */
  #selfDevicesUnpinned = false;

  /** Reactive native status (drives the settings consent flow) */
  readonly status = new ReactiveMap<
    "state",
    NativeStatus & { claimed: boolean }
  >();

  /**
   * Reactive fresh-install signal. Set true by `#onReady` when this device is
   * NOT provisioned yet the ACCOUNT previously opted into E2EE
   * (`user.e2eeEnabled`) — i.e. a returning user on a new device who may hold
   * a server-side key backup to restore. The app shell observes this to offer
   * "Restore from a recovery code" vs "Start fresh" BEFORE anything opens the
   * engine (design §6.1). Deliberately NEVER set for a brand-new opt-in
   * (nothing to restore) or an already-provisioned device, so it never nags a
   * user who hasn't chosen encryption.
   */
  readonly restoreAvailable = new ReactiveMap<"state", boolean>();

  /**
   * Reactive revoked-device re-enroll signal (design §6.4). Set true when a
   * post-restore device claim is REJECTED because this device's server-side
   * identity row was revoked while the install was dead (remote logout ⇒
   * `revoke_devices_for_session` deleted the row). The restore itself
   * succeeded locally and `#pendingRestoreRepublish` still holds the fresh key
   * bundle; coming back requires re-publishing it as a FIRST publication under
   * a SECOND MFA ticket (`finishReenroll`) — the server re-inserts the same
   * device_id + identity keys and peers see the loud same-keys `device_readded`
   * (no identity-change warning). The app shell observes this to prompt that
   * re-auth. Cleared once the re-enroll publishes.
   */
  readonly reenrollNeeded = new ReactiveMap<"state", boolean>();

  constructor(client: Client) {
    this.#client = client;
    this.#transport = createNativeTransport();

    client.on("ready", () => void this.#onReady());
  }

  /**
   * Inject the "Encrypt my calls" accessor (slice 6.5 §0.2 #9) from the local
   * Voice store. Gates the media-E2EE KeyPackage pre-publish; fail-closed until
   * wired (ME-14). Idempotent.
   */
  setCallsEnabled(accessor: () => boolean): void {
    this.#callsEnabled = accessor;
  }

  // ================================================================
  // IPC + raw HTTP plumbing
  // ================================================================

  #invoke<T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    return this.#transport.invoke<T>(command, args, options);
  }

  /**
   * Raw fetch against delta. The generated typed client drops bodies for
   * routes missing from its tables (and /e2ee/* is newer than the
   * published stoat-api), so E2EE routes go through plain fetch.
   */
  async #api<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const [authHeader, authValue] = this.#client.authenticationHeader;

    const response = await fetch(`${this.#client.options.baseURL}${path}`, {
      method,
      headers: {
        [authHeader]: authValue,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`E2EE API ${method} ${path} failed: ${response.status}`);
    }

    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }

  async refreshStatus(): Promise<NativeStatus> {
    const status = await this.#invoke<NativeStatus>("e2ee_status");
    const previous = this.status.get("state");
    this.status.set("state", { ...status, claimed: previous?.claimed ?? false });
    return status;
  }

  // ================================================================
  // Lifecycle: connect → claim device → drain → replenish
  // ================================================================

  /**
   * Filesystem-level provisioning check that never opens (and never
   * provisions) the engine — the thin `is_provisioned` shell command
   * (desktop `e2ee_is_provisioned` / Android uniffi `is_provisioned`), which
   * calls the audited core's marker-aware check without touching crypto.
   */
  #isProvisioned(): Promise<boolean> {
    return this.#invoke<boolean>("e2ee_is_provisioned");
  }

  async #onReady(): Promise<void> {
    try {
      // A fresh/unprovisioned device must NOT open the engine on connect:
      // `refreshStatus` → `e2ee_status` → `E2ee::open` writes master.key +
      // store.db, and a provisioned store makes key-backup RESTORE unreachable
      // (it refuses `StoreAlreadyProvisioned`). Restore has to be the FIRST
      // E2EE op on a fresh install (design §6.1, KEY CAVEAT). So gate the
      // status query on the side-effect-free provisioning check first.
      const provisioned = await this.#isProvisioned();
      if (!provisioned) {
        // Returning user on a new device (account opted in on another device)
        // ⇒ surface the restore-vs-start-fresh choice; the engine stays
        // unopened until the user picks. A brand-new user (never opted in) is
        // left alone — E2EE is opt-in and there is nothing to restore.
        if (this.#client.user?.e2eeEnabled) {
          this.restoreAvailable.set("state", true);
        }
        return;
      }

      const status = await this.refreshStatus();
      if (status.enabled && status.published && status.device_id) {
        // Claiming grants queue drain/ack rights AND rebinds this session
        // as the device-bound one for the HTTP route gates
        this.#client.events.send({
          type: "E2EERequestChallenge",
          device_id: status.device_id,
        });

        // Self-heal the advertised opt-in flag: peers' sender-initiated
        // upgrade discovers us through it, and the PATCH in enable() is
        // allowed to fail (the flag is a hint, never the consent gate —
        // that is the MFA-gated key publish, which native status proves
        // already happened here).
        this.#advertiseOptIn();

        // Resume any downgrade whose ctl fan-out never confirmed its
        // receipts (crash / total POST failure) — re-send it so peers are
        // notified, or leave the "may not have reached everyone" state
        // [G2: 5].
        void this.#resumePendingDowngrades();
      }
      // NB: a §6.4 restore strand is NOT caught here. A restored store carries
      // `published = true` (restore imports the source device's published flag,
      // e2ee-core backup.rs), so a stranded restored device takes the branch
      // ABOVE, sends its challenge, and the server rejects it (revoked row) →
      // the durable re-enroll re-detection lives in `#onClaimResult`, which is
      // exactly where that rejection lands.
    } catch (error) {
      console.error("[e2ee] startup failed", error);
    }
  }

  async #resumePendingDowngrades(): Promise<void> {
    try {
      const pending = await this.#invoke<string[]>("e2ee_pending_downgrades");
      for (const conversationId of pending) {
        try {
          // Re-emit the downgrade ctl (no dialog — the original was already
          // confirmed). Receivers absorb the duplicate harmlessly.
          const result = await this.#invoke<EncryptResult>(
            "e2ee_resend_downgrade",
            {
              conversationId,
              selfUserId: this.#client.user!.id,
              bundles: [],
            },
          );
          await this.#api("POST", "/e2ee/messages", result.payload);
          await this.#invoke("e2ee_mark_downgrade_delivered", {
            conversationId,
          });
        } catch {
          /* re-send failed; the flag stays set for the next connect */
        }
      }
    } catch (error) {
      console.error("[e2ee] pending-downgrade resume failed", error);
    }
  }

  /**
   * Ensure our profile advertises E2EE opt-in (`e2ee_enabled`, UI/discovery
   * hint only — invariant 2). Idempotent, deliberately fire-and-forget:
   * failure never blocks enable() or startup, and every connect retries.
   */
  #advertiseOptIn(): void {
    const user = this.#client.user;
    if (!user || user.e2eeEnabled) return;

    user
      .edit({ e2ee_enabled: true } as unknown as Parameters<
        typeof user.edit
      >[0])
      .catch((error) =>
        console.error(
          "[e2ee] opt-in advertisement failed (will retry next connect)",
          error,
        ),
      );
  }

  onEvent(event: E2EEServerEvent): void {
    switch (event.type) {
      case "E2EEChallenge":
        void this.#proveDevice(event.nonce);
        break;
      case "E2EEClaimResult":
        void this.#onClaimResult(event.accepted);
        break;
      case "E2EEMessage": {
        // Serialise: drain + live pushes must decrypt in delivery order
        const envelope = { ...event, type: undefined };
        delete envelope.type;
        this.#decryptQueue = this.#decryptQueue.then(() =>
          this.#handleEnvelope(envelope).catch((error) =>
            console.error("[e2ee] envelope handling failed", error),
          ),
        );
        break;
      }
      case "E2EEDeviceCreate":
        void this.#onDeviceCreate(event.user_id);
        break;
      case "E2EEDeviceDelete":
        void this.#onDeviceDelete(event.user_id, event.device_id);
        break;
      case "MlsJoinRequested":
        // Admit trigger — hand the (already server-relayed, client-reverified)
        // intent to the active call session's admit scheduler. No session ⇒
        // dropped; a joiner re-broadcasts on its retry timer.
        this.#mlsSink?.({
          kind: "join_request",
          request: {
            group_id: event.group_id,
            channel_id: event.channel_id,
            user_id: event.user_id,
            device_id: event.device_id,
            key_package_ref: event.key_package_ref,
            signature: event.signature,
          },
          rejoin: event.rejoin ?? false,
        });
        break;
      case "MlsCommit":
      case "MlsWelcome":
      case "MlsCtl": {
        // MLS handshake / application envelope → the session's per-group
        // serialized drain (H1), NOT the text `#decryptQueue`. A well-formed
        // commit/welcome always carries group_id + epoch. A ctl (6.5) carries
        // group_id but NO meaningful epoch (an application message has no
        // per-group ordering) — require only group_id for it, and stamp epoch
        // 0 so the drain never PARKS a ctl. NOT acked here — the session acks
        // after durable native processing (§3.3).
        const isCtl = event.type === "MlsCtl";
        if (event.group_id == null || (!isCtl && event.epoch == null)) {
          break;
        }
        this.#mlsSink?.({
          kind: "envelope",
          recipientDeviceId: event.recipient_device_id,
          envelope: {
            id: event.id,
            content_type:
              event.content_type ??
              (event.type === "MlsWelcome"
                ? "mls_welcome"
                : event.type === "MlsCtl"
                  ? "mls_ctl"
                  : "mls_commit"),
            group_id: event.group_id,
            epoch: event.epoch ?? 0,
            ciphertext: event.ciphertext,
          },
        });
        break;
      }
    }
  }

  async #proveDevice(nonce: string): Promise<void> {
    const status = this.status.get("state");
    const sessionId = this.#client.sessionId;
    if (!status?.device_id || !sessionId) return;

    try {
      const signature = await this.#invoke<string>("e2ee_sign_claim", {
        sessionId,
        nonce,
      });
      this.#client.events.send({
        type: "E2EEProveDevice",
        device_id: status.device_id,
        signature,
      });
    } catch (error) {
      console.error("[e2ee] device claim signing failed", error);
    }
  }

  async #onClaimResult(accepted: boolean): Promise<void> {
    const state = this.status.get("state");
    if (state) this.status.set("state", { ...state, claimed: accepted });

    if (!accepted) {
      // §6.4 revoked-device restore. A rejected claim WITH a stashed
      // post-restore republish CAN mean the restored device's identity row was
      // revoked while this install was dead (the claim had nothing to bind to)
      // — but a claim also rejects transiently (a fetch error, a superseding
      // challenge nonce) or can be rejected by a hostile server. Only a MISSING
      // server row is the §6.4 case; escalating the others to an MFA'd first
      // publish would hit `assert_bound_session` and 401-loop, so corroborate
      // against the server directory before prompting re-enroll.
      if (this.#pendingRestoreRepublish) {
        const presence = await this.#ownDevicePresence();
        if (presence === "missing") {
          console.warn(
            "[e2ee] post-restore claim rejected — device row revoked; " +
              "re-enroll required (design §6.4)",
          );
          this.reenrollNeeded.set("state", true);
          return;
        }
        // Row present (or presence UNKNOWN — a blip we must not escalate on) ⇒
        // not confirmably §6.4. Re-bind via ONE fresh claim so the stashed
        // republish drains on the normal §6.3 device-bound path; never loop
        // (a superseding nonce or a hostile server must not spin us). A real
        // revocation masked as UNKNOWN here is re-detected durably on the next
        // reconnect's challenge→reject cycle (published stays true, so the
        // device re-challenges and lands back in this handler).
        if (!this.#restoreReclaimTried) {
          this.#restoreReclaimTried = true;
          console.warn(
            "[e2ee] post-restore claim rejected but device row present; re-claiming once",
          );
          const retry = this.status.get("state");
          if (retry?.device_id) {
            this.#client.events.send({
              type: "E2EERequestChallenge",
              device_id: retry.device_id,
            });
          }
          return;
        }
        console.error(
          "[e2ee] post-restore claim keeps failing with the device row present; " +
            "giving up (republish retained for the next connect)",
        );
        return;
      }

      // No stashed republish. A rejected claim with an ABSENT server row here is
      // the DURABLE §6.4 case (design §8 HIGH-1): a device that restored and was
      // revoked-while-dead, whose in-memory re-enroll payload was lost to a
      // dismissal or a reload — the restored store is `published = true`, so on
      // reconnect it reaches this path via the normal challenge→reject flow
      // rather than the initial in-session restore. Re-derive a fresh
      // first-publish payload natively (`post_restore_rekey` is re-callable and
      // rotates only served PUBLIC keys — never the audited AEAD/KDF/pickle) and
      // re-raise `reenrollNeeded`, so the persistent affordance + backstop modal
      // can drive `finishReenroll`. Runs on every reconnect until re-enrolled,
      // which is what makes the recovery durable. A "present"/"unknown" row is
      // NOT this case (see `#ownDevicePresence`) — fall through to the honest
      // error so a transient reject or a hostile server can't churn re-derives.
      if ((await this.#ownDevicePresence()) === "missing") {
        try {
          this.#pendingRestoreRepublish = await this.#invoke<Record<
            string,
            unknown
          > | null>("e2ee_backup_rederive_republish");
        } catch (error) {
          console.error(
            "[e2ee] re-derive of the re-enroll payload failed; retrying next connect",
            error,
          );
          return;
        }
        if (this.#pendingRestoreRepublish) {
          console.warn(
            "[e2ee] claim rejected with an absent server row — re-arming durable " +
              "§6.4 re-enroll (design §8 HIGH-1)",
          );
          this.reenrollNeeded.set("state", true);
          return;
        }
      }

      console.error(
        "[e2ee] device claim REJECTED — this session cannot drain envelopes",
      );
      return;
    }

    // A successful claim ends any pending §6.4 re-enroll / restore-reclaim
    // episode: clear the flag so a stale signal cannot nag or burn a needless
    // MFA, and reset the one-shot reclaim guard.
    this.reenrollNeeded.delete("state");
    this.#restoreReclaimTried = false;

    // A RESTORE stashes a fresh-OTK republish that must EVICT the stale
    // server-side keys (design §6.3). It is deferred to here — the restored
    // device_id already exists server-side, so the republish PUT needs THIS
    // session device-bound, which is true only now that the claim is accepted.
    await this.#publishRestoreRepublish();

    // Post-claim housekeeping: reconcile our own device list (loud on
    // change) and replenish one-time keys below the watermark
    try {
      await this.#reconcileDevices(this.#client.user!.id);
      await this.#replenish();
    } catch (error) {
      console.error("[e2ee] post-claim housekeeping failed", error);
    }
  }

  async #replenish(): Promise<void> {
    const state = this.status.get("state");
    if (!state?.device_id) return;

    const devices = await this.#api<
      { device_id: string; one_time_key_count?: number }[]
    >("GET", `/e2ee/devices/${this.#client.user!.id}`);

    const own = devices.find((d) => d.device_id === state.device_id);
    if (own?.one_time_key_count === undefined) return;

    const payload = await this.#invoke<unknown | null>("e2ee_replenish", {
      serverRemaining: own.one_time_key_count,
    });
    if (payload) {
      await this.#api("PUT", "/e2ee/keys", payload);
      await this.#invoke("e2ee_mark_published");
    }
  }

  /**
   * This device's presence in the server directory, as a THREE-way signal so a
   * genuine revocation during a network blip is not silently read as "still
   * present" (design §8 HIGH-1, folded LOW):
   *   - `"missing"` — the GET succeeded and our device_id is ABSENT (revoked /
   *     deleted while we were dead, design §6.4);
   *   - `"present"` — the GET succeeded and our device_id is listed;
   *   - `"unknown"` — the GET failed (offline / transient) or we have no
   *     device_id yet, so presence is not determinable this cycle.
   * Callers escalate to an MFA'd re-enroll ONLY on `"missing"`. `"unknown"`
   * must never trigger a first-publish (that would 401-loop against a
   * still-present row); it self-heals on the next reconnect, when the device
   * re-challenges and `#onClaimResult` re-evaluates presence — which is what
   * makes the recovery durable.
   */
  async #ownDevicePresence(): Promise<"present" | "missing" | "unknown"> {
    const deviceId = this.status.get("state")?.device_id;
    const userId = this.#client.user?.id;
    if (!deviceId || !userId) return "unknown";
    try {
      const devices = await this.#api<{ device_id: string }[]>(
        "GET",
        `/e2ee/devices/${userId}`,
      );
      return devices.some((d) => d.device_id === deviceId)
        ? "present"
        : "missing";
    } catch (error) {
      console.error("[e2ee] device-presence check failed", error);
      return "unknown";
    }
  }

  /** Fetch a signed device listing and reconcile pins natively */
  async #reconcileDevices(userId: string): Promise<void> {
    const devices = await this.#api<unknown[]>("GET", `/e2ee/devices/${userId}`);
    const report = await this.#invoke<{
      revoked: string[];
      changed: string[];
      new_devices: string[];
    }>("e2ee_reconcile_devices", { userId, devices });

    if (userId === this.#client.user?.id && report.new_devices.length) {
      this.#selfDevicesUnpinned = true;
    }

    if (
      report.revoked.length ||
      report.changed.length ||
      report.new_devices.length
    ) {
      await this.#refreshMode(userId);
      await this.#syncRecent(userId);
    }
  }

  /**
   * Reconcile the SIGNED device listings for a set of media-call roster users
   * (slice 6.4) so their MLS leaves become `binding_verified` BEFORE we accept
   * a Welcome / admit a joiner / process their Add — the call-plane analog of
   * `groupReconcile`'s per-member device step. De-duplicated + concurrent;
   * fail-closed PER USER: one we can't fetch (or whose listing doesn't cover a
   * device) stays unverified and its leaf is refused loudly later, never
   * trusted. Only upgrades an existing curve-only stub / re-affirms a pin — a
   * brand-new unpinned device stays UnknownIdentity (needs a bundle fetch,
   * deferred).
   */
  async reconcileCallRoster(userIds: string[]): Promise<void> {
    await Promise.all(
      [...new Set(userIds)].map((id) =>
        this.#reconcileDevices(id).catch(() => {
          /* unfetchable / unverifiable stays unverified — fail closed */
        }),
      ),
    );
  }

  async #onDeviceCreate(userId: string): Promise<void> {
    // Device-list changes are loud — for peers AND for our own account
    // (a new own-device could be an account compromise; A: crypto-2)
    try {
      await this.#reconcileDevices(userId);
    } catch (error) {
      console.error("[e2ee] device-create reconcile failed", error);
    }
  }

  async #onDeviceDelete(userId: string, deviceId: string): Promise<void> {
    try {
      await this.#invoke("e2ee_device_removed", { userId, deviceId });
      await this.#refreshMode(userId);
      await this.#syncRecent(userId);
    } catch (error) {
      console.error("[e2ee] device-delete handling failed", error);
    }
  }

  // ================================================================
  // Receive path: envelope → native decrypt → local store → ack
  // ================================================================

  async #handleEnvelope(envelope: Record<string, unknown>): Promise<void> {
    const state = this.status.get("state");
    if (!state?.enabled || envelope.recipient_device_id !== state.device_id) {
      // Not our device's envelope (another of the account's devices will
      // ack its own copy) — never ack what we cannot decrypt durably
      return;
    }

    const outcome = await this.#invoke<DecryptOutcome>("e2ee_decrypt", {
      envelope,
    });

    // EVERY outcome is durably processed native-side → always ack
    this.#client.events.send({ type: "E2EEAck", ids: [outcome.id] });

    if (outcome.kind === "duplicate") return;

    const conversation = outcome.conversation;
    const isGroup =
      outcome.kind === "message" && outcome.conversation_kind === "group";

    if (isGroup) {
      // A group conversation may have been ESTABLISHED by this very message
      // (an inbound group_enable). Resolve the group channel and surface it.
      const channel = this.#groupChannel(conversation);
      await this.#refreshGroupMode(conversation);
      await this.#syncRecentConversation(
        conversation,
        channel?.id ?? conversation,
        /* live */ true,
      );
    } else {
      await this.#refreshMode(conversation);
      // Inject the message and any markers the decrypt recorded (gap,
      // tampered, identity change …) with their canonical native row ids
      await this.#syncRecent(conversation, /* live */ true);
    }
  }

  #groupChannel(conversationId: string): Channel | undefined {
    const channel = this.#client.channels.get(conversationId);
    return channel?.type === "Group" ? channel : undefined;
  }

  // ================================================================
  // Send path — the choke point (see module docs)
  // ================================================================

  async handleDirectMessageSend(
    channel: Channel,
    data: E2EEDataMessageSend,
  ): Promise<Message | null> {
    const peerId = this.#peerOf(channel);
    if (!peerId) {
      if (data.e2eeAttachments?.length) {
        // Prepared encrypted attachments can never ride a plaintext send
        throw new E2EESendError(
          "Encrypted attachments could not be matched to a conversation. Nothing was sent.",
          "native",
        );
      }
      return null;
    }

    // The NATIVE layer is the SOLE authority for plaintext-vs-encrypt — the
    // webview never caches or second-guesses it (a stale cache is the
    // downgrade surface). If the native call FAILS we cannot prove this
    // conversation is plaintext, so we fail CLOSED (throw) rather than fall
    // through to the plaintext path (invariant 1).
    let verdict: SendModeVerdict;
    try {
      verdict = await this.#invoke<SendModeVerdict>("e2ee_send_mode", {
        peerUserId: peerId,
      });
    } catch {
      throw new E2EESendError(
        "Encryption status could not be verified. The message was NOT sent.",
        "native",
      );
    }
    this.sendModes.set(peerId, this.#composerMode(verdict));

    if (verdict.mode === "peer_downgraded") {
      throw new E2EESendError(
        "This contact turned off encryption. Confirm before sending unencrypted.",
        "blocked",
      );
    }

    // Sender-initiated upgrade (slice-3 gate LOW #4): a never-encrypted
    // conversation whose peer ADVERTISES opt-in gets an encryption attempt
    // on this send, instead of staying plaintext until the peer messages
    // first. The advertisement (`User.e2eeEnabled`) is an upgrade trigger
    // ONLY — it can never flip an encrypted conversation back (the native
    // verdict above always wins), and a peer without verified keys leaves
    // the conversation plaintext exactly as before (no pins created, no
    // lock shown). One-time keys are only consumed here, at a real send —
    // never eagerly on DM-open.
    let opportunistic = false;
    if (verdict.mode === "plaintext") {
      if (data.e2eeAttachments?.length) {
        // Prepared-encrypted ids with a plaintext verdict means local
        // E2EE state vanished between prepare and send (e.g. a wipe).
        // Never fall through to the plaintext route, never drop silently.
        throw new E2EESendError(
          "The encryption state changed while sending. Nothing was sent.",
          "native",
        );
      }
      if (!(await this.#shouldInitiate(peerId, data))) return null;
      opportunistic = true;
    }

    if (verdict.mode === "blocked") {
      throw new E2EESendError(
        "The recipient's security identity changed. Review the warning in the conversation before sending.",
        "blocked",
      );
    }

    // ---- encrypt mode: from here on every failure is a hard error ----

    if (data.attachments?.length) {
      // Plaintext-Autumn ids in an encrypt-mode send: the mode flipped
      // after a legacy upload (or a stale caller). The prepared-encrypted
      // path is `e2eeAttachments`; these must not leak into an envelope.
      throw new E2EESendError(
        "Attachments must be re-added to this now-encrypted conversation.",
        "attachments_unsupported",
      );
    }

    const content = data.content ?? "";
    const result = await this.#encryptWithBundles(
      peerId,
      content,
      opportunistic,
      data.e2eeAttachments ?? [],
    );
    if (!result) {
      // Opportunistic establishment found no usable peer keys (stale or
      // spoofed advertisement) — nothing was pinned, the conversation is
      // genuinely still plaintext. Fall through to the ordinary path.
      return null;
    }

    let receipts: unknown[];
    try {
      ({ receipts } = await this.#api<{ receipts: unknown[] }>(
        "POST",
        "/e2ee/messages",
        result.payload,
      ));
    } catch (error) {
      throw new E2EESendError(
        "The encrypted message could not be delivered. It was NOT sent unencrypted.",
        "delivery_failed",
      );
    }

    const revoked = await this.#invoke<string[]>("e2ee_handle_receipts", {
      receipts,
    });
    if (revoked.length || opportunistic) {
      // opportunistic: the conversation just became sticky-encrypted —
      // flip the composer indicator to the lock
      await this.#refreshMode(peerId);
    }

    // Local echo with the native store's canonical message id. Attachment
    // metadata arrives with the #syncRecent below (the rows were bound in
    // the native encrypt transaction) — the renderer reads the reactive
    // attachment map, so the echo picks them up without re-injection.
    const message = this.#inject(
      channel.id,
      {
        id: result.message_id,
        conversation: peerId,
        direction: "out",
        kind: "text",
        content,
        sender_device_id: null,
        sequence: null,
        detail: null,
        created_at: Math.floor(Date.now() / 1000),
      },
      true,
    );

    await this.#syncRecent(peerId);
    return message;
  }

  // ================================================================
  // Group send path (slice 5) — mirrors the DM choke point over the
  // native group surface (send_mode_group / encrypt_group). Audience is
  // the pinned roster (never a server- or webview-supplied list); every
  // encrypt-mode failure THROWS (no silent plaintext fallback).
  // ================================================================

  async handleGroupMessageSend(
    channel: Channel,
    data: E2EEDataMessageSend,
  ): Promise<Message | null> {
    if (channel.type !== "Group") return null;
    const conversationId = channel.id;

    let verdict: SendModeVerdict;
    try {
      verdict = await this.#invoke<SendModeVerdict>("e2ee_send_mode_group", {
        conversationId,
      });
    } catch {
      throw new E2EESendError(
        "Encryption status could not be verified. The message was NOT sent.",
        "native",
      );
    }
    this.sendModes.set(conversationId, this.#composerMode(verdict));

    if (verdict.mode === "plaintext") {
      if (data.e2eeAttachments?.length) {
        throw new E2EESendError(
          "The encryption state changed while sending. Nothing was sent.",
          "native",
        );
      }
      return null; // never-encrypted group: ordinary plaintext path
    }

    if (verdict.mode === "peer_downgraded") {
      throw new E2EESendError(
        "A member turned off encryption for this group. Confirm before sending unencrypted.",
        "blocked",
      );
    }

    if (verdict.mode === "blocked") {
      throw new E2EESendError(
        "A member's security identity changed. Review the warning before sending.",
        "blocked",
      );
    }

    if (data.attachments?.length) {
      throw new E2EESendError(
        "Attachments must be re-added to this now-encrypted group.",
        "attachments_unsupported",
      );
    }

    const content = data.content ?? "";
    const result = await this.#encryptGroupWithBundles(
      conversationId,
      content,
      data.e2eeAttachments ?? [],
    );

    let receipts: unknown[];
    try {
      ({ receipts } = await this.#api<{ receipts: unknown[] }>(
        "POST",
        "/e2ee/messages",
        result.payload,
      ));
    } catch {
      throw new E2EESendError(
        "The encrypted message could not be delivered. It was NOT sent unencrypted.",
        "delivery_failed",
      );
    }

    await this.#invoke<string[]>("e2ee_handle_receipts", { receipts });

    const message = this.#inject(
      channel.id,
      {
        id: result.message_id,
        conversation: conversationId,
        direction: "out",
        kind: "text",
        content,
        sender_user_id: this.#client.user!.id,
        sender_device_id: null,
        sequence: null,
        detail: null,
        created_at: Math.floor(Date.now() / 1000),
      },
      true,
    );

    await this.#syncRecentConversation(conversationId, channel.id);
    return message;
  }

  /**
   * Encrypt to a group, fetching verified-later bundles only when the
   * native layer demands them (`needs_bundle` for a sessionless member
   * device). All-of-audience-or-nobody: a member that cannot be encrypted
   * to is a hard error, never a partial send.
   */
  async #encryptGroupWithBundles(
    conversationId: string,
    content: string,
    attachmentIds: string[],
  ): Promise<EncryptResult> {
    const bundles: KeyBundle[] = [];
    const fetched = new Set<string>();

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.#invoke<EncryptResult>("e2ee_encrypt_group", {
          conversationId,
          selfUserId: this.#client.user!.id,
          bundles,
          content,
          attachments: attachmentIds,
        });
      } catch (raw) {
        const native = raw as NativeError;
        if (native.type === "needs_bundle" && native.user_id) {
          if (fetched.has(native.user_id)) throw raw;
          fetched.add(native.user_id);
          const bundle = await this.#api<KeyBundle>(
            "GET",
            `/e2ee/keys/${native.user_id}`,
          );
          bundles.push(bundle);
          continue;
        }
        if (native.type === "peer_identity_changed") {
          await this.#refreshGroupMode(conversationId);
          throw new E2EESendError(
            "A member's security identity changed. Review the warning before sending.",
            "blocked",
          );
        }
        if (native.type === "fan_out_too_large") {
          throw new E2EESendError(
            "This encrypted group is too large to send to (too many member devices).",
            "native",
          );
        }
        throw raw;
      }
    }
    throw new E2EESendError(
      "Could not gather encryption keys for every group member.",
      "native",
    );
  }

  /**
   * Enable end-to-end encryption for a group (design §2.5). The caller
   * (settings UI) has shown the asserted-roster checklist and confirmed.
   * `roster` MUST be the exact member set the user is asserting.
   */
  async enableGroupEncryption(channel: Channel, roster: string[]): Promise<void> {
    if (channel.type !== "Group") throw new Error("not a group");
    const bundles: KeyBundle[] = [];
    const fetched = new Set<string>();

    for (let attempt = 0; attempt < roster.length + 2; attempt++) {
      try {
        const result = await this.#invoke<EncryptResult>("e2ee_enable_group", {
          conversationId: channel.id,
          roster,
          selfUserId: this.#client.user!.id,
          bundles,
        });
        await this.#api("POST", "/e2ee/messages", result.payload);
        await this.#refreshGroupMode(channel.id);
        await this.#syncRecentConversation(channel.id, channel.id);
        return;
      } catch (raw) {
        const native = raw as NativeError;
        if (native.type === "needs_bundle" && native.user_id) {
          if (fetched.has(native.user_id)) throw raw;
          fetched.add(native.user_id);
          bundles.push(
            await this.#api<KeyBundle>("GET", `/e2ee/keys/${native.user_id}`),
          );
          continue;
        }
        throw raw;
      }
    }
  }

  /** Native group state (roster + sticky state) for the UI. */
  async groupState(conversationId: string): Promise<GroupState> {
    return this.#invoke<GroupState>("e2ee_group_state", { conversationId });
  }

  /**
   * Reconcile a group's displayed member list against the pinned roster —
   * announces displayed-but-unpinned members (loud, never encrypted to)
   * and removes vanished ones (availability-only). Call on channel open and
   * on membership events for encrypted groups.
   *
   * Also reconciles each member's SIGNED device listing so genuine member
   * devices become `binding_verified` — the native layer requires that
   * before honoring a member's roster-mutation / downgrade control message
   * (final-audit CRITICAL-2 gate). Without this step a real member's roster
   * change is deferred (fail-closed) until we've verified them.
   */
  async groupReconcile(channel: Channel): Promise<void> {
    if (channel.type !== "Group") return;
    try {
      const displayed = [...channel.recipientIds.values()];
      await this.#invoke("e2ee_group_reconcile", {
        conversationId: channel.id,
        displayed,
        selfUserId: this.#client.user!.id,
      });

      // Verify every member's device identities from their signed listing
      // (self included, so our OWN other devices' roster/downgrade controls
      // also carry authority). A forged device can't produce a valid
      // signature, so this only ever upgrades genuine bindings.
      await Promise.all(
        displayed.map((id) =>
          this.#reconcileDevices(id).catch(() => {
            /* a member we can't fetch stays unverified — fail closed */
          }),
        ),
      );

      await this.#syncRecentConversation(channel.id, channel.id);
    } catch (error) {
      // A non-established group throws group_not_established — expected for
      // plaintext groups; ignore.
      const native = error as NativeError;
      if (native.type !== "group_not_established") {
        console.error("[e2ee] group reconcile failed", error);
      }
    }
  }

  /**
   * The safety number for a peer device (design §3) — digits + verification
   * flags only; key bytes never cross the IPC.
   */
  async safetyNumber(
    peerUserId: string,
    deviceId: string,
  ): Promise<SafetyNumber> {
    return this.#invoke<SafetyNumber>("e2ee_safety_number", {
      selfUserId: this.#client.user!.id,
      peerUserId,
      deviceId,
    });
  }

  /** Mark a peer device user-verified after an in-person comparison. */
  async markVerified(peerUserId: string, deviceId: string): Promise<void> {
    await this.#invoke("e2ee_mark_verified", { peerUserId, deviceId });
    await this.#syncRecent(peerUserId);
  }

  /**
   * Explicitly downgrade a conversation (DM or group) to plaintext (design
   * §5.2). The native layer shows a BLOCKING OS confirmation; declining
   * rejects with the typed `declined` error. On success the downgrade
   * control message fans out and the sticky state clears.
   */
  async downgradeConversation(channel: Channel): Promise<void> {
    const conversationId =
      channel.type === "Group" ? channel.id : this.#peerOf(channel);
    if (!conversationId) return;

    let result: EncryptResult;
    try {
      result = await this.#invoke<EncryptResult>("e2ee_downgrade", {
        conversationId,
        selfUserId: this.#client.user!.id,
        bundles: [],
      });
    } catch (raw) {
      const native = raw as NativeError;
      if (native.type === "declined") return; // user cancelled the OS dialog
      throw raw;
    }

    try {
      await this.#api("POST", "/e2ee/messages", result.payload);
      await this.#invoke("e2ee_mark_downgrade_delivered", { conversationId });
    } catch {
      // Receipts unconfirmed — the pending-downgrade flag stays set and is
      // retried on next connect (#onReady). Surface nothing destructive.
      console.warn("[e2ee] downgrade notice delivery unconfirmed");
    }

    if (channel.type === "Group") await this.#refreshGroupMode(conversationId);
    else await this.#refreshMode(conversationId);
    await this.#syncRecentConversation(conversationId, channel.id);
  }

  /**
   * Resolve a peer's downgrade prompt (design §5.2) — the local user action
   * that gates the plaintext direction on the receiving side. `accept`
   * opens plaintext; declining keeps the conversation encrypted.
   */
  async confirmPeerDowngrade(
    channel: Channel,
    accept: boolean,
  ): Promise<void> {
    const conversationId =
      channel.type === "Group" ? channel.id : this.#peerOf(channel);
    if (!conversationId) return;
    await this.#invoke("e2ee_confirm_peer_downgrade", {
      conversationId,
      accept,
    });
    if (channel.type === "Group") await this.#refreshGroupMode(conversationId);
    else await this.#refreshMode(conversationId);
  }

  /** Composer-facing mode string (collapses peer_downgraded to blocked). */
  #composerMode(
    verdict: SendModeVerdict,
  ): "encrypt" | "blocked" | "plaintext" {
    if (verdict.mode === "encrypt") return "encrypt";
    if (verdict.mode === "plaintext") return "plaintext";
    return "blocked"; // blocked or peer_downgraded — composer shows a guard
  }

  async #refreshGroupMode(conversationId: string): Promise<void> {
    try {
      const verdict = await this.#invoke<SendModeVerdict>(
        "e2ee_send_mode_group",
        { conversationId },
      );
      this.sendModes.set(conversationId, this.#composerMode(verdict));
    } catch {
      /* leave the last known mode */
    }
  }

  /**
   * Populate the group send-mode cache for the composer (idempotent). Unlike
   * groupReconcile this works for a never-encrypted group too, so the
   * "Encrypt this group" affordance can appear.
   */
  primeGroupMode(conversationId: string): Promise<void> {
    return this.#refreshGroupMode(conversationId);
  }

  /** Group-aware analog of `#syncRecent` (keyed by conversation id). */
  async #syncRecentConversation(
    conversationId: string,
    channelId: string,
    live = false,
  ): Promise<void> {
    const rows = await this.#invoke<HistoryRow[]>("e2ee_history", {
      peerUserId: conversationId,
      before: null,
      limit: 10,
    });
    for (const row of rows.reverse()) {
      const isNew = live && !this.#client.messages.has(row.id);
      this.#inject(channelId, row, isNew);
    }
  }

  /**
   * Preconditions for a sender-initiated upgrade of a plaintext-verdict
   * conversation. All of these are UPGRADE triggers only — a false negative
   * just keeps today's honest plaintext state, and no condition here can
   * ever push an encrypted conversation toward plaintext (the native
   * verdict is checked first and always wins).
   */
  async #shouldInitiate(
    peerId: string,
    data: { attachments?: string[] | null },
  ): Promise<boolean> {
    // Attachments would already have been uploaded to plaintext Autumn by
    // the draft path (guardSend saw a plaintext verdict) — upgrading now
    // would hard-error on attachments and orphan the upload. Text-only
    // sends upgrade; attachment sends keep the plaintext status quo.
    if (data.attachments?.length) return false;

    // The peer must advertise opt-in (UI/discovery hint — see User docs)
    if (!this.#client.users.get(peerId)?.e2eeEnabled) return false;

    // Never opportunistically PROVISION an unprovisioned device here: the
    // status query below would open the engine and write the store, pre-empting
    // a pending restore (design §6.1, KEY CAVEAT). A never-provisioned device
    // cannot be enabled anyway, so returning false is behaviour-preserving —
    // it only drops the empty-store side effect.
    try {
      if (!(await this.#isProvisioned())) return false;
    } catch {
      return false;
    }

    // ... and this device must actually be able to encrypt. Native status,
    // not the webview cache: a failure here just skips the upgrade.
    try {
      const status = await this.refreshStatus();
      return status.enabled && status.published && !!status.device_id;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt, fetching verified-later bundles only when the native layer
   * demands them (`needs_bundle` — sessionless devices only, which also
   * avoids needless one-time-key consumption).
   *
   * `opportunistic` (sender-initiated upgrade of a plaintext-verdict
   * conversation) returns `null` instead of throwing for exactly the
   * failures that occur BEFORE any peer state is pinned — a peer bundle
   * that cannot be fetched or contains no devices. Those leave the
   * conversation genuinely plaintext (the advertisement was stale or the
   * server withheld keys; the composer showed no lock either way). Every
   * failure after pinning is a hard error in both modes.
   */
  async #encryptWithBundles(
    peerId: string,
    content: string,
    opportunistic = false,
    attachments: string[] = [],
  ): Promise<EncryptResult | null> {
    const selfId = this.#client.user!.id;
    let peerBundle: unknown = null;
    let selfBundle: unknown = null;

    if (this.#selfDevicesUnpinned) {
      // Own devices need pinning and the core only pins them from a
      // selfBundle passed here. Best-effort: fan-out to own devices must
      // never block the send to the peer.
      try {
        selfBundle = await this.#api<unknown>("GET", `/e2ee/keys/${selfId}`);
      } catch (error) {
        console.warn("[e2ee] self bundle fetch failed; sending without own-device fan-out", error);
      }
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.#invoke<EncryptResult>("e2ee_encrypt", {
          peerUserId: peerId,
          selfUserId: selfId,
          peerBundle,
          selfBundle,
          content,
          attachments,
        });
        // Pins are durable in the native store — stop prefetching
        if (selfBundle) this.#selfDevicesUnpinned = false;
        return result;
      } catch (error) {
        const native = error as NativeError;

        if (native.type === "needs_bundle" && attempt < 2) {
          let bundle: unknown;
          try {
            bundle = await this.#api<unknown>(
              "GET",
              `/e2ee/keys/${native.user_id}`,
            );
          } catch (fetchError) {
            if (opportunistic && native.user_id === peerId) {
              // Peer bundle unavailable before anything was pinned —
              // the conversation stays honestly plaintext
              return null;
            }
            throw fetchError;
          }
          if (native.user_id === peerId) peerBundle = bundle;
          else selfBundle = bundle;
          continue;
        }

        if (native.type === "peer_identity_changed") {
          await this.#refreshMode(peerId);
          throw new E2EESendError(
            "The recipient's security identity changed. Review the warning in the conversation before sending.",
            "blocked",
          );
        }

        if (
          native.type === "no_usable_devices" ||
          native.type === "peer_has_no_devices"
        ) {
          if (opportunistic && native.user_id === peerId) {
            // Advertised peer has no registered devices (empty bundle —
            // stale flag or revoked keys). Nothing was pinned; plaintext
            // status quo.
            return null;
          }
          throw new E2EESendError(
            "No trusted device of the recipient can currently receive encrypted messages. The message was NOT sent unencrypted.",
            "no_devices",
          );
        }

        throw new E2EESendError(
          "Encryption failed. The message was NOT sent unencrypted.",
          "native",
        );
      }
    }
  }

  // ================================================================
  // Local history (the ONLY history for E2EE DMs)
  // ================================================================

  async fetchLocalHistory(
    channel: Channel,
    params?: { limit?: number; before?: string },
  ): Promise<Message[] | null> {
    const state = this.status.get("state");
    if (!state?.enabled) return null;

    const isGroup = channel.type === "Group";
    const conversationId = isGroup ? channel.id : this.#peerOf(channel);
    if (!conversationId) return null;

    const verdict = await this.#invoke<SendModeVerdict>(
      isGroup ? "e2ee_send_mode_group" : "e2ee_send_mode",
      isGroup ? { conversationId } : { peerUserId: conversationId },
    );
    this.sendModes.set(conversationId, this.#composerMode(verdict));
    if (verdict.mode === "plaintext") return null;

    const limit = params?.limit ?? 50;
    const rows = await this.#invoke<HistoryRow[]>("e2ee_history", {
      peerUserId: conversationId,
      before: params?.before ?? null,
      limit,
    });

    const messages = rows.map((row) => this.#inject(channel.id, row, false));

    // Start of local history: the "history starts here" divider (older
    // messages, if any ever existed, live only on the devices that
    // received them — the server holds no readable history)
    if (rows.length < limit) {
      messages.push(
        this.#inject(
          channel.id,
          {
            id: `00${channel.id.slice(0, 24)}`,
            conversation: conversationId,
            direction: "in",
            kind: "history_start",
            content: null,
            sender_device_id: null,
            sequence: null,
            detail: null,
            created_at: 0,
          },
          false,
        ),
      );
    }

    return messages;
  }

  /**
   * Re-inject the newest native history rows for a conversation. Rows keep
   * their canonical native ids, so this is idempotent — used after
   * decrypts and device events to surface new messages AND the marker rows
   * the native layer recorded alongside them.
   */
  async #syncRecent(peerId: string, live = false): Promise<void> {
    const channel = await this.#dmChannel(peerId);
    if (!channel) return;

    const rows = await this.#invoke<HistoryRow[]>("e2ee_history", {
      peerUserId: peerId,
      before: null,
      limit: 10,
    });

    for (const row of rows.reverse()) {
      const isNew = live && !this.#client.messages.has(row.id);
      this.#inject(channel.id, row, isNew);
    }
  }

  // ================================================================
  // Helpers
  // ================================================================

  #peerOf(channel: Channel): string | undefined {
    return [...channel.recipientIds.values()].find(
      (id) => id !== this.#client.user!.id,
    );
  }

  async #dmChannel(peerId: string): Promise<Channel | undefined> {
    const existing = [...this.#client.channels.values()].find(
      (channel) =>
        channel.type === "DirectMessage" &&
        channel.recipientIds.has(peerId),
    );
    if (existing) return existing;

    try {
      const user =
        this.#client.users.get(peerId) ??
        (await this.#client.users.fetch(peerId));
      return await user.openDM();
    } catch (error) {
      console.error("[e2ee] could not open DM channel", error);
      return undefined;
    }
  }

  /** Marker row → user-facing system text */
  #markerText(row: HistoryRow): string {
    switch (row.kind) {
      case "gap":
        return `${row.detail?.missing ?? "Some"} message(s) were lost in transit or expired before delivery.`;
      case "undecryptable":
        return "A message could not be decrypted on this device and was discarded.";
      case "tampered":
        return "A message arrived with inconsistent ordering information (possible server tampering).";
      case "identity_changed":
        return "This contact's security identity changed. Verify with them out-of-band, then accept the new identity to resume sending.";
      case "device_revoked":
        return "A device was removed from this conversation.";
      case "device_readded":
        return "A previously removed device was re-added to this conversation.";
      case "session_reset":
        return "The secure session was reset after repeated undecryptable messages.";
      case "history_start":
        return "Messages are end-to-end encrypted. History starts here on this device.";
      case "encryption_enabled": {
        const actor = this.#displayName(row.detail?.actor);
        const count = row.detail?.roster?.length;
        return count
          ? `${actor} turned on end-to-end encryption for these ${count} members.`
          : `${actor} turned on end-to-end encryption.`;
      }
      case "encryption_disabled":
        return `${this.#displayName(row.detail?.actor)} turned off end-to-end encryption. New messages will be readable by the server.`;
      case "member_added":
        return `${this.#displayName(row.detail?.user_id)} joined the encrypted conversation.`;
      case "member_removed":
        return `${this.#displayName(row.detail?.user_id)} left the encrypted conversation.`;
      case "member_announced":
        return `${this.#displayName(row.detail?.user_id)} is in this group but is NOT yet part of the encrypted conversation — they cannot read new messages until included.`;
      case "device_verified":
        return "You verified this contact's security number.";
      default:
        return "Encrypted conversation event.";
    }
  }

  #displayName(userId?: string): string {
    if (!userId) return "Someone";
    if (userId === this.#client.user?.id) return "You";
    return this.#client.users.get(userId)?.username ?? "A member";
  }

  /** Build + insert a collection message from a native history row */
  #inject(channelId: string, row: HistoryRow, isNew: boolean): Message {
    const self = this.#client.user!.id;
    const isText = row.kind === "text";

    // Trusted encrypted-ness lives in this set, NOT in a message flag (a
    // flag is server-forgeable). Marker rows are E2EE-conversation events
    // too, so they count.
    this.#encryptedIds.add(row.id);

    // Attachment metadata (reactive) + kick off pending ciphertext
    // fetches — also resumes fetches interrupted by a restart
    this.#trackAttachments(row);

    // Author: prefer the native sender attribution (group transcripts carry
    // it); fall back to the dm heuristic (out ⇒ us, in ⇒ the conversation
    // peer) for legacy rows.
    const author = isText
      ? (row.sender_user_id ?? (row.direction === "out" ? self : row.conversation))
      : SYSTEM_AUTHOR;

    const shape = {
      _id: row.id,
      channel: channelId,
      author,
      content: isText ? (row.content ?? "") : undefined,
      system: isText
        ? undefined
        : { type: "text", content: this.#markerText(row) },
    };

    return this.#client.messages.getOrCreate(
      row.id,
      shape as never,
      isNew,
    );
  }

  /** Trusted encrypted-ness of a message id (see `#encryptedIds`) */
  isEncryptedMessage(id: string): boolean {
    return this.#encryptedIds.has(id);
  }

  /**
   * Fail-closed gate at the shared upload chokepoint (`sendDraft`), so the
   * composer, `retrySend`, and any future caller are all covered by ONE
   * authoritative native check — plaintext file bytes can never reach the
   * ordinary Autumn store for an encrypt/blocked conversation (slice 3.5).
   *
   * plaintext verdict ⇒ null (caller runs the legacy upload path);
   * encrypt ⇒ every file is natively encrypted under its own random key,
   * the CIPHERTEXT is uploaded to the opaque-blob route, and the prepared
   * local ids are returned for `e2eeAttachments`; blocked / unverifiable ⇒
   * throws (even for text-only drafts — preserves the early gate).
   */
  async prepareDraftAttachments(
    channel: Channel,
    items: E2EEDraftFile[],
  ): Promise<string[] | null> {
    const isGroup = channel.type === "Group";
    if (channel.type !== "DirectMessage" && !isGroup) return null;

    const conversationId = isGroup ? channel.id : this.#peerOf(channel);
    if (!conversationId) return null;

    let mode: "encrypt" | "blocked" | "plaintext";
    try {
      mode = isGroup
        ? this.#composerMode(
            await this.#invoke<SendModeVerdict>("e2ee_send_mode_group", {
              conversationId,
            }),
          )
        : await this.sendModeNow(conversationId);
    } catch {
      throw new E2EESendError(
        "Encryption status could not be verified. Nothing was sent.",
        "native",
      );
    }

    if (mode === "blocked") {
      throw new E2EESendError(
        isGroup
          ? "This encrypted group is not in a sendable state. Resolve the warning before sending."
          : "The recipient's security identity changed. Accept the change in the conversation before sending.",
        "blocked",
      );
    }
    if (mode === "plaintext" || !items.length) return null;

    // ---- encrypt mode: plaintext bytes never leave the device ----

    // Recipient devices declared on the blob (active pins of every audience
    // member / the peer + our own other devices — mirrors the fan-out)
    const recipients = isGroup
      ? await this.#invoke<{ user_id: string; device_id: string }[]>(
          "e2ee_attachment_recipients_group",
          { conversationId, selfUserId: this.#client.user!.id },
        )
      : await this.#invoke<{ user_id: string; device_id: string }[]>(
          "e2ee_attachment_recipients",
          { peerUserId: conversationId, selfUserId: this.#client.user!.id },
        );

    if (!recipients.length) {
      throw new E2EESendError(
        "No trusted device of the recipient can currently receive encrypted attachments. Nothing was sent unencrypted.",
        "no_devices",
      );
    }

    const localIds: string[] = [];
    for (const { file, onProgress } of items) {
      const plaintext = new Uint8Array(await file.arrayBuffer());

      const prepared = await this.#invoke<{
        local_id: string;
        digest: string;
        ciphertext_size: number;
      }>("e2ee_attachment_prepare", plaintext, {
        headers: {
          "x-peer-user-id": conversationId,
          "x-name": encodeURIComponent(file.name || "attachment"),
          "x-mime": encodeURIComponent(
            file.type || "application/octet-stream",
          ),
        },
      });

      if (this.#transport.nativeBlobTransfer) {
        // Android: ciphertext moves shell→Autumn natively (upload +
        // attach_blob happen in the shell; bytes never transit the JS
        // bridge). Coarse progress only.
        const [authHeader, authValue] = this.#client.authenticationHeader;
        try {
          await this.#transport.uploadPrepared!(
            prepared.local_id,
            `${this.#client.configuration!.features.autumn.url}/e2ee`,
            authHeader,
            authValue,
            recipients,
          );
        } catch {
          throw new E2EESendError(
            "The encrypted attachment could not be uploaded. Nothing was sent unencrypted.",
            "delivery_failed",
          );
        }
        onProgress?.(1);
      } else {
        const ciphertext = await this.#invoke<ArrayBuffer>(
          "e2ee_attachment_ciphertext",
          { localId: prepared.local_id },
        );

        const blobId = await this.#uploadBlob(
          ciphertext,
          recipients,
          onProgress,
        );
        await this.#invoke("e2ee_attachment_attach_blob", {
          localId: prepared.local_id,
          blobId,
        });
      }

      localIds.push(prepared.local_id);
    }

    return localIds;
  }

  /** Upload one ciphertext blob to Autumn's opaque-blob route */
  #uploadBlob(
    ciphertext: ArrayBuffer,
    recipients: { user_id: string; device_id: string }[],
    onProgress?: (fraction: number) => void,
  ): Promise<string> {
    const body = new FormData();
    body.set("file", new Blob([ciphertext]));
    body.set("recipients", JSON.stringify(recipients));

    const [authHeader, authValue] = this.#client.authenticationHeader;

    // XHR for upload progress (fetch duplex needs HTTP/2)
    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      });

      xhr.addEventListener("loadend", () => {
        onProgress?.(1);
        if (xhr.readyState === 4 && xhr.status === 200 && xhr.response?.id) {
          resolve(xhr.response.id as string);
        } else {
          reject(
            new E2EESendError(
              "The encrypted attachment could not be uploaded. Nothing was sent unencrypted.",
              "delivery_failed",
            ),
          );
        }
      });

      xhr.open(
        "POST",
        `${this.#client.configuration!.features.autumn.url}/e2ee`,
        true,
      );
      xhr.setRequestHeader(authHeader, authValue);
      xhr.responseType = "json";
      xhr.send(body);
    });
  }

  /**
   * Webview URL a decrypted attachment renders from — the shell's
   * attachment endpoint (desktop `e2ee-att` protocol / Android WebView
   * interceptor), which decrypts natively per request: key material never
   * crosses to the webview. Both path segments are ULIDs / integers, so no
   * encoding is needed.
   */
  attachmentUrl(messageId: string, idx: number): string {
    return this.#transport.attachmentUrl(messageId, idx);
  }

  /** Reactive attachment metadata of a message (empty when none) */
  attachmentsFor(messageId: string): E2EEAttachmentMeta[] {
    return this.attachmentMeta.get(messageId) ?? [];
  }

  /**
   * Record a message's attachment metadata and start fetching any pending
   * ciphertext. Idempotent per sync; also runs on history loads, so
   * fetches interrupted by a restart resume.
   */
  #trackAttachments(row: HistoryRow): void {
    if (!row.attachments?.length) return;

    this.attachmentMeta.set(row.id, row.attachments);

    for (const meta of row.attachments) {
      if (meta.state === "pending" && meta.blob_id) {
        void this.#fetchAttachment(row.id, meta);
      }
    }
  }

  /**
   * Fetch + verify one pending attachment: download the ciphertext blob,
   * hand it to the native layer (digest verification MANDATORY there —
   * swapped/corrupt bytes mark it failed), and update the reactive state.
   * A 404/410 means the blob expired before this device fetched it.
   */
  async #fetchAttachment(
    messageId: string,
    meta: E2EEAttachmentMeta,
  ): Promise<void> {
    if (this.#fetchingAttachments.has(meta.local_id)) return;
    this.#fetchingAttachments.add(meta.local_id);

    try {
      const [authHeader, authValue] = this.#client.authenticationHeader;

      if (this.#transport.nativeBlobTransfer) {
        // Android: the shell fetches the ciphertext and hands it straight
        // to the core (mandatory digest verification there); bytes never
        // transit the JS bridge. Same state machine as the webview path.
        const state = await this.#transport.fetchAndStore!(
          meta.local_id,
          `${this.#client.configuration!.features.autumn.url}/e2ee/${meta.blob_id}`,
          authHeader,
          authValue,
        );
        if (state === "pending") return; // transient — next sync retries

        const current = this.attachmentMeta.get(messageId);
        if (current) {
          this.attachmentMeta.set(
            messageId,
            current.map((entry) =>
              entry.local_id === meta.local_id ? { ...entry, state } : entry,
            ),
          );
        }
        return;
      }

      const response = await fetch(
        `${this.#client.configuration!.features.autumn.url}/e2ee/${meta.blob_id}`,
        { headers: { [authHeader]: authValue } },
      );

      let state: E2EEAttachmentMeta["state"];
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        try {
          await this.#invoke("e2ee_attachment_store", bytes, {
            headers: { "x-local-id": meta.local_id },
          });
          state = "ready";
        } catch {
          // Digest mismatch / undecryptable — native marked it failed
          state = "failed";
        }
      } else if (response.status === 404 || response.status === 410) {
        await this.#invoke("e2ee_attachment_mark_unavailable", {
          localId: meta.local_id,
          expired: true,
        });
        state = "expired";
      } else {
        // Transient (ratelimit, 5xx, offline): stay pending; the next
        // sync retries
        return;
      }

      const current = this.attachmentMeta.get(messageId);
      if (current) {
        this.attachmentMeta.set(
          messageId,
          current.map((entry) =>
            entry.local_id === meta.local_id ? { ...entry, state } : entry,
          ),
        );
      }
    } catch {
      // Network failure: stay pending, retried on the next sync
    } finally {
      this.#fetchingAttachments.delete(meta.local_id);
    }
  }

  async #refreshMode(peerId: string): Promise<void> {
    try {
      const verdict = await this.#invoke<SendModeVerdict>("e2ee_send_mode", {
        peerUserId: peerId,
      });
      this.sendModes.set(peerId, this.#composerMode(verdict));
    } catch {
      // Do NOT fabricate a mode on error: leave any known value untouched.
      // Fabricating "encrypt" here would show a lock the send path can't
      // honor; the send path itself is authoritative and fails closed.
    }
  }

  /** Populate the send-mode cache for the composer indicator (idempotent) */
  primeSendMode(peerId: string): Promise<void> {
    return this.#refreshMode(peerId);
  }

  /**
   * Authoritative send-mode for a peer, straight from the native layer
   * (also updates the indicator cache). The composer awaits this BEFORE the
   * draft path uploads any attachment to the plaintext store, so an
   * encrypt/blocked conversation can never leak a file to Autumn. Throws on
   * native error — callers must treat a throw as fail-closed.
   */
  async sendModeNow(peerId: string): Promise<"encrypt" | "blocked" | "plaintext"> {
    const verdict = await this.#invoke<SendModeVerdict>("e2ee_send_mode", {
      peerUserId: peerId,
    });
    const mode = this.#composerMode(verdict);
    this.sendModes.set(peerId, mode);
    return mode;
  }

  /**
   * Authoritative send-mode for any E2EE-capable conversation — DM peer or
   * group — straight from the native layer (also refreshes the indicator
   * cache). Returns null for channel types that can never be E2EE (server
   * channels, threads, saved messages). Throws on native error — callers
   * must treat a throw as fail-closed.
   */
  async sendModeNowFor(
    channel: Channel,
  ): Promise<"encrypt" | "blocked" | "plaintext" | null> {
    const isGroup = channel.type === "Group";
    if (channel.type !== "DirectMessage" && !isGroup) return null;

    const conversationId = isGroup ? channel.id : this.#peerOf(channel);
    if (!conversationId) return null;

    const verdict = await this.#invoke<SendModeVerdict>(
      isGroup ? "e2ee_send_mode_group" : "e2ee_send_mode",
      isGroup ? { conversationId } : { peerUserId: conversationId },
    );
    const mode = this.#composerMode(verdict);
    this.sendModes.set(conversationId, mode);
    return mode;
  }

  // ================================================================
  // Consent flow (settings UI)
  // ================================================================

  /**
   * Enable E2EE on this device. The MFA ticket token gates the key
   * publication server-side (the consent gate is the MFA-gated publish —
   * never the profile flag, which is a pure UI hint).
   */
  async enable(mfaTicketToken: string): Promise<void> {
    const payload = await this.#invoke<unknown>("e2ee_enable");

    await this.#api("PUT", "/e2ee/keys", payload, {
      "X-MFA-Ticket": mfaTicketToken,
    });
    await this.#invoke("e2ee_mark_published");
    await this.refreshStatus();

    // Claim on the live connection so drain/ack and the HTTP route gates
    // recognise this session immediately
    const status = this.status.get("state");
    if (status?.device_id) {
      this.#client.events.send({
        type: "E2EERequestChallenge",
        device_id: status.device_id,
      });
    }

    // Advertise opt-in to peers (UI/discovery hint only — invariant 2).
    // Deliberately NOT awaited into the enable() result: the keys are
    // already published, so enable() has succeeded; a failed PATCH here
    // is self-healed by #onReady on every subsequent connect.
    this.#advertiseOptIn();

    // MLS KeyPackage pre-publish (publish-UX plan §3.2): seed the media-E2EE
    // directory while the user is already in an enrollment flow, so a first
    // call join finds it populated. Best-effort and NOT awaited — enable()
    // has already succeeded, and the call-join path self-heals via
    // `#ensureKeyPackages` (no-MFA publish, plan §3.1).
    void this.#prepublishMlsKeyPackages();
  }

  /**
   * Enrollment-time MLS KeyPackage pre-publish (publish-UX plan §3.2).
   * Rides §3.1's no-MFA publish route: the PUT /e2ee/keys that just ran
   * bound this session to the device, which is all the route demands.
   * Quiet by design: `feature_disabled` (media E2EE off until 6.5) is a
   * silent no-op, and any failure is only logged — the call-join
   * `#ensureKeyPackages` path remains the authoritative self-heal.
   */
  async #prepublishMlsKeyPackages(): Promise<void> {
    // Gate on "Encrypt my calls" (§0.2 #9): with calls E2EE off there is no
    // reason to stock the MLS KeyPackage directory. Fail-closed until wired.
    if (!this.#callsEnabled()) return;
    try {
      const userId = this.#client.user?.id;
      if (!userId) return;
      const payload = await this.mlsPublishKeyPackages(userId);
      const res = await this.mlsPutKeyPackages(payload);
      if (res.kind !== "ok" && res.kind !== "feature_disabled") {
        // `mfa_required` here means a pre-§3.1 server: acceptable during
        // rollout — the join-time fallback still prompts (plan §3.3)
        console.warn(
          "[e2ee] enrollment MLS KeyPackage pre-publish not completed:",
          res.kind,
        );
      }
    } catch (error) {
      console.error(
        "[e2ee] enrollment MLS KeyPackage pre-publish failed (best-effort)",
        error,
      );
    }
  }

  /**
   * Turn OFF E2EE on this device. Destroys ALL local encrypted state and
   * takes the device out of the server's key directory so peers stop
   * encrypting to it.
   *
   * Order matters for safe cancellation:
   *  1. Native `e2ee_wipe` runs FIRST — it shows a blocking OS confirmation
   *     (design §9a; a compromised webview cannot destroy data without a
   *     physical click). Declining it throws here and NOTHING else changed,
   *     so the toggle simply snaps back on.
   *  2. Only after the wipe succeeds do we clear the opt-in hint and revoke
   *     the device server-side (MFA-gated). Those are best-effort: if the
   *     revoke fails the device is already gone locally and cannot decrypt
   *     anything, so a lingering registry entry is harmless and its queued
   *     envelopes expire by TTL.
   */
  async disable(mfaTicketToken: string): Promise<void> {
    // Capture the device id before the wipe removes it from local state
    const deviceId = this.status.get("state")?.device_id;

    // (1) Local wipe with the native OS confirmation — throws on decline
    await this.#invoke("e2ee_wipe");

    // (2) Post-wipe cleanup. Failures here never resurrect local state.
    try {
      const user = this.#client.user;
      if (user?.e2eeEnabled) {
        await user.edit({ e2ee_enabled: false } as unknown as Parameters<
          typeof user.edit
        >[0]);
      }
    } catch (error) {
      console.error("[e2ee] clearing opt-in flag failed", error);
    }

    if (deviceId) {
      try {
        await this.#api("DELETE", `/e2ee/keys/${deviceId}`, undefined, {
          "X-MFA-Ticket": mfaTicketToken,
        });
      } catch (error) {
        // Lingering server-side device is harmless (wiped device can't
        // decrypt; its envelopes TTL out). Logged, not surfaced.
        console.error("[e2ee] server-side device revoke failed", error);
      }
    }

    await this.refreshStatus();
  }

  // ================================================================
  // Key backup & recovery (slice 5.5)
  // ================================================================
  //
  // The webview COURIERS opaque ciphertext between native and the server; the
  // recovery CODE never touches this layer — it lives entirely in the native
  // recovery window (desktop) / AlertDialog (Android). Server routes go
  // through `#api` (raw fetch) per the stoat-api body-drop rule.

  #backupCourierReady = false;

  /**
   * Post-restore fresh-OTK republish payload, held between a RESTORE and its
   * device claim. A restore recovers the OLD device_id, so on the server the
   * republish takes the `existing.assert_bound_session` path — it is accepted
   * only on a session that has already proven the device (the claim). So the
   * republish (design §6.3 — evicts the stale server OTKs whose private halves
   * died with the old install) is deferred here and drained by
   * `#onClaimResult` once the claim is accepted; running it before the claim,
   * like `enable()`'s FIRST publish, would 401 and silently skip eviction.
   * Null except in the window between a restore and its claim; retained on a
   * failed republish so the next claim retries.
   */
  #pendingRestoreRepublish: Record<string, unknown> | null = null;

  /**
   * One-shot guard: a post-restore claim was rejected while the device row was
   * still PRESENT (a transient/forced reject, not §6.4), so we re-claimed once.
   * Stops a superseding-nonce or hostile-server rejection from spinning us.
   * Reset by an accepted claim.
   */
  #restoreReclaimTried = false;

  /**
   * Publish the deferred post-restore republish (design §6.3), after the
   * device claim. No-op unless a restore stashed a payload. On failure the
   * payload is kept so the next accepted claim retries rather than silently
   * dropping OTK eviction.
   */
  async #publishRestoreRepublish(): Promise<void> {
    const payload = this.#pendingRestoreRepublish;
    if (!payload) return;
    this.#pendingRestoreRepublish = null;
    try {
      await this.#api("PUT", "/e2ee/keys", {
        ...payload,
        replace_one_time_keys: true,
      });
      await this.#invoke("e2ee_mark_published");
    } catch (error) {
      console.error(
        "[e2ee] post-restore OTK republish failed; will retry on next claim",
        error,
      );
      this.#pendingRestoreRepublish = payload;
    }
  }

  /**
   * §6.4 revoked-device restore. Called after `reenrollNeeded` is raised —
   * which `#onClaimResult` sets (on either the in-session pending-payload path
   * or the durable reconnect path) ONLY once it has corroborated (via
   * `#ownDevicePresence`) that the server row is actually absent, so this is a
   * genuine first publication, not a transient reject. That corroboration is
   * what makes the retry-on-failure below safe (the PUT lands on the server's
   * `existing is None` path, never the immutable-identity/`assert_bound` path).
   * Re-publishes the stashed fresh key bundle as a FIRST publication — the
   * server's `existing is None` path is MFA-gated, re-inserts the identity, and
   * broadcasts the loud same-keys `device_readded` to peers — then re-claims so
   * this connection's drain and the device-bound route gates recognise the
   * session again. Needs a SECOND MFA ticket (the first gated `GET /e2ee/backup`
   * during restore); design §6.4 permits up to two prompts in this path.
   *
   * The MFA'd PUT is the irreversible boundary: once it succeeds the row
   * exists, so the pending payload is cleared immediately (a retry must never
   * re-first-publish — that would hit the immutable-identity/`assert_bound`
   * path and fail). A PUT failure throws with the payload + flag retained so
   * the shell can surface the error and let the user retry.
   */
  async finishReenroll(mfaTicketToken: string): Promise<void> {
    const payload = this.#pendingRestoreRepublish;
    if (!payload) {
      this.reenrollNeeded.delete("state");
      return;
    }

    // FIRST publication of the restored identity: MFA-gated, and WITHOUT
    // `replace_one_time_keys` (there is no prior server row to replace against;
    // the flag is only honoured on the device-bound republish path anyway).
    await this.#api("PUT", "/e2ee/keys", payload, {
      "X-MFA-Ticket": mfaTicketToken,
    });
    // Row now exists — never re-first-publish this bundle.
    this.#pendingRestoreRepublish = null;
    this.reenrollNeeded.delete("state");
    try {
      await this.#invoke("e2ee_mark_published");
    } catch (error) {
      // Best-effort local bookkeeping; the keys are already published.
      console.error("[e2ee] e2ee_mark_published after re-enroll failed", error);
    }
    await this.refreshStatus();

    // Re-claim on the live connection now that the identity row exists again;
    // the accepted claim drains envelopes and runs post-claim housekeeping
    // (#pendingRestoreRepublish is now null, so its republish is a no-op).
    const status = this.status.get("state");
    if (status?.device_id) {
      this.#client.events.send({
        type: "E2EERequestChallenge",
        device_id: status.device_id,
      });
    }

    // Re-seed the MLS KeyPackage directory too (publish-UX plan §3.2): the
    // revocation cascade deleted this device's packages, and the re-enroll
    // PUT above re-bound the session, so the no-MFA publish rides now.
    void this.#prepublishMlsKeyPackages();
  }

  /**
   * Listen once for the native recovery window's completion signal and
   * courier whatever ciphertext it produced to the server. The event carries
   * only a mode string — never a secret. Desktop (Tauri) only; on Android the
   * plugin drives the flow natively.
   */
  async #ensureBackupCourier(): Promise<void> {
    if (this.#backupCourierReady) return;
    const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
    if (!tauri?.event) return;
    this.#backupCourierReady = true;
    await tauri.event.listen<string>("e2ee:recovery-complete", (event) => {
      this.#courierRecovery(event.payload).catch((error) =>
        console.error("[e2ee] backup courier failed", error),
      );
    });
  }

  async #courierRecovery(mode: string): Promise<void> {
    if (mode === "create" || mode === "rotate") {
      // Upload the freshly-minted backup blob.
      const bundle = await this.#invoke<BackupBundle | null>(
        "e2ee_backup_take_pending_upload",
      );
      if (!bundle) return;
      await this.#putBackup(bundle);
    } else if (mode === "restore") {
      // The store was rebuilt natively. The fresh-OTK republish (design §6.3)
      // must run on a DEVICE-BOUND session — i.e. AFTER the claim, not before
      // (the restored device_id already exists server-side, so the PUT takes
      // the server's `assert_bound_session` republish path). Stash it and let
      // the claim result (#onClaimResult) publish it.
      this.#pendingRestoreRepublish = await this.#invoke<Record<
        string,
        unknown
      > | null>("e2ee_backup_take_pending_republish");
      await this.refreshStatus();
      // Claim the device on the live connection so route gates + drain
      // recognise the restored identity; the claim result drains the stashed
      // republish.
      const status = this.status.get("state");
      if (status?.device_id) {
        this.#client.events.send({
          type: "E2EERequestChallenge",
          device_id: status.device_id,
        });
      }
    }
    // mode "cancel" (or unknown): nothing to courier.
  }

  /** PUT a backup blob for the current device, then record the upload. */
  async #putBackup(bundle: BackupBundle): Promise<void> {
    const deviceId = this.status.get("state")?.device_id;
    if (!deviceId) return;
    await this.#api("PUT", "/e2ee/backup", {
      device_id: deviceId,
      header: bundle.header,
      ciphertext: bundle.ciphertext,
      generation: bundle.generation,
    });
    await this.#invoke("e2ee_backup_mark_uploaded", {
      generation: bundle.generation,
    });
  }

  /**
   * Backup status for the Security & Privacy card: local bookkeeping merged
   * with the honest-server signal (`GET /e2ee/backup/status`). The server
   * signal is webview-couriered so a hostile webview can fake it — it drives
   * the nag against an honest server only (design §4.5 H3).
   */
  async backupStatus(): Promise<BackupStatusView> {
    const local = await this.#invoke<{
      exists: boolean;
      generation: number;
      uploaded_generation: number;
      created_at: number;
      refreshed_at: number;
    }>("e2ee_backup_status");

    let serverHasBackup = false;
    try {
      const deviceId = this.status.get("state")?.device_id;
      const res = await this.#api<{
        backups: { device_id: string; generation: number }[];
      }>("GET", "/e2ee/backup/status");
      serverHasBackup = res.backups.some((b) => b.device_id === deviceId);
    } catch (error) {
      console.error("[e2ee] backup status fetch failed", error);
    }

    return {
      exists: local.exists,
      generation: local.generation,
      uploadedGeneration: local.uploaded_generation,
      serverHasBackup,
      createdAt: local.created_at,
      refreshedAt: local.refreshed_at,
    };
  }

  /**
   * Refresh the backup if native says one is due (timer / message delta), and
   * upload the resulting blob. Called opportunistically on connect. No-op when
   * no backup exists or none is due.
   */
  async refreshBackupIfDue(): Promise<void> {
    const selfId = this.#client.user?.id;
    if (!selfId) return;
    const bundle = await this.#invoke<BackupBundle | null>(
      "e2ee_backup_refresh_if_due",
      { userId: selfId },
    );
    if (bundle) await this.#putBackup(bundle);
  }

  /**
   * CREATE a recovery code (opt-in step / settings card). The code is shown
   * only on the native surface — a bundled recovery window on desktop, a
   * native `AlertDialog` on Android — and the opaque ciphertext bundle is
   * uploaded on completion. This layer never sees the code.
   */
  async createRecoveryCode(): Promise<void> {
    const selfId = this.#client.user?.id;
    if (!selfId) throw new Error("not signed in");
    if (this.#transport.backupCreateDialog) {
      // Android: the dialog mints + displays the code and hands back only the
      // ciphertext bundle, which we courier to the server (design §7.2). A
      // dialog cancel rejects `declined` — swallow it so a user who backs out
      // sees no error (matching the desktop window's silent close).
      try {
        const bundle = await this.#transport.backupCreateDialog(selfId);
        await this.#putBackup(bundle);
      } catch (error) {
        if ((error as { type?: string })?.type !== "declined") throw error;
      }
      return;
    }
    await this.#ensureBackupCourier();
    await this.#invoke("e2ee_backup_open_recovery", {
      mode: "create",
      userId: selfId,
    });
  }

  /** Rotate the recovery code (re-auth-gated in the UI). */
  async rotateRecoveryCode(): Promise<void> {
    const selfId = this.#client.user?.id;
    if (!selfId) throw new Error("not signed in");
    if (this.#transport.backupRotateDialog) {
      try {
        const bundle = await this.#transport.backupRotateDialog(selfId);
        await this.#putBackup(bundle);
      } catch (error) {
        if ((error as { type?: string })?.type !== "declined") throw error;
      }
      return;
    }
    await this.#ensureBackupCourier();
    await this.#invoke("e2ee_backup_open_recovery", {
      mode: "rotate",
      userId: selfId,
    });
  }

  /**
   * Fetch this account's backup blobs (MFA-ticketed) and drive the native
   * recovery surface to enter the code and restore. Returns the number of
   * blobs offered (0 ⇒ nothing to restore).
   */
  async restoreFromBackup(mfaTicketToken: string): Promise<number> {
    const selfId = this.#client.user?.id;
    if (!selfId) throw new Error("not signed in");

    const res = await this.#api<{ backups: BackupBlob[] }>(
      "GET",
      "/e2ee/backup",
      undefined,
      { "X-MFA-Ticket": mfaTicketToken },
    );
    if (res.backups.length === 0) return 0;

    // Pass the server-claimed generation so native can cross-check it against
    // the AEAD-authenticated header (design §6.2 M2).
    const blobs = res.backups.map((b) => ({
      header: b.header,
      ciphertext: b.ciphertext,
      server_generation: b.generation,
    }));

    if (this.#transport.backupRestoreDialog) {
      // Android: the dialog enters the code and restores natively, returning
      // the fresh-OTK republish payload. A dialog cancel rejects `declined`:
      // report 0 restored (the user backed out) rather than surfacing an error.
      let republish: Record<string, unknown> | null;
      try {
        republish = await this.#transport.backupRestoreDialog(selfId, blobs);
      } catch (error) {
        if ((error as { type?: string })?.type === "declined") return 0;
        throw error;
      }
      // Defer the fresh-OTK republish until AFTER the claim (design §6.3): the
      // restored device_id already exists server-side, so the republish PUT
      // needs a device-bound session, which only the accepted claim provides.
      // #onClaimResult drains it.
      this.#pendingRestoreRepublish = republish;
      await this.refreshStatus();
      const status = this.status.get("state");
      if (status?.device_id) {
        this.#client.events.send({
          type: "E2EERequestChallenge",
          device_id: status.device_id,
        });
      }
      return res.backups.length;
    }

    await this.#ensureBackupCourier();
    await this.#invoke("e2ee_backup_open_recovery", {
      mode: "restore",
      userId: selfId,
      blobs,
    });
    return res.backups.length;
  }

  /**
   * Delete this device's server-side backup (MFA-gated) and forget the local
   * bookkeeping. Re-auth-gated in the UI, like the wipe flow.
   */
  async deleteBackup(mfaTicketToken: string): Promise<void> {
    const deviceId = this.status.get("state")?.device_id;
    if (deviceId) {
      await this.#api("DELETE", `/e2ee/backup/${deviceId}`, undefined, {
        "X-MFA-Ticket": mfaTicketToken,
      });
    }
    await this.#invoke("e2ee_backup_forget_local");
  }

  /** Native conversation state (per-device status + binding_verified) */
  conversationState(peerUserId: string): Promise<{
    peer_user_id: string;
    encrypted_since: number | null;
    devices: {
      device_id: string;
      status: "active" | "identity_changed" | "revoked";
      binding_verified: boolean;
      has_active_session: boolean;
    }[];
  }> {
    return this.#invoke("e2ee_conversation_state", { peerUserId });
  }

  /** Explicitly accept a changed peer identity (the ONLY unblock path) */
  async acceptIdentityChange(
    peerUserId: string,
    deviceId: string,
  ): Promise<void> {
    await this.#invoke("e2ee_accept_identity_change", {
      peerUserId,
      deviceId,
    });
    await this.#refreshMode(peerUserId);
    await this.#syncRecent(peerUserId);
  }

  /** Decrypted plaintext rows for a reported message (reporter-side) */
  async plaintextForReport(
    peerUserId: string,
    messageId: string,
  ): Promise<string | undefined> {
    const rows = await this.#invoke<HistoryRow[]>("e2ee_history", {
      peerUserId,
      before: null,
      limit: 100,
    });
    return rows.find((row) => row.id === messageId)?.content ?? undefined;
  }

  // ================================================================
  // Media E2EE — MLS call control plane (slice 6.3)
  //
  // Thin wrappers over the native `e2ee_call_*` / `e2ee_mls_*` IPC surface,
  // riding the SAME transport seam as text (plan §4.2 — no new machinery).
  // The webview is a courier: it shuttles PUBLIC wire shapes between
  // HTTP/WebSocket and native. The ONE secret-bearing call is
  // `callFrameKeys` — the documented §7.2 egress — whose result is handed
  // straight to `MlsKeyProvider`, memory-only, never persisted or logged.
  // ================================================================

  /**
   * Reactive per-channel call E2EE state (the `sendModes` pattern) — drives
   * the call UI. Minimally populated in 6.3; the epoch-lifecycle / downgrade
   * state machine that fully drives it is 6.4/6.5.
   */
  readonly callStates = new ReactiveMap<string, CallE2EEState>();

  /**
   * Active call session's inbound `Mls*` event sink (see `registerMlsSink`);
   * null between calls. At most one call is active at a time.
   */
  #mlsSink: MlsSessionSink | null = null;

  /**
   * Register the active call session's inbound sink for `Mls*` events
   * (`MlsJoinRequested` / `MlsCommit` / `MlsWelcome`). Returns an unregister
   * fn (idempotent — only clears if still the current sink). While none is
   * registered the events are dropped and their envelopes stay queued +
   * unacked server-side, so a later call re-drains them: never ack what no
   * call consumes. The session — NOT this bridge — acks after durable
   * processing (§3.3).
   */
  registerMlsSink(sink: MlsSessionSink): () => void {
    this.#mlsSink = sink;
    return () => {
      if (this.#mlsSink === sink) this.#mlsSink = null;
    };
  }

  /**
   * Acknowledge MLS envelopes (drop them from this device's server-side
   * mailbox) after the call session has DURABLY processed them natively
   * (§3.3). Same `E2EEAck` the text path sends per-envelope, but driven by the
   * MLS drain rather than `#handleEnvelope`. Only ack what native accepted or
   * terminally dropped — never a parked (gap) or transiently-failed envelope.
   */
  ackEnvelopes(ids: string[]): void {
    if (!ids.length) return;
    this.#client.events.send({ type: "E2EEAck", ids });
  }

  /** Create the MLS group for a new call (`POST /mls/groups` body). */
  callCreate(
    channelId: string,
    userId: string,
    supersedes?: string,
  ): Promise<MlsCallCreated> {
    return this.#invoke("e2ee_call_create", {
      channelId,
      userId,
      supersedes: supersedes ?? null,
    });
  }

  /**
   * Sign + persist a join intent (`POST /mls/groups/<id>/join_intent` body).
   *
   * **T-15 client-leg (carried 6.2 gate item).** `group_id ↔ channel_id` has
   * no cryptographic anchor the joiner can check — native binds `channel_id`
   * into the signed intent but cannot judge it against user intent, and the
   * Welcome's MLS GroupContext carries `group_id` only (no channel). So THIS
   * is the sole place the binding is checked: refuse loudly unless the
   * DS-asserted `channel_id` for the group equals the channel the user
   * actually intended to join, and sign the USER-intended channel — never a
   * server echo. A hostile DS steering the joiner into a different channel's
   * group is caught here, before any signature.
   */
  callJoinIntent(params: {
    groupId: string;
    /** The channel the user actually chose to join (route/UI truth). */
    intendedChannelId: string;
    /** The `channel_id` the DS create/join response asserted for the group. */
    dsResponseChannelId: string;
    userId: string;
  }): Promise<MlsJoinIntentPayload> {
    if (params.dsResponseChannelId !== params.intendedChannelId) {
      throw new E2EESendError(
        `MLS call join refused: the delivery service returned channel ` +
          `${params.dsResponseChannelId} for group ${params.groupId}, but the ` +
          `channel you chose is ${params.intendedChannelId} (group↔channel ` +
          `binding mismatch — T-15).`,
        "native",
      );
    }
    return this.#invoke("e2ee_call_join_intent", {
      groupId: params.groupId,
      // Bind the USER-intended channel into the signed intent, never the
      // server-echoed value.
      channelId: params.intendedChannelId,
      userId: params.userId,
    });
  }

  /**
   * Verify a fanned-out join intent against OUR pinned identity for the
   * claimed device (read-only, native). The rejoin trust gate: a member
   * never stages the stale-leaf Remove a `rejoin` event asks for on the
   * server relay alone — the same check `callAdmit` runs for the Add path.
   */
  callVerifyJoinIntent(request: MlsJoinRequest): Promise<void> {
    return this.#invoke("e2ee_call_verify_join_intent", { request });
  }

  /** Admit a joiner: stage an Add commit + Welcome (verified natively). */
  callAdmit(
    request: MlsJoinRequest,
    claimed: MlsClaimedKeyPackage,
  ): Promise<MlsSubmitCommit> {
    return this.#invoke("e2ee_call_admit", { request, claimed });
  }

  /**
   * Process one inbound MLS envelope and classify the disposition
   * (carried 6.2 ack-and-drop item). The caller (the 6.4 mailbox drain)
   * acts on `kind`:
   *  - `processed`  → ack the envelope (epoch may have advanced);
   *  - `park`       → do NOT ack; gap-refetch the missing epochs (invariant 10);
   *  - `drop`       → ack the envelope and drop it (poisoned / wiped / refused —
   *                   never retry a group the native layer will keep rejecting);
   *  - `error`      → do NOT ack; surface the unexpected error.
   */
  async processEnvelope(
    envelope: MlsEnvelope,
    userId: string,
  ): Promise<EnvelopeDisposition> {
    try {
      const outcome = await this.callProcess(envelope, userId);
      return { kind: "processed", outcome, ack: true };
    } catch (error) {
      return classifyEnvelopeError(error);
    }
  }

  /** Raw process wrapper (no classification) — used by `processEnvelope`. */
  callProcess(
    envelope: MlsEnvelope,
    userId: string,
  ): Promise<MlsProcessOutcome> {
    return this.#invoke("e2ee_call_process", { envelope, userId });
  }

  /**
   * Merge OUR staged commit after an authoritative DS `Won`. `wonEpoch` MUST
   * come from that authoritative response — NEVER a guess (native re-checks
   * `wonEpoch == staged`, but the trust rule is the caller's). Use
   * `reconcilePendingCommit` on reconnect rather than calling this blind.
   */
  callCommitWon(groupId: string, wonEpoch: number): Promise<MlsProcessOutcome> {
    return this.#invoke("e2ee_call_commit_won", { groupId, wonEpoch });
  }

  /** Discard OUR staged commit after a DS `Lost`; the caller then rebases. */
  callCommitLost(groupId: string): Promise<void> {
    return this.#invoke("e2ee_call_commit_lost", { groupId });
  }

  /** The epoch a currently-staged own commit would establish, if any. */
  callPendingCommitEpoch(groupId: string): Promise<number | null> {
    return this.#invoke("e2ee_call_pending_commit_epoch", { groupId });
  }

  /**
   * Reconcile a dangling staged commit against the DS after a crash/reconnect
   * (carried 6.2 reconnect-check item). Merges ONLY when the DS
   * authoritatively reports our commit won exactly the staged epoch; any
   * other state ⇒ we lost, so discard + rebase. Enforces
   * "commit_won only on an authoritative Won" so a reconnect can never fork
   * the group by merging a commit that actually lost.
   */
  async reconcilePendingCommit(params: {
    groupId: string;
    /** The epoch the DS says OUR device's commit won, or null if none. */
    dsWonEpoch: number | null;
  }): Promise<"won" | "lost" | "none"> {
    const pending = await this.callPendingCommitEpoch(params.groupId);
    if (pending === null) return "none";
    // Merge iff the DS authoritatively reports OUR commit won exactly the
    // staged epoch. If the DS has since advanced PAST it (heartbeats, or
    // others building on our epoch), we STILL won — merge, and the caller
    // gap-refetches forward from there. Gating on "DS current == pending" too
    // (as an earlier draft did) would wrongly discard a genuinely-won commit
    // whenever the group moved on. Native re-checks `wonEpoch == staged`, so a
    // wrong value is refused, never forked.
    if (params.dsWonEpoch === pending) {
      await this.callCommitWon(params.groupId, pending);
      return "won";
    }
    await this.callCommitLost(params.groupId);
    return "lost";
  }

  /** Wipe local MLS state for a call group. */
  callLeaveCleanup(groupId: string): Promise<void> {
    return this.#invoke("e2ee_call_leave_cleanup", { groupId });
  }

  /** Stage the epoch-heartbeat commit (HPKE-only self-update). */
  callHeartbeat(groupId: string): Promise<MlsSubmitCommit> {
    return this.#invoke("e2ee_call_heartbeat", { groupId });
  }

  /** Stage a Remove commit for a departed/ghost member. */
  callRemove(
    groupId: string,
    targetUserId: string,
    targetDeviceId: string,
  ): Promise<MlsSubmitCommit> {
    return this.#invoke("e2ee_call_remove", {
      groupId,
      targetUserId,
      targetDeviceId,
    });
  }

  /** Call-roster snapshot (display only — no key material). */
  callState(groupId: string): Promise<MlsCallState> {
    return this.#invoke("e2ee_call_state", { groupId });
  }

  /**
   * **THE documented §7.2 egress.** Per-sender, per-epoch 32-byte HKDF frame
   * key MATERIAL (+ the previous epoch during rotation overlap) for the
   * LiveKit worker. Handed straight to `MlsKeyProvider` — memory-only, never
   * persisted, never logged. Nothing else secret crosses this seam.
   */
  callFrameKeys(groupId: string): Promise<MlsFrameKeys> {
    return this.#invoke("e2ee_call_frame_keys", { groupId });
  }

  /**
   * Request a whole-call downgrade to plaintext (§3.4). Gated by a BLOCKING
   * native OS dialog whose non-enrolled roster is computed NATIVELY from the
   * group's VERIFIED MLS roster (6.5, closes the 6.3 [6.5 crypto LOW]): the
   * webview supplies the live SFU identities (attacker-controlled only in the
   * safe direction — can distort what is displayed, never suppress the dialog)
   * plus display names for rendering. On confirm this ALSO arms the native
   * announce gate; resolves Ok, rejects with `declined` on cancel.
   */
  callConfirmDowngrade(
    groupId: string,
    sfuParticipants: string[],
    displayNames: Record<string, string>,
  ): Promise<void> {
    return this.#invoke("e2ee_call_confirm_downgrade", {
      groupId,
      sfuParticipants,
      displayNames,
    });
  }

  /**
   * Clear the call's confirmed-downgrade grant (6.5 gate LOW-1): invoked on
   * a T6 re-upgrade so the announce oracle closes with the interlude, not at
   * call end. Clearing is the SAFE direction (only forces a fresh confirm).
   */
  callClearDowngrade(groupId: string): Promise<void> {
    return this.#invoke("e2ee_call_clear_downgrade", { groupId });
  }

  /**
   * Native-computed non-enrolled verdict (the roster panel + banner read
   * this): device-qualified SFU identities absent from the group's VERIFIED
   * MLS roster. The webview supplies the live SFU list; native intersects.
   * Attacker-controlled only in the safe direction (can over-report, never
   * hide a real non-enrolled participant that would trip the loud state).
   */
  callNonEnrolled(
    groupId: string,
    sfuParticipants: string[],
  ): Promise<string[]> {
    return this.#invoke("e2ee_call_non_enrolled", { groupId, sfuParticipants });
  }

  /**
   * Mint the group-encrypted §3.4 mode announcement (an MLS application
   * message; never advances an epoch). CONFIRM-GATED natively: rejects with
   * `mls_not_confirmed` unless `callConfirmDowngrade` already succeeded for
   * this call — so a compromised webview can re-request an announce (the
   * interlude re-announce after an epoch change) but never ORIGINATE one for
   * an unconfirmed call. Returns the `POST /mls/groups/<id>/messages` body.
   */
  callAnnounce(groupId: string, userId: string): Promise<MlsCtlPayload> {
    return this.#invoke("e2ee_call_announce", { groupId, userId });
  }

  /**
   * `POST /mls/groups/<id>/messages` — relay a group-encrypted MLS
   * application message (the §3.4 ctl-announce) to the roster. Member-gated +
   * rate-limited server-side; `feature_disabled` when the flag is off (quiet).
   * `payload.ciphertext` is opaque — no key material crosses.
   */
  mlsSendCtl(payload: MlsCtlPayload): Promise<MlsHttpResult<void>> {
    return this.#apiMls("POST", `/mls/groups/${payload.group_id}/messages`, {
      device_id: this.status.get("state")?.device_id,
      ciphertext: payload.ciphertext,
    });
  }

  /** Generate + record a KeyPackage batch (`PUT /mls/key_packages` body). */
  mlsPublishKeyPackages(userId: string): Promise<MlsPublishKeyPackages> {
    return this.#invoke("e2ee_mls_publish_key_packages", { userId });
  }

  /** Low-water KeyPackage replenish driven by the server-reported count. */
  mlsReplenish(
    userId: string,
    serverRemaining: number,
  ): Promise<MlsPublishKeyPackages | null> {
    return this.#invoke("e2ee_mls_replenish", { userId, serverRemaining });
  }

  /** Prune expired local KeyPackage bookkeeping (client-timer driven). */
  mlsExpireKeyPackages(): Promise<void> {
    return this.#invoke("e2ee_mls_expire_key_packages");
  }

  // ================================================================
  // Media E2EE — MLS Delivery Service couriers (slice 6.4)
  //
  // Thin HTTP couriers over the SAME transport seam as text E2EE (`#api` +
  // the arbitration-aware `#apiMls`). Every body/response is PUBLIC material
  // or opaque ciphertext — no key material crosses here (the sole secret
  // egress stays `callFrameKeys`). `POST /mls/groups` and `.../commits` are
  // arbitrated: a 409 is a create-race / commit-Lost, NORMAL control flow
  // (never an exception). Every route 400s `FeatureDisabled` when the
  // media-E2EE flag is off (§3.4 L4), surfaced as a quiet `feature_disabled`
  // outcome so the session stays plaintext without a loud NOT-ENCRYPTED latch.
  // ================================================================

  /**
   * Arbitration- and feature-flag-aware MLS fetch. Unlike `#api` (which throws
   * on any non-2xx), this returns 409 arbitration and feature-off as NORMAL
   * `MlsHttpResult` outcomes so the session treats create-race / commit-Lost /
   * media-E2EE-disabled as control flow, not exceptions (judgment call 3, L4).
   * Any OTHER non-2xx still throws.
   */
  async #apiMls<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: {
      arbitrated?: boolean;
      mfaRetryable?: boolean;
      notFoundOutcome?: boolean;
      callFullOutcome?: boolean;
      headers?: Record<string, string>;
    },
  ): Promise<MlsHttpResult<T>> {
    const [authHeader, authValue] = this.#client.authenticationHeader;

    const response = await fetch(`${this.#client.options.baseURL}${path}`, {
      method,
      headers: {
        [authHeader]: authValue,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts?.headers ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.ok) {
      const parsed =
        response.status === 204
          ? (undefined as T)
          : ((await response.json()) as T);
      return { kind: "ok", body: parsed };
    }

    // 409 on an arbitrated route: the body carries the winner (the open group
    // id, or the winning commit to rebase onto). Never an exception.
    if (opts?.arbitrated && response.status === 409) {
      return { kind: "conflict", body: (await response.json()) as T };
    }

    // MlsCallFull (409) on an opted-in NON-arbitrated route (`mlsJoinIntent`):
    // the roster is at the ceiling and this NEW joiner is refused (A3). Normal
    // control flow — the joiner auto-leaves (never a lingering non-enrolled).
    if (opts?.callFullOutcome && response.status === 409) {
      const err = (await response.json().catch(() => null)) as {
        type?: string;
      } | null;
      if (err?.type === "MlsCallFull") return { kind: "call_full" };
      throw new Error(
        `E2EE MLS ${method} ${path} failed: 409 ${err?.type ?? "conflict"}`,
      );
    }

    // Feature-off (400 `FeatureDisabled`): "not an E2EE call" — quiet. The
    // session stays plaintext and MUST NOT latch a loud NOT-ENCRYPTED state.
    if (response.status === 400) {
      const err = (await response.json().catch(() => null)) as {
        type?: string;
      } | null;
      if (err?.type === "FeatureDisabled") return { kind: "feature_disabled" };
      throw new Error(
        `E2EE MLS ${method} ${path} failed: 400 ${err?.type ?? "bad request"}`,
      );
    }

    // LEGACY-SERVER fallback (publish-UX plan §3.3): a pre-§3.1 server MFA-
    // gates the first MLS KeyPackage publish per device and returns 401
    // `InvalidToken` when no `X-MFA-Ticket` is presented. The auth guard
    // already validated the session, so a 401 reaching HERE means "an MFA
    // ticket is required", not a dead session. Surface it as a normal outcome
    // ONLY for the opted-in publish route (the session prompts once and
    // retries); a 401 on any other MLS route stays a thrown auth failure.
    // An upgraded server never demands a publish-time ticket; remove this
    // arm in a post-rollout cleanup.
    if (opts?.mfaRetryable && response.status === 401) {
      return { kind: "mfa_required" };
    }

    // 404 on an opted-in route: the group no longer exists or was CLOSED
    // (e.g. the DS's solo-stale rejoin close) — the joiner treats this as
    // "re-establish onto the create path", not a failure.
    if (opts?.notFoundOutcome && response.status === 404) {
      return { kind: "not_found" };
    }

    throw new Error(`E2EE MLS ${method} ${path} failed: ${response.status}`);
  }

  /**
   * `PUT /mls/key_packages` — publish/replenish this device's KeyPackages so
   * admitters can claim one to add us. Every publication rides the
   * device-bound session + server-verified credential binding — no MFA
   * (publish-UX plan §3.1); `mfaTicket` only serves the legacy-server
   * fallback (plan §3.3). `payload` is produced natively by
   * `mlsPublishKeyPackages` / `mlsReplenish`.
   */
  mlsPutKeyPackages(
    payload: MlsPublishKeyPackages,
    mfaTicket?: string,
  ): Promise<MlsHttpResult<ResponsePublishMlsKeyPackages>> {
    return this.#apiMls("PUT", "/mls/key_packages", payload, {
      mfaRetryable: true,
      headers: mfaTicket ? { "X-MFA-Ticket": mfaTicket } : undefined,
    });
  }

  /**
   * `POST /mls/key_packages/claim` — atomically consume one KeyPackage per
   * target device for admission. The caller MUST re-verify each returned
   * `binding_signature` natively (via `callAdmit`) — the DS relay is never the
   * trust decision.
   */
  mlsClaimKeyPackage(
    body: MlsClaimKeyPackagesBody,
  ): Promise<MlsHttpResult<ResponseClaimMlsKeyPackages>> {
    return this.#apiMls("POST", "/mls/key_packages/claim", body);
  }

  /**
   * `POST /mls/groups` — register the epoch-0 group for a call (arbitrated).
   * `ok` ⇒ we are the creator; `conflict` ⇒ another open group already exists
   * for the channel and its id (+ the DS-asserted `channel_id`, the honest-DS
   * T-15 leg) is in the body — take the join path.
   */
  mlsCreateGroup(
    payload: MlsCreateGroupPayload,
  ): Promise<MlsHttpResult<ResponseCreateMlsGroup>> {
    return this.#apiMls("POST", "/mls/groups", payload, { arbitrated: true });
  }

  /**
   * `POST /mls/groups/<id>/join_intent` — broadcast a signed join intent;
   * members fan-out-verify and admit. 204 on success (`ok` with a `void`
   * body). `payload` is produced + T-15-guarded natively by `callJoinIntent`.
   */
  mlsJoinIntent(
    groupId: string,
    payload: MlsJoinIntentPayload,
  ): Promise<MlsHttpResult<void>> {
    return this.#apiMls("POST", `/mls/groups/${groupId}/join_intent`, payload, {
      notFoundOutcome: true,
      callFullOutcome: true,
    });
  }

  /**
   * `POST /mls/groups/<id>/commits` — submit our staged commit for the next
   * epoch (arbitrated). `ok` ⇒ Won (merge via `callCommitWon`); `conflict` ⇒
   * Lost, with the winning commit in the body to rebase onto (`callCommitLost`
   * then process). `body` is produced natively (`callAdmit` / `callHeartbeat`
   * / `callRemove`).
   */
  mlsSubmitCommit(
    groupId: string,
    body: MlsSubmitCommit,
  ): Promise<MlsHttpResult<ResponseSubmitMlsCommit>> {
    return this.#apiMls("POST", `/mls/groups/${groupId}/commits`, body, {
      arbitrated: true,
    });
  }

  /**
   * `GET /mls/groups/<id>/commits?from_epoch=` — gap refetch for a desynced
   * member (requires GROUP membership server-side). Ascending by epoch;
   * `current_epoch` lets a caught-up caller confirm it is current. `groupId`
   * is 64 lowercase hex chars, so it needs no URL encoding.
   */
  mlsFetchCommits(
    groupId: string,
    fromEpoch: number,
  ): Promise<MlsHttpResult<ResponseFetchMlsCommits>> {
    return this.#apiMls(
      "GET",
      `/mls/groups/${groupId}/commits?from_epoch=${fromEpoch}`,
    );
  }

  /**
   * `GET /mls/channels/<id>/open_group` — the pre-join / in-call probe (6.5,
   * FE-7): does the channel have an open MLS group (i.e. is the call E2EE)?
   * Returns the group summary, or null on 404 / feature-off / any error (a
   * plain call). `channelId` is a ULID, so no URL encoding is needed.
   */
  async mlsOpenGroup(
    channelId: string,
  ): Promise<{ group_id: string; member_count: number } | null> {
    const res = await this.#apiMls<{
      group_id: string;
      member_count: number;
    }>("GET", `/mls/channels/${channelId}/open_group`, undefined, {
      notFoundOutcome: true,
    });
    return res.kind === "ok" ? res.body : null;
  }

  /**
   * Whether this shell can actually RECEIVE native call-key pushes — a
   * SYNCHRONOUS capability probe (slice 6.4 step 7, audit H3/NEW-4). It is the
   * exact precondition `onCallKeysChanged` checks before subscribing
   * (`!!window.__TAURI__?.event`); kept here, next to it, so that when 6.7 adds
   * the Android Capacitor key-push channel BOTH update together.
   *
   * The RTC layer folds this into `e2eeCapable` at Room-construction time. A
   * shell that is `nativeE2EEAvailable()` but CANNOT receive key pushes (today:
   * the Capacitor Android shell, whose `onCallKeysChanged` returns a no-op)
   * must be built WITHOUT the LiveKit `e2ee` option — never an E2EE-capable
   * Room whose first-key install can never arrive, which would leave the
   * pause-publish window permanently open and publish plaintext to the SFU
   * while believing it is encrypted (invariant 1). Fail CLOSED: no key-push
   * channel ⇒ treat as a non-E2EE shell (the loud non-enrolled path).
   *
   * MUST stay synchronous: `e2eeCapable` and the `e2ee:` option are decided
   * synchronously at Room construction, whereas `onCallKeysChanged` is awaited
   * later — gating on its (always-truthy) return would decide too late.
   */
  nativeKeyPushAvailable(): boolean {
    return !!(window as { __TAURI__?: TauriGlobal }).__TAURI__?.event;
  }

  /**
   * Subscribe to native epoch-change pushes (`e2ee:call-keys-changed`). On
   * every local epoch advance the RTC layer re-invokes `callFrameKeys` and
   * feeds `MlsKeyProvider` (plan §3.5). Desktop (Tauri) only; the Android
   * Capacitor listener is 6.7. Returns an unsubscribe fn.
   */
  async onCallKeysChanged(
    callback: (event: { group_id: string; epoch: number }) => void,
  ): Promise<() => void> {
    const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
    if (!tauri?.event) return () => {};
    return tauri.event.listen<{ group_id: string; epoch: number }>(
      "e2ee:call-keys-changed",
      (event) => callback(event.payload),
    );
  }
}

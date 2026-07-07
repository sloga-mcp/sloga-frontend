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
  | { mode: "plaintext" };

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
  sender_device_id: string | null;
  sequence: number | null;
  detail: { missing?: number } | null;
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

/**
 * Whether the native E2EE layer is reachable (Tauri desktop shell). The
 * web build has no native layer — and the server additionally refuses
 * E2EE routes for sessions that never proved a device claim.
 */
export function nativeE2EEAvailable(): boolean {
  return !!(window as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
}

export class E2EEBridge implements E2EEAdapter {
  #client: Client;
  #tauri: TauriGlobal;

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

  /** Reactive native status (drives the settings consent flow) */
  readonly status = new ReactiveMap<
    "state",
    NativeStatus & { claimed: boolean }
  >();

  constructor(client: Client) {
    this.#client = client;
    this.#tauri = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;

    client.on("ready", () => void this.#onReady());
  }

  // ================================================================
  // IPC + raw HTTP plumbing
  // ================================================================

  #invoke<T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    return this.#tauri.core.invoke<T>(command, args, options);
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

  async #onReady(): Promise<void> {
    try {
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
      }
    } catch (error) {
      console.error("[e2ee] startup failed", error);
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
      console.error(
        "[e2ee] device claim REJECTED — this session cannot drain envelopes",
      );
      return;
    }

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

  /** Fetch a signed device listing and reconcile pins natively */
  async #reconcileDevices(userId: string): Promise<void> {
    const devices = await this.#api<unknown[]>("GET", `/e2ee/devices/${userId}`);
    const report = await this.#invoke<{
      revoked: string[];
      changed: string[];
      new_devices: string[];
    }>("e2ee_reconcile_devices", { userId, devices });

    if (
      report.revoked.length ||
      report.changed.length ||
      report.new_devices.length
    ) {
      await this.#refreshMode(userId);
      await this.#syncRecent(userId);
    }
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
    await this.#refreshMode(conversation);
    // Inject the message and any markers the decrypt recorded (gap,
    // tampered, identity change …) with their canonical native row ids
    await this.#syncRecent(conversation, /* live */ true);
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
    this.sendModes.set(peerId, verdict.mode);

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

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#invoke<EncryptResult>("e2ee_encrypt", {
          peerUserId: peerId,
          selfUserId: selfId,
          peerBundle,
          selfBundle,
          content,
          attachments,
        });
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

    const peerId = this.#peerOf(channel);
    if (!peerId) return null;

    const verdict = await this.#invoke<SendModeVerdict>("e2ee_send_mode", {
      peerUserId: peerId,
    });
    this.sendModes.set(peerId, verdict.mode);
    if (verdict.mode === "plaintext") return null;

    const limit = params?.limit ?? 50;
    const rows = await this.#invoke<HistoryRow[]>("e2ee_history", {
      peerUserId: peerId,
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
            conversation: peerId,
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
      default:
        return "Encrypted conversation event.";
    }
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

    const shape = {
      _id: row.id,
      channel: channelId,
      author: isText
        ? row.direction === "out"
          ? self
          : row.conversation
        : SYSTEM_AUTHOR,
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
    if (channel.type !== "DirectMessage") return null;

    const peerId = this.#peerOf(channel);
    if (!peerId) return null;

    let mode: "encrypt" | "blocked" | "plaintext";
    try {
      mode = await this.sendModeNow(peerId);
    } catch {
      throw new E2EESendError(
        "Encryption status could not be verified. Nothing was sent.",
        "native",
      );
    }

    if (mode === "blocked") {
      throw new E2EESendError(
        "The recipient's security identity changed. Accept the change in the conversation before sending.",
        "blocked",
      );
    }
    if (mode === "plaintext" || !items.length) return null;

    // ---- encrypt mode: plaintext bytes never leave the device ----

    // Recipient devices declared on the blob (active pins of the peer +
    // our own other devices — mirrors the envelope fan-out)
    const recipients = await this.#invoke<
      { user_id: string; device_id: string }[]
    >("e2ee_attachment_recipients", {
      peerUserId: peerId,
      selfUserId: this.#client.user!.id,
    });

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
          "x-peer-user-id": peerId,
          "x-name": encodeURIComponent(file.name || "attachment"),
          "x-mime": encodeURIComponent(
            file.type || "application/octet-stream",
          ),
        },
      });

      const ciphertext = await this.#invoke<ArrayBuffer>(
        "e2ee_attachment_ciphertext",
        { localId: prepared.local_id },
      );

      const blobId = await this.#uploadBlob(ciphertext, recipients, onProgress);
      await this.#invoke("e2ee_attachment_attach_blob", {
        localId: prepared.local_id,
        blobId,
      });

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
   * Webview URL a decrypted attachment renders from — the desktop shell's
   * `e2ee-att` protocol, which decrypts natively per request (key material
   * never crosses to the webview). Windows serving origin; both path
   * segments are ULIDs / integers, so no encoding is needed.
   */
  attachmentUrl(messageId: string, idx: number): string {
    return `https://e2ee-att.localhost/${messageId}/${idx}`;
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
      this.sendModes.set(peerId, verdict.mode);
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
    this.sendModes.set(peerId, verdict.mode);
    return verdict.mode;
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
}

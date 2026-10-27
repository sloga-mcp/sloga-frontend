import { Accessor, Setter, batch, createSignal } from "solid-js";

import { API, Channel, Client, Message } from "stoat.js";
// The refusal class is read off the namespace rather than named above: the
// Draft specs load this file against a stoat.js stand-in that exports only
// the four names above, and a missing named export fails to link
import * as StoatSdk from "stoat.js";
import { ulid } from "ulid";

import { CONFIGURATION, insecureUniqueId } from "@revolt/common";

import { State } from "..";
// Pure modules, by relative path: the @revolt/client barrel would cycle, and
// the Draft specs load this file under plain node
import { isProtectedSendError } from "../../client/protectedSendError.ts";
import type { ProtectedNoticeKind } from "../../client/protectedShield.ts";
import { protectedNoticeForError } from "../../client/protectedShield.ts";

import { AbstractStore } from ".";
import { LAYOUT_SECTIONS } from "./Layout";
import { uploadFileChunked } from "./chunkedUpload";
import { describeSendError } from "./draftSendError.ts";
import {
  isProtectedForDraft,
  setProtectedChannelResolver,
} from "./protectedDraftGuard.ts";

/**
 * Attachment upload timeout, in milliseconds. Autumn buffers the whole file,
 * hashes it twice, encrypts it and PUTs it to S3 in one shot before responding,
 * so the wait after the last byte is sent scales with file size.
 */
const UPLOAD_TIMEOUT_BASE = 120e3;
const UPLOAD_TIMEOUT_PER_10MB = 60e3;
const UPLOAD_TIMEOUT_MAX = 30 * 60e3;

/**
 * On Android, files up to this size are read into memory when attached. The
 * picked file is a content URI owned by the gallery app, and some galleries
 * (seen on a Xiaomi) let the preview read succeed but fail the second read
 * the upload needs, so the request dies on the device and never reaches the
 * server. A snapshot taken at attach time is what every later read uses
 * (upload, E2EE preparation, retries). Larger files keep streaming from the
 * original handle to bound memory, and desktop pickers hand over stable disk
 * files, so they are left alone.
 */
const ATTACH_SNAPSHOT_MAX_BYTES = 32_000_000;

/**
 * A snapshot read that takes longer than this (e.g. a cloud-backed gallery
 * item still downloading) is abandoned in favour of the original handle, so
 * one stuck file can't hold up every attachment queued behind it.
 */
const ATTACH_SNAPSHOT_TIMEOUT = 30e3;

/**
 * Whether attachments should be snapshotted on this platform
 */
const snapshotsAttachments = () =>
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

export interface DraftData {
  /**
   * Message content
   */
  content?: string;

  /**
   * Message IDs being replied to
   */
  replies?: API.ReplyIntent[];

  /**
   * IDs of cached files
   */
  files?: string[];
}

export type UnsentMessage = {
  /**
   * Idempotency key
   */
  idempotencyKey: string;

  /**
   * Status
   */
  status: "sending" | "unsent" | "failed";

  /**
   * Why the last send attempt failed, shown on the failed message
   */
  error?: string;

  /**
   * Why the last protected send failed, as a notice kind (protected errors
   * carry no display copy); `DraftMessage` shows its text
   */
  protectedNotice?: ProtectedNoticeKind;

  /**
   * Count for the notice copy (seat or device cap), if any
   */
  protectedNoticeMax?: number | null;
} & DraftData;

/**
 * `TextFlowFailure` client reasons the bridge only raises before the first
 * POST of a send (or after deleting the stored bytes of an attempt known to
 * have failed): with a fresh key, nothing was delivered. Anything not listed
 * (`maybe_unsent`, `unexpected_error`, a reason added later) counts as an
 * unknown outcome.
 */
const UNDELIVERED_CLIENT_REASONS = new Set([
  "flag_stripped",
  "invalid_channel",
  "disposed",
  "malformed_encrypt",
  "empty_message",
  "invalid_flags",
  "invalid_reply",
  "not_allowed",
  "not_capable",
  "join_stalled",
  "welcome_pending",
  "no_group",
  "poisoned",
  "state_unavailable",
  "update_pending",
  "catch_up_incomplete",
  "catch_up_failed",
  "commit_restage_exhausted",
  "create_staged",
]);

/**
 * The cause of a protected send rejection: `ProtectedSendError.failure`, or
 * the SDK's own refusal thrown before the bridge was reached
 * @param error Thrown value
 * @returns Cause, or null for anything else
 */
function protectedFailureOf(
  error: unknown,
): Record<string, unknown> | Error | null {
  if (isProtectedSendError(error)) {
    const failure = error.failure;
    return typeof failure === "object" && failure !== null
      ? (failure as Record<string, unknown>)
      : null;
  }
  const name = (error as { name?: unknown } | null)?.name;
  return name === "ProtectedChannelUnavailable" ||
    name === "ProtectedFieldRefusedClient"
    ? (error as Error)
    : null;
}

/**
 * Whether a rejected protected send under a FRESH key was certainly not
 * delivered. True only for causes the bridge raises before any POST, or
 * after a definitive refusal (it deletes the stored bytes then); transport
 * failures, `maybe_unsent` and anything unrecognised are unknown outcomes.
 * Not valid for a retried key: an earlier attempt under it may still be
 * pending in the bridge's store.
 * @param error Thrown value
 * @returns Whether the message is known undelivered
 */
function protectedSendUndelivered(error: unknown): boolean {
  const failure = protectedFailureOf(error);
  if (!failure) return false;

  const { name, source, reason } = failure as Record<string, unknown>;
  if (
    name === "ProtectedChannelUnavailable" ||
    name === "ProtectedFieldRefusedClient"
  ) {
    return true;
  }

  if (source === "server" || source === "native") return true;
  return (
    source === "client" &&
    typeof reason === "string" &&
    UNDELIVERED_CLIENT_REASONS.has(reason)
  );
}

/**
 * Notice for a rejected protected send (plan D17)
 * @param error Thrown value
 * @param undelivered Whether the send is known undelivered
 * @returns Notice kind and its count
 */
function protectedSendNotice(
  error: unknown,
  undelivered: boolean,
): [ProtectedNoticeKind, number | null] {
  const failure = protectedFailureOf(error);
  const name = (failure as { name?: unknown } | null)?.name;
  if (name === "ProtectedChannelUnavailable") return ["not_available", null];
  if (name === "ProtectedFieldRefusedClient") return ["send_refused", null];

  if (failure) {
    const ui = protectedNoticeForError(failure, { op: "send" });
    if (ui.kind === "notice" && ui.tag !== "unknown") {
      return [ui.notice, ui.max];
    }
  }

  return [undelivered ? "send_refused" : "maybe_unsent", null];
}

export interface TextSelection {
  /**
   * Draft we should update
   */
  channelId: string;

  /**
   * Start index of text selection
   */
  start: number;

  /**
   * End index of text selection
   */
  end: number;
}

export type TypeDraft = {
  /**
   * All active message drafts
   */
  drafts: Record<string, DraftData>;

  /**
   * Unsent messages
   */
  outbox: Record<string, UnsentMessage[]>;

  /**
   * Message being edited, per channel. Kept per channel so a composer in one
   * window can't start or end an edit in another window's conversation.
   */
  editing?: Record<string, EditingState>;
};

export type EditingState = {
  /**
   * ID of the message being edited, or `true` as a marker for the channel's
   * message list to open the newest own message in the editor
   */
  id: string | true;

  /**
   * Current value of the editor
   */
  content?: string;
};

/**
 * Composer setter that replaces the editor contents (`[text]`) or focuses it
 * (`["_focus"]`)
 */
export type NodeReplacementSetter = Setter<
  readonly [string | "_focus"] | undefined
>;

type NodeReplacementEntry = {
  channelId: string;
  setter: NodeReplacementSetter;
};

/**
 * List of image content types
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Message drafts store
 */
export class Draft extends AbstractStore<"draft", TypeDraft> {
  /**
   * Keep track of cached files
   */
  private fileCache: Record<
    string,
    {
      file: File;
      dataUri?: string;
      dimensions?: [number, number];
      autumnId?: string;
      uploadProgress: [Accessor<number>, Setter<number>];
      /**
       * Set once the request body has been fully written to the socket but the
       * server hasn't responded yet. uploadProgress only measures bytes sent,
       * so without this the UI parks at 100% for the whole server-side leg
       * (hashing, encryption, S3 PUT) with no indication anything is happening.
       */
      uploadProcessing: [Accessor<boolean>, Setter<boolean>];
      /**
       * Why the attach-time snapshot read failed, if it did. The upload then
       * falls back to the original handle and will most likely fail the same
       * way, so the reason goes into the error the user sees.
       */
      readError?: string;
    }
  >;

  /**
   * Current text selection
   */
  private textSelection?: TextSelection;

  /**
   * Tail of the queue that attaches files one at a time
   */
  private attachQueue: Promise<void> = Promise.resolve();

  /**
   * Mounted composers, oldest first. Each window renders its own composer, so
   * the same channel may appear more than once; the newest entry wins.
   */
  private nodeReplacements: NodeReplacementEntry[] = [];

  /**
   * Mirror of `nodeReplacements` read only by `hasNodeReplacement()`, so menus
   * can react to composers mounting. Registration and replacement read the
   * plain array: a composer that registers from inside an effect must not
   * subscribe that effect to every other composer's registration.
   */
  private nodeReplacementsSignal: [
    Accessor<NodeReplacementEntry[]>,
    Setter<NodeReplacementEntry[]>,
  ];

  /**
   * Channels whose composer took focus, per window id, most recent last. A
   * mention from one window's menu must only ever land in that window's
   * composer, never in a conversation open in another window.
   */
  private composerFocus: Record<string, string[]> = {};

  /**
   * Mirror of `composerFocus` read only by `hasNodeReplacement()`, for the
   * same reason as `nodeReplacementsSignal`
   */
  private composerFocusSignal: [
    Accessor<Record<string, string[]>>,
    Setter<Record<string, string[]>>,
  ];

  /**
   * Client the protected-channel wiring was last installed for
   */
  private boundClient?: Client;

  /**
   * Set by `hydrate()`, which runs once every store's saved data is loaded:
   * until then the outbox is not the user's real outbox
   */
  private outboxLoaded = false;

  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "draft");
    this.fileCache = {};
    this.nodeReplacementsSignal = createSignal<NodeReplacementEntry[]>([]);
    this.composerFocusSignal = createSignal<Record<string, string[]>>({});

    this.getFile = this.getFile.bind(this);
    this.setEditingMessageContent = this.setEditingMessageContent.bind(this);
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    // State.hydrate() calls this after loading every store from disk
    this.outboxLoaded = true;
  }

  /**
   * Install the protected-channel wiring for a client (plan D9d, D10; W4b
   * audit M4), once per client; a new client (sign-in after sign-out)
   * replaces it. This store is the sole owner of both pieces:
   * - the draft-guard resolver behind `addFile`'s refusal, on every shell;
   * - where the client has a native bridge, the outbox keys its D10 orphan
   *   scan must leave alone (an entry the outbox owns is retried from here).
   *
   * Safe to call from anywhere, any number of times: `NotificationsWorker`
   * calls it at app start (before connect, so `addFile` refuses before the
   * first send) and `sendDraft` calls it as well. A different client
   * replaces the previous one everywhere; no reference to it is kept.
   * @param client Client
   */
  bindClient(client: Client) {
    if (this.boundClient === client) return;
    this.boundClient = client;

    setProtectedChannelResolver((channelId) =>
      client.isProtectedChannel(channelId),
    );

    // Structural: importing the bridge type from @revolt/client would cycle
    const e2ee = client.e2ee as unknown as
      | {
          setProtectedOutboxKeys?: (
            accessor: () => ReadonlySet<string>,
          ) => void;
        }
      | undefined;
    try {
      e2ee?.setProtectedOutboxKeys?.(() => this.outboxKeys());
    } catch (error) {
      // Never fails a send: without the keys the orphan scan only defers.
      // Forget the client so the next call registers again.
      this.boundClient = undefined;
      console.error("[protected] outbox keys not registered", {
        name: (error as { name?: unknown } | null)?.name,
      });
    }
  }

  /**
   * Idempotency keys of every outbox entry, for the bridge's orphan scan.
   * All channels, not only protected ones: the scan only looks up keys a
   * stored protected send carries, and such a key is in the outbox only when
   * this outbox owns that send. Filtering by the protected flag instead
   * could hand the scan a live entry while the flag is still loading.
   * @returns Keys
   * @throws until the outbox is loaded, so the scan defers instead of
   * reading a live entry as an orphan (W4b audit M4)
   */
  private outboxKeys(): ReadonlySet<string> {
    if (!this.outboxLoaded) {
      throw new Error("[protected] draft outbox not loaded");
    }

    const keys = new Set<string>();
    for (const entries of Object.values(this.get().outbox ?? {})) {
      for (const entry of entries ?? []) {
        keys.add(entry.idempotencyKey);
      }
    }

    return keys;
  }

  /**
   * Generate default values
   */
  default(): TypeDraft {
    return {
      drafts: {},
      outbox: {},
      editing: {},
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeDraft>): TypeDraft {
    const drafts: TypeDraft["drafts"] = {};
    const outbox: TypeDraft["outbox"] = {};

    /**
     * Validate replies array is correct
     * @param replies Replies array
     * @returns Validity
     */
    const validateReplies = (replies?: API.ReplyIntent[]) =>
      Array.isArray(replies) &&
      replies.length &&
      !replies.find(
        (x) =>
          typeof x !== "object" ||
          typeof x.id !== "string" ||
          typeof x.mention !== "boolean",
      );

    const messageDrafts = input.drafts;
    if (typeof messageDrafts === "object") {
      for (const channelId of Object.keys(messageDrafts)) {
        const entry = messageDrafts?.[channelId];
        const draft: DraftData = {};

        if (typeof entry?.content === "string" && entry.content) {
          draft.content = entry.content;
        }

        if (validateReplies(entry?.replies)) {
          draft.replies = entry!.replies;
        }

        if (Object.keys(draft).length) {
          drafts[channelId] = draft;
        }
      }
    }

    const pendingMessages = input.outbox;
    if (typeof pendingMessages === "object") {
      for (const channelId of Object.keys(pendingMessages)) {
        const entry = pendingMessages[channelId];
        const messages: UnsentMessage[] = [];

        if (Array.isArray(entry)) {
          for (const message of entry) {
            if (
              typeof message === "object" &&
              ["sending", "unsent", "failed"].includes(message.status) &&
              typeof message.idempotencyKey === "string" &&
              typeof message.content === "string" // shouldn't be enforced once we support caching files
            ) {
              const msg: UnsentMessage = {
                idempotencyKey: message.idempotencyKey,
                content: message.content,
                status: "unsent",
                // TODO: support storing unsent files in local storage
                // files: [..]
              };

              if (validateReplies(message.replies)) {
                msg.replies = message.replies;
              }

              messages.push(msg);
            }
          }
        }

        outbox[channelId] = messages;
      }
    }

    // An edit in progress is never restored after a reload: a stale `true`
    // marker would open the editor on the next visit to that channel. The
    // legacy global `editingMessageId` / `editingMessageContent` fields are
    // dropped by omission.
    return {
      drafts,
      outbox,
      editing: {},
    };
  }

  /**
   * Get draft for a channel.
   * @param channelId Channel ID
   */
  getDraft(channelId: string): DraftData {
    return this.get().drafts[channelId] ?? {};
  }

  /**
   * Check whether a channel has a draft.
   * @param channelId Channel ID
   */
  hasDraft(channelId: string) {
    const entry = this.get().drafts[channelId];
    return entry && entry.content!.length > 0;
  }

  /**
   * Set draft for a channel.
   * @param channelId Channel ID
   * @param data Draft content
   */
  setDraft(
    channelId: string,
    data?: DraftData | ((data: DraftData) => DraftData),
  ) {
    if (typeof data === "function") {
      data = data(this.getDraft(channelId));
    }

    if (typeof data === "undefined") {
      console.info("[draft] cleared!");
      return this.clearDraft(channelId);
    }

    console.info("[draft] updated to ", data);
    this.set("drafts", channelId, data);
  }

  /**
   * Clear draft from a channel.
   * @param channelId Channel ID
   */
  clearDraft(channelId: string) {
    const files = this.getDraft(channelId)?.files ?? [];
    for (const file of files) {
      delete this.fileCache[file];
    }

    this.setDraft(channelId, {
      content: "",
      replies: [],
      files: [],
    });
  }

  /**
   * Get the draft for a channel and send it
   * @param client Client
   * @param channel Channel
   * @param existingDraft The existing draft to send
   * @param retryOf Idempotency key of the outbox entry being retried
   */
  async sendDraft(
    client: Client,
    channel: Channel,
    existingDraft?: DraftData,
    retryOf?: string,
  ) {
    // Protected channels (plan D9e) are decided FIRST, from the SDK's own
    // predicate (server flag or local pin, independent of `client.e2ee`),
    // before any pop, Autumn upload or prepareDraftAttachments below
    if (client.isProtectedChannel(channel.id)) {
      return this.sendProtectedDraft(client, channel, existingDraft, retryOf);
    }

    this.bindClient(client);

    const draft = existingDraft ?? this.popDraft(channel.id);

    // Check if this is something we can even send
    if (!draft.content && !draft.files?.length) {
      if (retryOf) this.cancelSend(channel, retryOf);
      return;
    }

    // Fail-closed E2EE gate at the shared chokepoint (composer, retrySend,
    // any future caller), BEFORE the outbox entry and BEFORE any plaintext
    // byte reaches the ordinary Autumn store. The adapter decides from
    // native local truth: null ⇒ plaintext path (legacy upload below);
    // string[] ⇒ the files were encrypted natively and uploaded as opaque
    // ciphertext blobs (refs travel inside the envelope); blocked /
    // unverifiable ⇒ throws E2EESendError — never a plaintext fallback.
    let e2eeAttachments: string[] | null;
    try {
      e2eeAttachments = client.e2ee
        ? await client.e2ee.prepareDraftAttachments(
            channel,
            (draft.files ?? []).map((fileId) => {
              const entry = this.getFile(fileId);
              return {
                file: entry.file,
                onProgress: (fraction: number) =>
                  entry.uploadProgress[1](fraction),
              };
            }),
          )
        : null;
    } catch (error) {
      // Nothing was queued or sent. A retried entry is still in the outbox
      // (retrySend only marks it "sending"), so put it back as failed
      // rather than letting the message disappear.
      if (retryOf) this.markFailed(channel.id, retryOf, error);
      throw error;
    }

    // Add message to the outbox, replacing the entry being retried
    const idempotencyKey = ulid();
    this.set("outbox", channel.id, [
      ...this.getPendingMessages(channel.id).filter(
        (entry) => entry.idempotencyKey !== retryOf,
      ),
      {
        ...draft,
        idempotencyKey,
        status: "sending",
      } as UnsentMessage,
    ]);

    // Try sending the message
    const { content, replies, files } = draft;

    // Construct message object
    const attachments: string[] = [];
    const data: API.DataMessageSend & { e2eeAttachments?: string[] } = {
      content,
      replies,
      attachments,
    };

    if (e2eeAttachments?.length) {
      data.e2eeAttachments = e2eeAttachments;
    }

    // Both the upload loop and the send itself must share one catch: an upload
    // that throws outside it leaves the outbox entry wedged at "sending"
    // forever with no user-visible error.
    try {
      // Add any files if attached (plaintext path only — for an encrypted
      // conversation they were already uploaded as ciphertext blobs above)
      if (files?.length && !e2eeAttachments) {
        // TODO: allow individual files to be cancelled
        for (const fileId of files) {
          // Prepare for upload
          const body = new FormData();
          const { file, autumnId, uploadProgress, uploadProcessing } =
            this.getFile(fileId);

          // Use ID if already uploaded
          if (autumnId) {
            attachments.push(autumnId);
            continue;
          }

          // Files above the threshold take the chunked path: each part is
          // its own sub-100 MB request (the CDN kills anything larger), with
          // real progress, retry and resume. The returned id is a normal
          // claim-once attachment id.
          if (file.size > CONFIGURATION.CHUNKED_UPLOAD_THRESHOLD) {
            const id = await uploadFileChunked(
              client,
              file,
              (fraction) => uploadProgress[1](fraction),
              (processing) => uploadProcessing[1](processing),
            );
            attachments.push(id);
            this.fileCache[fileId].autumnId = id;
            continue;
          }

          body.set("file", file);

          // We have to use XMLHttpRequest because modern fetch duplex streams require QUIC or HTTP/2
          const xhr = new XMLHttpRequest();

          // How the request ended when it never got a response
          let failure: "timeout" | "network" | undefined;
          // Whether the whole body went out before it ended
          let bodySent = false;

          const [success, response] = await new Promise<
            [boolean, { id: string }]
          >((resolve) => {
            xhr.upload.addEventListener("progress", (event) => {
              if (event.lengthComputable) {
                uploadProgress[1](event.loaded / event.total);
              }
            });

            // The body is now fully written to the socket; everything after
            // this is the server hashing, encrypting and storing the file.
            xhr.upload.addEventListener("load", () => {
              bodySent = true;
              uploadProgress[1](1);
              uploadProcessing[1](true);
            });

            xhr.addEventListener("timeout", () => (failure = "timeout"));
            xhr.addEventListener("error", () => (failure = "network"));

            xhr.addEventListener("loadend", () => {
              const ok = xhr.readyState === 4 && xhr.status === 200;

              // Only a real success may claim 100%: a failure that also read
              // "100%" sent users (and us) looking at the server
              if (ok) uploadProgress[1](1);
              uploadProcessing[1](false);
              resolve([ok, xhr.response]);
            });

            xhr.open(
              "POST",
              `${client.configuration!.features.autumn.url}/attachments`,
              true,
            );

            // Neither the browser nor Caddy imposes a timeout here, so without
            // this a stalled S3 write hangs the send indefinitely. Scale with
            // file size — the server-side leg is proportional to it.
            xhr.timeout = Math.min(
              UPLOAD_TIMEOUT_BASE +
                (file.size / 10e6) * UPLOAD_TIMEOUT_PER_10MB,
              UPLOAD_TIMEOUT_MAX,
            );

            const [authHeader, authHeaderValue] = client.authenticationHeader;
            xhr.setRequestHeader(authHeader, authHeaderValue);
            xhr.responseType = "json";

            xhr.send(body);
          });

          // "loadend" fires for error/abort/timeout too, so a non-200 (or no
          // response at all) lands here rather than hanging.
          if (!success) {
            const { readError } = this.getFile(fileId);
            throw new Error(
              xhr.status
                ? `Upload of \`${file.name}\` failed (HTTP ${xhr.status})`
                : failure === "timeout"
                  ? `Upload of \`${file.name}\` timed out`
                  : bodySent
                    ? `Upload of \`${file.name}\` lost its connection after the file was sent`
                    : `Upload of \`${file.name}\` failed before reaching the server (network error, or the file couldn't be read${
                        readError ? `: ${readError}` : ""
                      })`,
            );
          }

          attachments.push(response.id);
          this.fileCache[fileId].autumnId = response.id;
        }
      }

      // TODO: fix bug with backend
      if (!attachments.length) {
        delete data.attachments;
      }

      // Send the message and clear the draft
      await channel.sendMessage(data, idempotencyKey);

      if (files) {
        for (const file of files) {
          this.removeFile(channel.id, file);
        }
      }

      this.set(
        "outbox",
        channel.id,
        this.getPendingMessages(channel.id).filter(
          (entry) => entry.idempotencyKey !== idempotencyKey,
        ),
      );
    } catch (error) {
      this.markFailed(channel.id, idempotencyKey, error);

      // A fail-closed E2EE send (peer identity change, no usable device,
      // delivery failure) must surface loudly — the message was NOT sent in
      // plaintext. Re-throw so the composer shows the explicit hard error
      // instead of a silent "failed" outbox entry. (Name check avoids a
      // dependency cycle into @revolt/client.)
      if ((error as { name?: string })?.name === "E2EESendError") {
        throw error;
      }
    }
  }

  /**
   * Send a draft to a protected channel (plan D9e, D10). Text only: the
   * native layer encrypts it, and the outbox entry's key is the bridge's
   * idempotency key, under which it stores the ciphertext and re-sends the
   * same bytes on a retry.
   * @param client Client
   * @param channel Protected channel
   * @param existingDraft Outbox entry being retried
   * @param retryOf Idempotency key of the outbox entry being retried
   * @throws on every refusal or failed send, with the text kept
   */
  private async sendProtectedDraft(
    client: Client,
    channel: Channel,
    existingDraft?: DraftData,
    retryOf?: string,
  ) {
    this.bindClient(client);

    // Protected text exists only in text channels. A protected or pinned id
    // the server relabelled (Thread, Group, DM, SavedMessages) or one not
    // hydrated yet is refused before anything else, Retry included, so it
    // can never reach a plaintext path (S1 audit PB-1 backstop). Nothing is
    // popped: the composer keeps the draft, a retried entry stays failed.
    if (channel.type !== "TextChannel") {
      const error = new StoatSdk.ProtectedChannelUnavailable();
      if (retryOf) this.markProtectedFailed(channel.id, retryOf, error, true);
      throw error;
    }

    // Read, not popped: the composer keeps the draft until the outbox entry
    // below exists
    const draft = existingDraft ?? this.getDraft(channel.id);

    // Attachments never go to a protected channel: refused here, before any
    // pop, Autumn upload or prepareDraftAttachments, never stripped. The
    // draft keeps its text and files.
    if (draft.files?.length) {
      const error = new StoatSdk.ProtectedFieldRefusedClient("attachments");
      if (retryOf) this.markProtectedFailed(channel.id, retryOf, error, true);
      throw error;
    }

    const { content, replies } = draft;
    if (!content) {
      if (retryOf) this.cancelSend(channel, retryOf);
      return;
    }

    // One outbox model: the entry exists before the pop and survives a
    // reload (clean() keeps text entries). A retry reuses its key, never a
    // fresh ulid, so the bridge re-sends the ciphertext stored under it.
    const idempotencyKey = retryOf ?? ulid();
    this.set("outbox", channel.id, [
      ...this.getPendingMessages(channel.id).filter(
        (entry) => entry.idempotencyKey !== idempotencyKey,
      ),
      {
        idempotencyKey,
        content,
        replies,
        status: "sending",
      } as UnsentMessage,
    ]);

    if (!existingDraft) this.popDraft(channel.id);

    try {
      await channel.sendMessage({ content, replies }, idempotencyKey);
    } catch (error) {
      // Exactly one copy of the text survives, and every rejection reaches
      // the caller (never a silent "failed"):
      // - known undelivered, fresh key: back in the composer, entry deleted;
      // - unknown outcome, or a retried key (an earlier attempt under it may
      //   still be pending in the bridge): a failed entry under the SAME
      //   key, so a retry re-sends the stored bytes. Never put back in the
      //   composer, where a second send would mint a new key and could
      //   duplicate a message that did land.
      const undelivered = !retryOf && protectedSendUndelivered(error);
      if (
        undelivered &&
        !existingDraft &&
        this.restoreProtectedText(channel.id, content, replies)
      ) {
        this.cancelSend(channel, idempotencyKey);
      } else {
        this.markProtectedFailed(
          channel.id,
          idempotencyKey,
          error,
          undelivered,
        );
      }
      throw error;
    }

    this.set(
      "outbox",
      channel.id,
      this.getPendingMessages(channel.id).filter(
        (entry) => entry.idempotencyKey !== idempotencyKey,
      ),
    );
  }

  /**
   * Mark a protected outbox entry as failed, with a notice kind as the
   * reason. No `error` text: protected errors carry no display copy, and
   * `describeSendError` would show their identifier.
   * @param channelId Channel ID
   * @param idempotencyKey Idempotency key
   * @param error Thrown value
   * @param undelivered Whether the send is known undelivered
   */
  private markProtectedFailed(
    channelId: string,
    idempotencyKey: string,
    error: unknown,
    undelivered: boolean,
  ) {
    const [notice, max] = protectedSendNotice(error, undelivered);
    this.set(
      "outbox",
      channelId,
      this.getPendingMessages(channelId).map((entry) =>
        entry.idempotencyKey === idempotencyKey
          ? {
              ...entry,
              status: "failed",
              error: undefined,
              protectedNotice: notice,
              protectedNoticeMax: max,
            }
          : entry,
      ),
    );
  }

  /**
   * Put the text of an undelivered protected send back in the composer,
   * unless the user has typed something new since
   * @param channelId Channel ID
   * @param content Text that was sent
   * @param replies Replies that were sent
   * @returns Whether the text went back
   */
  private restoreProtectedText(
    channelId: string,
    content: string,
    replies?: API.ReplyIntent[],
  ): boolean {
    const current = this.getDraft(channelId);
    if (current.content) return false;

    this.setDraft(channelId, {
      ...current,
      content,
      replies: current.replies?.length ? current.replies : replies,
    });

    // A mounted composer shows the editor, not the draft: write it there
    // too (it was emptied by the pop, so this is the whole text)
    this.replaceNode(channelId, [content]);
    return true;
  }

  /**
   * Remove required objects for sending a new message
   * @param channelId Channel ID
   * @returns Object with all required data
   */
  popDraft(channelId: string) {
    const { content, replies, files } = this.getDraft(channelId);

    this.setDraft(channelId, {
      content: "",
      replies: [],
      files: files?.splice(CONFIGURATION.MAX_ATTACHMENTS),
    });

    return {
      content,
      replies,
      files: files?.slice(0, CONFIGURATION.MAX_ATTACHMENTS),
    };
  }

  /**
   * Retry sending a message in a channel
   * @param client Client
   * @param channel Channel
   * @param idempotencyKey Idempotency key
   * @param onError Called with the reason if the retry fails; the entry is
   * already back in the outbox as failed by then
   */
  retrySend(
    client: Client,
    channel: Channel,
    idempotencyKey: string,
    onError?: (error: unknown) => void,
  ) {
    batch(() => {
      const draft = this.getPendingMessages(channel.id).find(
        (entry) => entry.idempotencyKey === idempotencyKey,
      );
      // TODO: validation?
      if (!draft || draft.status === "sending") return;

      // The entry stays in the outbox, shown as sending, until sendDraft
      // queues its replacement; a send refused before that (the E2EE gate)
      // marks it failed again instead of losing the message.
      this.set(
        "outbox",
        channel.id,
        this.getPendingMessages(channel.id).map((entry) =>
          entry.idempotencyKey === idempotencyKey
            ? { ...entry, status: "sending" }
            : entry,
        ),
      );

      // sendDraft's shared E2EE gate re-runs on retry: a conversation that
      // became encrypted since the original send re-routes the files down
      // the encrypted path (never a plaintext upload), and a blocked /
      // unverifiable state rejects the retry outright. Without a handler,
      // swallow the rejection so it doesn't surface as an unhandled one —
      // the fail-closed refusal already prevented any plaintext upload.
      this.sendDraft(client, channel, draft, idempotencyKey).catch(
        (error: unknown) => onError?.(error),
      );
    });
  }

  /**
   * Cancel sending a message in a channel
   * @param channel Channel
   * @param idempotencyKey Idempotency key
   */
  cancelSend(channel: Channel, idempotencyKey: string) {
    this.set(
      "outbox",
      channel.id,
      this.getPendingMessages(channel.id).filter(
        (entry) => entry.idempotencyKey !== idempotencyKey,
      ),
    );
  }

  /**
   * Mark an outbox entry as failed
   * @param channelId Channel ID
   * @param idempotencyKey Idempotency key
   * @param error Why the send failed
   */
  private markFailed(
    channelId: string,
    idempotencyKey: string,
    error: unknown,
  ) {
    this.set(
      "outbox",
      channelId,
      this.getPendingMessages(channelId).map((entry) =>
        entry.idempotencyKey === idempotencyKey
          ? {
              ...entry,
              status: "failed",
              error: describeSendError(error),
            }
          : entry,
      ),
    );
  }

  /**
   * Get all pending messages
   * @param channelId Channel Id
   * @returns Pending messages
   */
  getPendingMessages(channelId: string) {
    return this.get().outbox[channelId] ?? [];
  }

  /**
   * Set the current text selection
   * @param channelId Channel Id
   * @param start Start index
   * @param end End index
   */
  setSelection(channelId: string, start: number, end: number) {
    this.textSelection = {
      channelId,
      start,
      end,
    };
  }

  /**
   * Insert text into the current selection
   * @param string Text
   */
  insertText(string: string) {
    if (this.textSelection) {
      const content = this.getDraft(this.textSelection.channelId).content ?? "";
      const startStr = content.slice(0, this.textSelection.start);
      const endStr = content.slice(this.textSelection.end, content.length);

      this.setDraft(this.textSelection.channelId, (draft) => ({
        ...draft,
        content: startStr + string + endStr,
      }));

      const pasteEndIdx = startStr.length + string.length;
      this.textSelection = {
        ...this.textSelection,
        start: pasteEndIdx,
        end: pasteEndIdx,
      };
    }
  }

  /**
   * Reset and clear all drafts.
   */
  reset() {
    this.set("drafts", {});
  }

  /**
   * Add a reply to the given message
   * @param message Message
   * @param selfId Own user ID
   */
  addReply(message: Message, selfId: string) {
    this.replaceNode(message.channelId, ["_focus"]);

    // Ignore if reply already exists
    if (
      this.getDraft(message.channelId).replies?.find(
        (reply) => reply.id === message.id,
      )
    ) {
      return;
    }

    if (
      (this.getDraft(message.channelId).replies?.length ?? 0) >=
      CONFIGURATION.MAX_REPLIES
    ) {
      return;
    }

    // We should not mention ourselves, otherwise use previous mention state
    const shouldMention =
      message.authorId !== selfId &&
      this.state.layout.getSectionState(LAYOUT_SECTIONS.MENTION_REPLY);

    // Update the draft with new reply
    this.setDraft(message.channelId, (data) => ({
      replies: [
        ...(data.replies ?? []),
        {
          id: message.id,
          mention: shouldMention,
        },
      ],
    }));
  }

  /**
   * Toggle reply mention
   *
   * This has a side-effect of updating the MENTION_REPLY section state!
   * @param channelId Channel ID
   * @param messageId Message ID
   */
  toggleReplyMention(channelId: string, messageId: string) {
    this.setDraft(channelId, (data) => ({
      replies: data.replies?.map((reply) => {
        if (reply.id === messageId) {
          // Save current mention reply state as new default
          this.state.layout.setSectionState(
            LAYOUT_SECTIONS.MENTION_REPLY,
            !reply.mention,
          );

          return { ...reply, mention: !reply.mention };
        }

        return reply;
      }),
    }));
  }

  /**
   * Remove a reply by message ID from a channel draft
   * @param channelId Channel ID
   * @param messageId Message ID
   */
  removeReply(channelId: string, messageId: string) {
    this.setDraft(channelId, (data) => ({
      replies: data.replies?.filter((reply) => reply.id !== messageId),
    }));
  }

  /**
   * Create a cache entry for a file and probe image dimensions
   * @param file File to cache
   * @param snapshot Whether to read the file into memory first
   * @returns Cache ID
   */
  private async cacheFile(file: File, snapshot = false): Promise<string> {
    let readError: string | undefined;

    if (snapshot && file.size <= ATTACH_SNAPSHOT_MAX_BYTES) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const bytes = await Promise.race([
          file.arrayBuffer(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("timed out reading the file")),
              ATTACH_SNAPSHOT_TIMEOUT,
            );
          }),
        ]);

        file = new File([bytes], file.name, {
          type: file.type,
          lastModified: file.lastModified,
        });
      } catch (error) {
        readError =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "unknown";
        console.warn("[draft] couldn't snapshot attachment", file.name, error);
      } finally {
        clearTimeout(timer);
      }
    }

    const id = insecureUniqueId();
    this.fileCache[id] = {
      file,
      readError,
      dataUri: ALLOWED_IMAGE_TYPES.includes(file.type)
        ? URL.createObjectURL(file)
        : undefined,
      // we know what we're doing here...
      // eslint-disable-next-line solid/reactivity
      uploadProgress: createSignal(0),
      // eslint-disable-next-line solid/reactivity
      uploadProcessing: createSignal(false),
    };

    if (this.fileCache[id].dataUri) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise((resolve, reject) => {
        const image = new Image();

        image.onload = () => {
          this.fileCache[id].dimensions = [image.width, image.height];
          resolve(void 0);
        };

        image.onerror = reject;
        image.src = this.fileCache[id].dataUri!;

        // A stalled read (the same one that can time out the snapshot) would
        // otherwise never settle and hold up every attachment queued behind
        // it; the preview just goes without dimensions
        timer = setTimeout(reject, ATTACH_SNAPSHOT_TIMEOUT);
      })
        // ignore errors
        .catch(() => {})
        .finally(() => clearTimeout(timer));
    }

    return id;
  }

  /**
   * Add a file to a draft
   * @param channelId Channel ID
   * @param file File to add
   */
  addFile(channelId: string, file: File) {
    // A protected channel takes no attachments (plan D9d). The composer hides
    // the entry points; this refuses whatever still arrives. UX only: the
    // never-plaintext guard is sendDraft's own check.
    if (isProtectedForDraft(channelId)) {
      console.warn("[protected] attachment refused", { channelId });
      return Promise.resolve();
    }

    // One attachment at a time: the picker hands over many files at once and
    // the composer doesn't await, so without this every snapshot would be
    // read into memory concurrently. It also keeps the files in pick order.
    const added = this.attachQueue.then(async () => {
      // Files past the attachment limit are never sent from this draft, so
      // they aren't worth holding in memory
      const snapshot =
        snapshotsAttachments() &&
        (this.getDraft(channelId).files?.length ?? 0) <
          CONFIGURATION.MAX_ATTACHMENTS;

      const id = await this.cacheFile(file, snapshot);

      // The channel may have turned protected while the file was read
      if (isProtectedForDraft(channelId)) {
        this.deleteFile(id);
        console.warn("[protected] attachment refused", { channelId });
        return;
      }

      this.setDraft(channelId, (data) => ({
        files: [...(data.files ?? []), id],
      }));
    });

    this.attachQueue = added.catch(() => {});
    return added;
  }

  /**
   * Replace a draft file's contents (e.g. after editing an image), keeping
   * its position in the draft. The entry gets a fresh ID so anything keyed
   * on it (previews, upload state) rebuilds, and — critically — so a stale
   * `autumnId` from an earlier upload of the pre-edit bytes can never be
   * reused by sendDraft.
   * @param channelId Channel ID
   * @param fileId File ID being replaced
   * @param file New file contents
   */
  async replaceFile(channelId: string, fileId: string, file: File) {
    if (!this.getDraft(channelId).files?.includes(fileId)) return;

    const id = await this.cacheFile(file);

    // the draft may have changed while dimensions were probed
    if (!this.getDraft(channelId).files?.includes(fileId)) {
      this.deleteFile(id);
      return;
    }

    this.setDraft(channelId, (data) => ({
      files: data.files?.map((entry) => (entry === fileId ? id : entry)),
    }));

    this.deleteFile(fileId);
  }

  /**
   * Delete a file from cache
   * @param fileId File ID
   */
  private deleteFile(fileId: string) {
    const file = this.fileCache[fileId];
    if (file?.dataUri) {
      URL.revokeObjectURL(file.dataUri);
    }

    delete this.fileCache[fileId];
  }

  /**
   * Remove a file from a draft
   * @param channelId Channel ID
   * @param fileId File ID
   */
  removeFile(channelId: string, fileId: string) {
    this.deleteFile(fileId);
    this.setDraft(channelId, (data) => ({
      files: data.files?.filter((entry) => entry !== fileId),
    }));
  }

  /**
   * Get cache File by its ID
   * @param fileId File ID
   * @returns Cached File
   */
  getFile(fileId: string) {
    return this.fileCache[fileId];
  }

  /**
   * Whether additional elements (attachment/reply) are present
   * @param channelId Channel ID
   * @returns Whether information is present
   */
  hasAdditionalElements(channelId: string): boolean {
    const draft = this.getDraft(channelId);
    return !!(draft.replies?.length || draft.files?.length);
  }

  /**
   * Remove additional information from a draft (file or reply)
   * @param channelId Channel ID
   * @returns Whether information was removed
   */
  popFromDraft(channelId: string): boolean {
    const draft = this.getDraft(channelId);

    if (draft.replies?.length) {
      this.setDraft(channelId, {
        replies: draft.replies.slice(0, draft.replies.length - 1),
      });

      return true;
    }

    if (draft.files?.length) {
      this.setDraft(channelId, {
        files: draft.files.slice(0, draft.files.length - 1),
      });

      return true;
    }

    return false;
  }

  /**
   * Write one channel's editing state, leaving every other channel untouched
   * @param channelId Channel ID
   * @param entry New state, or undefined to stop editing
   */
  private setEditing(channelId: string, entry: EditingState | undefined) {
    batch(() => {
      // The store can't write a path through a missing record
      if (!this.get().editing) this.set("editing", {});

      if (entry) {
        // Writing an object over an existing one merges the two, so `content`
        // is always passed explicitly (undefined deletes it) to drop the
        // previous message's text
        this.set("editing", channelId, {
          id: entry.id,
          content: entry.content,
        });
      } else {
        // undefined deletes the key; the setter's types don't model deletion
        this.set("editing", channelId, undefined as unknown as EditingState);
      }
    });
  }

  /**
   * Start editing a message in its channel
   * @param message Message
   */
  setEditingMessage(message: Message): void;

  /**
   * Ask a channel's message list to edit the newest own message (`true`), or
   * stop editing in that channel (`undefined`)
   * @param value Marker or undefined
   * @param channelId Channel ID
   */
  setEditingMessage(value: true | undefined, channelId: string): void;

  setEditingMessage(value: Message | true | undefined, channelId?: string) {
    if (typeof value === "object") {
      this.setEditing(value.channelId, {
        id: value.id,
        content: value.content,
      });
    } else if (channelId) {
      this.setEditing(channelId, value ? { id: true } : undefined);
    }
  }

  /**
   * Set the editor value for a channel's message being edited
   * @param channelId Channel ID
   * @param content Content
   */
  setEditingMessageContent(channelId: string, content: string) {
    // Nothing to attach the text to once the edit has ended
    if (!this.get().editing?.[channelId]) return;
    this.set("editing", channelId, "content", content);
  }

  /**
   * Message currently being edited in a channel
   * @param channelId Channel ID
   * @returns Message ID, `true` while the newest own message is looked up,
   * or undefined
   */
  getEditingMessageId(channelId: string): string | true | undefined {
    return this.get().editing?.[channelId]?.id;
  }

  /**
   * Editor value for a channel's message being edited
   * @param channelId Channel ID
   * @returns Content
   */
  getEditingMessageContent(channelId: string): string | undefined {
    return this.get().editing?.[channelId]?.content;
  }

  /**
   * Register a mounted composer so replies, edits and mentions can reach it
   * @param channelId Channel the composer writes to
   * @param setter Composer setter
   * @returns Function that removes this registration (and only this one)
   */
  registerNodeReplacement(
    channelId: string,
    setter: NodeReplacementSetter,
  ): () => void {
    const entry: NodeReplacementEntry = { channelId, setter };
    this.setNodeReplacements([...this.nodeReplacements, entry]);

    return () => {
      if (!this.nodeReplacements.includes(entry)) return;

      batch(() => {
        this.setNodeReplacements(
          this.nodeReplacements.filter((other) => other !== entry),
        );

        // Registrations don't say which window they belong to, so the focus
        // notes for this channel are dropped in every window. Otherwise a
        // window that showed this channel could keep reaching it after the
        // channel moved to another window. A window that still shows it
        // picks it up again on its next focus.
        this.setComposerFocus(
          Object.fromEntries(
            Object.entries(this.composerFocus).map(([ctxId, channels]) => [
              ctxId,
              channels.filter((other) => other !== channelId),
            ]),
          ),
        );
      });
    };
  }

  /**
   * Replace the focus notes and notify `hasNodeReplacement()` readers
   * @param focus New notes
   */
  private setComposerFocus(focus: Record<string, string[]>) {
    this.composerFocus = focus;
    this.composerFocusSignal[1](focus);
  }

  /**
   * Replace the composer list and notify `hasNodeReplacement()` readers
   * @param entries New list
   */
  private setNodeReplacements(entries: NodeReplacementEntry[]) {
    this.nodeReplacements = entries;
    this.nodeReplacementsSignal[1](entries);
  }

  /**
   * Newest composer registered for a channel, read without tracking
   * @param channelId Channel ID
   * @returns Entry, if any
   */
  private findNodeReplacement(channelId: string) {
    for (let i = this.nodeReplacements.length - 1; i >= 0; i--) {
      if (this.nodeReplacements[i].channelId === channelId) {
        return this.nodeReplacements[i];
      }
    }
  }

  /**
   * Record that a channel's composer took focus
   * @param channelId Channel ID
   * @param ctxId Id of the window the composer is in
   */
  noteComposerFocus(channelId: string, ctxId: string = "main") {
    const channels = this.composerFocus[ctxId] ?? [];
    if (channels[channels.length - 1] === channelId) return;

    this.setComposerFocus({
      ...this.composerFocus,
      [ctxId]: [...channels.filter((other) => other !== channelId), channelId],
    });
  }

  /**
   * Whether a composer is mounted
   * @param channelId Channel ID, or omit for any channel
   * @param ctxId Window id; when given, only composers that took focus in
   * that window count
   * @returns Whether one is registered
   */
  hasNodeReplacement(channelId?: string, ctxId?: string): boolean {
    const entries = this.nodeReplacementsSignal[0]();
    const isMounted = (id: string) =>
      entries.some((entry) => entry.channelId === id);

    if (ctxId === undefined) {
      return channelId === undefined
        ? entries.length > 0
        : isMounted(channelId);
    }

    return (this.composerFocusSignal[0]()[ctxId] ?? []).some(
      (id) => (channelId === undefined || id === channelId) && isMounted(id),
    );
  }

  /**
   * Replace the contents of a composer, or focus it with `["_focus"]`
   * @param channelId Channel ID, or undefined for the composer focused last
   * in the given window (none if no composer there took focus)
   * @param value New contents
   * @param ctxId Window id used when no channel is given, `"main"` by default
   * @returns Whether a composer received it
   */
  replaceNode(
    channelId: string | undefined,
    value: readonly [string | "_focus"],
    ctxId?: string,
  ): boolean {
    let entry: NodeReplacementEntry | undefined;

    if (channelId !== undefined) {
      entry = this.findNodeReplacement(channelId);
    } else {
      const channels = this.composerFocus[ctxId ?? "main"] ?? [];
      for (let i = channels.length - 1; i >= 0 && !entry; i--) {
        entry = this.findNodeReplacement(channels[i]);
      }
    }

    if (!entry) return false;
    entry.setter(value);
    return true;
  }
}

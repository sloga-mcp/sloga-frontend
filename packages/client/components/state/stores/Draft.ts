import { Accessor, Setter, batch, createSignal } from "solid-js";

import { API, Channel, Client, Message } from "stoat.js";
import { ulid } from "ulid";

import { CONFIGURATION, insecureUniqueId } from "@revolt/common";

import { State } from "..";

import { AbstractStore } from ".";
import { LAYOUT_SECTIONS } from "./Layout";
import { uploadFileChunked } from "./chunkedUpload";
import { describeSendError } from "./draftSendError.ts";

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
} & DraftData;

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
    /** nothing needs to be done */
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
   */
  async sendDraft(client: Client, channel: Channel, existingDraft?: DraftData) {
    const draft = existingDraft ?? this.popDraft(channel.id);

    // Check if this is something we can even send
    if (!draft.content && !draft.files?.length) return;

    // Fail-closed E2EE gate at the shared chokepoint (composer, retrySend,
    // any future caller), BEFORE the outbox entry and BEFORE any plaintext
    // byte reaches the ordinary Autumn store. The adapter decides from
    // native local truth: null ⇒ plaintext path (legacy upload below);
    // string[] ⇒ the files were encrypted natively and uploaded as opaque
    // ciphertext blobs (refs travel inside the envelope); blocked /
    // unverifiable ⇒ throws E2EESendError — never a plaintext fallback.
    const e2eeAttachments = client.e2ee
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

    // Add message to the outbox
    const idempotencyKey = ulid();
    this.set("outbox", channel.id, [
      ...this.getPendingMessages(channel.id),
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
      this.set(
        "outbox",
        channel.id,
        this.getPendingMessages(channel.id).map((entry) =>
          entry.idempotencyKey === idempotencyKey
            ? {
                ...entry,
                status: "failed",
                error: describeSendError(error),
              }
            : entry,
        ),
      );

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
   */
  retrySend(client: Client, channel: Channel, idempotencyKey: string) {
    batch(() => {
      const draft = this.get().outbox[channel.id].find(
        (entry) => entry.idempotencyKey === idempotencyKey,
      );
      // TODO: validation?

      this.cancelSend(channel, idempotencyKey);
      // sendDraft's shared E2EE gate re-runs on retry: a conversation that
      // became encrypted since the original send re-routes the files down
      // the encrypted path (never a plaintext upload), and a blocked /
      // unverifiable state rejects the retry outright. Swallow the
      // rejection so it doesn't surface as an unhandled one — the
      // fail-closed refusal already prevented any plaintext upload.
      this.sendDraft(client, channel, draft!).catch(() => {});
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

/**
 * What a message notification may reveal, and where: the one decision every
 * notification surface (the Sloga-drawn toast, the OS toast, the browser's
 * `Notification`) consults before it plays a sound or builds a payload.
 *
 * Pure and free of imports on purpose, so `node --test` can load it
 * (`notificationPreviewPolicy.test.ts`). The glue that reads settings, voice
 * and E2EE state and acts on the answer lives in `NotificationsWorker.tsx`.
 *
 * Every rule after the user's choice can only take something away. That is
 * the point: a later rule never re-enables what an earlier one withheld, so
 * "Off" stays off and a stripped body stays stripped whatever else is true.
 */

/** The user's choice for direct messages and group chats. */
export type DmPreviewMode = "full_reply" | "sender" | "off";

export const DM_PREVIEW_MODES: readonly DmPreviewMode[] = [
  "full_reply",
  "sender",
  "off",
];

export const DM_PREVIEW_DEFAULT: DmPreviewMode = "full_reply";

export function isDmPreviewMode(value: unknown): value is DmPreviewMode {
  return (
    typeof value === "string" &&
    (DM_PREVIEW_MODES as readonly string[]).includes(value)
  );
}

/**
 * Who draws the notification. `sloga_toast` is our own window, so its text
 * never reaches the OS notification store; `os_toast` is any shell toast the
 * OS draws (Windows Action Center, macOS Notification Center, Electron's
 * `Notification`); `web` is the browser's `Notification`, which has no way to
 * send a reply back to us.
 */
export type NotificationSurface = "sloga_toast" | "os_toast" | "web";

export interface PreviewPolicyInput {
  /** The global setting. */
  mode: DmPreviewMode;
  /** The per-conversation override; wins over `mode` when set. */
  override?: DmPreviewMode;
  /** This message was end-to-end encrypted. */
  isE2EE: boolean;
  surface: NotificationSurface;
  screensharing: boolean;
  streamerMode: boolean;
  /** Someone is remote-controlling this PC. */
  rcActive: boolean;
  /** The stoat.js `channel.type`. */
  channelType: string;
}

export interface PreviewDecision {
  show: boolean;
  playSound: boolean;
  showBody: boolean;
  showImage: boolean;
  allowReply: boolean;
}

/** Channel types the DM preview setting governs. */
function isDmScope(channelType: string): boolean {
  return channelType === "DirectMessage" || channelType === "Group";
}

/**
 * The mode in force for one conversation. Settings are validated on load, but
 * the policy does not lean on that: a value it does not recognize is treated
 * as "sender", which still notifies and reveals nothing.
 */
function effectiveMode(input: PreviewPolicyInput): DmPreviewMode {
  const chosen = input.override ?? input.mode;
  return isDmPreviewMode(chosen) ? chosen : "sender";
}

export function decidePreview(input: PreviewPolicyInput): PreviewDecision {
  let decision: PreviewDecision;

  if (!isDmScope(input.channelType)) {
    // Server channels keep today's behavior: the DM setting and overrides do
    // not reach them, and there is no quick reply outside DMs.
    decision = {
      show: true,
      playSound: true,
      showBody: true,
      showImage: true,
      allowReply: false,
    };
  } else {
    switch (effectiveMode(input)) {
      case "off":
        // "Off" means badges only: no toast and no sound.
        decision = {
          show: false,
          playSound: false,
          showBody: false,
          showImage: false,
          allowReply: false,
        };
        break;
      case "sender":
        decision = {
          show: true,
          playSound: true,
          showBody: false,
          showImage: false,
          allowReply: false,
        };
        break;
      case "full_reply":
        decision = {
          show: true,
          playSound: true,
          showBody: true,
          showImage: true,
          allowReply: input.surface === "sloga_toast",
        };
        break;
    }

    // Anyone watching the screen (a remote controller, a share's audience, a
    // stream) sees the toast, and a reply box would let a remote controller
    // type as this user. Who wrote is still announced.
    if (input.rcActive || input.screensharing || input.streamerMode) {
      decision.showBody = false;
      decision.showImage = false;
      decision.allowReply = false;
    }
  }

  // A toast the OS draws is persisted by the OS (Windows keeps it in
  // wpndatabase.db), which would put decrypted E2EE text on disk in the clear.
  // Only our own toast window may show an encrypted message's content. The
  // browser's `Notification` is OS-drawn too, so it is held to the same rule.
  if (input.isE2EE && input.surface !== "sloga_toast") {
    decision.showBody = false;
    decision.showImage = false;
  }

  if (input.surface === "web") decision.allowReply = false;

  return decision;
}

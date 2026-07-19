import { createSignal } from "solid-js";

import type { Channel, User } from "stoat.js";

/**
 * A DM/Group call that is currently ringing us. Set by NotificationsWorker
 * when the call starts, consumed by IncomingCallOverlay (global popup) and
 * the home sidebar (ringing indicator).
 */
export interface IncomingCall {
  channel: Channel;
  /** User who started the call, if known to the cache */
  caller?: User;
  /** Epoch ms when we started ringing */
  receivedAt: number;
}

/**
 * How long the popup rings before auto-dismissing. Slightly shorter than the
 * synthesized ringtone's natural end (30 rings) so UI and sound stop together.
 */
export const INCOMING_CALL_TIMEOUT_MS = 45_000;

const [incomingCall, setIncomingCall] = createSignal<IncomingCall>();

export { incomingCall };

/**
 * Desktop shell: flash the taskbar icon while ringing (no-op elsewhere).
 * UserAttentionType.Critical = 1 — Windows flashes until the window is
 * focused; passing null cancels.
 */
function requestWindowAttention(active: boolean) {
  try {
    const tauriWindow = (
      window as {
        __TAURI__?: {
          window?: {
            getCurrentWindow?: () => {
              requestUserAttention(
                type: number | null,
              ): Promise<void>;
            };
          };
        };
      }
    ).__TAURI__?.window;
    tauriWindow
      ?.getCurrentWindow?.()
      ?.requestUserAttention(active ? 1 : null)
      .catch(() => {});
  } catch {
    // not running in the desktop shell
  }
}

/** Present the ringing popup for a starting call */
export function presentIncomingCall(call: IncomingCall) {
  setIncomingCall(call);
  requestWindowAttention(true);
}

/**
 * Dismiss the ringing popup.
 * @param channelId Only dismiss if the popup belongs to this channel
 */
export function dismissIncomingCall(channelId?: string) {
  if (channelId && incomingCall()?.channel.id !== channelId) return;
  if (incomingCall()) requestWindowAttention(false);
  setIncomingCall(undefined);
}

import { createSignal } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

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

/**
 * Android: cancel the ringing call notification (no-op elsewhere). The
 * full-screen intent leaves a native notification ringing while the popup is
 * up; once the user has accepted or declined it must stop, or the ringtone
 * carries on into the call.
 */
function dismissNativeCallNotification(channelId: string) {
  try {
    if (!Capacitor.isNativePlatform()) return;
    registerPlugin<{
      dismissCallNotification(options: { channelId: string }): Promise<void>;
    }>("PushToken")
      .dismissCallNotification({ channelId })
      .catch(() => {});
  } catch {
    // plugin unavailable on this shell
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
  const active = incomingCall();
  if (active) {
    requestWindowAttention(false);
    dismissNativeCallNotification(active.channel.id);
  }
  setIncomingCall(undefined);
}

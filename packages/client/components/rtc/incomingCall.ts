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
  /** Id of the call this ring belongs to, when the server gave one */
  callId?: string;
  /** Whether the caller started it as a video call, when known */
  video?: boolean;
}

/**
 * Why a ring stopped. "answered" and "declined" are the user's own choice on
 * this device, "timeout" is the ring window running out with no answer,
 * "ended" is the call finishing or the caller giving up, and "elsewhere" is
 * the call being handled on another of the user's devices.
 */
export type IncomingCallDismissReason =
  | "answered"
  | "declined"
  | "timeout"
  | "ended"
  | "elsewhere";

/**
 * How long a ring lasts when the server does not say. Slightly shorter than
 * the synthesized ringtone's natural end (30 rings) so UI and sound stop
 * together.
 */
export const RING_FALLBACK_MS = 45_000;

/**
 * @deprecated Use `ringDurationMs` with the server's advertised ring length.
 * Kept at the fallback value for callers that have not moved yet.
 */
export const INCOMING_CALL_TIMEOUT_MS = RING_FALLBACK_MS;

/**
 * Ring length in milliseconds from the server's advertised seconds. Anything
 * that is not a finite number from 5 to 120 inclusive falls back to 45 s, so
 * a missing, mistyped or out-of-range value can never give a ring that stops
 * at once or one that never stops. A fractional value inside the range is
 * accepted, and the result is rounded to a whole millisecond. Pure.
 */
export function ringDurationMs(advertisedSecs: unknown): number {
  if (
    typeof advertisedSecs !== "number" ||
    !Number.isFinite(advertisedSecs) ||
    advertisedSecs < 5 ||
    advertisedSecs > 120
  ) {
    return RING_FALLBACK_MS;
  }
  return Math.round(advertisedSecs * 1000);
}

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
              requestUserAttention(type: number | null): Promise<void>;
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
 *
 * The reason is sent only when the caller gave one, so a dismiss without a
 * reason sends exactly the options it always has.
 */
function dismissNativeCallNotification(
  channelId: string,
  reason?: IncomingCallDismissReason,
) {
  try {
    if (!Capacitor.isNativePlatform()) return;
    registerPlugin<{
      dismissCallNotification(options: {
        channelId: string;
        reason?: IncomingCallDismissReason;
      }): Promise<void>;
    }>("PushToken")
      .dismissCallNotification(reason ? { channelId, reason } : { channelId })
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
 * @param reason Why the ring stopped, passed on to the Android notification
 */
export function dismissIncomingCall(
  channelId?: string,
  reason?: IncomingCallDismissReason,
): void {
  if (channelId && incomingCall()?.channel.id !== channelId) return;
  const active = incomingCall();
  if (active) {
    requestWindowAttention(false);
    dismissNativeCallNotification(active.channel.id, reason);
  }
  setIncomingCall(undefined);
}

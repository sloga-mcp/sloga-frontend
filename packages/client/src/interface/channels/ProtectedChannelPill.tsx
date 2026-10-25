import { createEffect, createSignal, on, Show } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import type { E2EEBridge } from "@revolt/client/e2ee";
import {
  errorUiCopy,
  noticeCopy,
  panelCopy,
  shieldLabel,
} from "@revolt/client/protectedCopy";
import {
  type ProtectedShieldState,
  protectedNoticeForError,
  shieldPresentation,
} from "@revolt/client/protectedShield";
import type {
  OwnerPinStatus,
  ProtectedChannelView,
  ProtectedSeatsResponse,
  ProtectedUiApi,
} from "@revolt/client/protectedTextTypes";
import {
  protectedUiOf,
  useProtectedShield,
} from "@revolt/client/useProtectedChannel";
import { ProtectedShieldIcon } from "@revolt/ui/components/features/protected/ProtectedShieldIcon";

/**
 * Protected channel header pill and its click panel (W4 lane C3, plan D14,
 * D15, D21; product choices 2, 3, 5, 6).
 *
 * Renders nothing for a channel that is neither server-protected nor pinned,
 * so a normal header is unchanged. The pill is state-colored; its click
 * panel shows the state line and notice, then (only on a capable device) the
 * encryption line, seat usage, the owner-pin verification state, "Review
 * owner change" (D15: only while a SAME-user owner change is pending, and
 * the native dialog opens only from that click) and the owner-device-only
 * "Re-create the protected group" (D21). No handover UI (choice 3). A device
 * that cannot run the text plane gets the explanation only.
 *
 * Reads only the read-only shield hook and the bridge's `ProtectedUiApi`;
 * no request is sent unless the user clicks an action. Imports are file
 * paths and every `styled` call takes a string tag (an imported component
 * at module scope blanks the app).
 */

// --- pure: begin (loaded by protectedPill.scan.test.ts; the only runtime
// dependency is A2 `shieldPresentation`)

/**
 * D15 + choice 2: "Review owner change" is offered only while native holds
 * a pending signer of the SAME user and the change is pending (the manager
 * parked it, or native reports the pin as changed). A different user is
 * final in S1 (native's inform dialog), and an unknown signer gets no
 * button.
 * @param view The manager's channel view
 */
export function pillOwnerChangeReviewable(
  view: ProtectedChannelView | null | undefined,
): boolean {
  const pin = view?.native?.owner_pin ?? null;
  if (!pin || pin.pending_signer?.same_user !== true) return false;
  return view?.ownerChangePending === true || pin.status === "changed";
}

/**
 * Seat usage from the last `GET .../seats`. A null, non-integer or
 * non-positive `slot_cap` is UNKNOWN (null), never 0 and never "unlimited"
 * (design #152). No snapshot, or a malformed count, shows no seat line.
 * @param snapshot `seatsSnapshot(channelId)`
 */
export function pillSeats(
  snapshot: ProtectedSeatsResponse | null | undefined,
): { used: number; cap: number | null } | null {
  if (!snapshot) return null;
  const used = snapshot.seats_used;
  if (typeof used !== "number" || !Number.isInteger(used) || used < 0) {
    return null;
  }
  const cap = snapshot.slot_cap;
  return {
    used,
    cap:
      typeof cap === "number" && Number.isInteger(cap) && cap >= 1 ? cap : null,
  };
}

/**
 * Owner-pin line. "Verified" needs the pin AND native's verification of the
 * owner's device (`owner_verified`); a first-sight pin is "not verified
 * yet". A changed pin shows the review line only while it is reviewable;
 * otherwise the state notice already explains it (null = no line).
 * @param view The manager's channel view
 */
export function pillOwnerPin(
  view: ProtectedChannelView | null | undefined,
): OwnerPinStatus | null {
  const pin = view?.native?.owner_pin ?? null;
  if (pin?.status === "pinned" && pin.owner_verified === true) return "pinned";
  if (pin?.status === "changed") {
    return pillOwnerChangeReviewable(view) ? "changed" : null;
  }
  return "unpinned";
}

/**
 * D21: the owner-device-only re-create is offered when the manager says the
 * group is stranded (`recreateAvailable`, every member wiped) AND this
 * device signed the current seat list (re-checked here; native refuses a
 * non-signer anyway).
 * @param view The manager's channel view
 * @param self This session's user and E2EE device
 */
export function pillRecreateOffered(
  view: ProtectedChannelView | null | undefined,
  self: {
    userId: string | null | undefined;
    deviceId: string | null | undefined;
  },
): boolean {
  if (view?.recreateAvailable !== true) return false;
  const list = view.native?.seat_list ?? null;
  return (
    !!self.userId &&
    !!self.deviceId &&
    list !== null &&
    list.signer_user_id === self.userId &&
    list.signer_device_id === self.deviceId
  );
}

/**
 * D14 text tint: the state hue mixed 70% into the surface text color.
 * @param hueVar CSS variable NAME from `shieldPresentation`
 */
export function protectedTintColor(hueVar: string): string {
  return `color-mix(in srgb, var(${hueVar}) 70%, var(--md-sys-color-on-surface))`;
}

/**
 * D14 channel-name tint for the header (no unread state there, so the
 * state's `tintName` alone decides; never while re-securing, choice 5).
 * Undefined for a channel without a shield, so its header is unchanged.
 * @param state The shield state, or null without a shield
 */
export function protectedHeaderNameStyle(
  state: ProtectedShieldState | null | undefined,
): { color: string } | undefined {
  if (!state) return undefined;
  const p = shieldPresentation(state);
  return p.tintName ? { color: protectedTintColor(p.hueVar) } : undefined;
}

// --- pure: end

type PillOp = "review" | "recreate";

interface Props {
  channel: Channel;
}

export function ProtectedChannelPill(props: Props) {
  const client = useClient();
  const { t } = useLingui();
  const shield = useProtectedShield(() => props.channel.id);

  // Kept by the pill (the panel unmounts on close) and keyed by channel, so
  // a result never shows on another channel's header.
  const [busy, setBusy] = createSignal<{
    channelId: string;
    op: PillOp;
  } | null>(null);
  const [failure, setFailure] = createSignal<{
    channelId: string;
    text: string;
  } | null>(null);

  createEffect(
    on(
      () => props.channel.id,
      () => setFailure(null),
    ),
  );

  const ui = (): ProtectedUiApi | null => protectedUiOf(client()?.e2ee);

  const presentation = () => {
    const s = shield();
    return s
      ? shieldPresentation(s.state, {
          tauriE2eeOff: s.notice === "enable_e2ee",
        })
      : null;
  };

  /** The most specific notice for the state (explainShield), else A2's. */
  const notice = () => shield()?.notice ?? presentation()?.notice ?? null;

  /**
   * Non-throwing reads for the panel: it renders under the floating
   * manager, outside this Show, so it never reads the Show's narrowed
   * accessor (a stale read throws). The fallback only covers the instant
   * before the pill unmounts and is the fail-closed state.
   */
  const stateNow = () => shield()?.state ?? "unverified";
  const pillHue = () =>
    `var(${presentation()?.hueVar ?? "--sloga-protected-alert"})`;
  const tauriE2eeOff = () => shield()?.notice === "enable_e2ee";

  /** Full panel only where the text plane runs (D3); else explain only. */
  const full = () => shield()?.capable === true;

  const view = () => shield()?.view ?? null;
  const reviewable = () => full() && pillOwnerChangeReviewable(view());
  const ownerPin = () => pillOwnerPin(view());
  const seats = () => {
    const api = ui();
    if (!api || typeof api.seatsSnapshot !== "function") return null;
    return pillSeats(api.seatsSnapshot(props.channel.id));
  };
  const recreateOffered = () =>
    full() &&
    pillRecreateOffered(view(), {
      userId: client()?.user?.id,
      deviceId: (client()?.e2ee as E2EEBridge | undefined)?.status.get("state")
        ?.device_id,
    });

  const busyOp = () => {
    const b = busy();
    return b && b.channelId === props.channel.id ? b.op : null;
  };
  const failureText = () => {
    const f = failure();
    return f && f.channelId === props.channel.id ? f.text : null;
  };

  /**
   * Runs one owner action from its button click. Errors surface in the
   * panel through A2 + C0 (never `error.message`); native `declined` (the
   * user cancelled the dialog) maps to no copy and stays silent.
   */
  async function run(op: PillOp) {
    if (busy()) return;
    const channelId = props.channel.id;
    const api = ui();
    const action =
      op === "review" ? api?.confirmOwnerChange : api?.recreateGroup;
    setFailure(null);
    if (!api || typeof action !== "function") {
      setFailure({
        channelId,
        text: noticeCopy(tauriE2eeOff() ? "enable_e2ee" : "not_available"),
      });
      return;
    }
    setBusy({ channelId, op });
    try {
      await action.call(api, channelId);
    } catch (error) {
      const answer = protectedNoticeForError(error, { op: "owner" });
      const text = errorUiCopy(answer);
      if (text) {
        console.error("[protected] owner action failed", {
          channelId,
          op,
          type: answer.tag,
        });
        setFailure({ channelId, text });
      }
    } finally {
      setBusy(null);
    }
  }

  const seatsLine = (s: { used: number; cap: number | null }) => {
    if (s.cap !== null) return panelCopy.seatsUsed(s.used, s.cap);
    const used = s.used;
    // Local msgid for C16: the cap is unknown (null), so no "of {cap}".
    return t`Seats used: ${used}`;
  };

  return (
    <Show when={shield()}>
      <Pill
        type="button"
        aria-haspopup="dialog"
        data-protected-pill={stateNow()}
        style={{ "--protected-pill-hue": pillHue() }}
        use:floating={{
          contextMenu: () => (
            <Panel
              role="dialog"
              aria-label={panelCopy.pill()}
              // The floating manager closes on any document mousedown or
              // click; keep the panel open for clicks inside it, so an
              // action's progress and error stay visible.
              onMouseDown={(e) => e.stopImmediatePropagation()}
              onClick={(e) => e.stopImmediatePropagation()}
            >
              <PanelState>
                <ProtectedShieldIcon
                  state={stateNow()}
                  tauriE2eeOff={tauriE2eeOff()}
                  size={20}
                />
                <span>{panelCopy.status(shieldLabel(stateNow()))}</span>
              </PanelState>
              <Show when={notice()}>
                {(kind) => <PanelNote>{noticeCopy(kind())}</PanelNote>}
              </Show>
              <Show when={full()}>
                <PanelLine>{panelCopy.encrypted()}</PanelLine>
                <Show when={seats()}>
                  {(seat) => <PanelLine>{seatsLine(seat())}</PanelLine>}
                </Show>
                <Show when={ownerPin()}>
                  {(pin) => <PanelLine>{panelCopy.ownerPin(pin())}</PanelLine>}
                </Show>
                <Show when={reviewable()}>
                  <PanelAction
                    type="button"
                    disabled={busyOp() !== null}
                    onClick={() => void run("review")}
                  >
                    {panelCopy.reviewOwnerChange()}
                  </PanelAction>
                </Show>
                <Show when={recreateOffered()}>
                  <PanelNote>{panelCopy.recreateGroupHint()}</PanelNote>
                  <PanelAction
                    type="button"
                    disabled={busyOp() !== null}
                    onClick={() => void run("recreate")}
                  >
                    {busyOp() === "recreate"
                      ? panelCopy.recreatingGroup()
                      : panelCopy.recreateGroup()}
                  </PanelAction>
                </Show>
              </Show>
              <Show when={failureText()}>
                {(text) => <PanelError role="alert">{text()}</PanelError>}
              </Show>
            </Panel>
          ),
          contextMenuHandler: "click",
        }}
      >
        {shieldLabel(stateNow())}
      </Pill>
    </Show>
  );
}

/**
 * State-colored pill; the hue arrives as `--protected-pill-hue`. Static:
 * no animation, no transition (D14).
 */
const Pill = styled("button", {
  base: {
    display: "inline-block",
    flexShrink: 0,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    marginInlineStart: "var(--gap-md)",
    padding: "2px var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    border:
      "1px solid color-mix(in srgb, var(--protected-pill-hue) 45%, transparent)",
    background:
      "color-mix(in srgb, var(--protected-pill-hue) 14%, transparent)",
    color:
      "color-mix(in srgb, var(--protected-pill-hue) 70%, var(--md-sys-color-on-surface))",
    fontSize: "0.75rem",
    fontWeight: 600,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
    cursor: "pointer",
    animation: "none",
    transition: "none",
    // A narrow phone header shrinks the pill before the header icons.
    _phone: {
      flexShrink: 1,
    },
  },
});

const Panel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    minWidth: "240px",
    maxWidth: "320px",
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    boxShadow: "0 0 3px var(--md-sys-color-shadow)",
    fontSize: "0.875rem",
    lineHeight: 1.4,
  },
});

const PanelState = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    fontWeight: 600,
  },
});

const PanelLine = styled("div", {
  base: {},
});

const PanelNote = styled("div", {
  base: {
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const PanelError = styled("div", {
  base: {
    color: "var(--md-sys-color-error)",
  },
});

const PanelAction = styled("button", {
  base: {
    alignSelf: "flex-start",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    background: "var(--md-sys-color-secondary-container)",
    color: "var(--md-sys-color-on-secondary-container)",
    fontWeight: 600,
    cursor: "pointer",
    "&:disabled": {
      opacity: 0.6,
      cursor: "default",
    },
  },
});

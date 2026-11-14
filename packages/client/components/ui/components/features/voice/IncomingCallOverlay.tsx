import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import { Capacitor } from "@capacitor/core";
import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient, useSound } from "@revolt/client";
import {
  pushProvider,
  unifiedPushRegistered,
} from "@revolt/client/NotificationsController";
import { webRingtoneAllowed } from "@revolt/client/pushPolicy";
import { useSlimMode } from "@revolt/client/useSlimMode";
import { useNavigate } from "@revolt/routing";
import {
  type AnswerResult,
  type IncomingCall,
  deviceLocked,
  dismissIncomingCall,
  incomingCall,
  ringDurationMs,
  useVoice,
} from "@revolt/rtc";
import { serverCallRingSecs } from "@revolt/rtc/serverRingLength";
import { useState } from "@revolt/state";
import { Avatar, Button } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * How long the "Call ended" notice and the caller's "No answer" / "Declined"
 * notice stay up before they clear themselves.
 */
const NOTICE_MS = 10_000;

/**
 * How long a pressed Accept may hold the ring open before this popup stops
 * waiting for it. Unlocking can take a minute on old Android versions, and
 * the join comes after that. Past this the ring goes back to its own timer,
 * so an Accept that never reports back cannot keep a ring up for good.
 */
const ANSWER_GIVE_UP_MS = 90_000;

/**
 * What the lock state reads as while the phone has not answered yet. Only the
 * Android app can be on screen over a lock screen, so only there does an open
 * question read as locked. Everywhere else the answer is always "not locked",
 * and reading it as locked would flash a full-screen ring for no reason.
 */
function lockUnknown(): boolean {
  return Capacitor.getPlatform() === "android";
}

/**
 * Time left of a ring that started at `receivedAt`, never more than the full
 * ring length. A start time that is missing or lies in the future gives the
 * full length.
 */
function ringTimeLeft(receivedAt: number, ringMs: number): number {
  const elapsed = Date.now() - receivedAt;
  if (!(elapsed >= 0)) return ringMs;
  return Math.max(0, ringMs - elapsed);
}

/** Name of a chat as a notice shows it: the other person, or the group. */
function chatName(channel: Channel | undefined): string | undefined {
  if (!channel) return undefined;
  const user = channel.recipient;
  return user ? (user.displayName ?? user.username) : channel.name;
}

/**
 * Global incoming-call popup, mounted once at app level. It renders three
 * things, each from its own state, so none of them depends on a ring being
 * up:
 *
 * - The ring itself, while a DM/Group call is ringing us (state set by
 *   NotificationsWorker). Accept answers through the voice store and opens
 *   the conversation once the join has landed, Decline tells the server. On
 *   a locked phone and in Slim view the ring covers the whole screen and
 *   shows nothing but who is calling.
 * - "Call ended", when an Accept found the ring already over.
 * - "No answer" / "Declined", on the caller's side, when our own call was
 *   hung up for us.
 *
 * The two notices are small, clear themselves, and wait while a ring is up:
 * the ring takes the same place on screen.
 */
export function IncomingCallOverlay() {
  const voice = useVoice();
  const sound = useSound();
  const client = useClient();
  const navigate = useNavigate();
  const slim = useSlimMode();
  const state = useState();
  const { t } = useLingui();

  // Channel id of the ring whose Accept was pressed here and is still
  // unlocking or joining. It is also what stops a second press.
  const [answering, setAnswering] = createSignal<string>();
  let answerSeq = 0;

  // The ring this popup's Decline took down, so an Accept of it that is
  // still on its way does not open the chat once it settles
  let declinedRing: IncomingCall | undefined;

  // The voice store's own "answer in flight", which also covers an Answer
  // from the keybind or the notification. It gets the same give-up time as a
  // press here, so an answer that never settles cannot hold a ring up for
  // good: past it, that channel's answer no longer counts as in flight.
  const [answerOverdue, setAnswerOverdue] = createSignal<string>();
  createEffect(() => {
    const channelId = voice.answeringChannelId();
    setAnswerOverdue(undefined);
    if (!channelId) return;
    const timer = setTimeout(
      () => setAnswerOverdue(channelId),
      ANSWER_GIVE_UP_MS,
    );
    onCleanup(() => clearTimeout(timer));
  });

  /** Whether an Answer of this channel's ring is still unlocking or joining */
  const answerInFlight = (channelId: string | undefined) =>
    channelId !== undefined &&
    (answering() === channelId ||
      (voice.answeringChannelId() === channelId &&
        answerOverdue() !== channelId));

  /** Whether Accept is unavailable for the ring on screen */
  const acceptBusy = () =>
    answering() !== undefined || answerInFlight(incomingCall()?.channel.id);

  /** The ring length, as the server gives it once known */
  const ringMs = () => ringDurationMs(serverCallRingSecs());

  /**
   * Stop the ringtone only when what sounds is an incoming ring. The sound
   * is shared with our own outgoing ring, which must keep playing for a call
   * we are making elsewhere, including where the incoming ring is the
   * phone's own and the app plays none.
   */
  function stopIncomingRingtone() {
    if (sound.ringtoneKind() === "incoming") sound.stopRingtone();
  }

  /** As above, and only while the ring on screen is this channel's. */
  function stopRingtoneOf(channelId: string) {
    if (incomingCall()?.channel.id === channelId) stopIncomingRingtone();
  }

  // Whether the phone's lock screen is up, as last asked. It decides the
  // full-screen ring, so every doubt reads as locked: an open question on
  // Android, a failed question anywhere.
  const [locked, setLocked] = createSignal(lockUnknown());
  let lockAsk = 0;

  /** Ask the phone again. Only the newest question may answer. */
  function askLocked() {
    const ask = ++lockAsk;
    Promise.resolve()
      .then(() => deviceLocked())
      .then(
        (answer) => {
          if (ask === lockAsk) setLocked(answer !== false);
        },
        () => {
          if (ask === lockAsk) setLocked(true);
        },
      );
  }

  /** Drop the last answer, and any question still on its way. */
  function forgetLocked() {
    lockAsk++;
    setLocked(lockUnknown());
  }

  // Ask when a ring or a "Call ended" notice appears. The last answer is
  // dropped first: it may be from before the phone was locked.
  createEffect(() => {
    if (!incomingCall() && !voice.callEndedNotice()) return;
    forgetLocked();
    askLocked();
  });

  // Ask again when the app comes back to the front, which is also what
  // happens when the screen wakes for a ring or the user gets past the lock
  // screen. The answer is dropped the moment the app is hidden, so a ring
  // that comes back on a phone locked in the meantime is covered at once
  // rather than after the phone has answered.
  onMount(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        forgetLocked();
      } else if (incomingCall() || voice.callEndedNotice()) {
        askLocked();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );
  });

  const fullScreen = () => locked() || slim();

  // Take the ring down when the ring window runs out with no answer. The
  // window is counted from when the ring started, so a re-run of this effect
  // does not start it over. It is not counted while an Answer of this ring
  // (from here, the keybind or the notification) is still unlocking or
  // joining: that is not an unanswered ring, and taking it down then would
  // report a missed call for a call the user is answering. Once the Answer
  // has its result this runs again, and a ring that outlived its window by
  // then goes at once.
  createEffect(() => {
    const call = incomingCall();
    if (!call) return;
    if (answerInFlight(call.channel.id)) return;
    const timer = setTimeout(
      () => {
        stopRingtoneOf(call.channel.id);
        dismissIncomingCall(call.channel.id, "timeout");
      },
      ringTimeLeft(call.receivedAt, ringMs()),
    );
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    if (!voice.callEndedNotice()) return;
    const timer = setTimeout(() => voice.dismissCallEndedNotice(), NOTICE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    if (!voice.callerRingNotice()) return;
    const timer = setTimeout(() => voice.dismissCallerRingNotice(), NOTICE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  /**
   * Accept: the voice store decides, unlocks, joins, and takes the ring down
   * itself once the join has landed. Nothing here dismisses the ring. It is
   * refused while an Answer is already on its way, from here or elsewhere.
   */
  async function accept() {
    const call = incomingCall();
    if (!call || acceptBusy()) return;

    const seq = ++answerSeq;
    setAnswering(call.channel.id);
    const giveUp = setTimeout(() => {
      if (seq === answerSeq) setAnswering(undefined);
    }, ANSWER_GIVE_UP_MS);

    // On a phone that reads as locked the Accept may stop at the unlock
    // prompt, and then the ring has to carry on as it was, sound included.
    // So the ringtone is only stopped at once where no unlock is coming.
    if (!locked()) stopRingtoneOf(call.channel.id);
    askLocked();

    let result: AnswerResult = "failed";
    try {
      result = await voice.answerCall(call.channel);
    } catch (error) {
      console.error(error);
    } finally {
      clearTimeout(giveUp);
      if (seq === answerSeq) setAnswering(undefined);
    }

    ringtoneAfterAnswer(call, result);
    if (result === "joined" && declinedRing !== call) {
      navigate(call.channel.path);
    }
    askLocked();
  }

  /**
   * The ringtone once an Accept pressed here has its result. Only this
   * ring's ringtone is touched: a ring for another call that came up in the
   * meantime keeps its own.
   */
  function ringtoneAfterAnswer(call: IncomingCall, result: AnswerResult) {
    const ring = incomingCall();
    switch (result) {
      case "unlock_cancelled":
        // The ring carries on as it was, sound included
        return;
      case "joined":
      case "ended":
        // The answer took this ring down itself, so an incoming ringtone
        // still sounding with no ring on screen is this ring's
        if (!ring || ring.channel.id === call.channel.id) {
          stopIncomingRingtone();
        }
        return;
      case "blocked":
        stopRingtoneOf(call.channel.id);
        return;
      case "failed":
        // The call may still be there to answer, so the ring stays up for
        // what is left of its window, and rings again where it rang before.
        // A ring declined or taken down meanwhile is no longer on screen,
        // and an outgoing ring that started meanwhile is left alone.
        if (ring !== call || sound.ringtoneKind() === "outgoing") return;
        if (
          ringTimeLeft(call.receivedAt, ringMs()) > 0 &&
          webRingtoneAllowed({
            provider: pushProvider(),
            unifiedPushRegistered: unifiedPushRegistered(),
            ringCalls:
              state.settings.getValue("notifications:ring_calls") !== false,
          })
        ) {
          sound.playSound("ringtoneIncoming");
        } else {
          stopIncomingRingtone();
        }
        return;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }

  /**
   * Decline. It stays available while an Answer of this ring is still on
   * its way; the voice store then drops that Answer, or ends the leg it
   * already joined.
   */
  function decline() {
    const call = incomingCall();
    if (!call) return;
    declinedRing = call;
    stopRingtoneOf(call.channel.id);
    voice.declineCall(call.channel).catch(console.error);
  }

  /**
   * Call back: an ordinary call start, never an answer. It is not offered
   * from a lock screen. The button is already hidden while the phone reads as
   * locked, and the phone is asked once more at the press in case that
   * answer is old.
   */
  async function callBack() {
    const notice = voice.callEndedNotice();
    if (!notice) return;

    let nowLocked = true;
    try {
      nowLocked = (await deviceLocked()) !== false;
    } catch (error) {
      console.error(error);
    }
    lockAsk++;
    setLocked(nowLocked);
    if (nowLocked) return;

    // The notice may have cleared itself or been replaced while we asked
    if (voice.callEndedNotice() !== notice) return;

    voice.connect(notice.channel).catch(console.error);
    voice.dismissCallEndedNotice();
  }

  const caller = () => incomingCall()?.caller;

  const callerName = () =>
    caller()?.displayName ?? caller()?.username ?? t`Incoming Call`;

  // Group calls: "{callerName} is calling in {channelName}" (existing msgid —
  // keep the identifier names so the macro reuses it); DMs: "Incoming Call"
  const groupSubtitle = () => {
    const call = incomingCall();
    if (!call || call.channel.type !== "Group") return undefined;
    const callerName = caller()?.displayName ?? caller()?.username ?? "?";
    const channelName = call.channel.name;
    return t`${callerName} is calling in ${channelName}`;
  };

  const groupName = () => {
    const call = incomingCall();
    return call?.channel.type === "Group" ? call.channel.name : undefined;
  };

  // A ring the caller started with video says so. Both wordings are strings
  // the app already had.
  const ringLabel = () =>
    incomingCall()?.video === true ? t`Video call` : t`Incoming Call`;

  // Whether an Answer of this ring is waiting at the lock screen
  const unlocking = () =>
    locked() && answerInFlight(incomingCall()?.channel.id);

  const popupSubtitle = () =>
    unlocking() ? t`Unlock to answer` : (groupSubtitle() ?? ringLabel());

  const coverLabel = () => (unlocking() ? t`Unlock to answer` : ringLabel());

  // With no known caller the name line already reads "Incoming Call", so the
  // label under it is only shown when it adds something.
  const coverLabelShown = () =>
    unlocking() || !!caller() || incomingCall()?.video === true;

  const callerOutcome = () => {
    const outcome = voice.callerRingNotice()?.outcome;
    switch (outcome) {
      case undefined:
        return undefined;
      case "no_answer":
        return t`No answer`;
      case "declined":
        return t`Declined`;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  };

  const callerNoticeName = () => {
    const notice = voice.callerRingNotice();
    return notice ? chatName(client()?.channels.get(notice.channelId)) : "";
  };

  // Portalled to <body>: mounted inside the app tree the popup was painted
  // UNDER the channel's "Join the voice channel" card despite z-index 9999 (an
  // ancestor stacking context traps it), which clipped the Decline button and
  // sent taps through to the message author behind it. A portal escapes every
  // ancestor stacking context so the ringing popup is always the top layer.
  return (
    <Portal>
      <Show when={incomingCall()}>
        <Show
          when={fullScreen()}
          fallback={
            <Popup role="alertdialog" aria-label={t`Incoming Call`}>
              <PulsingAvatar>
                <Avatar
                  size={48}
                  src={caller()?.animatedAvatarURL ?? caller()?.avatarURL}
                  fallback={callerName()}
                />
              </PulsingAvatar>
              <Details>
                <Name>{callerName()}</Name>
                <Subtitle aria-live="polite">{popupSubtitle()}</Subtitle>
              </Details>
              <Actions>
                <RingButtons
                  size="sm"
                  busy={acceptBusy()}
                  onAccept={accept}
                  onDecline={decline}
                />
              </Actions>
            </Popup>
          }
        >
          <Cover
            role="alertdialog"
            aria-modal="true"
            aria-label={t`Incoming Call`}
          >
            <PulsingAvatar>
              <Avatar
                size={96}
                src={caller()?.animatedAvatarURL ?? caller()?.avatarURL}
                fallback={callerName()}
              />
            </PulsingAvatar>
            <CoverName>{callerName()}</CoverName>
            <Show when={groupName()}>
              <CoverLine>{groupName()}</CoverLine>
            </Show>
            <Show when={coverLabelShown()}>
              <CoverLine aria-live="polite">{coverLabel()}</CoverLine>
            </Show>
            <CoverActions>
              <RingButtons
                size="lg"
                busy={acceptBusy()}
                onAccept={accept}
                onDecline={decline}
              />
            </CoverActions>
          </Cover>
        </Show>
      </Show>
      <Show
        when={
          !incomingCall() &&
          (voice.callEndedNotice() || voice.callerRingNotice())
        }
      >
        <Notices>
          <Show when={voice.callEndedNotice()}>
            {(notice) => (
              <Notice role="status">
                <Details>
                  <Show when={chatName(notice().channel)}>
                    <Name>{chatName(notice().channel)}</Name>
                  </Show>
                  <Subtitle>
                    <Trans>Call ended</Trans>
                  </Subtitle>
                </Details>
                <Actions>
                  <Show when={!locked()}>
                    <Button variant="filled" size="sm" onPress={callBack}>
                      <Symbol>call</Symbol> <Trans>Call back</Trans>
                    </Button>
                  </Show>
                  <Button
                    variant="text"
                    size="sm"
                    onPress={() => voice.dismissCallEndedNotice()}
                  >
                    <Trans>Dismiss</Trans>
                  </Button>
                </Actions>
              </Notice>
            )}
          </Show>
          <Show when={voice.callerRingNotice()}>
            <Notice role="status">
              <Details>
                <Show when={callerNoticeName()}>
                  <Name>{callerNoticeName()}</Name>
                </Show>
                <Subtitle>{callerOutcome()}</Subtitle>
              </Details>
              <Actions>
                <Button
                  variant="text"
                  size="sm"
                  onPress={() => voice.dismissCallerRingNotice()}
                >
                  <Trans>Dismiss</Trans>
                </Button>
              </Actions>
            </Notice>
          </Show>
        </Notices>
      </Show>
    </Portal>
  );
}

/**
 * The ring's two buttons, shared by the popup and the full-screen ring.
 * Accept cannot be pressed again while an Accept is being worked on; Decline
 * always can.
 */
function RingButtons(props: {
  size: "sm" | "lg";
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <>
      <Button
        variant="filled"
        size={props.size}
        isDisabled={props.busy}
        onPress={props.onAccept}
      >
        <Symbol>call</Symbol> <Trans>Accept</Trans>
      </Button>
      <Button variant="_error" size={props.size} onPress={props.onDecline}>
        <Symbol>call_end</Symbol> <Trans>Decline</Trans>
      </Button>
    </>
  );
}

const Popup = styled("div", {
  base: {
    position: "fixed",
    top: "48px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 9999,

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
    maxWidth: "min(420px, calc(100vw - 2 * var(--gap-lg)))",

    // Phone widths: the avatar and both buttons are flexShrink: 0, so all the
    // shrinking landed on the caller's name, which collapsed to a single
    // character ("P" over "I.") on a Galaxy S25 Ultra. Give the actions their
    // own full-width row instead of squeezing everything onto one line — it
    // also gives the ringing call the presence it should have on a phone.
    "@media (max-width: 560px)": {
      flexWrap: "wrap",
      width: "calc(100vw - 2 * var(--gap-lg))",
      maxWidth: "none",
      rowGap: "var(--gap-md)",
    },

    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.4)",

    animation: "slideIn 0.24s ease-out",
    "--translateY": "-64px",
  },
});

/**
 * The full-screen ring: over everything, edge to edge, and never see-through.
 *
 * The background is two layers on purpose. A theme can set the surface color
 * to anything, including a see-through or a broken value, and on a lock
 * screen whatever shows through is the user's chat. The solid color under it
 * does not depend on the theme, so the ring stays opaque whatever the theme
 * says. It is the same fallback color the app root uses.
 */
const Cover = styled("div", {
  base: {
    position: "fixed",
    inset: 0,
    zIndex: 9999,

    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-md)",
    paddingTop: "calc(env(safe-area-inset-top, 0px) + var(--gap-xl))",
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + var(--gap-xl))",
    paddingInline: "var(--gap-lg)",
    textAlign: "center",
    userSelect: "none",
    overflowY: "auto",

    color: "var(--md-sys-color-on-surface)",
    backgroundColor: "#05090F",
    backgroundImage:
      "linear-gradient(var(--md-sys-color-surface), var(--md-sys-color-surface))",
  },
});

const CoverName = styled("div", {
  base: {
    maxWidth: "100%",
    marginTop: "var(--gap-md)",
    fontSize: "1.5em",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const CoverLine = styled("div", {
  base: {
    maxWidth: "100%",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const CoverActions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-lg)",
    width: "min(360px, 100%)",
    marginTop: "var(--gap-xl)",
    flexShrink: 0,

    "& > *": {
      flex: 1,
    },
  },
});

/**
 * Where the two notices sit: the place the ring popup takes while a ring is
 * up, which is why they wait for it.
 */
const Notices = styled("div", {
  base: {
    position: "fixed",
    top: "48px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 9999,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    width: "max-content",
    maxWidth: "min(420px, calc(100vw - 2 * var(--gap-lg)))",

    "@media (max-width: 560px)": {
      width: "calc(100vw - 2 * var(--gap-lg))",
      maxWidth: "none",
    },
  },
});

const Notice = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm) var(--gap-md) var(--gap-sm) var(--gap-lg)",

    // Same wrap as the ring popup: on a phone the buttons get their own row
    "@media (max-width: 560px)": {
      flexWrap: "wrap",
      rowGap: "var(--gap-sm)",
    },

    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.4)",
  },
});

const PulsingAvatar = styled("div", {
  base: {
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    flexShrink: 0,
    animation: "incomingCallPulse 1.6s ease-out infinite",
  },
});

const Details = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    // `flex: 1` is the load-bearing half: minWidth 0 alone only grants
    // PERMISSION to shrink past the content, and with both neighbours refusing
    // to shrink this was the only element that could, so it took all of it.
    flex: 1,
    minWidth: 0,
  },
});

const Name = styled("div", {
  base: {
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const Subtitle = styled("div", {
  base: {
    fontSize: "0.8em",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    flexShrink: 0,

    // Wrapped onto their own row on phones: split the width evenly so Accept
    // and Decline are full-size targets rather than two corner chips.
    "@media (max-width: 560px)": {
      flexBasis: "100%",
      "& > *": {
        flex: 1,
      },
    },
  },
});

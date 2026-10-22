import {
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Portal } from "solid-js/web";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import { REMOTE_CONTROL_CLAIM, isPanicCombo, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button } from "@revolt/ui/components/design";
import { VoiceGiveControlPanel } from "./VoiceGiveControlButton";
import { VoicePassControlPanel } from "./VoicePassControlPanel";

/**
 * The two remote-control surfaces that are not the sharer's own panel: the
 * inbound offer prompt, and the controller's status while driving.
 *
 * Mounted once alongside the call card. Both are deliberately plain — an
 * offer is an OFFER, not a warning: nothing of the target's is at risk, and
 * dressing it as dangerous is exactly how people are trained to dismiss the
 * prompt that does matter (the sharer's, which is native).
 */
export function RemoteControlOverlays() {
  const voice = useVoice();
  const client = useClient();
  const state = useState();
  const { t } = useLingui();
  const rc = voice.remoteControl;

  /**
   * The controller's push-to-talk key is held back from the sharer (see the
   * reservation in `RemoteControlCapture`), and while push-to-talk is ON that
   * is a real, unavoidable hole in what you can type — the key belongs to the
   * microphone. Say so rather than swallowing it silently: the DEFAULT key is
   * Space, and a controller who cannot type spaces with no explanation reads
   * the whole feature as broken.
   */
  const pttReserved = () => state.voice.pushToTalk;
  /** `KeyV` → `V`, `Space` → `Space`. Mirrors the settings screen's label. */
  const pttKeyLabel = () => state.voice.pushToTalkKey.replace(/^Key/, "");

  // The focused-window panic handler. `RegisterHotKey` in the shell already
  // covers the focused case on the SHARER'S machine, so this is
  // belt-and-braces there — but it is the only path that survives the combo
  // being owned by another process, and on the CONTROLLER'S machine no
  // hotkey is registered at all, so this is the primary path.
  //
  // It calls the native `rc_panic_local` rather than keeping the revoke in
  // renderer state: renderer state is what a compromised renderer controls,
  // and a kill switch is the last thing that should live there.
  //
  // `isPanicCombo` — the ONE combo predicate, shared with the capture
  // surface's forwarding suppression so a rebind can never update one and
  // miss the other again (the 08-02 rebind did exactly that). It matches
  // `key` OR `code`: `key` follows the keyboard layout (agreeing with the
  // native VK-based paths) but held modifiers can remap it; `code` is the
  // physical QWERTY-Q position. Firing on either is fail-safe — this
  // handler can only ever stop control.
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPanicCombo(event)) {
        event.preventDefault();
        void rc.panic();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  // Poll native while anything is live, so the sharer's panel can say
  // "control appears frozen" from native facts rather than from hope.
  onMount(() => {
    const timer = setInterval(() => {
      if (rc.sharing() || rc.controlling()) void rc.refreshStatus();
    }, 1000);
    onCleanup(() => clearInterval(timer));
  });

  // Portalled and mounted at APP level (the `IncomingCallOverlay` precedent),
  // NOT inside the call card. Everything here is a stop affordance — the
  // panic handler, "take back control", "release control", the §5(C)
  // calibration prompt, the offer prompt — and mounting it inside
  // `VoiceCallCardActiveRoom` meant every one of them vanished the moment the
  // user browsed to another channel and the card flipped to PiP. A live
  // session you can no longer see or stop because you clicked a channel is
  // the worst shape this feature can take.
  // `ENABLE_VIDEO` for the same reason every other screenshare affordance
  // carries it: remote control is an attachment to a screen share, so on a
  // deployment without video none of these surfaces can have anything to
  // describe. Belt-and-braces rather than load-bearing — an offer cannot
  // exist without a share to attach to — but the checklist gate is cheap and
  // its absence is the kind of thing that quietly becomes wrong later.
  return (
    <Show when={CONFIGURATION.ENABLE_VIDEO}>
      <Portal ref={document.getElementById("floating")! as HTMLDivElement}>
        <Stack>
          <Show when={rc.offer()}>
            {(offer) => <OfferPrompt offer={offer()} />}
          </Show>
          <ControllerPanel />
        </Stack>
        {/* The SHARER'S panel lives in its own stack, pushed below the strip
            of screen the native indicator occupies. The indicator (420×62,
            always-on-top, pinned top-centre of the DISPLAY) landed exactly on
            top of this panel whenever the app was maximized — two overlapping
            "who is controlling / how to stop" surfaces, both truncating. The
            indicator is the trust anchor and cannot move (its watchdog treats
            "not visible" as a revoke condition), so the renderer panel is the
            one that yields. The offset covers the maximized case the collision
            was observed in; an unmaximized window under the indicator is a
            window arrangement no fixed offset can solve. */}
        <SharerStack>
          <VoiceGiveControlPanel />
          {/* The rotation panel is a SIBLING, not a child of the picker: the
              picker's subtree is gated on `canOffer()`, which requires
              `!rc.sharing()`, so it unmounts the moment a session goes
              active — exactly when passing the controller becomes possible.
              Both are sharer-only by construction (`rc.sharing()` is only
              ever set on the machine being controlled). */}
          <VoicePassControlPanel />
        </SharerStack>
      </Portal>
    </Show>
  );

  function OfferPrompt(props: {
    offer: NonNullable<ReturnType<typeof rc.offer>>;
  }) {
    const sharer = useUser(props.offer.sharerId);
    const name = () => sharer()?.username ?? props.offer.sharerId;

    async function respond(accept: boolean) {
      const api = client();
      const self = api?.user?.id;
      if (!api || !self) return;
      await rc.respondToOffer({
        apiBase: api.options.baseURL,
        authHeader: api.authenticationHeader as [string, string],
        offer: props.offer,
        // THIS DEVICE'S OWN id, never `target_id` from the event, even
        // though every other field here does come from it. That field is
        // server-asserted; echoing it back would let the server supply both
        // halves of the key transcript, and a redirected session would then
        // derive, authenticate and run silently under a name the sharer
        // never picked.
        localUserId: self,
        sharerName: name(),
        accept,
      });
    }

    return (
      <Sheet>
        {/* Interpolated through `t`, with NO JSX inside the message. Writing
            this as `<Trans>{name()} is giving you…</Trans>` renders the text
            THREE TIMES — it passes tsc, extract and compile in silence and is
            visible only in a browser. */}
        <Heading>{t`${name()} is giving you control of their screen`}</Heading>
        <Muted>
          <Trans>
            Your mouse and keyboard will be sent to their computer while the
            session lasts. Nothing on your computer is shared.
          </Trans>
        </Muted>
        <Row>
          <Button size="sm" variant="filled" onPress={() => respond(true)}>
            <Trans>Accept</Trans>
          </Button>
          <Button size="sm" variant="text" onPress={() => respond(false)}>
            <Trans>Decline</Trans>
          </Button>
        </Row>
      </Sheet>
    );
  }

  /**
   * The controller's own status. The hard rule here is what it must NOT say.
   *
   * There is no authenticated feedback channel in v1 — the sharer→controller
   * key is derived and immediately discarded, and the SFU grant covers the
   * controller identity only, so a reply packet would be dropped by the SFU
   * anyway. Nothing this client can observe substantiates "you are in
   * control". So there is no green state: the strongest honest claim is
   * "your input is being sent", and the video feed is the real signal.
   *
   * `secure_desktop` / `foreground_elevated` from `rc_status` are NOT used
   * here. They describe whichever machine ran the call — on a controller
   * that is the controller's own desktop, so wiring a "frozen" banner to
   * them is wrong in both directions: the sharer hitting a UAC prompt does
   * not set them, and the controller opening one sets them while the
   * sharer's session is perfectly healthy.
   */
  function ControllerPanel() {
    const [showCode, setShowCode] = createSignal(false);
    // Once input is flowing, everything below the heading is onboarding the
    // controller has already read, and it sits on top of the very screen they
    // are supposed to be watching. Collapse to a compact bar and put the exit
    // FIRST; `Details` brings the full stack back.
    //
    // Only the ACTIVE phase collapses. `waiting` is pre-consent — the reader
    // has not acted yet and may still back out — so it keeps every word.
    const [expanded, setExpanded] = createSignal(false);
    const compact = (phase: string) => phase === "active" && !expanded();
    return (
      <Show when={rc.controlling()}>
        {(session) => (
          <Sheet>
            <Switch>
              <Match when={session().phase === "waiting"}>
                <Heading>
                  <Trans>Waiting for them to confirm on their machine</Trans>
                </Heading>
                <Muted>
                  <Trans>
                    Your input is not being delivered yet. They have to answer a
                    prompt from their operating system first.
                  </Trans>
                </Muted>
              </Match>
              <Match when={session().phase === "active"}>
                <Heading>
                  <Trans>Your input is being sent</Trans>
                </Heading>
                {/* The keyboard-mode signal the live matrix found missing:
                    while focus sits in one of THIS client's own editables the
                    capture surface keeps keys local (see `onFocusIn` there),
                    and without a line saying so, keys "not reaching the other
                    machine" reads as the feature breaking. Shown in compact
                    mode too — that is when the user is typing. */}
                <Show when={rc.localTyping()}>
                  <Muted>
                    <Trans>
                      You are typing locally. Click the shared screen to send
                      keys to their computer.
                    </Trans>
                  </Muted>
                </Show>
                {/* Interpolated through `t` with NO JSX inside — a nested
                    element here renders the sentence three times. */}
                <Show when={pttReserved()}>
                  <Muted>
                    {t`Push-to-talk is on, so ${pttKeyLabel()} stays on your computer and is not sent.`}
                  </Muted>
                </Show>
                <Show when={!compact(session().phase)}>
                  <Muted>
                    <Trans>
                      Watch their screen to see whether it is landing. Their
                      computer can silently ignore input on system prompts and
                      on windows with higher privileges, and they can take
                      control back at any time.
                    </Trans>
                  </Muted>
                </Show>
              </Match>
            </Switch>
            <Muted>{session().sharerName}</Muted>

            {/* Exit FIRST once control is live. The old order buried
                `Release control` under the resize row, the click-through
                note, Verify and the full claim — so the one control that
                stops the session was the furthest thing from the reader,
                on a panel that covers the screen they are watching. */}
            <Show when={compact(session().phase)}>
              <Row>
                <Button
                  size="sm"
                  variant="_error"
                  onPress={() => rc.endControlling("controller_released")}
                >
                  <Trans>Release control</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="text"
                  onPress={() => setExpanded(true)}
                >
                  <Trans>Details</Trans>
                </Button>
              </Row>
            </Show>

            <Show when={!compact(session().phase)}>
              {/* §1.8d — SIZE THE TILE FROM HERE, because you cannot size it
                from the tile.

                The capture `Surface` is `zIndex: 20` over the whole tile so
                that a remote click cannot hit Sloga's own chrome — every
                overlay it covers used to be a dead zone, and the theater one
                actively EXITED theater mode. The unhandled consequence was
                the mirror image: once control starts the controller is
                frozen at whatever size they had, with the expand button
                silently unresponsive and nothing saying why.

                🔴 The fix must NOT be to lower that z-index; it would put
                every dead zone back. This panel is portalled to `#floating`
                at `zIndex: 200`, outside the call card's stacking context
                entirely, so a click here never traverses the tile — which is
                the "bind tile sizing to a controller-side action" direction
                rather than the "exempt an in-tile affordance" one.

                Both actions are exactly what the call card's own two buttons
                do, in the order a user would press them, so this introduces
                no state the app could not already reach. `toggleFullscreen
                (false)` drops immersive on its way out, so one call restores
                both. Message ids are reused from those buttons deliberately:
                `lingui extract` does not run in this tree. */}
              <Row>
                <Show
                  when={voice.immersive()}
                  fallback={
                    <Button
                      size="sm"
                      variant="tonal"
                      onPress={() => {
                        voice.toggleFullscreen(true);
                        voice.toggleImmersive(true);
                      }}
                    >
                      <Trans>Maximize & hide participants</Trans>
                    </Button>
                  }
                >
                  <Button
                    size="sm"
                    variant="tonal"
                    onPress={() => voice.toggleFullscreen(false)}
                  >
                    <Trans>Exit theater mode</Trans>
                  </Button>
                </Show>
              </Row>
              <Muted>
                <Trans>
                  Clicks on the shared screen go to their computer, so Sloga's
                  own buttons over the video will not respond. Resize from here
                  instead.
                </Trans>
              </Muted>

              <Show when={session().sas}>
                <Button
                  size="sm"
                  variant="text"
                  onPress={() => setShowCode((was) => !was)}
                >
                  <Trans>Verify</Trans>
                </Button>
                <Show when={showCode()}>
                  <Code>{session().sas}</Code>
                  <Muted>
                    <Trans>
                      Read this aloud. If it does not match the code on their
                      screen, stop — someone may be intercepting the connection.
                    </Trans>
                  </Muted>
                </Show>
              </Show>

              <Claim>{REMOTE_CONTROL_CLAIM}</Claim>
              <Row>
                <Button
                  size="sm"
                  variant="_error"
                  onPress={() => rc.endControlling("controller_released")}
                >
                  <Trans>Release control</Trans>
                </Button>
                {/* "Hide" and "Details" are both EXISTING msgids, reused
                    deliberately. A new one needs a sorted insertion into
                    en + en-US `.po` and `lingui extract` is destructive in
                    this tree — not worth it for a disclosure toggle. */}
                <Show when={session().phase === "active"}>
                  <Button
                    size="sm"
                    variant="text"
                    onPress={() => setExpanded(false)}
                  >
                    <Trans>Hide</Trans>
                  </Button>
                </Show>
              </Row>
            </Show>
          </Sheet>
        )}
      </Show>
    );
  }
}

const Sheet = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    maxWidth: "420px",
  },
});

/**
 * Fixed to the top-centre of the viewport, above the call card's own float
 * layer. These panels must be reachable from anywhere in the app, so they
 * cannot be laid out inside anything that scrolls or unmounts with a route.
 * Kept below the desktop main window's own title bar (`--titlebar-height`,
 * 0 without one), which paints over everything else at the top edge.
 */
const Stack = styled("div", {
  base: {
    position: "fixed",
    top: "calc(var(--gap-lg) + var(--titlebar-height, 0px))",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 200,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    alignItems: "center",
    pointerEvents: "none",
    "& > *": { pointerEvents: "auto" },
  },
});

/**
 * Same fixed top-centre placement as `Stack`, offset below the native
 * indicator's band: 62px of window plus its margins. Only the sharer's panel
 * lives here — the offer prompt and controller panel render on machines with
 * no indicator, so they keep the top edge.
 */
const SharerStack = styled("div", {
  base: {
    position: "fixed",
    top: "calc(var(--gap-lg) + 78px)",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 200,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    alignItems: "center",
    pointerEvents: "none",
    "& > *": { pointerEvents: "auto" },
  },
});

const Heading = styled("div", { base: { fontWeight: 600 } });
const Muted = styled("div", { base: { fontSize: "0.85em", opacity: 0.75 } });
const Claim = styled("div", { base: { fontSize: "0.75em", opacity: 0.6 } });
const Row = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" },
});
const Code = styled("div", {
  base: {
    fontFamily: "var(--monospace-font), monospace",
    fontSize: "1.05em",
    letterSpacing: "0.06em",
    userSelect: "text",
  },
});

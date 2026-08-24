import { onCleanup, onMount } from "solid-js";

import { styled } from "styled-system/jsx";

import {
  classifyKey,
  isEditableTarget,
  isPanicCombo,
  normalizeToContentBox,
  useVoice,
  wheelNotches,
} from "@revolt/rtc";
import { useState } from "@revolt/state";

/**
 * The controller's capture surface: a transparent layer over a screen-share
 * tile that turns local pointer and keyboard input into events for the
 * sharer's machine.
 *
 * # Stacking — this is the whole reason the component exists separately
 *
 * `ParticipantTile` renders `<Overlay showOnHover>` at `gridArea: "1/1"`
 * with no `pointer-events: none` and no `z-index`. Both are grid items of a
 * `display: grid` tile at `position: static`, so a capture div placed as a
 * plain sibling AFTER `<VideoTrack>` paints below `Overlay` and hit-tests
 * below it too — across the ENTIRE tile, not just the visible bottom strip.
 * The symptom is the nastiest kind: control looks granted, the sharer's
 * indicator lights up, and nothing moves.
 *
 * The fix is a `zIndex` on the surface — 20, cleared against every overlay
 * the call card paints; the full comparison table lives on `Surface` below.
 * Deliberately NOT `pointerEvents: "none"` on `Overlay` — that is the obvious fix and it
 * silently kills the `use:floating` tooltip on the muted-participant icon
 * for every tile in every call, which is a real regression bought for
 * nothing since `z-index` alone is sufficient. `ParticipantCaption` already
 * proves the pattern (`pointerEvents: none` + `zIndex: 5` on a static grid
 * item beats `Overlay`).
 *
 * The surface is mounted ONLY while a session is armed, so hover chrome and
 * click-to-focus behave exactly as before outside one.
 */
export function RemoteControlCapture(props: {
  video?: HTMLVideoElement;
  /** Intrinsic video dimensions, from the tile's own `on:resize`. */
  videoDims: () => { width: number; height: number };
  /**
   * The sharer's FULL LiveKit identity (device-qualified since media E2EE),
   * used to scope `publishData` fan-out. Not the bare user id — the SFU
   * routes by identity.
   */
  sharerIdentity: string;
}) {
  const voice = useVoice();
  const state = useState();
  const rc = voice.remoteControl;
  let surface: HTMLDivElement | undefined;
  /**
   * §3's TEXT path needs an editable element: `beforeinput` and composition
   * events only ever fire on one, and they are the only source of textual
   * intent — a scan code resolves through the SHARER'S layout (QWERTY `KeyZ`
   * types `w` on AZERTY) and can never produce an accent, a dead-key
   * composition or an IME candidate. This invisible input is kept focused
   * while capturing; printable keydowns are deliberately NOT
   * `preventDefault`ed so the browser turns them into `beforeinput` here
   * (and IME composition into `compositionend`), which is forwarded as a
   * `text` event and injected natively via `KEYEVENTF_UNICODE`.
   */
  let textSink: HTMLInputElement | undefined;
  /**
   * One-shot: the controller's reserved push-to-talk key was pressed and
   * would also produce a character through the sink. The reservation has to
   * hold on BOTH paths, and `beforeinput` cannot see `event.code`.
   */
  let skipNextInsert = false;
  /**
   * Last pointer position INSIDE the content box, normalized. A button-up
   * delivered outside the picture (pointer capture keeps delivering after
   * the pointer leaves) is sent here rather than at a made-up coordinate.
   */
  let lastAt: { x: number; y: number } | undefined;
  /**
   * True only for the instant we release pointer capture ourselves, so the
   * `lostpointercapture` that follows is not mistaken for the browser taking
   * capture away — see `onLostPointerCapture`.
   */
  let selfReleasingCapture = false;
  /**
   * Keyboard forwarding is SUSPENDED: focus is genuinely inside one of the
   * controller's own editables (their composer, a search field), so
   * keystrokes stay local. The live matrix found the always-forward design's
   * failure mode — text aimed at the controller's own chat box delivered
   * silently into whatever had focus on the sharer's machine, which with a
   * password is a security problem, and nothing on screen said so.
   *
   * Maintained by `focusin` (fires on every focus change, composed, so a
   * shadow-DOM field still reports) rather than re-derived per keystroke.
   * Entering suspension releases everything held on the sharer — the user
   * may be mid-chord, and a modifier left down on someone else's machine
   * turns their every keystroke into an accelerator.
   */
  let suspended = false;

  /**
   * Map a client point to normalized `[0,1]` coordinates of the video's
   * CONTENT BOX.
   *
   * `object-fit: contain` letterboxes: a 16:9 stream in a non-16:9 tile has
   * bars that are part of the element rect but not part of the picture. A
   * naive `(clientX - rect.left) / rect.width` is both offset and mis-scaled,
   * and every click lands systematically tens to hundreds of pixels off —
   * which feels BROKEN rather than laggy, and is the failure most likely to
   * be blamed on the network.
   *
   * `getBoundingClientRect()` is re-read per event rather than cached: the
   * tile transitions `max-width` and `aspect-ratio` over 300 ms on a focus
   * toggle, and the whole call card transitions `transform`/`width` when it
   * docks, so a rect captured at either moment is wrong for a third of a
   * second. Reading it per event is a few microseconds against a ~5 ms IPC
   * floor.
   *
   * Returns `undefined` outside the content box — rejecting is correct,
   * extrapolating would send the sharer's pointer somewhere nobody pointed.
   */
  function normalize(event: { clientX: number; clientY: number }) {
    const element = props.video ?? surface;
    if (!element) return undefined;
    // The maths lives in `normalizeToContentBox` (pure, unit-tested). Only
    // the rect read stays here, and it is deliberately PER EVENT rather than
    // cached: the tile transitions `max-width` and `aspect-ratio` over 300 ms
    // on a focus toggle, and the whole call card transitions
    // `transform`/`width` when it docks, so a rect captured at either moment
    // is wrong for a third of a second. Reading it costs a few microseconds
    // against a ~5 ms IPC floor.
    return normalizeToContentBox(
      element.getBoundingClientRect(),
      props.videoDims(),
      event,
    );
  }

  /**
   * Sloga's own behaviours hijack remote input, and `preventDefault` does not
   * help: per spec it suppresses compat mouse events but NOT `click` or
   * `contextmenu`. Two ancestors are the problem — the tile's own
   * `onClick={() => voice.toggleFocus(track)}` (Solid delegates it at
   * `document`, and bails on `cancelBubble`, so stopping propagation here is
   * enough) and `use:floating`'s bubble-phase `contextmenu` listener, which
   * would otherwise open Sloga's user context menu over the controlled
   * desktop on every remote right-click.
   *
   * Capture phase, so it runs before either.
   */
  function swallow(event: Event) {
    event.stopPropagation();
    event.preventDefault();
  }

  const MOUSE_BUTTONS: Record<number, number> = {
    0: 0, // left
    2: 1, // right
    1: 2, // middle
    3: 3, // x1
    4: 4, // x2
  };

  function onPointerDown(event: PointerEvent) {
    swallow(event);
    const at = normalize(event);
    if (!at) return;
    lastAt = at;
    // Focus the TEXT SINK, not the surface: keyboard forwarding is
    // window-level either way, but only a focused editable turns printable
    // keys into the `beforeinput`/composition events the text path rides.
    textSink?.focus({ preventScroll: true });
    // A drag that leaves this small tile would otherwise deliver `pointerup`
    // to whatever is underneath, leaving the sharer's mouse button
    // PHYSICALLY DOWN and rubber-band-selecting their desktop indefinitely.
    try {
      surface?.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort; the release-all paths below are the guarantee */
    }
    const button = MOUSE_BUTTONS[event.button];
    if (button === undefined) return;
    rc.queue({ kind: "button", button, down: true, ...at });
  }

  function onPointerUp(event: PointerEvent) {
    swallow(event);
    const at = normalize(event);
    if (at) lastAt = at;
    const button = MOUSE_BUTTONS[event.button];
    if (button === undefined) return;
    // Every button packet carries its own absolute coordinates, so a click is
    // always positioned by its own packet and never by a stale lossy move.
    // If the release happened outside the content box, still send the "up" —
    // at the LAST IN-BOX position — because a missing "up" is far worse than
    // one landing a few pixels off. Pointer capture keeps delivering events
    // after the pointer leaves the picture, so this is the ordinary end of
    // any drag that overshoots: falling back to (0.5, 0.5) would release at
    // the CENTRE OF THE SHARER'S SCREEN and drop whatever was being dragged
    // onto whatever happens to be there.
    const release = at ?? lastAt;
    rc.queue({
      kind: "button",
      button,
      down: false,
      x: release?.x ?? 0.5,
      y: release?.y ?? 0.5,
    });
    try {
      // Our own release fires `lostpointercapture`. Flag it, or every single
      // click would be followed by a release-all — see `onLostPointerCapture`.
      selfReleasingCapture = true;
      surface?.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    } finally {
      selfReleasingCapture = false;
    }
  }

  function onPointerMove(event: PointerEvent) {
    const at = normalize(event);
    if (!at) return;
    lastAt = at;
    rc.queue({ kind: "move", ...at });
  }

  /**
   * Losing pointer capture to something OTHER than our own release — the
   * browser revoking it, the element being removed — means the pointer is
   * gone with buttons possibly still down, so everything held goes up.
   *
   * `onPointerUp` releases capture itself on every ordinary click, and that
   * fires this event too. Without the flag, a Shift+click range selection on
   * the sharer's machine would raise Shift after the first click and only
   * re-latch on the controller's OS key-repeat — if their configuration
   * repeats at all.
   */
  function onLostPointerCapture() {
    if (selfReleasingCapture) return;
    releaseAll();
  }

  let wheelRemainderX = 0;
  let wheelRemainderY = 0;

  function onWheel(event: WheelEvent) {
    swallow(event);
    const at = normalize(event);
    if (!at) return;
    lastAt = at;
    // `deltaY` is INVERTED on the way out. DOM positive means "content moves
    // down"; `MOUSEEVENTF_WHEEL` positive means "wheel rotated forward, away
    // from the user", which scrolls the other way. `deltaX` needs no flip —
    // DOM positive and `MOUSEEVENTF_HWHEEL` positive are both rightward.
    const x = wheelNotches(event.deltaX, event.deltaMode, wheelRemainderX);
    const y = wheelNotches(-event.deltaY, event.deltaMode, wheelRemainderY);
    wheelRemainderX = x.carry;
    wheelRemainderY = y.carry;
    // Nothing whole yet — the carry is holding it. A zero-delta wheel packet
    // would cost a round trip to move nothing.
    if (x.whole === 0 && y.whole === 0) return;
    rc.queue({
      kind: "wheel",
      ...at,
      deltaX: x.whole,
      deltaY: y.whole,
    });
  }

  /** Everything held goes up. Bound to every way focus or the pointer can be lost. */
  function releaseAll() {
    rc.queue({ kind: "releaseAll" });
  }

  /**
   * Only HIDING is a release condition. `visibilitychange` fires in both
   * directions, and releasing on becoming visible again would raise
   * everything the controller is holding the moment they come back to the
   * tab — including a modifier they are mid-chord on.
   */
  function onVisibilityChange() {
    if (document.hidden) releaseAll();
  }

  /**
   * Focus moved somewhere. Suspend forwarding while it sits in a local
   * editable; resume the moment it leaves for anything else — the surface, a
   * button, `body` after a stray blur. Stray focus loss therefore still
   * forwards (the reason the original design bound to `window` at all); only
   * a deliberate focus into a field the user can type into keeps keys local.
   */
  function onFocusIn(event: FocusEvent) {
    const target = event.composedPath()[0];
    if (target === textSink) {
      suspended = false;
      rc.setLocalTyping(false);
      return;
    }
    const local = isEditableTarget(target);
    if (local && !suspended) releaseAll();
    suspended = local;
    rc.setLocalTyping(local);
  }

  function onKey(event: KeyboardEvent, down: boolean) {
    // THE PANIC COMBO IS NEVER FORWARDED. On the sharer's machine
    // `RegisterHotKey` withholds it from the focused app entirely, but on the
    // CONTROLLER'S machine no hotkey is registered — the lease belongs to the
    // injector — so without this the kill switch would be typed at the person
    // whose machine is at risk instead of stopping the session.
    //
    // Only SUPPRESSED here; the app-level handler in `RemoteControlOverlays`
    // is the one that acts, so the two do not both fire for one press.
    // Shared predicate — the 08-02 rebind left this check on the OLD combo
    // while the overlays handler moved to Q, which is exactly the drift the
    // predicate exists to prevent.
    if (isPanicCombo(event)) {
      return;
    }

    // Focus is in one of the controller's OWN editables — the keystroke is
    // local, and it must both act locally (no preventDefault) and reach
    // Sloga's own handlers (no stopPropagation). Held keys were released on
    // the way in, so there is no remote chord to finish.
    if (suspended) {
      return;
    }

    // RESERVE THE CONTROLLER'S OWN PUSH-TO-TALK KEY. `ptt.rs` arms a GLOBAL
    // hook that fires regardless of focus, so without this a controller whose
    // PTT key is `KeyV` opens their own microphone *and* types `v` on the
    // sharer's machine.
    //
    // Two halves, and the second is easy to miss: do not forward it, and do
    // NOT swallow it either. The focused-window PTT listeners live on
    // `window` in the bubble phase and are the fallback whenever native
    // arming failed, so stopping propagation here would silently kill the
    // controller's own microphone.
    //
    // 🔴 GATED ON PUSH-TO-TALK BEING ON, since the 08-04 live matrix. This was
    // deliberately unconditional ("the setting can flip mid-session and the
    // native arm is lazy") and the cost was catastrophic in the default
    // configuration: `pushToTalkKey` defaults to **"Space"** while
    // `pushToTalk` defaults to **false** (`stores/Voice.ts`), so on a stock
    // install EVERY SPACE the controller typed was swallowed and the sharer
    // received words run together — observed live, and invisible to the
    // 08-03 evidence because that was a keystroke COUNT, not the text.
    // Reserving it while PTT is off protects nothing: both PTT listeners
    // (`rtc/state.tsx`) return early on the same flag, so the key does not
    // touch the microphone either. The mid-session-flip worry does not need
    // an unconditional reservation — this is a reactive store read evaluated
    // per keystroke, so a flip is honoured on the very next press, and the
    // lazy native arm only ever happens on a press while PTT is ON.
    if (state.voice.pushToTalk && event.code === state.voice.pushToTalkKey) {
      // A printable PTT key would still reach the sharer through the sink's
      // `beforeinput` — flag the insertion for suppression there. Only when
      // it is actually going to produce one, or the flag would swallow the
      // next legitimate character instead.
      skipNextInsert =
        down &&
        classifyKey({
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          altGraph: event.getModifierState("AltGraph"),
        }) === "text";
      return;
    }

    // Composition machinery owns these events: a scan code forwarded
    // mid-composition double-types on the sharer, and `preventDefault` here
    // would abort the very composition the text path exists to deliver.
    // `compositionend` below is where the result comes out.
    if (event.isComposing || event.key === "Dead" || event.key === "Process") {
      return;
    }

    // §3: two paths, decided per event. TEXT keys are left alone (no
    // preventDefault — that would suppress the `beforeinput` they exist to
    // become) and are NOT forwarded as scan codes; SCAN keys — control,
    // navigation, modifiers, accelerator chords — are swallowed and
    // forwarded positionally. `stopPropagation` on both, so Sloga's own
    // delegated handlers never react to remote-bound input.
    const path = classifyKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      altGraph: event.getModifierState("AltGraph"),
    });
    if (path === "text") {
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    rc.queue({ kind: "key", code: event.code, down, repeat: event.repeat });
  }

  /**
   * The text path's delivery point. Window-level capture like the key
   * handlers — focus can drift off the sink, and wherever a printable lands
   * while a session is live, it is remote-bound, not local.
   */
  function onBeforeInput(event: InputEvent) {
    // Local typing — the text belongs to the controller's own field.
    if (suspended) return;
    // Mid-composition updates are mutable — the candidate can change until
    // commit — and are not cancelable in Chromium anyway. `compositionend`
    // forwards the final text exactly once.
    if (event.inputType === "insertCompositionText") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.inputType !== "insertText" || !event.data) return;
    if (skipNextInsert) {
      skipNextInsert = false;
      return;
    }
    // Native refuses a WHOLE batch whose text run exceeds MAX_TEXT_LEN
    // (1024 bytes) — clamp far below it. A single beforeinput carries one
    // keystroke's worth of text; anything longer is not typing.
    rc.queue({ kind: "text", text: event.data.slice(0, 256) });
  }

  function onCompositionEnd(event: CompositionEvent) {
    // A composition committed into a local editable stays local.
    if (suspended) return;
    // The committed composition accumulated in the sink (insertCompositionText
    // is not cancelable) — clear it so the next composition starts clean.
    if (textSink) textSink.value = "";
    if (!event.data) return;
    rc.queue({ kind: "text", text: event.data.slice(0, 256) });
  }

  onMount(() => {
    if (!surface) return;
    // The generation this surface owns. Toggling focus swaps the tile between
    // two different `TrackLoop`s and Solid mounts the replacement BEFORE
    // disposing the original, so without a generation the outgoing tile's
    // cleanup would tear down the incoming tile's live capture — leaving a
    // fully-wired surface that silently discards every event.
    const generation = rc.startCapture(props.sharerIdentity);
    // Capture phase on the surface itself for the pointer events, so the
    // ancestors' delegated handlers never see them.
    surface.addEventListener("pointerdown", onPointerDown as never, true);
    surface.addEventListener("pointerup", onPointerUp as never, true);
    surface.addEventListener("pointermove", onPointerMove as never, true);
    surface.addEventListener("wheel", onWheel as never, {
      capture: true,
      passive: false,
    });
    surface.addEventListener("click", swallow, true);
    surface.addEventListener("contextmenu", swallow, true);
    surface.addEventListener("dblclick", swallow, true);
    surface.addEventListener("auxclick", swallow, true);

    const keydown = (event: KeyboardEvent) => onKey(event, true);
    const keyup = (event: KeyboardEvent) => onKey(event, false);
    // On `window`, capture phase: the surface can lose DOM focus (a click on
    // call chrome, a Solid remount) and keyboard events then target `body`.
    // The `keybindFilter` suppression covers correctness for Sloga's own
    // keybinds regardless; this is what actually forwards the keystrokes.
    //
    // RECORDED DECISION, revised after the 08-03 live matrix (supersedes
    // plan §6's "the keyboard belongs to the remote machine while this
    // surface is mounted"): forwarding stays window-level — a STRAY focus
    // change (call chrome click, Solid remount, focus on `body`) still
    // forwards, which is what the original decision existed to protect —
    // but focus genuinely inside one of the controller's own editables
    // suspends it (`onFocusIn`). The matrix observed the old trade's cost:
    // text typed into the controller's own chat box delivered silently into
    // an unrelated app on the sharer's machine; swap the message for a
    // password and it is a credential leak. Entering suspension releases
    // everything held remotely, so no chord is left down; the mode is
    // surfaced on the controller panel via `rc.localTyping`. The panic combo
    // and the controller's own push-to-talk key remain carve-outs; ending
    // control is always reachable by mouse.
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("beforeinput", onBeforeInput as never, true);
    window.addEventListener("compositionend", onCompositionEnd as never, true);
    window.addEventListener("focusin", onFocusIn);
    // Printables only become `beforeinput` inside an editable — put focus
    // there from the start, not only on the first click.
    textSink?.focus({ preventScroll: true });

    // §2.6 part 2 measurement probe, measurement builds only. The handle is
    // disposed with this surface — the probe holds a window keydown listener
    // and does a `getImageData` every video frame, neither of which may
    // outlive the tile it is measuring.
    //
    // 🔴 THE GUARD READS `import.meta.env` DIRECTLY, NOT `CONFIGURATION`, and
    // that is load-bearing rather than stylistic. Vite substitutes
    // `import.meta.env.*` with a literal at build time, so with the flag off
    // this whole block is statically dead and Rollup drops the dynamic
    // import along with its chunk. Guarding on `CONFIGURATION.X` — a property
    // access on an imported object — cannot be const-folded, so the `import()`
    // survives and the probe chunk is EMITTED INTO THE PRODUCTION DIST. It is
    // never fetched there (the runtime guard is still false), but it ships,
    // and "dev instrumentation that merely never runs" is not the property
    // this is supposed to have.
    //
    // Verified rather than assumed, both ways: flag off = 322 chunks and zero
    // hits for the probe's own strings; flag on = 323 chunks and one hit
    // each, with `willReadFrequently` going 2 -> 3 as the positive control
    // that the difference is exactly this chunk. Audit on those strings — see
    // the note in env.ts for why a CONFIGURATION entry cannot be the marker.
    let probe: { detach: () => void } | undefined;
    let probeDisposed = false;
    if (import.meta.env.VITE_CFG_RC_LATENCY_PROBE === "true" && props.video) {
      const video = props.video;
      void import("@revolt/rtc/rcLatencyProbeRuntime").then((m) => {
        // The surface can unmount before this resolves; attaching then would
        // leak a listener onto a tile that no longer exists.
        if (probeDisposed) return;
        probe = m.attachProbe(video);
      });
    }

    // Alt+Tab delivers a keydown for Alt and never a keyup, so without these
    // the sharer is left with Alt latched and every subsequent letter is an
    // accelerator on their machine.
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibilityChange);
    surface.addEventListener("pointercancel", releaseAll);
    surface.addEventListener("lostpointercapture", onLostPointerCapture);

    onCleanup(() => {
      surface?.removeEventListener("pointerdown", onPointerDown as never, true);
      surface?.removeEventListener("pointerup", onPointerUp as never, true);
      surface?.removeEventListener("pointermove", onPointerMove as never, true);
      surface?.removeEventListener("wheel", onWheel as never, true);
      surface?.removeEventListener("click", swallow, true);
      surface?.removeEventListener("contextmenu", swallow, true);
      surface?.removeEventListener("dblclick", swallow, true);
      surface?.removeEventListener("auxclick", swallow, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("beforeinput", onBeforeInput as never, true);
      window.removeEventListener(
        "compositionend",
        onCompositionEnd as never,
        true,
      );
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      surface?.removeEventListener("pointercancel", releaseAll);
      surface?.removeEventListener("lostpointercapture", onLostPointerCapture);
      probeDisposed = true;
      probe?.detach();
      // The flag describes THIS surface's suspension; a torn-down capture is
      // not "typing locally", it is not capturing at all.
      rc.setLocalTyping(false);
      // THE UNMOUNT IS ITSELF A PAUSE CONDITION, and this covers four
      // separate vectors at once rather than special-casing each: toggling
      // focus swaps the tile between two different `TrackLoop`s, the call
      // card flipping to PiP replaces the whole component, the sharer muting
      // their screenshare track unmounts the tile, and route navigation
      // takes the card with it. Every one of them would otherwise leave the
      // controller's held keys down on someone else's machine.
      rc.onFeedLost("capture_unmounted", generation);
    });
  });

  return (
    <Surface
      ref={surface}
      tabIndex={0}
      // No visible affordance beyond the cursor: anything painted here sits
      // on top of the desktop the controller is trying to read.
      style={{ cursor: "crosshair" }}
    >
      <TextSink
        ref={textSink}
        type="text"
        autocomplete="off"
        spellcheck={false}
        tabIndex={-1}
        aria-hidden="true"
      />
    </Surface>
  );
}

/**
 * Invisible, but a real focusable editable — `display: none` or
 * `visibility: hidden` would make it unfocusable and kill the text path.
 * `pointerEvents: none` so every click still hits the surface. The IME
 * candidate window anchors to its top-left corner; a recorded cosmetic
 * trade, not a bug.
 */
const TextSink = styled("input", {
  base: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "1px",
    height: "1px",
    opacity: 0,
    border: "none",
    padding: 0,
    pointerEvents: "none",
  },
});

const Surface = styled("div", {
  base: {
    gridArea: "1/1",
    // Anchor for the absolutely-positioned TextSink. Stacking is unchanged:
    // a grid item with a z-index already forms a stacking context, so
    // becoming positioned does not create a new comparison.
    position: "relative",
    width: "100%",
    height: "100%",
    /**
     * Above `Overlay` (z-index auto) AND above every other overlay the call
     * card paints across the tile. They all share one stacking context (the
     * card's `Base`), so the comparison is against their raw values, not
     * against their nesting:
     *
     *   ImmersiveControls        4  — top-right, and in theater mode the tile
     *                                 fills `View`, so this covers the
     *                                 maximized window's own close button
     *   ImmersiveChipOverlay     5  — top-left, over the app icon / File menu
     *   TopBanners               5  — the top strip stack: the §3.4 downgrade
     *                                 banner and the recording notice. The
     *                                 container itself is `pointer-events:
     *                                 none`, but its children are not
     *   VoiceCallRosterPanel     6  — 280px x 70% down the right-hand side
     *
     * Each of those was a dead zone where a remote click hit Sloga's chrome
     * instead of the shared desktop — and the theater one actively EXITED
     * theater mode. 20 clears all of them with room to spare.
     */
    zIndex: 20,
    outline: "none",
    touchAction: "none",
  },
});

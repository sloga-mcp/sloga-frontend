import {
  JSX,
  Match,
  Show,
  Switch,
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";

import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { SlideState } from "@revolt/ui/components/navigation/SlideDrawer";

import { VoiceCallCardActiveRoom } from "./VoiceCallCardActiveRoom";
import { VoiceCallCardPiP } from "./VoiceCallCardPiP";
import { VoiceCallCardPreview } from "./VoiceCallCardPreview";
import { type DockRect, dockDecision, sameDock } from "./callCardDock";

type Mode = "floating" | "moving";
// Corners plus the midpoint of each screen edge; "c" in either slot means
// centred on that axis (dead-centre "cc" is not a dock target).
type FloatType = "tl" | "tc" | "tr" | "cl" | "cr" | "bl" | "bc" | "br";

/** A channel page's mount marker: the channel it shows, and where it is. */
type Mount = {
  channel: Channel;
  el: HTMLElement;
};

const PAD = 16,
  PAD_X = `${PAD}px`,
  PAD_Y = `${PAD + 56}px`;

const callCardContext = createContext<{
  register(mount: Mount): void;
  unregister(el: HTMLElement): void;
}>();

/**
 * Voice call card context
 *
 * Where the card sits is DERIVED, never stored: docked over the mount marker
 * of the page being shown when that page is the call's channel (or any voice
 * channel while not in a call), the PiP while in a call anywhere else, and
 * nothing otherwise. The only state is what the user chose — the PiP corner
 * and a drag in progress — plus what the DOM reports.
 *
 * It used to be a state machine inside a memo that wrote `mode` and the
 * float's transform as side effects, fed by a snapshot the mount pushed. The
 * router runs every navigation inside `startTransition`, and the composer's
 * per-channel command fetch holds that transition open for a network round
 * trip. The phone drawer settles on a timer OUTSIDE the transition, so the old
 * voice page docked the card, then the route committed the text page, and the
 * memo was left believing it was up to date: the full docked card stayed over
 * the wrong page (and over the channel list) until a voice page mounted again.
 * Nothing here writes a signal from inside a computation now, and every input
 * change ends in a re-measure one frame later, outside any transition, so the
 * card always converges on the page that is actually showing.
 */
export function VoiceCallCardContext(props: { children: JSX.Element }) {
  const voice = useVoice();
  const state = useState();

  const [mount, setMount] = createSignal<Mount>();
  // `equals: false`: every measurement re-derives the dock from live values,
  // even when the geometry did not move. That re-derivation is the point —
  // see `measure`. `docked` below absorbs the no-op ones.
  const [rect, setRect] = createSignal<DockRect | undefined>(undefined, {
    equals: false,
  });
  // `equals: false` so dropping the card back into the corner it came from
  // still re-applies the corner's transform over the drag's raw one.
  const [float, setFloat] = createSignal<FloatType>("tr", { equals: false });
  const [moving, setMoving] = createSignal(false);

  // Expose the user-adjustable docked call card height as a CSS variable so
  // both the floating wrapper and the card itself can size to it.
  createEffect(() => {
    document.documentElement.style.setProperty(
      "--call-card-height",
      `${state.layout.getCallCardHeight()}vh`,
    );
  });

  let ref: HTMLDivElement | undefined,
    events: AbortController | null,
    frame = 0,
    pid = 0,
    ofsX = 0,
    ofsY = 0;

  /**
   * Read the registered mount's rect from the DOM as it is right now. A node
   * that is detached reports no rect; one that is not laid out reports zeros,
   * which `usableDockRect` rejects.
   */
  function measure() {
    const el = mount()?.el;
    setRect(el?.isConnected ? el.getBoundingClientRect() : undefined);
  }

  /** Measure again on the next frame, once layout has settled. */
  function remeasure() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  }

  // Re-measure whenever what the dock depends on changes: the mount (and its
  // channel), the drawer moving the channel pane on or off screen, and the
  // call. Once now, so the card follows in the same frame when it can, and
  // once on the next frame, which is the read that settles it.
  createEffect(() => {
    void mount();
    void state.appDrawer()?.state;
    void voice.channel();
    measure();
    remeasure();
  });

  // The mount's own box and its parent's: the keyboard, a side column or a
  // rotation resizing the page moves the dock without any signal changing.
  createEffect(() => {
    const el = mount()?.el;
    if (!el) return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(el);
    if (el.parentElement) observer.observe(el.parentElement);
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    window.addEventListener("resize", remeasure);
    onCleanup(() => window.removeEventListener("resize", remeasure));
  });
  onCleanup(() => cancelAnimationFrame(frame));

  /** The page the card docks over, or nothing: see `dockDecision`. */
  const docked = createMemo(
    () =>
      dockDecision({
        mount: mount(),
        rect: rect(),
        viewport: { width: innerWidth, height: innerHeight },
        drawer: state.appDrawer()?.state,
        drawerShown: SlideState.SHOWN,
        callChannelId: voice.channel()?.id,
      }),
    undefined,
    { equals: sameDock },
  );

  /**
   * The channel the FULL card is drawn for, or nothing (then the PiP while in
   * a call). That is the dock's channel when docked; and while this user is
   * CONTROLLING someone's screen it is also the call's channel when not
   * docked, because PiP is blocked for a controller (see the Switch below).
   *
   * One value for both, so a controller moving between the call's page and
   * anywhere else stays in ONE `<Match>`: only the Float's styles change. Two
   * Matches remounted the whole card on every such move — the active room,
   * every video tile, and the remote-control capture with it.
   */
  const fullCard = () =>
    docked()?.channel ??
    (voice.remoteControl.controlling() ? voice.channel() : undefined);

  const mode = (): Mode | undefined =>
    docked()
      ? undefined
      : moving()
        ? "moving"
        : voice.channel()
          ? "floating"
          : undefined;

  function mouseDown(e: PointerEvent) {
    pid = e.pointerId;
    if (mode() === "floating") {
      const pos = ref!.getBoundingClientRect();
      ofsX = e.clientX - pos.x;
      ofsY = e.clientY - pos.y;
      setMoving(true);
      addEvents();
    }
  }

  /**
   * Where the card's top-left lands for this pointer, clamped to the viewport.
   * A drag is otherwise free to carry the card off-screen, and `mouseUp` is the
   * only thing that ever brings it back — which is exactly the step a cancelled
   * gesture skips.
   */
  function cardPos(e: PointerEvent) {
    const { width, height } = ref!.getBoundingClientRect();
    return {
      width,
      height,
      x: Math.min(
        Math.max(e.clientX - ofsX, 0),
        Math.max(0, innerWidth - width),
      ),
      y: Math.min(
        Math.max(e.clientY - ofsY, 0),
        Math.max(0, innerHeight - height),
      ),
    };
  }

  function mouseMove(e: PointerEvent) {
    if (e.pointerId !== pid) return;
    e.preventDefault();
    const { x, y } = cardPos(e);
    ref!.style.transform = `translate(${x}px, ${y}px)`;
  }

  function mouseUp(e: PointerEvent) {
    if (e.pointerId !== pid) return;
    const sty = ref!.style,
      pos = cardPos(e),
      // Card centre as a fraction of the viewport; outer thirds dock to that
      // edge/corner, the middle third docks to the centre of the axis.
      cx = (pos.x + pos.width / 2) / innerWidth,
      cy = (pos.y + pos.height / 2) / innerHeight,
      h = cx < 1 / 3 ? "l" : cx > 2 / 3 ? "r" : "c",
      v = cy < 1 / 3 ? "t" : cy > 2 / 3 ? "b" : "c";

    sty.transition = "all .2s cubic-bezier(0, 1.5, 0.85, 0.8)";
    resetEvents();
    // Dead centre isn't a dock — snap to the nearest edge midpoint instead
    batch(() => {
      setMoving(false);
      setFloat(
        h === "c" && v === "c"
          ? Math.abs(cx - 0.5) > Math.abs(cy - 0.5)
            ? cx < 0.5
              ? "cl"
              : "cr"
            : cy < 0.5
              ? "tc"
              : "bc"
          : (`${v}${h}` as FloatType),
      );
    });
    //Reset CSS transition on next render pass
    setTimeout(() => (sty.transition = ""), 1);
  }

  function addEvents() {
    if (events) return;
    events = new AbortController();
    const opt = { passive: false, signal: events.signal };
    document.addEventListener("pointermove", mouseMove, opt);
    document.addEventListener("pointerup", mouseUp, opt);
    // Android hands a drag over to the system — edge swipe, notification
    // shade, an incoming call — by firing pointercancel INSTEAD of pointerup.
    // Without this the card keeps whatever raw transform the last move wrote
    // and `moving` stays set, so `mouseDown` (which only starts a drag from
    // "floating") never re-arms: the card is stranded, half off the screen,
    // for the rest of the session.
    document.addEventListener("pointercancel", mouseUp, opt);
  }

  function resetEvents() {
    events?.abort();
    events = null;
  }

  // Docking, or the call ending, ends any drag in progress.
  createEffect(() => {
    if (docked() || !voice.channel()) {
      resetEvents();
      setMoving(false);
    }
  });

  // The ONE place the float's position is written outside a drag.
  createEffect(() => {
    if (!ref) return;
    const sty = ref.style;
    const dock = docked();

    if (dock) {
      sty.transform = `translate(${dock.rect.x}px, ${dock.rect.y}px)`;
      sty.width = `${dock.rect.width}px`;
    } else if (voice.channel()) {
      // Mid-drag the pointer owns the transform; `mouseUp` hands it back here
      // through `float`.
      if (moving()) return;
      const corner = float(),
        x =
          corner[1] === "l"
            ? PAD_X
            : corner[1] === "r"
              ? `calc(100vw - var(--flt-w) - ${PAD_X})`
              : `calc((100vw - var(--flt-w)) / 2)`,
        y =
          corner[0] === "t"
            ? PAD_Y
            : corner[0] === "b"
              ? `calc(100vh - var(--flt-h) - ${PAD_Y})`
              : `calc((100vh - var(--flt-h)) / 2)`;
      sty.transform = `translate(${x}, ${y})`;
      sty.width = "";
    } else {
      // Nothing to show: park it just off the right edge.
      sty.transform = `translate(${innerWidth + 50}px, ${PAD_Y})`;
      sty.width = "";
    }
  });

  onCleanup(resetEvents);

  return (
    <callCardContext.Provider
      value={{
        register: setMount,
        // Only drop the registration if it is still this element's: during
        // a route transition the next page's mount can register before the
        // previous one is cleaned up.
        unregister: (el) =>
          setMount((cur) => (cur?.el === el ? undefined : cur)),
      }}
    >
      {props.children}
      <Portal ref={document.getElementById("floating")! as HTMLDivElement}>
        <Float
          ref={ref}
          mode={mode()}
          controlling={!!voice.remoteControl.controlling()}
          onPointerDown={mouseDown}
        >
          <Switch>
            {/* Non-keyed on purpose: Solid remounts a Match's children only
                when WHICH Match is chosen changes, so a new channel (or the
                same one, docked vs away) reaches the mounted card through
                the accessor. A controller who navigated away keeps the full
                card here, in the larger float (see `Float`'s `controlling`
                variant); anyone else away from the call's page gets the PiP
                below, never a docked card drawn over a page that is not its
                channel. */}
            <Match when={fullCard()}>
              {(channel) => <VoiceCallCard channel={channel()} />}
            </Match>
            {/* PiP is BLOCKED while this user is CONTROLLING someone, and it
                is a different path rather than a smaller one: `MiniVideo`
                never goes through `ParticipantTile`, so no capture surface
                exists there at all, and it uses `object-fit: cover` — part of
                the shared screen is CROPPED AWAY while the controller
                believes they can see all of it, so clicking where they think
                the edge is lands somewhere else entirely. PiP is entered when
                the user navigates away from the call's channel, not by a
                deliberate action, so this is the one decision point.

                Keyed on `controlling()` rather than on the capture surface
                being mounted: the surface's lifetime is exactly what PiP
                destroys, so gating on it would lift the block at the moment
                it is needed. */}
            <Match when={voice.channel() && !voice.remoteControl.controlling()}>
              <VoiceCallCardPiP />
            </Match>
          </Switch>
          {/* Watch-together player host (plan §2.1): a DIRECT child of the
              persistent Float, OUTSIDE the docked/PiP Switch, so the player
              element is never reparented or detached — a detached iframe
              loses its browsing context and reloads, a detached <video> is
              paused by spec. The store positions it over whatever rect the
              WatchOverlay reserves; with no card showing it is hidden and
              zero-size but keeps playing (audio continues). */}
          {voice.watch.host}
        </Float>
      </Portal>
    </callCardContext.Provider>
  );
}

const Float = styled("div", {
  base: {
    position: "fixed",
    zIndex: 10,
    pointerEvents: "none",
    // Animate docking (transform) and width changes, but NOT height — height is
    // user-driven by the resize divider and must track the pointer instantly.
    transition:
      "transform .3s cubic-bezier(1, 0, 0, 1), width .3s cubic-bezier(1, 0, 0, 1)",
    height: "var(--call-card-height, 40vh)",
    touchAction: "none",
  },
  variants: {
    mode: {
      floating: { cursor: "grab" },
      moving: {
        cursor: "grabbing",
        transition: "none",
      },
    },
    /** Whether this user is currently controlling someone's screen. */
    controlling: { true: {}, false: {} },
  },
  compoundVariants: [
    {
      mode: ["floating", "moving"],
      controlling: false,
      css: {
        "--flt-w": "300px",
        "--flt-h": "170px",
        width: "var(--flt-w)",
        height: "var(--flt-h)",
      },
    },
    {
      // A CONTROLLER who navigates away keeps the full card (PiP is blocked
      // — it crops the shared screen), and the full card inside the 300x170
      // float would put the capture surface in a postage stamp: the mapping
      // stays correct, but a whole desktop rendered into ~250x100 of tile is
      // not something anyone can aim at, and the card's own chrome assumes
      // roughly the docked height. Matches the docked 40vh with a 16:10 area.
      mode: ["floating", "moving"],
      controlling: true,
      css: {
        "--flt-w": "640px",
        "--flt-h": "400px",
        width: "var(--flt-w)",
        height: "var(--flt-h)",
      },
    },
  ],
});

/** 'Marker' that tells the call card where to dock for this channel's page */
export function VoiceChannelCallCardMount(props: { channel: Channel }) {
  const card = useContext(callCardContext)!;
  let ref!: HTMLDivElement;

  // Tracks `props.channel`: the text channel view is reused across channel
  // switches, so the same marker can start answering for another channel.
  createEffect(() => card.register({ channel: props.channel, el: ref }));
  onCleanup(() => card.unregister(ref));

  return <div ref={ref} />;
}

/**
 * Call card
 */
function VoiceCallCard(props: { channel: Channel }) {
  const voice = useVoice();
  const state = useState();
  const inCall = () => !!voice.channel();

  let viewRef: HTMLDivElement | undefined;

  // Resize-divider state: drag the bottom edge of the docked card to trade
  // vertical space between the call and the messages/composition below.
  const [resizing, setResizing] = createSignal(false);
  let resizeTop = 0,
    resizePid = 0,
    resizeEvents: AbortController | null = null;

  function resizeMove(e: PointerEvent) {
    if (e.pointerId !== resizePid) return;
    e.preventDefault();
    const px = e.clientY - resizeTop;
    state.layout.setCallCardHeight((px / window.innerHeight) * 100);
  }

  function resizeUp(e: PointerEvent) {
    if (e.pointerId !== resizePid) return;
    setResizing(false);
    resizeEvents?.abort();
    resizeEvents = null;
  }

  function resizeDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizePid = e.pointerId;
    resizeTop = viewRef?.getBoundingClientRect().top ?? 0;
    setResizing(true);
    resizeEvents?.abort();
    resizeEvents = new AbortController();
    const opt = { passive: false, signal: resizeEvents.signal };
    document.addEventListener("pointermove", resizeMove, opt);
    document.addEventListener("pointerup", resizeUp, opt);
  }

  onCleanup(() => resizeEvents?.abort());

  onMount(() => {
    viewRef?.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        voice.toggleFullscreen(false);
      }
    });
  });

  createEffect(() => {
    if (voice.fullscreen() && inCall()) {
      if (!viewRef?.isSameNode(document.fullscreenElement)) {
        if (document.fullscreenElement) {
          // Best-effort: a foreign element refusing to give fullscreen up is
          // not ours to reconcile, and the request below decides the signal
          // either way. Caught only so the rejection is not unhandled.
          document.exitFullscreen().catch(() => {});
        }
        // `requestFullscreen()` demands transient user activation, and this
        // runs from an effect — so a signal write that nothing "clicked"
        // (a global keybind) rejects here, as does a focused key press behind
        // a modal <dialog>, a permissions policy, or an element elsewhere
        // still holding fullscreen. A rejection means the DOM is NOT
        // fullscreen, so the signal must not keep claiming that it is: left
        // true, the effect sees no change on the next toggle and the button
        // looks dead. Reset through `toggleFullscreen(false)` rather than the
        // signal alone because this is the same "we are out of fullscreen"
        // path the `fullscreenchange` listener above takes, and theater mode
        // must never survive outside fullscreen.
        viewRef?.requestFullscreen().catch(() => voice.toggleFullscreen(false));
      }
    } else if (document.fullscreenElement) {
      // Nothing to reset: the signal already reads false. The
      // `fullscreenchange` listener is what reconciles a refused exit.
      document.exitFullscreen().catch(() => {});
    }
  });

  return (
    <Show when={voice.showCard(props.channel)}>
      <Base>
        <Card
          ref={viewRef}
          active={inCall()}
          style={resizing() ? { transition: "none" } : undefined}
        >
          <Show
            when={inCall()}
            fallback={<VoiceCallCardPreview channel={props.channel} />}
          >
            <VoiceCallCardActiveRoom />
          </Show>
          <Show when={inCall() && !voice.fullscreen()}>
            <ResizeHandle onPointerDown={resizeDown} title="Drag to resize">
              <ResizeGrip />
            </ResizeHandle>
          </Show>
        </Card>
      </Base>
    </Show>
  );
}

const Base = styled("div", {
  base: {
    left: 0,
    top: "var(--gap-md)",
    padding: "var(--gap-md)",

    width: "100%",
    position: "absolute",

    zIndex: 2,
    userSelect: "none",

    display: "flex",
    alignItems: "center",
    flexDirection: "column",
  },
});

const Card = styled("div", {
  base: {
    pointerEvents: "all",
    position: "relative",

    maxWidth: "100%",
    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease-in-out",

    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
  },
  variants: {
    active: {
      true: {
        width: "100%",
        height: "var(--call-card-height, 40vh)",
      },
      false: {
        width: "360px",
        height: "120px",
        cursor: "pointer",
      },
    },
  },
  defaultVariants: {
    active: false,
  },
});

/**
 * Draggable divider pinned to the bottom edge of the docked call card.
 * Dragging it down grows the call and shrinks the space left for messages.
 */
const ResizeHandle = styled("div", {
  base: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "14px",
    zIndex: 3,

    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",

    cursor: "ns-resize",
    touchAction: "none",

    "& > div": {
      opacity: 0.4,
      transition: "opacity .15s ease, background .15s ease",
    },
    _hover: {
      "& > div": {
        opacity: 1,
        background: "var(--md-sys-color-primary)",
      },
    },
  },
});

/**
 * Visible grip in the middle of the resize divider
 */
const ResizeGrip = styled("div", {
  base: {
    width: "48px",
    height: "4px",
    marginBottom: "3px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-outline)",
  },
});

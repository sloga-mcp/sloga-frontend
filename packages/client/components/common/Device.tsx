import {
  Accessor,
  createContext,
  createSignal,
  JSX,
  onCleanup,
  useContext,
} from "solid-js";

import { isMobileBrowser } from "@livekit/components-core";
// The leaf module, not the `@revolt/client` barrel, to stay out of its cycles.
import { useWindowCtx } from "@revolt/client/windowCtx";

import Breakpoint from "./Breakpoint";

export type Layout = "desktop" | "tablet" | "phone";

/**
 * Aspect ratio at or above which a display counts as ultrawide.
 *
 * Real panels sit nowhere near this line: the widest common non-ultrawide is
 * 16:9 at 1.78, and the narrowest panel sold as 21:9 is 2560x1080 at 2.37. Do
 * not lower it toward 1.9 to be generous — a maximized browser on a 1920x1080
 * screen has a *viewport* around 1920x930, which is 2.06. That artifact is
 * exactly why this is measured against the screen and not the window.
 */
const ULTRAWIDE_ASPECT = 2;

/**
 * Viewport width at or above which the ultrawide rearrangement has room to
 * happen: server rail (~64) + channel column (~240) + a capped message column
 * (1200-1600) + a member gutter (~240).
 */
const ULTRAWIDE_MIN_WIDTH = 1800;

/**
 * Whether the display itself is ultrawide.
 *
 * Read from `screen`, not from a media query: `min-device-aspect-ratio` is the
 * obvious-looking CSS equivalent and it is deprecated. There is no event for
 * "window moved to another monitor", so this is re-read on resize instead; the
 * values track whichever monitor the window is currently on.
 */
function readUltrawideDisplay(win: Window): boolean {
  const width = win.screen?.width;
  const height = win.screen?.height;

  // Fail OPEN. Locking a genuine ultrawide owner out of a layout preference
  // because some shell reported nothing is a worse outcome than offering the
  // option to somebody who has no use for it.
  if (!width || !height) return true;

  return width / height >= ULTRAWIDE_ASPECT;
}

/** Device type and compatibility info */
export class Device {
  /** Layout type based on viewport size

   * **Note:** This is for advanced reactivity. If you only need to
   * adjust CSS, use the `_phone` and `_tablet` PandaCSS breakpoints. */
  readonly layout: Accessor<Layout>;

  /** Whether the *display* is 21:9 or wider.

   * Gates whether the ultrawide layout option is offered at all. Deliberately
   * a property of the hardware, so it does not flicker while the window is
   * dragged, and so it still reads true for a half-screen window. */
  readonly ultrawideDisplay: Accessor<boolean>;

  /** Whether the *window* is currently wide enough to lay out for.

   * Gates whether the ultrawide layout actually applies. Width, not aspect:
   * "is there room for another column" is a question about absolute pixels. */
  readonly wideEnough: Accessor<boolean>;

  /** Mobile device detection based on User Agent.

   * **Warning:** Don't use unless absolutely necessary.
   * Granular feature-detection is preferred when possible. */
  readonly isMobile: boolean;

  private pMedia;
  private tMedia;
  private wMedia;
  private setLayout;
  /** Last layout reported, kept as a plain field so `onLayout` never
   * subscribes to its own signal from whatever scope constructed us. */
  private lastLayout: Layout | undefined;
  private setUltrawideDisplay;
  private onResize;
  private win: Window;

  /**
   * @param win Window whose viewport and screen are measured. A chat window
   * is its own viewport, so it gets its own layout rather than main's.
   */
  constructor(win: Window = window) {
    this.win = win;
    this.isMobile = isMobileBrowser();

    const [lo, setLo] = createSignal<Layout>("desktop");
    this.layout = lo;
    this.setLayout = setLo;

    this.pMedia = win.matchMedia(Breakpoint.phone);
    this.tMedia = win.matchMedia(Breakpoint.tablet);
    (this.pMedia.onchange = this.tMedia.onchange = this.onLayout.bind(this))();

    this.wMedia = win.matchMedia(`(min-width: ${ULTRAWIDE_MIN_WIDTH}px)`);
    const [wide, setWide] = createSignal(this.wMedia.matches);
    this.wideEnough = wide;
    this.wMedia.onchange = () => setWide(this.wMedia.matches);

    const [ultrawide, setUltrawide] = createSignal(readUltrawideDisplay(win));
    this.ultrawideDisplay = ultrawide;
    this.setUltrawideDisplay = setUltrawide;
    this.onResize = () => this.setUltrawideDisplay(readUltrawideDisplay(win));
    win.addEventListener("resize", this.onResize);
  }

  onLayout() {
    const next: Layout = this.pMedia.matches
      ? "phone"
      : this.tMedia.matches
        ? "tablet"
        : "desktop";

    // Instrumentation for the landscape-blanking investigation. The flip this
    // was written to detect is now confirmed: the operator's device reads a
    // 540 CSS px short side, phone false and tablet true, so a rotation does
    // cross phone<->tablet. A 411x915 phone matches both breakpoint queries
    // in both orientations and never flips, which is why that hardware ruled
    // nothing out. What is still open is whether this fully explains the
    // report, and whether a focused text field shrinking the visual viewport
    // can cross the same 501-600 band (DPR ~2.0, or a reduced Android Display
    // Size). The log stays unguarded until the device leg has run — the leg
    // reads it — so a76b5348's "remove it once report 5 is root-caused" is
    // deliberately not discharged yet.
    //
    // Cheap on purpose: this only fires when a breakpoint actually crosses,
    // which is rare, and the payload is built only in that case.
    if (next !== this.lastLayout) {
      console.info(
        `[device] layout ${this.lastLayout ?? "(init)"} -> ${next}`,
        {
          innerWidth: this.win.innerWidth,
          innerHeight: this.win.innerHeight,
          devicePixelRatio: this.win.devicePixelRatio,
          phone: this.pMedia.matches,
          tablet: this.tMedia.matches,
          orientation: this.win.screen?.orientation?.type,
        },
      );
      this.lastLayout = next;
    }

    this.setLayout(next);
  }

  destroy() {
    this.pMedia.onchange = this.tMedia.onchange = this.wMedia.onchange = null;
    this.win.removeEventListener("resize", this.onResize);
  }
}

const deviceCtx = createContext<Device>(null! as Device);

/** Mount device context for the window this subtree renders into */
export function DeviceContext(props: { children: JSX.Element }) {
  // Outside any WindowCtxProvider this is the main window, as before.
  const dev = new Device(useWindowCtx().win);
  // Passing `dev.destroy` bare loses `this` and throws on the first line of the
  // method. It never surfaced because this context is mounted at the root and
  // so is only ever disposed on teardown — but the resize listener added above
  // does need removing, so the call has to actually work.
  onCleanup(() => dev.destroy());

  return <deviceCtx.Provider value={dev}>{props.children}</deviceCtx.Provider>;
}

/** Name the chat-window chrome mounts; same component as `DeviceContext` */
export const DeviceProvider = DeviceContext;

/** Device type and compatibility info */
export const useDevice = () => useContext(deviceCtx);

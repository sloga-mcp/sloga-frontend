import {
  ErrorBoundary,
  JSX,
  Show,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { cva } from "styled-system/css";

import {
  MAIN_LABEL,
  close,
  mainFrame,
  mainMaximized,
  minimize,
  probe,
  release,
  toggleMaximize,
  watchResize,
  watchWindowFrameState,
} from "@revolt/client/mainShell";

import { CaptionButtons } from "../../../chatWindows/WindowControls";
import {
  TITLEBAR_HEIGHT,
  spacerRegion,
  tabDragActive,
  titleBarLayout,
  watchDragFlag,
} from "../../../chatWindows/chatWindowFrame";

import SlogaMark from "../../../../scripts/assets_fallback/web/favicon.svg?component-solid";

/**
 * The bar's connection status slot while the bar is drawn. ConnectionIndicator
 * portals its inline status into it from the app tree: the status needs the
 * client lifecycle, which this bar's own root does not have.
 */
const [statusSlot, setStatusSlot] = createSignal<HTMLElement>();

/**
 * Where the connection status goes while main's own title bar is drawn
 * (reactive), or undefined while it is not, when the status is the fixed dot.
 */
export function titleBarStatusSlot(): HTMLElement | undefined {
  return statusSlot();
}

/**
 * The main window's own title bar, drawn when the shell built main without
 * an OS one (mainShell): frame `buttons` on Windows (Tauri), where the bar
 * carries minimize, maximize / restore and close, and `inset` on macOS
 * (Electron), where the OS draws the traffic lights and the bar keeps their
 * corner clear. Everywhere else (web, Android, iOS, Linux, an older shell)
 * the probe answers `native` and this renders nothing.
 *
 * Mounted in its own root in `#titlebar` (src/index.tsx), outside the app
 * tree, so a crash there cannot take the window's only title bar with it.
 * `#titlebar` comes before `#floating` in the page: WebView2 resolves drag
 * regions in document order, so menus over the bar must come later to stay
 * clickable (see `ui/styles.css`).
 *
 * The bar claims the frame once, on mount ({@link probe}). It goes away for
 * good when the shell takes the frame back (`mainFrame()` turns `native`),
 * and the fixed connection dot comes back with it. While an element is
 * fullscreen the bar is hidden, not released: its drag region would
 * otherwise still answer presses over the fullscreen element. If the bar
 * itself throws, the frame is handed back ({@link BarCrashed}).
 */
export function MainTitleBar(): JSX.Element {
  onMount(() => void probe());

  return (
    <Show when={mainFrame() !== "native"}>
      <ErrorBoundary fallback={(error) => <BarCrashed error={error} />}>
        <Bar />
      </ErrorBoundary>
    </Show>
  );
}

/**
 * What is left when the bar throws after a claim: the frame handed back so
 * the shell restores the OS title bar. Once it confirms, `mainFrame()` turns
 * `native` and this goes too; the fixed connection dot comes back with the
 * bar's status slot. If the release fails, the window may have no OS title
 * bar, so a bare drag strip stands in for the bar: the window can still be
 * moved, maximized by a double-click, and closed from the system menu.
 * On macOS (`inset`) the traffic lights are the OS's and stay; there is
 * nothing to hand back, and nothing is drawn.
 */
function BarCrashed(props: { error: unknown }): JSX.Element {
  const [stuck, setStuck] = createSignal(false);
  const root = document.documentElement;
  let live = true;

  onMount(() => {
    console.error("[main-titlebar] the bar crashed:", props.error);
    // #root back to the top, also when the bar threw before its cleanup was
    // registered
    delete root.dataset.mainTitlebar;
    if (mainFrame() !== "buttons") return;
    void release().then((released) => {
      if (released || !live) return;
      root.dataset.mainTitlebar = "";
      setStuck(true);
    });
  });

  onCleanup(() => {
    live = false;
    if (stuck()) delete root.dataset.mainTitlebar;
  });

  return (
    <Show when={stuck()}>
      <div
        class={bar()}
        data-app-region="drag"
        style={{ height: `${TITLEBAR_HEIGHT}px` }}
      />
    </Show>
  );
}

/**
 * `[mac inset | connection status] [CENTER: mark + "Sloga"] [caption
 * buttons on Windows]`, in a grid whose side columns share the free space
 * equally, so the title sits on the window's center while there is room and
 * moves aside (then ellipsizes) instead of overlapping when there is not.
 *
 * The whole bar is a caption region: a press moves the window, a double-click
 * maximizes it (the OS's own handling, so there is no handler here), and a
 * right-click opens the system menu. Only real controls are no-drag. While a
 * drag of files is live it turns no-drag, as a caption region never receives
 * an HTML5 drop.
 */
function Bar(): JSX.Element {
  const layout = () => titleBarLayout(mainFrame(), MAIN_LABEL);
  const [fullscreen, setFullscreen] = createSignal(
    !!document.fullscreenElement,
  );

  onMount(() => {
    const root = document.documentElement;
    // Turns on --titlebar-height, which moves #root below the bar
    root.dataset.mainTitlebar = "";

    // Registered before anything starts, so a watcher that throws (caught
    // by the boundary) still leaves nothing behind.
    const stops: (() => void)[] = [];
    onCleanup(() => {
      delete root.dataset.mainTitlebar;
      for (const stop of stops) stop();
    });

    const onFullscreen = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFullscreen);
    stops.push(() =>
      document.removeEventListener("fullscreenchange", onFullscreen),
    );

    stops.push(watchResize(window));
    stops.push(watchWindowFrameState());
    stops.push(watchDragFlag(document));
  });

  onCleanup(() => setStatusSlot(undefined));

  return (
    <div
      class={bar()}
      data-app-region={spacerRegion(tabDragActive())}
      style={{
        height: `${TITLEBAR_HEIGHT}px`,
        display: fullscreen() ? "none" : undefined,
      }}
    >
      <div class={side()} style={layout().style}>
        <div
          id="titlebar-status"
          class={status()}
          ref={(el) => setStatusSlot(el)}
        />
      </div>
      <div class={title()}>
        <SlogaMark class={mark()} aria-hidden="true" />
        <span class={titleText()}>Sloga</span>
      </div>
      <div class={side({ end: true })}>
        <Show when={layout().controls}>
          <CaptionButtons
            maximized={mainMaximized()}
            onMinimize={() => void minimize()}
            onToggleMaximize={() => void toggleMaximize()}
            onClose={() => void close()}
          />
        </Show>
      </div>
    </div>
  );
}

/**
 * Same look as the chat windows' bars (TabStrip). Always laid out left to
 * right: the traffic lights' space and the caption buttons are physical
 * places, whatever the page's direction.
 */
const bar = cva({
  base: {
    display: "grid",
    gridTemplateColumns:
      "minmax(max-content, 1fr) minmax(0, max-content) minmax(max-content, 1fr)",
    alignItems: "stretch",
    direction: "ltr",
    userSelect: "none",
    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface-container)",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
  },
});

const side = cva({
  base: {
    display: "flex",
    alignItems: "stretch",
    minWidth: 0,
  },
  variants: {
    end: {
      true: {
        justifyContent: "flex-end",
      },
    },
  },
});

const status = cva({
  base: {
    display: "flex",
    alignItems: "center",
    paddingInline: "var(--gap-sm)",
  },
});

const title = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
    overflow: "hidden",
    pointerEvents: "none",
  },
});

const mark = cva({
  base: {
    flexShrink: 0,
    width: "16px",
    height: "16px",
  },
});

const titleText = cva({
  base: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

import { JSX, Show } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { cva } from "styled-system/css";

import * as chatShell from "@revolt/client/chatShell";

import {
  beginMaximizeToggle,
  settleMaximizeToggle,
  windowMaximized,
} from "./chatWindowFrame";

/**
 * Minimize, maximize / restore and close for a frameless chat window (the
 * `buttons` frame: Tauri on Windows, which builds the window without an OS
 * title bar). Rendered at the right end of the window's own title bar.
 *
 * Plain buttons drawn like the Windows 11 caption buttons, not IconButton:
 * its press delay and round ripple are wrong for caption buttons. Each one is
 * explicitly no-drag, as the bar around them is a caption region.
 *
 * Minimize and maximize go through main's shell bridge (the child window has
 * no IPC of its own). Close is the caller's: it goes through the chat window
 * store, so the host closes the window the same way as any other close.
 * Failures are logged only: a toast would show in main, which may be hidden.
 */
export function WindowControls(props: {
  /** The shell's label for this window (`ChildWindowHandle.shellLabel`) */
  label: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useLingui();

  const maximized = () => windowMaximized(props.label);

  function minimize() {
    const label = props.label;
    void chatShell.minimize(label).then((result) => {
      if (!result.ok) {
        console.warn("[chat-window] could not minimize", label, result.err);
      }
    });
  }

  function toggleMaximize() {
    const label = props.label;
    const ticket = beginMaximizeToggle(label);
    void chatShell.toggleMaximize(label).then((result) => {
      // The shell also pushes the new state, and its push may land first: a
      // reply that a push (or a newer click) overtook is dropped.
      if (result.ok) settleMaximizeToggle(label, ticket, result.maximized);
      else console.warn("[chat-window] could not maximize", label, result.err);
    });
  }

  const maximizeLabel = () => (maximized() ? t`Restore` : t`Maximize`);

  return (
    <div class={group()}>
      <button
        type="button"
        data-app-region="no-drag"
        class={captionButton()}
        aria-label={t`Minimize`}
        title={t`Minimize`}
        onClick={minimize}
      >
        <svg {...GLYPH}>
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button
        type="button"
        data-app-region="no-drag"
        class={captionButton()}
        aria-label={maximizeLabel()}
        title={maximizeLabel()}
        onClick={toggleMaximize}
      >
        <Show
          when={maximized()}
          fallback={
            <svg {...GLYPH}>
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          }
        >
          <svg {...GLYPH}>
            <rect x="0.5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5v-2h7v7h-2" />
          </svg>
        </Show>
      </button>
      <button
        type="button"
        data-app-region="no-drag"
        class={captionButton({ close: true })}
        aria-label={t`Close window`}
        title={t`Close window`}
        onClick={() => props.onClose()}
      >
        <svg {...GLYPH}>
          <path d="M0.5 0.5l9 9m0-9l-9 9" />
        </svg>
      </button>
    </div>
  );
}

/** The 10 px caption glyphs: 1 px strokes in the button's text color. */
const GLYPH = {
  width: 10,
  height: 10,
  viewBox: "0 0 10 10",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1,
  "aria-hidden": true,
} as const;

const group = cva({
  base: {
    display: "flex",
    alignItems: "stretch",
    alignSelf: "stretch",
    flexShrink: 0,
  },
});

const captionButton = cva({
  base: {
    all: "unset",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "46px",
    alignSelf: "stretch",
    cursor: "default",
    color: "var(--md-sys-color-on-surface)",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },

    "&:active": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },
  },
  variants: {
    // Hardcoded on purpose, not a theme token: Windows 11 draws its close
    // button's hover in this red (#c42b1c) with a white glyph in every theme
    // and accent, and a drawn caption button should match the OS's own.
    // Windows 10's is #e81123; the bar follows Windows 11's design.
    close: {
      true: {
        "&:hover": {
          background: "#c42b1c",
          color: "white",
        },

        "&:active": {
          background: "rgba(196, 43, 28, 0.9)",
          color: "white",
        },
      },
    },
  },
});

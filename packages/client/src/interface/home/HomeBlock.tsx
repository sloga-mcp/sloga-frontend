import { type JSX, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { ContextMenu, ContextMenuButton } from "@revolt/app/menus/ContextMenu";
import type {
  HomeBlockId,
  HomeColumn,
  HomeMove,
} from "@revolt/state/stores/homeLayoutRules";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Wrapper around one Home card: the card itself, plus a small pill in its
 * top-right corner with the drag grip and a menu to move or hide it.
 */
const Frame = styled("div", {
  base: {
    position: "relative",
    minWidth: 0,
    borderRadius: "16px",

    "&:hover > [data-home-controls], &:focus-within > [data-home-controls]": {
      opacity: 1,
    },
    "&[data-customizing]": {
      outline:
        "2px dashed color-mix(in srgb, 45% var(--md-sys-color-outline), transparent)",
      outlineOffset: "2px",
    },
    "&[data-customizing] > [data-home-controls]": {
      opacity: 1,
    },
  },
});

const Controls = styled("div", {
  base: {
    position: "absolute",
    top: "8px",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "2px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    opacity: 0,
    transition: "opacity 120ms ease",

    // nothing hovers on a touchscreen, so the controls stay visible there
    "@media (hover: none)": {
      opacity: 1,
    },
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
    },
  },
});

const ControlButton = styled("button", {
  base: {
    width: "32px",
    height: "32px",
    display: "grid",
    placeItems: "center",
    padding: 0,
    border: 0,
    borderRadius: "var(--borderRadius-full)",
    background: "transparent",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
      color: "var(--md-sys-color-on-surface)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },
  },
});

const Grip = styled("span", {
  base: {
    width: "32px",
    height: "32px",
    display: "grid",
    placeItems: "center",
    borderRadius: "var(--borderRadius-full)",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "grab",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
      color: "var(--md-sys-color-on-surface)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },
  },
});

export function HomeBlock(props: {
  /** The card's id, so the grid can find its menu button again after a move */
  id: HomeBlockId;
  /** The card's name, for its menu and screen readers */
  title: string;
  column: HomeColumn;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** A move from the menu; `fromKeyboard` when the menu was opened with a key */
  onMove: (move: HomeMove, fromKeyboard: boolean) => void;
  onHide: () => void;
  /** Distance of the controls from the right edge; cards with their own X need more */
  inset?: number;
  /** Props that make the grip pick the card up (left out on phones, which hold the card instead) */
  handle?: Record<string, unknown>;
  customizing: boolean;
  children: JSX.Element;
}) {
  const { t } = useLingui();

  // plain identifiers, so translators see named placeholders
  const dragLabel = () => {
    const name = props.title;
    return t`Drag ${name} to move it`;
  };
  const menuLabel = () => {
    const name = props.title;
    return t`Options for ${name}`;
  };

  // Whether the menu was opened from the keyboard (a key press on a button
  // fires a click with no pointer detail); only then does a move put focus
  // back on this button, so a mouse move neither scrolls nor pins the pill
  let openedFromKeyboard = false;
  const move = (direction: HomeMove) =>
    props.onMove(direction, openedFromKeyboard);

  return (
    <Frame data-customizing={props.customizing ? "" : undefined}>
      {props.children}
      <Controls data-home-controls style={{ right: `${props.inset ?? 8}px` }}>
        <Show when={props.handle}>
          {(handle) => (
            <Grip
              {...handle()}
              role="button"
              aria-label={dragLabel()}
              title={t`Drag to move`}
            >
              <Symbol size={20}>drag_indicator</Symbol>
            </Grip>
          )}
        </Show>
        <ControlButton
          type="button"
          data-home-menu={props.id}
          aria-label={menuLabel()}
          onClick={(event) => (openedFromKeyboard = event.detail === 0)}
          onContextMenu={() => (openedFromKeyboard = false)}
          use:floating={{
            contextMenu: () => (
              <ContextMenu>
                <Show when={props.canMoveUp}>
                  <ContextMenuButton onClick={() => move("up")}>
                    <Trans>Move up</Trans>
                  </ContextMenuButton>
                </Show>
                <Show when={props.canMoveDown}>
                  <ContextMenuButton onClick={() => move("down")}>
                    <Trans>Move down</Trans>
                  </ContextMenuButton>
                </Show>
                <ContextMenuButton onClick={() => move("other")}>
                  {props.column === "main" ? (
                    <Trans>Move to the side column</Trans>
                  ) : (
                    <Trans>Move to the main column</Trans>
                  )}
                </ContextMenuButton>
                <ContextMenuButton onClick={() => props.onHide()}>
                  <Trans>Hide this card</Trans>
                </ContextMenuButton>
              </ContextMenu>
            ),
            contextMenuHandler: "click",
          }}
        >
          <Symbol size={20}>more_horiz</Symbol>
        </ControlButton>
      </Controls>
    </Frame>
  );
}

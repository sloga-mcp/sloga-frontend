import { type JSX, createMemo } from "solid-js";

import { styled } from "styled-system/jsx";

import { useDevice } from "@revolt/common";
import { useState } from "@revolt/state";
import {
  type HomeBlockId,
  type HomeColumn,
  type HomeMove,
} from "@revolt/state/stores/homeLayoutRules";
import {
  Draggable,
  createDragHandle,
} from "@revolt/ui/components/utils/Draggable";

import { HomeBlock } from "./HomeBlock";

/** What the grid needs to know about one card */
export type HomeBlockDef = {
  /** The card's name in its menu and in Customize */
  title: () => string;
  /** Whether the card has anything to show right now */
  available: () => boolean;
  /**
   * Whether this viewer could ever see the card here; Customize leaves the
   * others out. Every card is offered unless it says otherwise.
   */
  offered?: () => boolean;
  /** Distance of the move/hide controls from the right edge (cards with their own X) */
  inset?: number;
  render: () => JSX.Element;
};

/** Drag type shared by both columns, so a card can cross between them */
const DRAG_TYPE = "home-blocks";

const Columns = styled("div", {
  base: {
    width: "100%",
    maxWidth: "1180px",
    marginInline: "auto",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 340px)",
    gap: "20px",
    alignItems: "start",

    "&[data-single]": {
      gridTemplateColumns: "minmax(0, 1fr)",
    },

    // the content pane is too narrow for two columns: the side column
    // stacks under the main one
    "@media (max-width: 1180px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      maxWidth: "780px",
    },
    "@media (max-width: 640px)": {
      gap: "14px",
    },
  },
});

const Column = styled("div", {
  base: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",

    "& > [data-dnd-zone]": {
      display: "flex",
      flexDirection: "column",
      gap: "16px",

      "@media (max-width: 640px)": {
        gap: "14px",
      },
    },

    // while customizing, an empty column is still somewhere to drop a card
    "&[data-customizing] > [data-dnd-zone]": {
      minHeight: "96px",
      borderRadius: "16px",
    },
    "&[data-customizing][data-empty] > [data-dnd-zone]": {
      outline:
        "2px dashed color-mix(in srgb, 45% var(--md-sys-color-outline), transparent)",
    },
    "&[data-hidden]": {
      display: "none",
    },
  },
});

/** Same ids in the same order */
function sameIds(a: readonly HomeBlockId[], b: readonly HomeBlockId[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The two columns of Home cards. Each column is a drop zone of one drag type,
 * so cards reorder within a column and move between them; every change goes
 * through the synced Home layout store.
 */
export function HomeGrid(props: {
  blocks: Record<HomeBlockId, HomeBlockDef>;
  customizing: boolean;
}) {
  const state = useState();

  // Constant for the life of the grid, as Draggable's `longPress` requires
  const isMobile = useDevice().isMobile;

  const available = (id: HomeBlockId) => props.blocks[id].available();

  // Compared by value: the store and the cards' own state change often, and a
  // new list here would rebuild every card in the column
  const mainIds = createMemo(
    () => state.homeLayout.shown("main", available),
    [],
    { equals: sameIds },
  );
  const sideIds = createMemo(
    () => state.homeLayout.shown("side", available),
    [],
    { equals: sameIds },
  );

  const mainItems = createMemo(() => mainIds().map((id) => ({ id })));
  const sideItems = createMemo(() => sideIds().map((id) => ({ id })));

  /** Cards drawn in either column right now */
  const shownSet = () => new Set<HomeBlockId>([...mainIds(), ...sideIds()]);

  /** Drag is off on phones outside Customize; the card menu still moves cards */
  const dragOff = () => isMobile && !props.customizing;

  /** One column has nothing and nobody is arranging: give the other the room */
  const single = () =>
    !props.customizing && (mainIds().length === 0 || sideIds().length === 0);

  let grid: HTMLDivElement | undefined;

  /**
   * Move a card from its menu. A move rebuilds the column, so the menu
   * button keyboard focus was on is gone; when the menu was opened from the
   * keyboard, put focus back on the moved card's own menu button (following
   * the card), unless focus has already gone somewhere else. A mouse move
   * leaves focus alone, so the page does not jump to the card.
   */
  function moveFromMenu(
    id: HomeBlockId,
    move: HomeMove,
    fromKeyboard: boolean,
  ) {
    state.homeLayout.move(id, move, shownSet());
    if (!fromKeyboard) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      grid?.querySelector<HTMLElement>(`[data-home-menu="${id}"]`)?.focus();
    });
  }

  function column(
    which: HomeColumn,
    ids: () => HomeBlockId[],
    items: () => { id: HomeBlockId }[],
  ) {
    return (
      <Column
        data-customizing={props.customizing ? "" : undefined}
        data-empty={ids().length === 0 ? "" : undefined}
        data-hidden={single() && ids().length === 0 ? "" : undefined}
      >
        <Draggable
          type={DRAG_TYPE}
          items={items()}
          dragHandles
          longPress={isMobile}
          // On a phone a resting finger would otherwise pick up whatever
          // card it is on, so holding to move only works while customizing.
          // One expression for both zones, as nested/paired zones require.
          disabled={dragOff()}
          onChange={(order) => state.homeLayout.drop(which, order, shownSet())}
        >
          {(entry) => {
            const id = entry.item.id;
            const def = props.blocks[id];
            const index = () => ids().indexOf(id);

            return (
              <HomeBlock
                id={id}
                title={def.title()}
                column={which}
                canMoveUp={index() > 0}
                canMoveDown={index() < ids().length - 1}
                onMove={(move, fromKeyboard) =>
                  moveFromMenu(id, move, fromKeyboard)
                }
                onHide={() => state.homeLayout.setHidden(id, true)}
                inset={def.inset}
                // a phone holds the card to pick it up; the grip only arms
                // the list under a mouse (see createDragHandle)
                handle={
                  isMobile
                    ? undefined
                    : createDragHandle(
                        entry.dragDisabled,
                        entry.setDragDisabled,
                      )
                }
                customizing={props.customizing}
              >
                {def.render()}
              </HomeBlock>
            );
          }}
        </Draggable>
      </Column>
    );
  }

  return (
    <Columns ref={grid} data-single={single() ? "" : undefined}>
      {column("main", mainIds, mainItems)}
      {column("side", sideIds, sideItems)}
    </Columns>
  );
}

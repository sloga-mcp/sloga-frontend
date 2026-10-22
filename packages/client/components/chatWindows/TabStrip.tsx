import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { cva } from "styled-system/css";

import { ContextMenu, ContextMenuButton } from "@revolt/app/menus/ContextMenu";
import { FriendContextMenu } from "@revolt/app/menus/FriendContextMenu";
import { useClient } from "@revolt/client";
import type { ChatWindowFrame } from "@revolt/client/chatShell";
import { useConversationE2EE } from "@revolt/client/useConversationE2EE";
import { allWindowCtxs, useWindowCtx } from "@revolt/client/windowCtx";
import { TextWithEmoji } from "@revolt/markdown";
import {
  Avatar,
  Unreads,
  UserStatus,
  isSlogaStaff,
  usePresenceText,
} from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdClose from "@material-design-icons/svg/outlined/close.svg?component-solid";

import { conversationUnread } from "../friends/friendData";

import { WindowControls } from "./WindowControls";
import {
  markTabDragEnd,
  markTabDragStart,
  spacerRegion,
  tabDragActive,
  titleBarLayout,
} from "./chatWindowFrame";
import {
  chatWindows,
  closeTab,
  moveTab,
  setActive,
  windowOf,
} from "./chatWindowsStore";
import {
  type ScreenRect,
  acceptsTabDrag,
  beginTabDrag,
  dropIndex,
  droppedTab,
  endTabDrag,
  endTabDragOnRemoval,
  markTabDropped,
  tabDragLive,
  tabDragPayload,
  tearOffAt,
} from "./tabDrop";

/**
 * The attribute every strip carries (written literally in the JSX below), so
 * the drop guard leaves drags over a strip alone.
 */
const STRIP_ATTR = "data-chat-tab-strip";

/**
 * Capture-phase guard against a tab landing anywhere but a tab strip. A tab
 * drag carries `text/plain`, so without it the composer (CodeMirror) or any
 * text field would accept the drop and insert `sloga-tab:<id>`. While a tab
 * drag is in progress and the pointer is off every strip, the drag is
 * refused (`dropEffect` "none", so the cursor says so) and a drop that still
 * arrives is cancelled before any target sees it. Other drags pass untouched,
 * and so does everything once a strip has taken the drop: that drag is over
 * but for its `dragend`, which a lost event must not turn into a guard that
 * refuses every later file drop.
 */
function tabDropGuard(e: DragEvent) {
  if (!tabDragLive()) return;
  const target = e.target as Element | null;
  if (target?.closest?.(`[${STRIP_ATTR}]`)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
}

const GUARDED_EVENTS = ["dragenter", "dragover", "drop"] as const;

/** Documents carrying the guard, with how many holders want it there. */
const guarded = new Map<Document, number>();

/** Put the guard on `doc` (once, however many hold it); returns the release. */
function holdDropGuard(doc: Document): () => void {
  const count = guarded.get(doc) ?? 0;
  guarded.set(doc, count + 1);
  if (count === 0) {
    for (const type of GUARDED_EVENTS) {
      doc.addEventListener(type, tabDropGuard as EventListener, true);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (guarded.get(doc) ?? 1) - 1;
    if (left > 0) {
      guarded.set(doc, left);
      return;
    }
    guarded.delete(doc);
    try {
      for (const type of GUARDED_EVENTS) {
        doc.removeEventListener(type, tabDropGuard as EventListener, true);
      }
    } catch {
      // A closed window's listeners die with it.
    }
  };
}

/**
 * Guards put on every window's document for the length of one drag: main and
 * the friends window have no strip of their own to hold one, but both have
 * text fields a tab could be dropped on.
 */
let dragGuards: (() => void)[] = [];

function guardAllWindows() {
  releaseDragGuards();
  dragGuards = allWindowCtxs().map((ctx) => holdDropGuard(ctx.doc));
}

function releaseDragGuards() {
  const held = dragGuards;
  dragGuards = [];
  for (const release of held) release();
}

/**
 * The guards only matter until a drop: release them once no live drag is
 * left, i.e. at the drop a strip took, or at a `dragend` with none. The title
 * bars' drag spacers go back to being caption regions at the same point.
 */
function releaseGuardsIfIdle() {
  if (tabDragLive()) return;
  releaseDragGuards();
  markTabDragEnd();
}

/** `dragend`: forget the drag of `channelId`, and drop its guards. */
function finishTabDrag(channelId: string) {
  endTabDrag(channelId);
  releaseGuardsIfIdle();
}

/**
 * Outer bounds of every visible app window, for the tear-off hit test. A
 * hidden window (main while only chat windows show) cannot catch a release.
 */
function appWindowBounds(): ScreenRect[] {
  const bounds: ScreenRect[] = [];
  for (const ctx of allWindowCtxs()) {
    try {
      if (ctx.doc.visibilityState === "hidden") continue;
      const w = ctx.win;
      bounds.push({
        left: w.screenX,
        top: w.screenY,
        width: w.outerWidth,
        height: w.outerHeight,
      });
    } catch {
      // A window closing under us cannot catch the release either.
    }
  }
  return bounds;
}

/**
 * The tab strip of one chat window (plan D7).
 *
 * Tabs are HTML5-draggable. Dropping one on any chat window's strip moves it
 * there at the slot it was dropped on; releasing it outside every app window
 * tears it off into a new window at the cursor. Both rely on the drag source
 * recorded in `tabDrop.ts`, which every window shares because they all run in
 * the main realm.
 *
 * The strip's own listeners are bound through JSX on elements in this
 * window's document, and the drop guard on this window's document from
 * `useWindowCtx()`, never on a global `document` / `window`: the strip renders
 * inside a child window, and the global ones are main's.
 *
 * In a window without an OS title bar (frame `buttons` or `inset`), the strip
 * is the title bar too:
 * `[mac inset] [tab scroller] [drag spacer] [window controls, buttons only]`.
 * The bar is a caption region (`data-app-region`, see `ui/styles.css`), so a
 * press on it moves the window; the scroller, and with it every tab and tab
 * button, is no-drag. The bar's free space (the spacer, and the mac inset)
 * turns no-drag while a tab drag or a drag of files is live, as a caption
 * region never receives an HTML5 drop; the spacer is part of the drop area,
 * where a tab counts as dropped after the last tab. With the `native` frame
 * the strip is exactly the plain strip. Which frame draws what is
 * `titleBarLayout`'s.
 */
export function TabStrip(props: {
  windowId: string;
  /** What the shell built around the window (`ChildWindowHandle.frame`) */
  frame: ChatWindowFrame;
  /** The shell's label for the window, for the window controls */
  shellLabel?: string;
  /** Close this window (the window controls' close button) */
  onCloseWindow: () => void;
}) {
  const { t } = useLingui();
  const windowCtx = useWindowCtx();

  const win = createMemo(() =>
    chatWindows.windows().find((w) => w.id === props.windowId),
  );
  const tabs = () => win()?.tabs ?? [];

  /** Where a hovering tab would land, as drawn; null when none hovers. */
  const [dropSlot, setDropSlot] = createSignal<number | null>(null);

  let strip: HTMLDivElement | undefined;

  // This window always carries the guard: its composer is the likeliest
  // wrong target. A window's ctx never changes, so binding once is correct.
  onMount(() => onCleanup(holdDropGuard(windowCtx.doc)));

  function slotAt(clientX: number): number {
    if (!strip) return tabs().length;
    const boxes = Array.from(
      strip.querySelectorAll<HTMLElement>("[data-chat-tab]"),
      (el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      },
    );
    return dropIndex(boxes, clientX);
  }

  /** dragenter and dragover: claim the drag only when it is one of our tabs. */
  function onDragOver(e: DragEvent) {
    if (!acceptsTabDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    setDropSlot(slotAt(e.clientX));
  }

  function onDragLeave(e: DragEvent) {
    // dragleave also fires moving between the strip's own children
    const to = e.relatedTarget as Node | null;
    if (!to || !strip?.contains(to)) setDropSlot(null);
  }

  function onDrop(e: DragEvent) {
    setDropSlot(null);
    if (!acceptsTabDrag(e.dataTransfer?.types)) return;
    e.preventDefault();

    const channelId = droppedTab(e.dataTransfer?.getData("text/plain"));
    if (!channelId) return;

    const index = slotAt(e.clientX);
    // Marked, not ended: the move may empty the source window, which the
    // host keeps open while the drag is reported, until the source tab's
    // dragend. Marking first also keeps the moved tab's cleanup from
    // ending it.
    markTabDropped(channelId);
    releaseGuardsIfIdle();
    moveTab(channelId, props.windowId, { index });
  }

  /** The tabs, then the free space after them (the end drop slot). */
  const tabList = () => (
    <>
      <For each={tabs()}>
        {(channelId, index) => (
          <Tab
            channelId={channelId}
            windowId={props.windowId}
            active={win()?.active === channelId}
            dropBefore={dropSlot() === index()}
            canPopOut={tabs().length > 1}
          />
        )}
      </For>
      <div
        class={dropEndStyle()}
        data-drop-target={dropSlot() !== null && dropSlot() === tabs().length}
      />
    </>
  );

  const layout = () => titleBarLayout(props.frame, props.shellLabel);

  return (
    <Show
      when={layout().bar}
      fallback={
        <div
          ref={strip}
          data-chat-tab-strip
          class={stripStyle()}
          role="tablist"
          aria-label={t`Conversations`}
          onDragEnter={onDragOver}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {tabList()}
        </div>
      }
    >
      <div
        class={barStyle()}
        data-app-region={spacerRegion(tabDragActive())}
        style={layout().style}
      >
        {/* The drop area: the tabs, and the spacer, which drops at the end */}
        <div
          ref={strip}
          data-chat-tab-strip
          class={dropAreaStyle()}
          onDragEnter={onDragOver}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div
            class={stripStyle({ bar: true })}
            data-app-region="no-drag"
            role="tablist"
            aria-label={t`Conversations`}
          >
            {tabList()}
          </div>
          <div
            class={spacerStyle()}
            data-app-region={spacerRegion(tabDragActive())}
          />
        </div>
        <Show when={layout().controls && props.shellLabel}>
          {(label) => (
            <WindowControls
              label={label()}
              onClose={() => props.onCloseWindow()}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}

function Tab(props: {
  channelId: string;
  windowId: string;
  active: boolean;
  /** Draw the drop marker on this tab's leading edge */
  dropBefore: boolean;
  /** Popping out the only tab would just reopen the same window */
  canPopOut: boolean;
}) {
  const { t } = useLingui();
  const client = useClient();
  const presence = usePresenceText();
  const windowCtx = useWindowCtx();

  const channel = () => client().channels.get(props.channelId);
  const e2ee = useConversationE2EE(channel);

  // The active tab's own unread is acked by the view, so it never shows one
  const unread = () => (props.active ? null : conversationUnread(channel()));

  const subtitle = () => {
    const ch = channel();
    if (!ch) return undefined;

    if (ch.type === "Group") {
      const count = ch.recipientIds.size;
      return count === 1 ? t`1 member` : t`${count} members`;
    }

    const user = ch.recipient;
    if (!user) return undefined;
    if (user.activity) return t`Playing ${user.activity.name}`;
    return user.statusMessage(presence.label) ?? presence.label(user.presence);
  };

  let tab: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.active) tab?.scrollIntoView?.({ block: "nearest" });
  });

  // A tab removed mid-drag (closed, or its window closed) is no longer a
  // valid drop; a late dragend from it must not tear anything off either.
  // A tab the drop moved to another window keeps the drag: its dragend
  // still fires here (Solid binds drag events on the element itself, not
  // delegated), and ends it then.
  onCleanup(() => {
    endTabDragOnRemoval(
      props.channelId,
      windowOf(props.channelId) !== undefined,
    );
    releaseGuardsIfIdle();
  });

  function onDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("text/plain", tabDragPayload(props.channelId));
    e.dataTransfer.effectAllowed = "move";
    beginTabDrag(props.channelId, props.windowId);
    guardAllWindows();
    // The title bars' drag spacers turn no-drag, so a drop there lands.
    markTabDragStart();
  }

  function onDragEnd(e: DragEvent) {
    const channelId = props.channelId;
    finishTabDrag(channelId);
    markTabDragEnd();

    const at = tearOffAt(
      e.dataTransfer?.dropEffect,
      e.screenX,
      e.screenY,
      appWindowBounds(),
    );
    // `moveTab` adds a tab that is open nowhere, so a tab closed while it
    // was being dragged must not come back in a new window
    if (at && windowOf(channelId)) moveTab(channelId, "new", { at });
  }

  /**
   * Right-click: for a DM with a friend, the Steam-style friend menu with
   * "Close tab" first; for anything else, just "Close tab"
   */
  const tabMenu = () => {
    const recipient =
      channel()?.type === "DirectMessage" ? channel()?.recipient : undefined;
    const close = () => closeTab(props.channelId);
    return recipient?.relationship === "Friend" ? (
      <FriendContextMenu user={recipient} onCloseTab={close} inConversation />
    ) : (
      <ContextMenu>
        <ContextMenuButton icon={MdClose} onClick={close}>
          <Trans>Close tab</Trans>
        </ContextMenuButton>
      </ContextMenu>
    );
  };

  /** Next to this window, so the new one does not open on top of it. */
  function popOut() {
    let at: { left: number; top: number } | undefined;
    try {
      at = {
        left: windowCtx.win.screenX + 40,
        top: windowCtx.win.screenY + 40,
      };
    } catch {
      // A window closing under us: let the host place the new one
    }
    moveTab(props.channelId, "new", at ? { at } : undefined);
  }

  return (
    <div
      ref={tab}
      data-chat-tab
      class={tabStyle({ active: props.active })}
      data-drop-target={props.dropBefore}
      role="tab"
      aria-selected={props.active}
      tabIndex={0}
      draggable={true}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => setActive(props.windowId, props.channelId)}
      use:floating={{ contextMenu: tabMenu }}
      onKeyDown={(e) => {
        // Keys bubbling up from the pop-out / close buttons are theirs
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setActive(props.windowId, props.channelId);
      }}
      // Middle-click closes; cancelling the press stops the autoscroll cursor
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        closeTab(props.channelId);
      }}
    >
      <Switch>
        <Match when={channel()?.type === "Group"}>
          <Avatar
            size={24}
            shape="rounded-square"
            fallback={channel()?.name}
            src={channel()?.iconURL}
            primaryContrast
          />
        </Match>
        <Match when={channel()?.type === "DirectMessage"}>
          <Avatar
            size={24}
            src={channel()?.iconURL}
            fallback={channel()?.recipient?.username}
            holepunch="bottom-right"
            overlay={
              <UserStatus.Graphic status={channel()?.recipient?.presence} />
            }
          />
        </Match>
      </Switch>

      <div class={labelStack()}>
        <div class={`${nameText()} ${ellipsis()}`}>
          <Switch fallback={t`Unknown conversation`}>
            <Match when={channel()?.type === "DirectMessage"}>
              <DisplayName
                user={channel()?.recipient}
                name={channel()?.recipient?.displayName ?? ""}
                brand={isSlogaStaff(channel()?.recipient)}
              />
            </Match>
            <Match when={channel()}>
              {(ch) => <TextWithEmoji content={ch().displayName ?? ""} />}
            </Match>
          </Switch>
        </div>
        <Show when={subtitle()}>
          <div class={`${subtitleText()} ${ellipsis()}`}>{subtitle()}</div>
        </Show>
      </div>

      <Switch>
        <Match when={e2ee() === "encrypted"}>
          <span
            class={e2eeIcon()}
            role="img"
            aria-label={t`End-to-end encrypted`}
            use:floating={{
              tooltip: {
                placement: "bottom",
                content: t`End-to-end encrypted`,
              },
            }}
          >
            <Symbol size={14}>lock</Symbol>
          </span>
        </Match>
        <Match when={e2ee() === "warning"}>
          <span
            class={e2eeIcon({ warning: true })}
            role="img"
            aria-label={t`Encryption needs your attention`}
            use:floating={{
              tooltip: {
                placement: "bottom",
                content: t`Encryption needs your attention`,
              },
            }}
          >
            <Symbol size={14}>warning</Symbol>
          </span>
        </Match>
      </Switch>

      <Show when={unread()}>
        {(u) => (
          <span
            class={unreadPill()}
            role="img"
            aria-label={u().mention ? t`Unread mentions` : t`Unread messages`}
          >
            <Unreads
              count={u().count}
              unread
              tone={u().mention ? "mention" : "unread"}
              size={u().count > 0 ? "16px" : "10px"}
            />
          </span>
        )}
      </Show>

      {/* Buttons keep their clicks: the tab's own click switches to it */}
      <div class={`tab-actions ${actions()}`}>
        <Show when={props.canPopOut}>
          <button
            class={iconButton()}
            draggable={false}
            aria-label={t`Pop out`}
            onClick={(e) => {
              e.stopPropagation();
              popOut();
            }}
            use:floating={{
              tooltip: { placement: "bottom", content: t`Pop out` },
            }}
          >
            <Symbol size={16}>open_in_new</Symbol>
          </button>
        </Show>
        <button
          class={iconButton()}
          draggable={false}
          aria-label={t`Close`}
          onClick={(e) => {
            e.stopPropagation();
            closeTab(props.channelId);
          }}
          use:floating={{
            tooltip: { placement: "bottom", content: t`Close` },
          }}
        >
          <Symbol size={16}>close</Symbol>
        </button>
      </div>
    </div>
  );
}

const stripStyle = cva({
  base: {
    display: "flex",
    alignItems: "stretch",
    flexShrink: 0,
    gap: "var(--gap-xs)",
    minHeight: "44px",
    paddingInline: "var(--gap-sm)",
    paddingTop: "var(--gap-xs)",
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "thin",
    background: "var(--md-sys-color-surface-container)",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
  },
  variants: {
    // The tab scroller inside a title bar: as wide as its tabs, shrinking
    // (and scrolling) to leave the drag spacer its room; the bar paints.
    bar: {
      true: {
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: "auto",
        minWidth: 0,
        background: "transparent",
        borderBottom: "none",
      },
    },
  },
});

/** A chat window's own title bar: the strip, a drag spacer, the controls. */
const barStyle = cva({
  base: {
    display: "flex",
    alignItems: "stretch",
    flexShrink: 0,
    userSelect: "none",
    background: "var(--md-sys-color-surface-container)",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
  },
});

/** The scroller and the spacer: everything in the bar a tab can drop on. */
const dropAreaStyle = cva({
  base: {
    display: "flex",
    alignItems: "stretch",
    flexGrow: 1,
    minWidth: 0,
  },
});

/** Free bar space that moves the window (and drops at the end in a drag). */
const spacerStyle = cva({
  base: {
    flexGrow: 1,
    flexShrink: 0,
    minWidth: "48px",
  },
});

const tabStyle = cva({
  base: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    gap: "var(--gap-sm)",
    minWidth: "140px",
    maxWidth: "220px",
    paddingInline: "var(--gap-sm)",
    borderTopLeftRadius: "var(--borderRadius-md)",
    borderTopRightRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    userSelect: "none",
    color: "var(--md-sys-color-on-surface-variant)",

    // Collapsed rather than display:none so the buttons stay tabbable
    "& .tab-actions": {
      width: 0,
      overflow: "hidden",
    },

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:hover .tab-actions, & .tab-actions:focus-within": {
      width: "auto",
      overflow: "visible",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },

    "&[data-drop-target='true']": {
      boxShadow: "inset 2px 0 0 var(--md-sys-color-primary)",
    },
  },
  variants: {
    active: {
      true: {
        color: "var(--md-sys-color-on-surface)",
        background: "var(--md-sys-color-surface)",

        "&:hover": {
          background: "var(--md-sys-color-surface)",
        },

        "& .tab-actions": {
          width: "auto",
          overflow: "visible",
        },
      },
    },
  },
});

/** The free space after the last tab; shows the marker for an end drop. */
const dropEndStyle = cva({
  base: {
    flexGrow: 1,
    minWidth: "var(--gap-md)",

    "&[data-drop-target='true']": {
      boxShadow: "inset 2px 0 0 var(--md-sys-color-primary)",
    },
  },
});

const labelStack = cva({
  base: {
    minWidth: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
});

const nameText = cva({
  base: {
    fontSize: "13px",
    lineHeight: "16px",
  },
});

const subtitleText = cva({
  base: {
    fontSize: "11px",
    lineHeight: "14px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ellipsis = cva({
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const e2eeIcon = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    color: "var(--md-sys-color-primary)",
  },
  variants: {
    warning: {
      true: {
        color: "var(--md-sys-color-error)",
      },
    },
  },
});

const unreadPill = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
  },
});

const actions = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
  },
});

const iconButton = cva({
  base: {
    all: "unset",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    borderRadius: "var(--borderRadius-full)",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
      background: "var(--md-sys-color-surface-container-highest)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
});

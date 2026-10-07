import { useFloating } from "solid-floating-ui";
import { BiRegularCheckCircle, BiSolidCheckCircle } from "solid-icons/bi";
import {
  Accessor,
  For,
  JSX,
  Match,
  Setter,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";

import { autoUpdate, flip, offset, shift } from "@floating-ui/dom";
import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useMutation } from "@tanstack/solid-query";
import type { API, Channel, Server, ServerFlags } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { ContextMenu, ContextMenuButton } from "@revolt/app/menus/ContextMenu";
import { useClient } from "@revolt/client";
import { useDevice } from "@revolt/common";
import { KeybindAction, createKeybind } from "@revolt/keybinds";
import { TextWithEmoji } from "@revolt/markdown";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { useVoice } from "@revolt/rtc";
import { isAfkChannel } from "@revolt/rtc/afkPolicy";
import { shouldJoinOnDoubleClick } from "@revolt/rtc/doubleClickJoinPolicy";
import {
  VOICE_MOVE_MIME,
  draggedVoiceParticipant,
  setDraggedVoiceParticipant,
} from "@revolt/rtc/voiceMoveDrag";
import {
  type MoveRefusalKind,
  moveRefusalKind,
  moveTargets,
} from "@revolt/rtc/voiceMovePolicy";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import {
  Button,
  Column,
  Draggable,
  Header,
  IconButton,
  MenuButton,
  OverflowingText,
  Row,
  Tooltip,
  iconSize,
  symbolSize,
  typography,
  unreadTone,
  useLayoutSides,
  useSnackbar,
} from "@revolt/ui";
import { VoiceChannelPreview } from "@revolt/ui/components/features/voice/VoiceChannelPreview";
import { createDragHandle } from "@revolt/ui/components/utils/Draggable";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdChevronRight from "@material-design-icons/svg/filled/chevron_right.svg?component-solid";
import MdLibraryAdd from "@material-design-icons/svg/outlined/library_add.svg?component-solid";
import MdSettings from "@material-symbols/svg-400/outlined/settings-fill.svg?component-solid";

import { isChannelGatedForMember } from "../../channels/memberGate";
import { ServerMemberSidebar } from "../../channels/text/MemberSidebar";

import { parseChannelPassword } from "../../../lib/channelPassword";

import {
  CategoryPayload,
  StagedCategory,
  applyCategoryOrder,
  applyMove,
  hasDuplicateChannel,
  seedStaged,
  toEditPayload,
} from "./channelReorder";
import { SidebarBase } from "./common";
import { exitReorderMode, reorderMode } from "./reorderMode";

/**
 * Whether one of the channel's gates (age, password, spoiler) still stands.
 *
 * The gates wrap the channel pane, but this sidebar draws things from the
 * channel outside it: the member list, a voice channel's live roster, and a
 * double-click that joins the call. Each asks here first, so passing the gate
 * is the only way to reach any of them.
 *
 * The check itself is the shared one in `memberGate.ts`: the member menus
 * filter their Move targets with it and the voice client asks it before
 * following a move, so all of them agree on what "gated" means.
 */
function isGatedFor(
  state: ReturnType<typeof useState>,
  channel: Channel,
): boolean {
  return isChannelGatedForMember(
    channel,
    (key) => state.layout.getSectionState(key, false),
    LAYOUT_SECTIONS.MATURE,
  );
}

interface Props {
  /**
   * Server to display sidebar for
   */
  server: Server;

  /**
   * Currently selected channel ID
   */
  channelId: string | undefined;

  /**
   * Open server information modal
   */
  openServerInfo: () => void;

  /**
   * Open server settings modal
   */
  openServerSettings: () => void;

  /**
   * Menu generator
   */
  menuGenerator: (target: Server | Channel) => JSX.Directives["floating"];
}

/**
 * Ordered category data returned from server
 */
type CategoryData = Omit<API.Category, "channels"> & { channels: Channel[] };

/**
 * One drag result, as `Draggable` delivers it.
 *
 * `moved` used to ride along here so `handleOrdering` could tell a
 * cross-category drop from a within-category one and defer the first of the
 * two events it produces. Nothing defers any more — both events are applied
 * to one staged array — so the flag has no reader and is gone. See
 * `handleOrdering` for the coalescing that replaced it.
 */
type OrderingEvent =
  | {
      type: "categories";
      ids: string[];
    }
  | {
      type: "category";
      id: string;
      channelIds: string[];
    };

/**
 * Display server information and channels
 */
export const ServerSidebar = (props: Props) => {
  const navigate = useNavigate();
  const { isMobile } = useDevice();
  const client = useClient();
  const state = useState();
  const sides = useLayoutSides();
  const { showError } = useModals();

  let memberScrollTarget: HTMLDivElement | undefined;
  let channelScrollTarget: HTMLDivElement | undefined;

  const selectedChannel = createMemo(() =>
    props.channelId ? client().channels.get(props.channelId) : undefined,
  );

  // User-dragged height (px) for the channel list while it shares the column
  // with the member list. null = the default content-sized 60%-capped split.
  const SPLIT_STORAGE_KEY = "sloga:channelMemberSplit";
  const [channelListHeight, setChannelListHeight] = createSignal<number | null>(
    (() => {
      const stored = parseInt(
        localStorage.getItem(SPLIT_STORAGE_KEY) ?? "",
        10,
      );
      return Number.isFinite(stored) && stored > 0 ? stored : null;
    })(),
  );

  /** Drag the channel/member divider to re-split the column */
  function beginDividerDrag(event: PointerEvent) {
    if (!channelScrollTarget) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = channelScrollTarget.getBoundingClientRect().height;
    // The column itself (SidebarBase) bounds how far down the divider can go;
    // always leave the member list a usable strip.
    const column = channelScrollTarget.parentElement!;

    const onMove = (e: PointerEvent) => {
      const ceiling = Math.max(column.getBoundingClientRect().height - 180, 48);
      setChannelListHeight(
        Math.min(Math.max(startHeight + (e.clientY - startY), 48), ceiling),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const height = channelListHeight();
      if (height != null) {
        localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(height)));
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** Reset the divider to the default automatic split */
  function resetDividerSplit() {
    setChannelListHeight(null);
    localStorage.removeItem(SPLIT_STORAGE_KEY);
  }

  // Server text channels host the member list at the bottom of this column
  // rather than in a right-hand one; the channel list has to stop growing
  // when it is there, otherwise it claims every spare pixel and leaves the
  // members scrolling inside a strip with dead space above it.
  //
  // Unless the layout setting (or the ultrawide layout, via "auto") has given
  // it its own column on the far side, in which case this column goes back to
  // being channels-only and the channel list gets the whole height. `TextChannel` reads the same condition from
  // the other side; exactly one of the two renders the list.
  //
  // Note this only stops *rendering* the divider — `channelListHeight` and its
  // localStorage entry are left alone, so the user's split comes back intact
  // when the layout turns off, including when it turns itself off because the
  // window got too narrow.
  //
  // Threads (forum posts included) are hosted here too. `TextChannel` used to
  // plant a member column beside every thread unconditionally; now that it
  // defers to the layout setting like a text channel does, this column has to
  // pick a thread up or a forum post would have no member list anywhere.
  //
  // The list sits OUTSIDE the channel's age/password/spoiler gates (those wrap
  // the channel pane), so it has to ask them itself: it used to render the
  // full roster of a mature channel right beside the "are you 18?" prompt.
  const showMemberList = () =>
    (selectedChannel()?.type === "TextChannel" ||
      !!selectedChannel()?.isThread) &&
    !sides().membersOwnColumn &&
    state.layout.getSectionState(LAYOUT_SECTIONS.MEMBER_SIDEBAR, true) &&
    !isGatedFor(state, selectedChannel()!);

  // Last scroll position the user actually chose.
  //
  // Deliberately *not* updated while the list has no overflow: the scroller is
  // content-sized under a 60% cap, and at the one transition where the content
  // falls below that cap `scrollHeight - clientHeight` is 0, so the browser
  // pins `scrollTop` to 0 and emits a scroll event carrying no intent. Letting
  // that event overwrite this — or clamping this into it on restore — is
  // exactly how the position is lost; instead it is kept until the list
  // overflows again and can hold it.
  let savedChannelScroll = 0;
  // The value our own restore wrote. Its echo scroll event must not be read
  // back as the user scrolling, or a partial shrink would ratchet the saved
  // position down.
  let writtenChannelScroll: number | null = null;
  // Largest offset the list could hold the last time either path looked at it.
  //
  // When the list gets shorter the browser clamps `scrollTop` onto the new
  // maximum by itself and queues a scroll event for it. That event can reach
  // us *before* the restore below does — scroll events are dispatched earlier
  // in a frame than resize-observer callbacks, and any layout read elsewhere
  // in the tick is enough to apply the clamp that early — so the save path
  // cannot rely on the restore having gone first and has to recognise a clamp
  // on its own.
  let lastChannelScrollMax = 0;

  function onChannelScroll() {
    const el = channelScrollTarget;
    if (!el) return;
    if (
      writtenChannelScroll !== null &&
      el.scrollTop === writtenChannelScroll
    ) {
      writtenChannelScroll = null;
      return;
    }
    const max = el.scrollHeight - el.clientHeight;
    const shrunk = max < lastChannelScrollMax;
    lastChannelScrollMax = max > 0 ? max : 0;
    // No overflow: this event carries no intent (see above).
    if (max <= 0) return;
    // The maximum just dropped and this event sits on it: that is the
    // browser's clamp, not a position the user chose. Saving it is precisely
    // the ratchet — the saved offset would be lowered by the height of the row
    // that vanished, and the restore would land short once it comes back. Only
    // the first event after the shrink is suppressed; `lastChannelScrollMax`
    // has caught up by the next one, so a genuine scroll to the bottom saves.
    //
    // Compared with a pixel of slack rather than for equality: `scrollHeight`
    // and `clientHeight` are rounded integers while `scrollTop` is a double,
    // so on a fractional layout (a non-integer device pixel ratio, a sub-pixel
    // row height) the real maximum the browser clamps onto is a fraction below
    // the integer `max` computed here and never compares equal to it. Strict
    // equality let exactly the clamp this line exists to suppress through.
    if (shrunk && el.scrollTop >= max - 1) return;
    savedChannelScroll = el.scrollTop;
  }

  // Puts the user back where they were after the scroller's content or its
  // viewport changed size.
  //
  // Driven by a `ResizeObserver` rather than by enumerating what can add a
  // row, because that enumeration was incomplete: besides the collapsed-
  // category filter, unread/ack churn and entering a thread, rows also come
  // from joined threads nested under a text channel or forum (a Join on a
  // forum post, a remote join/leave, an archive flip) and from
  // `VoiceChannelPreview` participant rows (anyone joining or leaving a voice
  // channel). None of those changed the old signature, so none of them
  // restored. A size change is the thing we actually care about, so observe
  // that directly.
  function restoreChannelScroll() {
    const el = channelScrollTarget;
    if (!el) return;
    // `ResizeObserver` callbacks run after layout, so these reads already see
    // the post-mutation heights.
    const max = el.scrollHeight - el.clientHeight;
    lastChannelScrollMax = max > 0 ? max : 0;
    // Content fits: 0 is the only position there is, and forcing it here would
    // be the same jump. Leave `savedChannelScroll` alone so it comes back when
    // the list overflows again.
    if (max <= 0) return;
    const target = Math.min(savedChannelScroll, max);
    const before = el.scrollTop;
    if (before !== target) el.scrollTop = target;
    const after = el.scrollTop;

    if (after !== before) {
      // We moved it; the scroll event that follows carries this value.
      writtenChannelScroll = after;
    } else if (savedChannelScroll > max) {
      // We wrote nothing, but the saved position no longer fits: the rows that
      // vanished took `max` below it, so the browser clamped `scrollTop` down
      // to `max` itself (the read above forces the layout that applies the
      // clamp) and has already queued the scroll event for that clamp. Arm the
      // guard on the clamped value so that event is not read back as the user
      // choosing a lower position — that is exactly how `savedChannelScroll`
      // gets ratcheted down by the height of the missing row, and the restore
      // then lands short once the row comes back.
      //
      // The cost is a guard that can sit armed when no echo was in fact coming
      // (the element already sat at `max` for another reason). It then
      // swallows at most one later scroll event landing on exactly this
      // offset, clearing itself as it does, and the next resize overwrites it
      // — strictly less drift than the ratchet it prevents.
      writtenChannelScroll = after;
    } else {
      // Nothing moved and nothing was clamped, so no echo is coming; a guard
      // left armed here would sit stale and swallow a real scroll.
      writtenChannelScroll = null;
    }
  }

  let channelScrollObserver: ResizeObserver | undefined;

  onMount(() => {
    channelScrollTarget?.addEventListener("scroll", onChannelScroll, {
      passive: true,
    });

    const el = channelScrollTarget;
    if (!el) return;

    // Two boxes matter. The `Draggable` wrapper is the only element child of
    // the scroller and holds every row, so its height is the content height.
    // The scroller itself is the viewport, which `showMemberList()` and a
    // divider drag both resize — that moves `max` without touching content.
    channelScrollObserver = new ResizeObserver(() => restoreChannelScroll());
    channelScrollObserver.observe(el);
    if (el.firstElementChild)
      channelScrollObserver.observe(el.firstElementChild);
  });

  onCleanup(() => {
    channelScrollTarget?.removeEventListener("scroll", onChannelScroll);
    channelScrollObserver?.disconnect();
  });

  // A different server is a different list; nothing to carry over.
  createEffect(
    on(
      () => props.server.id,
      () => {
        savedChannelScroll = 0;
        writtenChannelScroll = null;
        lastChannelScrollMax = 0;
      },
      { defer: true },
    ),
  );

  // Users can manage certain parts of the server individually, regardless of their ManageServer Permission.
  // Only gates the header settings gear; ViewAuditLog lets a role holding just that bit reach the audit log.
  const canManageServer = () =>
    props.server.orPermission(
      "ManageServer",
      "ManageCustomisation",
      "ManageRole",
      "ManagePermissions",
      "ViewAuditLog",
    );

  // TODO: this does not filter visible channels at the moment because the state for categories is not stored anywhere
  /** Gets a list of channels that are currently not hidden inside a closed category */
  const visibleChannels = () =>
    props.server.orderedChannels.flatMap((category) => category.channels);

  // TODO: when navigating channels, we want to add aria-keyshortcuts={localized-shortcut} to the next/previous channels
  // https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-keyshortcuts
  // TODO: issue warning if nothing is found somehow? warnings can be nicer than flat out not working
  // TODO: we want it to feel smooth when navigating through channels, so we'll want to select channels immediately but not actually navigate until we're done moving through them
  /** Navigates to the channel offset from the current one, wrapping around if needed */
  const _navigateChannel = (byOffset: number) => {
    if (props.channelId == null) return;

    const channels = visibleChannels();

    const currentChannelIndex = channels.findIndex(
      (channel) => channel.id === props.channelId,
    );

    // this will wrap the index around
    const nextChannel = channels.at(
      (currentChannelIndex + byOffset) % channels.length,
    );

    if (nextChannel) {
      navigate(`/server/${props.server.id}/channel/${nextChannel.id}`);
    }
  };

  // todo: I think these cause the infinite hang bug:

  // createKeybind(KeybindAction.NAVIGATION_CHANNEL_UP, () => navigateChannel(-1));

  // createKeybind(KeybindAction.NAVIGATION_CHANNEL_DOWN, () =>
  //   navigateChannel(1),
  // );

  createKeybind(KeybindAction.CHAT_MARK_SERVER_AS_READ, () => {
    if (props.server.unread) {
      props.server.ack();
    }
  });

  const noOrdering = () => !props.server.havePermission("ManageChannel");

  /**
   * Whether THIS server's channel list is in the mobile rearrange mode.
   *
   * Compared against the server id, never a boolean, because this component is
   * re-rendered with new props on a server switch rather than unmounted —
   * `src/interface/Sidebar.tsx:151-155` is a NON-KEYED `<Match
   * when={params.server}>`. A boolean would leak a mode (and, with it, a
   * staged order that belongs to another server's channels) straight into the
   * next server's sidebar.
   */
  const inReorderMode = () => reorderMode() === props.server.id;

  /**
   * The order being staged: category order plus each category's channel ids.
   *
   * A signal this component OWNS, deliberately not a derivation of the store.
   * Two reasons, both load-bearing:
   *
   * - `Draggable`'s items effect (`Draggable.tsx:517`) rewrites its rendered
   *   rows from `props.items` on every touch of anything that expression
   *   reads. `props.server.orderedChannels` is a getter recomputed on every
   *   access, over `channelIds` and `categories`, so any unrelated server
   *   traffic would snap a half-finished arrangement back.
   * - Nothing is written to the server until Save, so the staged order is the
   *   only place the user's work exists. It has to outlive every render.
   *
   * Seeded from RAW ids (see the seeding effect below), never from resolved
   * channels.
   */
  const [staged, setStaged] = createSignal<StagedCategory[]>([]);

  /**
   * Set when a staged session was thrown away because the channel list changed
   * underneath it; drives the notice that replaces the Save/Cancel bar.
   */
  const [discardedNotice, setDiscardedNotice] = createSignal(false);
  let discardedNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * True while our own Save is in flight.
   *
   * The `ServerUpdate` our save causes usually arrives over the websocket
   * BEFORE the PATCH's own response resolves, and the race watcher below would
   * read it as somebody else editing the server and bin the very reorder that
   * produced it. Plain `let`, not a signal: only event handlers read it.
   *
   * It is the ONLY suppressor on the `serverUpdate` half of that watcher, so a
   * value stuck at `true` is not a stuck save — it is a watcher switched off.
   * And "stuck" means stuck for the lifetime of the SIDEBAR, not of the
   * session: this component is not unmounted on a server switch (the non-keyed
   * `<Match when={params.server}>` at `src/interface/Sidebar.tsx:152`
   * re-renders it with new props), so a PATCH that never settles leaves every
   * later session on every server this component renders deaf to other
   * people's re-categorisation — and Save then writes a stale full-replace
   * array straight over their work. Hence both resets below.
   */
  let committing = false;

  /**
   * Fail-safe for the flag above.
   *
   * `onSettled` is the only thing that lowers it, and a request that never
   * settles never runs it, so the flag needs a way down that does not depend
   * on the network coming back.
   *
   * The window it actually has to cover is the gap between our PATCH leaving
   * and the `ServerUpdate` it causes arriving over the websocket — a second or
   * two. If a save really is slower than this, the cost is that its own echo
   * is read as somebody else's edit and the session is discarded WITH THE
   * NOTICE: visible, explained, and the save itself still lands. That is
   * strictly better than a permanently deaf watcher, which is silent and
   * overwrites other people's changes.
   */
  const COMMITTING_GUARD_MS = 15_000;
  let committingTimer: ReturnType<typeof setTimeout> | undefined;

  /** Suppress the race watcher for the duration of our own save */
  function beginCommitting() {
    committing = true;
    clearTimeout(committingTimer);
    committingTimer = setTimeout(() => {
      committing = false;
    }, COMMITTING_GUARD_MS);
  }

  /** Re-arm the race watcher */
  function endCommitting() {
    committing = false;
    clearTimeout(committingTimer);
  }

  /**
   * Throw a staged session away because the list it describes no longer
   * matches the server.
   *
   * Reordering on top of a channel that has been deleted (or missing one that
   * was just created) is worse than losing the arrangement, because Save is a
   * FULL REPLACE: `server.edit({ categories })` writes exactly the array it is
   * given, so a stale staged list would delete or strand real channels.
   */
  function discardStaged() {
    exitReorderMode();
    setStaged([]);
    setDiscardedNotice(true);
    clearTimeout(discardedNoticeTimer);
    discardedNoticeTimer = setTimeout(() => setDiscardedNotice(false), 8000);
  }

  onCleanup(() => {
    clearTimeout(discardedNoticeTimer);
    clearTimeout(committingTimer);
    // Same reason as the `props.server.id` effect below: neither of these is
    // keyed, and a retained batch pins a whole category array for as long as
    // the closure lives.
    desktopBatch = undefined;
    lastDesktopFlush = undefined;
  });

  // Seed on entry, drop on exit. The body of `on(...)` runs untracked, which
  // is exactly what we want: the seed is a SNAPSHOT of the server's raw state
  // at the moment the mode opens, and must not re-run when that state moves.
  createEffect(
    on(inReorderMode, (active) => {
      if (!active) {
        setStaged([]);
        return;
      }

      setDiscardedNotice(false);
      clearTimeout(discardedNoticeTimer);

      // A new session must not inherit the last one's suppression. If the
      // previous Save's PATCH never settled, `committing` is still true and
      // the race watcher armed below would ignore every `serverUpdate` for
      // this session too — silently, and for as long as the sidebar lives.
      endCommitting();

      // RAW ids only. `orderedChannels` resolves ids through
      // `client.channels`, and the client is only ever sent the channels the
      // viewer may see — so a staged list seeded from it silently omits every
      // hidden channel, and saving it (a full replace) evicts them from their
      // categories for everybody. `categories` + `channelIds` carry the ids
      // whether or not we can resolve them.
      setStaged(
        seedStaged(props.server.categories ?? [], [...props.server.channelIds]),
      );
    }),
  );

  /*
   * Leave the mode when this component is destroyed.
   *
   * It IS destroyed, on paths that have nothing to do with reordering. The
   * sidebar renders under `<Show when={showSidebar()}>`
   * (`src/interface/Sidebar.tsx:150`), and `showSidebar()`
   * (`src/interface/Sidebar.tsx:96-98`) is false whenever the primary sidebar
   * section is collapsed or the path starts with `/discover`; inside it, the
   * `<Match when={params.server}>` is false on a DM. So collapsing the
   * sidebar, opening Discover or opening a DM all dispose this component —
   * and the staged order lives ONLY here, so it dies with it.
   *
   * `reorderMode()` does not: it is a module-level signal
   * (`./reorderMode.ts`). Without this, coming back re-enters the mode, the
   * seed effect re-seeds from the server's current state, and the user is
   * shown a Save/Cancel bar over an arrangement that no longer exists —
   * pressing Save would write the order they never made. Neither the
   * `props.server.id` effect (`{ defer: true }`, and the id has not changed)
   * nor the seed effect covers this, because both are inside the component
   * that just went away.
   *
   * Exits SILENTLY, and the alternative is the dishonest one. The only notice
   * this component can show (`discardedNotice`) is rendered by this component,
   * so a notice raised during its own cleanup is never painted; surfacing one
   * would mean moving it into module state, where it would appear over an
   * unrelated screen — Discover, a DM — describing a sidebar the user is no
   * longer looking at. A silent exit at least matches what the user sees: the
   * rearrange UI left the screen together with the sidebar that hosted it, and
   * the next visit shows the server's real order rather than a bar over
   * nothing.
   *
   * Guarded on the id so a session another server's sidebar owns is never
   * cancelled from here.
   *
   * That guard reads a tracked LOCAL rather than `props.server`, and the
   * difference is a crash. `src/interface/Sidebar.tsx:242` passes
   * `server={server()}`, which babel-preset-solid compiles to a plain
   * NON-MEMOISED getter, so every read re-evaluates
   * `client()!.servers.get(params().serverId!)` (`Sidebar.tsx:216`). By the
   * time a cleanup runs, `useSmartParams` has already stopped matching
   * `RE_SERVER` (`components/routing/index.tsx:22`) on the Discover, DM and
   * Home paths, so `serverId` is undefined, `Collection.get` returns
   * undefined rather than throwing
   * (`packages/stoat.js/src/collections/Collection.ts:137-138`), and the `!`
   * is erased at runtime. Reading `props.server.id` here threw a
   * `TypeError` on two of the three paths this cleanup exists for.
   *
   * Nothing contained that throw. Solid runs cleanups LIFO and `cleanNode`
   * has no try/catch, so ONE throwing cleanup aborts every remaining one, and
   * no `ErrorBoundary` covers this subtree. It took the timer cleanup at
   * `:534` down with it, and the pre-existing scroll-listener plus
   * `ResizeObserver` cleanup at `:354` as well, leaking an observer that
   * pins the detached scroller and this whole closure.
   *
   * `props.server?.id` is NOT the fix. It silences the crash but compares
   * against undefined, which never equals a server id, so the mode would stay
   * open on exactly the two paths that motivated this cleanup.
   */
  // Seeded untracked on purpose: this read is a SNAPSHOT for the case where
  // the component is disposed before its first effect flushes, and the effect
  // below is what keeps it current. Without `untrack` the bare read makes
  // `solid/reactivity` warn that the change would be ignored, which here it
  // is not.
  let ownedServerId = untrack(() => props.server.id);
  createEffect(() => (ownedServerId = props.server.id));

  onCleanup(() => {
    if (reorderMode() === ownedServerId) exitReorderMode();
  });

  // A different server is a different list. The mode is keyed by id so the UI
  // has already stopped matching, but the module-level signal and the staged
  // array would both still be holding the previous server's session — and the
  // synthesised uncategorised category is hardcoded `id:"default"` on every
  // server, so a leaked staged entry would look like it belonged here.
  createEffect(
    on(
      () => props.server.id,
      (id) => {
        if (reorderMode() !== undefined && reorderMode() !== id)
          exitReorderMode();
        setStaged([]);
        setDiscardedNotice(false);
        clearTimeout(discardedNoticeTimer);
        // The desktop path is keyed by nothing, so it has to be dropped by
        // hand. Both of these describe the PREVIOUS server, and the seed
        // below chains from `lastDesktopFlush` for as long as a PATCH is
        // pending — which a hung request makes forever. Stamping the entry
        // stops it being USED here; clearing it stops it being held, and
        // stops a later return to that server resuming a batch the user
        // walked away from.
        desktopBatch = undefined;
        lastDesktopFlush = undefined;
      },
      { defer: true },
    ),
  );

  // Watch for the list changing underneath a staged session.
  //
  // Only mounted while the mode is open, so the ordinary sidebar pays nothing
  // for it. `channelIds` cannot stand in for the create half of this:
  // stoat.js never calls `channelIds.add` (`ChannelCollection.ts` only ever
  // deletes), so a new channel is invisible to any memo over that set until a
  // full rehydrate — the event is the only signal there is.
  createEffect(() => {
    if (!inReorderMode()) return;

    const liveClient = client();
    const serverId = props.server.id;

    /**
     * Somebody else re-ordered or re-categorised the server.
     * @param server the updated server
     * @param previousServer its state before the update
     */
    function onServerUpdate(
      server: { id: string; categories?: API.Category[] },
      previousServer: { categories?: API.Category[] },
    ) {
      if (server.id !== serverId || committing) return;
      // `ServerUpdate` fires for every field; only a categories change can
      // invalidate a staged order, and a rename or a banner swap must not
      // throw the user's work away.
      if (
        JSON.stringify(previousServer.categories) ===
        JSON.stringify(server.categories)
      )
        return;
      discardStaged();
    }

    /**
     * A channel appeared in or vanished from this server.
     * @param channel the channel, or (on delete) its final snapshot
     */
    function onChannelChange(channel: {
      serverId?: string;
      channelType?: string;
    }) {
      if (channel.serverId !== serverId) return;
      // Threads are never listed in a category, so they cannot invalidate an
      // ordering. Busy forums would otherwise cancel the mode constantly.
      if (channel.channelType === "Thread") return;
      discardStaged();
    }

    /**
     * `channelCreate` hands over a live `Channel`, whose thread test is a
     * getter rather than the hydrated `channelType` field.
     * @param channel the created channel
     */
    function onChannelCreate(channel: Channel) {
      onChannelChange({
        serverId: channel.serverId,
        channelType: channel.isThread ? "Thread" : undefined,
      });
    }

    liveClient.on("serverUpdate", onServerUpdate);
    liveClient.on("channelCreate", onChannelCreate);
    liveClient.on("channelDelete", onChannelChange);

    onCleanup(() => {
      liveClient.removeListener("serverUpdate", onServerUpdate);
      liveClient.removeListener("channelCreate", onChannelCreate);
      liveClient.removeListener("channelDelete", onChannelChange);
    });
  });

  /**
   * The categories as they should be RENDERED.
   *
   * Outside the mode this is the store's own view. Inside it, it is the staged
   * order resolved for display: ids we cannot resolve are dropped here and
   * here only — they stay in `staged()` and round-trip through Save untouched.
   */
  const displayCategories = createMemo<CategoryData[]>(() => {
    if (!inReorderMode()) return props.server.orderedChannels;

    const channels = client().channels;
    return staged().map((category) => ({
      id: category.id,
      title: category.title,
      channels: category.channels
        .map((id) => channels.get(id))
        .filter((channel): channel is Channel => !!channel),
    }));
  });

  /**
   * Put back the channels a drag could not have seen.
   *
   * `Draggable` reports the ids it RENDERED, and a category can hold ids the
   * viewer cannot resolve (a private channel). Handing that rendered list
   * straight to `applyMove` — which replaces a category's array wholesale —
   * would delete those ids from the category, which is the same data loss the
   * raw-id seeding exists to prevent, one level down.
   *
   * Survival is decided by membership of the rendered list, NOT by
   * resolvability, and the difference matters in both directions: an id that
   * resolves but is absent genuinely moved to another category and must go,
   * while an id that does not resolve was never on screen and must stay. A row
   * deleted between render and drop resolves to nothing yet is still in the
   * rendered list — testing membership first is what stops it being re-added
   * alongside itself as a duplicate, which the backend rejects outright.
   *
   * Hidden ids keep their place behind the last surviving id they followed, so
   * a reorder that never touched them does not visibly move them either.
   * @param previous this category's staged ids, before the drag
   * @param rendered the ids `Draggable` handed back
   */
  function reinsertUnrenderedChannels(
    previous: string[],
    rendered: string[],
  ): string[] {
    const channels = client().channels;
    const renderedIds = new Set(rendered);

    const head: string[] = [];
    const trailing = new Map<string, string[]>();
    let anchor: string | undefined;

    for (const id of previous) {
      if (renderedIds.has(id)) {
        anchor = id;
        continue;
      }
      if (channels.get(id)) continue; // on screen, and dragged elsewhere

      if (anchor === undefined) head.push(id);
      else trailing.set(anchor, [...(trailing.get(anchor) ?? []), id]);
    }

    if (head.length === 0 && trailing.size === 0) return rendered;

    // One pass places every hidden id there is. `trailing`'s keys are only
    // ever set while standing on an id that `renderedIds` contained, so each
    // key is met again while walking `rendered`; none can be left over.
    //
    // A second sweep used to sit here for "the anchor was itself dragged into
    // another category, so its hidden followers are homeless". That case
    // cannot occur: an id that left this category is absent from `rendered`,
    // and an id absent from `rendered` is never recorded as an anchor. A
    // hidden id whose visible predecessor moved away falls to the previous
    // surviving anchor instead, or to `head` when there is none.
    const merged = [...head];

    for (const id of rendered) {
      merged.push(id);
      const after = trailing.get(id);
      if (after) merged.push(...after);
    }

    return merged;
  }

  /**
   * Fold one drag result into a staged list.
   * @param list the staged list to apply it to
   * @param event the drag result
   */
  function applyOrderingEvent(
    list: StagedCategory[],
    event: OrderingEvent,
  ): StagedCategory[] {
    if (event.type === "categories") return applyCategoryOrder(list, event.ids);

    const previous =
      list.find((category) => category.id === event.id)?.channels ?? [];

    return applyMove(
      list,
      event.id,
      reinsertUnrenderedChannels(previous, event.channelIds),
    );
  }

  const commitOrdering = useMutation(() => ({
    mutationFn: (categories: CategoryPayload[]) =>
      props.server.edit({ categories }),
    // Every `server.edit()` ordering call in this file used to be un-awaited
    // with no `.catch()`, so a rejected reorder vanished without a trace.
    onError: showError,
  }));

  /**
   * The desktop drag path's in-flight edit, if a burst is being collected.
   *
   * A cross-category drop dispatches `finalize` to BOTH zones — the
   * destination first, then the origin — from one synchronous call
   * (`svelte-dnd-action/src/pointerAction.js`, `finalizeWithinZone`). Applying
   * only the first and committing would send a payload with the channel in two
   * categories at once, and the backend rejects the WHOLE edit with
   * `InvalidOperation` on a repeated id. So the burst is collected and flushed
   * in a microtask, which cannot run between two synchronous dispatches.
   *
   * This replaces the old `heldEvent`, which held the first event in a field
   * and waited for a partner that the `type:"categories"` path never cleared —
   * and since this component is never unmounted on a server switch, a held
   * move survived into the next server, where the synthetic uncategorised
   * category has the same hardcoded `id:"default"` and would happily absorb
   * it. Nothing is held here: a lone event flushes on its own.
   */
  let desktopBatch: StagedCategory[] | undefined;

  /**
   * The last batch `flushDesktopOrdering` actually sent.
   *
   * `Server.edit` writes the store only AFTER its PATCH resolves
   * (`packages/stoat.js/src/classes/Server.ts:434-447`), so between a flush
   * and its response `props.server.categories` still describes the PRE-drag
   * list. Seeding the next burst from it there replays the previous drag's
   * starting point: the channel that just moved is present in both its old and
   * its new category, `hasDuplicateChannel` trips, and the second drag is
   * discarded. Two quick desktop drags is all it takes.
   *
   * Only consulted while `commitOrdering.isPending`, so a FAILED commit is
   * never chained onto: once the mutation settles the store is authoritative
   * again — unchanged on failure, updated on success — and seeding goes back
   * to it. Nothing here mutates a category object (`applyMove` copies), so
   * sharing entries between this and `desktopBatch` cannot alias.
   *
   * STAMPED with the server it describes, because "in flight" is not the same
   * question as "the same list". This component is not remounted on a server
   * switch (non-keyed `<Show when={server()}>`; Solid compares `!a === !b`,
   * so truthy to truthy keeps the branch), and `server.edit({ categories })`
   * is a FULL REPLACE. An unstamped entry let a drag on server B chain onto
   * server A's list, and the PATCH — whose `mutationFn` reads
   * `props.server` at mutate time — wrote A's category ids and titles onto
   * B while deleting B's own, for everyone, with no undo. A hung PATCH pins
   * `isPending` true indefinitely, so one hang poisoned every later drag on
   * every server.
   */
  let lastDesktopFlush:
    | { serverId: string; list: StagedCategory[] }
    | undefined;

  /** Send the collected desktop burst as one edit */
  function flushDesktopOrdering() {
    const batch = desktopBatch;
    desktopBatch = undefined;
    if (!batch) return;

    // A real guard, not a formality — and REACHABLE, whatever the comment
    // that used to sit here claimed. The backend walks every category's
    // channels through one `HashSet` and rejects the WHOLE edit with
    // `InvalidOperation` on a repeated id, so sending one would lose the drag
    // anyway, with an error naming nothing.
    //
    // Reported rather than swallowed. A drag that silently does nothing and
    // then snaps back when an earlier response lands reads as the feature
    // being broken, and is exactly how the in-flight reseed above stayed
    // hidden. Not lingui-ised for the same reason as `ReorderNotice` below.
    if (hasDuplicateChannel(batch)) {
      showError(
        new Error(
          "That move could not be applied, because the channel list moved underneath it. Nothing was changed - try again.",
        ),
      );
      return;
    }

    lastDesktopFlush = { serverId: props.server.id, list: batch };
    commitOrdering.mutate(toEditPayload(batch).categories);
  }

  /**
   * Serialise a drag result — the one entry point for both paths.
   *
   * In the mobile reorder mode nothing is sent: the staged signal is the whole
   * effect, and Save is what reaches the server. On desktop the drag IS the
   * commit, so a freshly seeded list is mutated and flushed.
   * @param event the drag result
   */
  function handleOrdering(event: OrderingEvent) {
    if (inReorderMode()) {
      // `applyMove` returns the same array reference for a no-op, so a drag
      // that landed back where it started does not re-render the sidebar.
      setStaged((list) => applyOrderingEvent(list, event));
      return;
    }

    // A mobile drag must never reach the desktop commit path, even though
    // `inReorderMode()` is false by the time we get here. `discardStaged()`
    // flips the mode off, but a long-press drag finalises from a
    // `window.setTimeout(..., dropAnimationDurationMs)` and can land after
    // it; a WITHIN-category drag is a single event with no duplicate to trip
    // the guard below, so it would fall through and PATCH the server
    // immediately after the user was told their changes were discarded. On
    // mobile the drop zones are `disabled` outside the mode, so a drag
    // arriving here can only have started inside it.
    if (isMobile || noOrdering()) return;

    if (!desktopBatch) {
      // Seeded from RAW ids for the same reason the mobile path is: the
      // previous implementation built this from `orderedChannels` and so
      // deleted every channel the mover could not see out of its category.
      //
      // Unless our own last edit has not come back yet, in which case the
      // store still holds the PRE-drag list and seeding from it would replay a
      // move that has already been sent — see `lastDesktopFlush`.
      desktopBatch =
        commitOrdering.isPending &&
        lastDesktopFlush?.serverId === props.server.id
          ? lastDesktopFlush.list
          : seedStaged(props.server.categories ?? [], [
              ...props.server.channelIds,
            ]);
      queueMicrotask(flushDesktopOrdering);
    }

    desktopBatch = applyOrderingEvent(desktopBatch, event);
  }

  /**
   * Whether the staged order differs from what the server holds.
   *
   * Memoised because it is not cheap — a full re-seed of every category plus
   * two `JSON.stringify` of the whole channel list — and it is read from
   * `canSave()`, which `isDisabled={!canSave()}` re-runs on every touch of
   * `props.server.categories`, `props.server.channelIds` or `staged()`. On a
   * busy server that is every ack and every membership change.
   */
  const unsavedChanges = createMemo(
    () =>
      JSON.stringify(toEditPayload(staged())) !==
      JSON.stringify(
        toEditPayload(
          seedStaged(props.server.categories ?? [], [
            ...props.server.channelIds,
          ]),
        ),
      ),
  );

  /**
   * The staged list is holding one channel in two places at once.
   *
   * Transiently normal: in the mode every drag event is applied straight to
   * `staged()` with no coalescing, and a cross-category drop is TWO events —
   * the destination gains the channel before the origin loses it — dispatched
   * from one synchronous call, so nothing ever renders in between.
   *
   * Permanently, it is a wedge, and it is reachable: the library only
   * dispatches to the origin zone when the shadow ended up somewhere else, so
   * an origin that disappeared mid-drag (its category removed) leaves the
   * destination half applied on its own. `canSave()` is then false forever and
   * — before this — the bar showed a dead Save button and no reason at all,
   * with Cancel the only exit and nothing saying so.
   *
   * Deliberately NOT self-healed by dropping one of the two copies: which copy
   * is the wrong one is exactly what we do not know, and guessing moves a
   * channel the user never dragged. Saying so and offering Cancel is honest;
   * silently rearranging their server is not.
   */
  const stagedBlockedByDuplicate = createMemo(
    () => inReorderMode() && hasDuplicateChannel(staged()),
  );

  /**
   * Whether Save may be pressed.
   *
   * `hasDuplicateChannel` is a HARD precondition, not a nicety: the backend
   * walks every category's channels through one `HashSet` and rejects the
   * entire edit with `InvalidOperation` the moment an id repeats, so a single
   * duplicate would discard the user's whole rearrangement with an error that
   * names nothing.
   */
  const canSave = () =>
    !noOrdering() &&
    !stagedBlockedByDuplicate() &&
    unsavedChanges() &&
    !commitOrdering.isPending;

  /** Commit the staged order as a single edit */
  function saveOrdering() {
    if (!canSave()) return;

    beginCommitting();
    commitOrdering.mutate(toEditPayload(staged()).categories, {
      onSuccess: () => {
        exitReorderMode();
        setStaged([]);
        // A save slower than COMMITTING_GUARD_MS un-mutes the race watcher
        // mid-flight, so our OWN echoing `ServerUpdate` is read as somebody
        // else editing the server and `discardStaged()` raises the notice.
        // The work was not discarded - it was saved - so the notice must not
        // outlive the response it contradicts.
        setDiscardedNotice(false);
        clearTimeout(discardedNoticeTimer);
      },
      onSettled: endCommitting,
    });
  }

  /** Leave the mode, throwing the staged order away */
  function cancelOrdering() {
    exitReorderMode();
    setStaged([]);
  }

  return (
    <SidebarBase
      class="channel_bar server"
      use:floating={props.menuGenerator(props.server)}
    >
      <Switch
        fallback={
          <Header placement="secondary">
            <ServerInfo
              server={props.server}
              canManageServer={canManageServer()}
              openServerInfo={props.openServerInfo}
              openServerSettings={props.openServerSettings}
            />
          </Header>
        }
      >
        <Match when={props.server.banner}>
          <Header
            image
            placement="secondary"
            style={{
              background: `url('${props.server.bannerURL}')`,
            }}
          >
            <ServerInfo
              server={props.server}
              canManageServer={canManageServer()}
              openServerInfo={props.openServerInfo}
              openServerSettings={props.openServerSettings}
            />
          </Header>
        </Match>
      </Switch>
      <div
        ref={channelScrollTarget}
        use:invisibleScrollable
        style={{
          flex: showMemberList() ? "0 1 auto" : "1 1 auto",
          "min-height": 0,
          // A dragged divider position wins; otherwise content-sized with a
          // 60% cap while sharing the column, so the members always keep
          // a 40% floor on servers with a long channel list.
          height:
            showMemberList() && channelListHeight() != null
              ? `${channelListHeight()}px`
              : undefined,
          "max-height": showMemberList()
            ? channelListHeight() != null
              ? "none"
              : "60%"
            : "none",
          "margin-bottom": showMemberList() ? 0 : "var(--gap-md)",
        }}
        use:floating={props.menuGenerator(props.server)}
      >
        <Draggable
          dragHandles
          type="category"
          // A CONSTANT, and it has to stay one. `Draggable` captures this with
          // `untrack` inside `onMount`, which runs once, while the effect that
          // arms the zone re-runs: a reactive value here means either no
          // listener is ever attached (the feature silently does nothing) or —
          // worse — the zone is left armed with nothing to re-arm it, and the
          // library's non-passive `touchmove` `preventDefault`s every scroll
          // for the rest of the list's life. `useDevice().isMobile` is
          // assigned once from a UA test. A DEV `console.warn` fires if this
          // ever changes. The MODE is expressed through `disabled`, which is
          // reactive and re-read on every gesture.
          longPress={isMobile}
          // Must stay in lockstep with the channels zone inside `Category`:
          // `inNestedZone` (`Draggable.tsx:142`) suppresses this outer zone
          // whenever an inner `data-dnd-zone` is on the touch path, WITHOUT
          // asking whether that inner zone is itself accepting drags. If the
          // two expressions disagree there is a band of rows where the inner
          // one bails on `disabled` and this one bails on nesting, so a long
          // press does nothing at all and reads as flakiness. Both are `false`
          // in reorder mode and both `true` on mobile outside it. They do
          // differ on desktop with a collapsed category, which is inert:
          // `longPress` is false there, and `inNestedZone` is only consulted
          // from inside the long-press layer's `start()`.
          disabled={!inReorderMode() && (isMobile || noOrdering())}
          items={displayCategories()}
          onChange={(ids) => handleOrdering({ type: "categories", ids })}
        >
          {(entry) => (
            <Category
              server={props.server}
              category={entry.item}
              channelId={props.channelId}
              menuGenerator={props.menuGenerator}
              dragDisabled={entry.dragDisabled}
              setDragDisabled={entry.setDragDisabled}
              noOrdering={noOrdering}
              inReorderMode={inReorderMode}
              handleOrdering={handleOrdering}
            />
          )}
        </Draggable>
      </div>
      <Show when={showMemberList()}>
        <DividerHandle
          onPointerDown={beginDividerDrag}
          onDblClick={resetDividerSplit}
          title="Drag to resize, double-click to reset"
        />
        <div
          ref={memberScrollTarget}
          use:invisibleScrollable
          style={{
            // Zero flex-basis: the member list fills whatever the channel
            // list leaves over. With basis auto its content height entered
            // the flex-shrink math and shrank the channel scroller below its
            // specified height, so a drag re-reading the rendered height
            // made the divider leap on the first pixel of movement.
            flex: "1 1 0",
            "min-height": "48px",
            overflow: "auto",
          }}
        >
          <ServerMemberSidebar
            channel={selectedChannel()!}
            scrollTargetElement={memberScrollTarget!}
          />
        </div>
      </Show>
      {/*
        Last child of `SidebarBase` on purpose, and NOT between the channel
        scroller and `DividerHandle`: the divider's arithmetic assumes those
        two are the adjacent pair it is splitting, and a non-flexible element
        wedged in between would offset every drag. Both flexible siblings
        already have floors (`min-height: 0` on the scroller, `min-height:
        48px` on the members) and `beginDividerDrag` re-reads the column height
        live on every pointermove, so the divider cannot be dragged over this
        bar and the divider code needs no change. `SidebarBase` is a direct
        child of `MainBar`, which pads every child by
        `--layout-height-user-footer` (`src/interface/Sidebar.tsx:59-63`) to
        clear the floating user pill — padding on a flex container sits below
        its last item, so this bar lands above the pill rather than under it.
      */}
      <Show when={inReorderMode()}>
        {/*
          No `Row` here. `Row justify="stretch"` compiles to `& * { flex: 1 }`
          (`components/ui/components/layout/Row.tsx:37-41`), a DESCENDANT
          selector, so the `flex: 1` lands on the ripple, the label and every
          icon INSIDE each button as well as on the buttons. `ReorderBar` does
          the row itself, with a direct-child rule.
        */}
        <ReorderBar>
          <Button size="sm" variant="text" onPress={cancelOrdering}>
            <Trans>Cancel</Trans>
          </Button>
          <Show
            when={!stagedBlockedByDuplicate()}
            fallback={
              /*
                Why Save is gone, in the one place the user is looking for it.
                Same non-lingui reasoning as `ReorderNotice` below — a msgid
                absent from the compiled catalog renders as its raw hash.
              */
              <ReorderBlocked>
                That move could not be applied. Cancel to start again.
              </ReorderBlocked>
            }
          >
            <Button size="sm" onPress={saveOrdering} isDisabled={!canSave()}>
              <Trans>Save</Trans>
            </Button>
          </Show>
        </ReorderBar>
      </Show>
      <Show when={discardedNotice()}>
        {/*
          Deliberately NOT a lingui message. A msgid that is not in the
          compiled catalog renders as its raw hash, and the extract that would
          add one is a later task — shipping a hash to users is worse than
          shipping the untranslated English this file already ships in its
          tooltips and `title` attributes. Lingui-ise it in the same pass that
          does those.
        */}
        <ReorderNotice onClick={() => setDiscardedNotice(false)}>
          The channel list changed while you were rearranging, so your changes
          were discarded.
        </ReorderNotice>
      </Show>
    </SidebarBase>
  );
};

/**
 * Save/Cancel bar for the mobile rearrange mode.
 *
 * `styled("div", ...)`, and it has to be a STRING TAG. `styled(SomeComponent,
 * …)` from `styled-system/jsx` evaluates its argument at module scope, and
 * much of `components/ui` sits in an import cycle, so the reference lands in
 * the temporal dead zone and the whole bundle boots to a blank page with
 * `ReferenceError: Cannot access 'xr' before initialization`. `tsc`, `eslint`
 * and `vite build` are all green on it — this shipped once and was caught only
 * by loading the built page. Wrap `Row`/`Button` as children instead.
 */
const ReorderBar = styled("div", {
  base: {
    // `flex: 0 0 auto`, spelled out so the panda `flex` utility cannot
    // reinterpret the shorthand.
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container-low)",

    // The two buttons share the bar evenly. A DIRECT-CHILD selector, which is
    // the whole difference from `Row justify="stretch"`: that one is `& *`, so
    // it also stretches the ripple, the label and any icon inside each button.
    // It also has to be a nested selector rather than a prop, because `Button`
    // overwrites both `class` and `style`
    // (`components/ui/components/design/Button.tsx:132-146`) — and being
    // nested is what beats `Button`'s own `flexShrink: 0` on specificity
    // (0,1,1 against 0,1,0).
    "& > button": {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
    },
  },
});

/**
 * Stands in for Save when the staged order cannot be saved at all.
 *
 * See `stagedBlockedByDuplicate`. A string tag, for the reason spelled out on
 * `ReorderBar` above.
 */
const ReorderBlocked = styled("div", {
  base: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,

    display: "flex",
    alignItems: "center",
    color: "var(--md-sys-color-error)",

    ...typography.raw({ class: "label", size: "small" }),
  },
});

/**
 * Notice shown when a staged rearrangement had to be thrown away
 */
const ReorderNotice = styled("div", {
  base: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",

    padding: "var(--gap-md)",
    cursor: "pointer",
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",

    ...typography.raw({ class: "label", size: "small" }),
  },
});

/**
 * Server Information
 */
function ServerInfo(
  props: Pick<Props, "server" | "openServerInfo" | "openServerSettings"> & {
    canManageServer: boolean;
  },
) {
  const navigate = useNavigate();
  const [createAnchor, setCreateAnchor] = createSignal<HTMLDivElement>();
  return (
    <Row align grow minWidth={0}>
      <ServerBadge flags={props.server.flags} />
      <ServerName onClick={props.openServerInfo}>
        <TextWithEmoji content={props.server.name} />
      </ServerName>
      <Show when={props.server.havePermission("ManageChannel")}>
        <div ref={setCreateAnchor} style={{ display: "flex" }}>
          <IconButton
            size="xs"
            width="narrow"
            variant={props.server.banner ? "_header" : "standard"}
            use:floating={{
              tooltip: { placement: "bottom", content: "Create" },
            }}
          >
            <Symbol>add</Symbol>
          </IconButton>
        </div>
        <HeaderCreateMenu server={props.server} anchor={createAnchor} />
      </Show>
      <IconButton
        size="xs"
        width="narrow"
        variant={props.server.banner ? "_header" : "standard"}
        onPress={() => navigate(`/server/${props.server.id}/events`)}
        use:floating={{
          tooltip: { placement: "bottom", content: "Server Events" },
        }}
      >
        <Symbol>calendar_month</Symbol>
      </IconButton>
      <Show when={props.canManageServer}>
        <IconButton
          size="xs"
          width="narrow"
          variant={props.server.banner ? "_header" : "standard"}
          onPress={props.openServerSettings}
        >
          <MdSettings {...symbolSize(24)} />
        </IconButton>
      </Show>
    </Row>
  );
}

/**
 * Dropdown behind the header "+": create a channel (goes uncategorised
 * unless the picker says otherwise) or a category. Click-opened floating
 * menus follow the UserMenu anchor/portal pattern.
 */
function HeaderCreateMenu(props: {
  server: Server;
  anchor: Accessor<HTMLDivElement | undefined>;
}) {
  const { openModal } = useModals();
  const [show, setShow] = createSignal(false);
  const [ref, setRef] = createSignal<HTMLDivElement>();

  const position = useFloating(() => props.anchor(), ref, {
    placement: "bottom-start",
    whileElementsMounted: autoUpdate,
    middleware: [offset(5), flip(), shift({ padding: 8 })],
  });

  function toggle() {
    setShow((v) => !v);
  }

  function close() {
    setShow(false);
  }

  function onMouseDown(event: MouseEvent) {
    const target = event.target as Node;
    // The anchor's own click handler toggles; only close for true
    // outside clicks.
    if (props.anchor()?.contains(target)) return;
    close();
  }

  onMount(() => document.addEventListener("mousedown", onMouseDown));
  onCleanup(() => document.removeEventListener("mousedown", onMouseDown));

  createEffect(
    on(
      () => props.anchor(),
      (anchor) => {
        if (anchor) {
          anchor.addEventListener("click", toggle);
          onCleanup(() => anchor.removeEventListener("click", toggle));
        }
      },
    ),
  );

  return (
    <Portal mount={document.getElementById("floating")!}>
      <Presence>
        <Show when={show()}>
          <Motion
            ref={setRef}
            style={{
              position: position.strategy,
              top: `${position.y ?? 0}px`,
              left: `${position.x ?? 0}px`,
            }}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, easing: [0.87, 0, 0.13, 1] }}
          >
            <ContextMenu>
              <ContextMenuButton
                icon={<Symbol size={16}>add</Symbol>}
                onClick={() => {
                  close();
                  openModal({ type: "create_channel", server: props.server });
                }}
              >
                <Trans>Create channel</Trans>
              </ContextMenuButton>
              <ContextMenuButton
                icon={MdLibraryAdd}
                onClick={() => {
                  close();
                  openModal({ type: "create_category", server: props.server });
                }}
              >
                <Trans>Create category</Trans>
              </ContextMenuButton>
            </ContextMenu>
          </Motion>
        </Show>
      </Presence>
    </Portal>
  );
}

/**
 * Grabbable divider between the channel list and the member list; doubles as
 * the visual separator the member list used to draw with border-top.
 */
const DividerHandle = styled("div", {
  base: {
    flexShrink: 0,
    height: "9px",
    display: "flex",
    alignItems: "center",
    cursor: "ns-resize",
    touchAction: "none",
    userSelect: "none",

    "&::after": {
      content: '""',
      flexGrow: 1,
      height: "1px",
      borderRadius: "2px",
      background: "var(--md-sys-color-outline-variant)",
      transition: "var(--transitions-fast) all",
    },

    "&:hover::after, &:active::after": {
      height: "3px",
      background: "var(--md-sys-color-outline)",
    },
  },
});

/**
 * Server name
 */
const ServerName = styled("a", {
  base: {
    flexGrow: 1,
    minWidth: 0,

    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

/**
 * Server badge
 */
function ServerBadge(props: { flags: ServerFlags }) {
  const { t } = useLingui();

  return (
    <Show when={props.flags}>
      <Tooltip
        content={props.flags === 1 ? t`Official Server` : t`Verified`}
        placement="top"
      >
        {props.flags === 1 ? (
          <BiSolidCheckCircle size={12} />
        ) : (
          <BiRegularCheckCircle size={12} />
        )}
      </Tooltip>
    </Show>
  );
}

/**
 * Single category entry
 */
function Category(
  props: {
    server: Server;
    category: CategoryData;
    channelId: string | undefined;
    noOrdering: Accessor<boolean>;
    inReorderMode: Accessor<boolean>;
    handleOrdering: (event: OrderingEvent) => void;
  } & Pick<Props, "menuGenerator"> & {
      dragDisabled: Accessor<boolean>;
      setDragDisabled: Setter<boolean>;
    },
) {
  const state = useState();
  const isOpen = () => state.layout.getSectionState(props.category.id, true);
  const { isMobile } = useDevice();
  const { openModal } = useModals();

  // A collapsed category renders only its unread/active channels. Handing that
  // filtered list to a drop zone would write it back as the category's WHOLE
  // channel array on the next drag, silently deleting every channel the filter
  // hid — so in reorder mode every category renders expanded and unfiltered,
  // and the `disabled` expression below refuses drags on a filtered list
  // anywhere else.
  const channels = createMemo(() =>
    props.inReorderMode()
      ? props.category.channels
      : props.category.channels.filter(
          (channel) =>
            props.category.id === "default" ||
            isOpen() ||
            channel.unread ||
            channel.id === props.channelId,
        ),
  );

  return (
    <CategorySection>
      <Show when={props.category.id !== "default"}>
        <div use:floating={props.menuGenerator(props.category as never)}>
          <CategoryBase
            // Forced open in reorder mode so the chevron matches the rows that
            // are actually on screen.
            open={props.inReorderMode() ? true : isOpen()}
            onClick={() => {
              // RENDER-ONLY EXPANSION, IN BOTH DIRECTIONS. This handler writes
              // PERSISTED layout state (`State.write` queues a
              // `localforage.setItem`), so a tap on a header while rearranging
              // would collapse the category in the store and the user would
              // find it collapsed once they saved — a change they never asked
              // for, made by a gesture that looked like nothing happened.
              if (props.inReorderMode()) return;
              state.layout.toggleSectionState(props.category.id, true);
            }}
            {...createDragHandle(props.dragDisabled, props.setDragDisabled)}
          >
            {props.category.title}
            <MdChevronRight {...iconSize(12)} />
            <Show
              when={!isMobile && props.server.havePermission("ManageChannel")}
            >
              <a
                class="category-add"
                use:floating={{
                  tooltip: { placement: "top", content: "Create Channel" },
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openModal({
                    type: "create_channel",
                    server: props.server,
                    categoryId: props.category.id,
                  });
                }}
              >
                <Symbol size={16}>add</Symbol>
              </a>
            </Show>
          </CategoryBase>
        </div>
      </Show>
      <Draggable
        type="channels"
        // Constant, exactly as on the categories zone above — see the comment
        // there for what a reactive value does to the press-and-hold layer.
        longPress={isMobile}
        items={channels()}
        onChange={(channelIds) => {
          props.handleOrdering({
            type: "category",
            id: props.category.id,
            channelIds,
          });
        }}
        // Kept in lockstep with the categories zone in `ServerSidebar`; see the
        // `inNestedZone` note there for what a disagreement costs. `!isOpen()`
        // is what stops a drag ever rewriting the filtered list a collapsed
        // category renders, and it is deliberately not consulted in reorder
        // mode, where nothing is filtered.
        disabled={
          props.inReorderMode()
            ? false
            : isMobile || props.noOrdering() || !isOpen()
        }
        minimumDropAreaHeight="32px"
      >
        {(entry) => (
          <Entry
            channel={entry.item}
            active={entry.item.id === props.channelId}
            channelId={props.channelId}
            reordering={props.inReorderMode()}
            menuGenerator={props.menuGenerator}
          />
        )}
      </Draggable>
    </CategorySection>
  );
}

const CategorySection = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    flexDirection: "column",
    paddingBlock: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-sm)",
    background: "var(--md-sys-color-surface-container-low)",
  },
});

/**
 * Category title styling
 */
const CategoryBase = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",

    padding: "0 var(--gap-sm)",
    paddingLeft: "calc(var(--gap-lg) + 5px)",
    paddingTop: "10px",

    cursor: "pointer",
    userSelect: "none",
    transition: "var(--transitions-fast) all",

    "--color": "var(--md-sys-color-on-surface)",
    color: "var(--color)",
    fill: "var(--color)",

    ...typography.raw({ class: "label", size: "small" }),
    fontSize: "13px",

    "&:hover": {
      "--color": "var(--md-sys-color-on-surface-variant)",
    },

    "& svg": {
      transition: "var(--transitions-fast) transform",
    },

    // Discord-style create-channel action, revealed on header hover; sits at
    // the far end of the row so the toggle chevron keeps its place.
    "& .category-add": {
      display: "flex",
      alignItems: "center",
      marginInlineStart: "auto",
      opacity: 0,
      transition: "var(--transitions-fast) opacity",
    },

    "&:hover .category-add": {
      opacity: 1,
    },
  },
  variants: {
    open: {
      true: {
        "& svg": {
          transform: "rotateZ(90deg)",
        },
      },
    },
  },
});

/**
 * Server channel entry
 */
function Entry(
  props: {
    channel: Channel;
    active: boolean;
    channelId: string | undefined;
    /** Whether the sidebar is in the mobile rearrange mode */
    reordering: boolean;
  } & Pick<Props, "menuGenerator">,
) {
  const state = useState();
  const voice = useVoice();
  const client = useClient();
  const { openModal } = useModals();
  const { isMobile } = useDevice();
  const snackbar = useSnackbar();
  const { t } = useLingui();

  /**
   * Whether a voice-member drag is hovering this row (see `voiceMoveDrop`)
   */
  const [dropHover, setDropHover] = createSignal(false);

  // A new drag, or the source clearing the old one on `dragend`, starts every
  // row unhighlighted. Without this, a row whose `dragleave` never arrived
  // would light up the moment the NEXT drag began, before the pointer was
  // anywhere near it.
  createEffect(
    on(draggedVoiceParticipant, () => setDropHover(false), { defer: true }),
  );

  /**
   * Highlight only while a voice-member drag is actually in flight
   */
  const dropActive = () => dropHover() && !!draggedVoiceParticipant();

  /**
   * The voice member being dragged, if this row may take the drop.
   *
   * Drag-to-move (`voiceMoveDrag.ts`): a participant row out of another
   * voice channel's preview in THIS server, dropped here, moves that member
   * here. Undefined for every other drag, which this row must then leave
   * completely alone: the channel reorder, a file drop, a text selection.
   *
   * The module signal says WHO is being dragged; the MIME type in
   * `dataTransfer.types` says this drag is the one that set it. The signal
   * alone can be stale (its source row unmounted mid-drag, so `dragend` never
   * cleared it), and a stale signal must not turn an unrelated drag into a
   * move.
   *
   * The destination checks mirror `moveTargets` so the row never lights up
   * for a move the server is sure to refuse. MoveMembers in the SOURCE and
   * outranking the target were the source row's gate before it let the drag
   * start (`canDragParticipant`). None of this is authorization; the server
   * decides.
   */
  function voiceMoveDrop(e: DragEvent) {
    const types = e.dataTransfer?.types;
    // `types` is a plain array today but a DOMStringList in older engines
    if (!types || !Array.prototype.includes.call(types, VOICE_MOVE_MIME))
      return undefined;

    const dragged = draggedVoiceParticipant();
    const channel = props.channel;
    if (!dragged || props.reordering) return undefined;
    if (!channel.isVoice || !channel.serverId) return undefined;
    if (dragged.serverId !== channel.serverId) return undefined;

    // A channel still behind its gate isn't one we've entered: its roster is
    // hidden below, and a double-click won't join it either.
    if (isGatedFor(state, channel)) return undefined;

    const allowed = moveTargets([channel], {
      currentChannelId: dragged.fromChannelId,
      isSelf: dragged.userId === client().user?.id,
      isVoice: (c) => c.isVoice && !!c.serverId,
      canConnect: (c) => c.havePermission("Connect"),
      canMoveMembers: (c) => c.havePermission("MoveMembers"),
    });
    return allowed.length ? dragged : undefined;
  }

  /**
   * `dragenter` / `dragover`: claim a voice-member drag this row can take.
   * Any other drag is not cancelled, so it carries on exactly as before.
   */
  function onVoiceMoveDragOver(e: DragEvent) {
    if (!voiceMoveDrop(e)) {
      setDropHover(false);
      return;
    }

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropHover(true);
  }

  /**
   * `dragleave` fires on every child the pointer crosses, so only a leave
   * to somewhere outside this row clears the highlight. Where an engine
   * reports no `relatedTarget` (older WebKit), this clears on each crossing
   * and the next `dragover` puts it straight back. A cancelled drag (Esc)
   * ends with a `dragleave` whose `relatedTarget` is null, so it clears too.
   */
  function onVoiceMoveDragLeave(e: DragEvent) {
    const zone = e.currentTarget;
    const into = e.relatedTarget;
    if (zone instanceof Node && into instanceof Node && zone.contains(into))
      return;
    setDropHover(false);
  }

  /**
   * Move the dragged member into this voice channel
   */
  function onVoiceMoveDrop(e: DragEvent) {
    setDropHover(false);

    const dragged = voiceMoveDrop(e);
    if (!dragged) return;
    // `getData` is readable only now, at the drop. Require it to name the
    // same member as the signal, so only the drag that set the signal can
    // act on it (the server stays the authority either way).
    if (e.dataTransfer?.getData(VOICE_MOVE_MIME) !== dragged.userId) return;

    e.preventDefault();
    setDraggedVoiceParticipant(undefined);

    const channelId = props.channel.id;
    const isSelf = dragged.userId === client().user?.id;

    // `fetch` returns the cached member when it is fully loaded and asks the
    // server otherwise. Nothing in the voice path fills that cache, so a
    // participant can easily be unknown here (see `callMember` in
    // UserContextMenu).
    client()
      .serverMembers.fetch(dragged.serverId, dragged.userId)
      .then((member) => member.moveToVoiceChannel(channelId))
      .catch((err: unknown) => {
        const kind = moveRefusalKind(err);
        // The kind only, never the rejection itself: its shape belongs to
        // the request layer (stoat-api 0.13 throws the response body), so
        // nothing here can promise it holds no credential.
        console.warn("[voice-move] drag-to-move refused:", kind);
        snackbar.show({ message: moveRefusedMessage(kind, isSelf) });
      });
  }

  /**
   * What a refused drag-to-move tells the mover. The member menus' Move
   * entries (UserContextMenu) show exactly the same strings for the same
   * refusals, whichever way the move was asked for.
   *
   * The copy for moving someone else who isn't in a call is worded so it
   * never says whether they are in one the mover can't see.
   */
  function moveRefusedMessage(kind: MoveRefusalKind, isSelf: boolean) {
    if (isSelf) {
      switch (kind) {
        case "cannot-join":
          return t`You can't join that call right now. It may be full, or you may not be able to connect to it.`;
        case "not-connected":
          return t`You're not in a voice call you can move from.`;
        case "not-authenticated":
          return t`You can only move yourself from the device that's in the call.`;
        case "server-error":
          return t`Something went wrong on our end. Try again in a moment.`;
        case "target-cannot-view":
        case "is-bot":
        case "other":
          return t`Couldn't move you to that channel.`;
        default: {
          const unhandled: never = kind;
          return unhandled;
        }
      }
    }

    switch (kind) {
      case "target-cannot-view":
        return t`They can't see that channel, so they can't be moved there.`;
      case "is-bot":
        return t`Bots can't be moved between voice channels.`;
      case "cannot-join":
        return t`They can't join that call right now. It may be full, or they may not be able to connect to it.`;
      case "not-connected":
        return t`They're not in a voice call you can move them from.`;
      case "server-error":
        return t`Something went wrong on our end. Try again in a moment.`;
      case "not-authenticated":
      case "other":
        return t`Couldn't move them. They may have left the call, or you may not have permission.`;
      default: {
        const unhandled: never = kind;
        return unhandled;
      }
    }
  }

  // Joined, non-archived threads hanging off this channel — nested below it.
  // Membership is seeded from Ready (joined threads only) and kept live by
  // ThreadMemberJoin/Leave events, so unread state never surfaces for
  // threads the user hasn't joined. Forum posts are threads too, so joined
  // posts nest under their forum the same way.
  const joinedThreads = createMemo(() => {
    const selfId = client().user?.id;
    if (
      !selfId ||
      (props.channel.type !== "TextChannel" && props.channel.type !== "Forum")
    )
      return [];
    return client()
      .channels.filter(
        (channel) =>
          channel.isThread &&
          channel.parentChannelId === props.channel.id &&
          !channel.archived &&
          channel.threadMembers.has(selfId),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  });

  const canEditChannel = createMemo(() =>
    (["ManageChannel", "ManagePermissions", "ManageWebhooks"] as const).some(
      (perm) => props.channel.server?.havePermission(perm),
    ),
  );

  const canInvite = createMemo(() =>
    props.channel.server?.havePermission("InviteOthers"),
  );

  const alertState = createMemo(
    () =>
      !props.active &&
      props.channel.unread &&
      // A zero count means the server never supplied one — fall back to the
      // plain dot rather than rendering a "0"
      (props.channel.unreadCount || true),
  );

  const alertTone = createMemo(() =>
    unreadTone(
      props.channel.mentions?.size ?? 0,
      props.channel.unreadHasAttachments,
    ),
  );

  const inCall = () => props.channel.id === voice.channel()?.id;

  /**
   * Whether this is the server's designated AFK channel, which is what the
   * muted-mic icon means.
   *
   * This used to key off the channel NAME (`name?.toLowerCase() === "afk"`), so
   * renaming any channel to "afk" earned the icon, renaming the real one lost
   * it, and "AFK Channel" or "💤 AFK" got nothing — while the server muted a
   * completely different channel. An accessor rather than a value so a
   * designation change repaints without a reload.
   */
  const isAfkVoiceChannel = () =>
    isAfkChannel(props.channel.server?.afkChannelId, props.channel.id);

  /**
   * Double-click a voice channel to join it, skipping the two-step the
   * channel list otherwise forces: open the channel, then press the call
   * button in the header. The first click of the pair keeps its own
   * meaning (it navigates), so this only ever ADDS the join — which is
   * also why the setting can be turned off without changing anything
   * else about the row.
   *
   * Deliberately inert when a join for this channel is already in flight
   * or a terminal refusal holds (`joinBlocked`, joinRefusalPolicy): the
   * header buttons disable on exactly that, and a double-click is the
   * easiest affordance in the app to fire twice by accident.
   */
  function onDoubleClick(e: MouseEvent) {
    // Rearranging must not be able to join a call. Two taps in quick
    // succession are exactly what a failed drag looks like.
    if (props.reordering) return;

    // Nor may it join past a gate. The first click of the pair has already
    // opened the channel, so the gate is on screen; joining is for after it.
    if (isGatedFor(state, props.channel)) return;

    const join = shouldJoinOnDoubleClick({
      isVoiceChannel: props.channel.isVoice,
      settingEnabled: state.voice.joinVoiceOnDoubleClick,
      canConnect: !!props.channel.havePermission("Connect"),
      alreadyInThisCall: inCall(),
      joinBlocked: !!voice.joinBlocked(props.channel),
    });
    if (!join) return;

    e.preventDefault();
    void voice.connect(props.channel);
  }

  // Colour of the mic icon while we're connected to this voice channel.
  // Deliberately not --md-sys-color-primary: the theme sets that to the same
  // #00B2FF as --md-sys-color-primary-container, which is the selected-channel
  // pill background, so the icon vanished into the highlight whenever you were
  // viewing the channel you had joined. On the pill we fall back to the pill's
  // own foreground; everywhere else we use the online-presence green.
  const inCallIconColour = () =>
    props.active
      ? "var(--md-sys-color-on-primary-container)"
      : "var(--brand-presence-online)";

  const attentionState = createMemo(() =>
    props.active
      ? "selected"
      : inCall()
        ? "active"
        : state.notifications.isChannelMuted(props.channel)
          ? "muted"
          : props.channel.unread
            ? "active"
            : "normal",
  );

  return (
    <Column
      gap="sm"
      // The whole block takes a voice-member drop: the row and the roster
      // under it. Inert for every other drag and for non-voice channels.
      class={
        props.channel.isVoice
          ? voiceDropTarget({ hover: dropActive() })
          : undefined
      }
      onDragEnter={onVoiceMoveDragOver}
      onDragOver={onVoiceMoveDragOver}
      onDragLeave={onVoiceMoveDragLeave}
      onDrop={onVoiceMoveDrop}
    >
      <MenuButton
        // No navigation while rearranging. A plain tap on a row is easy to
        // land during a drag, and on a phone following the link ALSO slides
        // the drawer shut (`MenuButton`'s own `onClick` calls
        // `appDrawer()?.setShown(true)`), which takes the Save/Cancel bar off
        // screen with staged work still live and no obvious way back to it.
        //
        // But the `href` STAYS. Dropping it was the old way of doing this, and
        // it took the row out of the keyboard and screen-reader order with it:
        // `MenuButton`'s no-href branch renders a bare `<div>` with no
        // `tabindex`, no `role` and no `aria-*`
        // (`components/ui/components/design/MenuButton.tsx:114-130`), so the
        // whole channel list became mouse-only for as long as the mode was
        // open. Cancelling the click covers both halves instead:
        //
        //  - navigation: `@solidjs/router`'s document-level
        //    `handleAnchorClick` bails on `evt.defaultPrevented`
        //    (`@solidjs/router/dist/index.js:1394-1395`), and it is registered
        //    AFTER Solid's delegated click dispatch (`:1464-1465`, "ensure
        //    delegated event run first"), so this `preventDefault` has already
        //    run by the time it looks. It also stops the browser following the
        //    `<a>` itself, which is what covers ctrl/cmd-click — there the
        //    router bails anyway.
        //  - the drawer: `MenuButton` only calls `appDrawer()?.setShown(true)`
        //    when `!local.noDrawer` (`MenuButton.tsx:83-87`), so `noDrawer`
        //    below still suppresses the slide-out, exactly as before.
        //  - the iOS callout: with the link back, a press-and-hold on a phone
        //    is a press-and-hold ON A LINK, and iOS answers it with its own
        //    preview/share sheet — over the very gesture that picks the row up
        //    (`Draggable`'s press-and-hold layer is the only way to drag
        //    on mobile). Android raises that as `contextmenu`, which
        //    `Draggable` already vetoes
        //    (`components/ui/components/utils/Draggable.tsx:289-303`); iOS
        //    raises no event to veto, so the property is the only lever
        //    left. Scoped to the mode, so an ordinary row keeps the
        //    platform's normal long-press behaviour on a link.
        style={
          props.reordering ? { "-webkit-touch-callout": "none" } : undefined
        }
        href={`/server/${props.channel.serverId}/channel/${props.channel.id}`}
        noDrawer={props.reordering}
        onClick={(event: MouseEvent) => {
          if (props.reordering) event.preventDefault();
        }}
        onDblClick={onDoubleClick}
        use:floating={props.menuGenerator(props.channel)}
        size="normal"
        alert={alertState()}
        alertTone={alertTone()}
        attention={attentionState()}
        icon={
          <>
            <Switch fallback={<Symbol>edit</Symbol>}>
              <Match when={props.channel.isVoice}>
                <Symbol color={inCall() ? inCallIconColour() : undefined}>
                  {isAfkVoiceChannel() ? "mic_off" : "mic"}
                </Symbol>
              </Match>
              <Match when={props.channel.type === "Forum"}>
                <Symbol>forum</Symbol>
              </Match>
              <Match when={props.channel.isAnnouncement}>
                <Symbol>campaign</Symbol>
              </Match>
            </Switch>
            <Show when={props.channel.icon}>
              <ChannelIcon
                src={props.channel.iconURL}
                css={{ marginEnd: "0.2em" }}
              />
            </Show>
            {/* The lock says the channel HAS a password, whether or not this
                member has passed it, so this is not `isGatedFor`. These rows
                are never threads, so there is no parent to resolve. */}
            <Show
              when={
                parseChannelPassword(props.channel.description).passwordHash
              }
            >
              <Symbol size={14} style={{ opacity: "0.6" }}>
                lock
              </Symbol>
            </Show>
          </>
        }
        actions={
          <Show when={!isMobile}>
            <Show when={canInvite()}>
              <a
                use:floating={{
                  tooltip: { placement: "top", content: "Create Invite" },
                }}
                onClick={(e) => {
                  e.preventDefault();
                  openModal({
                    type: "create_invite",
                    channel: props.channel,
                  });
                }}
              >
                <Symbol size={16} fill>
                  person_add
                </Symbol>
              </a>
            </Show>
            <Show when={canEditChannel()}>
              <a
                use:floating={{
                  tooltip: { placement: "top", content: "Edit Channel" },
                }}
                onClick={(e) => {
                  e.preventDefault();
                  openModal({
                    type: "settings",
                    config: "channel",
                    context: props.channel,
                  });
                }}
              >
                <Symbol size={16} fill>
                  settings
                </Symbol>
              </a>
            </Show>
          </Show>
        }
      >
        <OverflowingText>
          <TextWithEmoji content={props.channel.name!} />
        </OverflowingText>
      </MenuButton>

      {/* Who is in the call is the channel's content too: hidden behind its
          gate, unless this device is already in that call. */}
      <Show when={inCall() || !isGatedFor(state, props.channel)}>
        <VoiceChannelPreview channel={props.channel} />
      </Show>

      <For each={joinedThreads()}>
        {(thread) => {
          const threadActive = () => thread.id === props.channelId;
          const threadAlert = () =>
            !threadActive() && thread.unread && (thread.unreadCount || true);
          const threadTone = () =>
            unreadTone(thread.mentions?.size ?? 0, thread.unreadHasAttachments);

          return (
            <ThreadNest>
              <MenuButton
                // Same reasoning as the channel row above, accessibility
                // included: a nested thread is part of a draggable row, so a
                // tap on it while rearranging must not navigate away or close
                // the drawer — but it must stay focusable, so the link stays
                // and the click is cancelled instead.
                // iOS callout suppressed for the same reason as above.
                style={
                  props.reordering
                    ? { "-webkit-touch-callout": "none" }
                    : undefined
                }
                href={`/server/${thread.serverId}/channel/${thread.id}`}
                noDrawer={props.reordering}
                onClick={(event: MouseEvent) => {
                  if (props.reordering) event.preventDefault();
                }}
                use:floating={props.menuGenerator(thread)}
                size="normal"
                alert={threadAlert()}
                alertTone={threadTone()}
                attention={
                  threadActive()
                    ? "selected"
                    : state.notifications.isMuted(thread)
                      ? "muted"
                      : thread.unread
                        ? "active"
                        : "normal"
                }
                icon={<Symbol size={16}>subdirectory_arrow_right</Symbol>}
              >
                <OverflowingText>
                  <TextWithEmoji content={thread.name!} />
                </OverflowingText>
              </MenuButton>
            </ThreadNest>
          );
        }}
      </For>
    </Column>
  );
}

/**
 * A voice channel's block while a dragged voice member hovers it
 * (drag-to-move, `voiceMoveDrag.ts`). No `false` variant on purpose: an
 * idle block looks exactly as it did before.
 */
const voiceDropTarget = cva({
  base: {
    borderRadius: "var(--borderRadius-lg)",
    outline: "2px solid transparent",
    outlineOffset: "-2px",
    transition:
      "var(--transitions-fast) background-color, var(--transitions-fast) outline-color",
  },
  variants: {
    hover: {
      true: {
        outlineColor: "var(--md-sys-color-primary)",
        background:
          "color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)",
      },
    },
  },
});

/**
 * Indentation wrapper for threads nested under their parent channel
 */
const ThreadNest = styled("div", {
  base: {
    paddingLeft: "var(--gap-lg)",
  },
});

/**
 * Channel icon styling
 */
const ChannelIcon = styled("img", {
  base: {
    width: "16px",
    height: "16px",
    objectFit: "contain",
  },
});

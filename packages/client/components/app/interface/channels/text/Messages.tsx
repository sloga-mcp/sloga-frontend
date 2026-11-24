import {
  Accessor,
  For,
  JSX,
  Match,
  Show,
  Signal,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  splitProps,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import isEqual from "lodash.isequal";
import { Channel, Message as MessageInterface } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient, useClientLifecycle, useE2EE } from "@revolt/client";
import { State } from "@revolt/client/Controller";
import {
  notEncryptedRow,
  plainGroupUnderLatch,
} from "@revolt/client/encryptedOnlyChat";
import {
  buildPlainWriteInput,
  channelKindOf,
  dmPeerId,
  peerTurnedOff,
} from "@revolt/client/encryptedOnlyGuard";
import { latchedForClient } from "@revolt/client/encryptedOnlyLatch";
import { timelineCopy } from "@revolt/client/protectedCopy";
import {
  dividerAfter,
  nativeHistoryInput,
} from "@revolt/client/protectedRowPolicy";
import {
  historyFloorNotice,
  protectedActionsBlocked,
} from "@revolt/client/protectedShield";
import type { TimelineMarker } from "@revolt/client/protectedTextTypes";
import {
  protectedUiOf,
  useProtectedTimeline,
} from "@revolt/client/useProtectedChannel";
import { useTime } from "@revolt/i18n";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  BlockedMessage,
  Button,
  ConversationStart,
  Deferred,
  JumpToBottom,
  MessageDivider,
} from "@revolt/ui";

import {
  ListView2,
  ListView2Update,
} from "@revolt/ui/components/utils/ListView2";
import { Symbol as MaterialSymbol } from "@revolt/ui/components/utils/Symbol";
import { Message } from "./Message";
import { useMessageCache } from "./MessageCache";
import {
  type ConversationTrust,
  channelTrust,
  restorableForTrust,
  serverActionsBlocked,
  splitUntrusted,
} from "./e2eeTranscriptTrust";
import { offersEncryptGroup } from "./encryptedOnlyInvite";

/**
 * Initial fetch limit
 */
const INITIAL_FETCH_LIMIT = 30;

/**
 * Fetch limit
 */
const FETCH_LIMIT = 50;

/**
 * Display limit
 */
const DISPLAY_LIMIT = 150;

// protected-pure:begin
// Pure protected channel helpers (W4 lane C7). No imports and no Solid, so
// protectedMessages.scan.test.ts loads this region on its own and runs it.

/**
 * Whether this list renders a Protected channel transcript: a server text
 * channel the SDK holds protected or pinned. DMs and groups always stay on
 * the DM trust path, whatever flag a server sends for them.
 * @param channelType Channel type
 * @param protectedOrPinned `client.isProtectedChannel(id)`
 * @returns Whether the protected rules apply
 */
function protectedTranscriptOf(
  channelType: string | undefined,
  protectedOrPinned: boolean,
): boolean {
  return channelType === "TextChannel" && protectedOrPinned === true;
}

/**
 * Trust the DM transcript filter sees. A protected transcript is never on
 * the DM path (plan D2): its rows are never in the DM trusted set, so that
 * path would hide all of them. A row without `encrypted` still renders and
 * Message.tsx shows the red `unencrypted_row` marker for it (design 9.4).
 * @param protectedTranscript Result of `protectedTranscriptOf`
 * @param dmTrust The DM/group derivation (`channelTrust`)
 * @returns Trust level
 */
function transcriptTrustFor(
  protectedTranscript: boolean,
  dmTrust: ConversationTrust,
): ConversationTrust {
  return protectedTranscript ? "not_e2ee" : dmTrust;
}

/**
 * Rows restored from the cache that have no decrypted view (or marker)
 * yet, in their original order; a `pending` view counts as a view.
 * @param rows Restored rows
 * @param hasView Whether the bridge holds a view for an id
 * @returns Rows to hand to `decryptProtectedHistory`
 */
function rowsWithoutView<T extends { id: string }>(
  rows: readonly T[],
  hasView: (id: string) => boolean,
): T[] {
  return rows.filter((row) => !hasView(row.id));
}

/**
 * Display name for a timeline marker: the member nickname, then the user's
 * display name, then the id-free fallback. Never the user id.
 * @param names Candidate names, best first
 * @param fallback Copy such as "A member"
 * @returns Name
 */
function timelineDisplayName(
  names: readonly (string | null | undefined)[],
  fallback: string,
): string {
  for (const name of names) {
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return fallback;
}

/**
 * Same calendar day in local time, the comparison the list's date
 * dividers use
 * @param a Time in ms
 * @param b Time in ms
 * @returns Whether both fall on one day
 */
function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/**
 * The markers to place: every marker that is not a history floor, and of
 * the history floors only the latest one of each channel. The bridge's list
 * is append-only, so a later stop of the walk comes after the stop it
 * replaces and the older line must not stay on screen beside it.
 * @param markers Markers in arrival order
 * @returns Markers in the same order, older floors left out
 */
function latestFloorOnly<M extends { kind?: string; channelId?: string }>(
  markers: readonly M[],
): M[] {
  const latest = new Map<string, number>();
  markers.forEach((marker, index) => {
    if (marker.kind === "history_floor") {
      latest.set(marker.channelId ?? "", index);
    }
  });
  return markers.filter(
    (marker, index) =>
      marker.kind !== "history_floor" ||
      latest.get(marker.channelId ?? "") === index,
  );
}

/**
 * Whether a history floor marker belongs to the row at `rowAtMs`. The
 * manager raises the marker 1 ms after the newest loaded row at or below
 * the floor (R-W4-32), so it is that row's whatever else is loaded.
 * @param marker Marker
 * @param rowAtMs Time of the row in ms
 * @returns Whether the marker is anchored to the row
 */
function floorAnchoredTo(
  marker: { atMs: number; kind?: string },
  rowAtMs: number,
): boolean {
  return (
    marker.kind === "history_floor" &&
    marker.atMs >= rowAtMs &&
    marker.atMs - rowAtMs <= 1
  );
}

/**
 * Where local timeline markers sit among the loaded messages, ordered by
 * their `atMs`. Indices follow `messagesAtMs`, which is newest first like
 * the list; every array of markers is newest first too. A history floor is
 * placed by its `atMs` like any other marker, and only the latest floor of
 * a channel is placed at all.
 * - `before[k]`: markers at or after message k and before message k - 1.
 *   For k = 0 they are newer than every loaded message and show only at
 *   the end of the conversation (otherwise they belong to unloaded rows);
 *   a history floor anchored to message 0 (`floorAnchoredTo`) is the one
 *   exception and shows wherever the loaded window ends.
 * - `beforeDate[k]`: markers older than message k but on its day, when
 *   message k + 1 is on an earlier day (they go under k's date divider).
 * - `breaksTail[k]`: a marker sits between message k and message k + 1.
 * - `trailing`: markers older than the oldest loaded message, shown only
 *   at the start of the conversation.
 * @param markers Markers in any order
 * @param messagesAtMs Message times in ms, newest first
 * @param atStart Whether the start of the conversation is loaded
 * @param atEnd Whether the end of the conversation is loaded
 * @param sameDay Day comparison
 * @returns Placement
 */
function planTimelineMarkers<
  M extends { atMs: number; kind?: string; channelId?: string },
>(
  markers: readonly M[],
  messagesAtMs: readonly number[],
  atStart: boolean,
  atEnd: boolean,
  sameDay: (a: number, b: number) => boolean,
): { before: M[][]; beforeDate: M[][]; breaksTail: boolean[]; trailing: M[] } {
  // Newest first; equal times keep their arrival order once reversed
  const pending = latestFloorOnly(markers)
    .map((marker, index) => ({ marker, index }))
    .filter(({ marker }) => Number.isFinite(marker.atMs))
    .sort((a, b) => b.marker.atMs - a.marker.atMs || b.index - a.index)
    .map(({ marker }) => marker);

  const before: M[][] = [];
  const beforeDate: M[][] = [];
  const breaksTail: boolean[] = [];
  let i = 0;

  for (let k = 0; k < messagesAtMs.length; k++) {
    const at = messagesAtMs[k];
    const newer: M[] = [];
    while (i < pending.length && pending[i].atMs >= at) {
      newer.push(pending[i++]);
    }
    before.push(
      k === 0 && !atEnd
        ? newer.filter((marker) => floorAnchoredTo(marker, at))
        : newer,
    );

    const next = k + 1 < messagesAtMs.length ? messagesAtMs[k + 1] : undefined;
    const sameDayOlder: M[] = [];
    if (next !== undefined && !sameDay(at, next)) {
      while (
        i < pending.length &&
        pending[i].atMs > next &&
        sameDay(pending[i].atMs, at)
      ) {
        sameDayOlder.push(pending[i++]);
      }
    }
    beforeDate.push(sameDayOlder);

    breaksTail.push(
      next !== undefined &&
        (sameDayOlder.length > 0 ||
          (i < pending.length && pending[i].atMs >= next)),
    );
  }

  const rest = pending.slice(i);
  const trailing =
    messagesAtMs.length === 0
      ? atStart && atEnd
        ? rest
        : []
      : atStart
        ? rest
        : [];

  return { before, beforeDate, breaksTail, trailing };
}

/**
 * Whether a timeline row reads loud. Only a history floor can: its tone
 * comes from `historyFloorNotice`, and any tone other than the two quiet
 * ones is loud, so a stop this build does not know is never shown as an
 * ordinary "before you joined" line.
 * @param kind Marker kind
 * @param floorTone `historyFloorNotice(stop).tone` for a history floor
 * @returns Tone of the row
 */
function timelineTone(
  kind: string,
  floorTone: string | null | undefined,
): "quiet" | "loud" {
  if (kind !== "history_floor") return "quiet";
  return floorTone === "gray" || floorTone === "before_join" ? "quiet" : "loud";
}

/**
 * Whether a fetched page ends paging in its direction. An ordinary channel
 * ends on a short page. A protected or pinned channel ends on an EMPTY page
 * only: the server filters rows out of its pages there, so a short page can
 * sit in the middle of the history, and there is no `has_more` to ask.
 * @param count Rows in the page
 * @param limit Rows asked for
 * @param protectedChannel Result of `protectedTranscriptOf`
 * @returns Whether no further page is requested
 */
function pageEndsHistory(
  count: number,
  limit: number,
  protectedChannel: boolean,
): boolean {
  return protectedChannel === true ? count === 0 : count < limit;
}

/**
 * Whether a page of a protected channel brought no row beyond the row it
 * was fetched from. Ending only on an empty page would otherwise ask for
 * the same page for as long as it keeps coming back, so such a page ends
 * paging too and none of its rows are added. Never true for an ordinary
 * channel, an empty page or a fetch with no cursor.
 * @param ids Ids of the page's rows
 * @param cursor Id the page was fetched before or after
 * @param direction "older" for a page before the cursor, "newer" for after
 * @param protectedChannel Result of `protectedTranscriptOf`
 * @returns Whether the page made no progress
 */
function pageStalled(
  ids: readonly string[],
  cursor: string | undefined,
  direction: "older" | "newer",
  protectedChannel: boolean,
): boolean {
  if (protectedChannel !== true || cursor === undefined || !ids.length) {
    return false;
  }
  return !ids.some((id) => (direction === "older" ? id < cursor : id > cursor));
}

/**
 * Whether a row's view says its key is not held on this device: the gray
 * "sent before this device joined" and "unknown key" markers. A row sent
 * after this device was removed is not one (no walk can bring that key),
 * and neither is a pending or a failed row.
 * @param view The bridge's view of the row, if any
 * @returns Whether a history walk could bring the key
 */
function keylessView(
  view: { status?: string; kind?: string } | null | undefined,
): boolean {
  return (
    view?.status === "marker" &&
    (view.kind === "sent_before_join" || view.kind === "unknown_key")
  );
}

/**
 * Whether a backward page load asks the manager for a history walk. Asked
 * at most once per loaded page, and only with the history flag on:
 * - never while a walk runs, and never without a view of the channel;
 * - always when the last walk has to be retried (`retry_later`);
 * - otherwise only when the page holds rows whose key is not held and no
 *   walk has stopped at a floor yet. Once a floor marker stands, such rows
 *   are the expected state and paging through them starts no walk.
 * @param i Page and channel state
 * @returns Whether to call `walkHistory`
 */
function walkAfterPage(i: {
  protectedChannel: boolean;
  historyFlag: boolean;
  historyWalk: string | undefined;
  rows: number;
  keylessRows: boolean;
  floorKnown: boolean;
}): boolean {
  if (i.protectedChannel !== true || i.historyFlag !== true) return false;
  if (!(i.rows > 0)) return false;
  if (i.historyWalk === "retry_later") return true;
  if (i.historyWalk !== "idle") return false;
  return i.keylessRows === true && i.floorKnown === false;
}

/**
 * Whether the initial load asks the manager to take up a history walk that
 * could not finish (`retry_later`). With the whole channel loaded there is
 * no backward page to ask from, so the load asks once itself; the manager
 * restarts from the gap the walk was for. Nothing in any other state.
 * @param i Channel state
 * @returns Whether to call `walkHistory`
 */
function walkOnInitialLoad(i: {
  protectedChannel: boolean;
  historyFlag: boolean;
  historyWalk: string | undefined;
}): boolean {
  if (i.protectedChannel !== true || i.historyFlag !== true) return false;
  return i.historyWalk === "retry_later";
}

/**
 * The rows a list may hold: on a protected or pinned channel only rows
 * that name this channel (audit A1). A row naming another channel has no
 * decrypted view here and must never be listed as an ordinary message.
 * Any other channel keeps its rows as they came.
 * @param rows Rows from a fetch or the cache
 * @param channelId Channel the list renders
 * @param protectedOrPinned `client.isProtectedChannel(id)`
 * @returns Rows to list, in the same order
 */
function rowsOfChannel<T extends { channelId?: string }>(
  rows: readonly T[],
  channelId: string,
  protectedOrPinned: boolean,
): T[] {
  if (protectedOrPinned !== true) return [...rows];
  return rows.filter((row) => row.channelId === channelId);
}

/**
 * Rows of several lists as one, newest first by id (the comparison the
 * list always used). Every list setter that takes fetched rows goes through
 * this, so a row the server put out of order still lands where its id says
 * (and on its side of the boundary divider).
 * @param lists Lists of rows
 * @returns One list, newest first
 */
function newestFirst<T extends { id: string }>(lists: readonly T[][]): T[] {
  return lists.flat().sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Whether a delete that emptied the list asks for a fresh initial load.
 * Only when rows were listed before and none are left, nothing is being
 * fetched, and no such reload was spent since the list last got a row by
 * another route: a server that keeps answering with rows that are deleted
 * again gets one request, not a loop, and a channel that is really empty
 * has no row whose delete could ask again.
 * @param i Row counts around the delete, fetch state, reloads spent
 * @returns Whether to call `caseInitialLoad`
 */
function reloadAfterEmptied(i: {
  before: number;
  after: number;
  fetching: boolean;
  reloads: number;
}): boolean {
  if (!(i.before > 0) || i.after !== 0) return false;
  if (i.fetching !== false) return false;
  return i.reloads === 0;
}

/**
 * What this list may show about a channel's history, from the VERIFIED
 * native state only. Null (show nothing) while the state is not loaded or
 * not verified, while the SDK holds the channel conflicted, and whenever
 * the wipe records disagree with the verified list: the SDK or the pin says
 * wiped while the list does not, or the pin holds another boundary.
 * @param native Result of `nativeHistoryInput` for the view's native state
 * @param historySetting `view.native.history_setting`, as it is now
 * @param pin The local pin's history record, null when none
 * @param latch The SDK's per-session records for the channel
 * @returns History setting and divider inputs, or null
 */
function verifiedHistoryOf(
  native:
    | {
        verified: boolean;
        boundary: string | null;
        preHistory: "kept" | "wiped" | null;
      }
    | null
    | undefined,
  historySetting: unknown,
  pin: { boundary: string; wiped: boolean } | null | undefined,
  latch: { conflicted: boolean; wiped: boolean },
): {
  historyVisible: boolean;
  divider: { boundary: string; preHistory: "kept" | "wiped" } | null;
} | null {
  if (!native || native.verified !== true) return null;
  if (latch.conflicted !== false) return null;

  const boundary =
    typeof native.boundary === "string" && native.boundary !== ""
      ? native.boundary
      : null;
  const preHistory =
    native.preHistory === "kept" || native.preHistory === "wiped"
      ? native.preHistory
      : null;
  const wipedByList = boundary !== null && preHistory === "wiped";

  if (latch.wiped !== false && !wipedByList) return null;
  if (pin) {
    if (pin.boundary !== boundary) return null;
    if (pin.wiped !== false && !wipedByList) return null;
  }

  return {
    historyVisible: historySetting === "visible",
    divider:
      boundary !== null && preHistory !== null
        ? { boundary, preHistory }
        : null,
  };
}

/**
 * Options for `timelineCopy`: "It can read this channel's history." is
 * added only while the verified state says the history is visible now.
 * Anything else leaves the option out.
 * @param history Result of `verifiedHistoryOf`
 * @returns Options bag
 */
function historyVisibleOption(
  history: { historyVisible: boolean } | null | undefined,
): { historyVisible?: true } {
  return history?.historyVisible === true ? { historyVisible: true } : {};
}

/**
 * Where the permanent boundary divider goes, or null for none.
 * - It sits directly below the newest loaded row at or below the boundary
 *   (`dividerAfter`), provided a newer row or the end of the conversation
 *   is loaded too: without either, a newer row at or below the boundary
 *   may still be unloaded and the line would be drawn too high.
 * - With `wiped` and no such row loaded it sits at the top of the channel
 *   once backward paging has ended.
 * @param i Loaded ids (newest first), the `divider` of `verifiedHistoryOf`,
 *   list position and L1p's `dividerAfter`
 * @returns The row the divider sits below (null: the top), and its kind
 */
function planBoundaryDivider(i: {
  idsNewestFirst: readonly string[];
  divider: { boundary: string; preHistory: "kept" | "wiped" } | null;
  atStart: boolean;
  atEnd: boolean;
  dividerAfter: (
    idsOldestFirst: readonly string[],
    boundary: string,
  ) => string | null;
}): { below: string | null; preHistory: "kept" | "wiped" } | null {
  const divider = i.divider;
  if (!divider) return null;
  if (divider.preHistory !== "kept" && divider.preHistory !== "wiped") {
    return null;
  }

  const below = i.dividerAfter(
    [...i.idsNewestFirst].reverse(),
    divider.boundary,
  );
  if (below !== null) {
    const newerLoaded = i.idsNewestFirst.some((id) => id > below);
    if (!newerLoaded && i.atEnd !== true) return null;
    return { below, preHistory: divider.preHistory };
  }

  // A boundary no row can be compared with has no divider anywhere
  if (i.dividerAfter([divider.boundary], divider.boundary) === null) {
    return null;
  }
  return divider.preHistory === "wiped" && i.atStart === true
    ? { below: null, preHistory: "wiped" }
    : null;
}
// protected-pure:end

interface Props {
  /**
   * Channel to fetch messages from
   */
  channel: Channel;

  /**
   * Pending messages to render at the end of the list
   */
  pendingMessages?: (props: { tail: boolean; ids: string[] }) => JSX.Element;

  /**
   * Display typing indicator instead of padding
   */
  typingIndicator?: JSX.Element;

  /**
   * Highlighted message id
   */
  highlightedMessageId: Accessor<string | undefined>;

  /**
   * Last read message id
   */
  lastReadId: Accessor<string | undefined>;

  /**
   * Clear the highlighted message
   */
  clearHighlightedMessage: () => void;

  /**
   * Bind the initial messages function to the parent component
   * @param fn Function
   */
  jumpToBottomRef?: (fn: (nearby?: string) => void) => void;

  atEnd?: Signal<boolean>;
}

/**
 * Render messages in a Channel
 */
export function Messages(props: Props) {
  const cache = useMessageCache();
  const lifecycle = useClientLifecycle();
  const client = useClient();
  const e2ee = useE2EE();
  const state = useState();
  const dayjs = useTime();
  const { t } = useLingui();
  const { openModal } = useModals();

  /** Whether the Encrypted-only latch is on here */
  const latched = createMemo(() => latchedForClient(client().user?.id));

  /**
   * Whether a message row carries the "Not encrypted" label: under the
   * latch, every unencrypted message in a direct message or group, however
   * old. It is never shown as encrypted.
   * @param message Message
   * @returns Whether to label it
   */
  function notEncryptedLabel(message: MessageInterface): boolean {
    const kind = channelKindOf(props.channel);
    return notEncryptedRow({
      latched: latched(),
      conversation: kind === "dm" || kind === "group",
      encrypted: isTrustedMessage(message.id),
      system: !!message.systemMessage,
    });
  }

  /**
   * A group that is not encrypted, under the latch: read-only, with a way
   * out. Other members can still write here.
   */
  const plainGroup = createMemo(
    () =>
      props.channel.type === "Group" &&
      plainGroupUnderLatch(buildPlainWriteInput(client(), props.channel)),
  );

  /**
   * The other person of a direct message, once an update said they turned
   * Encrypted-only off while this app was running
   */
  const peerTurnedOffName = createMemo((): string | undefined => {
    const c = client();
    const peerId = dmPeerId(c, props.channel);
    if (!peerId || !peerTurnedOff(c, peerId)) return undefined;
    const peer = c.users.get(peerId);
    return peer?.displayName || peer?.username || undefined;
  });

  /**
   * The notice for a peer who turned Encrypted-only off
   * @param name Their name
   * @returns Text
   */
  function turnedOffText(name: string): string {
    return t`${name} turned off Encrypted-only chats.`;
  }

  /**
   * Local timeline markers of this channel (protected channels, plan D22)
   */
  const protectedTimeline = useProtectedTimeline(() => props.channel.id);

  /**
   * Whether the SDK holds this channel protected or pinned. Used as is
   * where it only withholds an action (fails closed).
   * @returns Boolean
   */
  function protectedOrPinned(): boolean {
    return client().isProtectedChannel(props.channel.id);
  }

  /**
   * Whether this list renders a Protected channel transcript (server text
   * channel only, so a DM never leaves the DM trust path)
   * @returns Boolean
   */
  function protectedTranscript(): boolean {
    return protectedTranscriptOf(props.channel.type, protectedOrPinned());
  }

  /**
   * What the verified native state says about this channel's history (the
   * boundary divider reads it); null on any other channel or state
   */
  const verifiedHistory = useVerifiedHistory(() =>
    protectedTranscript() ? props.channel.id : undefined,
  );

  /**
   * After a backward page was loaded: ask the manager for a history walk
   * when `walkAfterPage` says so. Called once per loaded page from the
   * paging path, never from an effect or a memo.
   * @param page Rows of the page
   */
  function walkHistoryAfterPage(page: MessageInterface[]) {
    const channelId = props.channel.id;
    const ui = protectedUiOf(client().e2ee);
    if (!ui || typeof ui.walkHistory !== "function") return;
    if (typeof ui.protectedFlag !== "function") return;

    try {
      const wanted = walkAfterPage({
        protectedChannel: protectedTranscript(),
        historyFlag: ui.protectedFlag().historySetting === true,
        historyWalk: ui.protectedChannels.get(channelId)?.historyWalk,
        rows: page.length,
        keylessRows: page.some((row) =>
          keylessView(ui.protectedViews.get(row.id)),
        ),
        floorKnown: protectedTimeline().some(
          (marker) => marker.kind === "history_floor",
        ),
      });
      if (wanted) ui.walkHistory(channelId);
    } catch {
      console.error("[protected] history walk request failed", { channelId });
    }
  }

  /**
   * After an initial load: take up a history walk that could not finish
   * (`walkOnInitialLoad`). Called once per initial load, never from an
   * effect or a memo.
   */
  function walkHistoryOnLoad() {
    const channelId = props.channel.id;
    const ui = protectedUiOf(client().e2ee);
    if (!ui || typeof ui.walkHistory !== "function") return;
    if (typeof ui.protectedFlag !== "function") return;

    try {
      const wanted = walkOnInitialLoad({
        protectedChannel: protectedTranscript(),
        historyFlag: ui.protectedFlag().historySetting === true,
        historyWalk: ui.protectedChannels.get(channelId)?.historyWalk,
      });
      if (wanted) ui.walkHistory(channelId);
    } catch {
      console.error("[protected] history walk request failed", { channelId });
    }
  }

  /**
   * Rows this list may hold (`rowsOfChannel`); a dropped row is logged by
   * count only.
   * @param rows Rows from a fetch or the cache
   * @returns Rows to list
   */
  function ownRows(rows: MessageInterface[]): MessageInterface[] {
    const channelId = props.channel.id;
    const kept = rowsOfChannel(rows, channelId, protectedOrPinned());
    if (kept.length !== rows.length) {
      console.error("[protected] rows of another channel dropped", {
        channelId,
        count: rows.length - kept.length,
      });
    }
    return kept;
  }

  /**
   * Hand rows restored from the cache that have no decrypted view to the
   * bridge, in one batch per restore (plan D22). Fetched rows are already
   * handed over by the SDK's fetch methods.
   * @param rows Restored rows
   */
  function decryptRestoredProtectedRows(rows: MessageInterface[]) {
    const c = client();
    const views = protectedUiOf(c.e2ee)?.protectedViews;
    const missing = rowsWithoutView(rows, (id) => views?.get(id) !== undefined);
    if (!missing.length) return;

    try {
      c.e2ee?.decryptProtectedHistory?.(props.channel, missing);
    } catch {
      console.error("[protected] restore decrypt failed", {
        channelId: props.channel.id,
      });
    }
  }

  /**
   * Loaded messages
   */
  const [messages, setMessages] = createSignal<MessageInterface[]>([]);

  /**
   * Whether this device knows the group has a webhook. Listing a group's
   * webhooks needs Manage Webhooks and no event announces a new one, so
   * nothing is fetched for this: it reads only webhooks already loaded
   * this session and loaded messages a webhook sent.
   */
  const groupWebhooksKnown = () =>
    messages().some((message) => !!message.webhook) ||
    client()
      .channelWebhooks.toList()
      .some((webhook) => webhook.channelId === props.channel.id);

  /**
   * Whether the plain group banner offers "Encrypt this group": 24 people
   * or fewer counting you, every other member with encryption on and none
   * a bot, and no known webhook. A member this device does not know yet
   * counts as without encryption. Declared after `messages`, which it reads.
   */
  const encryptGroupOffered = createMemo(() => {
    if (props.channel.type !== "Group") return false;
    const c = client();
    const selfId = c.user?.id;
    const others = [...(props.channel.recipientIds ?? [])]
      .filter((id) => id !== selfId)
      .map((id) => {
        const user = c.users.get(id);
        return { encrypted: user?.e2eeEnabled === true, bot: !!user?.bot };
      });
    return offersEncryptGroup(
      buildPlainWriteInput(c, props.channel),
      others,
      groupWebhooksKnown,
    );
  });

  /**
   * Whether we've reached the start of the conversation
   */
  const [atStart, setStart] = createSignal(false);

  /**
   * Whether we've reached the end of the conversation
   */
  // eslint-disable-next-line solid/reactivity
  const [atEnd, setEnd] = props.atEnd ?? createSignal(true);

  /**
   * The current direction of fetching
   */
  const [fetching, setFetching] = createSignal<
    "initial" | "upwards" | "downwards" | "jump_end" | "jump_msg"
  >();

  /**
   * Whether the current fetch has failed
   */
  const [failure, setFailure] = createSignal(false);

  /**
   * Collect messages during fetches
   *
   * The new message handler should write into this if it
   * is defined as opposed to appending to messages[] list
   */
  let collectedMessages: MessageInterface[] | undefined;

  /**
   * Reloads spent on a list that a delete emptied (`reloadAfterEmptied`);
   * back to zero on a channel switch and when a live message is listed
   */
  let emptiedReloads = 0;

  /**
   * Pre-empt the current fetch
   */
  let preemptFetch: () => void | undefined;

  /**
   * Reference for the list container so we can scroll to elements
   */
  let listRef: HTMLDivElement | undefined;

  /**
   * Whether we can fetch
   * @returns Boolean
   */
  function canFetch() {
    return !fetching() || failure();
  }

  /**
   * Window the list renders in: a chat window is its own document, and the
   * main realm's timers are throttled while the main window is hidden
   * @returns Window
   */
  function listWindow(): Window {
    return listRef?.ownerDocument.defaultView ?? window;
  }

  /**
   * Pre-empt the current fetch
   */
  function preempt() {
    batch(() => {
      setFetching();
      setFailure(false);
      preemptFetch?.();
    });
  }

  /**
   * Helper for checking if we've been pre-empted
   * @returns Function to check if we have been pre-empted
   */
  function newPreempted() {
    let preempted = false;
    preemptFetch = () => {
      preempted = true;
    };

    return () => preempted;
  }

  /**
   * Safely update messages by applying consistency checks
   * @param messagesArr Array of message arrays
   */
  function setMessagesSafely(...messagesArr: MessageInterface[][]) {
    setMessages(newestFirst(messagesArr));
  }

  /**
   * After a delete: load the channel again when the delete emptied the list
   * (`reloadAfterEmptied`), e.g. a wipe that removed every loaded row.
   * @param before Rows listed before the delete
   */
  function reloadIfEmptied(before: number) {
    const wanted = reloadAfterEmptied({
      before,
      after: messages().length,
      fetching: fetching() !== undefined,
      reloads: emptiedReloads,
    });
    if (!wanted) return;
    emptiedReloads++;
    caseInitialLoad();
  }

  /**
   * Initial load subroutine
   * @param nearby Message we should load around (and then scroll to)
   */
  async function caseInitialLoad(nearby?: string) {
    // Pre-empt any fetches
    preempt();
    setFetching("initial");

    // Handle incoming pre-emptions
    const preempted = newPreempted();

    // Clear the messages list
    // NB. component does not remount on channel switch
    setMessages([]);

    // Set the initial position
    setStart(false);
    setEnd(true);

    // Start collecting messages
    collectedMessages = [];

    try {
      // Fetch messages for channel
      let messages;

      // In an encrypted (or not yet known) conversation, a cached list that
      // holds a row this device did not decrypt is refused and refetched.
      // Its marker is emitted once, after the merge below.
      const restored = restorableForTrust(
        cache!.unmanage(props.channel) ?? undefined,
        currentTrust(),
        isTrustedMessage,
      );
      const existingState = restored.entry;
      const restoreHidden = restored.hiddenVisible;
      let mergeHidden = 0;
      const useExistingState = existingState && !nearby;

      if (useExistingState) {
        messages = existingState.messages;

        // Protected channel: restored rows without a view re-request decrypt
        if (protectedTranscript()) {
          decryptRestoredProtectedRows(messages);
        }
      } else {
        // Fetch results are not re-checked: in an encrypted conversation
        // fetchMessagesWithUsers returns fetchLocalHistory, whose rows are
        // all trusted.
        messages = await props.channel
          .fetchMessagesWithUsers({
            limit: INITIAL_FETCH_LIMIT,
            nearby,
          })
          .then(({ messages }) => messages);
      }

      // Rows of another channel are never listed
      messages = ownRows(messages);

      // Cancel if we've been pre-empted
      if (preempted()) {
        collectedMessages = undefined;
        return;
      }

      // Assume we are not at the end if we jumped to a message
      // NB. we set this late to not display the "jump to bottom" bar
      if (typeof nearby === "string") {
        setEnd(
          // If the messages fetched include the latest message,
          // then we are at the end and mark the channel as such.
          messages.findIndex(
            (msg) => msg.id === props.channel.lastMessageId,
          ) !== -1,
        );
      }
      // Check if we're at the start of the conversation otherwise
      else if (
        !useExistingState &&
        pageEndsHistory(
          messages.length,
          INITIAL_FETCH_LIMIT,
          protectedTranscript(),
        )
      ) {
        setStart(true);
      }
      // Apply existing state if present
      else if (existingState) {
        setStart(existingState.atStart);
        setEnd(existingState.atEnd);
      }

      // Merge list with any new ones that have come in if we are at the end
      if (atEnd()) {
        let collected = collectedMessages!;
        // Live rows buffered before the send mode was known skipped the
        // trust filter in onMessage, so re-check them here
        if (encryptedConversation()) {
          const split = splitUntrusted(collected, isTrustedMessage);
          collected = split.trusted;
          mergeHidden = split.hiddenVisible;
        }
        const knownIds = new Set(collected.map((x) => x.id));
        setMessagesSafely(
          collected,
          messages.filter((x) => !knownIds.has(x.id)),
        );
      }
      // Otherwise just replace the whole list, sorted like every other load
      else {
        setMessagesSafely(messages);
      }

      // Stop collecting messages
      collectedMessages = undefined;

      // One marker per load, emitted only now: its messageCreate arrives
      // through onMessage synchronously, and with no load buffer left it is
      // prepended to the list instead of being lost with the buffer
      if (restoreHidden + mergeHidden > 0 && atEnd()) {
        e2ee?.noteDroppedPlaintext(props.channel.id);
      }

      // Mark as fetching has ended
      setFetching();

      // A walk that could not finish is taken up once per load
      walkHistoryOnLoad();

      // If we're not at the end, restore scroll position
      if (existingState && !existingState.atEnd) {
        listWindow().setTimeout(() =>
          listRef?.scrollTo({
            top: existingState.scrollTop!,
            behavior: "instant",
          }),
        );
      }
      // Or... reset scroll to the end
      else if (atEnd()) {
        listWindow().setTimeout(() =>
          listRef?.scrollTo({
            top: 9999999,
            behavior: "instant",
          }),
        );
      }
    } catch {
      // Keep track of any failures (and allow retry / other actions)
      setFailure(true);
      setFetching();
    }
  }

  /**
   * Fetch upwards from current position
   */
  async function caseFetchUpwards(): Promise<ListView2Update | undefined> {
    // Pre-conditions:
    // - Must not already be at the start
    // - Must not already be fetching (or otherwise the fetch must have failed)
    if (atStart() || !canFetch()) return;

    // Nothing loaded means there is no row to page from
    const oldest = messages().slice(-1)[0]?.id;
    if (oldest === undefined) return;

    // Indicate we are fetching upwards
    setFetching("upwards");

    // Handle incoming pre-emptions
    const preempted = newPreempted();

    try {
      // Fetch messages for channel
      const result = await props.channel.fetchMessagesWithUsers({
        limit: FETCH_LIMIT,
        // Take the id of the oldest message currently fetched
        before: oldest,
      });

      // Cancel if we've been pre-empted
      if (preempted()) return;

      // Rows of another channel are never listed
      result.messages = ownRows(result.messages);

      // A protected channel ends on an empty page, or on a page that
      // brought nothing older; any other channel ends on a short page
      const protectedPage = protectedTranscript();
      const stalled = pageStalled(
        result.messages.map((message) => message.id),
        oldest,
        "older",
        protectedPage,
      );
      if (
        stalled ||
        pageEndsHistory(result.messages.length, FETCH_LIMIT, protectedPage)
      ) {
        setStart(true);
      }

      // One history walk request per loaded page, decided by the page
      if (!stalled) walkHistoryAfterPage(result.messages);

      // Prepend messages if we received any
      if (result.messages.length && !stalled) {
        // Calculate how much we need to cut off the other end
        const tooManyBy = Math.max(
          0,
          result.messages.length + messages().length - DISPLAY_LIMIT,
        );

        // If it's at least one element, we are no longer at the end
        if (tooManyBy > 0) {
          setEnd(false);
        }

        const msgs = messages();
        return {
          scrollAnchorId: msgs[msgs.length - 1].id,
          commitToDOM() {
            setMessagesSafely(messages(), result.messages);

            if (tooManyBy) {
              setMessages((prev) => {
                return prev.slice(tooManyBy);
              });
            }

            setFetching();
          },
        };
      } else {
        setFetching();
      }
    } catch {
      // Keep track of any failures (and allow retry / other actions)
      setFailure(true);
      setFetching();
    }
  }

  /**
   * Fetch downwards from current position
   */
  async function caseFetchDownwards(): Promise<ListView2Update | undefined> {
    // Pre-conditions:
    // - Must not already be at the end
    // - Must not already be fetching (or otherwise the fetch must have failed)
    if (atEnd() || !canFetch()) return;

    // Nothing loaded means there is no row to page from
    const newest = messages()[0]?.id;
    if (newest === undefined) return;

    // Indicate we are fetching downwards
    setFetching("downwards");

    // Handle incoming pre-emptions
    const preempted = newPreempted();

    try {
      // Fetch messages after the newest message we have
      const result = await props.channel.fetchMessagesWithUsers({
        limit: FETCH_LIMIT,
        after: newest,
        sort: "Oldest",
      });

      // Cancel if we've been pre-empted
      if (preempted()) return;

      // Rows of another channel are never listed
      result.messages = ownRows(result.messages);

      // A protected channel ends on an empty page, or on a page that
      // brought nothing newer; any other channel ends on a short page
      const protectedPage = protectedTranscript();
      const stalled = pageStalled(
        result.messages.map((message) => message.id),
        newest,
        "newer",
        protectedPage,
      );
      if (
        stalled ||
        pageEndsHistory(result.messages.length, FETCH_LIMIT, protectedPage)
      ) {
        setEnd(true);
      }

      // If we received any messages at all, append them to the bottom
      if (result.messages.length && !stalled) {
        // Calculate how much we need to cut off the other end
        const tooManyBy = Math.max(
          0,
          result.messages.length + messages().length - DISPLAY_LIMIT,
        );

        // If it's at least one element, we are no longer at the start
        if (tooManyBy > 0) {
          setStart(false);
        }

        return {
          scrollAnchorId: messages()[0].id,
          commitToDOM() {
            setMessagesSafely(result.messages, messages());

            if (tooManyBy) {
              setMessages((prev) => prev.slice(0, -tooManyBy));
            }

            setFetching();
          },
        };
      } else {
        // Mark as fetching has ended
        setFetching();
      }
    } catch {
      // Keep track of any failures (and allow retry / other actions)
      setFailure(true);
      setFetching();
    }
  }

  /**
   * Jump to the present messages
   */
  async function caseJumpToBottom() {
    /**
     * Helper function to find the closest parent scroll container
     * @param el Element
     * @returns Element
     */
    function findScrollContainer(el: Element | null) {
      if (!el) {
        return null;
      } else if (
        (el.ownerDocument.defaultView ?? window).getComputedStyle(el)
          .overflowY === "scroll"
      ) {
        return el;
      } else {
        return el.parentElement;
      }
    }

    // Scroll to the bottom if we're already at the end
    if (atEnd()) {
      const containerChild = findScrollContainer(listRef!)!.children[0];
      containerChild!.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
    // Otherwise fetch present messages
    else {
      // Pre-empty any fetches
      preempt();
      setFetching("jump_end");

      // Handle incoming pre-emptions
      const preempted = newPreempted();

      // Start collecting messages
      collectedMessages = [];

      try {
        // Fetch messages for channel
        const fetched = await props.channel.fetchMessagesWithUsers({
          limit: FETCH_LIMIT,
        });

        // Cancel if we've been pre-empted
        if (preempted()) {
          collectedMessages = undefined;
          return;
        }

        // Rows of another channel are never listed
        const messages = ownRows(fetched.messages);

        // Check if we're at the start of the conversation
        // NB. this may be counter-intuitive because we are in history but,
        //     this could be a very rare edge case for large moderation actions
        if (
          pageEndsHistory(messages.length, FETCH_LIMIT, protectedTranscript())
        ) {
          setStart(true);
        } else {
          setStart(false);
        }

        // Indicate we are at the end now
        setEnd(true);

        // Merge list with any new ones that have come in, re-checking
        // live rows buffered before the send mode was known
        let collected = collectedMessages!;
        let mergeHidden = 0;
        if (encryptedConversation()) {
          const split = splitUntrusted(collected, isTrustedMessage);
          collected = split.trusted;
          mergeHidden = split.hiddenVisible;
        }
        const knownIds = new Set(collected.map((x) => x.id));
        setMessagesSafely(
          collected,
          messages.filter((x) => !knownIds.has(x.id)),
        );

        // Stop collecting messages
        collectedMessages = undefined;

        // One marker per load, emitted after the buffer is gone so that
        // onMessage prepends it to the list
        if (mergeHidden > 0) {
          e2ee?.noteDroppedPlaintext(props.channel.id);
        }

        // Animate scroll to bottom
        listWindow().setTimeout(() => {
          const containerChild = findScrollContainer(listRef!)!.children[0];

          containerChild!.scrollIntoView({
            behavior: "instant",
            block: "start",
          });

          listWindow().setTimeout(() => {
            containerChild!.scrollIntoView({
              behavior: "smooth",
              block: "end",
            });

            // Mark as fetching has ended
            setFetching();
          });
        });
      } catch {
        // Keep track of any failures (and allow retry / other actions)
        setFailure(true);
        setFetching();
      }
    }
  }

  /**
   * Jump to a given message
   * @param messageId Message Id
   */
  async function caseJumpToMessage(messageId: string) {
    /**
     * Scroll to the nearest message (to the id) in history
     */
    const scrollToNearestMessage = () => {
      const index = messagesWithTail().findIndex(
        (entry) => entry.t === 0 && entry.message.id === messageId,
      ); // use localeCompare

      listRef!.children[index + (atStart() ? 1 : 0)].scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    };

    if (messages().find((message) => message.id === messageId)) {
      scrollToNearestMessage();
      return;
    }

    // Pre-empty any fetches
    preempt();
    setFetching("jump_msg");

    // Handle incoming pre-emptions
    const preempted = newPreempted();

    try {
      // Fetch messages for channel
      const fetched = await props.channel.fetchMessagesWithUsers({
        limit: FETCH_LIMIT,
        nearby: messageId,
      });

      // Cancel if we've been pre-empted
      if (preempted()) return;

      // Rows of another channel are never listed
      const messages = ownRows(fetched.messages);

      // Assume we are somewhere in history
      // NB. we could be clever here, but best not to be
      setStart(false);
      setEnd(false);

      // Replace the messages
      setMessagesSafely(messages);

      // A one-shot read, as with the global setTimeout the rule allows
      // eslint-disable-next-line solid/reactivity
      listWindow().setTimeout(() => {
        // Scroll to the message
        scrollToNearestMessage();

        // Mark as fetching has ended
        listWindow().setTimeout(() => {
          setFetching();
        }, 300 /* probably long enough for scroll to finish */);
      });
    } catch {
      // Keep track of any failures (and allow retry / other actions)
      setFailure(true);
      setFetching();
    }
  }

  // Setup references if they exists
  onMount(() => {
    props.jumpToBottomRef?.(jumpToBottom);
  });

  /**
   * Fetch messages on channel mount
   */
  createEffect(
    on(
      () => props.channel,
      (channel) => {
        emptiedReloads = 0;
        caseInitialLoad(props.highlightedMessageId());

        // move state into cache when navigating away
        onCleanup(() => {
          if (fetching() !== "initial") {
            cache!.manage(channel, {
              messages: messages(),
              atStart: atStart(),
              atEnd: atEnd(),
              scrollTop: listRef?.scrollTop,
            });
          }
        });
      },
    ),
  );

  /**
   * Jump to highlighted message
   */
  createEffect(
    on(
      () => props.highlightedMessageId(),
      (messageId) => {
        // Jump only if messages are loaded
        if (messageId && messages()) {
          caseJumpToMessage(messageId);
        }
      },
    ),
  );

  /**
   * Whether this conversation is end-to-end encrypted (native local truth).
   * The server is outside the trust boundary but still controls the ordinary
   * Message pipeline for a DM/group channel — so in an encrypted
   * conversation any message that this device did NOT decrypt-and-inject
   * (`isEncryptedMessage`) is either server-injected or a plaintext send by a
   * web/old client. It must NEVER render as if encrypted (final-audit HIGH,
   * design §5.2). We suppress it from the encrypted transcript rather than
   * showing server-controlled content under the lock.
   *
   * `pending` is a composer-only label, never a sendModes value. An absent
   * mode must not hide live messages (it would blank plaintext DMs and any
   * device with E2EE off), so "unknown" fails closed only on cache restore.
   */
  function encryptedConversation(): boolean {
    return currentTrust() === "encrypted";
  }

  /**
   * Trust level of this conversation, keyed the same way as the e2ee layer:
   * the channel id for a group, the other recipient's id for a DM
   */
  function currentTrust(): ConversationTrust {
    return transcriptTrustFor(
      protectedTranscript(),
      channelTrust(e2ee, props.channel, client().user?.id),
    );
  }

  /**
   * Whether this device decrypted and injected the given message
   * @param id Message id
   */
  function isTrustedMessage(id: string): boolean {
    return e2ee?.isEncryptedMessage(id) === true;
  }

  /**
   * Handle incoming messages
   * @param message Message object
   */
  function onMessage(message: MessageInterface) {
    if (message.channelId === props.channel.id) {
      // In an encrypted conversation, only accept messages this device
      // authenticated + injected (trusted encrypted set). A message the
      // server injected — or a plaintext send from a web/old client — is not
      // in that set and must not appear under the lock as if authenticated.
      if (encryptedConversation() && !e2ee?.isEncryptedMessage(message.id)) {
        // Design §4: never a SILENT drop — leave a visible (non-
        // persisted) marker in place of the suppressed plaintext. System
        // messages (join/leave/rename) stay silently suppressed — an
        // "unencrypted message hidden" marker per membership event would
        // be misleading noise (review MINOR-4).
        if (!message.systemMessage) {
          e2ee?.noteDroppedPlaintext(props.channel.id);
        }
        return;
      }
      // A listed live row gives a later emptied list its reload back
      emptiedReloads = 0;
      if (collectedMessages) {
        collectedMessages.push(message);
        return;
      }
      if (atEnd()) {
        // A protected list is kept in id order: a live row with an old id
        // must not sit under the newest rows
        if (protectedOrPinned()) {
          setMessagesSafely([message], messages());
        } else {
          setMessages([message, ...messages()]);
        }
      }
    }
  }

  /**
   * Handle deleted messages
   */
  function onMessageDelete(message: { id: string; channelId: string }) {
    // Also drop it from the in-flight load buffer, or the merge revives it
    // (incl. a forged row the E2EE layer evicted before injecting).
    if (collectedMessages && message.channelId === props.channel.id) {
      collectedMessages = collectedMessages.filter(
        (msg) => msg.id !== message.id,
      );
    }

    if (
      message.channelId === props.channel.id &&
      messages().find((msg) => msg.id === message.id)
    ) {
      const before = messages().length;
      setMessages((messages) =>
        messages.filter((msg) => msg.id !== message.id),
      );
      reloadIfEmptied(before);
    }
  }
  /**
   * Handle bulk-deleted messages
   */
  function onMessageDeleteBulk(
    deleted_messages: { id: string; channelId: string }[],
    channel?: { id: string },
  ) {
    if (channel?.id === props.channel.id) {
      // Same as onMessageDelete: keep the load buffer in step.
      if (collectedMessages) {
        collectedMessages = collectedMessages.filter(
          (msg) => !deleted_messages.find((m) => m.id === msg.id),
        );
      }

      const before = messages().length;
      setMessages((messages) =>
        messages.filter(
          (msg) => !deleted_messages.find((m) => m.id === msg.id),
        ),
      );
      reloadIfEmptied(before);
    }
  }

  // Add listener for messages
  onMount(() => {
    const c = client();
    c.addListener("messageCreate", onMessage);
    c.addListener("messageDelete", onMessageDelete);
    c.addListener("messageDeleteBulk", onMessageDeleteBulk);
  });

  onCleanup(() => {
    const c = client();
    c.removeListener("messageCreate", onMessage);
    c.removeListener("messageDeleteBulk", onMessageDeleteBulk);
    c.removeListener("messageDelete", onMessageDelete);
  });

  // Ensure that we reload when lifecycle state changes
  createEffect(
    on(
      () => lifecycle.lifecycle.state(),
      (state) => {
        if (
          state === State.Connected &&
          atEnd() &&
          !props.highlightedMessageId()
        ) {
          caseInitialLoad();
        }
      },
      { defer: true },
    ),
  );

  // We need to cache created objects to prevent needless re-rendering
  const objectCache = new Map();

  // Determine which messages have a tail and add message dividers
  const messagesWithTail = createMemo<ListEntry[]>(() => {
    const messagesWithTail: ListEntry[] = [];
    const lastReadId = props.lastReadId() ?? "0";

    let blockedMessages = 0;
    let insertedUnreadDivider = false;

    /**
     * Create blocked message divider
     */
    const createBlockedMessageCount = () => {
      if (blockedMessages) {
        messagesWithTail.push({
          t: 2,
          count: blockedMessages,
        });

        blockedMessages = 0;
      }
    };

    const arr = messages();

    // Local timeline markers, by time, on a protected channel only
    const timeline = protectedTranscript()
      ? planTimelineMarkers(
          protectedTimeline(),
          arr.map((message) => +message.createdAt),
          atStart(),
          atEnd(),
          sameLocalDay,
        )
      : undefined;

    // Permanent history boundary divider, from the verified state only
    const boundary = protectedTranscript()
      ? planBoundaryDivider({
          idsNewestFirst: arr.map((message) => message.id),
          divider: verifiedHistory()?.divider ?? null,
          atStart: atStart(),
          atEnd: atEnd(),
          dividerAfter,
        })
      : null;

    /**
     * Push the boundary divider (after any pending blocked message count,
     * so that blocked rows stay on their own side of it)
     */
    const pushBoundaryDivider = () => {
      if (!boundary) return;
      createBlockedMessageCount();
      messagesWithTail.push(
        objectCache.get(`protected_boundary:${boundary.preHistory}`) ?? {
          t: 4,
          kind: "protected_boundary",
          preHistory: boundary.preHistory,
        },
      );
    };

    /**
     * Push timeline markers (after any pending blocked message count)
     */
    const pushTimelineMarkers = (markers?: readonly TimelineMarker[]) => {
      if (!markers?.length) return;
      createBlockedMessageCount();
      for (const marker of markers) {
        messagesWithTail.push(objectCache.get(marker) ?? { t: 3, marker });
      }
    };

    arr.forEach((message, index) => {
      const next = arr[index + 1];
      let tail = true;

      // If there is a next message, compare it to the current message
      let date = null;
      if (next) {
        // Compare dates between messages
        const adate = message.createdAt,
          bdate = next.createdAt,
          atime = +adate,
          btime = +bdate;

        if (
          adate.getFullYear() !== bdate.getFullYear() ||
          adate.getMonth() !== bdate.getMonth() ||
          adate.getDate() !== bdate.getDate()
        ) {
          date = adate;
        }

        // Compare time and properties of messages
        if (
          // split up different authors
          message.authorId !== next.authorId ||
          // split up chains which are too far apart
          Math.abs(btime - atime) >= 420000 ||
          // treat masquerade as a change in author
          !isEqual(message.masquerade, next.masquerade) ||
          // ensure all system messages render independently
          message.systemMessage ||
          next.systemMessage ||
          // replies present on current message
          message.replyIds?.length ||
          // next message in history has already been read
          // so there will be a message divider present
          (next.id.localeCompare(lastReadId) === -1 && !insertedUnreadDivider)
        ) {
          tail = false;
        }
      } else {
        tail = false;
      }

      // A timeline marker between this message and the next splits chains
      if (timeline?.breaksTail[index]) {
        tail = false;
      }

      // So does the boundary divider under the next message
      if (boundary && next && boundary.below === next.id) {
        tail = false;
      }

      // Try to add the unread divider
      if (
        !insertedUnreadDivider &&
        message.id.localeCompare(lastReadId) === -1
      ) {
        insertedUnreadDivider = true;

        messagesWithTail.push(
          objectCache.get(true) ?? {
            t: 1,
            unread: true,
          },
        );
      }

      // Markers newer than this message
      pushTimelineMarkers(timeline?.before[index]);

      // The boundary divider sits directly below this message
      if (boundary && boundary.below === message.id) {
        pushBoundaryDivider();
      }

      if (message.author?.relationship === "Blocked") {
        blockedMessages++;
      } else {
        // Push any blocked messages if they haven't been yet
        createBlockedMessageCount();

        // Add message to list, retrieve if it exists in the cache
        messagesWithTail.push(
          objectCache.get(`${message.id}:${tail}`) ?? {
            t: 0,
            message,
            tail,
          },
        );
      }

      // Markers older than this message on its day go under its divider
      pushTimelineMarkers(timeline?.beforeDate[index]);

      // Add date to list, retrieve if it exists in the cache
      if (date) {
        messagesWithTail.push(
          objectCache.get(date) ?? {
            t: 1,
            date: dayjs(date).format("LL"),
          },
        );
      }
    });

    // Markers older than every loaded message (start of conversation only)
    pushTimelineMarkers(timeline?.trailing);

    // Push remainder of blocked messages
    createBlockedMessageCount();

    // After a wipe the boundary divider sits at the top of the channel
    if (boundary && boundary.below === null) {
      pushBoundaryDivider();
    }

    // Strip unread divider if it is the first item
    // (hence would show alone at the bottom of messages)
    if (messagesWithTail[0]?.t === 1) {
      messagesWithTail.shift();
    }

    // Flush cache
    objectCache.clear();

    // Populate cache with current objects
    for (const object of messagesWithTail) {
      if (object.t === 0) {
        objectCache.set(`${object.message.id}:${object.tail}`, object);
      } else if (object.t === 1) {
        objectCache.set(object.unread ?? object.date, object);
      } else if (object.t === 3) {
        objectCache.set(object.marker, object);
      } else if (object.t === 4) {
        objectCache.set(`protected_boundary:${object.preHistory}`, object);
      }
    }

    return messagesWithTail.reverse();
  });

  /**
   * Jump to the bottom of the chat
   */
  function jumpToBottom() {
    caseJumpToBottom();

    if (props.highlightedMessageId()) {
      props.clearHighlightedMessage();
    }
  }

  /**
   * Select last message for editing if this channel's signal is true.
   * Editing state is per channel, so a list in another window never
   * resolves (or clears) this channel's request.
   */
  createEffect(
    on(
      () => state.draft.getEditingMessageId(props.channel.id),
      (shouldSetEditingMessageId) => {
        if (shouldSetEditingMessageId !== true) return;

        const channelId = props.channel.id;

        // Encrypted rows are local-only and cannot be edited on the
        // server, so skip them; with none left this clears the request.
        // If the conversation itself is gated, edit nothing: a mode flip
        // leaves old plaintext rows on screen, and editing one would PATCH
        // the new text to the server in plaintext. Edit is hidden on a
        // protected or pinned channel (plan D11).
        const message =
          serverActionsBlocked(e2ee, props.channel, client().user?.id) ||
          protectedActionsBlocked(protectedOrPinned(), "edit")
            ? undefined
            : messages().find(
                (message) =>
                  message.channelId === channelId &&
                  message.author?.self &&
                  !e2ee?.isEncryptedMessage(message.id),
              );

        if (message) {
          state.draft.setEditingMessage(message);
        } else {
          state.draft.setEditingMessage(undefined, channelId);
        }
      },
    ),
  );

  /**
   * Id of the message being edited in this channel
   * @returns Message id, if a message is being edited
   */
  function editingMessageId() {
    const id = state.draft.getEditingMessageId(props.channel.id);
    return typeof id === "string" ? id : undefined;
  }

  /**
   * Check whether to trail the currently pending messages
   * @returns Whether to trail pending message
   */
  function pendingMessageIsTrailing() {
    const messages = messagesWithTail();
    const lastMessage = messages[messages.length - 1];

    return lastMessage &&
      lastMessage.t === 0 &&
      // check if last message is authored by us
      lastMessage.message.author?.self &&
      // split up chains that are too far apart
      Math.abs(+new Date() - +lastMessage.message.createdAt) < 420000
      ? true
      : false;
  }

  /**
   * Message ids
   * @returns List of message ids
   */
  function sentMessageIdempotency() {
    return messages().map((msg) => msg.nonce!);
  }

  return (
    <>
      <Show when={plainGroup()}>
        <EncryptedOnlyNotice role="status">
          <MaterialSymbol size={20}>lock_open</MaterialSymbol>
          <span>
            <Trans>
              This group is not encrypted. You can read it, but you can't write
              here while Encrypted-only chats is on.
            </Trans>
          </span>
          <Show when={encryptGroupOffered()}>
            <Button
              variant="tonal"
              onPress={() =>
                openModal({
                  type: "e2ee_enable_group",
                  channelId: props.channel.id,
                })
              }
            >
              <Trans>Encrypt this group</Trans>
            </Button>
          </Show>
          <Button
            variant="tonal"
            onPress={() =>
              openModal({ type: "delete_channel", channel: props.channel })
            }
          >
            <Trans>Leave</Trans>
          </Button>
        </EncryptedOnlyNotice>
      </Show>
      <Show when={peerTurnedOffName()}>
        {(name) => (
          <EncryptedOnlyNotice role="status">
            <MaterialSymbol size={20}>info</MaterialSymbol>
            <span>{turnedOffText(name())}</span>
          </EncryptedOnlyNotice>
        )}
      </Show>
      <ListView2
        fetchTop={caseFetchUpwards}
        fetchBottom={caseFetchDownwards}
        atStart={atStart}
        atEnd={atEnd}
        permitFetching={() => typeof fetching() !== "string"}
      >
        <Deferred>
          <div>
            <div ref={listRef}>
              <Show when={atStart()}>
                <ConversationStart channel={props.channel} />
              </Show>
              {/* TODO: else show (loading icon) OR (load more) */}
              <For each={messagesWithTail()}>
                {(entry) => (
                  <Entry
                    {...entry}
                    listChannelId={props.channel.id}
                    highlightedMessageId={props.highlightedMessageId}
                    editingMessageId={editingMessageId()}
                    notEncryptedLabel={notEncryptedLabel}
                  />
                )}
              </For>
              {/* TODO: show (loading icon) OR (load more) */}
              <Show when={atEnd()}>
                {props.pendingMessages?.({
                  tail: pendingMessageIsTrailing(),
                  ids: sentMessageIdempotency(),
                })}
                {props.typingIndicator ?? <Padding />}
              </Show>
            </div>
          </div>
        </Deferred>
      </ListView2>
      <Show when={!atEnd()}>
        <AnchorToEnd>
          <JumpToBottom onClick={jumpToBottom} />
        </AnchorToEnd>
      </Show>
    </>
  );
}

/**
 * Anchor to the end of the messages list
 */
const AnchorToEnd = styled("div", {
  base: {
    zIndex: 30,
    position: "relative",

    "& > div": {
      width: "100%",
      position: "absolute",
      bottom: "var(--gap-md)",
    },
  },
});

/**
 * Container padding
 */
const Padding = styled("div", {
  base: {
    height: "24px",
  },
});

/**
 * Encrypted-only notice above the messages
 */
const EncryptedOnlyNotice = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "var(--gap-md)",
    flexShrink: 0,
    margin: "0 var(--gap-md) var(--gap-sm) 0",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    fontSize: "0.875em",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",

    "& > span": {
      flex: "1 1 200px",
      minWidth: 0,
    },
  },
});

/**
 * "Not encrypted" label under a message, in line with its content
 */
const NotEncryptedRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    paddingInlineStart:
      "calc(var(--gap-lg) + max(54px, calc(var(--message-avatar-size, 36px) + 18px)))",
    fontSize: "0.75em",
    color: "var(--md-sys-color-error)",
  },
});

/**
 * List entries
 */
type ListEntry =
  | {
      // Message
      t: 0;
      message: MessageInterface;
      tail: boolean;
      highlight: boolean;
    }
  | {
      // Message Divider
      t: 1;
      date?: string;
      unread?: boolean;
    }
  | {
      // Blocked messages
      t: 2;
      count: number;
    }
  | {
      // Protected channel timeline marker (local, never from the server)
      t: 3;
      marker: TimelineMarker;
    }
  | {
      // Protected channel history boundary (permanent; from the verified
      // native state only, never merged with the date or unread divider)
      t: 4;
      kind: "protected_boundary";
      preHistory: "kept" | "wiped";
    };

/**
 * Render individual list entry
 */
function Entry(
  props: ListEntry &
    Pick<Props, "highlightedMessageId"> & {
      /** Channel the list renders; a row is judged against it */
      listChannelId: string;
      editingMessageId?: string;
      notEncryptedLabel: (message: MessageInterface) => boolean;
    },
) {
  const [local, other] = splitProps(props, [
    "t",
    "listChannelId",
    "highlightedMessageId",
    "editingMessageId",
    "notEncryptedLabel",
  ]);

  return (
    <Switch>
      <Match when={local.t === 0}>
        <Message
          {...(other as ListEntry & { t: 0 })}
          listChannelId={local.listChannelId}
          highlight={
            (other as ListEntry & { t: 0 }).message.id ===
            local.highlightedMessageId()
          }
          editing={
            (other as ListEntry & { t: 0 }).message.id ===
            local.editingMessageId
          }
        />
        {/* Encrypted-only: an unencrypted message after the latch is
            labelled, never shown as encrypted */}
        <Show
          when={local.notEncryptedLabel(
            (other as ListEntry & { t: 0 }).message,
          )}
        >
          <NotEncryptedRow>
            <MaterialSymbol size={14}>lock_open</MaterialSymbol>
            <Trans>Not encrypted</Trans>
          </NotEncryptedRow>
        </Show>
      </Match>
      <Match when={local.t === 1}>
        <MessageDivider {...(other as ListEntry & { t: 1 })} />
      </Match>
      <Match when={local.t === 2}>
        <BlockedMessage count={(other as ListEntry & { t: 2 }).count} />
      </Match>
      <Match when={local.t === 3}>
        <ProtectedTimelineRow marker={(other as ListEntry & { t: 3 }).marker} />
      </Match>
      <Match when={local.t === 4}>
        <MessageDivider
          protectedBoundary={(other as ListEntry & { t: 4 }).preHistory}
        />
      </Match>
    </Switch>
  );
}

/**
 * The verified history state of a channel (`verifiedHistoryOf`): the
 * manager's view through `nativeHistoryInput`, the local pin and the SDK's
 * conflict and wipe records. Null without a channel id, a bridge surface
 * or a view.
 * @param channelId Channel id
 * @returns Accessor
 */
function useVerifiedHistory(channelId: Accessor<string | undefined>) {
  const client = useClient();

  const history = createMemo(() => {
    const id = channelId();
    const c = client();
    if (!id || !c) return null;

    const view = protectedUiOf(c.e2ee)?.protectedChannels.get(id);
    if (!view) return null;

    return verifiedHistoryOf(
      nativeHistoryInput(view.native, { seatListError: view.seatListError }),
      view.native?.history_setting,
      c.protectedPins.historyOf(id) ?? null,
      {
        conflicted: c.protectedHistory.isConflicted(id),
        wiped: c.protectedHistory.isWiped(id),
      },
    );
  });
  return history;
}

/**
 * Glyph for a timeline marker kind
 * @param kind Marker kind
 * @param tone Result of `timelineTone`
 * @returns Material symbol name
 */
function timelineGlyph(
  kind: TimelineMarker["kind"],
  tone: "quiet" | "loud",
): string {
  switch (kind) {
    case "new_device":
      return "devices";
    case "forced_removal":
      return "person_remove";
    case "history_floor":
      return tone === "loud" ? "gpp_bad" : "key_off";
    default: {
      const _exhaustive: never = kind;
      return "info";
    }
  }
}

/**
 * Local system-style row for a protected channel timeline marker (plan
 * D22). The member is named the way system messages name users (server
 * nickname, then display name); an unknown member reads "A member", never
 * an id. A history floor names no member; it reads loud when the walk
 * stopped for a reason other than hidden or missing history.
 */
function ProtectedTimelineRow(props: { marker: TimelineMarker }) {
  const client = useClient();
  const { t } = useLingui();
  const history = useVerifiedHistory(() => props.marker.channelId);

  const tone = createMemo(() => {
    const marker = props.marker;
    return timelineTone(
      marker.kind,
      marker.kind === "history_floor"
        ? historyFloorNotice(marker.stop).tone
        : null,
    );
  });

  const text = createMemo(() => {
    const c = client();
    const marker = props.marker;
    const userId = marker.kind === "history_floor" ? undefined : marker.userId;
    const serverId = c.channels.get(marker.channelId)?.serverId;
    const member =
      serverId && userId
        ? c.serverMembers.getByKey({ server: serverId, user: userId })
        : undefined;
    const user = userId ? c.users.get(userId) : undefined;

    return timelineCopy(
      props.marker,
      timelineDisplayName(
        [member?.nickname, user?.displayName],
        // C16: local msgid; C0 has no member-name fallback yet
        t`A member`,
      ),
      // "It can read this channel's history." only from the verified state
      historyVisibleOption(history()),
    );
  });

  return (
    <TimelineRow
      role="note"
      tone={tone()}
      data-protected-timeline={props.marker.kind}
    >
      <MaterialSymbol size={16}>
        {timelineGlyph(props.marker.kind, tone())}
      </MaterialSymbol>
      <span>{text()}</span>
    </TimelineRow>
  );
}

/**
 * Timeline marker row, styled like the other list-level notices
 */
const TimelineRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    marginTop: "var(--gap-md)",
    padding: "var(--gap-sm) var(--gap-xxl)",
    fontSize: "0.8em",
    overflowWrap: "anywhere",
  },
  variants: {
    // One key per `timelineTone` result; `tone` is always passed
    tone: {
      quiet: {
        fontStyle: "italic",
        color: "var(--md-sys-color-outline)",
      },
      loud: {
        fontStyle: "normal",
        color: "var(--md-sys-color-error)",
      },
    },
  },
  defaultVariants: {
    tone: "quiet",
  },
});

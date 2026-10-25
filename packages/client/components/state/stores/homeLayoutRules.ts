/**
 * Rules behind the Home page's arrangeable cards: which cards exist, where
 * they start, and how a drag, a menu move or a hide changes the saved layout.
 * Kept free of Solid so `node --test` can load it.
 *
 * The layout is synced between devices, so everything read back from storage
 * is untrusted and goes through `cleanHomeLayout` first.
 */

/**
 * Every card Home can show, in default order. These strings are what gets
 * stored and synced: never rename one, only add new ones.
 */
export const HOME_BLOCKS = [
  "welcome",
  "cipher",
  "happening",
  "unread",
  "mentions",
  "upcoming",
  "discover",
  "staff",
  "friends",
  "streamers",
  "whatsNew",
  "import",
] as const;

export type HomeBlockId = (typeof HOME_BLOCKS)[number];

export type HomeColumn = "main" | "side";

/** Where each card goes before anyone has moved it */
export const DEFAULT_COLUMN: Record<HomeBlockId, HomeColumn> = {
  welcome: "main",
  cipher: "main",
  happening: "main",
  unread: "main",
  mentions: "main",
  upcoming: "main",
  discover: "main",
  staff: "main",
  friends: "side",
  streamers: "side",
  whatsNew: "side",
  import: "side",
};

export type TypeHomeLayout = {
  /** Cards in the wide column, top to bottom */
  main: HomeBlockId[];

  /** Cards in the narrow column, top to bottom */
  side: HomeBlockId[];

  /** Cards the person switched off; they keep their place for when they return */
  hidden: HomeBlockId[];
};

// A synced key may hold ~1 MiB, so clean() only looks at this many entries
// of each list; a real layout has one entry per card
const MAX_ENTRIES_SCANNED = HOME_BLOCKS.length * 10;

/**
 * Whether a value is one of the known card ids
 * @param value Candidate
 */
export function isHomeBlockId(value: unknown): value is HomeBlockId {
  // hasOwnProperty, so synced data cannot name "__proto__" or "toString"
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(DEFAULT_COLUMN, value)
  );
}

/**
 * The other column
 * @param column Column
 */
export function otherColumn(column: HomeColumn): HomeColumn {
  return column === "main" ? "side" : "main";
}

/**
 * The layout before anyone has changed anything
 */
export function defaultHomeLayout(): TypeHomeLayout {
  return {
    main: HOME_BLOCKS.filter((id) => DEFAULT_COLUMN[id] === "main"),
    side: HOME_BLOCKS.filter((id) => DEFAULT_COLUMN[id] === "side"),
    hidden: [],
  };
}

/**
 * Known card ids from an untrusted list, in order, leaving out any already
 * in `seen` (which this adds to)
 * @param list Candidate list
 * @param seen Ids taken so far
 */
function knownIds(list: unknown, seen: Set<HomeBlockId>): HomeBlockId[] {
  const out: HomeBlockId[] = [];
  if (!Array.isArray(list)) return out;

  const end = Math.min(list.length, MAX_ENTRIES_SCANNED);
  for (let i = 0; i < end; i++) {
    const id: unknown = list[i];
    if (isHomeBlockId(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Turn stored or synced data into a usable layout.
 *
 * Unknown ids are dropped and each card appears once across both columns
 * (the first place it is listed wins). A card missing from both columns, such
 * as one added in a later release, goes to the end of its default column, so
 * people who arranged their Home still get new cards.
 *
 * The result is a fixed point (cleaning it again changes nothing), as sync
 * compares cleaned remote data against the live store.
 * @param input Untrusted layout
 */
export function cleanHomeLayout(input: unknown): TypeHomeLayout {
  const raw: Record<string, unknown> =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const placed = new Set<HomeBlockId>();
  const main = knownIds(raw.main, placed);
  const side = knownIds(raw.side, placed);

  for (const id of HOME_BLOCKS) {
    if (placed.has(id)) continue;
    (DEFAULT_COLUMN[id] === "main" ? main : side).push(id);
  }

  return { main, side, hidden: knownIds(raw.hidden, new Set()) };
}

/**
 * The column a card is in
 * @param layout Layout
 * @param id Card
 */
export function columnOf(
  layout: TypeHomeLayout,
  id: HomeBlockId,
): HomeColumn | undefined {
  if (layout.main.includes(id)) return "main";
  if (layout.side.includes(id)) return "side";
  return undefined;
}

/**
 * Cards a column draws: in order, not hidden, and available right now
 * @param layout Layout
 * @param column Column
 * @param available Whether a card has anything to show
 */
export function shownBlocks(
  layout: TypeHomeLayout,
  column: HomeColumn,
  available: (id: HomeBlockId) => boolean,
): HomeBlockId[] {
  return layout[column].filter(
    (id) => !layout.hidden.includes(id) && available(id),
  );
}

/**
 * Put a column's new on-screen order back into its full order.
 *
 * A drag only sees the cards a column draws. Cards it does not draw (hidden,
 * or with nothing to show) stay where they were, right after the same drawn
 * card they followed; one whose card left the column follows the nearest
 * drawn card before it that is still here, or goes first.
 * @param column The column's full order before the drop
 * @param visible The column's drawn cards after the drop, in order
 * @param shown Cards that were drawn (in either column) before the drop
 */
export function mergeVisibleOrder(
  column: readonly HomeBlockId[],
  visible: readonly HomeBlockId[],
  shown: ReadonlySet<HomeBlockId>,
): HomeBlockId[] {
  const stays = new Set(visible);
  const leading: HomeBlockId[] = [];
  const after = new Map<HomeBlockId, HomeBlockId[]>();

  column.forEach((id, index) => {
    if (shown.has(id)) return;

    let anchor: HomeBlockId | undefined;
    for (let j = index - 1; j >= 0; j--) {
      const before = column[j];
      if (shown.has(before) && stays.has(before)) {
        anchor = before;
        break;
      }
    }

    if (anchor === undefined) leading.push(id);
    else after.set(anchor, [...(after.get(anchor) ?? []), id]);
  });

  const out = [...leading];
  for (const id of visible) {
    out.push(id, ...(after.get(id) ?? []));
  }
  return out;
}

/**
 * Apply a drop: `visible` is the order a column now draws.
 *
 * Cards new to this column are taken out of the other one. A card that left
 * this column is not put anywhere here: the drop onto the other column
 * reports it, and `cleanHomeLayout` puts back anything a drop left out.
 * @param layout Layout
 * @param column Column the drop happened in
 * @param visible Card ids the column now draws, in order
 * @param shown Cards that were drawn (in either column) before the drop
 */
export function applyDrop(
  layout: TypeHomeLayout,
  column: HomeColumn,
  visible: readonly string[],
  shown: ReadonlySet<HomeBlockId>,
): TypeHomeLayout {
  const ids = knownIds(visible, new Set());
  const next = mergeVisibleOrder(layout[column], ids, shown);
  const other = otherColumn(column);

  return {
    ...layout,
    [column]: next,
    [other]: layout[other].filter((id) => !next.includes(id)),
  } as TypeHomeLayout;
}

export type HomeMove = "up" | "down" | "other";

/**
 * Move a card one drawn place up or down within its column, or to the end
 * of the other column. Cards that are not drawn are stepped over, so one
 * press always moves the card past something the person can see.
 * @param layout Layout
 * @param id Card
 * @param move Direction
 * @param shown Cards drawn right now
 * @returns The new layout, or the same object when nothing moves
 */
export function moveBlock(
  layout: TypeHomeLayout,
  id: HomeBlockId,
  move: HomeMove,
  shown: ReadonlySet<HomeBlockId>,
): TypeHomeLayout {
  const column = columnOf(layout, id);
  if (!column) return layout;

  const list = [...layout[column]];
  const from = list.indexOf(id);

  if (move === "other") {
    const other = otherColumn(column);
    return {
      ...layout,
      [column]: list.filter((entry) => entry !== id),
      [other]: [...layout[other], id],
    } as TypeHomeLayout;
  }

  const step = move === "up" ? -1 : 1;
  let to = from + step;
  while (to >= 0 && to < list.length && !shown.has(list[to])) to += step;
  if (to < 0 || to >= list.length) return layout;

  // Index `to` is right for both: moving up lands before the target, and
  // moving down lands after it because removing `id` shifted it left by one
  list.splice(from, 1);
  list.splice(to, 0, id);

  return { ...layout, [column]: list } as TypeHomeLayout;
}

/**
 * Switch a card off or back on
 * @param layout Layout
 * @param id Card
 * @param hidden Whether it should be hidden
 */
export function setBlockHidden(
  layout: TypeHomeLayout,
  id: HomeBlockId,
  hidden: boolean,
): TypeHomeLayout {
  const has = layout.hidden.includes(id);
  if (has === hidden) return layout;

  return {
    ...layout,
    hidden: hidden
      ? [...layout.hidden, id]
      : layout.hidden.filter((entry) => entry !== id),
  };
}

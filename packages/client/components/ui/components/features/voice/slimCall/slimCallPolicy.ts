/**
 * The Slim view call screen: the pure rules for when it is up.
 *
 * In Slim view a direct message or group call fills the screen instead of
 * sitting in the docked call card. The user can minimise the screen back to
 * the card and bring it up again. Only one surface may draw the participant
 * tiles at a time, so the card and the picture-in-picture ask
 * `slimCallOwnsTiles` before they draw theirs.
 *
 * This module holds the rules and nothing else: it imports nothing and reads
 * no app or browser state (every fact is passed in), so `node --test` loads
 * it directly (`slimCallPolicy.test.ts`). The shared minimised flag lives in
 * `slimCallView.ts`.
 */

/** The facts that decide whether the call screen is up. */
type SlimCallInput = {
  /** Whether Slim view is active on this device. */
  slim: boolean;
  /** Whether this device is in a call. */
  inCall: boolean;
  /** The type of the call's channel, or `undefined` while it is not known. */
  channelType: string | undefined;
  /** Whether the user has minimised the call screen back to the card. */
  minimised: boolean;
};

/**
 * Whether a channel of this type gets the call screen: a direct message or a
 * group, and nothing else. A server voice channel has the type "TextChannel",
 * so no server call passes. The match is exact, so a type this build does
 * not know is treated like a server channel.
 */
function isConversation(channelType: string | undefined): boolean {
  return channelType === "DirectMessage" || channelType === "Group";
}

/**
 * Whether the full-screen call screen is showing.
 *
 * It shows for a direct message or group call in Slim view until the user
 * minimises it. While the channel is not known yet the answer is false, so
 * the call stays on the docked card until the caller asks again with the
 * type.
 * @param input The facts
 * @returns Whether the call screen is showing
 */
export function slimCallShown(input: SlimCallInput): boolean {
  if (!input.slim) return false;
  if (!input.inCall) return false;
  if (!isConversation(input.channelType)) return false;

  return !input.minimised;
}

/**
 * Whether a full-screen call screen is up, so the docked card and the
 * picture-in-picture must not also render tiles. Same answer as
 * `slimCallShown` today; it has its own name so the two callers read
 * correctly.
 * @param input The facts
 * @returns Whether the call screen is the surface that renders the tiles
 */
export function slimCallOwnsTiles(input: SlimCallInput): boolean {
  return slimCallShown(input);
}

/**
 * The minimised flag after a call change: leaving a call or changing channel
 * clears it, so the next call starts with the call screen up. Nothing here
 * ever turns the flag on; only the user does that.
 * @param input The flag as it is now, whether this device is in a call, and
 * whether the call is on a different channel than the last time this was asked
 * @returns The flag to store
 */
export function nextSlimCallMinimised(input: {
  minimised: boolean;
  inCall: boolean;
  channelChanged: boolean;
}): boolean {
  if (!input.inCall) return false;
  if (input.channelChanged) return false;

  return input.minimised;
}

/** What the video layout rule reads from one participant tile. */
type SlimCallTile = {
  /** Whether the tile is this device's own participant. */
  own: boolean;
  /** Whether the tile has a real, unmuted picture. */
  liveVideo: boolean;
  /** Whether the tile is a screen share rather than a camera. */
  screenShare: boolean;
  /** Whether the user picked this tile for the large box. */
  focused: boolean;
};

/**
 * The video layout of a direct call: one picture fills the screen and the
 * other sits in a corner, as a phone's own video call does.
 *
 * It applies to a direct message call with exactly the two sides' camera
 * tiles and at least one camera on. A group, a screen share, a call still
 * waiting for the other side, and a call with both cameras off keep the
 * plain arrangement. The other side fills the screen unless the user picked
 * their own tile, in which case the two swap. While the corner tile is hidden
 * there is nothing to swap with, so the other side always fills the screen.
 * @param input The channel type, the tiles in the order they are drawn, and
 * whether the user has hidden the corner tile
 * @returns The indexes of the tile that fills the screen and of the corner
 * tile, or `null` for the plain arrangement
 */
export function slimCallVideoLayout(input: {
  channelType: string | undefined;
  tiles: readonly SlimCallTile[];
  cornerHidden?: boolean;
}): { main: number; corner: number } | null {
  if (input.channelType !== "DirectMessage") return null;

  const { tiles } = input;
  if (tiles.length !== 2) return null;
  if (tiles.some((tile) => tile.screenShare)) return null;
  if (!tiles.some((tile) => tile.liveVideo)) return null;

  const own = tiles.findIndex((tile) => tile.own);
  if (own === -1 || tiles[1 - own].own) return null;

  const focused = input.cornerHidden
    ? -1
    : tiles.findIndex((tile) => tile.focused);
  const main = focused === -1 ? 1 - own : focused;

  return { main, corner: 1 - main };
}

/** How far a press on the corner tile may travel, in px, and still be a press. */
const CORNER_DRAG_SLOP = 8;

/**
 * Whether a pointer that has moved this far from where it went down is
 * dragging the corner tile. Anything shorter is a press, which swaps the two
 * pictures.
 * @param dx Horizontal travel in px
 * @param dy Vertical travel in px
 * @returns Whether this is a drag
 */
export function isCornerDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > CORNER_DRAG_SLOP;
}

/**
 * Where the corner tile goes when the user drags it: anywhere, as long as
 * all of it stays inside the area with a margin to the edges. An area too
 * small for that keeps the tile at the margin from the top left.
 * @param input The wanted top left corner, the tile's size, the area's size
 * and the margin, all in px
 * @returns The top left corner to use
 */
export function clampCornerPosition(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  areaWidth: number;
  areaHeight: number;
  margin: number;
}): { x: number; y: number } {
  const within = (value: number, room: number) => {
    const max = Math.max(input.margin, room - input.margin);
    if (!Number.isFinite(value)) return input.margin;
    return Math.min(Math.max(value, input.margin), max);
  };

  return {
    x: within(input.x, input.areaWidth - input.width),
    y: within(input.y, input.areaHeight - input.height),
  };
}

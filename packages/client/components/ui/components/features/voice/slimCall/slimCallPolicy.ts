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

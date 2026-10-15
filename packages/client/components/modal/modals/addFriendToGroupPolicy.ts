/**
 * Whether a friend may be added to an existing group chat. Pure, so the
 * branches are spec'd under `node --test` (`addFriendToGroupPolicy.test.ts`).
 *
 * A plain server add to an encrypted group leaves the new member unable to
 * read it, so every branch of that path fails closed. Two things make that
 * hard to know:
 *
 *  - A native "plaintext" verdict for a group only means THIS device never
 *    learned about encryption there. The local row is created solely by a
 *    received group_enable, so a new device, a missed enable or a
 *    server-side add all read "plaintext" for a group that is encrypted.
 *  - No server field marks a group encrypted.
 *
 * What does hold: a group can only be encrypted if at least one OTHER member
 * has E2EE devices. So the add goes ahead only when every other member's
 * device listing was fetched just now and came back empty. A listing that
 * could not be fetched (rate limited, blocked pair, offline, odd shape) is
 * not "empty": it refuses.
 *
 * A group this device knows is encrypted takes the other route: the modal
 * includes the new member in its encryption (`rowStateFor` "include",
 * `waitForMember`), and `decideAdd` still refuses it.
 */

/**
 * The most other members one add will fetch listings for. Every listing
 * spends the shared `e2ee_devices` budget (120 per 10 s) that calls draw on
 * to admit joiners, so a bigger group refuses as "unverified" before any
 * request is made.
 */
export const MAX_VERIFIED_OTHER_MEMBERS = 20;

/** Whether a group has more other members than an add may check */
export function tooManyToVerify(memberIds: readonly string[]): boolean {
  return memberIds.length > MAX_VERIFIED_OTHER_MEMBERS;
}

/** The native send-mode verdict for the group, or null when unavailable */
export type GroupVerdict =
  | "encrypt"
  | "blocked"
  | "plaintext"
  | "peer_downgraded"
  | null
  | undefined;

/** One member's `GET /e2ee/devices/{id}` outcome */
export type MemberListing =
  | { kind: "fetched"; body: unknown }
  | { kind: "error"; error?: unknown };

export type AddDecision =
  | { kind: "add" }
  | { kind: "refuse"; reason: "encrypted" | "unverified" };

/** How a group row looks before anyone clicks it */
export type RowState = "addable" | "include" | "encrypted" | "unverified";

/**
 * Row display from the cached verdict. "addable" only means the click is
 * worth trying: the device listings are checked on click. "include" is an
 * encrypted group this device can add someone to by including them in its
 * encryption (the modal runs its own preflight on confirm); without a ready
 * device an encrypted group stays "encrypted", which can't be clicked.
 */
export function rowStateFor(
  verdict: GroupVerdict,
  selfReady: boolean,
): RowState {
  if (verdict === "encrypt") return selfReady ? "include" : "encrypted";
  return verdict === "plaintext" && selfReady ? "addable" : "unverified";
}

/**
 * How long an include waits for the local channel to list the new member
 * after the server add. Including them before that would let the next
 * group reconcile, which only knows the members it is shown, mark them
 * removed again.
 */
export const INCLUDE_MEMBER_WAIT_MS = 5000;

const MEMBER_POLL_MS = 100;

/**
 * Poll `has` every 100 ms until it is true (resolves true) or `timeoutMs`
 * runs out or `signal` aborts (resolves false). `has` is checked once before
 * the first sleep, so a member already present returns at once. Never
 * throws: a `has` that throws counts as "not yet", a `sleep` that rejects as
 * a finished sleep. Elapsed time is the larger of the sleeps requested and
 * the wall clock, so an injected `sleep` stays deterministic in specs and a
 * throttled timer can't stretch the wait far past the timeout. A timeout
 * that isn't a positive finite number checks once and gives up.
 */
export async function waitForMember(
  has: () => boolean,
  opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const { signal } = opts;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 0;

  const present = () => {
    try {
      return has() === true;
    } catch {
      return false;
    }
  };

  // An abort means the caller no longer wants the include to go ahead, so
  // it wins over a member who has just appeared.
  if (signal?.aborted) return false;
  if (present()) return true;

  const start = Date.now();
  let slept = 0;
  for (;;) {
    const elapsed = Math.max(slept, Date.now() - start);
    if (elapsed >= timeoutMs) return false;
    const ms = Math.min(MEMBER_POLL_MS, timeoutMs - elapsed);

    // Ends early on abort, and survives a sleep that throws or rejects.
    await new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        resolve();
      };
      signal?.addEventListener("abort", done);
      let pending: Promise<void>;
      try {
        pending = sleep(ms);
      } catch {
        pending = Promise.resolve();
      }
      Promise.resolve(pending).then(done, done);
    });
    slept += ms;

    if (signal?.aborted) return false;
    if (present()) return true;
  }
}

/**
 * The members whose listings must be empty: every recipient except self.
 * Null when self is unknown, which refuses (we can't tell who "other" is).
 */
export function otherMemberIds(
  recipientIds: Iterable<string>,
  selfId: string | undefined,
): string[] | null {
  if (!selfId) return null;
  return [...new Set(recipientIds)].filter((id) => id !== selfId);
}

/** "empty" only for a fetched JSON array with nothing in it */
export function classifyListing(
  listing: MemberListing | undefined,
): "empty" | "devices" | "error" {
  if (!listing || listing.kind !== "fetched") return "error";
  if (!Array.isArray(listing.body)) return "error";
  return listing.body.length === 0 ? "empty" : "devices";
}

/**
 * The add decision. Allowed only when this device is ready, a fresh native
 * verdict says "plaintext", and every other member's listing is present and
 * empty. Any member with devices refuses as "encrypted" (it may be); any
 * missing or failed listing, or more other members than
 * `MAX_VERIFIED_OTHER_MEMBERS`, refuses as "unverified". No other members
 * at all is allowed: nobody else could have turned encryption on.
 */
export function decideAdd(input: {
  selfReady: boolean;
  verdict: GroupVerdict;
  memberIds: readonly string[] | null;
  listings: ReadonlyMap<string, MemberListing>;
}): AddDecision {
  if (!input.selfReady) return { kind: "refuse", reason: "unverified" };
  if (input.verdict === "encrypt") {
    return { kind: "refuse", reason: "encrypted" };
  }
  if (input.verdict !== "plaintext") {
    return { kind: "refuse", reason: "unverified" };
  }
  if (!input.memberIds) return { kind: "refuse", reason: "unverified" };
  if (tooManyToVerify(input.memberIds)) {
    return { kind: "refuse", reason: "unverified" };
  }

  let unverified = false;
  for (const id of input.memberIds) {
    const result = classifyListing(input.listings.get(id));
    if (result === "devices") return { kind: "refuse", reason: "encrypted" };
    if (result === "error") unverified = true;
  }

  return unverified
    ? { kind: "refuse", reason: "unverified" }
    : { kind: "add" };
}

/**
 * Fetch every listing with at most `concurrency` requests in flight, and
 * stop starting new ones once any result already refuses: there is no point
 * spending the rate-limit budget on a decision that's made. Ids never
 * fetched are absent from the map, which `decideAdd` reads as a refusal.
 * A group too big to verify fetches nothing at all.
 * `fetchOne` must not throw; if it does anyway, that member is an error.
 */
export async function collectListings(
  memberIds: readonly string[],
  fetchOne: (id: string) => Promise<MemberListing>,
  concurrency = 4,
): Promise<Map<string, MemberListing>> {
  const listings = new Map<string, MemberListing>();
  if (tooManyToVerify(memberIds)) return listings;
  const queue = [...memberIds];
  let stop = false;

  async function worker() {
    while (!stop) {
      const id = queue.shift();
      if (id === undefined) return;
      let listing: MemberListing;
      try {
        listing = await fetchOne(id);
      } catch (error) {
        listing = { kind: "error", error };
      }
      listings.set(id, listing);
      if (classifyListing(listing) !== "empty") stop = true;
    }
  }

  const workers = Math.max(1, Math.min(concurrency, 4, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return listings;
}

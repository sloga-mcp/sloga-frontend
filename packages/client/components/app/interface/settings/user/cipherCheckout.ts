/**
 * Every decision behind the Cipher settings page (`./CipherSettings.tsx`):
 * which tiers are offered and at what price, the checkout request, the
 * settings context it is opened with, and the controller that reads the
 * buyer's standing and polls it after a checkout.
 *
 * # Why this is a separate module
 *
 * `CipherSettings.tsx` reaches `solid-js`, lingui, `@revolt/ui` and the
 * client, so nothing declared inside it is loadable by `node --test`. This
 * module imports types only (erased at runtime), and the page keeps only the
 * composition.
 *
 * The server owns prices and decides every purchase (same tier, downgrades,
 * disputes, one live checkout per user, sales open, numbers left). The
 * figures here are for display, and every gate here only decides what is
 * offered, never what is allowed.
 */
import type { CipherTier, UserCipher } from "stoat.js";

/**
 * The tier, and `User.cipher` (the public badge, absent while a payment is
 * disputed), as stoat.js defines them for the whole client
 */
export type { CipherTier, UserCipher };

export type CipherSku =
  | { type: "CipherNew"; tier: CipherTier }
  | { type: "CipherUpgrade"; from: CipherTier; to: CipherTier };

export type CipherMembership = {
  number: number;
  tier: CipherTier;
  disputed: boolean;
  prot_grant: number;
};

export type CipherPending = {
  order_id: string;
  sku: CipherSku;
  /** Epoch ms */
  expires_at: number;
};

/** `GET /payments/cipher/@me` */
export type CipherMe = {
  membership?: CipherMembership;
  pending?: CipherPending;
};

/** `GET /payments/cipher/stats` */
export type CipherStats = {
  claimed: number;
  cap: number;
  open: boolean;
  closes_at?: number;
};

/** Cheapest first */
export const CIPHER_TIERS: readonly CipherTier[] = ["T99", "T149", "T299"];

const TIER_CENTS: Record<CipherTier, number> = {
  T99: 9900,
  T149: 14900,
  T299: 29900,
};

/** Prot granted at launch per tier (display only) */
const TIER_PROT: Record<CipherTier, number> = {
  T99: 16_500,
  T149: 33_000,
  T299: 75_000,
};

/**
 * `@me` has its own rate-limit bucket, `payments_me`: 10 requests per fixed
 * 10 s window per session. Reads of the standing keep at least this gap, so
 * one page spends at most 5 of them in any 10 s and leaves the rest to
 * another tab on the same session.
 */
export const MIN_REQUEST_GAP_MS = 2000;

/** Poll interval after a checkout */
export const POLL_INTERVAL_MS = 5000;

/** How long a poll runs before it gives up */
export const POLL_TIMEOUT_MS = 2 * 60_000;

/**
 * How long the standing stays unread after a checkout request settles. No
 * new read starts while one is in flight either (a read already in flight
 * still lands): the buy is the request that matters, and no poll read is
 * started alongside it.
 */
export const CHECKOUT_PAUSE_MS = 1000;

/**
 * Longest `retry_after` a rate-limited checkout waits out before its one
 * automatic retry (a `payments` window: 3 per 10 s). A longer wait is
 * reported instead, so the buy button never sits disabled for a minute.
 */
export const CHECKOUT_RETRY_MAX_MS = 10_000;

/** Wait after a 429 that carries no usable `retry_after` (one window) */
const RATE_LIMIT_FALLBACK_MS = 10_000;

/** Longest wait honored from a `retry_after` */
const RATE_LIMIT_MAX_MS = 60_000;

/**
 * Hosts a checkout page may be on, compared exactly: no subdomain, port or
 * credentials, and nothing that merely starts or ends with one of them
 */
export const CHECKOUT_HOSTS: readonly string[] = ["checkout.stripe.com"];

export function isCipherTier(value: unknown): value is CipherTier {
  return value === "T99" || value === "T149" || value === "T299";
}

/** Position of a tier, cheapest first */
export function tierRank(tier: CipherTier): number {
  return CIPHER_TIERS.indexOf(tier);
}

/** List price of a tier in US cents */
export function tierCents(tier: CipherTier): number {
  return TIER_CENTS[tier];
}

/** The badge number as it is shown everywhere: `#0042` */
export function formatCipherNumber(number: number): string {
  return `#${String(number).padStart(4, "0")}`;
}

/**
 * The app locale (`i18n.locale`, which may use `_`) as an Intl tag, as
 * `formatCount` reads it
 */
function intlLocale(locale: string | undefined): string {
  return (locale ?? "en").replace(/_/g, "-");
}

/** A price in US cents, in the app locale: `$99`, `US$ 149,50` */
export function formatUsd(cents: number, locale: string | undefined): string {
  const options: Intl.NumberFormatOptions = {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  };
  try {
    return new Intl.NumberFormat(intlLocale(locale), options).format(
      cents / 100,
    );
  } catch {
    return new Intl.NumberFormat("en", options).format(cents / 100);
  }
}

/** A time of day (epoch ms), short, in the app locale */
export function formatShortTime(
  ms: number,
  locale: string | undefined,
): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      timeStyle: "short",
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(ms);
  }
}

/** The tier a checkout is for, whether a new membership or an upgrade */
export function skuTier(sku: CipherSku): CipherTier {
  return sku.type === "CipherNew" ? sku.tier : sku.to;
}

// ---------------------------------------------------------------------------
// Parsing what the server and the client store hand us
// ---------------------------------------------------------------------------

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * `User.cipher` from the client store, or undefined when it is absent or not
 * the shape this page understands
 */
export function parseUserCipher(value: unknown): UserCipher | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { number, tier } = value as { number?: unknown; tier?: unknown };
  if (!isPositiveInteger(number) || !isCipherTier(tier)) return undefined;
  return { number, tier };
}

function parseSku(value: unknown): CipherSku | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const sku = value as {
    type?: unknown;
    tier?: unknown;
    from?: unknown;
    to?: unknown;
  };
  if (sku.type === "CipherNew" && isCipherTier(sku.tier)) {
    return { type: "CipherNew", tier: sku.tier };
  }
  if (
    sku.type === "CipherUpgrade" &&
    isCipherTier(sku.from) &&
    isCipherTier(sku.to)
  ) {
    return { type: "CipherUpgrade", from: sku.from, to: sku.to };
  }
  return undefined;
}

/**
 * The `@me` body, keeping only parts this page understands. A part it cannot
 * read is dropped rather than guessed at.
 */
export function parseCipherMe(value: unknown): CipherMe {
  const me: CipherMe = {};
  if (typeof value !== "object" || value === null) return me;
  const body = value as { membership?: unknown; pending?: unknown };

  if (typeof body.membership === "object" && body.membership !== null) {
    const m = body.membership as {
      number?: unknown;
      tier?: unknown;
      disputed?: unknown;
      prot_grant?: unknown;
    };
    if (isPositiveInteger(m.number) && isCipherTier(m.tier)) {
      me.membership = {
        number: m.number,
        tier: m.tier,
        disputed: m.disputed === true,
        prot_grant:
          Number.isSafeInteger(m.prot_grant) && (m.prot_grant as number) >= 0
            ? (m.prot_grant as number)
            : 0,
      };
    }
  }

  if (typeof body.pending === "object" && body.pending !== null) {
    const p = body.pending as {
      order_id?: unknown;
      sku?: unknown;
      expires_at?: unknown;
    };
    const sku = parseSku(p.sku);
    if (
      typeof p.order_id === "string" &&
      sku &&
      typeof p.expires_at === "number" &&
      Number.isFinite(p.expires_at)
    ) {
      me.pending = { order_id: p.order_id, sku, expires_at: p.expires_at };
    }
  }

  return me;
}

/** The stats body, or undefined when it is not one */
export function parseCipherStats(value: unknown): CipherStats | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const s = value as {
    claimed?: unknown;
    cap?: unknown;
    open?: unknown;
    closes_at?: unknown;
  };
  if (
    !Number.isSafeInteger(s.claimed) ||
    !Number.isSafeInteger(s.cap) ||
    typeof s.open !== "boolean"
  ) {
    return undefined;
  }
  return {
    claimed: s.claimed as number,
    cap: s.cap as number,
    open: s.open,
    closes_at: typeof s.closes_at === "number" ? s.closes_at : undefined,
  };
}

// ---------------------------------------------------------------------------
// What the page offers
// ---------------------------------------------------------------------------

export type CipherOffer = {
  tier: CipherTier;
  kind: "new" | "upgrade";
  /** What this checkout charges: the list price, or the difference */
  cents: number;
  /** Prot the tier carries at launch */
  prot: number;
};

/**
 * Tiers on offer above `current`: all three at list price for a non-member,
 * otherwise only higher tiers at the difference. The same tier and
 * downgrades are never offered.
 */
export function cipherOffers(current: CipherTier | undefined): CipherOffer[] {
  const from = current === undefined ? -1 : tierRank(current);
  const paid = current === undefined ? 0 : TIER_CENTS[current];

  return CIPHER_TIERS.filter((tier) => tierRank(tier) > from).map((tier) => ({
    tier,
    kind: current === undefined ? "new" : "upgrade",
    cents: TIER_CENTS[tier] - paid,
    prot: TIER_PROT[tier],
  }));
}

/**
 * Offers for a loaded standing. None while a payment is disputed: the server
 * voids an upgrade bought during an open dispute, so offering one would only
 * charge and refund the buyer.
 */
export function pageOffers(me: CipherMe): CipherOffer[] {
  if (me.membership?.disputed) return [];
  return cipherOffers(me.membership?.tier);
}

/** A checkout that is still open at `now` */
export function livePending(
  me: CipherMe | undefined,
  now: number,
): CipherPending | undefined {
  const pending = me?.pending;
  return pending && pending.expires_at > now ? pending : undefined;
}

export type SaleStatus = "open" | "closed" | "soldOut";

/**
 * The sale as the public counter reports it; undefined while it is unknown,
 * in which case the page offers everything and the server decides
 */
export function saleStatus(
  stats: CipherStats | undefined,
): SaleStatus | undefined {
  if (!stats) return undefined;
  if (!stats.open) return "closed";
  if (stats.claimed >= stats.cap) return "soldOut";
  return "open";
}

/**
 * What one offer's button does:
 * - `buy`: start a checkout;
 * - `resume`: the open checkout is for this tier, so asking again returns
 *   its page;
 * - `waitForPending`: another tier has an open checkout, which the server
 *   refuses to replace until it expires;
 * - `closed` / `soldOut`: the sale refuses it (sold out only stops new
 *   memberships; an upgrade keeps its number).
 */
export type OfferAction =
  | "buy"
  | "resume"
  | "waitForPending"
  | "closed"
  | "soldOut";

export function offerAction(
  offer: CipherOffer,
  me: CipherMe,
  sale: SaleStatus | undefined,
  now: number,
): OfferAction {
  if (sale === "closed") return "closed";
  const pending = livePending(me, now);
  if (pending) {
    return skuTier(pending.sku) === offer.tier ? "resume" : "waitForPending";
  }
  if (sale === "soldOut" && offer.kind === "new") return "soldOut";
  return "buy";
}

// ---------------------------------------------------------------------------
// Settings context and the checkout return
// ---------------------------------------------------------------------------

/** How Stripe sent the buyer back (`?cipher=success|cancel` on the web) */
export type CheckoutReturn = "success" | "cancel";

export type CipherSettingsContext = {
  /** Tier picked before the page opened (the sloga.gg deep link) */
  tier?: CipherTier;
  /** Set when the page opens on the way back from checkout */
  checkout?: CheckoutReturn;
};

/**
 * Read the settings context the page was opened with:
 * `{ page: "cipher", tier?: CipherTier, checkout?: "success" | "cancel" }`.
 * Anything else in it is ignored.
 */
export function parseCipherContext(value: unknown): CipherSettingsContext {
  if (typeof value !== "object" || value === null) return {};
  const ctx = value as { tier?: unknown; checkout?: unknown };
  return {
    tier: isCipherTier(ctx.tier) ? ctx.tier : undefined,
    checkout:
      ctx.checkout === "success" || ctx.checkout === "cancel"
        ? ctx.checkout
        : undefined,
  };
}

/** Where the server sends the buyer after checkout */
export function checkoutReturnTo(nativeShell: boolean): "web" | "shell" {
  return nativeShell ? "shell" : "web";
}

/**
 * Only ever open an https page on a {@link CHECKOUT_HOSTS} host, whatever the
 * server sent. `host` (not `hostname`) so an explicit port is refused, and no
 * credentials, so `https://checkout.stripe.com@evil.com` (whose host is
 * evil.com) and `https://x@checkout.stripe.com` are both refused.
 *
 * Returns the page as the URL parser serialized it (`url.href`), and that is
 * what gets opened: the URL that was checked, never the raw string.
 */
export function checkoutHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const allowed =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    CHECKOUT_HOSTS.includes(url.host);
  return allowed ? url.href : undefined;
}

/** See {@link checkoutHref} */
export function isCheckoutUrl(value: unknown): value is string {
  return checkoutHref(value) !== undefined;
}

/**
 * Hand the buyer to the checkout page. Shells open it in the system browser:
 * Tauri allows any navigation, so assigning `location` would load Stripe
 * inside the app window.
 */
export function openCheckout(
  url: string,
  nativeShell: boolean,
  nav: {
    open: (url: string, target: string, features: string) => unknown;
    assign: (url: string) => void;
  },
): void {
  if (nativeShell) {
    nav.open(url, "_blank", "noopener");
  } else {
    nav.assign(url);
  }
}

/**
 * The checkout this tab started, kept in session storage across the trip to
 * Stripe so the return knows which tier to wait for. Keyed to the account,
 * and dropped once the checkout could no longer be open (35 min) plus slack.
 */
export type CheckoutIntent = { user: string; tier: CipherTier; at: number };

export const INTENT_KEY = "sloga.cipher.checkout";

export const INTENT_TTL_MS = 40 * 60_000;

export function encodeIntent(intent: CheckoutIntent): string {
  return JSON.stringify(intent);
}

export function readIntent(
  raw: string | null | undefined,
  user: string | undefined,
  now: number,
): CheckoutIntent | undefined {
  if (!raw || !user) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const intent = value as { user?: unknown; tier?: unknown; at?: unknown };
  if (
    intent.user !== user ||
    !isCipherTier(intent.tier) ||
    typeof intent.at !== "number" ||
    intent.at > now ||
    now - intent.at > INTENT_TTL_MS
  ) {
    return undefined;
  }
  return { user, tier: intent.tier, at: intent.at };
}

/**
 * Whether a standing read after a checkout shows that checkout finished.
 *
 * With the tier known: a membership at or above it. Without it (the intent
 * was lost): any membership with no checkout still open. `@me` lists only
 * open checkouts, so a paid order the server has not fulfilled yet reads
 * like no order at all; that is why the tier is kept when it can be.
 */
export function checkoutSettled(
  me: CipherMe,
  target: CipherTier | undefined,
): boolean {
  const membership = me.membership;
  if (!membership) return false;
  if (target !== undefined) {
    return tierRank(membership.tier) >= tierRank(target);
  }
  return !me.pending;
}

/**
 * What a poll starts from: the tier held (`null` for none), or undefined
 * while the standing has not loaded (as on the way back from checkout)
 */
export function pollBaselineOf(
  me: CipherMe | undefined,
): CipherTier | null | undefined {
  return me ? (me.membership?.tier ?? null) : undefined;
}

/**
 * The membership a finished poll thanks the buyer for: one that is new, or
 * higher than the poll's baseline. A quiet poll that settles only because an
 * open checkout expired (or was paid elsewhere for the same tier) thanks
 * nobody.
 */
export function thankedMembership(
  state: { me?: CipherMe; poll: PollPhase },
  baseline: CipherTier | null | undefined,
): CipherMembership | undefined {
  const membership = state.me?.membership;
  if (state.poll !== "confirmed" || !membership) return undefined;
  if (baseline === undefined || baseline === null) return membership;
  return tierRank(membership.tier) > tierRank(baseline)
    ? membership
    : undefined;
}

/**
 * How a poll shows itself:
 * - `announced`: the page says it is confirming the payment, and says so
 *   again if the poll gives up. Only for a return Stripe sent as paid
 *   (`checkout: "success"`), or when the buyer asks to check again.
 * - `quiet`: a checkout this tab started may still be open (its intent
 *   survived, or a shell window came back), and only its result (a
 *   thank-you) is shown. While this tab's intent for the tier it waits on is
 *   stored, it runs until that tier arrives or it times out: `@me` stops
 *   listing an order once it is paid, before the membership is written, so
 *   "no open checkout" alone does not end it. Without one, it runs only
 *   while the standing shows an open checkout.
 */
export type PollMode = "announced" | "quiet";

/** The poll a page starts as it opens, if any */
export function mountPollMode(
  returned: CheckoutReturn | undefined,
  hasIntent: boolean,
): PollMode | undefined {
  if (returned === "success") return "announced";
  if (returned === "cancel") return undefined;
  return hasIntent ? "quiet" : undefined;
}

/** The note a poll puts on screen, if any; a quiet poll never has one */
export function pollNote(
  state: Pick<StandingState, "poll" | "mode">,
): "confirming" | "notSeen" | undefined {
  if (state.mode !== "announced") return undefined;
  if (state.poll === "polling") return "confirming";
  if (state.poll === "timedOut") return "notSeen";
  return undefined;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * A failure this module detected itself rather than one the API described.
 * The page translates these; API error bodies (`{ type }`) go to `useError`.
 */
export class CipherClientError extends Error {
  kind: "rateLimited" | "badResponse";
  retryAfterMs: number;

  constructor(kind: "rateLimited" | "badResponse", retryAfterMs = 0) {
    super(kind);
    this.name = "CipherClientError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Error for a failed response: a 429 as a rate-limit error carrying its wait,
 * the API's own error body when it has one (so it can be translated),
 * otherwise the HTTP status
 */
export async function responseError(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => undefined)) as
    | { type?: unknown; retry_after?: unknown }
    | undefined;

  if (response.status === 429) {
    const wait =
      typeof body?.retry_after === "number" &&
      Number.isFinite(body.retry_after) &&
      body.retry_after >= 0
        ? body.retry_after
        : RATE_LIMIT_FALLBACK_MS;
    return new CipherClientError(
      "rateLimited",
      Math.min(wait, RATE_LIMIT_MAX_MS),
    );
  }

  return typeof body?.type === "string"
    ? body
    : new Error(`${response.status} ${response.statusText}`.trim());
}

export type CipherApi = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** API base the client already uses, without a trailing slash */
  apiBase: string;
  /** Session and JSON headers, read per request */
  headers: () => Record<string, string>;
};

export async function fetchCipherMe(api: CipherApi): Promise<CipherMe> {
  const response = await api.fetch(`${api.apiBase}/payments/cipher/@me`, {
    headers: api.headers(),
  });
  if (!response.ok) throw await responseError(response);
  return parseCipherMe(await response.json());
}

/** Public counter; sent without the session */
export async function fetchCipherStats(
  api: CipherApi,
): Promise<CipherStats | undefined> {
  const response = await api.fetch(`${api.apiBase}/payments/cipher/stats`);
  if (!response.ok) throw await responseError(response);
  return parseCipherStats(await response.json());
}

/**
 * Start (or, for the tier already in checkout, resume) a checkout and return
 * the page to send the buyer to. The body names a tier only; the server
 * prices it.
 */
export async function postCheckout(
  api: CipherApi,
  tier: CipherTier,
  nativeShell: boolean,
): Promise<string> {
  const response = await api.fetch(`${api.apiBase}/payments/cipher/checkout`, {
    method: "POST",
    headers: api.headers(),
    body: JSON.stringify({ tier, return_to: checkoutReturnTo(nativeShell) }),
  });
  if (!response.ok) throw await responseError(response);

  const body = (await response.json().catch(() => undefined)) as
    | { url?: unknown }
    | undefined;
  const href = checkoutHref(body?.url);
  if (href === undefined) throw new CipherClientError("badResponse");
  return href;
}

// ---------------------------------------------------------------------------
// Standing controller: load, refresh, poll after checkout
// ---------------------------------------------------------------------------

export type PollPhase = "idle" | "polling" | "confirmed" | "timedOut";

export type StandingState = {
  /** Last standing read; kept when a later read fails */
  me?: CipherMe;
  /** Last read's failure, cleared by the next success */
  error?: unknown;
  /** A read is in flight */
  loading: boolean;
  poll: PollPhase;
  /** How the current (or last) poll shows itself */
  mode?: PollMode;
};

export type StandingDeps = {
  fetchMe: () => Promise<CipherMe>;
  onChange: (state: StandingState) => void;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /**
   * The tier of the checkout this tab started, while its intent is still
   * stored and fresh; read again after every poll read (see PollMode)
   */
  intendedTier?: () => CipherTier | undefined;
};

/**
 * Reads the buyer's standing, one request at a time and never faster than
 * {@link MIN_REQUEST_GAP_MS} (or than a 429 asked), and after a checkout
 * polls it every {@link POLL_INTERVAL_MS} until {@link checkoutSettled} or
 * {@link POLL_TIMEOUT_MS}. A read asked for too soon is deferred, and reads
 * asked for while one is waiting or in flight share it: there is one timer
 * and one poll per controller, however often the poll is (re)started.
 *
 * A checkout request goes through {@link checkout}, which pauses every read
 * while it is in flight and for {@link CHECKOUT_PAUSE_MS} after.
 */
export function createCipherStanding(deps: StandingDeps) {
  let state: StandingState = { loading: false, poll: "idle" };

  let timer: unknown;
  let timerDue = 0;
  let hasTimer = false;

  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let notBefore = 0;
  let again = false;
  let disposed = false;

  let target: CipherTier | undefined;
  let deadline = 0;

  let checkoutRunning = false;
  /** A read came due while the checkout ran; it is taken after the pause */
  let readOwed = false;
  let sleepTimer: unknown;
  let wake: (() => void) | undefined;

  function update(patch: Partial<StandingState>) {
    state = { ...state, ...patch };
    deps.onChange(state);
  }

  function cancelTimer() {
    if (!hasTimer) return;
    deps.clearTimer(timer);
    hasTimer = false;
  }

  /** Read after `ms`, unless a read is already due sooner */
  function schedule(ms: number) {
    const wait = Math.max(0, ms);
    const due = deps.now() + wait;
    if (hasTimer && timerDue <= due) return;
    cancelTimer();
    hasTimer = true;
    timerDue = due;
    timer = deps.setTimer(() => {
      hasTimer = false;
      void request();
    }, wait);
  }

  function afterRead(me: CipherMe | undefined) {
    if (state.poll !== "polling") return;
    if (me && checkoutSettled(me, target)) {
      cancelTimer();
      update({ poll: "confirmed" });
      return;
    }
    // A quiet poll waits on a checkout that is still open or, while this
    // tab's intent for its tier is stored, on that tier: a paid order leaves
    // `@me` before its membership shows up
    const intended = target !== undefined && deps.intendedTier?.() === target;
    if (
      me &&
      state.mode === "quiet" &&
      !intended &&
      !livePending(me, deps.now())
    ) {
      cancelTimer();
      update({ poll: "idle" });
      return;
    }
    if (deps.now() >= deadline) {
      cancelTimer();
      update({ poll: "timedOut" });
      return;
    }
    schedule(POLL_INTERVAL_MS);
  }

  async function request(): Promise<void> {
    if (disposed) return;
    if (checkoutRunning) {
      readOwed = true;
      return;
    }
    if (state.loading) {
      again = true;
      return;
    }

    const now = deps.now();
    const wait = Math.max(
      notBefore - now,
      lastRequestAt + MIN_REQUEST_GAP_MS - now,
    );
    if (wait > 0) {
      schedule(wait);
      return;
    }

    cancelTimer();
    lastRequestAt = now;
    update({ loading: true });

    let me: CipherMe | undefined;
    try {
      me = await deps.fetchMe();
    } catch (error) {
      if (disposed) return;
      if (error instanceof CipherClientError && error.kind === "rateLimited") {
        notBefore = deps.now() + error.retryAfterMs;
      }
      update({ loading: false, error });
    }
    if (disposed) return;
    if (me) update({ loading: false, error: undefined, me });

    afterRead(me);

    if (again) {
      again = false;
      // A running poll has its next read scheduled, and that read serves
      // whatever asked meanwhile: a focus and a visibility event arriving
      // together, or a restart, never add a read of their own
      if (state.poll !== "polling") void request();
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      wake = () => {
        wake = undefined;
        resolve();
      };
      sleepTimer = deps.setTimer(() => wake?.(), ms);
    });
  }

  function endCheckout() {
    checkoutRunning = false;
    if (disposed) return;
    notBefore = Math.max(notBefore, deps.now() + CHECKOUT_PAUSE_MS);
    if (readOwed) {
      readOwed = false;
      void request();
    }
  }

  return {
    state: () => state,

    /** Read the standing now, or as soon as the request budget allows */
    refresh() {
      void request();
    },

    /**
     * Poll after a checkout, waiting for `tier` when it is known. Restarting
     * a running poll resets its two minutes and never adds a second one; a
     * quiet restart leaves an announced poll announced.
     */
    startPoll(tier?: CipherTier, mode: PollMode = "announced") {
      if (disposed) return;
      target = tier;
      deadline = deps.now() + POLL_TIMEOUT_MS;
      const keepAnnounced =
        state.poll === "polling" && state.mode === "announced";
      update({ poll: "polling", mode: keepAnnounced ? "announced" : mode });
      void request();
    },

    /**
     * Run a checkout request with the standing paused around it: no read
     * while it is in flight or for {@link CHECKOUT_PAUSE_MS} after, so a poll
     * never competes with the buy. A rate-limited attempt is retried once,
     * after its `retry_after` (when that is at most
     * {@link CHECKOUT_RETRY_MAX_MS}); any other failure, or a second one, is
     * thrown for the page to report.
     */
    async checkout<T>(attempt: () => Promise<T>): Promise<T> {
      if (disposed || checkoutRunning) {
        throw new Error("A checkout request is already running");
      }
      checkoutRunning = true;
      if (hasTimer) {
        cancelTimer();
        readOwed = true;
      }
      try {
        try {
          return await attempt();
        } catch (error) {
          if (
            !(error instanceof CipherClientError) ||
            error.kind !== "rateLimited" ||
            error.retryAfterMs > CHECKOUT_RETRY_MAX_MS
          ) {
            throw error;
          }
          await sleep(error.retryAfterMs);
          if (disposed) throw error;
          return await attempt();
        }
      } finally {
        endCheckout();
      }
    },

    dispose() {
      disposed = true;
      cancelTimer();
      if (wake) {
        deps.clearTimer(sleepTimer);
        wake();
      }
    },
  };
}

export type CipherStanding = ReturnType<typeof createCipherStanding>;

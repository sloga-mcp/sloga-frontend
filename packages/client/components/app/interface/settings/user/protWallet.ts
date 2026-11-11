/**
 * Every decision behind the Prot settings page (`./ProtSettings.tsx`): the
 * wallet the server reports, the sale it advertises, what the page offers,
 * the checkout request, the settings context it is opened with, and the
 * controller that reads the wallet and polls it after a checkout.
 *
 * # Why this is a separate module
 *
 * `ProtSettings.tsx` reaches lingui, `@revolt/ui` and the client, so nothing
 * declared inside it is loadable by `node --test`. This module imports
 * `solid-js` (signals only) and the Cipher helpers it shares, and the page
 * keeps only the composition.
 *
 * The server owns every amount: it prices packs and pay-exact, refuses a
 * checkout over the wallet cap, credits only what the order was stamped
 * with, and computes the 72-hour purchase hold. The figures here are for
 * display, and every gate here only decides what is offered, never what is
 * allowed.
 */
import { createSignal } from "solid-js";

import type {
  ProtEntryKind,
  ProtFeature,
  ProtLedgerView,
  ProtMe,
  ProtPackView,
  ProtPendingView,
  ProtSku,
} from "stoat.js";

import {
  type CipherApi,
  type PollPhase,
  CipherClientError,
  INTENT_TTL_MS,
  MIN_REQUEST_GAP_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  checkoutHref,
  checkoutReturnTo,
  responseError,
} from "./cipherCheckout.ts";

export type {
  ProtEntryKind,
  ProtFeature,
  ProtLedgerView,
  ProtMe,
  ProtPackView,
  ProtPendingView,
} from "stoat.js";

export type ProtSettingsContext = {
  page: "prot";
  checkout?: "success" | "cancel";
};

export type ProtCheckoutChoice = { pack: string } | { exactCents: number };

/** A `ProtBalanceUpdate` event as the client emits it */
export type ProtBalanceUpdate = { balance: number; version: number };

/** Longest pack id the server accepts (`DataProtCheckout.pack`) */
const MAX_PACK_ID = 16;

/** Every ledger kind, in the server's order (`v0::ProtEntryKind`) */
export const PROT_ENTRY_KINDS: readonly ProtEntryKind[] = [
  "Purchase",
  "CipherFounding",
  "CipherUpgrade",
  "Contribution",
  "TierUpgrade",
  "PledgeHold",
  "PledgeCapture",
  "PledgeReturn",
  "PledgeWithdraw",
  "LaunchReturn",
  "Burn",
  "Settlement",
  "WriteOff",
  "Clawback",
  "ClawbackHold",
  "Forfeit",
  "ForfeitHold",
  "ForfeitTank",
  "AdminAdjust",
];

// ---------------------------------------------------------------------------
// Parsing what the server and the client hand us
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isProtEntryKind(value: unknown): value is ProtEntryKind {
  return (
    typeof value === "string" &&
    (PROT_ENTRY_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Read the settings context the page was opened with:
 * `{ page: "prot", checkout?: "success" | "cancel" }`. Anything else in it
 * is ignored.
 */
export function parseProtContext(value: unknown): ProtSettingsContext {
  if (!isRecord(value)) return { page: "prot" };
  const checkout = value.checkout;
  return checkout === "success" || checkout === "cancel"
    ? { page: "prot", checkout }
    : { page: "prot" };
}

/** Everything off: what an absent or unreadable advert means */
function closedFeature(): ProtFeature {
  return {
    enabled: false,
    self_serve_enabled: false,
    sales_open: false,
    cipher_grants_enabled: false,
    packs: [],
    exact_min_cents: 0,
    exact_max_cents: 0,
    wallet_cap: 0,
  };
}

function parsePack(value: unknown): ProtPackView | undefined {
  if (!isRecord(value)) return undefined;
  const { id, cents, prot } = value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_PACK_ID ||
    !isPositiveInteger(cents) ||
    !isPositiveInteger(prot)
  ) {
    return undefined;
  }
  return { id, cents, prot };
}

/**
 * `features.prot` from the root config. Fails closed: a missing or
 * unreadable advert is everything off with no packs; a flag is on only when
 * it is literally `true`; a pack that is not well formed (or repeats an id)
 * is dropped; unreadable pay-exact bounds are 0 (no pay-exact); an
 * unreadable cap is 0 (every purchase reads as over it).
 */
export function parseProtFeature(value: unknown): ProtFeature {
  const feature = closedFeature();
  if (!isRecord(value)) return feature;

  feature.enabled = value.enabled === true;
  feature.self_serve_enabled = value.self_serve_enabled === true;
  feature.sales_open = value.sales_open === true;
  feature.cipher_grants_enabled = value.cipher_grants_enabled === true;

  if (Array.isArray(value.packs)) {
    const seen = new Set<string>();
    for (const raw of value.packs) {
      const pack = parsePack(raw);
      if (!pack || seen.has(pack.id)) continue;
      seen.add(pack.id);
      feature.packs.push(pack);
    }
  }

  const min = value.exact_min_cents;
  const max = value.exact_max_cents;
  if (isPositiveInteger(min) && isPositiveInteger(max) && min <= max) {
    feature.exact_min_cents = min;
    feature.exact_max_cents = max;
  }

  if (isNonNegativeInteger(value.wallet_cap)) {
    feature.wallet_cap = value.wallet_cap;
  }

  return feature;
}

function parseSku(value: unknown): ProtSku | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "ProtPack" &&
    typeof value.pack === "string" &&
    isPositiveInteger(value.prot) &&
    isPositiveInteger(value.cents)
  ) {
    return {
      type: "ProtPack",
      pack: value.pack,
      prot: value.prot,
      cents: value.cents,
    };
  }
  if (value.type === "ProtExact" && isPositiveInteger(value.prot)) {
    return { type: "ProtExact", prot: value.prot };
  }
  return undefined;
}

function parsePending(value: unknown): ProtPendingView | undefined {
  if (!isRecord(value)) return undefined;
  const sku = parseSku(value.sku);
  if (
    typeof value.order_id !== "string" ||
    !sku ||
    typeof value.expires_at !== "number" ||
    !Number.isFinite(value.expires_at)
  ) {
    return undefined;
  }
  return { order_id: value.order_id, sku, expires_at: value.expires_at };
}

function parseEntry(value: unknown): ProtLedgerView | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, amount, created_at, order_id } = value;
  if (
    typeof id !== "string" ||
    !isProtEntryKind(kind) ||
    !Number.isSafeInteger(amount) ||
    typeof created_at !== "number" ||
    !Number.isFinite(created_at)
  ) {
    return undefined;
  }
  const entry: ProtLedgerView = {
    id,
    kind,
    amount: amount as number,
    created_at,
  };
  if (typeof order_id === "string") entry.order_id = order_id;
  return entry;
}

/**
 * The `GET /payments/prot/@me` body. The balance, the held part and the
 * account version are required: a wallet whose balance cannot be read is
 * reported as a bad response, never shown as 0. `held` is at most the
 * balance. A pending order or history row this page cannot read is dropped
 * rather than guessed at.
 */
export function parseProtMe(value: unknown): ProtMe {
  if (!isRecord(value)) throw new CipherClientError("badResponse");
  const { balance, held, version } = value;
  if (
    !isNonNegativeInteger(balance) ||
    !isNonNegativeInteger(held) ||
    !isNonNegativeInteger(version)
  ) {
    throw new CipherClientError("badResponse");
  }

  const me: ProtMe = {
    balance,
    held: Math.min(held, balance),
    version,
    recent: [],
  };

  const pending = parsePending(value.pending_order);
  if (pending) me.pending_order = pending;

  if (Array.isArray(value.recent)) {
    for (const raw of value.recent) {
      const entry = parseEntry(raw);
      if (entry) me.recent.push(entry);
    }
  }

  return me;
}

// ---------------------------------------------------------------------------
// What the page offers
// ---------------------------------------------------------------------------

/**
 * Whether the page offers packs and pay-exact at all: never in a build that
 * may not link out to other payment methods (`allowsDonationLinks()`), and
 * only while the server advertises Prot as enabled with sales open
 */
export function salesOffered(
  feature: ProtFeature,
  donationLinks: boolean,
): boolean {
  return donationLinks && feature.enabled && feature.sales_open;
}

/** Whether the advert carries usable pay-exact bounds */
export function exactAvailable(feature: ProtFeature): boolean {
  return (
    isPositiveInteger(feature.exact_min_cents) &&
    isPositiveInteger(feature.exact_max_cents) &&
    feature.exact_min_cents <= feature.exact_max_cents
  );
}

/**
 * What is wrong with a pay-exact amount, if anything. Both bounds are
 * inclusive (the server's `quote_prot`). Fails closed: with no usable bounds
 * every amount is out of range, and never less than 1 cent.
 */
export function exactCentsProblem(
  cents: number,
  feature: ProtFeature,
): "notInteger" | "belowMin" | "aboveMax" | undefined {
  if (!Number.isSafeInteger(cents)) return "notInteger";
  if (cents < Math.max(feature.exact_min_cents, 1)) return "belowMin";
  if (!(cents <= feature.exact_max_cents)) return "aboveMax";
  return undefined;
}

/**
 * Whether crediting `prot` would take a balance past the wallet cap (D18).
 * Reaching the cap exactly is allowed; anything unreadable counts as over.
 * The server also counts paid orders not credited yet, so it may refuse a
 * purchase this lets through, never the other way round.
 */
export function wouldExceedCap(
  balance: number,
  prot: number,
  cap: number,
): boolean {
  if (
    !Number.isFinite(balance) ||
    !Number.isFinite(prot) ||
    !Number.isFinite(cap)
  ) {
    return true;
  }
  return balance + prot > cap;
}

/** Bonus Prot a pack carries over its price (1 Prot = 1 cent) */
export function packBonus(pack: ProtPackView): number {
  return Math.max(0, pack.prot - pack.cents);
}

/**
 * The user's pay-exact entry as a whole number of Prot (= cents), or NaN
 * when it is not one. Digits only (an optional grouping is not guessed at:
 * "1,234" and "1.234" mean different things in different locales).
 */
export function parseExactInput(text: string): number {
  const trimmed = text.trim();
  return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** A checkout that is still open at `now` */
export function livePendingOrder(
  me: ProtMe | undefined,
  now: number,
): ProtPendingView | undefined {
  const pending = me?.pending_order;
  return pending && pending.expires_at > now ? pending : undefined;
}

/** Prot an open checkout credits once paid */
export function skuProt(sku: ProtSku): number {
  return sku.prot;
}

/** The choice that asks for the same checkout again (the server resumes it) */
export function pendingChoice(pending: ProtPendingView): ProtCheckoutChoice {
  return pending.sku.type === "ProtPack"
    ? { pack: pending.sku.pack }
    : { exactCents: pending.sku.prot };
}

function sameChoice(a: ProtCheckoutChoice, b: ProtCheckoutChoice): boolean {
  if ("pack" in a) return "pack" in b && a.pack === b.pack;
  return "exactCents" in b && a.exactCents === b.exactCents;
}

/**
 * What a buy button does:
 * - `buy`: start a checkout;
 * - `resume`: the open checkout is for this choice, so asking again returns
 *   its page;
 * - `waitForPending`: another choice has an open checkout, which the server
 *   refuses to replace until it expires;
 * - `overCap`: the purchase would take the wallet past its cap.
 */
export type ProtOfferAction = "buy" | "resume" | "waitForPending" | "overCap";

export function protOfferAction(
  choice: ProtCheckoutChoice,
  prot: number,
  me: ProtMe,
  feature: ProtFeature,
  now: number,
): ProtOfferAction {
  const pending = livePendingOrder(me, now);
  if (pending) {
    return sameChoice(pendingChoice(pending), choice)
      ? "resume"
      : "waitForPending";
  }
  if (wouldExceedCap(me.balance, prot, feature.wallet_cap)) return "overCap";
  return "buy";
}

/**
 * The wallet to show: the `/@me` read, with a `ProtBalanceUpdate` balance
 * laid over it only when the event's account version is newer than the
 * read's. A read newer than a late event wins, and so does a read of the
 * same version. The held part never exceeds the balance it is part of.
 */
export function withBalanceUpdate(
  me: ProtMe | undefined,
  update: ProtBalanceUpdate | undefined,
): ProtMe | undefined {
  if (!me || !update) return me;
  if (
    !isNonNegativeInteger(update.balance) ||
    !isNonNegativeInteger(update.version) ||
    update.version <= me.version
  ) {
    return me;
  }
  return {
    ...me,
    balance: update.balance,
    held: Math.min(me.held, update.balance),
    version: update.version,
  };
}

/** Whether the history shows a purchase credited at or after `sinceMs` */
export function purchasedSince(me: ProtMe, sinceMs: number): boolean {
  return me.recent.some(
    (entry) =>
      entry.kind === "Purchase" &&
      entry.amount > 0 &&
      entry.created_at >= sinceMs,
  );
}

/**
 * Rows the server returns in `recent`, newest first (`PROT_RECENT_LIMIT` in
 * the payments engine)
 */
export const PROT_RECENT_ROWS = 20;

/**
 * How far back a checkout return whose stored intent was lost (another tab,
 * no storage) looks for its purchase. An older purchase is never taken for
 * this checkout.
 */
export const PROT_RETURN_WINDOW_MS = 10 * 60_000;

/**
 * Whether `me.recent` reaches back to `sinceMs`, so that a purchase credited
 * since then would be in it: the list is shorter than a full page (it is the
 * whole history), or it holds a row from before `sinceMs`.
 */
export function historyReaches(me: ProtMe, sinceMs: number): boolean {
  return (
    me.recent.length < PROT_RECENT_ROWS ||
    me.recent.some((entry) => entry.created_at < sinceMs)
  );
}

/**
 * Whether a read confirms the checkout a poll waits for.
 *
 * With the checkout's start (`sinceMs`, the stored intent's `at`): a
 * Purchase row created at or after it confirms, so an unrelated credit (a
 * Cipher grant, an admin adjustment) never does, and a debit in the window
 * never hides a real purchase. Only when the history cannot reach back that
 * far does a balance above the baseline stand in. Without a start time, the
 * balance rise alone decides.
 */
export function checkoutConfirmed(
  me: ProtMe | undefined,
  baselineBalance: number,
  sinceMs?: number,
): boolean {
  if (!me) return false;
  if (sinceMs === undefined) return me.balance > baselineBalance;
  if (purchasedSince(me, sinceMs)) return true;
  if (historyReaches(me, sinceMs)) return false;
  return me.balance > baselineBalance;
}

/**
 * What the page does with a `ProtBalanceUpdate` of `version`: `keep` it when
 * it is newer than the newest event kept so far, and `refresh` the wallet
 * (for the history and the held part) when it is kept and no read is held
 * yet or the read held is older.
 */
export function balanceUpdateAction(
  latest: ProtBalanceUpdate | undefined,
  me: ProtMe | undefined,
  version: number,
): { keep: boolean; refresh: boolean } {
  const keep = !latest || version > latest.version;
  return { keep, refresh: keep && (!me || version > me.version) };
}

/** How the history labels a ledger row */
export type ProtEntryGroup =
  | "purchase"
  | "cipher"
  | "clawback"
  | "adjustment"
  | "contribution"
  | "pledge"
  | "returned"
  | "forfeit"
  | "other";

export function ledgerKindGroup(kind: ProtEntryKind): ProtEntryGroup {
  switch (kind) {
    case "Purchase":
      return "purchase";
    case "CipherFounding":
    case "CipherUpgrade":
      return "cipher";
    case "Clawback":
    case "ClawbackHold":
      return "clawback";
    case "AdminAdjust":
      return "adjustment";
    case "Contribution":
      return "contribution";
    case "PledgeHold":
      return "pledge";
    case "PledgeReturn":
    case "PledgeWithdraw":
    case "LaunchReturn":
    case "Settlement":
      return "returned";
    case "Forfeit":
    case "ForfeitHold":
    case "ForfeitTank":
      return "forfeit";
    // Tank and hold sides: never a wallet row today
    case "TierUpgrade":
    case "PledgeCapture":
    case "Burn":
    case "WriteOff":
      return "other";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * The app locale (`i18n.locale`, which may use `_`) as an Intl tag, as
 * `formatCount` reads it
 */
function intlLocale(locale: string | undefined): string {
  return (locale ?? "en").replace(/_/g, "-");
}

function formatNumber(
  amount: number,
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): string {
  try {
    return new Intl.NumberFormat(intlLocale(locale), options).format(amount);
  } catch {
    return new Intl.NumberFormat("en", options).format(amount);
  }
}

/**
 * A Prot amount: grouped digits only, in the app locale (`2,600`,
 * `2.600`). No currency sign: Prot is not money, and the page adds the word
 * "Prot" itself.
 */
export function formatProt(amount: number, locale: string | undefined): string {
  return formatNumber(amount, locale, { maximumFractionDigits: 0 });
}

/** A history amount with its sign (`+2,600`, `-500`, `0`) */
export function formatProtDelta(
  amount: number,
  locale: string | undefined,
): string {
  return formatNumber(amount, locale, {
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  });
}

/** When a history row was written (epoch ms), in the app locale */
export function formatLedgerTime(
  ms: number,
  locale: string | undefined,
): string {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  };
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), options).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en", options).format(ms);
  }
}

// ---------------------------------------------------------------------------
// The checkout this tab started
// ---------------------------------------------------------------------------

/**
 * The balance before a checkout this tab started, and when it started
 * (`at`), kept in session storage across the trip to Stripe so the return
 * knows when the Prot has arrived (a Purchase row at or after `at`).
 * Keyed to the account, and dropped after the Cipher intent's lifetime.
 */
export type ProtCheckoutIntent = { user: string; balance: number; at: number };

export const PROT_INTENT_KEY = "sloga.prot.checkout";

export const PROT_INTENT_TTL_MS = INTENT_TTL_MS;

export function encodeProtIntent(intent: ProtCheckoutIntent): string {
  return JSON.stringify(intent);
}

export function readProtIntent(
  raw: string | null | undefined,
  user: string | undefined,
  now: number,
): ProtCheckoutIntent | undefined {
  if (!raw || !user) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { balance, at } = value;
  if (
    value.user !== user ||
    !isNonNegativeInteger(balance) ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    at > now ||
    now - at > PROT_INTENT_TTL_MS
  ) {
    return undefined;
  }
  return { user, balance, at };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** `GET {apiBase}/payments/prot/@me` */
export async function fetchProtMe(api: CipherApi): Promise<ProtMe> {
  const response = await api.fetch(`${api.apiBase}/payments/prot/@me`, {
    headers: api.headers(),
  });
  if (!response.ok) throw await responseError(response);
  return parseProtMe(await response.json().catch(() => undefined));
}

/**
 * Start (or, for the choice already in checkout, resume) a Prot checkout
 * and return the page to send the buyer to. The body names a pack id or an
 * exact amount (never both) and the return target; the server prices it.
 * Only a {@link checkoutHref}-checked page is returned.
 */
export async function postProtCheckout(
  api: CipherApi,
  choice: ProtCheckoutChoice,
  nativeShell: boolean,
): Promise<string> {
  const return_to = checkoutReturnTo(nativeShell);
  const body =
    "pack" in choice
      ? { pack: choice.pack, return_to }
      : { exact_cents: choice.exactCents, return_to };

  const response = await api.fetch(`${api.apiBase}/payments/prot/checkout`, {
    method: "POST",
    headers: api.headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);

  const answer = (await response.json().catch(() => undefined)) as
    | { url?: unknown }
    | undefined;
  const href = checkoutHref(answer?.url);
  if (href === undefined) throw new CipherClientError("badResponse");
  return href;
}

// ---------------------------------------------------------------------------
// Wallet controller: load, refresh, poll after checkout
// ---------------------------------------------------------------------------

export type ProtStandingDeps = { api: CipherApi; nowMs: () => number };

/**
 * Reads the wallet, one request at a time and never faster than
 * {@link MIN_REQUEST_GAP_MS} (or than a 429 asked): `@me` shares the
 * `payments_me` bucket (10 per 10 s) with the Cipher page. A read asked for
 * too soon is deferred, and reads asked for while one is waiting share it:
 * there is one timer per controller.
 *
 * After a checkout, {@link pollAfterCheckout} reads every
 * {@link POLL_INTERVAL_MS} until a read confirms the purchase
 * ({@link checkoutConfirmed}: `confirmed`) or {@link POLL_TIMEOUT_MS} passes
 * (`timedOut`). Restarting a running poll resets its two minutes and never
 * adds a second one.
 *
 * The accessors are Solid signals. A failed read keeps the last wallet and
 * sets `error()`; the next good read clears it.
 */
export function createProtStanding(deps: ProtStandingDeps): {
  me: () => ProtMe | undefined;
  error: () => unknown;
  phase: () => PollPhase;
  refresh(): Promise<void>;
  pollAfterCheckout(baselineBalance: number, sinceMs?: number): void;
  dispose(): void;
} {
  const [me, setMe] = createSignal<ProtMe | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [phase, setPhase] = createSignal<PollPhase>("idle");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDue = 0;
  let loading = false;
  let disposed = false;

  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let notBefore = 0;

  let baseline = 0;
  let since: number | undefined;
  let deadline = 0;

  /** `refresh()` callers waiting for the next read to start and finish */
  let queued: (() => void)[] = [];

  function cancelTimer() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  /** Read after `ms`, unless a read is already due sooner */
  function schedule(ms: number) {
    const wait = Math.max(0, ms);
    const due = deps.nowMs() + wait;
    if (timer !== undefined && timerDue <= due) return;
    cancelTimer();
    timerDue = due;
    timer = setTimeout(() => {
      timer = undefined;
      request();
    }, wait);
  }

  function request(): void {
    if (disposed || loading) return;
    const now = deps.nowMs();
    const wait = Math.max(
      notBefore - now,
      lastRequestAt + MIN_REQUEST_GAP_MS - now,
    );
    if (wait > 0) {
      schedule(wait);
      return;
    }
    cancelTimer();
    void read(now);
  }

  function afterRead(value: ProtMe | undefined) {
    if (phase() !== "polling") return;
    if (checkoutConfirmed(value, baseline, since)) {
      cancelTimer();
      setPhase("confirmed");
      return;
    }
    if (deps.nowMs() >= deadline) {
      cancelTimer();
      setPhase("timedOut");
      return;
    }
    schedule(POLL_INTERVAL_MS);
  }

  async function read(startedAt: number): Promise<void> {
    loading = true;
    lastRequestAt = startedAt;
    const waiters = queued;
    queued = [];

    let value: ProtMe | undefined;
    let failure: unknown;
    let failed = false;
    try {
      value = await fetchProtMe(deps.api);
    } catch (caught) {
      failed = true;
      failure = caught;
    }
    loading = false;

    if (!disposed) {
      if (failed) {
        if (
          failure instanceof CipherClientError &&
          failure.kind === "rateLimited"
        ) {
          notBefore = deps.nowMs() + failure.retryAfterMs;
        }
        // A function value would be called by the setter
        setError(() => failure);
      } else {
        setMe(value);
        setError(undefined);
      }
      afterRead(value);
    }

    for (const resolve of waiters) resolve();
    if (!disposed && queued.length > 0) request();
  }

  return {
    me,
    error,
    phase,

    /** Read the wallet now, or as soon as the request budget allows */
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        queued.push(resolve);
        request();
      });
    },

    /**
     * Poll until a read confirms the checkout that started at `sinceMs`
     * from `baselineBalance` (see checkoutConfirmed)
     */
    pollAfterCheckout(baselineBalance: number, sinceMs?: number): void {
      if (disposed) return;
      baseline = baselineBalance;
      since = sinceMs;
      deadline = deps.nowMs() + POLL_TIMEOUT_MS;
      setPhase("polling");
      // A read in flight is judged against the new baseline when it lands,
      // and schedules the next one
      request();
    },

    dispose(): void {
      disposed = true;
      cancelTimer();
      const waiters = queued;
      queued = [];
      for (const resolve of waiters) resolve();
    },
  };
}

export type ProtStanding = ReturnType<typeof createProtStanding>;

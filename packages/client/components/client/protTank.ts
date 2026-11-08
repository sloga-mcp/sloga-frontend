/**
 * Every decision behind the Prot fuel tank and goal UI (S5b): reading what
 * the server sends about a tank or a goal, which banner a channel shows,
 * how a contributor is labelled, the prices a goal form previews, whether a
 * pledge can still be withdrawn, and the requests to the `/prot` routes.
 *
 * # Why this is a separate module
 *
 * The modals, the channel banner and the settings page are `.tsx` files that
 * reach lingui, `@revolt/ui` and the client, so nothing declared inside them
 * is loadable by `node --test`. This module imports types only (erased at
 * runtime) and the Cipher request helpers, and the UI keeps only the
 * composition.
 *
 * The server owns every figure: it prices goals and tier changes, checks
 * eligibility, minimums and the purchase hold, and runs the clock. The
 * prices here are previews from the root advert, and every gate here only
 * decides what is offered, never what is allowed. Contribute, pledge and
 * top-up entry points are shown only where `allowsProtSpending()`
 * (`./distribution.ts`) is true; that gate lives with each entry point.
 *
 * Reads are open while Prot is switched off (owner answer 3): nothing here
 * checks `features.prot.enabled` before a read.
 */
import type {
  DataProtContribute,
  DataProtGoalLaunch,
  DataProtLaunchGoal,
  DataProtTier,
  DataProtUpgradeGoal,
  ProtContributionResponse,
  ProtContributorView,
  ProtFeature,
  ProtGoalKind,
  ProtGoalState,
  ProtGoalView,
  ProtPledgeResponse,
  ProtPledgeState,
  ProtPledgeView,
  ProtTankStage,
  ProtTankSummary,
  ProtTankView,
} from "stoat.js";

import {
  type CipherApi,
  CipherClientError,
  responseError,
} from "../app/interface/settings/user/cipherCheckout.ts";

export type {
  DataProtContribute,
  DataProtGoalLaunch,
  DataProtLaunchGoal,
  DataProtTier,
  DataProtUpgradeGoal,
  ProtContributionResponse,
  ProtContributorView,
  ProtGoalKind,
  ProtGoalState,
  ProtGoalView,
  ProtPledgeResponse,
  ProtPledgeState,
  ProtPledgeView,
  ProtTankStage,
  ProtTankSummary,
  ProtTankView,
} from "stoat.js";

/** The tank rules in the root advert (`features.prot.tank`) */
export type ProtTankFeature = NonNullable<ProtFeature["tank"]>;

/** `PUT /prot/servers/<id>/contributor` (hide-name is per server) */
export type DataProtContributorPrefs = { hidden: boolean };

// ---------------------------------------------------------------------------
// Copy pinned to the server
// ---------------------------------------------------------------------------

/**
 * The seat notice, byte for byte the server's `PROT_SEAT_NOTICE`
 * (`v0/prot.rs`; this repo cannot see that file, so the spec pins a copy of
 * the text). It is also the catalog msgid; the UI must render it through
 * lingui, never shortened, hidden or collapsed (contracts 16.3).
 */
export const PROT_SEAT_NOTICE_EN =
  "Contributing supports this server. It does not reserve a seat; the owner chooses members.";

/**
 * The pinned pt-BR msgstr for {@link PROT_SEAT_NOTICE_EN} (contracts 16.4):
 * the text the pt-BR Terms page quotes (`sloga-website`
 * `pt-br/legal/terms.html`; nothing in this repo reads the site, so a site
 * edit is not caught here). `protTank.test.ts` checks that the pt-BR
 * catalog's msgstr for the notice is this text byte for byte.
 */
export const PROT_SEAT_NOTICE_PT_BR =
  "Contribuir ajuda este servidor. Não reserva uma vaga; o dono escolhe os membros.";

// ---------------------------------------------------------------------------
// Constants mirrored from the server
// ---------------------------------------------------------------------------

/** Slot tiers a channel tank can have (`PROT_SLOT_TIERS`) */
export const PROT_SLOT_TIERS: readonly number[] = [10, 25, 50, 100];

/** Largest single contribution or pledge (`PROT_MAX_AMOUNT`) */
export const PROT_MAX_AMOUNT = 1_000_000;

/**
 * Days of Prot left at or below which an Active tank shows the "low" banner.
 * The advert does not carry `warn_days`; this is the largest default warn
 * day (`[7, 3, 1]`), when the first push goes out. The day count the banner
 * shows always comes from the tank ({@link tankDaysLeft}), never from here.
 */
export const PROT_LOW_DAYS = 7;

const DAY_MS = 86_400_000;

/** Every tank stage, in the server's order (`v0::ProtTankStage`) */
export const PROT_TANK_STAGES: readonly ProtTankStage[] = [
  "Launching",
  "Active",
  "Grace",
  "Frozen",
  "Settling",
  "Deleted",
  "Terminated",
];

/** Every goal state, in the server's order (`v0::ProtGoalState`) */
export const PROT_GOAL_STATES: readonly ProtGoalState[] = [
  "Funding",
  "Funded",
  "Launching",
  "Launched",
  "Applied",
  "Expired",
  "Cancelled",
];

/** Every goal kind (`v0::ProtGoalKind`) */
export const PROT_GOAL_KINDS: readonly ProtGoalKind[] = ["Launch", "Upgrade"];

/** Every pledge state (`v0::ProtPledgeState`) */
export const PROT_PLEDGE_STATES: readonly ProtPledgeState[] = [
  "Held",
  "Captured",
  "Returned",
  "Withdrawn",
  "Forfeited",
  "ClawedBack",
];

// ---------------------------------------------------------------------------
// Parsing what the server hands us
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

export function isProtTankStage(value: unknown): value is ProtTankStage {
  return oneOf(PROT_TANK_STAGES, value);
}

export function isProtGoalState(value: unknown): value is ProtGoalState {
  return oneOf(PROT_GOAL_STATES, value);
}

export function isProtGoalKind(value: unknown): value is ProtGoalKind {
  return oneOf(PROT_GOAL_KINDS, value);
}

export function isProtPledgeState(value: unknown): value is ProtPledgeState {
  return oneOf(PROT_PLEDGE_STATES, value);
}

/** The server's notice when it sent one, else the pinned English text */
function noticeOf(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? value
    : PROT_SEAT_NOTICE_EN;
}

/**
 * A `ProtTankSummary` (a REST read or a write response), or `null` when it
 * is not one. Fails closed: an unknown stage, a missing id or an unreadable
 * balance, cost, tier or version is `null`, never a guess. An optional date
 * or pending tier that cannot be read is left out (no date is promised).
 */
export function parseProtTankSummary(value: unknown): ProtTankSummary | null {
  if (!isRecord(value)) return null;
  const {
    tank_id,
    channel_id,
    stage,
    slot_tier,
    daily_cost,
    balance,
    version,
    balance_version,
  } = value;
  if (
    !isId(tank_id) ||
    !isId(channel_id) ||
    !isProtTankStage(stage) ||
    !isPositiveInteger(slot_tier) ||
    !isNonNegativeInteger(daily_cost) ||
    !isInteger(balance) ||
    !isNonNegativeInteger(version) ||
    !isNonNegativeInteger(balance_version)
  ) {
    return null;
  }

  const summary: ProtTankSummary = {
    tank_id,
    channel_id,
    stage,
    slot_tier,
    daily_cost,
    balance,
    version,
    balance_version,
  };
  if (isPositiveInteger(value.pending_slot_tier)) {
    summary.pending_slot_tier = value.pending_slot_tier;
  }
  if (isTime(value.protected_until)) {
    summary.protected_until = value.protected_until;
  }
  if (isTime(value.grace_ends_at)) summary.grace_ends_at = value.grace_ends_at;
  if (isTime(value.deletes_at)) summary.deletes_at = value.deletes_at;
  if (isTime(value.launched_at)) summary.launched_at = value.launched_at;
  return summary;
}

/**
 * One contributor line, or `null` when it is not one. A user id is kept only
 * for a line that is neither hidden nor deleted: whatever the server sent, a
 * hidden contributor's or a deleted user's id never reaches the UI.
 */
export function parseProtContributorView(
  value: unknown,
): ProtContributorView | null {
  if (!isRecord(value) || !isPositiveInteger(value.amount)) return null;
  const hidden = value.hidden === true;
  const deleted = value.deleted === true;
  const view: ProtContributorView = {
    amount: value.amount,
    hidden,
    deleted,
    you: value.you === true,
  };
  if (!hidden && !deleted && isId(value.user_id)) {
    view.user_id = value.user_id;
  }
  return view;
}

/** One of the caller's pledges, or `null` (an unknown state included) */
export function parseProtPledgeView(value: unknown): ProtPledgeView | null {
  if (!isRecord(value)) return null;
  const { id, goal_id, amount, remaining, state, created_at } = value;
  if (
    !isId(id) ||
    !isId(goal_id) ||
    !isNonNegativeInteger(amount) ||
    !isNonNegativeInteger(remaining) ||
    !isProtPledgeState(state) ||
    !isTime(created_at)
  ) {
    return null;
  }
  return { id, goal_id, amount, remaining, state, created_at };
}

function parseList<T>(value: unknown, parse: (raw: unknown) => T | null): T[] {
  const list: T[] = [];
  if (!Array.isArray(value)) return list;
  for (const raw of value) {
    const item = parse(raw);
    if (item !== null) list.push(item);
  }
  return list;
}

/**
 * A `ProtGoalView`, or `null` when it is not one. Fails closed: an unknown
 * kind or state, a missing id, or unreadable amounts, deadline or withdraw
 * cutoff is `null`. A contributor line or pledge that cannot be read is
 * dropped rather than guessed at.
 */
export function parseProtGoalView(value: unknown): ProtGoalView | null {
  if (!isRecord(value)) return null;
  const {
    id,
    kind,
    server_id,
    slots,
    daily_cost,
    target_prot,
    pledged_total,
    state,
    deadline_at,
    withdraw_until,
  } = value;
  if (
    !isId(id) ||
    !isProtGoalKind(kind) ||
    !isId(server_id) ||
    !isPositiveInteger(slots) ||
    !isNonNegativeInteger(daily_cost) ||
    !isNonNegativeInteger(target_prot) ||
    !isNonNegativeInteger(pledged_total) ||
    !isProtGoalState(state) ||
    !isTime(deadline_at) ||
    !isTime(withdraw_until)
  ) {
    return null;
  }

  const goal: ProtGoalView = {
    id,
    kind,
    server_id,
    slots,
    daily_cost,
    target_prot,
    pledged_total,
    state,
    deadline_at,
    withdraw_until,
    contributors: parseList(value.contributors, parseProtContributorView),
    your_pledges: parseList(value.your_pledges, parseProtPledgeView),
    notice: noticeOf(value.notice),
  };
  if (isId(value.channel_id)) goal.channel_id = value.channel_id;
  if (isId(value.tank_id)) goal.tank_id = value.tank_id;
  if (isPositiveInteger(value.days)) goal.days = value.days;
  if (isTime(value.funded_at)) goal.funded_at = value.funded_at;
  if (isTime(value.launch_deadline_at)) {
    goal.launch_deadline_at = value.launch_deadline_at;
  }
  if (isTime(value.launched_at)) goal.launched_at = value.launched_at;
  return goal;
}

/**
 * The `GET /prot/channels/<id>/tank` body, or `null` when its tank summary
 * cannot be read (see {@link parseProtTankSummary}). A goal or contributor
 * line that cannot be read is dropped. The caller's own figures and flags
 * fail closed: unreadable is 0 or false (no contribute offered).
 */
export function parseProtTankView(value: unknown): ProtTankView | null {
  if (!isRecord(value)) return null;
  const tank = parseProtTankSummary(value.tank);
  if (!tank) return null;
  return {
    tank,
    contributors: parseList(value.contributors, parseProtContributorView),
    goals: parseList(value.goals, parseProtGoalView),
    you_contributed: isNonNegativeInteger(value.you_contributed)
      ? value.you_contributed
      : 0,
    can_contribute: value.can_contribute === true,
    is_owner: value.is_owner === true,
    seats_used: isNonNegativeInteger(value.seats_used) ? value.seats_used : 0,
    notice: noticeOf(value.notice),
  };
}

/** A contribution's response, or `null` when it is not one */
export function parseProtContributionResponse(
  value: unknown,
): ProtContributionResponse | null {
  if (!isRecord(value)) return null;
  const tank = parseProtTankSummary(value.tank);
  if (!tank || !isId(value.entry_id) || !isNonNegativeInteger(value.balance)) {
    return null;
  }
  return {
    entry_id: value.entry_id,
    tank,
    balance: value.balance,
    already_applied: value.already_applied === true,
    notice: noticeOf(value.notice),
  };
}

/** A pledge's response, or `null` when it is not one */
export function parseProtPledgeResponse(
  value: unknown,
): ProtPledgeResponse | null {
  if (!isRecord(value)) return null;
  const pledge = parseProtPledgeView(value.pledge);
  const goal = parseProtGoalView(value.goal);
  if (!pledge || !goal || !isNonNegativeInteger(value.balance)) return null;
  return {
    pledge,
    goal,
    balance: value.balance,
    already_applied: value.already_applied === true,
    notice: noticeOf(value.notice),
  };
}

/** Everything off: what an absent or unreadable tank advert means */
function closedTankFeature(): ProtTankFeature {
  return {
    channel_daily_cost: {},
    min_contribution: 0,
    min_launch_goal_days: 0,
    max_launch_goal_days: 0,
    launch_goal_deadline_days: 0,
    withdraw_cutoff_hours: 0,
    contribute_hold_hours: 0,
    grace_days: 0,
    freeze_days: 0,
    deletion_enabled: false,
  };
}

/** Advert counts read as whole numbers, 0 when unreadable */
const TANK_FEATURE_COUNTS = [
  "launch_goal_deadline_days",
  "withdraw_cutoff_hours",
  "contribute_hold_hours",
  "grace_days",
  "freeze_days",
] as const;

/**
 * `features.prot.tank` from the root config (the S5a `parseProtFeature`
 * keeps only the wallet keys). Fails closed, like the server's advert of an
 * invalid config: no tier costs, zeros and `deletion_enabled: false`.
 * `min_contribution: 0` means contribute is not offered. Only the four slot
 * tiers with a positive whole cost are kept. Deletion copy is shown only
 * while `deletion_enabled` is literally `true`.
 */
export function parseProtTankFeature(value: unknown): ProtTankFeature {
  const feature = closedTankFeature();
  if (!isRecord(value)) return feature;

  const costs = value.channel_daily_cost;
  if (isRecord(costs)) {
    for (const slots of PROT_SLOT_TIERS) {
      const cost = costs[String(slots)];
      if (isPositiveInteger(cost)) {
        feature.channel_daily_cost[String(slots)] = cost;
      }
    }
  }

  if (isPositiveInteger(value.min_contribution)) {
    feature.min_contribution = value.min_contribution;
  }
  const min = value.min_launch_goal_days;
  const max = value.max_launch_goal_days;
  if (isPositiveInteger(min) && isPositiveInteger(max) && min <= max) {
    feature.min_launch_goal_days = min;
    feature.max_launch_goal_days = max;
  }
  for (const key of TANK_FEATURE_COUNTS) {
    const raw = value[key];
    if (isNonNegativeInteger(raw)) feature[key] = raw;
  }
  feature.deletion_enabled = value.deletion_enabled === true;
  return feature;
}

/** The tank advert of a whole `features.prot`, or a tank advert as is */
function tankFeatureOf(
  feature: ProtTankFeature | ProtFeature | null | undefined,
): ProtTankFeature {
  if (isRecord(feature) && "tank" in feature) {
    return parseProtTankFeature((feature as ProtFeature).tank);
  }
  return parseProtTankFeature(feature);
}

// ---------------------------------------------------------------------------
// What the UI shows
// ---------------------------------------------------------------------------

/**
 * Whole days of Prot an Active tank has left at `nowMs` (the `{days}` of the
 * low banner), or `null` for any other stage or when it cannot be told.
 * Counted from `protected_until` (next UTC midnight plus whole funded days),
 * so a summary read earlier still counts down; never below 0.
 */
export function tankDaysLeft(
  summary: ProtTankSummary | null | undefined,
  nowMs: number,
): number | null {
  if (!summary || summary.stage !== "Active" || !isTime(nowMs)) return null;
  if (isTime(summary.protected_until)) {
    return Math.max(0, Math.floor((summary.protected_until - nowMs) / DAY_MS));
  }
  if (isPositiveInteger(summary.daily_cost) && summary.balance >= 0) {
    return Math.floor(summary.balance / summary.daily_cost);
  }
  return null;
}

export type ProtTankBannerKind = "grace" | "frozen" | "deleted" | "low";

/**
 * Which banner a channel with this tank shows at `nowMs`, if any:
 * - `grace`: the tank ran out and is in its grace period;
 * - `frozen`: Frozen, or Settling (a deletion in progress), the same stages
 *   the shield treats as frozen;
 * - `deleted`: Deleted or Terminated, the stages the shield treats as
 *   deleted;
 * - `low`: Active with at most {@link PROT_LOW_DAYS} whole days left;
 * - `null`: no tank, a Launching tank, an Active tank with more left, or a
 *   summary this client cannot read.
 */
export function tankBannerKind(
  summary: ProtTankSummary | null | undefined,
  nowMs: number,
): ProtTankBannerKind | null {
  if (!summary) return null;
  switch (summary.stage) {
    case "Grace":
      return "grace";
    case "Frozen":
    case "Settling":
      return "frozen";
    case "Deleted":
    case "Terminated":
      return "deleted";
    case "Active": {
      const days = tankDaysLeft(summary, nowMs);
      return days !== null && days <= PROT_LOW_DAYS ? "low" : null;
    }
    case "Launching":
      return null;
    default: {
      const exhaustive: never = summary.stage;
      void exhaustive;
      return null;
    }
  }
}

export type ProtContributorLabel =
  | { kind: "user"; userId: string }
  | { kind: "anonymous" }
  | { kind: "deleted" };

/**
 * How a contributor line is labelled: a deleted user is "Deleted user", a
 * hidden contributor (or a line without an id) is "Anonymous", and only a
 * visible line with an id names its user. Deleted wins over hidden, and no
 * id is ever shown for either.
 */
export function contributorLabel(
  view: ProtContributorView,
): ProtContributorLabel {
  if (view.deleted) return { kind: "deleted" };
  if (view.hidden || !isId(view.user_id)) return { kind: "anonymous" };
  return { kind: "user", userId: view.user_id };
}

/** Daily cost of a slot tier in the advert, or `null` when it has none */
export function tierDailyCost(
  feature: ProtTankFeature | ProtFeature | null | undefined,
  slots: number,
): number | null {
  if (!PROT_SLOT_TIERS.includes(slots)) return null;
  const cost = tankFeatureOf(feature).channel_daily_cost[String(slots)];
  return isPositiveInteger(cost) ? cost : null;
}

/**
 * The target a launch goal for `slots` and `days` would get (8.2:
 * `days * daily_cost`), or `null` when the server would refuse it: a tier
 * without a cost, or days outside the advertised range. 10 slots at 40 a
 * day for 30 days is 1,200. A preview: the server prices the goal.
 */
export function launchGoalPrice(
  feature: ProtTankFeature | ProtFeature | null | undefined,
  slots: number,
  days: number,
): number | null {
  const tank = tankFeatureOf(feature);
  const cost = tierDailyCost(tank, slots);
  if (
    cost === null ||
    !isPositiveInteger(days) ||
    tank.min_launch_goal_days < 1 ||
    days < tank.min_launch_goal_days ||
    days > tank.max_launch_goal_days
  ) {
    return null;
  }
  const price = days * cost;
  return Number.isSafeInteger(price) ? price : null;
}

/**
 * The target an upgrade goal gets, as the server's `prot_upgrade_goal_price`
 * (4.4, D13): `(new_cost - old_cost) * floor(balance / old_cost)`, and 0
 * when there is nothing to price (no old cost, no rise, no balance). 10 to
 * 25 slots (40 to 90 a day) with 1,200 left is 1,500.
 */
export function upgradeGoalPrice(
  oldCost: number,
  newCost: number,
  balance: number,
): number {
  if (
    !isInteger(oldCost) ||
    !isInteger(newCost) ||
    !isInteger(balance) ||
    oldCost <= 0 ||
    newCost <= oldCost ||
    balance <= 0
  ) {
    return 0;
  }
  const price = (newCost - oldCost) * Math.floor(balance / oldCost);
  return Number.isSafeInteger(price) ? price : 0;
}

/**
 * Whether the caller could still withdraw a pledge from `goal` at `nowMs`
 * (8.4): the goal is still Funding and the withdraw cutoff has not passed
 * (`withdraw_until` itself is allowed, as on the server). The pledge must
 * also be the caller's, Held and with something left; the server decides.
 */
export function withdrawOpen(goal: ProtGoalView, nowMs: number): boolean {
  return (
    goal.state === "Funding" &&
    isTime(nowMs) &&
    isTime(goal.withdraw_until) &&
    nowMs <= goal.withdraw_until
  );
}

/**
 * What is wrong with a contribution or pledge amount, if anything (8.1,
 * 8.3): a whole number from the advert's minimum to {@link PROT_MAX_AMOUNT}.
 * For a pledge pass the goal's `open` (target minus pledged): the server
 * caps a pledge at it, and a pledge that completes the goal may be below the
 * minimum. Fails closed: with no usable minimum (the advert is off or
 * unreadable) every amount is refused.
 */
export function contributionAmountProblem(
  amount: number,
  minContribution: number,
  open?: number,
): "notInteger" | "belowMin" | "aboveMax" | "noMinimum" | undefined {
  if (!isPositiveInteger(minContribution)) return "noMinimum";
  if (!Number.isSafeInteger(amount) || amount < 1) return "notInteger";
  if (amount > PROT_MAX_AMOUNT) return "aboveMax";
  if (open !== undefined && isPositiveInteger(open)) {
    const capped = Math.min(amount, open);
    return capped < minContribution && capped !== open ? "belowMin" : undefined;
  }
  return amount < minContribution ? "belowMin" : undefined;
}

// ---------------------------------------------------------------------------
// Requests (all through the S5a `CipherApi`; the server decides everything)
// ---------------------------------------------------------------------------

/**
 * Route segments, each escaped. An empty, `.` or `..` id is refused before
 * any request: URL parsing would drop it or walk the path up to another
 * route (`%2E%2E` counts as `..` too, so escaping cannot help).
 */
function path(...parts: string[]): string {
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new Error("Not a Prot route id");
    }
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

async function send(
  api: CipherApi,
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method, headers: api.headers() };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await api.fetch(`${api.apiBase}/prot/${route}`, init);
  if (!response.ok) throw await responseError(response);
  return response;
}

async function readAs<T>(
  response: Response,
  parse: (value: unknown) => T | null,
): Promise<T> {
  const parsed = parse(await response.json().catch(() => undefined));
  if (parsed === null) throw new CipherClientError("badResponse");
  return parsed;
}

/**
 * `GET /prot/channels/<id>/tank`. `null` means the channel has no tank (the
 * server's `NotFound`, which a non-viewer gets too). A body that cannot be
 * read is a bad response, never "no tank": the caller keeps what it had.
 */
export async function fetchProtTank(
  api: CipherApi,
  channelId: string,
): Promise<ProtTankView | null> {
  let response: Response;
  try {
    response = await send(api, "GET", path("channels", channelId, "tank"));
  } catch (error) {
    if (isRecord(error) && error.type === "NotFound") return null;
    throw error;
  }
  return readAs(response, parseProtTankView);
}

/**
 * `POST /prot/channels/<id>/contribute`. Keep the same `nonce` when retrying
 * the same top-up: the server applies it once and answers the replay with
 * `already_applied`.
 */
export async function postContribute(
  api: CipherApi,
  channelId: string,
  data: DataProtContribute,
): Promise<ProtContributionResponse> {
  const response = await send(
    api,
    "POST",
    path("channels", channelId, "contribute"),
    { amount: data.amount, nonce: data.nonce },
  );
  return readAs(response, parseProtContributionResponse);
}

/** `POST /prot/goals/<id>/pledges` (nonce: as {@link postContribute}) */
export async function postPledge(
  api: CipherApi,
  goalId: string,
  data: DataProtContribute,
): Promise<ProtPledgeResponse> {
  const response = await send(api, "POST", path("goals", goalId, "pledges"), {
    amount: data.amount,
    nonce: data.nonce,
  });
  return readAs(response, parseProtPledgeResponse);
}

/** `DELETE /prot/goals/<id>/pledges/<pledge_id>`: withdraw a pledge */
export async function deletePledge(
  api: CipherApi,
  goalId: string,
  pledgeId: string,
): Promise<ProtPledgeView> {
  const response = await send(
    api,
    "DELETE",
    path("goals", goalId, "pledges", pledgeId),
  );
  return readAs(response, parseProtPledgeView);
}

/** `POST /prot/servers/<id>/goals`: the owner opens a launch goal */
export async function postLaunchGoal(
  api: CipherApi,
  serverId: string,
  data: DataProtLaunchGoal,
): Promise<ProtGoalView> {
  const response = await send(api, "POST", path("servers", serverId, "goals"), {
    slots: data.slots,
    days: data.days,
    nonce: data.nonce,
  });
  return readAs(response, parseProtGoalView);
}

/** `POST /prot/channels/<id>/goals`: the owner opens an upgrade goal */
export async function postUpgradeGoal(
  api: CipherApi,
  channelId: string,
  data: DataProtUpgradeGoal,
): Promise<ProtGoalView> {
  const response = await send(
    api,
    "POST",
    path("channels", channelId, "goals"),
    { slots: data.slots, nonce: data.nonce },
  );
  return readAs(response, parseProtGoalView);
}

/** `POST /prot/goals/<id>/launch`: launch a funded goal on an empty channel */
export async function postGoalLaunch(
  api: CipherApi,
  goalId: string,
  data: DataProtGoalLaunch,
): Promise<ProtGoalView> {
  const response = await send(api, "POST", path("goals", goalId, "launch"), {
    channel_id: data.channel_id,
  });
  return readAs(response, parseProtGoalView);
}

/** `POST /prot/goals/<id>/cancel`: the owner cancels (pledges go back) */
export async function postGoalCancel(
  api: CipherApi,
  goalId: string,
): Promise<ProtGoalView> {
  const response = await send(api, "POST", path("goals", goalId, "cancel"));
  return readAs(response, parseProtGoalView);
}

/** `PUT /prot/channels/<id>/tier`: the owner changes the slot tier */
export async function putTier(
  api: CipherApi,
  channelId: string,
  data: DataProtTier,
): Promise<ProtTankSummary> {
  const response = await send(api, "PUT", path("channels", channelId, "tier"), {
    slots: data.slots,
    nonce: data.nonce,
  });
  return readAs(response, parseProtTankSummary);
}

/**
 * `PUT /prot/servers/<id>/contributor`: hide (or show) the caller's name on
 * every tank and goal of the server (hide-name is per server)
 */
export async function putContributorPrefs(
  api: CipherApi,
  serverId: string,
  data: DataProtContributorPrefs,
): Promise<void> {
  await send(api, "PUT", path("servers", serverId, "contributor"), {
    hidden: data.hidden === true,
  });
}

/**
 * `GET /prot/servers/<id>/goals`: the server's open launch goals. A goal
 * that cannot be read is dropped; a body that is not a list is a bad
 * response.
 */
export async function fetchServerGoals(
  api: CipherApi,
  serverId: string,
): Promise<ProtGoalView[]> {
  const response = await send(api, "GET", path("servers", serverId, "goals"));
  return readAs(response, (value) =>
    Array.isArray(value) ? parseList(value, parseProtGoalView) : null,
  );
}

/** `GET /prot/goals/<id>` */
export async function fetchGoal(
  api: CipherApi,
  goalId: string,
): Promise<ProtGoalView> {
  const response = await send(api, "GET", path("goals", goalId));
  return readAs(response, parseProtGoalView);
}

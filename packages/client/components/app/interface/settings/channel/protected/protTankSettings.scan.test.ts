// Spec for the owner's Prot tank settings page and the server launch goals
// dialog (S5b W6 lane L6e; contracts 8.0, 8.2-8.9, 16.3, 17, 22.1), run with
// Node's built-in runner from packages/client:
//   node --conditions=browser --test components/app/interface/settings/channel/protected/protTankSettings.scan.test.ts
//
// Both files import Solid, lingui and the UI kit, so Node cannot load them.
// Their rules sit in marked regions (`// prot-pure:begin` ..
// `// prot-pure:end`) with no imports; this spec cuts them out, strips the
// types with Node's own stripper and runs the real source. The wiring is
// checked by scanning the files.
//
//  T1  store builds (D5, S6 pin): every spend or goal-create site (open a
//      launch goal, open an upgrade goal, launch a goal, move to more seats,
//      open `prot_contribute`) re-checks `allowsProtSpending()` in its own
//      function, and the render gates are fed `allowsProtSpending()`;
//  T2  owner answer 1 (8.0): the owner's tier and goal controls need Prot
//      AND self-serve on; with either off nothing is offered;
//  T3  the tier rules (8.9): more seats only from Active and only with
//      spend; fewer seats from Active / Grace / Frozen; locked while an
//      upgrade goal is open;
//  T4  the upgrade goal rules (8.7) and the 1,500 price vector;
//  T5  one open launch goal per server (owner answer 5); pledge, cancel
//      and launch per goal state and deadline;
//  T6  withdraw returns Prot: never spend-gated, only Held pledges with
//      something left while the window is open;
//  T7  the launch picker offers only empty text channels of the server;
//  T8  nonces are kept per intent;
//  T9  copy and traps: the seat notice is byte for byte protTank's, next to
//      Pledge; Anonymous / Deleted user carry the "Prot contributor"
//      context; no price or payment-link text; no styled(Component); the
//      pinned component names and the pinned `prot_contribute` goal target.
//
// Point `PROT_TANK_SETTINGS_FILE` or `PROT_SERVER_GOALS_FILE` at another copy
// (a known-bad control) to check that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (env: string, fallback: string) =>
  readFileSync(process.env[env] || join(here, fallback), "utf8");

const settingsSource = read("PROT_TANK_SETTINGS_FILE", "ProtTankSettings.tsx");
const goalsSource = read(
  "PROT_SERVER_GOALS_FILE",
  "../../../../../modal/modals/ProtServerGoals.tsx",
);
const protTankSource = readFileSync(
  join(here, "../../../../../client/protTank.ts"),
  "utf8",
);

const BEGIN = "// prot-pure:begin";
const END = "// prot-pure:end";

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SETTINGS = code(settingsSource);
const GOALS = code(goalsSource);

async function loadRegion<T>(src: string, tag: string): Promise<T> {
  const from = src.indexOf(BEGIN);
  const to = src.indexOf(END);
  assert.ok(from !== -1 && to > from, `${tag}: prot-pure region missing`);
  const region = src.slice(from, to);
  assert.ok(
    !/^\s*import\s/m.test(region),
    `${tag}: the region must not import`,
  );
  const js = stripTypeScriptTypes(region, { mode: "strip" });
  const dir = mkdtempSync(join(tmpdir(), "s5bw6-l6e-"));
  const out = join(dir, `${tag}.mjs`);
  writeFileSync(out, js);
  return (await import(pathToFileURL(out).href)) as T;
}

type Gate = {
  isOwner: boolean;
  enabled: boolean;
  selfServe: boolean;
  spending: boolean;
};
type Writes = { manage: boolean; spend: boolean };
type TierTank = {
  slotTier: number;
  pendingSlotTier?: number;
  stage: string;
  dailyCost: number;
  balance: number;
};
type TierChoice = { slots: number; cost: number; direction: "up" | "down" };
type UpgradeOffer =
  | { kind: "none" }
  | { kind: "needsDay" }
  | { kind: "offer"; choices: { slots: number; target: number }[] };
type NonceKeeper = { nonceFor(key: string): string; clear(): void };

interface SettingsRules {
  ownerTankWrites(gate: Gate): Writes;
  openUpgradeGoal<G extends { kind: string; state: string }>(
    goals: readonly G[],
  ): G | undefined;
  goalCancelOffered(goal: { state: string }, writes: Writes): boolean;
  tierChoices(
    tank: TierTank,
    costs: Record<string, number>,
    tiers: readonly number[],
    writes: Writes,
    upgradeGoalOpen: boolean,
  ): { choices: TierChoice[]; locked: boolean };
  upgradeGoalChoices(
    tank: TierTank,
    costs: Record<string, number>,
    tiers: readonly number[],
    writes: { spend: boolean },
    upgradeGoalOpen: boolean,
    price: (oldCost: number, newCost: number, balance: number) => number,
  ): UpgradeOffer;
  createNonceKeeper(make: () => string): NonceKeeper;
}

type LaunchChannel = {
  id: string;
  type: string;
  serverId: string | undefined;
  voice: boolean;
  announcement: boolean;
  protected: boolean;
  lastMessageId: string | undefined | null;
};

interface GoalsRules {
  OPEN_GOAL_STATES: readonly string[];
  isOpenGoal(goal: { state: string }): boolean;
  ownerGoalWrites(gate: Gate): Writes;
  createLaunchGoalOffered(
    gate: Gate,
    goals: readonly { state: string }[],
  ): boolean;
  launchGoalActions(
    goal: { state: string; deadline_at: number; launch_deadline_at?: number },
    nowMs: number,
    gate: Gate,
    minContribution: number,
  ): { pledge: boolean; cancel: boolean; launch: boolean };
  withdrawablePledges<P extends { state: string; remaining: number }>(
    pledges: readonly P[],
    enabled: boolean,
    windowOpen: boolean,
  ): P[];
  heldPledgeTotal(
    pledges: readonly { state: string; remaining: number }[],
  ): number;
  launchableChannels<C extends LaunchChannel>(
    channels: readonly C[],
    serverId: string,
  ): C[];
  parseWholeNumber(text: string): number | null;
  createNonceKeeper(make: () => string): NonceKeeper;
}

const S = await loadRegion<SettingsRules>(settingsSource, "ProtTankSettings");
const G = await loadRegion<GoalsRules>(goalsSource, "ProtServerGoals");

/** Every gate combination */
function* gates(): Generator<Gate> {
  for (const isOwner of [false, true])
    for (const enabled of [false, true])
      for (const selfServe of [false, true])
        for (const spending of [false, true])
          yield { isOwner, enabled, selfServe, spending };
}

const OPEN: Gate = {
  isOwner: true,
  enabled: true,
  selfServe: true,
  spending: true,
};
const COSTS = { "10": 40, "25": 90, "50": 160, "100": 300 };
const TIERS = [10, 25, 50, 100];

/** The server's `prot_upgrade_goal_price` (4.4), as protTank mirrors it */
const price = (oldCost: number, newCost: number, balance: number) =>
  newCost <= oldCost || balance <= 0
    ? 0
    : (newCost - oldCost) * Math.floor(balance / oldCost);

/** All indexes of `needle` in `src` */
function sites(src: string, needle: string): number[] {
  const out: number[] = [];
  for (
    let at = src.indexOf(needle);
    at !== -1;
    at = src.indexOf(needle, at + 1)
  ) {
    out.push(at);
  }
  return out;
}

/** The source from the nearest `function ` before `index` up to it */
function enclosingFunction(src: string, index: number): string {
  const start = src.lastIndexOf("function ", index);
  assert.ok(start !== -1, "a call site outside any function");
  return src.slice(start, index);
}

/** Every `needle` site re-checks `guard` earlier in its own function */
function assertGuarded(
  src: string,
  file: string,
  needle: string,
  guard: string,
) {
  const found = sites(src, needle);
  assert.ok(found.length > 0, `${file}: no ${needle} site (renamed?)`);
  for (const at of found) {
    const body = enclosingFunction(src, at);
    assert.ok(
      body.includes(guard),
      `${file}: ${needle} is reached without \`${guard}\` in its function:\n${body.slice(0, 160)}`,
    );
  }
}

describe("T1 store builds: spend and goal-create sites (D5)", () => {
  it("both files take the gate from the S5a distribution module", () => {
    for (const [file, src] of [
      ["ProtTankSettings", SETTINGS],
      ["ProtServerGoals", GOALS],
    ] as const) {
      assert.match(
        src,
        /import \{ allowsProtSpending \} from "@revolt\/client\/distribution";/,
        `${file}: allowsProtSpending import`,
      );
    }
  });

  it("every launch-goal create, launch and pledge site re-checks", () => {
    const guard = "if (!allowsProtSpending()) return;";
    assertGuarded(GOALS, "ProtServerGoals", "postLaunchGoal(", guard);
    assertGuarded(GOALS, "ProtServerGoals", "postGoalLaunch(", guard);
    assertGuarded(GOALS, "ProtServerGoals", 'type: "prot_contribute"', guard);
  });

  it("every upgrade-goal create and seat-increase site re-checks", () => {
    assertGuarded(
      SETTINGS,
      "ProtTankSettings",
      "postUpgradeGoal(",
      "if (!allowsProtSpending()) return;",
    );
    assertGuarded(
      SETTINGS,
      "ProtTankSettings",
      "putTier(",
      'if (choice.direction === "up" && !allowsProtSpending()) return;',
    );
  });

  it("the render gates are fed allowsProtSpending(), Prot and self-serve", () => {
    assert.match(
      GOALS,
      /const gate = \(\): GoalWriteGate => \(\{\s*isOwner: isOwner\(\),\s*enabled: feature\(\)\.enabled,\s*selfServe: feature\(\)\.self_serve_enabled,\s*spending: allowsProtSpending\(\),\s*\}\);/,
      "ProtServerGoals: the write gate",
    );
    assert.match(
      SETTINGS,
      /ownerTankWrites\(\{\s*isOwner: isOwner\(\),\s*enabled: feature\(\)\.enabled,\s*selfServe: feature\(\)\.self_serve_enabled,\s*spending: allowsProtSpending\(\),\s*\}\)/,
      "ProtTankSettings: the write gate",
    );
  });

  it("the create form renders only behind createOffered()", () => {
    assert.match(
      GOALS,
      /const createOffered = \(\) => createLaunchGoalOffered\(gate\(\), list\(\)\);/,
    );
    const form = GOALS.indexOf("<Trans>Open a launch goal</Trans>");
    assert.ok(form !== -1, "create form title");
    const opener = GOALS.lastIndexOf("<Show when={createOffered()", form);
    assert.ok(opener !== -1, "the form is inside <Show when={createOffered()…");
    assert.ok(
      !GOALS.slice(opener, form).includes("</Show>"),
      "the form title is directly inside the createOffered() Show",
    );
  });

  it("the Pledge button renders only behind actionsFor(goal).pledge", () => {
    const button = GOALS.indexOf("onPress={() => openPledge(goal)}");
    assert.ok(button !== -1, "Pledge button");
    const opener = GOALS.lastIndexOf(
      "<Show when={actionsFor(goal).pledge}>",
      button,
    );
    assert.ok(opener !== -1, "Pledge is inside the pledge Show");
    assert.ok(!GOALS.slice(opener, button).includes("</Show>"));
  });

  it("with spending off nothing that spends is offered, in any gate", () => {
    for (const gate of gates()) {
      if (gate.spending) continue;
      assert.equal(S.ownerTankWrites(gate).spend, false);
      assert.equal(G.ownerGoalWrites(gate).spend, false);
      assert.equal(G.createLaunchGoalOffered(gate, []), false);
      const funded = {
        state: "Funded",
        deadline_at: 9e15,
        launch_deadline_at: 9e15,
      };
      const funding = { state: "Funding", deadline_at: 9e15 };
      assert.equal(G.launchGoalActions(funding, 0, gate, 50).pledge, false);
      assert.equal(G.launchGoalActions(funded, 0, gate, 50).launch, false);
      const tank = {
        slotTier: 10,
        stage: "Active",
        dailyCost: 40,
        balance: 1200,
      };
      const writes = S.ownerTankWrites(gate);
      assert.ok(
        S.tierChoices(tank, COSTS, TIERS, writes, false).choices.every(
          (choice) => choice.direction === "down",
        ),
      );
      assert.deepEqual(
        S.upgradeGoalChoices(tank, COSTS, TIERS, writes, false, price),
        { kind: "none" },
      );
    }
  });
});

describe("T2 owner answer 1: owner writes need Prot and self-serve", () => {
  it("manage = owner && enabled && selfServe; spend = manage && spending", () => {
    for (const gate of gates()) {
      const manage = gate.isOwner && gate.enabled && gate.selfServe;
      const expected = { manage, spend: manage && gate.spending };
      assert.deepEqual(S.ownerTankWrites(gate), expected, JSON.stringify(gate));
      assert.deepEqual(G.ownerGoalWrites(gate), expected, JSON.stringify(gate));
    }
  });

  it("self-serve off: no tier choice, no goal, no cancel, no launch", () => {
    const off = { ...OPEN, selfServe: false };
    const writes = S.ownerTankWrites(off);
    const tank = {
      slotTier: 25,
      stage: "Active",
      dailyCost: 90,
      balance: 2700,
    };
    assert.deepEqual(
      S.tierChoices(tank, COSTS, TIERS, writes, false).choices,
      [],
    );
    assert.equal(S.goalCancelOffered({ state: "Funding" }, writes), false);
    assert.equal(G.createLaunchGoalOffered(off, []), false);
    const actions = G.launchGoalActions(
      { state: "Funded", deadline_at: 9e15, launch_deadline_at: 9e15 },
      0,
      off,
      50,
    );
    assert.equal(actions.cancel, false);
    assert.equal(actions.launch, false);
  });

  it("the owner notes explain a missing control instead of a dead button", () => {
    assert.match(GOALS, /<Match when=\{!feature\(\)\.enabled\}>/);
    assert.match(GOALS, /<Match when=\{!feature\(\)\.self_serve_enabled\}>/);
    assert.match(SETTINGS, /<Match when=\{!feature\(\)\.enabled\}>/);
    assert.match(SETTINGS, /<Match when=\{!feature\(\)\.self_serve_enabled\}>/);
  });
});

describe("T3 tier rules (8.9)", () => {
  const writes = { manage: true, spend: true };
  const slotsOf = (r: { choices: TierChoice[] }) =>
    r.choices.map((choice) => `${choice.direction}${choice.slots}`);

  it("Active: up with spend, down always; the current tier is not offered", () => {
    const tank = { slotTier: 25, stage: "Active", dailyCost: 90, balance: 900 };
    assert.deepEqual(
      slotsOf(S.tierChoices(tank, COSTS, TIERS, writes, false)),
      ["down10", "up50", "up100"],
    );
    assert.deepEqual(
      slotsOf(
        S.tierChoices(
          tank,
          COSTS,
          TIERS,
          { manage: true, spend: false },
          false,
        ),
      ),
      ["down10"],
    );
  });

  it("Grace and Frozen: fewer seats only; other stages: nothing", () => {
    for (const stage of ["Grace", "Frozen"]) {
      const tank = { slotTier: 50, stage, dailyCost: 160, balance: -10 };
      assert.deepEqual(
        slotsOf(S.tierChoices(tank, COSTS, TIERS, writes, false)),
        ["down10", "down25"],
      );
    }
    for (const stage of [
      "Launching",
      "Settling",
      "Deleted",
      "Terminated",
      "Bogus",
    ]) {
      const tank = { slotTier: 50, stage, dailyCost: 160, balance: 5000 };
      assert.deepEqual(
        S.tierChoices(tank, COSTS, TIERS, writes, false).choices,
        [],
      );
    }
  });

  it("a pending tier and an uncosted tier are not offered", () => {
    const tank = {
      slotTier: 50,
      pendingSlotTier: 10,
      stage: "Active",
      dailyCost: 160,
      balance: 1600,
    };
    assert.deepEqual(
      slotsOf(
        S.tierChoices(
          tank,
          { "10": 40, "25": 90, "50": 160 },
          TIERS,
          writes,
          false,
        ),
      ),
      ["down25"],
    );
  });

  it("an open upgrade goal locks the choices", () => {
    const tank = {
      slotTier: 10,
      stage: "Active",
      dailyCost: 40,
      balance: 1200,
    };
    assert.equal(S.tierChoices(tank, COSTS, TIERS, writes, true).locked, true);
    assert.equal(
      S.tierChoices(tank, COSTS, TIERS, writes, false).locked,
      false,
    );
    const goals = [
      { kind: "Launch", state: "Funding" },
      { kind: "Upgrade", state: "Applied" },
      { kind: "Upgrade", state: "Funded", id: "g" },
    ];
    assert.equal((S.openUpgradeGoal(goals) as { id?: string })?.id, "g");
    assert.equal(
      S.openUpgradeGoal([{ kind: "Upgrade", state: "Cancelled" }]),
      undefined,
    );
    assert.ok(S.openUpgradeGoal([{ kind: "Upgrade", state: "Funding" }]));
  });

  it("the seat-change confirm is disabled while locked", () => {
    assert.match(SETTINGS, /disabled=\{busy\(\) \|\| tiers\(\)\.locked\}/);
    assert.match(SETTINGS, /if \(busy\(\) \|\| tiers\(\)\.locked\) return;/);
  });
});

describe("T4 upgrade goal rules (8.7)", () => {
  const tank = { slotTier: 10, stage: "Active", dailyCost: 40, balance: 1200 };

  it("prices 10 → 25 seats with 1,200 left at 1,500", () => {
    const offer = S.upgradeGoalChoices(
      tank,
      COSTS,
      TIERS,
      { spend: true },
      false,
      price,
    );
    assert.equal(offer.kind, "offer");
    assert.deepEqual(offer.kind === "offer" ? offer.choices : [], [
      { slots: 25, target: 1500 },
      { slots: 50, target: 3600 },
      { slots: 100, target: 7800 },
    ]);
  });

  it("less than a whole day of Prot is needsDay", () => {
    assert.deepEqual(
      S.upgradeGoalChoices(
        { ...tank, balance: 39 },
        COSTS,
        TIERS,
        { spend: true },
        false,
        price,
      ),
      { kind: "needsDay" },
    );
  });

  it("not Active, pending, already open or no spend: none", () => {
    for (const offer of [
      S.upgradeGoalChoices(
        { ...tank, stage: "Grace" },
        COSTS,
        TIERS,
        { spend: true },
        false,
        price,
      ),
      S.upgradeGoalChoices(
        { ...tank, pendingSlotTier: 10 },
        COSTS,
        TIERS,
        { spend: true },
        false,
        price,
      ),
      S.upgradeGoalChoices(tank, COSTS, TIERS, { spend: true }, true, price),
      S.upgradeGoalChoices(tank, COSTS, TIERS, { spend: false }, false, price),
      S.upgradeGoalChoices(
        { ...tank, slotTier: 100, dailyCost: 300 },
        COSTS,
        TIERS,
        { spend: true },
        false,
        price,
      ),
    ]) {
      assert.deepEqual(offer, { kind: "none" });
    }
  });

  it("the page prices with protTank's upgradeGoalPrice", () => {
    assert.match(SETTINGS, /upgradeOpen\(\),\s*upgradeGoalPrice,\s*\)/);
  });

  it("cancel is offered on open goals to a managing owner only", () => {
    for (const state of ["Funding", "Funded", "Launching"]) {
      assert.equal(
        S.goalCancelOffered({ state }, { manage: true, spend: false }),
        true,
      );
      assert.equal(
        S.goalCancelOffered({ state }, { manage: false, spend: false }),
        false,
      );
    }
    for (const state of ["Launched", "Applied", "Expired", "Cancelled"]) {
      assert.equal(
        S.goalCancelOffered({ state }, { manage: true, spend: true }),
        false,
      );
    }
  });
});

describe("T5 launch goals per server and per state", () => {
  it("one open launch goal per server", () => {
    assert.deepEqual(
      [...G.OPEN_GOAL_STATES],
      ["Funding", "Funded", "Launching"],
    );
    assert.equal(G.createLaunchGoalOffered(OPEN, []), true);
    assert.equal(
      G.createLaunchGoalOffered(OPEN, [
        { state: "Expired" },
        { state: "Launched" },
      ]),
      true,
    );
    for (const state of G.OPEN_GOAL_STATES) {
      assert.equal(G.createLaunchGoalOffered(OPEN, [{ state }]), false, state);
    }
    assert.equal(
      G.createLaunchGoalOffered({ ...OPEN, isOwner: false }, []),
      false,
    );
  });

  it("pledge: spending, Prot on, a minimum, Funding and before the deadline", () => {
    const goal = { state: "Funding", deadline_at: 1000 };
    const member = { ...OPEN, isOwner: false, selfServe: false };
    assert.equal(G.launchGoalActions(goal, 999, member, 50).pledge, true);
    assert.equal(G.launchGoalActions(goal, 1000, member, 50).pledge, false);
    assert.equal(
      G.launchGoalActions(goal, 0, { ...member, enabled: false }, 50).pledge,
      false,
    );
    assert.equal(
      G.launchGoalActions(goal, 0, { ...member, spending: false }, 50).pledge,
      false,
    );
    assert.equal(G.launchGoalActions(goal, 0, member, 0).pledge, false);
    for (const state of [
      "Funded",
      "Launching",
      "Launched",
      "Expired",
      "Cancelled",
    ]) {
      assert.equal(
        G.launchGoalActions({ ...goal, state }, 0, member, 50).pledge,
        false,
      );
    }
  });

  it("launch: owner spend, Funded, until launch_deadline_at", () => {
    const goal = { state: "Funded", deadline_at: 0, launch_deadline_at: 5000 };
    assert.equal(G.launchGoalActions(goal, 5000, OPEN, 50).launch, true);
    assert.equal(G.launchGoalActions(goal, 5001, OPEN, 50).launch, false);
    assert.equal(
      G.launchGoalActions({ state: "Funded", deadline_at: 0 }, 0, OPEN, 50)
        .launch,
      false,
    );
    assert.equal(
      G.launchGoalActions({ ...goal, state: "Funding" }, 0, OPEN, 50).launch,
      false,
    );
    assert.equal(
      G.launchGoalActions(goal, 0, { ...OPEN, isOwner: false }, 50).launch,
      false,
    );
  });

  it("cancel: managing owner, any open state, in every build", () => {
    const noSpend = { ...OPEN, spending: false };
    for (const state of ["Funding", "Funded", "Launching"]) {
      assert.equal(
        G.launchGoalActions({ state, deadline_at: 0 }, 0, noSpend, 50).cancel,
        true,
      );
    }
    assert.equal(
      G.launchGoalActions({ state: "Launched", deadline_at: 0 }, 0, OPEN, 50)
        .cancel,
      false,
    );
  });

  it("the pledge target is the pinned 16.3 goal shape", () => {
    assert.match(
      GOALS,
      /target: \{ kind: "goal", goalId: goal\.id, serverId: goal\.server_id \},/,
    );
  });
});

describe("T6 withdraw returns Prot: never spend-gated", () => {
  const pledges = [
    { id: "a", state: "Held", remaining: 100 },
    { id: "b", state: "Held", remaining: 0 },
    { id: "c", state: "Withdrawn", remaining: 50 },
    { id: "d", state: "Captured", remaining: 0 },
  ];

  it("only Held pledges with something left, while on and open", () => {
    assert.deepEqual(
      G.withdrawablePledges(pledges, true, true).map((p) => p.id),
      ["a"],
    );
    assert.deepEqual(G.withdrawablePledges(pledges, false, true), []);
    assert.deepEqual(G.withdrawablePledges(pledges, true, false), []);
    assert.equal(G.heldPledgeTotal(pledges), 100);
  });

  it("the window comes from protTank's withdrawOpen, and no spend gate", () => {
    assert.match(GOALS, /withdrawOpen\(goal, now\(\)\)/);
    const at = GOALS.indexOf("deletePledge(api");
    assert.ok(at !== -1, "withdraw site");
    assert.ok(!enclosingFunction(GOALS, at).includes("allowsProtSpending"));
  });

  it("withdraw goes through a confirm step", () => {
    const confirm = GOALS.indexOf("withdrawQuestion(pledge)");
    const call = GOALS.indexOf("void withdraw(goal, pledge)");
    assert.ok(
      confirm !== -1 && call > confirm,
      "the question precedes the call",
    );
  });
});

describe("T7 launch picker", () => {
  const base: LaunchChannel = {
    id: "ok",
    type: "TextChannel",
    serverId: "S",
    voice: false,
    announcement: false,
    protected: false,
    lastMessageId: null,
  };

  it("offers only empty, unprotected text channels of the server", () => {
    const channels: LaunchChannel[] = [
      base,
      { ...base, id: "undefinedLast", lastMessageId: undefined },
      { ...base, id: "emptyLast", lastMessageId: "" },
      { ...base, id: "voice", voice: true },
      { ...base, id: "announce", announcement: true },
      { ...base, id: "protected", protected: true },
      { ...base, id: "messages", lastMessageId: "01MSG" },
      { ...base, id: "other", serverId: "T" },
      { ...base, id: "noserver", serverId: undefined },
      { ...base, id: "vc", type: "VoiceChannel" },
    ];
    assert.deepEqual(
      G.launchableChannels(channels, "S").map((c) => c.id),
      ["ok", "undefinedLast", "emptyLast"],
    );
  });

  it("the launch call re-checks the pick against the picker", () => {
    const at = GOALS.indexOf("postGoalLaunch(");
    assert.match(
      enclosingFunction(GOALS, at),
      /launchable\(\)\.some\(\(entry\) => entry\.id === channelId\)/,
    );
  });

  it("parses whole days only", () => {
    assert.equal(G.parseWholeNumber(" 30 "), 30);
    for (const bad of ["", "3.5", "-1", "1e3", "abc", "1234567"]) {
      assert.equal(G.parseWholeNumber(bad), null, bad);
    }
  });
});

describe("T8 nonces per intent", () => {
  for (const [file, rules] of [
    ["ProtTankSettings", S],
    ["ProtServerGoals", G],
  ] as const) {
    it(`${file}: same intent same nonce; new intent or clear, new nonce`, () => {
      let n = 0;
      const keeper = rules.createNonceKeeper(() => `n${++n}`);
      assert.equal(keeper.nonceFor("25"), "n1");
      assert.equal(keeper.nonceFor("25"), "n1");
      assert.equal(keeper.nonceFor("50"), "n2");
      keeper.clear();
      assert.equal(keeper.nonceFor("50"), "n3");
    });
  }
});

describe("T9 copy and traps", () => {
  const notice = /export const PROT_SEAT_NOTICE_EN =\s*"([^"]+)";/.exec(
    protTankSource,
  )?.[1];

  it("the seat notice is protTank's, byte for byte, next to Pledge", () => {
    assert.ok(notice, "PROT_SEAT_NOTICE_EN in protTank.ts");
    const at = GOALS.indexOf("{t`" + notice + "`}");
    assert.ok(at !== -1, "ProtServerGoals renders the notice through t``");
    const opener = GOALS.lastIndexOf(
      "<Show when={actionsFor(goal).pledge}>",
      at,
    );
    const button = GOALS.indexOf("openPledge(goal)", at);
    assert.ok(opener !== -1 && button !== -1);
    assert.ok(!GOALS.slice(opener, button).includes("</Show>"));
  });

  it("Anonymous and Deleted user carry the Prot contributor context", () => {
    for (const src of [SETTINGS, GOALS]) {
      assert.match(
        src,
        /t\(\{ message: "Anonymous", context: "Prot contributor" \}\)/,
      );
      assert.match(
        src,
        /t\(\{ message: "Deleted user", context: "Prot contributor" \}\)/,
      );
    }
  });

  it("no price, payment link or donation text", () => {
    for (const src of [SETTINGS, GOALS]) {
      assert.doesNotMatch(
        src,
        /formatUsd|allowsDonationLinks|sloga\.gg|\bUSD\b/,
      );
      assert.doesNotMatch(src, /openCheckout|postProtCheckout|\bbuy\b/i);
    }
  });

  it("deletion copy only from the server's deletes_at", () => {
    assert.match(
      SETTINGS,
      /if \(tank\.deletes_at === undefined\) return undefined;/,
    );
    assert.doesNotMatch(GOALS, /deleted from Sloga's servers/);
  });

  it("no styled(Component) and no use:floating", () => {
    for (const src of [SETTINGS, GOALS]) {
      assert.doesNotMatch(src, /styled\(\s*[^"'\s]/);
      assert.doesNotMatch(src, /use:floating/);
    }
  });

  it("the pinned names L6h wires", () => {
    assert.match(
      SETTINGS,
      /export function ProtTankSettings\(props: \{ channel: Channel \}\)/,
    );
    assert.match(
      GOALS,
      /export function ProtServerGoalsModal\(\s*props: DialogProps & Modals & \{ type: "prot_server_goals" \},?\s*\)/,
    );
  });
});

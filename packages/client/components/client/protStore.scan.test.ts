// Store gate for Prot spending (S5b, contracts 17, D5; S6 pin), run with
// Node's built-in runner from packages/client:
//   node --conditions=browser --test components/client/protStore.scan.test.ts
//
// Store builds (Play, App Store) may not spend Prot until S6 brings in-app
// purchase. Every entry point that spends Prot (top up, pledge, open or
// launch a goal, move to more seats) must sit behind `allowsProtSpending()`
// from `distribution.ts` twice: where it renders, and at the call itself.
// Balances, banners, contributors, withdraw and cancel stay in every build.
//
//  P1  inventory: every `"prot_contribute"` in the client source (tests
//      excluded) is one of the known sites: the modal type, its switch arm,
//      the dialog's own props, and the four openers (ProtectedTank.tsx 2,
//      ProtServerGoals.tsx 1, ProtBanner.tsx 1). A new opener fails here
//      until it is listed (and gated) below;
//  P2  every opener's function starts with `if (!allowsProtSpending()) return;`;
//  P3  every reference to an opener renders only inside its gate
//      (`<Show when={gate}>` children, never its `fallback`);
//  P4  every spend request (`postContribute`, `postPledge`, `postLaunchGoal`,
//      `postGoalLaunch`, `postUpgradeGoal`, `putTier`) is called only from
//      its one known function, which starts with the guard (`putTier`: a
//      move UP needs it), and that function is reached only from its render
//      gate; no file but protTank.ts builds a `/prot/...` route itself;
//  P5  play distribution: with the REAL distribution module on an Android
//      bridge whose AppFlavor reports "play", every file's own gate
//      expressions and pure rules offer no spending, while withdraw, cancel
//      and moving to fewer seats stay offered. The same expressions with
//      spending allowed do offer it (so P5 is not vacuous).
//
// Known-bad controls: point PROT_STORE_TANK_FILE, PROT_STORE_GOALS_FILE,
// PROT_STORE_CONTRIBUTE_FILE, PROT_STORE_BANNER_FILE or
// PROT_STORE_SETTINGS_FILE at a mutated copy (it replaces that file, in the
// inventory walk too); PROT_STORE_EXTRA_FILE adds one more file to the walk
// (as components/app/protStoreScanControl.tsx); PROT_STORE_DISTRIBUTION_MODULE
// imports another distribution module. Each control must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// What @capacitor/core reads at import (as distribution.play.test.ts): an
// Android bridge whose AppFlavor plugin answers "play". Set BEFORE the
// distribution module is imported below; node --test runs this file in its
// own process.
Object.assign(globalThis, {
  androidBridge: {},
  Capacitor: {
    PluginHeaders: [
      { name: "AppFlavor", methods: [{ name: "get", rtype: "promise" }] },
    ],
    nativePromise: () => Promise.resolve({ channel: "play" }),
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");

const TANK = "components/modal/modals/ProtectedTank.tsx";
const GOALS = "components/modal/modals/ProtServerGoals.tsx";
const CONTRIBUTE = "components/modal/modals/ProtContribute.tsx";
const BANNER = "src/interface/channels/text/ProtBanner.tsx";
const SETTINGS =
  "components/app/interface/settings/channel/protected/ProtTankSettings.tsx";
const TYPES = "components/modal/types.ts";
const MODALS = "components/modal/modals.tsx";
const PROT_TANK = "components/client/protTank.ts";
const EXTRA = "components/app/protStoreScanControl.tsx";

const OVERRIDES: Record<string, string | undefined> = {
  [TANK]: process.env.PROT_STORE_TANK_FILE,
  [GOALS]: process.env.PROT_STORE_GOALS_FILE,
  [CONTRIBUTE]: process.env.PROT_STORE_CONTRIBUTE_FILE,
  [BANNER]: process.env.PROT_STORE_BANNER_FILE,
  [SETTINGS]: process.env.PROT_STORE_SETTINGS_FILE,
};

function readRel(rel: string): string {
  return readFileSync(OVERRIDES[rel] || join(ROOT, rel), "utf8");
}

/** Comments blanked (offsets kept) so prose never counts as code */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, " "));
}

const SRC: Record<string, string> = {};
for (const rel of [TANK, GOALS, CONTRIBUTE, BANNER, SETTINGS]) {
  SRC[rel] = code(readRel(rel));
}

/** Every client source file (tests and generated catalogs excluded) */
function walk(): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "catalogs") continue;
      if (entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) {
        continue;
      }
      const rel = relative(ROOT, full).split(sep).join("/");
      out.set(rel, readRel(rel));
    }
  };
  visit(join(ROOT, "components"));
  visit(join(ROOT, "src"));
  if (process.env.PROT_STORE_EXTRA_FILE) {
    out.set(EXTRA, readFileSync(process.env.PROT_STORE_EXTRA_FILE, "utf8"));
  }
  return out;
}
const TREE = walk();

/** All indexes of a regex in `src` */
function indexes(src: string, re: RegExp): number[] {
  return [
    ...src.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g")),
  ].map((m) => m.index ?? -1);
}

/** The `function NAME(` that encloses `index`, with its body up to `index` */
function enclosingFunction(
  src: string,
  index: number,
): { name: string; body: string } {
  const start = src.lastIndexOf("function ", index);
  assert.ok(start !== -1, `a site at ${index} is outside any function`);
  const head = src.slice(start).match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
  assert.ok(head, `unnamed function before ${index}`);
  // the parameter list, then the body's opening brace
  let i = start + head[0].length;
  for (let depth = 1; depth > 0; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
  }
  const open = src.indexOf("{", i);
  assert.ok(open !== -1 && open < index, `no body before ${index}`);
  return { name: head[1], body: src.slice(open + 1, index) };
}

/** The statement `const NAME = …;` (an arrow function), or fail */
function constExpr(src: string, name: string, file: string): string {
  const head = new RegExp(`\\bconst ${name}\\s*=\\s*`).exec(src);
  assert.ok(head, `${file}: no \`const ${name} =\``);
  const from = head.index + head[0].length;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) return src.slice(from, i);
  }
  throw new Error(`${file}: \`const ${name}\` never ends`);
}

/**
 * Evaluate the file's own arrow function `const NAME = …` with `deps` as its
 * free variables (types stripped). A free variable missing from `deps`
 * throws when called, so a changed gate fails instead of passing.
 */
function evalConst<T>(
  src: string,
  name: string,
  file: string,
  deps: Record<string, unknown>,
): T {
  const expr = constExpr(src, name, file);
  const js = stripTypeScriptTypes(`(${expr})`, { mode: "strip" });
  const names = Object.keys(deps);
  return new Function(...names, `"use strict"; return ${js};`)(
    ...names.map((n) => deps[n]),
  ) as T;
}

type Frame = { tag: string; when: string; tagEnd: number };

/** Where the opening tag starting at `at` ends (its `>`), braces balanced */
function openingTagEnd(src: string, at: number): number {
  let depth = 0;
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  throw new Error(`unterminated tag at ${at}`);
}

/**
 * The tag's own `when={…}` expression: only at brace depth 0, so the
 * `when` of a <Show> nested in a `fallback={…}` is never taken for it
 */
function whenOf(tag: string): string {
  let depth = 0;
  for (let at = 0; at < tag.length; at++) {
    const c = tag[at];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && /\s/.test(c) && tag.startsWith("when={", at + 1)) {
      let inner = 1;
      let i = at + 7;
      for (; inner > 0 && i < tag.length; i++) {
        if (tag[i] === "{") inner++;
        else if (tag[i] === "}") inner--;
      }
      return tag
        .slice(at + 7, i - 1)
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return "";
}

/** The open <Show>/<Match> elements around `index` (outermost first) */
function framesAt(src: string, index: number): Frame[] {
  const stack: Frame[] = [];
  for (const m of src.matchAll(/<(\/?)(Show|Match)\b/g)) {
    const at = m.index ?? 0;
    if (at >= index) break;
    if (m[1] === "/") {
      const top = stack.pop();
      assert.ok(top && top.tag === m[2], `unbalanced </${m[2]}> at ${at}`);
      continue;
    }
    const end = openingTagEnd(src, at);
    if (src[end - 1] === "/") continue; // self-closing
    stack.push({
      tag: m[2],
      when: whenOf(src.slice(at, end + 1)),
      tagEnd: end,
    });
  }
  return stack;
}

/**
 * Whether `index` renders only behind a gate: inside the CHILDREN of a
 * <Show>/<Match> whose `when` matches (a `fallback` is the opposite of the
 * gate, so a site in the opening tag does not count), or inside one of
 * `spans` (an `allowsProtSpending() ? […] : []` branch).
 */
function gated(
  src: string,
  index: number,
  when: RegExp,
  spans: [number, number][] = [],
): boolean {
  if (spans.some(([a, b]) => index > a && index < b)) return true;
  return framesAt(src, index).some(
    (f) => index > f.tagEnd && when.test(f.when),
  );
}

/** References to function `name` other than its definition */
function references(src: string, name: string): number[] {
  return indexes(src, new RegExp(`\\b${name}\\b`)).filter(
    (at) => !/function\s+$/.test(src.slice(Math.max(0, at - 16), at)),
  );
}

const GUARD = "if (!allowsProtSpending()) return;";
const TIER_GUARD =
  'if (choice.direction === "up" && !allowsProtSpending()) return;';

/** The four `prot_contribute` openers and the gate each renders behind */
const OPENERS = [
  { file: TANK, fn: "openTopUp", when: /^topUpOffered\(\)$/ },
  { file: TANK, fn: "openPledge", when: /^pledgeOffered\(goal\)$/ },
  { file: GOALS, fn: "openPledge", when: /^actionsFor\(goal\)\.pledge$/ },
  { file: BANNER, fn: "openTopUp", when: /^topUpOffered\(\)$/ },
] as const;

/** Every other `"prot_contribute"` the source may carry */
const DECLARATIONS: Record<string, number> = {
  [TYPES]: 1,
  [MODALS]: 1,
  [CONTRIBUTE]: 1,
};

/** The spend requests, the one function each is called from, its gate */
const SPENDS = [
  { call: "postContribute", file: CONTRIBUTE, fn: "submit", guard: GUARD },
  { call: "postPledge", file: CONTRIBUTE, fn: "submit", guard: GUARD },
  { call: "postLaunchGoal", file: GOALS, fn: "createGoal", guard: GUARD },
  { call: "postGoalLaunch", file: GOALS, fn: "launchGoal", guard: GUARD },
  {
    call: "postUpgradeGoal",
    file: SETTINGS,
    fn: "createUpgradeGoal",
    guard: GUARD,
  },
  { call: "putTier", file: SETTINGS, fn: "changeTier", guard: TIER_GUARD },
] as const;

/** The `...(allowsProtSpending() ? […] : [])` spans of a file */
function spendSpans(src: string): [number, number][] {
  return indexes(src, /\.\.\.\(allowsProtSpending\(\)\s*\?/).map((at) => {
    let depth = 0;
    for (let i = at + 3; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0)
        return [at, i] as [number, number];
    }
    throw new Error("unterminated allowsProtSpending() spread");
  });
}

const SPEND_GATES: Record<string, { when: RegExp; spans?: boolean }> = {
  // the confirm button (in the spread) and the form (Match block() === null)
  submit: { when: /^block\(\) === null$/, spans: true },
  createGoal: { when: /^createOffered\(\)( |$)/ },
  launchGoal: { when: /^actionsFor\(goal\)\.launch$/ },
  createUpgradeGoal: { when: /upgradeGoals\(\)/ },
  changeTier: { when: /^tiers\(\)\.choices\.length$/ },
};

describe("P1 inventory: every prot_contribute site is known", () => {
  it("walks the whole client source", () => {
    assert.ok(TREE.size > 300, `only ${TREE.size} source files found`);
    for (const rel of [TANK, GOALS, CONTRIBUTE, BANNER, SETTINGS, TYPES]) {
      assert.ok(TREE.has(rel), `${rel} not in the walk`);
    }
  });

  it("no file opens prot_contribute except the listed openers", () => {
    const expected: Record<string, number> = { ...DECLARATIONS };
    for (const o of OPENERS) expected[o.file] = (expected[o.file] ?? 0) + 1;
    for (const [rel, text] of TREE) {
      const want = expected[rel] ?? 0;
      // A quoted literal in the raw text, and the bare token in the code
      // (comments blanked): either one alone could be dodged
      const quoted = indexes(text, /["']prot_contribute["']/).length;
      const token = indexes(code(text), /prot_contribute/).length;
      for (const [how, found] of [
        ["quoted", quoted],
        ["in code", token],
      ] as const) {
        assert.equal(
          found,
          want,
          `${rel}: ${found} "prot_contribute" site(s) ${how}, the store scan lists ${want}. A new opener must be listed in OPENERS and gated by allowsProtSpending()`,
        );
      }
    }
  });

  it('each opener site is `type: "prot_contribute"` in its listed function', () => {
    for (const file of [TANK, GOALS, BANNER]) {
      const src = SRC[file];
      const listed = OPENERS.filter((o) => o.file === file).map((o) => o.fn);
      const seen = indexes(src, /type: "prot_contribute",/).map(
        (at) => enclosingFunction(src, at).name,
      );
      assert.deepEqual(seen.sort(), [...listed].sort(), `${file}: openers`);
    }
  });

  it("the gate comes from the S5a distribution module in every file", () => {
    for (const file of [TANK, GOALS, CONTRIBUTE, BANNER, SETTINGS]) {
      assert.match(
        SRC[file],
        /import \{ allowsProtSpending \} from "@revolt\/client\/distribution";/,
        `${file}: allowsProtSpending import`,
      );
      assert.doesNotMatch(
        SRC[file],
        /(const|let|var|function)\s+allowsProtSpending\b/,
        `${file}: a local allowsProtSpending shadows the real one`,
      );
    }
  });
});

describe("P2 every opener re-checks the gate at the call", () => {
  for (const o of OPENERS) {
    it(`${o.file.split("/").pop()} ${o.fn}`, () => {
      const src = SRC[o.file];
      const at = src.indexOf(
        'type: "prot_contribute",',
        src.search(new RegExp(`function ${o.fn}\\(`)),
      );
      assert.ok(at !== -1, `${o.fn}: no opener`);
      const { name, body } = enclosingFunction(src, at);
      assert.equal(name, o.fn);
      assert.ok(
        body.trimStart().startsWith(GUARD),
        `${o.fn} must start with \`${GUARD}\`:\n${body.slice(0, 200)}`,
      );
    });
  }
});

describe("P3 every opener renders only behind its gate", () => {
  for (const o of OPENERS) {
    it(`${o.file.split("/").pop()} ${o.fn} inside <Show when={${o.when.source}}>`, () => {
      const src = SRC[o.file];
      const refs = references(src, o.fn);
      assert.ok(refs.length > 0, `${o.fn} is never rendered (renamed?)`);
      for (const at of refs) {
        assert.ok(
          gated(src, at, o.when),
          `${o.file}: ${o.fn} is reachable outside its gate:\n${src.slice(Math.max(0, at - 160), at + 40)}`,
        );
      }
    });
  }
});

describe("P4 spend requests: one guarded, gated function each", () => {
  it("no other file calls a spend request or builds a /prot/ route", () => {
    for (const [rel, raw] of TREE) {
      if (rel === PROT_TANK) continue;
      const text = code(raw);
      for (const s of SPENDS) {
        const uses = indexes(text, new RegExp(`\\b${s.call}\\b`)).length;
        const allowed = SPENDS.some((x) => x.call === s.call && x.file === rel);
        if (!allowed) {
          assert.equal(
            uses,
            0,
            `${rel} uses ${s.call}: spend requests are listed in the store scan`,
          );
        }
      }
      assert.doesNotMatch(
        text,
        /prot\/(channels|goals|servers|tanks)\b|\bpath\("(channels|goals|servers|tanks)"/,
        `${rel} builds a /prot/ route itself; requests go through protTank.ts`,
      );
    }
  });

  for (const s of SPENDS) {
    it(`${s.call} only in ${s.fn}, guarded`, () => {
      const src = SRC[s.file];
      assert.doesNotMatch(
        src,
        new RegExp(`\\b${s.call} as\\b`),
        `${s.call} is aliased`,
      );
      const calls = indexes(src, new RegExp(`\\b${s.call}\\(`));
      assert.ok(
        calls.length > 0,
        `${s.file}: ${s.call} never called (renamed?)`,
      );
      for (const at of calls) {
        const { name, body } = enclosingFunction(src, at);
        assert.equal(name, s.fn, `${s.file}: ${s.call} called from ${name}`);
        assert.ok(
          body.trimStart().startsWith(s.guard),
          `${s.fn} must start with \`${s.guard}\`:\n${body.slice(0, 200)}`,
        );
      }
      // every other mention is the import specifier
      const all = indexes(src, new RegExp(`\\b${s.call}\\b`)).length;
      const imported = indexes(src, new RegExp(`^\\s*${s.call},$`, "m")).length;
      assert.equal(
        all,
        calls.length + imported,
        `${s.file}: ${s.call} passed around`,
      );
    });
  }

  for (const [fn, gate] of Object.entries(SPEND_GATES)) {
    const file = SPENDS.find((s) => s.fn === fn)!.file;
    it(`${fn} renders only behind its gate`, () => {
      const src = SRC[file];
      const spans = gate.spans ? spendSpans(src) : [];
      if (gate.spans)
        assert.ok(spans.length > 0, `${file}: no allowsProtSpending() spread`);
      const refs = references(src, fn);
      assert.ok(refs.length > 0, `${fn} is never rendered (renamed?)`);
      for (const at of refs) {
        assert.ok(
          gated(src, at, gate.when, spans),
          `${file}: ${fn} is reachable outside its gate:\n${src.slice(Math.max(0, at - 160), at + 40)}`,
        );
      }
    });
  }

  it("the contribute dialog's confirm button is inside the spend spread", () => {
    const src = SRC[CONTRIBUTE];
    const spans = spendSpans(src);
    const button = src.indexOf("<Trans>Contribute</Trans>");
    assert.ok(button !== -1, "confirm label");
    assert.ok(
      spans.some(([a, b]) => button > a && button < b),
      "the Contribute button renders outside `...(allowsProtSpending() ? […] : [])`",
    );
  });
});

// ---- P5: the play distribution, end to end ---------------------------------

const BEGIN = /\/\/ prot-(contribute-)?pure:begin/;
const END = /\/\/ prot-(contribute-)?pure:end/;

async function loadRegion<T>(file: string, extraExport?: string): Promise<T> {
  const src = readRel(file);
  const from = src.search(BEGIN);
  const to = src.search(END);
  assert.ok(from !== -1 && to > from, `${file}: pure region missing`);
  const region = src.slice(from, to);
  assert.ok(
    !/^\s*import\s/m.test(region),
    `${file}: the region must not import`,
  );
  const js =
    stripTypeScriptTypes(region, { mode: "strip" }) +
    (extraExport ? `\nexport { ${extraExport} };\n` : "");
  const dir = mkdtempSync(join(tmpdir(), "s5bw6-L6h-"));
  const out = join(dir, `${file.split("/").pop()}.mjs`);
  writeFileSync(out, js);
  return (await import(pathToFileURL(out).href)) as T;
}

type Fn = (...args: never[]) => unknown;
const distribution = (await import(
  process.env.PROT_STORE_DISTRIBUTION_MODULE
    ? pathToFileURL(process.env.PROT_STORE_DISTRIBUTION_MODULE).href
    : "./distribution.ts"
)) as {
  allowsProtSpending: () => boolean;
  distributionChannel: () => string;
};
// let the AppFlavor answer land
await new Promise((resolve) => setTimeout(resolve, 0));

const C = await loadRegion<{ contributeBlock: Fn }>(
  CONTRIBUTE,
  "contributeBlock",
);
const G = await loadRegion<Record<string, Fn>>(GOALS);
const S = await loadRegion<Record<string, Fn>>(SETTINGS);

const NOW = 1_800_000_000_000;
const COSTS = { "10": 40, "25": 90, "50": 160, "100": 300 };
const TIERS = [10, 25, 50, 100];
const upgradePrice = (oldCost: number, newCost: number, balance: number) =>
  newCost <= oldCost || balance <= 0
    ? 0
    : (newCost - oldCost) * Math.floor(balance / oldCost);

/** What each surface offers, from the files' own expressions */
function offers(allowsProtSpending: () => boolean) {
  const open = { min_contribution: 50 };
  const tankDeps = {
    allowsProtSpending,
    protEnabled: () => true,
    tankRules: () => open,
    detail: () => ({ can_contribute: true }),
  };
  const tankTopUp = evalConst<() => boolean>(
    SRC[TANK],
    "topUpOffered",
    TANK,
    tankDeps,
  );
  const tankPledge = evalConst<(goal: unknown) => boolean>(
    SRC[TANK],
    "pledgeOffered",
    TANK,
    tankDeps,
  );
  const bannerTopUp = evalConst<() => boolean>(
    SRC[BANNER],
    "topUpOffered",
    BANNER,
    {
      allowsProtSpending,
      protEnabled: () => true,
      tankRules: () => open,
      summary: () => ({ stage: "Grace", tank_id: "T1" }),
      lastRead: () => ({ channelId: "C1", tankId: "T1", canContribute: true }),
      props: { channel: { id: "C1" } },
      TOP_UP_STAGES: new Set(["Active", "Grace", "Frozen"]),
    },
  );

  const owner = {
    isOwner: () => true,
    feature: () => ({ enabled: true, self_serve_enabled: true }),
    allowsProtSpending,
  };
  const gate = evalConst<() => unknown>(SRC[GOALS], "gate", GOALS, owner);
  const actionsFor = evalConst<(goal: unknown) => Record<string, boolean>>(
    SRC[GOALS],
    "actionsFor",
    GOALS,
    {
      launchGoalActions: G.launchGoalActions,
      now: () => NOW,
      gate,
      tankRules: () => open,
    },
  );
  const createOffered = evalConst<() => boolean>(
    SRC[GOALS],
    "createOffered",
    GOALS,
    {
      createLaunchGoalOffered: G.createLaunchGoalOffered,
      gate,
      list: () => [],
    },
  );
  const funding = { state: "Funding", deadline_at: NOW + 1e6 };
  const funded = {
    state: "Funded",
    deadline_at: NOW - 1,
    launch_deadline_at: NOW + 1e6,
  };

  const writes = evalConst<() => { manage: boolean; spend: boolean }>(
    SRC[SETTINGS],
    "writes",
    SETTINGS,
    { ownerTankWrites: S.ownerTankWrites, ...owner },
  );
  const tank = { slotTier: 25, stage: "Active", dailyCost: 90, balance: 9000 };
  const tiers = (
    S.tierChoices as (...a: unknown[]) => {
      choices: { direction: string }[];
    }
  )(tank, COSTS, TIERS, writes(), false);
  const upgrade = (
    S.upgradeGoalChoices as (...a: unknown[]) => { kind: string }
  )(tank, COSTS, TIERS, writes(), false, upgradePrice);

  const block = evalConst<() => unknown>(SRC[CONTRIBUTE], "block", CONTRIBUTE, {
    contributeBlock: C.contributeBlock,
    allowsProtSpending,
    enabled: () => true,
    tankFeature: () => open,
    targetState: () => ({ kind: "tank", stage: "Active", canContribute: true }),
  });

  return {
    tankTopUp: tankTopUp(),
    tankPledge: tankPledge({ kind: "Upgrade", state: "Funding" }),
    bannerTopUp: bannerTopUp(),
    goalPledge: actionsFor(funding).pledge,
    goalLaunch: actionsFor(funded).launch,
    goalCancel: actionsFor(funding).cancel,
    createGoal: createOffered(),
    tierUp: tiers.choices.some((c) => c.direction === "up"),
    tierDown: tiers.choices.some((c) => c.direction === "down"),
    upgradeGoal: upgrade.kind === "offer",
    contributeForm: block() === null,
    contributeBlock: block(),
  };
}

describe("P5 a Play build offers no Prot spending", () => {
  it("the real distribution module reads as Play there", () => {
    assert.equal(distribution.distributionChannel(), "play");
    assert.equal(distribution.allowsProtSpending(), false);
  });

  it("every spending entry point is off; returning Prot is not", () => {
    const play = offers(distribution.allowsProtSpending);
    assert.deepEqual(
      {
        tankTopUp: play.tankTopUp,
        tankPledge: play.tankPledge,
        bannerTopUp: play.bannerTopUp,
        goalPledge: play.goalPledge,
        goalLaunch: play.goalLaunch,
        createGoal: play.createGoal,
        tierUp: play.tierUp,
        upgradeGoal: play.upgradeGoal,
        contributeForm: play.contributeForm,
      },
      {
        tankTopUp: false,
        tankPledge: false,
        bannerTopUp: false,
        goalPledge: false,
        goalLaunch: false,
        createGoal: false,
        tierUp: false,
        upgradeGoal: false,
        contributeForm: false,
      },
    );
    assert.equal(play.contributeBlock, "store", "the dialog says why first");
    // not spending: still offered in a store build
    assert.equal(play.goalCancel, true, "cancel a goal (pledges go back)");
    assert.equal(play.tierDown, true, "move to fewer seats");
  });

  it("the same expressions do offer spending where it is allowed", () => {
    const web = offers(() => true);
    for (const [key, value] of Object.entries(web)) {
      if (key === "contributeBlock") continue;
      assert.equal(value, true, `${key} with spending allowed`);
    }
    assert.equal(web.contributeBlock, null);
  });

  it("withdrawing a pledge is never spend-gated", () => {
    const held = [{ state: "Held", remaining: 120 }];
    assert.equal(
      (G.withdrawablePledges as (...a: unknown[]) => unknown[])(
        held,
        true,
        true,
      ).length,
      1,
    );
    assert.doesNotMatch(
      constExpr(SRC[TANK], "withdrawOffered", TANK),
      /allowsProtSpending/,
      "ProtectedTank: withdraw must not depend on the store gate",
    );
  });
});

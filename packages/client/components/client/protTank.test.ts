/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/protTank.test.ts
 *
 * The decisions behind the Prot fuel tank and goal UI (S5b), which live in
 * `.tsx` files reaching lingui and `@revolt/ui` and so are loadable by no
 * unit runner. Each `describe` names the decision and what goes wrong
 * without it:
 *
 * - the seat notice is the server's text byte for byte, in English and in
 *   the pinned pt-BR (a reworded notice could promise a seat);
 * - the catalogs hold that copy: the pt-BR catalog's notice is the pinned
 *   pt-BR text byte for byte (the one the pt-BR Terms page quotes), its
 *   "Prot contributor" labels are the pinned ones, and all five Prot locales
 *   translate the notice (an empty msgstr would show the English, or the
 *   hash). Point `PROT_CATALOG_DIR` at a copy of `components/i18n/catalogs`
 *   (a known-bad control) to check that instead; it must fail;
 * - parsing fails closed: an unknown stage, kind or state is `null`, never a
 *   guess, and a hidden or deleted contributor's id never survives parsing;
 * - the banner for every stage, and the low banner counts down from the
 *   tank's own date;
 * - the price previews match the server's math (1,200 for a 30-day launch
 *   goal at 40 a day; 1,500 for the 10 to 25 slot upgrade with 1,200 left);
 * - withdraw closes at the cutoff, and amounts below the minimum are refused
 *   unless they complete a goal;
 * - the requests hit the right routes with the right bodies, `NotFound` on a
 *   tank read means "no tank", and any other failure or an unreadable body
 *   is an error, never "no tank".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  type CipherApi,
  CipherClientError,
} from "../app/interface/settings/user/cipherCheckout.ts";
import {
  type ProtContributorView,
  type ProtGoalView,
  type ProtTankFeature,
  type ProtTankSummary,
  PROT_GOAL_KINDS,
  PROT_GOAL_STATES,
  PROT_LOW_DAYS,
  PROT_MAX_AMOUNT,
  PROT_PLEDGE_STATES,
  PROT_SEAT_NOTICE_EN,
  PROT_SEAT_NOTICE_PT_BR,
  PROT_SLOT_TIERS,
  PROT_TANK_STAGES,
  contributionAmountProblem,
  contributorLabel,
  deletePledge,
  fetchGoal,
  fetchProtTank,
  fetchServerGoals,
  launchGoalPrice,
  parseProtContributionResponse,
  parseProtContributorView,
  parseProtGoalView,
  parseProtPledgeResponse,
  parseProtPledgeView,
  parseProtTankFeature,
  parseProtTankSummary,
  parseProtTankView,
  postContribute,
  postGoalCancel,
  postGoalLaunch,
  postLaunchGoal,
  postPledge,
  postUpgradeGoal,
  putContributorPrefs,
  putTier,
  tankBannerKind,
  tankDaysLeft,
  tierDailyCost,
  upgradeGoalPrice,
  withdrawOpen,
} from "./protTank.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const TANK_ADVERT = {
  channel_daily_cost: { "10": 40, "25": 90, "50": 160, "100": 280 },
  min_contribution: 50,
  min_launch_goal_days: 30,
  max_launch_goal_days: 365,
  launch_goal_deadline_days: 30,
  withdraw_cutoff_hours: 48,
  contribute_hold_hours: 72,
  grace_days: 5,
  freeze_days: 25,
  deletion_enabled: true,
};

const SUMMARY_WIRE = {
  tank_id: "01TANK",
  channel_id: "01CHANNEL",
  stage: "Active",
  slot_tier: 10,
  daily_cost: 40,
  balance: 1200,
  protected_until: NOW + 30 * DAY,
  launched_at: NOW - 3 * DAY,
  version: 3,
  balance_version: 12,
};

const summary = (patch: Partial<ProtTankSummary> = {}): ProtTankSummary => ({
  ...(parseProtTankSummary(SUMMARY_WIRE) as ProtTankSummary),
  ...patch,
});

const CONTRIBUTOR_WIRE = {
  user_id: "01USER",
  amount: 600,
  hidden: false,
  deleted: false,
  you: false,
};

const PLEDGE_WIRE = {
  id: "01PLEDGE",
  goal_id: "01GOAL",
  amount: 400,
  remaining: 400,
  state: "Held",
  created_at: NOW - DAY,
};

const GOAL_WIRE = {
  id: "01GOAL",
  kind: "Launch",
  server_id: "01SERVER",
  slots: 10,
  days: 30,
  daily_cost: 40,
  target_prot: 1200,
  pledged_total: 400,
  state: "Funding",
  deadline_at: NOW + 10 * DAY,
  withdraw_until: NOW + 10 * DAY - 48 * HOUR,
  contributors: [CONTRIBUTOR_WIRE],
  your_pledges: [PLEDGE_WIRE],
  notice: PROT_SEAT_NOTICE_EN,
};

const goal = (patch: Partial<ProtGoalView> = {}): ProtGoalView => ({
  ...(parseProtGoalView(GOAL_WIRE) as ProtGoalView),
  ...patch,
});

const TANK_VIEW_WIRE = {
  tank: SUMMARY_WIRE,
  contributors: [CONTRIBUTOR_WIRE],
  goals: [{ ...GOAL_WIRE, kind: "Upgrade", slots: 25, days: undefined }],
  you_contributed: 600,
  can_contribute: true,
  is_owner: false,
  seats_used: 4,
  notice: PROT_SEAT_NOTICE_EN,
};

// ---------------------------------------------------------------------------
// A fake API: records every request and answers from a script
// ---------------------------------------------------------------------------

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

function reply(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

function badJson(): FakeResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
}

type Call = { url: string; init?: RequestInit };

function fakeApi(answer: (call: Call) => FakeResponse) {
  const calls: Call[] = [];
  const api: CipherApi = {
    apiBase: "https://api.test",
    headers: () => ({
      "X-Session-Token": "token",
      "Content-Type": "application/json",
    }),
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return answer(call) as unknown as Response;
    },
  };
  return { api, calls };
}

function bodyOf(call: Call): unknown {
  return typeof call.init?.body === "string"
    ? JSON.parse(call.init.body)
    : undefined;
}

// ---------------------------------------------------------------------------

describe("the seat notice is verbatim", () => {
  it("is the server's PROT_SEAT_NOTICE byte for byte", () => {
    const expected =
      "Contributing supports this server. It does not reserve a seat; the owner chooses members.";
    assert.equal(PROT_SEAT_NOTICE_EN, expected);
    const bytes = new TextEncoder().encode(PROT_SEAT_NOTICE_EN);
    assert.deepEqual(bytes, new TextEncoder().encode(expected));
    assert.equal(PROT_SEAT_NOTICE_EN.length, 89);
    assert.equal(bytes.length, 89);
    assert.match(PROT_SEAT_NOTICE_EN, /^[\x20-\x7e]+$/);
  });

  it("is the pinned pt-BR text, precomposed", () => {
    const expected =
      "Contribuir ajuda este servidor. Não reserva uma vaga; o dono escolhe os membros.";
    assert.equal(PROT_SEAT_NOTICE_PT_BR, expected);
    assert.equal(
      PROT_SEAT_NOTICE_PT_BR,
      PROT_SEAT_NOTICE_PT_BR.normalize("NFC"),
    );
    assert.equal(PROT_SEAT_NOTICE_PT_BR.length, 80);
    assert.equal(new TextEncoder().encode(PROT_SEAT_NOTICE_PT_BR).length, 81);
    // U+00E3 (precomposed a-tilde) is the only character outside ASCII
    assert.equal(PROT_SEAT_NOTICE_PT_BR.codePointAt(33), 0xe3);
    assert.equal(
      PROT_SEAT_NOTICE_PT_BR.replace(/[\x20-\x7e]/g, ""),
      String.fromCodePoint(0xe3),
    );
  });

  it("stands in for a notice the server left out", () => {
    const { notice, ...rest } = GOAL_WIRE;
    assert.equal(notice, PROT_SEAT_NOTICE_EN);
    assert.equal(parseProtGoalView(rest)?.notice, PROT_SEAT_NOTICE_EN);
    assert.equal(
      parseProtTankView({ ...TANK_VIEW_WIRE, notice: 5 })?.notice,
      PROT_SEAT_NOTICE_EN,
    );
  });
});

// ---------------------------------------------------------------------------
// The catalogs (`components/i18n/catalogs/<locale>/messages.po`), read as
// gettext: comments, msgctxt, msgid, msgstr, continuation lines, C escapes
// ---------------------------------------------------------------------------

type PoEntry = { context?: string; id: string; str: string; fuzzy: boolean };

type PoCatalog = {
  file: string;
  entries: Map<string, PoEntry>;
  /** Keys that appear more than once (gettext would take one at random) */
  duplicates: string[];
};

/** The lookup key of an entry: its msgctxt (or none) and its msgid */
function poKey(context: string | undefined, id: string): string {
  return JSON.stringify([context ?? null, id]);
}

/** One quoted .po string, unescaped; anything else is an error */
function poString(text: string, where: string): string {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(text.trim());
  if (!match) throw new Error(`${where}: not a quoted .po string: ${text}`);
  return match[1].replace(/\\(.)/g, (_, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        throw new Error(`${where}: unsupported escape \\${escaped}`);
    }
  });
}

/** A keyword line: msgctxt, msgid, msgid_plural, msgstr or msgstr[n] */
const PO_KEYWORD =
  /^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(".*")$/;

/**
 * Parse a .po file. An entry's msgstr is its `msgstr` (`msgstr[0]` for a
 * plural); obsolete `#~` entries are comments; a `#, fuzzy` flag is kept so
 * a test can refuse it. A line this parser does not understand throws.
 */
function parsePo(text: string, file: string): PoCatalog {
  const entries = new Map<string, PoEntry>();
  const duplicates: string[] = [];
  let context: string | undefined;
  let id: string | undefined;
  let str: string | undefined;
  let fuzzy = false;
  let field: "context" | "id" | "str" | "ignored" | undefined;

  function flush() {
    if (id !== undefined) {
      const key = poKey(context, id);
      if (entries.has(key)) duplicates.push(key);
      entries.set(key, {
        ...(context === undefined ? {} : { context }),
        id,
        str: str ?? "",
        fuzzy,
      });
    }
    context = id = str = field = undefined;
    fuzzy = false;
  }

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const where = `${file}:${index + 1}`;
    const line = lines[index].trim();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("#")) {
      if (str !== undefined) flush();
      if (line.startsWith("#,") && /\bfuzzy\b/.test(line)) fuzzy = true;
      continue;
    }
    const keyword = PO_KEYWORD.exec(line);
    if (keyword) {
      const [, name, plural, quoted] = keyword;
      const value = poString(quoted, where);
      if (name === "msgctxt") {
        if (id !== undefined) flush();
        context = value;
        field = "context";
      } else if (name === "msgid") {
        if (id !== undefined) flush();
        id = value;
        field = "id";
      } else if (name === "msgid_plural") {
        field = "ignored";
      } else {
        if (id === undefined) throw new Error(`${where}: msgstr before msgid`);
        if (plural === undefined || plural === "0") {
          str = value;
          field = "str";
        } else {
          field = "ignored";
        }
      }
      continue;
    }
    if (line.startsWith('"')) {
      const value = poString(line, where);
      switch (field) {
        case "context":
          context = (context ?? "") + value;
          break;
        case "id":
          id = (id ?? "") + value;
          break;
        case "str":
          str = (str ?? "") + value;
          break;
        case "ignored":
          break;
        case undefined:
          throw new Error(`${where}: continuation outside an entry`);
      }
      continue;
    }
    throw new Error(`${where}: not a .po line: ${line}`);
  }
  flush();
  return { file, entries, duplicates };
}

/** The one, non-fuzzy entry for `id` (in `context`); fails the test else */
function entryOf(catalog: PoCatalog, id: string, context?: string): PoEntry {
  const key = poKey(context, id);
  assert.ok(
    !catalog.duplicates.includes(key),
    `${catalog.file}: ${key} appears more than once`,
  );
  const entry = catalog.entries.get(key);
  assert.ok(entry, `${catalog.file}: no entry for ${key}`);
  assert.equal(entry.fuzzy, false, `${catalog.file}: ${key} is fuzzy`);
  return entry;
}

const here = dirname(fileURLToPath(import.meta.url));

/** The catalogs, or the copy a control points `PROT_CATALOG_DIR` at */
const CATALOG_DIR = resolve(
  process.env.PROT_CATALOG_DIR || join(here, "../i18n/catalogs"),
);

/** The locales the Prot copy is pinned in (contracts 16.4) */
const PROT_LOCALES = ["en", "es", "es-419", "pt-BR", "pt-PT"];

function readCatalog(locale: string): PoCatalog {
  const file = join(CATALOG_DIR, locale, "messages.po");
  return parsePo(readFileSync(file, "utf8"), file);
}

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("parsePo reads gettext the way lingui writes it", () => {
  const FIXTURE = String.raw`msgid ""
msgstr ""
"Language: pt-BR\n"

#. js-lingui-explicit-id
#: components/one.tsx
msgid "Plain"
msgstr "Simples"

#: components/modal/modals/ProtectedTank.tsx
msgctxt "Prot contributor"
msgid "Anonymous"
msgstr "Anonimo (ctx)"

msgid "Anonymous"
msgstr "Anonimo"

msgid ""
"Split "
"over lines"
msgstr ""
"Dividido "
"em linhas"

msgid "Quote \" backslash \\ newline \n tab \t end"
msgstr "Aspas \" barra \\ quebra \n tab \t fim"

#, fuzzy
msgid "Fuzzy"
msgstr "Difuso"

msgid "One"
msgid_plural "Many"
msgstr[0] "Um"
msgstr[1] "Muitos"

#~ msgid "Obsolete"
#~ msgstr "Obsoleto"

msgid "Empty"
msgstr ""
msgid "No blank line before"
msgstr "Sem linha em branco"
`;

  const str = (catalog: PoCatalog, id: string, context?: string) =>
    catalog.entries.get(poKey(context, id))?.str;

  it("reads plain, context, continued, escaped, plural and empty entries", () => {
    const catalog = parsePo(FIXTURE, "fixture.po");
    assert.equal(str(catalog, ""), "Language: pt-BR\n");
    assert.equal(str(catalog, "Plain"), "Simples");
    assert.equal(
      str(catalog, "Anonymous", "Prot contributor"),
      "Anonimo (ctx)",
    );
    assert.equal(str(catalog, "Anonymous"), "Anonimo");
    assert.equal(str(catalog, "Split over lines"), "Dividido em linhas");
    assert.equal(
      str(catalog, 'Quote " backslash \\ newline \n tab \t end'),
      'Aspas " barra \\ quebra \n tab \t fim',
    );
    assert.equal(str(catalog, "One"), "Um");
    assert.equal(str(catalog, "Empty"), "");
    assert.equal(str(catalog, "No blank line before"), "Sem linha em branco");
    assert.equal(catalog.entries.has(poKey(undefined, "Obsolete")), false);
    assert.equal(catalog.entries.get(poKey(undefined, "Fuzzy"))?.fuzzy, true);
    assert.equal(catalog.entries.get(poKey(undefined, "Plain"))?.fuzzy, false);
    assert.deepEqual(catalog.duplicates, []);
  });

  it("reads CRLF line ends and a byte order mark the same way", () => {
    const crlf = String.fromCharCode(0xfeff) + FIXTURE.replace(/\n/g, "\r\n");
    const a = parsePo(FIXTURE, "a.po");
    const b = parsePo(crlf, "b.po");
    assert.deepEqual([...b.entries], [...a.entries]);
  });

  it("reports a repeated entry, and entryOf refuses it", () => {
    const catalog = parsePo(
      'msgid "A"\nmsgstr "1"\n\nmsgid "A"\nmsgstr "2"\n',
      "dup.po",
    );
    assert.deepEqual(catalog.duplicates, [poKey(undefined, "A")]);
    assert.throws(() => entryOf(catalog, "A"), /appears more than once/);
    assert.throws(() => entryOf(catalog, "B"), /no entry/);
    const fuzzy = parsePo('#, fuzzy\nmsgid "A"\nmsgstr "1"\n', "f.po");
    assert.throws(() => entryOf(fuzzy, "A"), /is fuzzy/);
  });

  it("throws on anything it does not understand", () => {
    for (const bad of [
      'msgid "A"\nmsgstr "\\q"\n',
      'msgid "A"\nmsgstr "open\n',
      'msgstr "no msgid"\n',
      '"stray continuation"\n',
      'msgid "A"\nmsgstr "1"\nnonsense\n',
    ]) {
      assert.throws(() => parsePo(bad, "bad.po"), Error, bad);
    }
  });
});

describe("the catalogs hold the pinned Prot copy", () => {
  it("pt-BR translates the seat notice to PROT_SEAT_NOTICE_PT_BR byte for byte", () => {
    const entry = entryOf(readCatalog("pt-BR"), PROT_SEAT_NOTICE_EN);
    assert.equal(entry.context, undefined);
    assert.equal(entry.str, PROT_SEAT_NOTICE_PT_BR);
    assert.deepEqual(utf8(entry.str), utf8(PROT_SEAT_NOTICE_PT_BR));
  });

  it("pt-BR labels Prot contributors Anônimo and Usuário excluído", () => {
    // Spelled by code point, so the check does not depend on how this file
    // itself encodes the accents
    const ANONIMO = [0x41, 0x6e, 0xf4, 0x6e, 0x69, 0x6d, 0x6f];
    const USUARIO_EXCLUIDO = [
      0x55, 0x73, 0x75, 0xe1, 0x72, 0x69, 0x6f, 0x20, 0x65, 0x78, 0x63, 0x6c,
      0x75, 0xed, 0x64, 0x6f,
    ];
    const anonymous = String.fromCodePoint(...ANONIMO);
    const deleted = String.fromCodePoint(...USUARIO_EXCLUIDO);
    assert.equal(anonymous, "Anônimo");
    assert.equal(deleted, "Usuário excluído");

    const catalog = readCatalog("pt-BR");
    const anonymousEntry = entryOf(catalog, "Anonymous", "Prot contributor");
    const deletedEntry = entryOf(catalog, "Deleted user", "Prot contributor");
    assert.deepEqual(utf8(anonymousEntry.str), utf8(anonymous));
    assert.deepEqual(utf8(deletedEntry.str), utf8(deleted));
  });

  it("every Prot locale has a non-empty seat notice translation", () => {
    for (const locale of PROT_LOCALES) {
      const entry = entryOf(readCatalog(locale), PROT_SEAT_NOTICE_EN);
      assert.notEqual(entry.str.trim(), "", `${locale}: empty notice`);
      if (locale === "en") {
        assert.equal(entry.str, PROT_SEAT_NOTICE_EN, "en notice");
      } else {
        // A copied English string is not a translation
        assert.notEqual(entry.str, PROT_SEAT_NOTICE_EN, `${locale}: English`);
      }
    }
  });
});

describe("constants mirror the server", () => {
  it("lists every stage, state, kind and tier in the server's order", () => {
    assert.deepEqual(PROT_TANK_STAGES, [
      "Launching",
      "Active",
      "Grace",
      "Frozen",
      "Settling",
      "Deleted",
      "Terminated",
    ]);
    assert.deepEqual(PROT_GOAL_STATES, [
      "Funding",
      "Funded",
      "Launching",
      "Launched",
      "Applied",
      "Expired",
      "Cancelled",
    ]);
    assert.deepEqual(PROT_GOAL_KINDS, ["Launch", "Upgrade"]);
    assert.deepEqual(PROT_PLEDGE_STATES, [
      "Held",
      "Captured",
      "Returned",
      "Withdrawn",
      "Forfeited",
      "ClawedBack",
    ]);
    assert.deepEqual(PROT_SLOT_TIERS, [10, 25, 50, 100]);
    assert.equal(PROT_MAX_AMOUNT, 1_000_000);
  });
});

describe("parseProtTankSummary fails closed", () => {
  it("reads a full summary and keeps only the options that are present", () => {
    assert.deepEqual(parseProtTankSummary(SUMMARY_WIRE), SUMMARY_WIRE);
    const grace = parseProtTankSummary({
      ...SUMMARY_WIRE,
      stage: "Grace",
      balance: -80,
      protected_until: undefined,
      grace_ends_at: NOW + 2 * DAY,
      deletes_at: NOW + 27 * DAY,
      pending_slot_tier: 25,
    });
    assert.equal(grace?.balance, -80);
    assert.equal(grace?.grace_ends_at, NOW + 2 * DAY);
    assert.equal(grace?.deletes_at, NOW + 27 * DAY);
    assert.equal(grace?.pending_slot_tier, 25);
    assert.equal(grace !== null && "protected_until" in grace, false);
  });

  it("is null for every stage it does not know", () => {
    for (const stage of [
      "Paused",
      "active",
      "",
      undefined,
      null,
      3,
      ["Active"],
    ]) {
      assert.equal(parseProtTankSummary({ ...SUMMARY_WIRE, stage }), null);
    }
  });

  it("is null when an id, balance, cost, tier or version is unreadable", () => {
    const broken: Record<string, unknown>[] = [
      { tank_id: "" },
      { tank_id: 7 },
      { channel_id: undefined },
      { slot_tier: 0 },
      { slot_tier: 10.5 },
      { daily_cost: -40 },
      { daily_cost: "40" },
      { balance: 1.5 },
      { balance: Number.NaN },
      { balance: undefined },
      { version: -1 },
      { balance_version: undefined },
    ];
    for (const patch of broken) {
      assert.equal(
        parseProtTankSummary({ ...SUMMARY_WIRE, ...patch }),
        null,
        JSON.stringify(patch),
      );
    }
    for (const value of [undefined, null, "tank", 5, [SUMMARY_WIRE]]) {
      assert.equal(parseProtTankSummary(value), null);
    }
  });

  it("leaves out an unreadable date or pending tier (no date promised)", () => {
    const parsed = parseProtTankSummary({
      ...SUMMARY_WIRE,
      stage: "Frozen",
      protected_until: "soon",
      deletes_at: Number.POSITIVE_INFINITY,
      pending_slot_tier: 0,
    });
    assert.ok(parsed);
    assert.equal("protected_until" in parsed, false);
    assert.equal("deletes_at" in parsed, false);
    assert.equal("pending_slot_tier" in parsed, false);
  });
});

describe("contributor lines never reveal a hidden or deleted user", () => {
  it("keeps the id of a visible line only", () => {
    assert.deepEqual(
      parseProtContributorView(CONTRIBUTOR_WIRE),
      CONTRIBUTOR_WIRE,
    );
    const hidden = parseProtContributorView({
      ...CONTRIBUTOR_WIRE,
      hidden: true,
      you: true,
    });
    assert.deepEqual(hidden, {
      amount: 600,
      hidden: true,
      deleted: false,
      you: true,
    });
    const deleted = parseProtContributorView({
      ...CONTRIBUTOR_WIRE,
      deleted: true,
    });
    assert.equal(deleted !== null && "user_id" in deleted, false);
  });

  it("drops a line without a positive whole amount", () => {
    for (const amount of [0, -5, 1.5, "600", undefined]) {
      assert.equal(
        parseProtContributorView({ ...CONTRIBUTOR_WIRE, amount }),
        null,
      );
    }
  });

  it("labels deleted, then anonymous, then the user", () => {
    const line = (
      patch: Partial<ProtContributorView>,
    ): ProtContributorView => ({
      amount: 100,
      hidden: false,
      deleted: false,
      you: false,
      ...patch,
    });
    assert.deepEqual(contributorLabel(line({ user_id: "01USER" })), {
      kind: "user",
      userId: "01USER",
    });
    assert.deepEqual(contributorLabel(line({ hidden: true })), {
      kind: "anonymous",
    });
    assert.deepEqual(
      contributorLabel(line({ hidden: true, user_id: "01USER" })),
      { kind: "anonymous" },
    );
    assert.deepEqual(contributorLabel(line({})), { kind: "anonymous" });
    assert.deepEqual(contributorLabel(line({ deleted: true })), {
      kind: "deleted",
    });
    assert.deepEqual(
      contributorLabel(line({ deleted: true, hidden: true, user_id: "01X" })),
      { kind: "deleted" },
    );
  });
});

describe("parseProtGoalView and parseProtPledgeView fail closed", () => {
  it("reads a full goal", () => {
    const parsed = parseProtGoalView({
      ...GOAL_WIRE,
      channel_id: "01CHANNEL",
      tank_id: "01TANK",
      funded_at: NOW,
      launch_deadline_at: NOW + 7 * DAY,
      launched_at: NOW + DAY,
    });
    assert.ok(parsed);
    assert.equal(parsed.kind, "Launch");
    assert.equal(parsed.days, 30);
    assert.equal(parsed.channel_id, "01CHANNEL");
    assert.equal(parsed.tank_id, "01TANK");
    assert.equal(parsed.launch_deadline_at, NOW + 7 * DAY);
    assert.deepEqual(parsed.contributors, [CONTRIBUTOR_WIRE]);
    assert.deepEqual(parsed.your_pledges, [PLEDGE_WIRE]);
  });

  it("is null for an unknown kind or state", () => {
    for (const kind of ["Server", "launch", undefined]) {
      assert.equal(parseProtGoalView({ ...GOAL_WIRE, kind }), null);
    }
    for (const state of ["Open", "funding", "", undefined, 1]) {
      assert.equal(parseProtGoalView({ ...GOAL_WIRE, state }), null);
    }
  });

  it("is null without its amounts, deadline or withdraw cutoff", () => {
    for (const patch of [
      { id: "" },
      { server_id: undefined },
      { slots: 0 },
      { target_prot: -1 },
      { pledged_total: "400" },
      { deadline_at: undefined },
      { withdraw_until: Number.NaN },
    ] as Record<string, unknown>[]) {
      assert.equal(
        parseProtGoalView({ ...GOAL_WIRE, ...patch }),
        null,
        JSON.stringify(patch),
      );
    }
  });

  it("drops a contributor line or pledge it cannot read", () => {
    const parsed = parseProtGoalView({
      ...GOAL_WIRE,
      contributors: [
        CONTRIBUTOR_WIRE,
        { amount: 0 },
        "x",
        { ...CONTRIBUTOR_WIRE, hidden: true },
      ],
      your_pledges: [PLEDGE_WIRE, { ...PLEDGE_WIRE, state: "Pending" }],
    });
    assert.ok(parsed);
    assert.equal(parsed.contributors.length, 2);
    assert.equal("user_id" in parsed.contributors[1], false);
    assert.deepEqual(parsed.your_pledges, [PLEDGE_WIRE]);
    assert.deepEqual(
      parseProtGoalView({ ...GOAL_WIRE, contributors: "all" })?.contributors,
      [],
    );
  });

  it("reads a pledge and refuses an unknown state", () => {
    assert.deepEqual(parseProtPledgeView(PLEDGE_WIRE), PLEDGE_WIRE);
    for (const state of [...PROT_PLEDGE_STATES]) {
      assert.equal(
        parseProtPledgeView({ ...PLEDGE_WIRE, state })?.state,
        state,
      );
    }
    for (const state of ["held", "Pending", undefined]) {
      assert.equal(parseProtPledgeView({ ...PLEDGE_WIRE, state }), null);
    }
    assert.equal(parseProtPledgeView({ ...PLEDGE_WIRE, remaining: -1 }), null);
  });
});

describe("parseProtTankView fails closed", () => {
  it("reads a full view", () => {
    const view = parseProtTankView(TANK_VIEW_WIRE);
    assert.ok(view);
    assert.deepEqual(view.tank, SUMMARY_WIRE);
    assert.equal(view.goals.length, 1);
    assert.equal(view.goals[0].kind, "Upgrade");
    assert.equal(view.you_contributed, 600);
    assert.equal(view.can_contribute, true);
    assert.equal(view.is_owner, false);
    assert.equal(view.seats_used, 4);
  });

  it("is null when its tank is unreadable or in an unknown stage", () => {
    assert.equal(
      parseProtTankView({
        ...TANK_VIEW_WIRE,
        tank: { ...SUMMARY_WIRE, stage: "Paused" },
      }),
      null,
    );
    assert.equal(
      parseProtTankView({ ...TANK_VIEW_WIRE, tank: undefined }),
      null,
    );
    assert.equal(parseProtTankView(undefined), null);
  });

  it("offers nothing on unreadable flags and drops unreadable goals", () => {
    const view = parseProtTankView({
      ...TANK_VIEW_WIRE,
      can_contribute: "yes",
      is_owner: 1,
      you_contributed: -3,
      seats_used: undefined,
      goals: [{ ...GOAL_WIRE, state: "Open" }],
    });
    assert.ok(view);
    assert.equal(view.can_contribute, false);
    assert.equal(view.is_owner, false);
    assert.equal(view.you_contributed, 0);
    assert.equal(view.seats_used, 0);
    assert.deepEqual(view.goals, []);
  });
});

describe("parseProtTankFeature fails closed", () => {
  it("reads the advert", () => {
    assert.deepEqual(parseProtTankFeature(TANK_ADVERT), TANK_ADVERT);
  });

  it("is no costs, zeros and no deletion when absent or unreadable", () => {
    const closed = {
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
    for (const value of [undefined, null, "tank", [TANK_ADVERT]]) {
      assert.deepEqual(parseProtTankFeature(value), closed);
    }
  });

  it("keeps the four tiers with a positive cost, deletion only when true", () => {
    const parsed = parseProtTankFeature({
      ...TANK_ADVERT,
      channel_daily_cost: { "10": 40, "25": 0, "50": "160", "75": 120 },
      min_launch_goal_days: 400,
      deletion_enabled: "true",
    });
    assert.deepEqual(parsed.channel_daily_cost, { "10": 40 });
    // min above max: no launch goal can be priced
    assert.equal(parsed.min_launch_goal_days, 0);
    assert.equal(parsed.max_launch_goal_days, 0);
    assert.equal(parsed.deletion_enabled, false);
  });
});

describe("tankBannerKind", () => {
  it("names the banner of every stage", () => {
    const expected: Record<string, string | null> = {
      Launching: null,
      Active: null,
      Grace: "grace",
      Frozen: "frozen",
      Settling: "frozen",
      Deleted: "deleted",
      Terminated: "deleted",
    };
    for (const stage of PROT_TANK_STAGES) {
      assert.equal(
        tankBannerKind(summary({ stage }), NOW),
        expected[stage],
        stage,
      );
    }
    assert.equal(tankBannerKind(null, NOW), null);
    assert.equal(tankBannerKind(undefined, NOW), null);
  });

  it("shows the low banner from PROT_LOW_DAYS whole days left", () => {
    assert.equal(PROT_LOW_DAYS, 7);
    const until = (ms: number) => summary({ protected_until: ms });
    assert.equal(tankBannerKind(until(NOW + 8 * DAY), NOW), null);
    assert.equal(tankBannerKind(until(NOW + 8 * DAY - 1), NOW), "low");
    assert.equal(tankBannerKind(until(NOW + 3 * DAY), NOW), "low");
    // a summary read earlier still counts down
    assert.equal(tankBannerKind(until(NOW + 10 * DAY), NOW + 3 * DAY), "low");
    // an overdue date is 0 days left, not a negative count
    assert.equal(tankDaysLeft(until(NOW - DAY), NOW), 0);
    assert.equal(tankBannerKind(until(NOW - DAY), NOW), "low");
  });

  it("counts days from the tank, never from a fixed number", () => {
    assert.equal(tankDaysLeft(summary(), NOW), 30);
    const halfDay = summary({ protected_until: NOW + 7.5 * DAY });
    assert.equal(tankDaysLeft(halfDay, NOW), 7);
    // without a date: whole days of balance
    const noDate = summary({ protected_until: undefined, balance: 250 });
    assert.equal(tankDaysLeft(noDate, NOW), 6);
    assert.equal(tankBannerKind(noDate, NOW), "low");
    assert.equal(
      tankDaysLeft(summary({ protected_until: undefined, daily_cost: 0 }), NOW),
      null,
    );
    assert.equal(tankDaysLeft(summary({ stage: "Grace" }), NOW), null);
    assert.equal(tankDaysLeft(summary(), Number.NaN), null);
  });
});

describe("price previews match the server", () => {
  it("prices a launch goal as days times the tier's daily cost", () => {
    const advert = TANK_ADVERT as ProtTankFeature;
    assert.equal(launchGoalPrice(advert, 10, 30), 1200);
    assert.equal(launchGoalPrice(advert, 25, 30), 2700);
    assert.equal(launchGoalPrice(advert, 100, 365), 102200);
    // the whole features.prot advert works too
    assert.equal(
      launchGoalPrice({ enabled: true, tank: TANK_ADVERT } as never, 10, 30),
      1200,
    );
  });

  it("is null where the server would refuse the goal", () => {
    const advert = TANK_ADVERT as ProtTankFeature;
    assert.equal(launchGoalPrice(advert, 20, 30), null);
    assert.equal(launchGoalPrice(advert, 10, 29), null);
    assert.equal(launchGoalPrice(advert, 10, 366), null);
    assert.equal(launchGoalPrice(advert, 10, 30.5), null);
    assert.equal(launchGoalPrice(undefined, 10, 30), null);
    assert.equal(launchGoalPrice({ enabled: true } as never, 10, 30), null);
    const noCosts = parseProtTankFeature({
      ...TANK_ADVERT,
      channel_daily_cost: {},
    });
    assert.equal(launchGoalPrice(noCosts, 10, 30), null);
  });

  it("reads a tier's cost from the advert only", () => {
    assert.equal(tierDailyCost(TANK_ADVERT as ProtTankFeature, 50), 160);
    assert.equal(tierDailyCost(TANK_ADVERT as ProtTankFeature, 75), null);
    assert.equal(tierDailyCost(undefined, 10), null);
  });

  it("prices an upgrade goal as (new - old) x whole days left", () => {
    assert.equal(upgradeGoalPrice(40, 90, 1200), 1500);
    assert.equal(upgradeGoalPrice(40, 90, 1239), 1500);
    assert.equal(upgradeGoalPrice(40, 90, 1240), 1550);
    assert.equal(upgradeGoalPrice(40, 90, 39), 0);
  });

  it("is 0 when there is nothing to price, as on the server", () => {
    assert.equal(upgradeGoalPrice(0, 90, 1200), 0);
    assert.equal(upgradeGoalPrice(90, 90, 1200), 0);
    assert.equal(upgradeGoalPrice(90, 40, 1200), 0);
    assert.equal(upgradeGoalPrice(40, 90, 0), 0);
    assert.equal(upgradeGoalPrice(40, 90, -80), 0);
    assert.equal(upgradeGoalPrice(40, 90, Number.NaN), 0);
  });
});

describe("withdrawOpen", () => {
  it("is open while Funding up to and including withdraw_until", () => {
    const g = goal();
    assert.equal(withdrawOpen(g, NOW), true);
    assert.equal(withdrawOpen(g, g.withdraw_until), true);
    assert.equal(withdrawOpen(g, g.withdraw_until + 1), false);
  });

  it("is closed in every other state", () => {
    for (const state of PROT_GOAL_STATES) {
      if (state === "Funding") continue;
      assert.equal(withdrawOpen(goal({ state }), NOW), false, state);
    }
    assert.equal(withdrawOpen(goal(), Number.NaN), false);
  });
});

describe("contributionAmountProblem", () => {
  it("allows the minimum to PROT_MAX_AMOUNT", () => {
    assert.equal(contributionAmountProblem(50, 50), undefined);
    assert.equal(contributionAmountProblem(PROT_MAX_AMOUNT, 50), undefined);
    assert.equal(contributionAmountProblem(49, 50), "belowMin");
    assert.equal(
      contributionAmountProblem(PROT_MAX_AMOUNT + 1, 50),
      "aboveMax",
    );
    for (const amount of [0, -1, 1.5, Number.NaN]) {
      assert.equal(contributionAmountProblem(amount, 50), "notInteger");
    }
  });

  it("allows a pledge below the minimum only if it completes the goal", () => {
    assert.equal(contributionAmountProblem(30, 50, 30), undefined);
    assert.equal(contributionAmountProblem(40, 50, 30), undefined);
    assert.equal(contributionAmountProblem(20, 50, 30), "belowMin");
    assert.equal(contributionAmountProblem(49, 50, 800), "belowMin");
    assert.equal(contributionAmountProblem(500, 50, 800), undefined);
  });

  it("refuses everything without a usable minimum (contribute hidden)", () => {
    assert.equal(contributionAmountProblem(500, 0), "noMinimum");
    assert.equal(contributionAmountProblem(500, Number.NaN), "noMinimum");
  });
});

describe("requests", () => {
  it("reads a tank, and NotFound means no tank", async () => {
    const ok = fakeApi(() => reply(200, TANK_VIEW_WIRE));
    const view = await fetchProtTank(ok.api, "01CHANNEL");
    assert.equal(view?.tank.tank_id, "01TANK");
    assert.equal(
      ok.calls[0].url,
      "https://api.test/prot/channels/01CHANNEL/tank",
    );
    assert.equal(ok.calls[0].init?.method, "GET");
    assert.equal(ok.calls[0].init?.body, undefined);
    assert.deepEqual(ok.calls[0].init?.headers, {
      "X-Session-Token": "token",
      "Content-Type": "application/json",
    });

    const missing = fakeApi(() => reply(404, { type: "NotFound" }));
    assert.equal(await fetchProtTank(missing.api, "01CHANNEL"), null);
  });

  it("never reads a failure or an unreadable body as no tank", async () => {
    const proxy = fakeApi(() => reply(404, undefined));
    await assert.rejects(fetchProtTank(proxy.api, "01CHANNEL"), Error);

    const other = fakeApi(() => reply(500, { type: "InternalError" }));
    await assert.rejects(fetchProtTank(other.api, "01CHANNEL"), {
      type: "InternalError",
    });

    const limited = fakeApi(() => reply(429, { retry_after: 2500 }));
    await assert.rejects(
      fetchProtTank(limited.api, "01CHANNEL"),
      (error: unknown) =>
        error instanceof CipherClientError &&
        error.kind === "rateLimited" &&
        error.retryAfterMs === 2500,
    );

    for (const body of [
      { ...TANK_VIEW_WIRE, tank: { ...SUMMARY_WIRE, stage: "Paused" } },
      {},
      [],
    ]) {
      const bad = fakeApi(() => reply(200, body));
      await assert.rejects(
        fetchProtTank(bad.api, "01CHANNEL"),
        (error: unknown) =>
          error instanceof CipherClientError && error.kind === "badResponse",
      );
    }
    const garbled = fakeApi(() => badJson());
    await assert.rejects(
      fetchProtTank(garbled.api, "01CHANNEL"),
      (error: unknown) =>
        error instanceof CipherClientError && error.kind === "badResponse",
    );
  });

  it("escapes ids into the path and refuses dot ids", async () => {
    const { api, calls } = fakeApi(() => reply(200, GOAL_WIRE));
    await fetchGoal(api, "../admin?x=1#y");
    assert.equal(
      calls[0].url,
      "https://api.test/prot/goals/..%2Fadmin%3Fx%3D1%23y",
    );
    for (const id of ["", ".", ".."]) {
      await assert.rejects(fetchGoal(api, id), /Not a Prot route id/);
      await assert.rejects(
        deletePledge(api, "01GOAL", id),
        /Not a Prot route id/,
      );
    }
    assert.equal(calls.length, 1);
  });

  it("contributes with only the amount and the nonce", async () => {
    const response = {
      entry_id: "01ENTRY",
      tank: SUMMARY_WIRE,
      balance: 300,
      already_applied: false,
      notice: PROT_SEAT_NOTICE_EN,
    };
    const { api, calls } = fakeApi(() => reply(200, response));
    const result = await postContribute(api, "01CHANNEL", {
      amount: 500,
      nonce: "01NONCE",
      extra: true,
    } as never);
    assert.deepEqual(result, response);
    assert.equal(
      calls[0].url,
      "https://api.test/prot/channels/01CHANNEL/contribute",
    );
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(bodyOf(calls[0]), { amount: 500, nonce: "01NONCE" });
  });

  it("pledges and withdraws", async () => {
    const pledged = {
      pledge: PLEDGE_WIRE,
      goal: GOAL_WIRE,
      balance: 100,
      already_applied: true,
      notice: PROT_SEAT_NOTICE_EN,
    };
    const pledge = fakeApi(() => reply(200, pledged));
    const result = await postPledge(pledge.api, "01GOAL", {
      amount: 400,
      nonce: "01NONCE",
    });
    assert.equal(result.already_applied, true);
    assert.equal(result.pledge.id, "01PLEDGE");
    assert.equal(
      pledge.calls[0].url,
      "https://api.test/prot/goals/01GOAL/pledges",
    );
    assert.equal(pledge.calls[0].init?.method, "POST");
    assert.deepEqual(bodyOf(pledge.calls[0]), {
      amount: 400,
      nonce: "01NONCE",
    });

    const withdraw = fakeApi(() =>
      reply(200, { ...PLEDGE_WIRE, state: "Withdrawn" }),
    );
    const view = await deletePledge(withdraw.api, "01GOAL", "01PLEDGE");
    assert.equal(view.state, "Withdrawn");
    assert.equal(
      withdraw.calls[0].url,
      "https://api.test/prot/goals/01GOAL/pledges/01PLEDGE",
    );
    assert.equal(withdraw.calls[0].init?.method, "DELETE");
    assert.equal(withdraw.calls[0].init?.body, undefined);
  });

  it("refuses a write response it cannot read", async () => {
    const contribute = fakeApi(() =>
      reply(200, { entry_id: "01E", balance: 1 }),
    );
    await assert.rejects(
      postContribute(contribute.api, "01CHANNEL", { amount: 50, nonce: "n" }),
      (error: unknown) =>
        error instanceof CipherClientError && error.kind === "badResponse",
    );
    assert.equal(
      parseProtPledgeResponse({
        pledge: PLEDGE_WIRE,
        goal: { ...GOAL_WIRE, state: "?" },
        balance: 1,
      }),
      null,
    );
    assert.equal(
      parseProtContributionResponse({
        entry_id: "01E",
        tank: SUMMARY_WIRE,
        balance: -1,
      }),
      null,
    );
  });

  it("sends the owner's goal, tier and launch requests", async () => {
    const cases: {
      run: (api: CipherApi) => Promise<unknown>;
      url: string;
      method: string;
      body: unknown;
      answer: unknown;
    }[] = [
      {
        run: (api) =>
          postLaunchGoal(api, "01SERVER", { slots: 10, days: 30, nonce: "n1" }),
        url: "https://api.test/prot/servers/01SERVER/goals",
        method: "POST",
        body: { slots: 10, days: 30, nonce: "n1" },
        answer: GOAL_WIRE,
      },
      {
        run: (api) =>
          postUpgradeGoal(api, "01CHANNEL", { slots: 25, nonce: "n2" }),
        url: "https://api.test/prot/channels/01CHANNEL/goals",
        method: "POST",
        body: { slots: 25, nonce: "n2" },
        answer: { ...GOAL_WIRE, kind: "Upgrade" },
      },
      {
        run: (api) =>
          postGoalLaunch(api, "01GOAL", { channel_id: "01CHANNEL" }),
        url: "https://api.test/prot/goals/01GOAL/launch",
        method: "POST",
        body: { channel_id: "01CHANNEL" },
        answer: { ...GOAL_WIRE, state: "Launching" },
      },
      {
        run: (api) => postGoalCancel(api, "01GOAL"),
        url: "https://api.test/prot/goals/01GOAL/cancel",
        method: "POST",
        body: undefined,
        answer: { ...GOAL_WIRE, state: "Cancelled" },
      },
      {
        run: (api) => putTier(api, "01CHANNEL", { slots: 50, nonce: "n3" }),
        url: "https://api.test/prot/channels/01CHANNEL/tier",
        method: "PUT",
        body: { slots: 50, nonce: "n3" },
        answer: { ...SUMMARY_WIRE, slot_tier: 50 },
      },
    ];
    for (const c of cases) {
      const { api, calls } = fakeApi(() => reply(200, c.answer));
      const result = await c.run(api);
      assert.ok(result, c.url);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, c.url);
      assert.equal(calls[0].init?.method, c.method, c.url);
      assert.deepEqual(bodyOf(calls[0]), c.body, c.url);
    }
  });

  it("sets hide-name per server", async () => {
    const { api, calls } = fakeApi(() => reply(204, undefined));
    await putContributorPrefs(api, "01SERVER", { hidden: true });
    assert.equal(
      calls[0].url,
      "https://api.test/prot/servers/01SERVER/contributor",
    );
    assert.equal(calls[0].init?.method, "PUT");
    assert.deepEqual(bodyOf(calls[0]), { hidden: true });

    const refused = fakeApi(() => reply(403, { type: "ProtNotEligible" }));
    await assert.rejects(
      putContributorPrefs(refused.api, "01SERVER", { hidden: false }),
      { type: "ProtNotEligible" },
    );
  });

  it("lists a server's goals, dropping any it cannot read", async () => {
    const { api, calls } = fakeApi(() =>
      reply(200, [GOAL_WIRE, { ...GOAL_WIRE, id: "01OTHER", state: "Open" }]),
    );
    const goals = await fetchServerGoals(api, "01SERVER");
    assert.deepEqual(
      goals.map((g) => g.id),
      ["01GOAL"],
    );
    assert.equal(goals[0].kind, "Launch");
    assert.equal(calls[0].url, "https://api.test/prot/servers/01SERVER/goals");
    assert.equal(calls[0].init?.method, "GET");

    const bad = fakeApi(() => reply(200, { goals: [GOAL_WIRE] }));
    await assert.rejects(
      fetchServerGoals(bad.api, "01SERVER"),
      (error: unknown) =>
        error instanceof CipherClientError && error.kind === "badResponse",
    );
  });

  it("reports a goal read failure with the API's error", async () => {
    const { api } = fakeApi(() => reply(404, { type: "NotFound" }));
    await assert.rejects(fetchGoal(api, "01GOAL"), { type: "NotFound" });
  });
});

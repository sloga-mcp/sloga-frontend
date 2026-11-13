// Spec for the Protected channel seat picker modal (W4 lane C12, plan
// product choice 4 and §4.4), run with Node's built-in runner from
// packages/client:
//   node --conditions=browser --test components/modal/modals/protectedSeatPicker.scan.test.ts
//
// ProtectedSeatPicker.tsx imports Solid, lingui and the UI kit, so Node
// cannot load it. Its seat rules sit in one marked region
// (`// protected-pure:begin` .. `// protected-pure:end`) with no imports;
// this spec cuts it out, strips the types with Node's own stripper and runs
// the real source. The wiring is checked by scanning the files.
//
//  P1  the modal type is registered: `types.ts` declares
//      `"protected_seat_picker"` with the pinned props and `modals.tsx` has
//      its switch arm (the `default` arm only logs, so a missing arm never
//      opens) (C-C12a);
//  P2  the owner is never removable: its row never toggles and the list
//      handed to `onConfirm` always starts with it (C-C12b);
//  P3  a null (unknown) cap is never 0 and never blocks; a known cap blocks
//      new seats at the limit, never removals (C-C12c);
//  P4  new seats need a non-bot, non-staff member who can view the channel;
//      current seats stay listed and re-checkable;
//  P5  Confirm needs an owner and a changed list; the full list goes to
//      `onConfirm`, the modal stays open until it settles; P5b genesis
//      (`current` empty) confirms the owner-only list within the cap
//      (C-C12d);
//  P6  eligibility comes from the house permission helper and the user's
//      `bot` / `privileged` facts;
//  P7  errors only through `protectedNoticeForError(…, {op: "owner"})` and
//      `errorUiCopy`, never an error's `message`;
//  P8  copy from C0 (no bare English literals) and blank-page traps;
//  P9  W4d (W2 C1): a `SeatListNamesRemovedUsers` refusal deselects
//      exactly the users it names, keeps them off (unlisted, never in a
//      later list), lets the list without them be confirmed, and never
//      resubmits by itself (C-SET3, picker side);
//  P10 a fresh picker never offers a `removed` user (C-SET4);
//  P11 W4d N3: whenever anyone is left off, Confirm is preceded by a line
//      naming them all (C-N3c).
//
// S2 W4-3 lane U8 (D39 owner seat UI, D40 unseat reason, F2, F3):
//  P7b every mapped error passes its failure to `errorUiCopy` (F2: else
//      the `authority_needs_v2` copy never shows);
//  P12 released seats (`cooling[]`) are listed with their cause, owner
//      only, by name, never by id;
//  P13 the cap clamp: cooling seats count toward the slot cap and a
//      re-seat of a cooling user reuses its slot; removals never block;
//  P14 the "no longer have seats" banner, and "Update the list" only for a
//      removal-only change;
//  P15 "Removal waiting" after 10 minutes with "Finish now" (a refresh),
//      or "Re-create the protected group" on a poisoned group;
//  P16 a device count per seated row; unknown members are not 0;
//  P17 revoked owner devices: `proposedOwnerDevices(snapshot, self)` to
//      `authoritySign`, one button only when there is a proposal;
//  P18 the unseat reason: `validReason(s, "header")` before any send, the
//      sanitized reason sent, server refusals mapped before the notice;
//  P19 "Discard this change" only through `cancelPendingSeats`, disabled
//      when not discardable, every answer worded (unknown = maybe kept);
//  P20 the stored change wins: the rows lock and the modal says so;
//  P21 `publish_not_persisted` has its own copy;
//  P22 (U8b) the pure seat-UI rules come from `protectedSeatUiPolicy.ts`
//      (unit-tested in `components/client/protectedSeatUiPolicy.test.ts`);
//      P12-P21 keep the wiring pins here.
//
// Point `PROTECTED_SEAT_PICKER_FILE`, `PROTECTED_MODAL_TYPES_FILE` or
// `PROTECTED_MODALS_FILE` at another copy (a known-bad control) to check
// that instead; it must fail.
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

const source = read("PROTECTED_SEAT_PICKER_FILE", "ProtectedSeatPicker.tsx");
const typesSource = read("PROTECTED_MODAL_TYPES_FILE", "../types.ts");
const modalsSource = read("PROTECTED_MODALS_FILE", "../modals.tsx");

/**
 * The shared seat-UI policy (U8b): its pure rules have their own unit test
 * (`components/client/protectedSeatUiPolicy.test.ts`); the region below
 * imports `seatUsedCount` from it, which this spec supplies the same way.
 */
const POLICY_URL = new URL(
  "../../client/protectedSeatUiPolicy.ts",
  import.meta.url,
).href;
/** Names the region uses from the shared policy (imported, not defined). */
const REGION_IMPORTS = ["seatUsedCount"] as const;

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

interface Candidate {
  id: string;
  bot: boolean;
  privileged: boolean;
  canView: boolean;
}
type Block = "owner" | "bot" | "staff" | "no_access" | "cap" | null;
interface Rules {
  seatCapOf(v: unknown): number | null;
  seatListed(
    c: Candidate,
    current: ReadonlySet<string>,
    ownerId: string | null,
    dropped?: ReadonlySet<string>,
  ): boolean;
  seatWithout(ids: Iterable<string>, drop: Iterable<string>): string[];
  seatRefusalRemoved(ui: unknown, ownerId: string | null): string[];
  seatDroppedIds(ids: unknown, ownerId: string | null): string[];
  seatLeftOffNames(
    ids: readonly string[],
    names: readonly (string | null | undefined)[],
  ): string;
  seatInitialSelection(
    current: readonly string[],
    ownerId: string | null,
  ): Set<string>;
  seatFinalList(
    current: readonly string[],
    selected: ReadonlySet<string>,
    ownerId: string,
  ): string[];
  seatToggled(selected: ReadonlySet<string>, id: string): Set<string>;
  seatToggleBlock(
    c: Candidate,
    selected: ReadonlySet<string>,
    current: ReadonlySet<string>,
    ownerId: string | null,
    slotCap: number | null,
    cooling?: ReadonlySet<string>,
  ): Block;
  seatCanConfirm(
    current: readonly string[],
    selected: ReadonlySet<string>,
    ownerId: string | null,
    slotCap: number | null,
    cleanup?: boolean,
    cooling?: readonly string[],
  ): boolean;
}
const RULE_NAMES = [
  "seatCapOf",
  "seatListed",
  "seatWithout",
  "seatRefusalRemoved",
  "seatDroppedIds",
  "seatLeftOffNames",
  "seatInitialSelection",
  "seatFinalList",
  "seatToggleBlock",
  "seatToggled",
  "seatCanConfirm",
] as const;

let rulesPromise: Promise<Rules> | null = null;
function loadRules(): Promise<Rules> {
  rulesPromise ??= (async () => {
    const from = source.indexOf(BEGIN);
    const to = source.indexOf(END);
    assert.ok(from !== -1 && to > from, "protected-pure region missing");
    const region = source.slice(from, to);
    assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
    const js =
      `import { ${REGION_IMPORTS.join(", ")} } from ${JSON.stringify(POLICY_URL)};\n` +
      stripTypeScriptTypes(region, { mode: "strip" }) +
      `\nexport { ${RULE_NAMES.join(", ")} };\n`;
    const dir = mkdtempSync(join(tmpdir(), "w4c1-C12-"));
    const out = join(dir, "protectedSeatPickerPure.mjs");
    writeFileSync(out, js);
    const mod = (await import(pathToFileURL(out).href)) as Record<
      string,
      unknown
    >;
    for (const name of RULE_NAMES) {
      assert.equal(typeof mod[name], "function", `${name} missing`);
    }
    return mod as unknown as Rules;
  })();
  return rulesPromise;
}

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(source);
const TYPES = code(typesSource);
const MODALS = code(modalsSource);

/** The component body: from its declaration to the pure region. */
function componentBody(): string {
  const from = source.indexOf("export function ProtectedSeatPickerModal(");
  assert.ok(from !== -1, "ProtectedSeatPickerModal missing");
  const to = source.indexOf(BEGIN, from);
  assert.ok(to > from, "the component must precede the pure region");
  return code(source.slice(from, to));
}

const BODY = componentBody();

/** S2 lane U8's local msgids, as lingui extracts them (L9 inserts them). */
const U8_MSGIDS = [
  "Unknown member",
  "Released seats",
  "Removed from the seat list",
  "Removed from the server",
  "Lost access to this channel",
  "No device joined before the seat was released",
  "Counts toward the seat limit until {until}",
  "People on your signed list who no longer have seats: {count}",
  "Update the list",
  "Removal waiting",
  "Finish now",
  "Trying the removal again…",
  "Devices: {count}",
  "Re-sign signing devices",
  "Reason for the removal",
  "Discard this change",
  "An earlier change to the seats hasn't finished saving. Trying again sends that same change, exactly as it was.",
  "Seats you pick here aren't included. Discard the earlier change to make a different one.",
  "This change can't be discarded now. The server may already have it.",
  "The server may already have this change, so it can't be discarded.",
  "This change couldn't be stored on this device, so it wasn't sent. Try again.",
  "The change was discarded.",
  "There's no change waiting to be discarded.",
  "This change is being sent right now. Try again in a moment.",
] as const;

const OWNER = "owner";
const person = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  bot: false,
  privileged: false,
  canView: true,
  ...over,
});
const set = (...ids: string[]) => new Set(ids);

describe("Protected channel seat picker (lane C12)", () => {
  it("P1 registers the modal type with the pinned props and a switch arm (C-C12a)", () => {
    const at = TYPES.indexOf('type: "protected_seat_picker";');
    assert.ok(at !== -1, 'types.ts lacks type: "protected_seat_picker"');
    const entry = TYPES.slice(at, TYPES.indexOf("}", at));
    for (const field of [
      /\bchannel: Channel;/,
      /\bcurrent: string\[\];/,
      /\bslotCap: number \| null;/,
      /\bonConfirm: \(userIds: string\[\]\) => Promise<void>;/,
      // W4d: optional, so every other opener keeps the pinned contract
      /\bremoved\?: string\[\];/,
    ]) {
      assert.match(entry, field, `pinned prop ${field} changed`);
    }

    assert.match(
      MODALS,
      /import \{ ProtectedSeatPickerModal \} from "\.\/modals\/ProtectedSeatPicker";/,
    );
    const arm = MODALS.indexOf('case "protected_seat_picker":');
    assert.ok(arm !== -1, 'modals.tsx has no case "protected_seat_picker"');
    assert.equal(
      MODALS.indexOf('case "protected_seat_picker":', arm + 1),
      -1,
      "one arm only",
    );
    const def = MODALS.indexOf("default:");
    assert.ok(def > arm, "the arm must sit before the default arm");
    assert.match(
      MODALS.slice(arm, def),
      /^case "protected_seat_picker":\s*return <ProtectedSeatPickerModal \{\.\.\.modalProps\} \/>;/,
    );
  });

  it("P2 never lets the owner be removed (C-C12b)", async () => {
    const r = await loadRules();
    const current = set(OWNER, "a");
    // Checked, unchecked, any cap: the owner row never toggles.
    for (const selected of [set(OWNER, "a"), set("a"), set()]) {
      for (const cap of [null, 0, 1, 5]) {
        assert.equal(
          r.seatToggleBlock(person(OWNER), selected, current, OWNER, cap),
          "owner",
        );
      }
    }
    // Owner unknown: nothing toggles (fail closed).
    assert.equal(
      r.seatToggleBlock(person("a"), set("a"), current, null, null),
      "owner",
    );
    // The list always starts with the owner, even if the selection lost it
    // or `current` didn't carry it.
    assert.deepEqual(r.seatFinalList(["a"], set("a"), OWNER), [OWNER, "a"]);
    assert.deepEqual(r.seatFinalList([OWNER, "a"], set(), OWNER), [OWNER]);
    assert.deepEqual(
      r.seatFinalList(["a", OWNER, "b"], set("b", "a", "c"), OWNER),
      [OWNER, "a", "b", "c"],
    );
    assert.deepEqual([...r.seatInitialSelection(["a"], OWNER)], [OWNER, "a"]);
    // A selection without the owner still counts as no change.
    assert.equal(r.seatCanConfirm([OWNER, "a"], set("a"), OWNER, null), false);
  });

  it("P3 a null cap is unknown, never 0; a known cap blocks only new seats (C-C12c)", async () => {
    const r = await loadRules();
    assert.equal(r.seatCapOf(null), null);
    assert.equal(r.seatCapOf(undefined), null);
    assert.equal(r.seatCapOf(Number.NaN), null);
    assert.equal(r.seatCapOf(-1), null);
    assert.equal(r.seatCapOf(2.5), null);
    assert.equal(r.seatCapOf(0), 0);
    assert.equal(r.seatCapOf(10), 10);

    const many = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const big = new Set([OWNER, ...many]);
    // Unknown cap: adding is never blocked, confirming an addition is allowed.
    assert.equal(
      r.seatToggleBlock(person("new"), big, set(OWNER), OWNER, null),
      null,
    );
    assert.equal(
      r.seatToggleBlock(person("new"), set(OWNER), set(OWNER), OWNER, null),
      null,
    );
    assert.equal(r.seatCanConfirm([OWNER], big, OWNER, null), true);
    assert.equal(r.seatCanConfirm([OWNER], set(OWNER, "a"), OWNER, null), true);

    // Known cap 3 (owner counts): room for 2 more, then blocked.
    assert.equal(
      r.seatToggleBlock(person("b"), set(OWNER, "a"), set(OWNER), OWNER, 3),
      null,
    );
    assert.equal(
      r.seatToggleBlock(
        person("c"),
        set(OWNER, "a", "b"),
        set(OWNER),
        OWNER,
        3,
      ),
      "cap",
    );
    assert.equal(
      r.seatCanConfirm([OWNER], set(OWNER, "a", "b"), OWNER, 3),
      true,
    );
    assert.equal(
      r.seatCanConfirm([OWNER], set(OWNER, "a", "b", "c"), OWNER, 3),
      false,
    );
    // Removing is never blocked by the cap, even over it.
    const over = [OWNER, "a", "b", "c", "d"];
    assert.equal(
      r.seatToggleBlock(person("d"), new Set(over), new Set(over), OWNER, 2),
      null,
    );
    assert.equal(
      r.seatCanConfirm(over, set(OWNER, "a", "b", "c"), OWNER, 2),
      true,
    );
    // ...but an addition while over is.
    assert.equal(
      r.seatCanConfirm(over, set(OWNER, "a", "b", "c", "e"), OWNER, 2),
      false,
    );
    // Cap 0 is a real (known) zero, not "unknown".
    assert.equal(
      r.seatToggleBlock(person("a"), set(OWNER), set(OWNER), OWNER, 0),
      "cap",
    );

    // The component normalises the prop and gates through the helpers.
    assert.match(BODY, /const slotCap = seatCapOf\(props\.slotCap\);/);
    assert.doesNotMatch(
      CODE,
      /slotCap \?\? 0\)?\s*(?:[-<>=]|\|\|)/,
      "a null cap must never be read as 0 in a comparison",
    );
  });

  it("P4 new seats need a viewer who is neither a bot nor staff", async () => {
    const r = await loadRules();
    const current = set(OWNER, "kept");
    const sel = set(OWNER, "kept");
    assert.equal(
      r.seatToggleBlock(person("x"), sel, current, OWNER, null),
      null,
    );
    assert.equal(
      r.seatToggleBlock(person("x", { bot: true }), sel, current, OWNER, null),
      "bot",
    );
    assert.equal(
      r.seatToggleBlock(
        person("x", { privileged: true }),
        sel,
        current,
        OWNER,
        null,
      ),
      "staff",
    );
    assert.equal(
      r.seatToggleBlock(
        person("x", { canView: false }),
        sel,
        current,
        OWNER,
        null,
      ),
      "no_access",
    );
    // A current seat that lost access may be removed and put back (not a
    // new claim, design 4.3 step 5).
    const lost = person("kept", { canView: false });
    assert.equal(r.seatToggleBlock(lost, sel, current, OWNER, null), null);
    assert.equal(
      r.seatToggleBlock(lost, set(OWNER), current, OWNER, null),
      null,
    );
    // Listing: bots and non-viewers are hidden unless already seated.
    assert.equal(r.seatListed(person("x"), current, OWNER), true);
    assert.equal(
      r.seatListed(person("x", { bot: true }), current, OWNER),
      false,
    );
    assert.equal(
      r.seatListed(person("x", { canView: false }), current, OWNER),
      false,
    );
    assert.equal(r.seatListed(lost, current, OWNER), true);
    assert.equal(
      r.seatListed(person(OWNER, { canView: false }), current, OWNER),
      true,
    );
    // Toggle flips one id and returns a new set.
    const before = set(OWNER, "a");
    const after = r.seatToggled(before, "a");
    assert.deepEqual([...after], [OWNER]);
    assert.deepEqual([...before], [OWNER, "a"]);
    assert.deepEqual([...r.seatToggled(after, "b")], [OWNER, "b"]);
  });

  it("P5 confirms only a changed list, hands over the full list and waits", async () => {
    const r = await loadRules();
    assert.equal(
      r.seatCanConfirm([OWNER, "a"], set(OWNER, "a"), OWNER, 5),
      false,
    );
    assert.equal(r.seatCanConfirm([OWNER, "a"], set(OWNER), OWNER, 5), true);
    assert.equal(r.seatCanConfirm([OWNER], set(OWNER, "b"), null, null), false);

    // W4d: from `currentIds()` (`props.current` minus refusal-dropped).
    // S2 D40 (pin updated by lane U8): with a reason the same list goes to
    // the bridge's `setSeats` instead (P18); either way close only after
    // the send resolves.
    assert.match(
      BODY,
      /const list = seatFinalList\(currentIds\(\), selected\(\), owner\);\s*await \(sendReason === null\s*\? props\.onConfirm\(list\)\s*: setSeatsWithReason\(list, sendReason\)\);\s*props\.onClose\(\);/,
      "onConfirm gets the full list, close only after it resolves",
    );
    assert.equal(
      (BODY.match(/props\.onConfirm\(/g) ?? []).length,
      1,
      "one onConfirm call",
    );
    assert.match(BODY, /setPending\(true\);/);
    assert.match(BODY, /finally \{\s*setPending\(false\);\s*\}/);
    assert.match(BODY, /isDisabled=\{pending\(\)\}/);
    assert.match(BODY, /<CircularProgress\b/);
    // Closing (scrim, Cancel) waits for the publish to settle.
    assert.match(
      BODY,
      /function close\(\) \{\s*if \(!pending\(\)\) props\.onClose\(\);\s*\}/,
    );
    assert.match(BODY, /onClose=\{close\}/);
    // The toggle handler obeys the rules.
    assert.match(
      BODY,
      /if \(pending\(\) \|\| blockOf\(row\) !== null\) return;/,
    );
    assert.match(BODY, /isDisabled: !canConfirm\(\)/);
    // S2 D39 (pin updated by lane U8): the cap also counts cooling seats
    // (P13); while a reason is asked for, Confirm re-sends the stored
    // change (P20).
    assert.match(
      BODY,
      /\(askReason\(\) \|\|\s*seatCanConfirm\(\s*currentIds\(\),\s*selected\(\),\s*ownerId\(\),\s*slotCap,\s*dropped\(\)\.size > 0,\s*cooling\(\),\s*\)\)/,
    );
  });

  it("P5b genesis (current empty) confirms the owner-only list within the cap (C-C12d)", async () => {
    const r = await loadRules();
    const owner = r.seatInitialSelection([], OWNER);
    assert.deepEqual([...owner], [OWNER]);
    assert.deepEqual(r.seatFinalList([], owner, OWNER), [OWNER]);
    // Owner only: valid for protect (design 6.3), any cap that fits it.
    for (const cap of [null, 1, 5]) {
      assert.equal(r.seatCanConfirm([], owner, OWNER, cap), true, `cap ${cap}`);
    }
    // Owner plus initial members, within and over a known cap.
    assert.equal(r.seatCanConfirm([], set(OWNER, "a"), OWNER, null), true);
    assert.equal(r.seatCanConfirm([], set(OWNER, "a"), OWNER, 2), true);
    assert.equal(r.seatCanConfirm([], set(OWNER, "a", "b"), OWNER, 2), false);
    assert.equal(r.seatCanConfirm([], owner, OWNER, 0), false);
    // Still needs a known owner.
    assert.equal(r.seatCanConfirm([], owner, null, null), false);
    // Non-genesis keeps the unchanged-list rule.
    assert.equal(r.seatCanConfirm([OWNER], set(OWNER), OWNER, null), false);
  });

  it("P6 eligibility uses the house permission helper and user facts", () => {
    assert.match(
      BODY,
      /member\.hasPermission\(props\.channel, "ViewChannel"\)/,
    );
    assert.match(BODY, /bot: !!user\.bot,/);
    assert.match(BODY, /privileged: user\.privileged === true,/);
    // W4d: `current` is now a memo (minus refusal-dropped users).
    assert.match(
      BODY,
      /seatListed\(candidate, current\(\), owner, dropped\(\)\)/,
    );
    assert.match(BODY, /m\.id\.server === serverId/);
    assert.match(BODY, /props\.channel\.server\?\.ownerId \?\? null/);
    // Current seats the client holds no member for stay in the list.
    assert.match(
      BODY,
      /for \(const id of owner === null \? currentIds\(\) : \[owner, \.\.\.current\(\)\]\)/,
    );
  });

  it("P7 errors only via protectedNoticeForError + errorUiCopy, never .message", () => {
    assert.match(
      BODY,
      /return protectedNoticeForError\(err, \{ op: "owner" \}\);/,
    );
    // W4d: the removed-users copy names who was left off when it can.
    // F2 (pin updated by lane U8): the failure rides along (P7b).
    assert.match(
      BODY,
      /setError\(\s*errorUiCopy\(ui, \{ removedUserNames: displayNames, failure: err \}\),?\s*\);/,
    );
    // S2 (count replaced by lane U8: the owner actions added error sites):
    // every error shown is cleared (null), a D17 mapping, or the one local
    // client-failure line (P21); never anything built from the error.
    const sets = [...BODY.matchAll(/setError\(\s*([\s\S]{0,40})/g)].map(
      (m) => m[1],
    );
    assert.ok(sets.length >= 3, "setError sites");
    for (const arg of sets) {
      assert.match(
        arg,
        /^(?:null\)|errorUiCopy\(|notPersistedLine\(\)\))/,
        `setError(${arg}…)`,
      );
    }
    assert.match(BODY, /setError\(null\);/);
    assert.doesNotMatch(CODE, /\.message\b/, "never read an error's message");
    assert.doesNotMatch(CODE, /\bshowError\b/, "never the generic error modal");
    assert.doesNotMatch(CODE, /String\(err/, "never stringify the error");
    // The SDK refusal is mapped like the composer does (choice 6 copy).
    assert.match(BODY, /err instanceof ProtectedChannelUnavailable/);
    assert.match(BODY, /shield\(\)\?\.notice === "enable_e2ee"/);
  });

  it("P7b every mapped error passes its failure to errorUiCopy (F2)", () => {
    const calls = [...BODY.matchAll(/errorUiCopy\(([^;]*?)\)\s*,?\s*\);/g)];
    // confirm, discard, re-sign, re-create
    assert.equal(calls.length, 4, "errorUiCopy sites");
    for (const [call, args] of calls) {
      assert.match(args, /\bfailure: err \}$/, call);
    }
    // the owner-action catches map through the same D17 helper
    for (const fn of ["discard", "resignDevices", "recreate"]) {
      const from = BODY.indexOf(`async function ${fn}()`);
      assert.ok(from !== -1, `${fn} missing`);
      const body = BODY.slice(from, BODY.indexOf("\n  }\n", from));
      assert.match(
        body,
        /\} catch \(err\) \{[\s\S]*setError\(errorUiCopy\(errorUiOf\(err\), \{ failure: err \}\)\);[\s\S]*\} finally \{\s*setPending\(false\);/,
        fn,
      );
    }
  });

  it("P8 copy from C0 and no blank-page traps", () => {
    for (const name of [
      "seatPickerCopy.title()",
      "seatPickerCopy.description()",
      "seatPickerCopy.searchPlaceholder()",
      "seatPickerCopy.noResults()",
      "seatPickerCopy.seatsLeft(",
      "seatPickerCopy.confirm()",
      "settingsCopy.seatsUsed(",
      "settingsCopy.ownerBadge()",
      "settingsCopy.ownerOnly()",
    ]) {
      assert.ok(BODY.includes(name), `${name} not used`);
    }
    // JSX text children must be expressions or <Trans>: no bare English.
    const bare = [...BODY.matchAll(/>\s*([A-Za-z][^<>{}();=]*?)\s*</g)].map(
      (m) => m[1],
    );
    assert.deepEqual(bare, ["Cancel"], "only <Trans>Cancel</Trans> is literal");
    assert.match(BODY, /<Trans>Cancel<\/Trans>/);
    // Never "Protected" alone in a local string.
    for (const m of BODY.matchAll(/\bt`([^`]*)`/g)) {
      assert.doesNotMatch(m[1], /\bProtected\b(?! channel)/, m[1]);
    }

    assert.doesNotMatch(
      CODE,
      /\bstyled\(\s*[A-Z]/,
      "styled(Component) at module scope",
    );
    assert.doesNotMatch(
      CODE,
      /from "@revolt\/ui";/,
      "@revolt/ui barrel import",
    );
    assert.doesNotMatch(CODE, /features\/legacy/, "legacy barrel");
    // W4d N3 added ONE local msgid (the left-off line, P11; catalog owed).
    // S2 lane U8 added exactly `U8_MSGIDS` (catalog owed, L9); the count
    // moved from 5 to 29 with them.
    assert.equal((BODY.match(/\bt`/g) ?? []).length, 29, "local msgids");
    for (const msgid of U8_MSGIDS) {
      const src = msgid.replace(/\{(\w+)\}/g, "${$1}");
      assert.ok(BODY.includes("t`" + src + "`"), `local msgid ${msgid}`);
    }
    for (const file of [
      "@revolt/ui/components/design/Avatar",
      "@revolt/ui/components/design/Button",
      "@revolt/ui/components/design/Dialog",
      "@revolt/ui/components/design/LoadingProgress",
      "@revolt/ui/components/layout/Column",
      "@revolt/ui/components/utils/Symbol",
    ]) {
      assert.ok(CODE.includes(`from "${file}";`), `${file} by file path`);
    }
  });

  it("P9 a removed-users refusal deselects exactly them and never resubmits (C-SET3)", async () => {
    const r = await loadRules();
    const refusal = {
      kind: "notice",
      notice: "seat_list_names_removed_users",
      max: null,
      tag: "SeatListNamesRemovedUsers",
      users: ["x", OWNER, "", 7, "x", "y"],
    };
    assert.deepEqual(r.seatRefusalRemoved(refusal, OWNER), ["x", "y"]);
    assert.deepEqual(
      r.seatRefusalRemoved({ ...refusal, users: null }, OWNER),
      [],
    );
    assert.deepEqual(
      r.seatRefusalRemoved({ ...refusal, notice: "seat_cap_reached" }, OWNER),
      [],
    );
    assert.deepEqual(
      r.seatRefusalRemoved({ kind: "none", tag: "Declined" }, OWNER),
      [],
    );
    assert.deepEqual(r.seatRefusalRemoved(undefined, OWNER), []);
    const kept = r.seatWithout(["a", "x", "b", "y"], ["x", "y"]);
    assert.deepEqual(kept, ["a", "b"]);
    assert.deepEqual(r.seatWithout(set(OWNER, "x"), new Set(["x"])), [OWNER]);
    // Dropped users are never listed again in this modal (re-adding them
    // waits for a list without them); the owner always is.
    const dropped = set("x");
    assert.equal(
      r.seatListed(person("x"), set(OWNER, "x"), OWNER, dropped),
      false,
    );
    assert.equal(r.seatListed(person("y"), set(OWNER), OWNER, dropped), true);
    assert.equal(
      r.seatListed(person(OWNER), set(OWNER), OWNER, set(OWNER)),
      true,
    );
    // The list without them is a change on its own (the server's list still
    // names them), but only with `cleanup`.
    assert.equal(
      r.seatCanConfirm([OWNER, "a"], set(OWNER, "a"), OWNER, 5),
      false,
    );
    assert.equal(
      r.seatCanConfirm([OWNER, "a"], set(OWNER, "a"), OWNER, 5, true),
      true,
    );
    assert.equal(
      r.seatCanConfirm([OWNER, "a"], set(OWNER, "a"), null, 5, true),
      false,
      "still needs a known owner",
    );
    // Wiring: `current` is `props.current` minus the dropped users, the
    // refusal deselects exactly them, and the catch resubmits nothing.
    assert.match(
      BODY,
      /const currentIds = createMemo\(\(\) => seatWithout\(props\.current, dropped\(\)\)\);/,
    );
    // W4d: the selection starts from `currentIds()` (minus `removed`, P10).
    assert.match(
      BODY,
      /seatInitialSelection\(currentIds\(\), ownerId\(\)\)/,
      "a removed user is never pre-selected",
    );
    const from = BODY.indexOf(
      "} catch (err) {",
      BODY.indexOf("async function confirm()"),
    );
    const to = BODY.indexOf("} finally {", from);
    assert.ok(from !== -1 && to > from, "confirm catch missing");
    const katch = BODY.slice(from, to);
    assert.match(
      katch,
      /const removed = seatRefusalRemoved\(ui, owner\);\s*if \(removed\.length > 0\) \{\s*setDropped\(\(prev\) => new Set\(\[\.\.\.prev, \.\.\.removed\]\)\);\s*setSelected\(\(prev\) => new Set\(seatWithout\(prev, removed\)\)\);\s*\}/,
    );
    assert.doesNotMatch(
      katch,
      /onConfirm|confirm\(\)|onClose/,
      "a refusal never resubmits or closes",
    );
    // S2 D39 (count updated by lane U8): plus "Update the list" (P14).
    assert.equal(
      (BODY.match(/(?<![.\w])confirm\(\)/g) ?? []).length,
      3,
      "confirm(): its declaration, the Confirm action and Update the list",
    );
    assert.match(
      BODY,
      /onClick: \(\) => \{\s*void confirm\(\);\s*return false;/,
    );
  });

  it("P10 a fresh picker never offers a user the page knows was removed (C-SET4)", async () => {
    const r = await loadRules();
    // The prop is read like a refusal's ids: strings, deduplicated, no owner.
    assert.deepEqual(r.seatDroppedIds(["x", OWNER, "", 3, "x", "y"], OWNER), [
      "x",
      "y",
    ]);
    assert.deepEqual(r.seatDroppedIds(undefined, OWNER), [], "absent = none");
    assert.deepEqual(r.seatDroppedIds("x", OWNER), []);
    // A fresh modal: `removed` x is not selected, not a candidate even if
    // they rejoined and can view, and dropping them alone may be confirmed.
    const dropped = new Set(r.seatDroppedIds(["x"], OWNER));
    const currentIds = r.seatWithout([OWNER, "a", "x"], dropped);
    assert.deepEqual(currentIds, [OWNER, "a"]);
    const initial = r.seatInitialSelection(currentIds, OWNER);
    assert.equal(initial.has("x"), false, "never pre-selected");
    assert.equal(
      r.seatListed(person("x"), new Set(currentIds), OWNER, dropped),
      false,
      "never offered",
    );
    assert.equal(
      r.seatCanConfirm(currentIds, initial, OWNER, 5, dropped.size > 0),
      true,
      "the list that only drops them can be confirmed",
    );
    assert.equal(
      r.seatCanConfirm(currentIds, initial, OWNER, 5, false),
      false,
      "without removed users nothing changed",
    );
    // Wiring: `dropped` starts from the prop.
    assert.match(
      BODY,
      /createSignal<ReadonlySet<string>>\(\s*new Set\(seatDroppedIds\(props\.removed, ownerId\(\)\)\),\s*\);/,
    );
    assert.match(
      CODE,
      /return seatDroppedIds\(u\.users, ownerId\);/,
      "the prop and a refusal's ids share one rule",
    );
  });

  it("P11 Confirm is preceded by who will be left off (C-N3c)", async () => {
    const r = await loadRules();
    // Unresolved or blank names show the id: nobody dropped goes unnamed.
    assert.equal(
      r.seatLeftOffNames(["x", "y", "z"], ["Xena", " ", null]),
      "Xena, y, z",
    );
    assert.equal(r.seatLeftOffNames(["x"], []), "x");
    // Wiring: the line shows whenever `dropped` (the `removed` prop or a
    // refusal) is non-empty, after the error, last before the actions.
    assert.match(
      BODY,
      /const leftOff = \(\): string \| null => \{\s*const ids = \[\.\.\.dropped\(\)\];\s*if \(ids\.length === 0\) return null;\s*return leftOffLine\(seatLeftOffNames\(ids, displayNames\(ids\)\)\);\s*\};/,
    );
    assert.match(
      BODY,
      /const leftOffLine = \(names: string\) =>\s*t`Will be left off the seat list: \$\{names\}`;/,
    );
    const err = BODY.indexOf('<Notice role="alert">{error()}</Notice>');
    const line = BODY.indexOf("<Show when={leftOff()}>");
    const end = BODY.indexOf("</Column>");
    assert.ok(
      err !== -1 && line > err && end > line,
      "left-off line placement",
    );
    assert.match(
      BODY.slice(line, end),
      /^<Show when=\{leftOff\(\)\}>\s*\{\(line\) => \(\s*<LeftOff role="status" data-left-off>\s*\{line\(\)\}\s*<\/LeftOff>\s*\)\}\s*<\/Show>\s*$/,
    );
    // Names of users this client hasn't loaded are fetched.
    assert.match(BODY, /for \(const id of dropped\(\)\) \{/);
    assert.match(BODY, /c\.users\.fetch\(id\)\.catch\(/);
  });

  // ---- S2 W4-3 lane U8 (pure rules: protectedSeatUiPolicy.test.ts) -------

  it("P12 S2 D39: released seats are listed with their cause, owner only (C-U8a)", () => {
    // Wiring: from the bridge's seat read, owner only, by name (never id),
    // the cause through an exhaustive switch over the policy's kinds.
    assert.match(
      BODY,
      /const released = createMemo\(\(\) => seatReleasedRows\(snapshot\(\)\?\.cooling\)\);/,
    );
    assert.match(
      BODY,
      /<Show when=\{viewerIsOwner\(\) && released\(\)\.length > 0\}>\s*<Section data-released>/,
    );
    assert.match(BODY, /<SeatName>\{nameOf\(seat\.userId\)\}<\/SeatName>/);
    assert.match(
      BODY,
      /const nameOf = \(id: string\): string =>\s*displayNames\(\[id\]\)\[0\] \?\? unknownMember\(\);/,
    );
    assert.match(
      BODY,
      /<Show when=\{seatUntilText\(seat\.until\)\}>\s*\{\(until\) => <SeatNote>\{untilLine\(until\(\)\)\}<\/SeatNote>\}/,
    );
    const from = BODY.indexOf("function causeLine(");
    const sw = BODY.slice(from, BODY.indexOf("\n  }\n", from));
    assert.match(sw, /\(cause: SeatReleaseCause \| null\)/);
    for (const c of [
      "owner_unseat",
      "server_removal",
      "access_lost",
      "device_never_joined",
    ]) {
      assert.ok(sw.includes(`case "${c}":`), c);
    }
    assert.match(sw, /const _exhaustive: never = cause;/);
  });

  it("P13 S2 D39 cap clamp: cooling seats count, a re-seat reuses its slot (C-U8b)", async () => {
    const r = await loadRules();
    const cooling = set("b");
    // cap 3: owner + a + cooling b = full
    assert.equal(
      r.seatToggleBlock(
        person("c"),
        set(OWNER, "a"),
        set(OWNER, "a"),
        OWNER,
        3,
        cooling,
      ),
      "cap",
    );
    assert.equal(
      r.seatToggleBlock(
        person("c"),
        set(OWNER, "a"),
        set(OWNER, "a"),
        OWNER,
        3,
      ),
      null,
      "without cooling seats there is room",
    );
    // re-seating the cooling user takes no new slot
    assert.equal(
      r.seatToggleBlock(
        person("b"),
        set(OWNER, "a"),
        set(OWNER, "a"),
        OWNER,
        3,
        cooling,
      ),
      null,
    );
    // an unknown cap still never blocks
    assert.equal(
      r.seatToggleBlock(
        person("c"),
        set(OWNER, "a"),
        set(OWNER, "a"),
        OWNER,
        null,
        cooling,
      ),
      null,
    );
    assert.equal(
      r.seatCanConfirm([OWNER, "a"], set(OWNER, "a", "c"), OWNER, 3, false, [
        "b",
      ]),
      false,
    );
    assert.equal(
      r.seatCanConfirm([OWNER, "a"], set(OWNER, "a", "c"), OWNER, 3),
      true,
    );
    assert.equal(
      r.seatCanConfirm([OWNER, "a"], set(OWNER, "a", "b"), OWNER, 3, false, [
        "b",
      ]),
      true,
      "a re-seat of a cooling user fits",
    );
    // removal-only is never blocked, cooling or not
    assert.equal(
      r.seatCanConfirm([OWNER, "a", "c"], set(OWNER, "a"), OWNER, 2, false, [
        "b",
        "d",
      ]),
      true,
    );

    // Wiring: the counter, the toggles and Confirm all count them.
    assert.match(
      BODY,
      /: seatUsedCount\(\s*seatFinalList\(currentIds\(\), selected\(\), owner\),\s*cooling\(\),\s*\);/,
    );
    assert.match(
      BODY,
      /seatToggleBlock\(\s*row\.candidate,\s*selected\(\),\s*current\(\),\s*ownerId\(\),\s*slotCap,\s*coolingSet\(\),\s*\)/,
    );
    assert.match(
      BODY,
      /const cooling = createMemo\(\(\) => released\(\)\.map\(\(r\) => r\.userId\)\);/,
    );
  });

  it("P14 S2 D39: the no-longer-seated banner and a removal-only Update the list (C-U8c)", () => {
    assert.match(
      BODY,
      /<Show when=\{viewerIsOwner\(\) && dropped\(\)\.size > 0\}>\s*<Callout role="status" data-update-list>\s*<span>\{noSeatsLine\(dropped\(\)\.size\)\}<\/span>\s*<Show when=\{canUpdateList\(\)\}>\s*<Button[^>]*onPress=\{\(\) => void confirm\(\)\}\s*>/,
    );
    const from = BODY.indexOf("const canUpdateList = () => {");
    assert.ok(from !== -1, "canUpdateList missing");
    const fn = BODY.slice(from, BODY.indexOf("\n  };\n", from));
    assert.match(fn, /!askReason\(\)/);
    assert.match(fn, /canConfirm\(\)/);
    assert.match(fn, /!seatAdds\(currentIds\(\), selected\(\), owner\)/);
  });

  it("P15 S2 D39: Removal waiting after 10 minutes, Finish now or re-create (C-U8d)", () => {
    // Owner only, from the view's text group, re-checked on a timer that is
    // cleaned up; Finish now is ONE manual refresh (U8b: `retryNow`, never
    // the open's 60 s loop); a poisoned group offers the re-create instead.
    assert.match(
      BODY,
      /viewerIsOwner\(\)\s*\? seatRemovalsWaiting\(view\(\)\?\.serverGroup\?\.pending_removals, now\(\)\)\s*: \[\]/,
    );
    assert.match(
      BODY,
      /const timer = setInterval\(\(\) => setNow\(Date\.now\(\)\), REMOVAL_RECHECK_MS\);\s*onCleanup\(\(\) => clearInterval\(timer\)\);/,
    );
    const from = BODY.indexOf("function finishNow() {");
    const fn = BODY.slice(from, BODY.indexOf("\n  }\n", from));
    assert.match(
      fn,
      /if \(!api \|\| pending\(\)\) return;\s*api\.retryNow\(props\.channel\.id\);/,
    );
    assert.doesNotMatch(BODY, /\bprotectedOpen\b/, "never the open lifecycle");
    assert.match(BODY, /await api\.recreateGroup\(props\.channel\.id\);/);
    assert.match(
      BODY,
      /<Show\s*when=\{poisoned\(\)\}\s*fallback=\{\s*<Button[^>]*onPress=\{finishNow\}\s*>\s*\{finishLabel\(\)\}\s*<\/Button>\s*\}\s*>\s*<Button[^>]*onPress=\{\(\) => void recreate\(\)\}\s*>\s*\{panelCopy\.recreateGroup\(\)\}/,
    );
    assert.match(
      BODY,
      /const poisoned = \(\) => view\(\)\?\.native\?\.state === "poisoned";/,
    );
  });

  it("P16 S2 D39: a device count per seated row; unknown is not 0 (C-U8e)", () => {
    // Only seated rows; unknown members show no column, a seated user with
    // no device in the group shows 0.
    const from = BODY.indexOf(
      "const devicesOf = (row: SeatRow): number | null => {",
    );
    assert.ok(from !== -1, "devicesOf missing");
    const fn = BODY.slice(from, BODY.indexOf("\n  };\n", from));
    assert.match(
      fn,
      /if \(id !== ownerId\(\) && !current\(\)\.has\(id\)\) return null;/,
    );
    assert.match(
      fn,
      /return counts === null \? null : \(counts\.get\(id\) \?\? 0\);/,
    );
    assert.match(
      BODY,
      /seatDeviceCounts\(view\(\)\?\.serverGroup\?\.members\)/,
    );
    assert.match(
      BODY,
      /<Show when=\{devicesOf\(row\) !== null\}>\s*<SeatDevices data-devices>\s*\{devicesLine\(devicesOf\(row\) \?\? 0\)\}/,
    );
  });

  it("P17 S2 R27: revoked owner devices go to authoritySign via proposedOwnerDevices (C-U8f)", () => {
    // The banner: owner only, a non-empty server list; the 9.2 copy.
    const rv = BODY.indexOf("const revoked = () => {");
    assert.ok(rv !== -1, "revoked missing");
    assert.match(
      BODY.slice(rv, BODY.indexOf("\n  };\n", rv)),
      /return viewerIsOwner\(\) && Array\.isArray\(r\) && r\.length > 0;/,
    );
    assert.match(
      BODY,
      /<Show when=\{revoked\(\)\}>\s*<Alert role="alert" data-revoked-owner-devices>\s*<span>\{noticeCopy\("revoked_owner_devices"\)\}<\/span>\s*<Show when=\{proposedDevices\(\) !== null\}>/,
    );
    // The proposal: this device's id (never rendered) and the seat read.
    assert.match(
      BODY,
      /const self = readUi\(\(api\) => api\.selfDeviceId\(\), null\);\s*if \(self === null\) return null;\s*try \{\s*return proposedOwnerDevices\(snapshot\(\), self\);\s*\} catch \{/,
    );
    // The action signs exactly the proposal; nothing else calls it.
    assert.match(
      BODY,
      /const devices = proposedDevices\(\);\s*if \(!api \|\| devices === null \|\| pending\(\)\) return;/,
    );
    assert.match(
      BODY,
      /await api\.authoritySign\(props\.channel\.id, devices\);/,
    );
    assert.equal((BODY.match(/\.authoritySign\(/g) ?? []).length, 1);
    assert.match(
      CODE,
      /import \{ proposedOwnerDevices \} from "@revolt\/client\/protectedTextOwner";/,
    );
  });

  it("P18 S2 D40: the unseat reason is checked, sanitized and sent; refusals map before the notice (C-U8g)", () => {
    // Before any send: `validReason(s, "header")`, a problem stops it, and
    // the SANITIZED reason is what goes out.
    const from = BODY.indexOf("async function confirm()");
    const fn = BODY.slice(from, BODY.indexOf("\n  }\n", from));
    assert.match(
      fn,
      /if \(askReason\(\)\) \{\s*const check = validReason\(reason\(\), "header"\);\s*if \(!check\.ok\) \{\s*setReasonProblem\(\s*reasonProblemCopy\(check\.why, AUDIT_LOG_REASON_MAX_CHARS\),?\s*\);\s*return;\s*\}\s*sendReason = check\.reason;\s*\}/,
    );
    assert.ok(
      fn.indexOf("sendReason = check.reason;") <
        fn.indexOf("setPending(true);"),
      "checked before pending",
    );
    assert.doesNotMatch(fn, /sendReason = reason\(\)/, "never the raw input");
    // The reason travels with the seat PUT of the stored change.
    assert.match(
      BODY,
      /const cap = seatCapOf\(snapshot\(\)\?\.device_cap\);\s*if \(!api \|\| cap === null\) throw new ProtectedChannelUnavailable\(\);\s*await api\.setSeats\(props\.channel\.id, list, cap, why\);/,
    );
    // The catch: too long (the failure BODY, `seatFailureBody`), then a
    // missing reason, then the notice mapping.
    const katch = fn.slice(fn.indexOf("} catch (err) {"));
    const tl = katch.indexOf(
      'if (reasonRefusal(seatFailureBody(err)) === "too_long") {',
    );
    const rq = katch.indexOf("} else if (seatReasonRequired(ui)) {");
    const np = katch.indexOf("errorUiCopy(ui,");
    assert.ok(tl !== -1 && rq > tl && np > rq, "refusal order");
    assert.match(
      katch.slice(tl, rq),
      /setReasonWanted\(true\);\s*setReasonProblem\(\s*reasonProblemCopy\("too_long", AUDIT_LOG_REASON_MAX_CHARS\),?\s*\);/,
    );
    // The input: shown while asked, owner only, with the 9.2 copy.
    assert.match(
      BODY,
      /const askReason = \(\) => reasonWanted\(\) \|\| stored\(\)\?\.reasonRequired === true;/,
    );
    assert.match(
      BODY,
      /<Show when=\{viewerIsOwner\(\) && askReason\(\)\}>\s*<Section data-reason>\s*<SeatNote>\{noticeCopy\("removal_reason_required"\)\}<\/SeatNote>\s*<ReasonInput/,
    );
  });

  it("P19 F3: Discard this change only via cancelPendingSeats, disabled when not discardable (C-U8h)", () => {
    const from = BODY.indexOf("async function discard()");
    const fn = BODY.slice(from, BODY.indexOf("\n  }\n", from));
    assert.match(
      fn,
      /try \{\s*const outcome = seatDiscardOutcome\(\s*await api\.cancelPendingSeats\(props\.channel\.id\),?\s*\);/,
    );
    assert.match(
      fn,
      /if \(outcome === "discarded" \|\| outcome === "none"\) \{\s*setReasonWanted\(false\);/,
    );
    assert.equal((BODY.match(/\.cancelPendingSeats\(/g) ?? []).length, 1);
    // the button: only with a stored change, disabled unless discardable
    assert.match(
      BODY,
      /<Show when=\{stored\(\)\}>\s*\{\(s\) => \(\s*<>\s*<Button[^>]*isDisabled=\{pending\(\) \|\| s\(\)\.discardable === false\}[^>]*onPress=\{\(\) => void discard\(\)\}\s*>\s*\{discardLabel\(\)\}/,
    );
    // every answer is worded; unknown reads as maybe accepted
    const sw = BODY.slice(BODY.indexOf("function discardLine("));
    assert.match(sw, /\(outcome: SeatDiscardOutcome\)/);
    assert.match(
      sw,
      /case "maybe_accepted":\s*case "unknown":\s*return maybeAcceptedLine\(\);/,
    );
    assert.match(sw, /const _exhaustive: never = outcome;/);
  });

  it("P20 the stored change wins: the rows lock and the modal says so (C-U8i)", () => {
    const from = BODY.indexOf("function toggle(row: SeatRow) {");
    const fn = BODY.slice(from, BODY.indexOf("\n  }\n", from));
    assert.match(
      fn,
      /if \(askReason\(\)\) return;\s*setSelected\(\(prev\) => seatToggled\(prev, row\.candidate\.id\)\);/,
    );
    assert.match(
      BODY,
      /data-blocked=\{block\(\) !== null \|\| askReason\(\) \|\| undefined\}/,
    );
    assert.match(
      BODY,
      /<Show\s*when=\{\s*viewerIsOwner\(\) &&\s*!pending\(\) &&\s*\(stored\(\) !== null \|\| reasonWanted\(\)\)\s*\}\s*>\s*<Callout role="status" data-stored-change>\s*<span>\{storedLine\(\)\}<\/span>\s*<Show when=\{askReason\(\)\}>\s*<span>\{lockedLine\(\)\}<\/span>/,
    );
  });

  it("P21 publish_not_persisted has its own copy (C-U8j)", () => {
    assert.match(
      BODY,
      /\} else if \(seatClientReason\(err\) === "publish_not_persisted"\) \{\s*setError\(notPersistedLine\(\)\);/,
    );
  });

  it("P22 U8b: the seat-UI rules come from protectedSeatUiPolicy, never redefined here", () => {
    const shared = [
      "seatAdds",
      "seatClientReason",
      "seatDeviceCounts",
      "seatDiscardOutcome",
      "seatFailureBody",
      "seatReasonRequired",
      "seatReleasedRows",
      "seatRemovalsWaiting",
      "seatUntilText",
      "seatUsedCount",
    ];
    const at = CODE.indexOf('} from "@revolt/client/protectedSeatUiPolicy";');
    assert.ok(at !== -1, "policy import missing");
    const imp = CODE.slice(CODE.lastIndexOf("import {", at), at);
    for (const name of shared) {
      assert.match(imp, new RegExp(`\\b${name},`), `${name} imported`);
      assert.doesNotMatch(
        CODE,
        new RegExp(`function ${name}\\(`),
        `${name} not redefined`,
      );
    }
    assert.match(imp, /\btype SeatDiscardOutcome,/);
    assert.match(imp, /\btype SeatReleaseCause,/);
    assert.doesNotMatch(CODE, /\bREMOVAL_WAITING_MS = /);
    assert.doesNotMatch(CODE, /\bSEAT_RELEASE_CAUSES\b/);
  });
});

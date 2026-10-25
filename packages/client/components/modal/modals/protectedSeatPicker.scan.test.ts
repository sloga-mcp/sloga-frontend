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
//      resubmits by itself (C-SET3, picker side).
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
  seatInitialSelection(
    current: readonly string[],
    ownerId: string | null,
  ): Set<string>;
  seatFinalList(
    current: readonly string[],
    selected: ReadonlySet<string>,
    ownerId: string,
  ): string[];
  seatToggleBlock(
    c: Candidate,
    selected: ReadonlySet<string>,
    current: ReadonlySet<string>,
    ownerId: string | null,
    slotCap: number | null,
  ): Block;
  seatToggled(selected: ReadonlySet<string>, id: string): Set<string>;
  seatCanConfirm(
    current: readonly string[],
    selected: ReadonlySet<string>,
    ownerId: string | null,
    slotCap: number | null,
    cleanup?: boolean,
  ): boolean;
}
const RULE_NAMES = [
  "seatCapOf",
  "seatListed",
  "seatWithout",
  "seatRefusalRemoved",
  "seatDroppedIds",
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
    assert.match(
      BODY,
      /await props\.onConfirm\(seatFinalList\(currentIds\(\), selected\(\), owner\)\);\s*props\.onClose\(\);/,
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
    assert.match(
      BODY,
      /seatCanConfirm\(\s*currentIds\(\),\s*selected\(\),\s*ownerId\(\),\s*slotCap,\s*dropped\(\)\.size > 0,\s*\)/,
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
    assert.match(
      BODY,
      /setError\(errorUiCopy\(ui, \{ removedUserNames: displayNames \}\)\);/,
    );
    assert.equal(
      (BODY.match(/setError\(/g) ?? []).length,
      3,
      "setError: clear on toggle, clear on confirm, the mapped copy",
    );
    assert.match(BODY, /setError\(null\);/);
    assert.doesNotMatch(CODE, /\.message\b/, "never read an error's message");
    assert.doesNotMatch(CODE, /\bshowError\b/, "never the generic error modal");
    assert.doesNotMatch(CODE, /String\(err/, "never stringify the error");
    // The SDK refusal is mapped like the composer does (choice 6 copy).
    assert.match(BODY, /err instanceof ProtectedChannelUnavailable/);
    assert.match(BODY, /shield\(\)\?\.notice === "enable_e2ee"/);
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
    // W4d added no local msgid: the removed-users copy is L-ERR's.
    assert.equal((BODY.match(/\bt`/g) ?? []).length, 4, "local msgids");
    for (const file of [
      "@revolt/ui/components/design/Avatar",
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
    assert.equal(
      (BODY.match(/(?<![.\w])confirm\(\)/g) ?? []).length,
      2,
      "confirm(): its declaration and the Confirm action only",
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
});

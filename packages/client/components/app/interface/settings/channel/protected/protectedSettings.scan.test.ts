// Spec for the Protected channel settings page (W4 lane C11, plan D7, D13,
// D17, product choices 3 and 4; design 6.3, 6.4, 7.2), run with Node's
// built-in runner from packages/client:
//   node --conditions=browser --test components/app/interface/settings/channel/protected/protectedSettings.scan.test.ts
//
// The page files import Solid, lingui and the UI kit, so Node cannot load
// them. Their rules sit in marked regions (`// protected-pure:begin` ..
// `// protected-pure:end`) with no imports; this spec cuts them out,
// strips the types with Node's own stripper and runs the real source. The
// wiring is checked by scanning the files.
//
//  S1  registry: the "protected" entry and page arm are owner-gated by the
//      same predicate, and the page re-checks it (C-C11a);
//  S2  eligibility: server owner of a server text channel only; voice and
//      announcement channels only when already protected (C-C11a);
//  S3  "Protect this channel" needs the flag, capability, no history, an
//      entitlement and a known device cap; it is rendered only when
//      offered (C-C11b);
//  S4  a null cap is unknown, never 0 and never unlimited (C-C11c);
//  S5  the Webhooks tab and page are hidden on protected-or-pinned
//      channels (C-C11d);
//  S6  unseat = setSeats without that user, owner kept first; no modal;
//  S11 Remove only arms an inline confirm naming the member and the
//      14-day cooldown; only its affirmative button unseats (W4c#4,
//      C-C11e);
//  S7  a publish in flight disables Add and Remove and shows C0 progress;
//  S8  errors via protectedNoticeForError({op: "owner"}) + errorUiCopy;
//      onConfirm rejects so the picker shows the notice; never .message;
//  S9  the only raw request is a read-only seats GET; device caps come
//      from the seats read or the flag, never invented;
//  S10 C0 copy, no handover UI, no blank-page traps;
//  S12 W4d (W2 C1): a user the server removed whom the signed list still
//      names is never in the picker's `current` (C-SET1);
//  S13 W4d: "Remove seat" never submits a list naming another
//      server-removed user (C-SET2); they show read-only;
//  S14 W4d: a `SeatListNamesRemovedUsers` refusal leaves exactly those
//      users off the next list and re-reads; it never resubmits (C-SET3);
//  S15 W4d N3: "removed" needs positive evidence (cooling, or a same-list
//      refusal), never mere absence (C-N3a/b); the Remove-seat confirm
//      names everyone else the submitted list drops.
//
// Point `PROTECTED_SETTINGS_FILE`, `PROTECTED_SEAT_LIST_FILE` or
// `PROTECTED_CHANNEL_SETTINGS_FILE` at another copy (a known-bad control)
// to check that instead; it must fail.
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

const pageSource = read(
  "PROTECTED_SETTINGS_FILE",
  "ProtectedChannelSettings.tsx",
);
const listSource = read("PROTECTED_SEAT_LIST_FILE", "SeatList.tsx");
const registrySource = read(
  "PROTECTED_CHANNEL_SETTINGS_FILE",
  "../../ChannelSettings.tsx",
);

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PAGE = code(pageSource);
const LIST = code(listSource);
const REGISTRY = code(registrySource);

/** Source before the pure region (the component and its helpers). */
function componentPart(src: string): string {
  const to = src.indexOf(BEGIN);
  assert.ok(to !== -1, "protected-pure region missing");
  return code(src.slice(0, to));
}
const PAGE_BODY = componentPart(pageSource);
const LIST_BODY = componentPart(listSource);

async function loadRegion<T>(src: string, tag: string): Promise<T> {
  const from = src.indexOf(BEGIN);
  const to = src.indexOf(END);
  assert.ok(from !== -1 && to > from, `${tag}: protected-pure region missing`);
  const region = src.slice(from, to);
  assert.ok(
    !/^\s*import\s/m.test(region),
    `${tag}: the region must not import`,
  );
  const js = stripTypeScriptTypes(region, { mode: "strip" });
  const dir = mkdtempSync(join(tmpdir(), "w4c1-C11-"));
  const out = join(dir, `${tag}.mjs`);
  writeFileSync(out, js);
  return (await import(pathToFileURL(out).href)) as T;
}

interface PageRules {
  protectedSettingsEligible(i: Record<string, unknown>): boolean;
  channelHasMessages(v: unknown): boolean;
  deviceCapForProtect(a: unknown, b: unknown): number | null;
  protectReadWanted(i: Record<string, unknown>): boolean;
  protectAvailability(
    i: Record<string, unknown>,
  ):
    | { ok: true; slotCap: number; deviceCap: number }
    | { ok: false; block: string };
  parseSeatsBody(b: unknown): unknown;
  seatsOver<T>(snap: T, fresh: { basis: unknown; body: T } | null): T;
  refusedFor(
    r: { channelId: string; listBody: string; users: string[] } | null,
    channelId: string,
    listBody: unknown,
  ): readonly string[];
  removedUsersOfRefusal(ui: unknown): string[] | null;
}
interface ListRules {
  seatCount(v: unknown): number | null;
  seatRows(
    seats: unknown,
    ownerId: string,
    removed?: string[],
  ): { userId: string; owner: boolean; withoutAccess: boolean }[];
  serverRemovedSeatIds(
    r: Record<string, unknown>,
    ownerId: string,
    reported?: readonly string[],
  ): string[];
  editableSeatIds(r: Record<string, unknown>, removed: string[]): string[];
  leftOffBesides(
    r: Record<string, unknown>,
    ownerId: string,
    removed: string[],
    target: string,
  ): string[];
  seatsUsedOf(r: Record<string, unknown>): number;
  deviceCapLine(v: unknown): { kind: string; max?: number };
  coolingRows(c: unknown): { userId: string; until: string | null }[];
  listSeatIds(body: unknown): string[] | null;
  currentSeatIds(r: Record<string, unknown>): string[];
  ownerFirst(ids: string[], owner: string): string[];
  seatsAfterRemoval(
    current: string[],
    owner: string,
    target: string,
  ): string[] | null;
}

const pageRules = loadRegion<PageRules>(pageSource, "page");
const listRules = loadRegion<ListRules>(listSource, "list");

/** The ChannelSettings entry object with `id: "<id>"`. */
function entry(id: string): string {
  const at = REGISTRY.indexOf(`id: "${id}",`);
  assert.ok(at !== -1, `entry ${id} missing`);
  const from = REGISTRY.lastIndexOf("{", REGISTRY.lastIndexOf("hidden:", at));
  const to = REGISTRY.indexOf("},", at);
  return REGISTRY.slice(from, to);
}

/** The ChannelSettings `case "<id>":` arm of `render`. */
function arm(id: string): string {
  const at = REGISTRY.indexOf(`case "${id}":`);
  assert.ok(at !== -1, `render arm ${id} missing`);
  const to = REGISTRY.indexOf("case ", at + 6);
  const end = REGISTRY.indexOf("default:", at);
  return REGISTRY.slice(at, to === -1 || end < to ? end : to);
}

const OWNER = {
  type: "TextChannel",
  serverId: "S1",
  voice: false,
  announcement: false,
  protectedOrPinned: false,
  ownerId: "U_OWNER",
  selfId: "U_OWNER",
};

const READY = {
  flagEnabled: true,
  capable: true,
  tauriE2eeOff: false,
  selfPrivileged: false,
  hasMessages: false,
  seats: { slot_cap: 10, entitlement_device_cap: 5 },
  defaultDeviceCap: 3,
};

describe("protected channel settings (C11)", () => {
  it("S1 registry entry and page arm are owner-gated; the page re-checks", () => {
    assert.match(
      REGISTRY,
      /import \{\s*ProtectedChannelSettings,\s*protectedSettingsVisibleFor,\s*\} from "\.\/channel\/protected\/ProtectedChannelSettings";/,
    );
    const e = entry("protected");
    assert.match(
      e,
      /hidden: !protectedSettingsVisibleFor\(channel, client\(\)\),/,
    );
    assert.match(e, /title: settingsCopy\.title\(\),/);
    const a = arm("protected");
    assert.match(
      a,
      /return protectedSettingsVisibleFor\(channel, client\(\)\) \? \(\s*<ProtectedChannelSettings channel=\{channel\} \/>\s*\) : null;/,
    );
    assert.equal(
      (REGISTRY.match(/<ProtectedChannelSettings\b/g) ?? []).length,
      1,
      "the page is rendered from the gated arm only",
    );
    // The page itself: everything under the same predicate.
    assert.match(
      PAGE_BODY,
      /const eligible = \(\) => protectedSettingsVisibleFor\(props\.channel, client\(\)\);/,
    );
    assert.match(
      PAGE_BODY,
      /<Show\s+when=\{eligible\(\)\}\s+fallback=\{<Notice role="alert">\{settingsCopy\.ownerOnly\(\)\}<\/Notice>\}\s*>/,
    );
    assert.match(PAGE_BODY, /selfId: client\?\.user\?\.id,/);
    assert.match(PAGE_BODY, /ownerId: channel\.server\?\.ownerId,/);
    // Every owner flow re-checks too.
    assert.match(
      PAGE_BODY,
      /if \(!a\.ok \|\| !api \|\| owner === null \|\| !eligible\(\)\)/,
    );
    assert.match(PAGE_BODY, /const canChangeSeats = \(\) =>\s*eligible\(\) &&/);
  });

  it("S2 eligibility: the server owner of a server text channel only", async () => {
    const r = await pageRules;
    assert.equal(r.protectedSettingsEligible(OWNER), true);
    assert.equal(
      r.protectedSettingsEligible({ ...OWNER, selfId: "U_OTHER" }),
      false,
      "non-owner",
    );
    assert.equal(
      r.protectedSettingsEligible({ ...OWNER, selfId: undefined }),
      false,
    );
    assert.equal(
      r.protectedSettingsEligible({
        ...OWNER,
        ownerId: undefined,
        selfId: undefined,
      }),
      false,
      "unknown owner never matches an unknown self",
    );
    assert.equal(
      r.protectedSettingsEligible({ ...OWNER, ownerId: "", selfId: "" }),
      false,
    );
    for (const type of [
      "Thread",
      "Forum",
      "Group",
      "DirectMessage",
      "SavedMessages",
    ]) {
      assert.equal(
        r.protectedSettingsEligible({ ...OWNER, type }),
        false,
        type,
      );
    }
    assert.equal(
      r.protectedSettingsEligible({ ...OWNER, serverId: undefined }),
      false,
    );
    assert.equal(
      r.protectedSettingsEligible({ ...OWNER, voice: true }),
      false,
      "voice",
    );
    assert.equal(
      r.protectedSettingsEligible({ ...OWNER, announcement: true }),
      false,
      "announcement",
    );
    // Already protected/pinned: the owner keeps the page (to unseat).
    assert.equal(
      r.protectedSettingsEligible({
        ...OWNER,
        voice: true,
        protectedOrPinned: true,
      }),
      true,
    );
    assert.equal(
      r.protectedSettingsEligible({
        ...OWNER,
        protectedOrPinned: true,
        selfId: "U_OTHER",
      }),
      false,
      "protected does not bypass the owner check",
    );
    assert.match(PAGE, /voice: channel\.isVoice,/);
    assert.match(PAGE, /announcement: channel\.isAnnouncement === true,/);
    assert.match(
      PAGE,
      /protectedOrPinned: client\?\.isProtectedChannel\(channel\.id\) === true,/,
    );
  });

  it("S3 protect is offered only with the flag, capability, no history and an entitlement", async () => {
    const r = await pageRules;
    assert.deepEqual(r.protectAvailability(READY), {
      ok: true,
      slotCap: 10,
      deviceCap: 5,
    });
    const block = (over: Record<string, unknown>) => {
      const a = r.protectAvailability({ ...READY, ...over });
      return a.ok ? "OFFERED" : a.block;
    };
    assert.equal(block({ flagEnabled: false }), "flag_off");
    assert.equal(block({ flagEnabled: undefined }), "flag_off");
    assert.equal(block({ capable: false }), "not_available");
    assert.equal(block({ capable: false, tauriE2eeOff: true }), "enable_e2ee");
    assert.equal(block({ selfPrivileged: true }), "staff_owner");
    assert.equal(block({ hasMessages: true }), "has_messages");
    assert.equal(block({ seats: null }), "loading");
    assert.equal(block({ seats: "loading" }), "loading");
    assert.equal(block({ seats: "failed" }), "load_failed");
    assert.equal(
      block({ seats: { slot_cap: null, entitlement_device_cap: null } }),
      "no_entitlement",
    );
    assert.equal(r.channelHasMessages("01HX"), true);
    assert.equal(r.channelHasMessages(undefined), false);
    assert.equal(r.channelHasMessages(null), false);
    // The read happens only when it can matter.
    assert.equal(r.protectReadWanted(READY), true);
    assert.equal(r.protectReadWanted({ ...READY, flagEnabled: false }), false);
    assert.equal(r.protectReadWanted({ ...READY, capable: false }), false);
    assert.equal(r.protectReadWanted({ ...READY, hasMessages: true }), false);
    assert.equal(
      r.protectReadWanted({ ...READY, selfPrivileged: true }),
      false,
    );
    // The button lives only in the offered arm; both openers re-check.
    const offered = PAGE_BODY.indexOf("<Match when={availability().ok}>");
    const button = PAGE_BODY.indexOf("{settingsCopy.protectButton()}");
    assert.ok(
      offered !== -1 && button > offered,
      "button outside the offered arm",
    );
    assert.equal(
      (PAGE_BODY.match(/settingsCopy\.protectButton\(\)/g) ?? []).length,
      1,
    );
    assert.match(
      PAGE_BODY,
      /if \(!a\.ok \|\| busy\(\) \|\| !eligible\(\)\) return;/,
    );
    assert.match(PAGE_BODY, /flagEnabled: flag\(\)\.enabled,/);
    // One-way warning (C0) next to the button and in the confirm step.
    assert.equal(
      (
        PAGE_BODY.match(
          /<Warning>\{settingsCopy\.protectConfirmBody\(\)\}<\/Warning>/g,
        ) ?? []
      ).length,
      2,
    );
    assert.match(PAGE_BODY, /settingsCopy\.protectConfirmTitle\(\)/);
  });

  it("S4 a null cap is unknown: never 0, never unlimited", async () => {
    const p = await pageRules;
    const l = await listRules;
    assert.equal(l.seatCount(null), null);
    assert.equal(l.seatCount(undefined), null);
    assert.equal(l.seatCount(-1), null);
    assert.equal(l.seatCount(1.5), null);
    assert.equal(l.seatCount("5"), null);
    assert.equal(l.seatCount(0), 0);
    assert.equal(l.seatCount(7), 7);
    assert.deepEqual(l.deviceCapLine(null), { kind: "unknown" });
    assert.deepEqual(l.deviceCapLine(0), { kind: "unlimited" });
    assert.deepEqual(l.deviceCapLine(4), { kind: "max", max: 4 });
    assert.equal(l.seatsUsedOf({ seats_used: 3, seats: [] }), 3);
    assert.equal(l.seatsUsedOf({ seats_used: null, seats: [{}, {}] }), 2);
    // Device cap for the genesis list: entitlement, else flag default.
    assert.equal(p.deviceCapForProtect(5, 3), 5);
    assert.equal(p.deviceCapForProtect(0, 3), 0, "0 = unlimited is a real cap");
    assert.equal(p.deviceCapForProtect(null, 3), 3);
    assert.equal(p.deviceCapForProtect(null, null), null, "never invented");
    const none = p.protectAvailability({
      ...READY,
      seats: { slot_cap: 10, entitlement_device_cap: null },
      defaultDeviceCap: null,
    });
    assert.deepEqual(none, { ok: false, block: "no_device_cap" });
    // Rendering: the unknown line for a null slot cap, never seatsUsed(…, 0).
    assert.match(
      LIST_BODY,
      /\{slotCap\(\) === null\s*\? unknownCapLine\(used\(\)\)\s*: settingsCopy\.seatsUsed\(used\(\), slotCap\(\)!\)\}/,
    );
    assert.match(
      LIST_BODY,
      /const slotCap = \(\) => seatCount\(props\.seats\.slot_cap\);/,
    );
    assert.match(
      LIST_BODY,
      /const device = \(\) => deviceCapLine\(props\.seats\.device_cap\);/,
    );
    assert.doesNotMatch(LIST + PAGE, /\?\? 0\b/, "no null-to-0 fallback");
    // The picker gets the nullable cap as-is.
    assert.match(PAGE_BODY, /slotCap: seatCount\(s\.slot_cap\),/);
  });

  it("S5 Webhooks are hidden on protected-or-pinned channels", () => {
    const e = entry("webhooks");
    assert.match(e, /client\(\)\.isProtectedChannel\(channel\.id\) \|\|/);
    assert.match(
      arm("webhooks"),
      /return client\(\)\.isProtectedChannel\(channel\.id\) \? null : \(\s*<WebhooksList channel=\{channel\} \/>\s*\);/,
    );
    assert.match(
      REGISTRY,
      /const client = useClient\(\);\s*\n\s*return \{\s*context: channel,/,
    );
  });

  it("S11 Remove arms an inline confirm; only its affirmative unseats", () => {
    // Exactly one call into the page's unseat, inside the confirm block.
    assert.equal(
      (LIST_BODY.match(/props\.onRemove\(/g) ?? []).length,
      1,
      "one onRemove call site",
    );
    const from = LIST_BODY.indexOf("const confirm = (");
    const to = LIST_BODY.indexOf("</Confirm>", from);
    assert.ok(from !== -1 && to > from, "inline confirm block missing");
    const block = LIST_BODY.slice(from, to);
    assert.match(block, /confirmId\(\) === row\.userId/);
    assert.match(
      block,
      /variant="_error"\s*isDisabled=\{props\.disabled\}\s*onPress=\{\(\) => \{\s*setConfirmId\(null\);\s*props\.onRemove\(row\.userId\);\s*\}\}/,
    );
    assert.match(
      block,
      /onPress=\{\(\) => setConfirmId\(null\)\}\s*>\s*<Trans>Cancel<\/Trans>/,
    );
    assert.match(block, /\{removeConfirmLine\(who\(\)\.name\)\}/);
    // The row's Remove only arms the confirm.
    assert.match(
      LIST_BODY,
      /isDisabled=\{props\.disabled\}\s*onPress=\{\(\) => setConfirmId\(row\.userId\)\}/,
    );
    assert.match(LIST_BODY, /confirmId\(\) !== row\.userId/);
    // The copy names the member and states the 14-day cooldown.
    const line = LIST_BODY.match(
      /const removeConfirmLine = \(name: string\) =>\s*t`([^`]*)`/,
    );
    assert.ok(line, "removeConfirmLine missing");
    assert.match(line[1], /\$\{name\}/);
    assert.match(line[1], /14 days/);
  });

  it("S6 unseat drops only that user, keeps the owner first, no modal", async () => {
    const l = await listRules;
    assert.deepEqual(l.seatsAfterRemoval(["O", "A", "B"], "O", "A"), [
      "O",
      "B",
    ]);
    assert.deepEqual(l.seatsAfterRemoval(["A", "O", "B"], "O", "B"), [
      "O",
      "A",
    ]);
    assert.equal(
      l.seatsAfterRemoval(["O", "A"], "O", "O"),
      null,
      "owner stays",
    );
    assert.equal(l.seatsAfterRemoval(["O", "A"], "O", "Z"), null, "not seated");
    assert.deepEqual(l.ownerFirst(["A", "O", "A", ""], "O"), ["O", "A"]);
    const body =
      "sloga-seat-list-v1\nv:1\nchannel_id:C\nversion:2\ndevice_cap:5\nissued_at:1\nsigner_user_id:O\nsigner_device_id:d\nseats:A,B,O";
    assert.deepEqual(l.listSeatIds(body), ["A", "B", "O"]);
    assert.equal(l.listSeatIds("nope"), null);
    assert.deepEqual(
      l.currentSeatIds({ list: { body }, seats: [{ user_id: "X" }] }),
      ["A", "B", "O"],
      "the signed list wins over the rows",
    );
    assert.deepEqual(
      l.currentSeatIds({
        list: null,
        seats: [{ user_id: "X" }, { user_id: "X" }],
      }),
      ["X"],
    );
    // Rows: owner first, withoutAccess only for non-owners with the flag.
    assert.deepEqual(
      l.seatRows(
        [
          { user_id: "A", seated_without_access: true },
          { user_id: "O", seated_without_access: true },
          { user_id: "A" },
          { user_id: 5 },
        ],
        "O",
      ),
      [
        { userId: "O", owner: true, withoutAccess: false },
        { userId: "A", owner: false, withoutAccess: true },
      ],
    );
    assert.deepEqual(l.coolingRows([{ user_id: "C", cooldown_until: "bad" }]), [
      { userId: "C", until: null },
    ]);
    assert.equal(l.coolingRows(null).length, 0);
    // Wiring: Remove → seatsAfterRemoval → setSeats; never on the owner row.
    // W4d: from the editable seats (S13), no longer `currentSeatIds(s)`.
    assert.match(
      PAGE_BODY,
      /const next = seatsAfterRemoval\(editableIds\(\), owner, userId\);/,
    );
    assert.match(PAGE_BODY, /void runSetSeats\(next, false\);/);
    assert.equal(
      (LIST_BODY.match(/!row\.owner &&\s*!props\.hideRemove &&/g) ?? []).length,
      2,
      "Remove and its confirm are never on the owner row",
    );
    assert.doesNotMatch(
      PAGE_BODY + LIST_BODY,
      /openModal\(\{\s*type: "(?!protected_seat_picker)/,
      "no other dialog",
    );
    // seated_without_access is highlighted with copy.
    assert.match(
      LIST_BODY,
      /data-without-access=\{row\.withoutAccess \|\| undefined\}/,
    );
    assert.match(LIST_BODY, /<Show when=\{row\.withoutAccess\}>/);
  });

  it("S7 a publish in flight disables Add and Remove and shows progress", () => {
    assert.match(
      PAGE_BODY,
      /const busy = \(\) => view\(\)\?\.publishInFlight === true \|\| pending\(\) !== null;/,
    );
    assert.match(
      PAGE_BODY,
      /<Show when=\{busy\(\)\}>[\s\S]*?\{settingsCopy\.publishInFlight\(\)\}/,
    );
    assert.match(
      PAGE_BODY,
      /isDisabled=\{busy\(\)\}\s*onPress=\{openSeatPicker\}/,
    );
    assert.match(PAGE_BODY, /disabled=\{busy\(\)\}\s*onRemove=\{removeSeat\}/);
    assert.match(LIST_BODY, /isDisabled=\{props\.disabled\}/);
    assert.match(
      PAGE_BODY,
      /if \(!s \|\| busy\(\) \|\| !canAddSeats\(\)\) return;/,
    );
    assert.match(
      PAGE_BODY,
      /if \(!s \|\| owner === null \|\| busy\(\) \|\| !canChangeSeats\(\)\) return;/,
    );
    // Growth is flag-gated (D13); removal is not.
    assert.match(
      PAGE_BODY,
      /const canAddSeats = \(\) => canChangeSeats\(\) && flag\(\)\.enabled === true;/,
    );
    assert.doesNotMatch(
      PAGE_BODY.slice(
        PAGE_BODY.indexOf("const canChangeSeats"),
        PAGE_BODY.indexOf("const canAddSeats"),
      ),
      /flag\(\)/,
      "removal must not depend on the flag",
    );
    assert.match(PAGE_BODY, /\{settingsCopy\.protecting\(\)\}/);
  });

  it("S8 errors via protectedNoticeForError + errorUiCopy; onConfirm rejects", () => {
    assert.match(
      PAGE_BODY,
      /return protectedNoticeForError\(err, \{ op: "owner" \}\);/,
    );
    // W4d: the removed-users copy names who was left off when it can.
    assert.match(
      PAGE_BODY,
      /return errorUiCopy\(ui, \{ removedUserNames: displayNames \}\);/,
    );
    assert.match(
      PAGE_BODY,
      /if \(isClientReason\(err, "publish_in_flight"\)\) \{\s*return settingsCopy\.publishInFlight\(\);/,
    );
    assert.match(PAGE_BODY, /err instanceof ProtectedChannelUnavailable/);
    assert.doesNotMatch(
      PAGE + LIST,
      /\.message\b/,
      "never read an error's message",
    );
    assert.doesNotMatch(PAGE + LIST, /\bshowError\b/);
    assert.doesNotMatch(PAGE + LIST, /String\(err/);
    // The picker contract (C12): rejection reaches the picker.
    assert.match(PAGE_BODY, /setError\(errorText\(err\)\);\s*throw err;/);
    assert.match(
      PAGE_BODY,
      /setError\(errorText\(err\)\);\s*if \(rethrow\) throw err;/,
    );
    assert.match(PAGE_BODY, /onConfirm: runProtect,/);
    assert.match(
      PAGE_BODY,
      /onConfirm: \(userIds\) => runSetSeats\(userIds, true\),/,
    );
    for (const m of PAGE_BODY.matchAll(/openModal\(\{([\s\S]*?)\}\);/g)) {
      assert.match(
        m[1],
        /type: "protected_seat_picker",\s*channel: props\.channel,\s*current: [^,]+,\s*slotCap: [^,]+,\s*onConfirm:/,
      );
    }
  });

  it("S9 one read-only seats GET; device caps never invented", async () => {
    const r = await pageRules;
    const calls = [...PAGE.matchAll(/\.api\.(\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(calls, ["get"], "only api.get");
    assert.match(
      PAGE_BODY,
      /client\(\)\.api\.get\(\s*`\/channels\/\$\{props\.channel\.id as ""\}\/seats` as never,\s*\)/,
    );
    assert.doesNotMatch(LIST, /\.api\./, "SeatList makes no API request");
    assert.doesNotMatch(PAGE + LIST, /(?<![.\w])fetch\(/, "no raw fetch");
    // The read runs only when the bridge has no snapshot (protected) or the
    // entitlement matters (not protected).
    assert.match(
      PAGE_BODY,
      /if \(isProtected\(\)\) return snapshot\(\) === null \? `protected:\$\{id\}` : null;/,
    );
    assert.match(PAGE_BODY, /return protectReadWanted\(\{/);
    assert.equal(r.parseSeatsBody(null), null);
    assert.equal(r.parseSeatsBody("x"), null);
    assert.equal(r.parseSeatsBody({ seats: [], cooling: [], list: 5 }), null);
    assert.notEqual(
      r.parseSeatsBody({ seats: [], cooling: [], list: null }),
      null,
    );
    // Caps passed to the bridge.
    assert.match(
      PAGE_BODY,
      /await api\.protect\(\s*props\.channel\.id,\s*ownerFirst\(userIds, owner\),\s*a\.deviceCap,\s*\);/,
    );
    assert.match(
      PAGE_BODY,
      /await api\.setSeats\(props\.channel\.id, ownerFirst\(userIds, owner\), cap\);/,
    );
    assert.match(
      PAGE_BODY,
      /const seatsDeviceCap = \(\) => seatCount\(seats\(\)\?\.device_cap\);/,
    );
    assert.match(PAGE_BODY, /seatsDeviceCap\(\) !== null;/);
    assert.match(PAGE_BODY, /defaultDeviceCap: flag\(\)\.defaultDeviceCap,/);
  });

  it("S10 C0 copy, no handover UI, no blank-page traps", () => {
    for (const name of [
      "settingsCopy.description()",
      "settingsCopy.protectButton()",
      "settingsCopy.protectConfirmTitle()",
      "settingsCopy.protectConfirmBody()",
      "settingsCopy.protecting()",
      "settingsCopy.ownerOnly()",
      "settingsCopy.addSeats()",
      "settingsCopy.publishInFlight()",
      "settingsCopy.seatsSaved()",
      'noticeCopy("protected_channels_unavailable")',
      'noticeCopy("network_error")',
    ]) {
      assert.ok(PAGE_BODY.includes(name), `page: ${name} not used`);
    }
    for (const name of [
      "settingsCopy.seatsHeading()",
      "settingsCopy.seatsUsed(",
      "settingsCopy.deviceCap(",
      "settingsCopy.removeSeat()",
      "settingsCopy.noSeats()",
      "settingsCopy.ownerBadge()",
    ]) {
      assert.ok(LIST_BODY.includes(name), `list: ${name} not used`);
    }
    for (const [tag, body, allowed] of [
      ["page", PAGE_BODY, ["Cancel", "Continue"]],
      ["list", LIST_BODY, ["Cancel"]],
    ] as const) {
      const bare = [...body.matchAll(/>\s*([A-Za-z][^<>{}();=]*?)\s*</g)].map(
        (m) => m[1],
      );
      assert.deepEqual(bare, [...allowed], `${tag}: bare JSX text`);
      for (const m of body.matchAll(/\bt`([^`]*)`/g)) {
        assert.doesNotMatch(m[1], /\bProtected\b(?! channel)/, m[1]);
      }
    }
    // No handover UI (choice 3), no owner-change/recreate here.
    assert.doesNotMatch(
      PAGE + LIST,
      /handover|confirmOwnerChange|recreateGroup/i,
    );
    for (const [tag, src] of [
      ["page", PAGE],
      ["list", LIST],
    ] as const) {
      assert.doesNotMatch(
        src,
        /\bstyled\(\s*[A-Za-z_$]/,
        `${tag}: styled(Component)`,
      );
      assert.doesNotMatch(
        src,
        /from "@revolt\/ui";/,
        `${tag}: @revolt/ui barrel`,
      );
      assert.doesNotMatch(src, /features\/legacy/, `${tag}: legacy barrel`);
    }
    assert.doesNotMatch(REGISTRY, /\bstyled\(\s*[A-Za-z_$]/);
    // W4d: the removed group reuses L-ERR's copy (no new msgid here).
    assert.ok(
      LIST_BODY.includes('noticeCopy("seat_list_names_removed_users")'),
      "list: removed-users copy not used",
    );
    assert.match(
      REGISTRY,
      /import \{ Symbol \} from "@revolt\/ui\/components\/utils\/Symbol";/,
    );
    for (const file of [
      "@revolt/ui/components/design/Button",
      "@revolt/ui/components/design/LoadingProgress",
    ]) {
      assert.ok(PAGE.includes(`from "${file}";`), `page: ${file} by file path`);
    }
    for (const file of [
      "@revolt/ui/components/design/Avatar",
      "@revolt/ui/components/design/Button",
    ]) {
      assert.ok(LIST.includes(`from "${file}";`), `list: ${file} by file path`);
    }
  });

  // W4d (W2 C1). A forced release (kick, ban, leave, account deletion)
  // frees the seat but never edits the signed list; a PUT still naming
  // such a user is refused 400 `SeatListNamesRemovedUsers {users}`.
  // Signed list O,A,B,X,Y. KICKED: X and Y released and cooling. ABSENT:
  // X and Y merely missing from `seats[]` (no cooling, no refusal; N3).
  const SIGNED =
    "sloga-seat-list-v1\nv:1\nchannel_id:C\nversion:4\ndevice_cap:5\nissued_at:1\nsigner_user_id:O\nsigner_device_id:d\nseats:A,B,O,X,Y";
  const cool = (user_id: string) => ({
    user_id,
    released_at: "2026-10-20T00:00:00Z",
    cooldown_until: "2026-11-03T00:00:00Z",
  });
  const KICKED = {
    list: { body: SIGNED },
    seats: [{ user_id: "O" }, { user_id: "A" }, { user_id: "B" }],
    cooling: [cool("X"), cool("Y")],
  };
  const ABSENT = { ...KICKED, cooling: [] };

  /** One component-scope function of the page, `function <name>(` to `}`. */
  function pageFn(name: string): string {
    const from = PAGE_BODY.indexOf(`function ${name}(`);
    assert.ok(from !== -1, `${name} missing`);
    const to = PAGE_BODY.indexOf("\n  }\n", from);
    assert.ok(to > from, `${name}: end missing`);
    return PAGE_BODY.slice(from, to);
  }

  it("S12 a server-removed user is never in the picker's current (C-SET1)", async () => {
    const l = await listRules;
    const removed = l.serverRemovedSeatIds(KICKED, "O");
    assert.deepEqual(removed, ["X", "Y"], "released and cooling");
    assert.deepEqual(l.editableSeatIds(KICKED, removed), ["A", "B", "O"]);
    // The owner (the signer) is never removed, even listed as cooling.
    assert.deepEqual(
      l.serverRemovedSeatIds(
        {
          ...KICKED,
          seats: [{ user_id: "A" }],
          cooling: [cool("O"), cool("X")],
        },
        "O",
      ),
      ["X"],
      "B is only absent (N3): not removed",
    );
    // Nothing removed: the editable seats are the signed list's.
    const all = {
      list: { body: SIGNED },
      seats: ["A", "B", "O", "X", "Y"].map((user_id) => ({ user_id })),
    };
    assert.deepEqual(l.serverRemovedSeatIds(all, "O"), []);
    assert.deepEqual(l.editableSeatIds(all, []), ["A", "B", "O", "X", "Y"]);
    // A refusal's ids count while the list names them, even over a stale
    // read that still shows the seat; never an id the list doesn't name.
    assert.deepEqual(l.serverRemovedSeatIds(all, "O", ["B", "Z", "O"]), ["B"]);
    // Unreadable reads never leave anyone off.
    assert.deepEqual(
      l.serverRemovedSeatIds({ list: { body: SIGNED }, seats: null }, "O"),
      [],
    );
    assert.deepEqual(
      l.serverRemovedSeatIds({ list: null, seats: [{ user_id: "A" }] }, "O"),
      [],
    );
    assert.deepEqual(
      l.serverRemovedSeatIds({ list: { body: "nope" }, seats: [] }, "O"),
      [],
    );
    // Wiring: the picker's `current` is the editable list, the removed set
    // comes from the shown seats plus the remembered refusal.
    assert.match(PAGE_BODY, /current: editableIds\(\),/);
    // C-SET4: the picker also learns who is removed, before any refusal.
    assert.match(
      PAGE_BODY,
      /onConfirm: \(userIds\) => runSetSeats\(userIds, true\),\s*removed: removedIds\(\),/,
    );
    assert.doesNotMatch(PAGE_BODY, /current: currentSeatIds\(/);
    assert.doesNotMatch(
      PAGE,
      /\bcurrentSeatIds\(/,
      "the page never edits from the raw signed list",
    );
    assert.match(
      PAGE_BODY,
      /return s === null \? \[\] : editableSeatIds\(s, removedIds\(\)\);/,
    );
    assert.match(
      PAGE_BODY,
      /const reported = refusedFor\(refused\(\), props\.channel\.id, s\.list\?\.body\);\s*return serverRemovedSeatIds\(s, owner, reported\);/,
    );
  });

  it("S13 Remove seat never names another server-removed user (C-SET2)", async () => {
    const l = await listRules;
    const removed = l.serverRemovedSeatIds(KICKED, "O");
    // Two removed users: the old base (the signed list) re-sent both.
    assert.deepEqual(
      l.seatsAfterRemoval(l.editableSeatIds(KICKED, removed), "O", "A"),
      ["O", "B"],
    );
    assert.equal(
      l.seatsAfterRemoval(l.editableSeatIds(KICKED, removed), "O", "X"),
      null,
      "a removed user has no Remove of their own",
    );
    // They show read-only: never as seated rows, never with Remove.
    assert.deepEqual(
      l.seatRows(KICKED.seats, "O", removed).map((r) => r.userId),
      ["O", "A", "B"],
    );
    const staleRows = [{ user_id: "O" }, { user_id: "A" }, { user_id: "X" }];
    assert.deepEqual(
      l.seatRows(staleRows, "O", ["X", "O"]).map((r) => r.userId),
      ["O", "A"],
      "a stale row of a removed user is hidden; the owner never is",
    );
    assert.match(
      LIST_BODY,
      /seatRows\(props\.seats\.seats, props\.ownerId, props\.removed\)/,
    );
    const from = LIST_BODY.indexOf("<Show when={props.removed.length > 0}>");
    const to = LIST_BODY.indexOf("</Show>", LIST_BODY.indexOf("</For>", from));
    assert.ok(from !== -1 && to > from, "removed group missing");
    const group = LIST_BODY.slice(from, to);
    assert.match(group, /<For each=\{props\.removed\}>/);
    assert.doesNotMatch(group, /onRemove|<Button|setConfirmId/, "read-only");
    assert.match(PAGE_BODY, /removed=\{removedIds\(\)\}/);
  });

  it("S14 a removed-users refusal leaves exactly those off; never resubmits (C-SET3)", async () => {
    const p = await pageRules;
    const ui = {
      kind: "notice",
      notice: "seat_list_names_removed_users",
      max: null,
      tag: "SeatListNamesRemovedUsers",
      users: ["X", "", 5, "Y"],
    };
    assert.deepEqual(p.removedUsersOfRefusal(ui), ["X", "Y"]);
    assert.deepEqual(p.removedUsersOfRefusal({ ...ui, users: undefined }), []);
    assert.equal(
      p.removedUsersOfRefusal({ ...ui, notice: "network_error" }),
      null,
    );
    assert.equal(
      p.removedUsersOfRefusal({ kind: "none", tag: "Declined" }),
      null,
    );
    assert.equal(p.removedUsersOfRefusal(null), null);
    // The remembered ids apply to the same channel and signed list only.
    const r = { channelId: "C", listBody: SIGNED, users: ["X"] };
    assert.deepEqual(p.refusedFor(r, "C", SIGNED), ["X"]);
    assert.deepEqual(p.refusedFor(r, "C2", SIGNED), []);
    assert.deepEqual(p.refusedFor(r, "C", `${SIGNED}\n`), [], "newer list");
    assert.deepEqual(p.refusedFor(r, "C", undefined), []);
    assert.deepEqual(p.refusedFor(null, "C", SIGNED), []);
    // The re-read only replaces the seat rows of the very snapshot it was
    // read over, with the same signed list; a newer snapshot wins.
    const snap = { list: { body: SIGNED }, seats: [{ user_id: "X" }] };
    const body = { list: { body: SIGNED }, seats: [] };
    assert.equal(p.seatsOver(snap, { basis: snap, body }), body);
    assert.equal(p.seatsOver(snap, null), snap);
    assert.equal(p.seatsOver(snap, { basis: { ...snap }, body }), snap);
    assert.equal(
      p.seatsOver(snap, {
        basis: snap,
        body: { ...body, list: { body: `${SIGNED}x` } },
      }),
      snap,
      "a different signed list is never adopted",
    );
    const unlisted = { list: null, seats: [] };
    assert.equal(
      p.seatsOver(unlisted, {
        basis: unlisted,
        body: { list: null, seats: [{ user_id: "X" }] },
      }),
      unlisted,
      "no signed list: nothing to scope the re-read to",
    );
    // Wiring: noted on the refusal path, then the error; no resubmission
    // anywhere on it.
    assert.match(
      PAGE_BODY,
      /\} catch \(err\) \{\s*noteRemovedRefusal\(err, listBody\);\s*setError\(errorText\(err\)\);\s*if \(rethrow\) throw err;\s*return;\s*\}/,
    );
    assert.match(PAGE_BODY, /const listBody = seats\(\)\?\.list\?\.body;/);
    const note = pageFn("noteRemovedRefusal");
    assert.match(
      note,
      /const users = removedUsersOfRefusal\(errorUiOf\(err\)\);/,
    );
    assert.match(
      note,
      /setRefused\(\{ channelId: props\.channel\.id, listBody, users \}\);\s*void refreshSeatsAfterRefusal\(\);/,
    );
    const refresh = pageFn("refreshSeatsAfterRefusal");
    for (const [tag, src] of [
      ["noteRemovedRefusal", note],
      ["refreshSeatsAfterRefusal", refresh],
    ] as const) {
      assert.doesNotMatch(
        src,
        /runSetSeats|setSeats|\.protect\(|openSeatPicker|removeSeat|onConfirm/,
        `${tag} must never resubmit`,
      );
    }
    assert.equal(
      (PAGE_BODY.match(/\bapi\.setSeats\(/g) ?? []).length,
      1,
      "one setSeats call site",
    );
    assert.equal(
      (PAGE_BODY.match(/\brunSetSeats\(/g) ?? []).length,
      3,
      "runSetSeats: its declaration, the picker's onConfirm, Remove seat",
    );
    // The re-read is the page's one read-only GET, over the snapshot.
    assert.match(refresh, /await fetchSeatsBody\(\);/);
    assert.match(
      refresh,
      /if \(generation !== freshGeneration \|\| snapshot\(\) !== basis\) return;/,
    );
    assert.match(
      PAGE_BODY,
      /if \(isProtected\(\) && snap !== null\) return seatsOver\(snap, fresh\(\)\);/,
    );
  });

  it("S15 removal needs positive evidence; Remove seat names who else is dropped (C-N3a/b)", async () => {
    const l = await listRules;
    // C-N3a: absent from the owner's read only: still editable, so the
    // owner never signs them away on the server's silence.
    assert.deepEqual(l.serverRemovedSeatIds(ABSENT, "O"), []);
    assert.deepEqual(l.editableSeatIds(ABSENT, []), ["A", "B", "O", "X", "Y"]);
    assert.deepEqual(
      l.serverRemovedSeatIds({ list: { body: SIGNED }, seats: [] }, "O"),
      [],
      "an empty seats read removes nobody",
    );
    // C-N3b: released and cooling is evidence; so is a same-list refusal.
    assert.deepEqual(
      l.serverRemovedSeatIds({ ...ABSENT, cooling: [cool("X")] }, "O"),
      ["X"],
    );
    assert.deepEqual(l.serverRemovedSeatIds(ABSENT, "O", ["Y"]), ["Y"]);
    // Contradictions and junk never count: active AND cooling, cooling but
    // not on the list, malformed rows.
    assert.deepEqual(
      l.serverRemovedSeatIds(
        { ...KICKED, seats: [...KICKED.seats, { user_id: "X" }] },
        "O",
      ),
      ["Y"],
    );
    assert.deepEqual(
      l.serverRemovedSeatIds(
        { ...ABSENT, cooling: [cool("Z"), { user_id: 5 }, null] },
        "O",
      ),
      [],
    );
    assert.match(
      LIST,
      /const released = cooling\.has\(id\) && !active\.has\(id\);\s*if \(released \|\| reported\.includes\(id\)\) out\.push\(id\);/,
    );
    // Disclosure: Remove seat for A also drops X and Y here; nobody else
    // when nothing is removed. Same inputs as the page's submission.
    assert.deepEqual(l.leftOffBesides(KICKED, "O", ["X", "Y"], "A"), [
      "X",
      "Y",
    ]);
    assert.deepEqual(l.leftOffBesides(ABSENT, "O", [], "A"), []);
    assert.deepEqual(l.leftOffBesides(KICKED, "O", ["X", "Y"], "O"), []);
    const from = LIST_BODY.indexOf("const confirm = (");
    const to = LIST_BODY.indexOf("</Confirm>", from);
    const block = LIST_BODY.slice(from, to);
    assert.match(
      block,
      /<Show when=\{leftOff\(row\.userId\)\}>\s*\{\(line\) => <span data-left-off>\{line\(\)\}<\/span>\}\s*<\/Show>/,
    );
    assert.match(
      LIST_BODY,
      /const ids = leftOffBesides\(\s*props\.seats,\s*props\.ownerId,\s*props\.removed,\s*target,\s*\);/,
    );
    assert.match(
      LIST_BODY,
      /const leftOffLine = \(names: string\) =>\s*t`Will be left off the seat list: \$\{names\}`;/,
    );
    // The page submits exactly what the disclosure describes.
    assert.match(
      PAGE_BODY,
      /seatsAfterRemoval\(editableIds\(\), owner, userId\)/,
    );
    assert.match(PAGE_BODY, /removed=\{removedIds\(\)\}/);
  });
});

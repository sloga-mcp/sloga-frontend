// Spec for the account page's protected-servers warning (S2-D43, W4-3 lane
// U14), run with Node's built-in runner from packages/client:
//   node --conditions=browser --test \
//     components/app/interface/settings/user/account.scan.test.ts
//
// Account.tsx imports Solid, lingui and the UI kit, so Node cannot load it.
// The count rule sits in one marked region (`// protected-pure:begin` ..
// `// protected-pure:end`) with no imports; this spec cuts it out, strips
// the types with Node's own stripper and runs the real source. The wiring
// is checked by scanning the component with comments removed.
//
//  A1  only servers this user owns count (`ownerId === self`); an unknown
//      self counts nothing;
//  A2  only servers with at least one protected channel count;
//  A3  each server counts once, however many protected channels it has;
//  A4  the count reads the client cache: every cached server, the own user
//      id, and `client.isProtectedChannel` (server flag or this device's
//      pin), never the bare server flag;
//  A5  the warning is hidden at 0 and shows the count through `<Plural>`;
//  A6  no request: the warning and the rule never fetch;
//  A7  a count only: no server name or id is rendered;
//  A8  copy and blank-page traps.
//
// Point `ACCOUNT_PAGE_FILE` at another copy (a known-bad control) to check
// that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  process.env.ACCOUNT_PAGE_FILE || join(here, "Account.tsx"),
  "utf8",
);

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

type ServerView = { ownerId: unknown; channelIds?: Iterable<string> | null };
interface Rules {
  ownedProtectedServerCount(
    servers: Iterable<ServerView>,
    selfId: unknown,
    isProtected: (channelId: string) => boolean,
  ): number;
}
const RULE_NAMES = ["ownedProtectedServerCount"] as const;

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
    const dir = mkdtempSync(join(tmpdir(), "s2w43-U14-"));
    const out = join(dir, "accountPure.mjs");
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

/** Whitespace-insensitive: every run of whitespace is one space. */
function flat(s: string): string {
  return s.replace(/\s+/g, " ");
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** The warning component: from its declaration to the next top-level item. */
function warningBody(): string {
  const from = source.indexOf("function ProtectedOwnedWarning(");
  assert.ok(from !== -1, "ProtectedOwnedWarning missing");
  const to = source.indexOf("\n}\n", from);
  assert.ok(to > from, "ProtectedOwnedWarning has no end");
  return code(source.slice(from, to + 2));
}

/** The pure region, comments removed. */
function regionCode(): string {
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  assert.ok(from !== -1 && to > from, "protected-pure region missing");
  return code(source.slice(from, to));
}

const CODE = code(source);
const WARNING = warningBody();
const FLAT_WARNING = flat(WARNING);

const SELF = "01SELF";
const OTHER = "01OTHER";
const PROTECTED = new Set(["p1", "p2", "p3", "pinned"]);
const isProt = (id: string) => PROTECTED.has(id);

test("A1 only servers this user owns count; an unknown self counts nothing", async () => {
  const { ownedProtectedServerCount: n } = await loadRules();
  // someone else's server with a protected channel never counts
  assert.equal(n([{ ownerId: OTHER, channelIds: ["p1"] }], SELF, isProt), 0);
  assert.equal(
    n(
      [
        { ownerId: OTHER, channelIds: ["p1"] },
        { ownerId: SELF, channelIds: ["p2"] },
        { ownerId: OTHER, channelIds: ["p3", "t1"] },
      ],
      SELF,
      isProt,
    ),
    1,
  );
  // an owner id that differs only by case or whitespace is someone else
  assert.equal(
    n(
      [
        { ownerId: SELF.toLowerCase(), channelIds: ["p1"] },
        { ownerId: ` ${SELF}`, channelIds: ["p1"] },
      ],
      SELF,
      isProt,
    ),
    0,
  );
  // an unknown self never matches an absent owner id
  for (const self of [undefined, null, "", 0]) {
    assert.equal(
      n(
        [
          { ownerId: undefined, channelIds: ["p1"] },
          { ownerId: null, channelIds: ["p1"] },
          { ownerId: "", channelIds: ["p1"] },
          { ownerId: 0, channelIds: ["p1"] },
        ],
        self,
        isProt,
      ),
      0,
      `self ${String(self)}`,
    );
  }
});

test("A2 only servers with at least one protected channel count", async () => {
  const { ownedProtectedServerCount: n } = await loadRules();
  assert.equal(
    n([{ ownerId: SELF, channelIds: ["t1", "t2"] }], SELF, isProt),
    0,
  );
  assert.equal(n([{ ownerId: SELF, channelIds: [] }], SELF, isProt), 0);
  assert.equal(n([{ ownerId: SELF }], SELF, isProt), 0);
  assert.equal(n([{ ownerId: SELF, channelIds: null }], SELF, isProt), 0);
  assert.equal(
    n(
      [
        { ownerId: SELF, channelIds: ["t1"] },
        { ownerId: SELF, channelIds: ["t2", "pinned"] },
        { ownerId: SELF, channelIds: ["t3"] },
      ],
      SELF,
      isProt,
    ),
    1,
  );
  // only a strict `true` from the check counts
  const truthy = (() => 1) as unknown as (id: string) => boolean;
  assert.equal(n([{ ownerId: SELF, channelIds: ["x"] }], SELF, truthy), 0);
  // the check is asked about the server's own channel ids
  const asked: string[] = [];
  n([{ ownerId: SELF, channelIds: new Set(["t1", "t2"]) }], SELF, (id) => {
    asked.push(id);
    return false;
  });
  assert.deepEqual(asked, ["t1", "t2"]);
});

test("A3 each server counts once, however many protected channels it has", async () => {
  const { ownedProtectedServerCount: n } = await loadRules();
  assert.equal(
    n([{ ownerId: SELF, channelIds: ["p1", "p2", "p3"] }], SELF, isProt),
    1,
  );
  assert.equal(
    n(
      [
        { ownerId: SELF, channelIds: ["p1", "p2"] },
        { ownerId: SELF, channelIds: new Set(["t1", "p3", "pinned"]) },
        { ownerId: SELF, channelIds: ["t2"] },
      ],
      SELF,
      isProt,
    ),
    2,
  );
});

test("A4 the count reads the client cache and the pin-aware protected check", () => {
  assert.match(
    FLAT_WARNING,
    /const protectedOwned = createMemo\(\(\) => ownedProtectedServerCount\( client\(\)\.servers\.toList\(\), client\(\)\.user\?\.id, \(channelId\) => client\(\)\.isProtectedChannel\(channelId\), \), \);/,
  );
  assert.equal(count(CODE, "ownedProtectedServerCount("), 2, "one call");
  // never the bare server flag (it drops this device's pins)
  assert.doesNotMatch(WARNING, /\.isProtected\b/);
  assert.doesNotMatch(regionCode(), /\.isProtected\b|\.protected\b/);
});

test("A5 the warning is hidden at 0 and shows the count through Plural", () => {
  assert.match(
    FLAT_WARNING,
    /return \( <Show when=\{protectedOwned\(\) > 0\}> <ProtectedOwnedNote role="note"> <Plural value=\{protectedOwned\(\)\} /,
  );
  assert.equal(count(WARNING, "<Show"), 1);
  assert.equal(count(WARNING, "<Plural"), 1);
  // the page renders the warning once, after the deletion controls
  const page = flat(
    code(source.slice(0, source.indexOf("function EditAccount("))),
  );
  assert.match(
    page,
    /<ManageAccount \/> <ProtectedOwnedWarning \/> <\/Column>/,
  );
  assert.equal(count(CODE, "<ProtectedOwnedWarning />"), 1);
});

test("A6 no request: the warning and the rule never fetch", () => {
  const network =
    /\bfetch\w*\(|\.api\b|\bawait\b|\basync\b|\.then\(|createResource|createQuery|useQuery|XMLHttpRequest|WebSocket|\bresources\b/;
  assert.doesNotMatch(WARNING, network);
  assert.doesNotMatch(regionCode(), network);
  // the component's only reads of the client are the three cache reads
  assert.deepEqual(
    [...WARNING.matchAll(/client\(\)\.([\w.?]+)/g)].map((m) => m[1]),
    ["servers.toList", "user?.id", "isProtectedChannel"],
  );
});

test("A7 a count only: no server name or id is rendered", () => {
  const jsx = WARNING.slice(WARNING.indexOf("return ("));
  assert.doesNotMatch(jsx, /\.name\b|\.id\b|ownerId|channelIds|\.servers\b/);
  // the Plural's only value is the count
  assert.equal(count(jsx, "value="), 1);
  assert.match(flat(jsx), /value=\{protectedOwned\(\)\}/);
});

test("A8 D43 copy through Plural; string-tag styled only", () => {
  assert.match(
    FLAT_WARNING,
    /<Plural value=\{protectedOwned\(\)\} one="You own # server with protected channels\. Delete it or transfer it before deleting your account\. Deleting a server deletes its protected channels for everyone\." other="You own # servers with protected channels\. Delete or transfer them before deleting your account\. Deleting a server deletes its protected channels for everyone\." \/>/,
  );
  assert.match(
    CODE,
    /import \{ Plural, Trans \} from "@lingui-solid\/solid\/macro";/,
  );
  assert.doesNotMatch(CODE, /styled\((?!"div")/);
  assert.match(CODE, /const ProtectedOwnedNote = styled\("div", \{/);
  assert.doesNotMatch(CODE, /use:floating/);
});

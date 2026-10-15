// Unit spec for the shared import screens (`ImportShell.tsx`) and the
// Discord modal's kind filter (`ImportDiscord.tsx`). Run from
// packages/client:
//   node --test --conditions=browser components/modal/modals/importShell.test.ts
//
// `node --test` cannot load either file (Solid JSX, lingui macros), so the
// decisions under test are written as plain-JavaScript function bodies and
// this spec lifts each body out of the source TEXT and runs it, with a stand-in
// for lingui's `t` that returns the message with its values filled in. The
// copy asserted below is therefore the copy in the file, byte for byte.
//
// What this cannot see: whether the JSX renders these functions where it
// should. The source pins at the bottom cover the wiring that matters most.
//
// IMPORT_SHELL_FILE / IMPORT_DISCORD_FILE point the spec at another copy of
// either file (used to prove it fails on a known-bad one).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SHELL_FILE =
  process.env.IMPORT_SHELL_FILE ??
  new URL("./ImportShell.tsx", import.meta.url).pathname;
const DISCORD_FILE =
  process.env.IMPORT_DISCORD_FILE ??
  new URL("./ImportDiscord.tsx", import.meta.url).pathname;
const CATALOG_FILE = new URL(
  "../../i18n/catalogs/en/messages.po",
  import.meta.url,
).pathname;

const shell = readFileSync(SHELL_FILE, "utf8");
const discord = readFileSync(DISCORD_FILE, "utf8");

/**
 * The text inside the ONE block `head` opens (`head` ends with its `{`),
 * skipping strings, template literals and comments while matching braces.
 */
function blockAfter(file: string, source: string, head: string): string {
  const found = source.split(head).length - 1;
  assert.equal(
    found,
    1,
    `${file} must contain this once, found ${found}:\n${head}`,
  );
  const open = source.indexOf(head) + head.length - 1;
  assert.equal(source[open], "{", `${file}: head must end with "{"`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") j++;
        j++;
      }
      i = j;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail(`${file}: the block after this head is never closed:\n${head}`);
}

/** Stand-in for lingui's `t`: the message with its values filled in. */
function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce(
    (out, part, i) => out + part + (i < values.length ? String(values[i]) : ""),
    "",
  );
}

type StageLabel = (stage: string, kind?: string) => string;
type ErrorMessage = (
  type: string | undefined,
  source: string,
) => string | undefined;

const stageLabel = new Function(
  "t",
  "stage",
  "kind",
  blockAfter(
    SHELL_FILE,
    shell,
    "return (stage: string, kind?: string): string => {",
  ),
).bind(null, t) as StageLabel;

const errorMessage = new Function(
  "t",
  "type",
  "source",
  blockAfter(
    SHELL_FILE,
    shell,
    "return (type: string | undefined, source: string): string | undefined => {",
  ),
).bind(null, t) as ErrorMessage;

const isDiscordJobKind = new Function(
  "kind",
  blockAfter(
    DISCORD_FILE,
    discord,
    "function isDiscordJobKind(kind: string | undefined): boolean {",
  ),
) as (kind: string | undefined) => boolean;

// ----------------------------------------------------------------- stages --

test("Template Fetching keeps the Discord copy, byte for byte", () => {
  assert.equal(
    stageLabel("Fetching", "Template"),
    "Reading the Discord template…",
  );
});

test("StoatServer Fetching reads the Stoat server", () => {
  assert.equal(
    stageLabel("Fetching", "StoatServer"),
    "Reading your Stoat server…",
  );
});

test("other or missing kinds get the neutral Fetching copy", () => {
  for (const kind of [
    "FluxerServer",
    "MatrixSpace",
    "Stickers",
    "Bogus",
    undefined,
  ])
    assert.equal(
      stageLabel("Fetching", kind),
      "Reading the source server…",
      `kind ${String(kind)}`,
    );
});

test("the new stages have copy", () => {
  assert.equal(stageLabel("Verifying"), "Checking your verification code…");
  assert.equal(stageLabel("Assets", "StoatServer"), "Copying icons and emoji…");
});

test("the Discord stages keep their copy whatever the kind", () => {
  const discordStages: [string, string][] = [
    ["Server", "Creating your server…"],
    ["Roles", "Recreating roles and permissions…"],
    ["Channels", "Recreating channels…"],
    ["Membership", "Setting you up as the owner…"],
    ["Invite", "Generating an invite…"],
    ["Stickers", "Importing stickers…"],
    ["Done", "Finishing up…"],
    ["", "Waiting for a worker…"],
  ];
  for (const kind of ["Template", "Stickers", "StoatServer", undefined])
    for (const [stage, label] of discordStages)
      assert.equal(
        stageLabel(stage, kind),
        label,
        `${stage} / ${String(kind)}`,
      );
});

test("an unknown stage falls back to its raw value", () => {
  assert.equal(stageLabel("Teleporting", "Template"), "Teleporting");
  assert.equal(stageLabel("verifying"), "verifying");
});

// ----------------------------------------------------------------- errors --

test("the existing shared error copy is unchanged", () => {
  assert.equal(
    errorMessage("ImportAlreadyInProgress", "Discord"),
    "You already have an import running. Wait for it to finish before starting another.",
  );
  assert.equal(
    errorMessage("TooManyServers", "Discord"),
    "You've reached the maximum number of servers you can be in.",
  );
});

test("the five new error types each have their own copy", () => {
  const types = [
    "ImportSourceNotFound",
    "ImportVerificationMissing",
    "ImportBotNotInServer",
    "ImportUpstreamUnavailable",
    "ImportSourceUnavailable",
  ];
  const copy = types.map((type) => errorMessage(type, "Stoat"));
  for (const [i, message] of copy.entries())
    assert.ok(message && message.length > 0, `${types[i]} has no copy`);
  assert.equal(new Set(copy).size, types.length, "two types share copy");
  assert.equal(
    errorMessage("ImportUpstreamUnavailable", "Stoat"),
    "We couldn't reach Stoat right now. Try again in a few minutes.",
  );
  assert.equal(
    errorMessage("ImportSourceUnavailable", "Fluxer"),
    "Importing from Fluxer is not available right now.",
  );
  assert.equal(
    errorMessage("ImportSourceNotFound", "Stoat"),
    "We couldn't find that server on Stoat. Check the link and try again.",
  );
});

test("source-specific and unknown types are left to the caller", () => {
  for (const type of [
    "InvalidOperation",
    "OperationFailed",
    "Bogus",
    undefined,
  ])
    assert.equal(errorMessage(type, "Discord"), undefined, String(type));
});

// ------------------------------------------------------ Discord kind gate --

test("the Discord modal shows Template, Sticker and kind-less jobs only", () => {
  assert.equal(isDiscordJobKind(undefined), true);
  assert.equal(isDiscordJobKind("Template"), true);
  assert.equal(isDiscordJobKind("Stickers"), true);
  for (const kind of [
    "StoatServer",
    "FluxerServer",
    "MatrixSpace",
    "Bogus",
    "",
  ])
    assert.equal(isDiscordJobKind(kind), false, kind);
});

test("source pin: the Discord modal reads the store only through the kind gate", () => {
  // Once in the import list, once in the filtered `view`. A second read
  // anywhere else would see another source's job.
  assert.equal(
    discord.split("discordImportView").length - 1,
    2,
    `${DISCORD_FILE} must name discordImportView exactly twice`,
  );
  const view = blockAfter(DISCORD_FILE, discord, "const view = () => {");
  assert.ok(
    view.includes("discordImportView()") &&
      view.includes("isDiscordJobKind(current.kind) ? current : undefined"),
    `${DISCORD_FILE}: view() must filter the store by isDiscordJobKind`,
  );
});

// ------------------------------------------------------------------ copy --

test("every moved msgid still resolves in the en catalog", () => {
  // lingui renders a msgid missing from the catalog as its HASH, so a moved
  // string must stay byte-identical (JSX text is compared with its line
  // breaks collapsed, as lingui extracts it).
  const catalog = readFileSync(CATALOG_FILE, "utf8");
  const flat = shell.replace(/\s*\n\s*/g, " ");
  const moved = [
    "Reading the Discord template…",
    "Creating your server…",
    "Recreating roles and permissions…",
    "Recreating channels…",
    "Setting you up as the owner…",
    "Generating an invite…",
    "Importing stickers…",
    "Finishing up…",
    "Waiting for a worker…",
    "You can close this — the import keeps going and we'll let you know when it's ready.",
    "Streamer Mode is hiding your invite link — hover over it to reveal.",
    "Notes",
    "The import didn't finish.",
    "You already have an import running. Wait for it to finish before starting another.",
    "You've reached the maximum number of servers you can be in.",
  ];
  for (const msgid of moved) {
    assert.ok(flat.includes(msgid), `${SHELL_FILE} lost: ${msgid}`);
    assert.ok(
      catalog.includes(`\nmsgid "${msgid}"\n`),
      `catalog lacks: ${msgid}`,
    );
  }
  // The summary line is a `t` template; lingui numbers its placeholders.
  assert.ok(
    shell.includes(
      "t`Created ${props.summary!.channels_created} channels, ${props.summary!.categories_created} categories and ${props.summary!.roles_created ?? 0} roles.`",
    ),
  );
  assert.ok(
    catalog.includes(
      '\nmsgid "Created {0} channels, {1} categories and {2} roles."\n',
    ),
  );
});

// Unit spec for the Discord import modal's handling of a start request that
// collides with an import already running (`ImportAlreadyInProgress`). Run
// from packages/client:
//   node --test --conditions=browser components/modal/modals/importDiscordCollision.test.ts
//
// The modal adopts the job it collided with. A Discord job then shows its
// progress, as before; another platform's job cannot show in this modal, so
// the explain screen names its source and offers "View it", which opens
// `import_source` on that source.
//
// `node --test` cannot load `ImportDiscord.tsx` (Solid JSX, lingui macros),
// so `adoptCollidedJob` is written as a plain-JavaScript body and this spec
// lifts it out of the source TEXT and runs it with stubs (a stand-in for
// lingui's `t` fills in the values, so the asserted copy is the copy in the
// file). The source pins cover the wiring around it.
//
// IMPORT_DISCORD_FILE points the spec at another copy of the file (used to
// prove it fails on a known-bad one).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const DISCORD_FILE =
  process.env.IMPORT_DISCORD_FILE ??
  new URL("./ImportDiscord.tsx", import.meta.url).pathname;

const discord = readFileSync(DISCORD_FILE, "utf8");

/**
 * The text inside the ONE block `head` opens (`head` ends with its `{`),
 * skipping strings, template literals and comments while matching braces.
 * Same walker as `importShell.test.ts`.
 */
function blockAfter(head: string): string {
  const found = discord.split(head).length - 1;
  assert.equal(
    found,
    1,
    `${DISCORD_FILE} must contain this once, found ${found}:\n${head}`,
  );
  const open = discord.indexOf(head) + head.length - 1;
  assert.equal(discord[open], "{", "head must end with '{'");
  let depth = 0;
  for (let i = open; i < discord.length; i++) {
    const c = discord[i];
    if (c === "/" && discord[i + 1] === "/") {
      i = discord.indexOf("\n", i);
      if (i === -1) break;
    } else if (c === "/" && discord[i + 1] === "*") {
      i = discord.indexOf("*/", i + 2) + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < discord.length && discord[j] !== c) {
        if (discord[j] === "\\") j++;
        j++;
      }
      i = j;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return discord.slice(open + 1, i);
  }
  assert.fail(`${DISCORD_FILE}: the block after this head is never closed`);
}

/** Stand-in for lingui's `t`: the message with its values filled in. */
function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce(
    (out, part, i) => out + part + (i < values.length ? String(values[i]) : ""),
    "",
  );
}

/** Stand-in for the store's `sourceLabel`. */
const LABELS: Record<string, string> = {
  stoat: "Stoat",
  fluxer: "Fluxer",
  matrix: "Matrix",
};

/**
 * Run `adoptCollidedJob` with the store holding a job of `source` (or a
 * Discord job, for `undefined`) once the resume lands.
 */
async function adopt(source: string | undefined) {
  const resumed: unknown[] = [];
  const errors: (string | undefined)[] = [];
  const others: (string | undefined)[] = [];
  let storeSource: string | undefined = "never-read-before-resume";
  const props = { client: { id: "client" } };

  new Function(
    "t",
    "props",
    "resumeDiscordImport",
    "trackedImportSource",
    "importSourceLabel",
    "setOtherSource",
    "setStartError",
    blockAfter("  function adoptCollidedJob() {"),
  )(
    t,
    props,
    async (client: unknown) => {
      resumed.push(client);
      storeSource = source;
      return undefined;
    },
    () => storeSource,
    (key: string) => LABELS[key],
    (value: string | undefined) => others.push(value),
    (value: string | undefined) => errors.push(value),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { resumed, errors, others, props };
}

test("a collided Discord job is adopted and nothing else changes", async () => {
  const { resumed, errors, others, props } = await adopt(undefined);
  assert.deepEqual(resumed, [props.client]);
  assert.deepEqual(errors, [], "the generic error stays as it was");
  assert.deepEqual(others, []);
});

test("a collided other-platform job names its source", async () => {
  for (const [source, label] of Object.entries(LABELS)) {
    const { resumed, errors, others, props } = await adopt(source);
    assert.deepEqual(resumed, [props.client]);
    assert.deepEqual(others, [source]);
    assert.deepEqual(errors, [
      `You already have an import from ${label} running.`,
    ]);
  }
});

test("source pin: both start paths adopt through adoptCollidedJob", () => {
  // `resumeDiscordImport(` is called in exactly one place: inside
  // adoptCollidedJob. A bare call elsewhere would skip the source check.
  assert.equal(
    discord.split("resumeDiscordImport(").length - 1,
    1,
    "resumeDiscordImport( must appear once",
  );
  assert.ok(
    discord.includes(
      'if (type === "ImportAlreadyInProgress") adoptCollidedJob();',
    ),
    "start() must adopt through adoptCollidedJob",
  );
  const stickers = blockAfter(
    "  async function startStickers(parentJobId: string) {",
  );
  assert.ok(
    /case "ImportAlreadyInProgress":[^]*?adoptCollidedJob\(\);\s*break;/.test(
      stickers,
    ),
    "startStickers() must adopt through adoptCollidedJob",
  );
  // Each attempt starts with no stale source notice.
  const start = blockAfter("  async function start() {");
  for (const block of [start, stickers])
    assert.ok(block.includes("setOtherSource(undefined);"));
});

test("source pin: View it shows only after a collision and opens import_source", () => {
  const explain = discord.slice(
    discord.indexOf('case "explain":'),
    discord.indexOf('case "importing":'),
  );
  assert.ok(
    /\.\.\.\(otherSource\(\)\s*\?\s*\[\s*\{\s*text: <Trans>View it<\/Trans>/.test(
      explain,
    ),
    "the View it action must be gated on otherSource()",
  );
  assert.ok(
    explain.includes(`openModal({
                      type: "import_source",
                      client: props.client,
                      source: otherSource(),
                    });`),
    "View it must open import_source on the collided source",
  );
  // Cancel stays first and Start import stays the last action.
  assert.ok(
    explain.indexOf("<Trans>Cancel</Trans>") <
      explain.indexOf("<Trans>View it</Trans>") &&
      explain.indexOf("<Trans>View it</Trans>") <
        explain.indexOf("<Trans>Start import</Trans>"),
  );
});

// Unit spec for the "Import a server" modal (`ImportSource.tsx`), the pure
// entry-point helpers it shares with the create/join fan-outs
// (`importEntry.ts`), and those fan-outs' import action. Run from
// packages/client:
//   node --test --conditions=browser components/modal/modals/importSource.test.ts
//
// `node --test` cannot load the modal (Solid JSX, lingui macros), so its
// decisions are written as plain-JavaScript function bodies and this spec
// lifts each body out of the source TEXT and runs it with stubs, the
// approach `importShell.test.ts` takes. A stand-in for lingui's `t` fills in
// the values, so the asserted copy is the copy in the file. Where the modal
// calls into the shared screens or the store, the spec lifts the REAL body
// from `ImportShell.tsx` / `discordImport.ts` instead of stubbing it, so the
// seams are tested against the code on the other side.
//
// What this cannot see: whether the JSX renders these functions where it
// should. The source pins at the bottom cover the wiring that matters most.
//
// IMPORT_SOURCE_FILE points the spec at another copy of the modal,
// IMPORT_ENTRY_FILE at another copy of `importEntry.ts`, and
// IMPORT_FANOUT_FILES (colon-separated) at other copies of the two fan-outs
// (used to prove it fails on a known-bad one).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SOURCE_FILE =
  process.env.IMPORT_SOURCE_FILE ??
  new URL("./ImportSource.tsx", import.meta.url).pathname;
const ENTRY_FILE =
  process.env.IMPORT_ENTRY_FILE ??
  new URL("./importEntry.ts", import.meta.url).pathname;
const FANOUT_FILES = process.env.IMPORT_FANOUT_FILES?.split(":") ?? [
  new URL("./CreateOrJoinServer.tsx", import.meta.url).pathname,
  new URL("./CreateGroupOrServer.tsx", import.meta.url).pathname,
];
const SHELL_FILE = new URL("./ImportShell.tsx", import.meta.url).pathname;
const STORE_FILE = new URL("../../client/discordImport.ts", import.meta.url)
  .pathname;

const modal = readFileSync(SOURCE_FILE, "utf8");
const shell = readFileSync(SHELL_FILE, "utf8");
const store = readFileSync(STORE_FILE, "utf8");

const { importActionFor, pickerEntries } = (await import(
  pathToFileURL(ENTRY_FILE).href
)) as typeof import("./importEntry.ts");

/**
 * The text inside the ONE block `head` opens (`head` ends with its `{`),
 * skipping strings, template literals and comments while matching braces.
 * Same walker as `importShell.test.ts`.
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

const modalBlock = (head: string) => blockAfter(SOURCE_FILE, modal, head);

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
const sourceLabel = (source: string) => LABELS[source];

type Job = { status: string; kind?: string; jobId?: string };

// ------------------------------------------------- real bodies, other side --

/** The store's `kindToSource`, lifted from `discordImport.ts`. */
const kindToSource = new Function(
  "kind",
  blockAfter(
    STORE_FILE,
    store,
    "  kind: string | undefined,\n): ImportSource | undefined {",
  ),
) as (kind: string | undefined) => string | undefined;

/** The shared `importScreen`, lifted from `ImportShell.tsx`. */
const importScreen = new Function(
  "job",
  blockAfter(SHELL_FILE, shell, "): ImportScreen {"),
) as (job: Job | undefined) => string;

/** The shared error copy, lifted from `ImportShell.tsx`. */
const importErrorMessage = new Function(
  "t",
  "type",
  "source",
  blockAfter(
    SHELL_FILE,
    shell,
    "return (type: string | undefined, source: string): string | undefined => {",
  ),
).bind(null, t) as (type: string | undefined, source: string) => string;

// ------------------------------------------------------ the modal's bodies --

const modalScreen = new Function(
  "importScreen",
  "source",
  "job",
  "explainable",
  modalBlock("): SourceModalScreen {"),
).bind(null, importScreen) as (
  source: string | undefined,
  job: Job | undefined,
  explainable: boolean,
) => string;

function hasExplainScreen(
  source: string | undefined,
  enabled: (source: string) => boolean,
) {
  return new Function(
    "importSourceEnabled",
    "source",
    modalBlock(
      "function hasExplainScreen(source: ImportSource | undefined): boolean {",
    ),
  )(enabled, source) as boolean;
}

/** Run the modal's `view()` with the modal on `source` and `job` in store. */
function view(source: string | undefined, job: Job | undefined) {
  return new Function(
    "source",
    "discordImportView",
    "kindToSource",
    modalBlock("  const view = () => {"),
  )(
    () => source,
    () => job,
    kindToSource,
  ) as Job | undefined;
}

const SOURCE_KIND = new Function(
  `return {${modalBlock(
    "const SOURCE_KIND: Record<ImportSource, string> = {",
  )}};`,
)() as Record<string, string>;

const startErrorMessage = new Function(
  "t",
  "importErrorMessage",
  "importSourceLabel",
  "type",
  "wanted",
  modalBlock("    wanted: ImportSource,\n  ): string {"),
).bind(null, t, importErrorMessage, sourceLabel) as (
  type: string | undefined,
  wanted: string,
) => string;

const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<void>;

/**
 * Run `adoptCollidedJob` with `job` in the store once the resume lands.
 * Until then the store holds a job of no known kind, which a read made
 * before the resume would take for a Discord one.
 */
async function adopt(modalSource: string, job: Job | undefined) {
  const resumed: unknown[] = [];
  const errors: (string | undefined)[] = [];
  const collided: (string | undefined)[] = [];
  let stored: Job | undefined = { status: "Running", kind: "never-read" };
  const props = { client: { id: "client" } };

  await new AsyncFunction(
    "t",
    "props",
    "source",
    "resumeDiscordImport",
    "discordImportView",
    "kindToSource",
    "importSourceLabel",
    "setCollided",
    "setStartError",
    modalBlock("  async function adoptCollidedJob() {"),
  )(
    t,
    props,
    () => modalSource,
    async (client: unknown) => {
      resumed.push(client);
      stored = job;
      return undefined;
    },
    () => stored,
    kindToSource,
    sourceLabel,
    (value: string | undefined) => collided.push(value),
    (value: string | undefined) => errors.push(value),
  );
  return { resumed, errors, collided, props };
}

/**
 * Run the modal's `start()` with the given modal state, the start request
 * resolving with `job_id` "job-1" or rejecting with `rejection`.
 */
async function start(opts: {
  source?: string;
  input: string;
  starting?: boolean;
  rejection?: unknown;
}) {
  const requests: [string, string][] = [];
  const tracked: unknown[][] = [];
  const errors: (string | undefined)[] = [];
  const startingLog: boolean[] = [];
  const collided: (string | undefined)[] = [];
  let adopted = 0;

  await new AsyncFunction(
    "props",
    "source",
    "input",
    "starting",
    "setStarting",
    "setStartError",
    "setCollided",
    "trackDiscordImport",
    "SOURCE_KIND",
    "discordImportErrorType",
    "startErrorMessage",
    "adoptCollidedJob",
    modalBlock("  async function start() {"),
  )(
    {
      client: {
        importServer: async (source: string, value: string) => {
          requests.push([source, value]);
          if (opts.rejection !== undefined) throw opts.rejection;
          return { job_id: "job-1" };
        },
      },
    },
    () => opts.source,
    () => opts.input,
    () => opts.starting ?? false,
    (value: boolean) => startingLog.push(value),
    (value: string | undefined) => errors.push(value),
    (value: string | undefined) => collided.push(value),
    (...args: unknown[]) => tracked.push(args),
    SOURCE_KIND,
    // Same as the store's `discordImportErrorType`.
    (error: unknown) =>
      error && typeof error === "object" && "type" in error
        ? typeof (error as { type?: unknown }).type === "string"
          ? (error as { type: string }).type
          : undefined
        : undefined,
    startErrorMessage,
    () => adopted++,
  );
  return { requests, tracked, errors, startingLog, collided, adopted };
}

// ---------------------------------------------------------------- screens --

test("no source is the picker, whatever the store holds", () => {
  assert.equal(modalScreen(undefined, undefined, false), "picker");
  assert.equal(modalScreen(undefined, undefined, true), "picker");
  assert.equal(modalScreen(undefined, { status: "Running" }, true), "picker");
});

test("a job of the source shows its own screen", () => {
  assert.equal(modalScreen("stoat", { status: "Queued" }, true), "importing");
  assert.equal(modalScreen("stoat", { status: "Running" }, true), "importing");
  assert.equal(modalScreen("stoat", { status: "Completed" }, true), "done");
  assert.equal(modalScreen("stoat", { status: "Failed" }, true), "failed");
  // A job is shown even when the source has gone dark since it started.
  assert.equal(
    modalScreen("fluxer", { status: "Running" }, false),
    "importing",
  );
});

test("no job: the explain screen, or a notice when it can't be offered", () => {
  assert.equal(modalScreen("stoat", undefined, true), "explain");
  assert.equal(modalScreen("stoat", undefined, false), "unavailable");
  assert.equal(modalScreen("matrix", undefined, false), "unavailable");
});

test("only Stoat has an explain screen, and only when the instance offers it", () => {
  const on = () => true;
  const off = () => false;
  assert.equal(hasExplainScreen("stoat", on), true);
  assert.equal(hasExplainScreen("stoat", off), false);
  for (const source of ["fluxer", "matrix", undefined])
    assert.equal(hasExplainScreen(source, on), false, String(source));
});

// ---------------------------------------------------------- the kind gate --

test("the modal shows only a job of its own source", () => {
  const stoat = { status: "Running", kind: "StoatServer" };
  assert.equal(view("stoat", stoat), stoat);
  for (const kind of [
    undefined,
    "",
    "Template",
    "Stickers",
    "FluxerServer",
    "MatrixSpace",
    "Bogus",
  ])
    assert.equal(
      view("stoat", { status: "Running", kind }),
      undefined,
      `kind ${String(kind)} must not render on the Stoat modal`,
    );
  assert.equal(view("stoat", undefined), undefined);

  const fluxer = { status: "Completed", kind: "FluxerServer" };
  assert.equal(view("fluxer", fluxer), fluxer);
  assert.equal(view("fluxer", stoat), undefined);
});

test("the picker matches no job, not even a kind-less Discord one", () => {
  for (const kind of [undefined, "Template", "StoatServer"])
    assert.equal(
      view(undefined, { status: "Running", kind }),
      undefined,
      `kind ${String(kind)}`,
    );
});

test("each source tracks with its pinned kind, and the store maps it back", () => {
  assert.equal(SOURCE_KIND.stoat, "StoatServer");
  assert.equal(SOURCE_KIND.fluxer, "FluxerServer");
  assert.equal(SOURCE_KIND.matrix, "MatrixSpace");
  for (const source of Object.keys(LABELS))
    assert.equal(kindToSource(SOURCE_KIND[source]), source, source);
});

// ------------------------------------------------------------------ start --

test("start trims the input and tracks the job with its kind", async () => {
  const run = await start({ source: "stoat", input: "  rvlt.gg/abc \n" });
  assert.deepEqual(run.requests, [["stoat", "rvlt.gg/abc"]]);
  assert.deepEqual(run.tracked, [["job-1", "StoatServer"]]);
  assert.deepEqual(run.startingLog, [true, false]);
  assert.deepEqual(run.errors, [undefined], "only the reset");
  assert.deepEqual(run.collided, [undefined], "only the reset");
  assert.equal(run.adopted, 0);
});

test("start sends nothing for blank input, a second click or no source", async () => {
  for (const opts of [
    { source: "stoat", input: "" },
    { source: "stoat", input: "  \t\n" },
    { source: "stoat", input: "abc", starting: true },
    { source: undefined, input: "abc" },
  ]) {
    const run = await start(opts);
    assert.deepEqual(run.requests, [], JSON.stringify(opts));
    assert.deepEqual(run.tracked, []);
    assert.deepEqual(run.startingLog, []);
  }
});

test("a failed start shows its copy, tracks nothing and re-enables Import", async () => {
  const run = await start({
    source: "stoat",
    input: "abc",
    rejection: { type: "ImportVerificationMissing" },
  });
  assert.deepEqual(run.tracked, []);
  assert.deepEqual(run.startingLog, [true, false]);
  assert.deepEqual(run.errors, [
    undefined,
    "We couldn't find your verification code in the server description. Copy your code again, paste it there and try again.",
  ]);
  assert.equal(run.adopted, 0);
});

test("a collision adopts the running job", async () => {
  const run = await start({
    source: "stoat",
    input: "abc",
    rejection: { type: "ImportAlreadyInProgress" },
  });
  assert.equal(run.adopted, 1);
  assert.deepEqual(run.startingLog, [true, false]);
});

test("a rejection that is not an API error gets the generic copy", async () => {
  const run = await start({
    source: "stoat",
    input: "abc",
    rejection: new TypeError("Failed to fetch"),
  });
  assert.deepEqual(run.errors, [
    undefined,
    "Could not start the import. Try again shortly.",
  ]);
  assert.deepEqual(run.startingLog, [true, false]);
});

// ----------------------------------------------------------------- errors --

test("Stoat start errors: its own copy where the steps are Stoat's", () => {
  for (const type of ["InvalidOperation", "FailedValidation"])
    assert.equal(
      startErrorMessage(type, "stoat"),
      "That doesn't look like a Stoat invite link or server ID.",
      type,
    );
  assert.equal(
    startErrorMessage("ImportVerificationMissing", "stoat"),
    "We couldn't find your verification code in the server description. Copy your code again, paste it there and try again.",
  );
});

test("the shared types read from the shared copy, naming the source", () => {
  assert.equal(
    startErrorMessage("ImportSourceNotFound", "stoat"),
    "We couldn't find that server on Stoat. Check the link and try again.",
  );
  assert.equal(
    startErrorMessage("ImportUpstreamUnavailable", "stoat"),
    "We couldn't reach Stoat right now. Try again in a few minutes.",
  );
  assert.equal(
    startErrorMessage("ImportAlreadyInProgress", "stoat"),
    "You already have an import running. Wait for it to finish before starting another.",
  );
  // The Stoat-specific copy does not leak onto another source.
  assert.equal(
    startErrorMessage("ImportVerificationMissing", "fluxer"),
    importErrorMessage("ImportVerificationMissing", "Fluxer"),
  );
});

test("unknown errors get the generic copy", () => {
  for (const type of ["Bogus", "CantCreateServers", undefined])
    assert.equal(
      startErrorMessage(type, "stoat"),
      "Could not start the import. Try again shortly.",
      String(type),
    );
});

// --------------------------------------------------------------- adoption --

test("a collided job of this source is shown here, with no notice", async () => {
  const run = await adopt("stoat", { status: "Running", kind: "StoatServer" });
  assert.deepEqual(run.resumed, [run.props.client]);
  assert.deepEqual(run.errors, [undefined]);
  assert.deepEqual(run.collided, []);
});

test("a collided Discord job is named and offered in its own modal", async () => {
  for (const kind of [undefined, "Template", "Stickers"]) {
    const run = await adopt("stoat", { status: "Running", kind });
    assert.deepEqual(run.collided, ["discord"], String(kind));
    assert.deepEqual(run.errors, [
      "You already have a Discord import running.",
    ]);
  }
});

test("a collided job of another platform names that platform", async () => {
  const run = await adopt("stoat", { status: "Running", kind: "FluxerServer" });
  assert.deepEqual(run.collided, ["fluxer"]);
  assert.deepEqual(run.errors, [
    "You already have an import from Fluxer running.",
  ]);
});

test("nothing recovered leaves the shared copy in place", async () => {
  const run = await adopt("stoat", undefined);
  assert.deepEqual(run.resumed, [run.props.client]);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.collided, []);
});

// ----------------------------------------------------------- entry points --

/**
 * Run the modal's `choose()` on `entry`, logging what it closes, opens and
 * picks.
 */
function choose(entry: string) {
  const log: unknown[][] = [];
  const props = {
    client: { id: "client" },
    onClose: () => log.push(["close"]),
  };
  new Function(
    "props",
    "openModal",
    "pick",
    "entry",
    modalBlock("  function choose(entry: PickerEntry) {"),
  )(
    props,
    (request: unknown) => log.push(["open", request]),
    (next: string) => log.push(["pick", next]),
    entry,
  );
  return { log, props };
}

test("the fan-outs offer one import action: the picker once a source is ready", () => {
  assert.equal(importActionFor(false, false), "none");
  assert.equal(importActionFor(true, false), "discord");
  assert.equal(importActionFor(false, true), "picker");
  // Not both: the picker lists Discord itself.
  assert.equal(importActionFor(true, true), "picker");
});

test("the picker lists Discord first when offered, then the sources", () => {
  const sources = ["stoat", "fluxer"] as const;
  assert.deepEqual(pickerEntries(true, sources), [
    "discord",
    "stoat",
    "fluxer",
  ]);
  assert.deepEqual(pickerEntries(false, sources), ["stoat", "fluxer"]);
  assert.deepEqual(pickerEntries(true, []), ["discord"]);
  assert.deepEqual(sources, ["stoat", "fluxer"], "the input is not mutated");
});

test("the picker's empty state is only for no Discord and no source", () => {
  assert.equal(pickerEntries(false, []).length, 0);
  assert.notEqual(pickerEntries(true, []).length, 0, "Discord alone");
  assert.notEqual(pickerEntries(false, ["stoat"]).length, 0, "a source alone");
});

test("choosing Discord closes the picker and opens the Discord import", () => {
  const { log, props } = choose("discord");
  assert.deepEqual(log, [
    ["close"],
    ["open", { type: "import_discord", client: props.client }],
  ]);
});

test("choosing another source picks it here, closing and opening nothing", () => {
  for (const entry of ["stoat", "fluxer", "matrix"])
    assert.deepEqual(choose(entry).log, [["pick", entry]], entry);
});

// ------------------------------------------------------------ source pins --

test("source pin: the picker renders its entries, with the empty state only when there are none", () => {
  assert.ok(
    modal.includes(
      "const entries = () => pickerEntries(importDiscordEnabled(), pickable());",
    ),
    "entries() must lead with Discord when the instance offers it",
  );
  assert.ok(
    /<Show\s+when=\{entries\(\)\.length\}\s+fallback=\{\s*<Text>\s*<Trans>No import sources are available right now\.<\/Trans>/.test(
      modal,
    ),
    "the empty state must hang off entries(), not the sources alone",
  );
  assert.equal(modal.split("<For each={").length - 1, 1);
  assert.ok(modal.includes("<For each={entries()}>"));
  assert.ok(modal.includes("onClick={() => choose(entry)}"));
  assert.ok(!modal.includes("pick(entry)}"), "rows go through choose()");
});

test("source pin: the picker is titled like the fan-outs' action", () => {
  assert.ok(modal.includes("if (!source()) return t`Import a server`;"));
  assert.ok(!modal.includes("Import from another app"));
});

test("source pin: both fan-outs offer at most one import action, the same way", () => {
  assert.equal(FANOUT_FILES.length, 2);
  const segments = FANOUT_FILES.map((file) => {
    const text = readFileSync(file, "utf8");
    const count = (needle: string) => text.split(needle).length - 1;
    assert.equal(
      count(
        "importActionFor(importDiscordEnabled(), anyImportSourceEnabled());",
      ),
      1,
      `${file}: the import action comes from importActionFor`,
    );
    // The flags are read only there, so nothing else adds an import button.
    assert.equal(count("importDiscordEnabled("), 1, file);
    assert.equal(count("anyImportSourceEnabled("), 1, file);
    assert.equal(count('importAction() === "discord"'), 1, file);
    assert.equal(count('importAction() === "picker"'), 1, file);
    assert.equal(count("Import from another app"), 0, file);
    // Two primary actions plus the two mutually exclusive import ones.
    assert.equal(count("text:"), 4, `${file}: action count`);

    const start = text.indexOf('...(importAction() === "discord"');
    const end = text.indexOf("\n      ]}", start);
    assert.ok(start > 0 && end > start, `${file}: import actions not found`);
    return text.slice(start, end);
  });
  assert.equal(segments[0], segments[1], "the fan-outs' import actions differ");
  assert.ok(segments[0].includes("<Trans>Import from Discord</Trans>"));
  assert.ok(segments[0].includes("<Trans>Import a server</Trans>"));
  assert.ok(
    segments[0].includes(
      'openModal({ type: "import_discord", client: props.client });',
    ),
  );
  assert.ok(
    segments[0].includes(
      'openModal({ type: "import_source", client: props.client });',
    ),
    "the picker opens with no source",
  );
});

test("source pin: the store's job is read only through the kind gate", () => {
  // The import, `view()`, and `adoptCollidedJob` (which only classifies the
  // job's kind). A read anywhere else could render another kind's job.
  assert.equal(
    modal.split("discordImportView").length - 1,
    3,
    `${SOURCE_FILE} must name discordImportView exactly three times`,
  );
  const adoptBody = modalBlock("  async function adoptCollidedJob() {");
  assert.ok(adoptBody.includes("discordImportView()"));
  // Screens and the navigate effect read `view()`, never the store.
  assert.ok(modal.includes("modalScreen(source(), view(),"));
  assert.ok(
    /createEffect\(\(\) => \{\s*const current = view\(\);/.test(modal),
    "the navigate-on-complete effect must read view()",
  );
});

test("source pin: the store is only cleared when it holds this modal's job", () => {
  const clears = modal.split("clearDiscordImport()").length - 1;
  const guarded = modal.split("if (view()) clearDiscordImport();").length - 1;
  assert.equal(clears, 2);
  assert.equal(guarded, clears, "every clearDiscordImport() is guarded");
});

test("source pin: the bot page opens through a new window, which the shells route out", () => {
  assert.ok(modal.includes('if (url) window.open(url, "_blank", "noopener");'));
  assert.ok(modal.includes("importSourceBotUrl(wanted)"));
});

test("source pin: copy goes through the clipboard helper that reports failure", () => {
  assert.equal(
    modal.split("navigator.clipboard.writeText(").length - 1,
    1,
    "only copyToClipboard may touch the clipboard",
  );
  assert.ok(modal.includes("await copyToClipboard(code)"));
  assert.ok(modal.includes("await copyToClipboard(link())"));
});

test("source pin: every <Trans> is flat (no elements, no expressions)", () => {
  const blocks = [...modal.matchAll(/<Trans>([^]*?)<\/Trans>/g)];
  assert.ok(blocks.length >= 20, `found only ${blocks.length} <Trans> blocks`);
  for (const [, inner] of blocks)
    assert.ok(!/[<{]/.test(inner), `nested content in <Trans>${inner}`);
});

test("source pin: the default export U3b imports", () => {
  assert.ok(modal.includes("export default function ImportSourceModal("));
});

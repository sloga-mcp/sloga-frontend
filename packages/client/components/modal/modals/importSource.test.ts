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

type Challenge = { source: string; code: unknown };

/**
 * Run the modal's `fetchChallenge` with a stand-in client. Lifted on use, so
 * a copy of the modal without it fails only the tests that need it.
 */
function fetchChallenge(
  client: { fetchImportChallenge: (source: string) => Promise<unknown> },
  source: string,
) {
  return new AsyncFunction(
    "client",
    "source",
    modalBlock(
      'async function fetchChallenge(\n  client: Pick<Client, "fetchImportChallenge">,\n  source: ImportSource,\n) {',
    ),
  )(client, source) as unknown as Promise<Challenge>;
}

/**
 * Run the modal's `challengeCode()` with the resource in `state` holding
 * `latest`, and the modal on `source`. Reading `latest` of an errored
 * resource throws, as Solid's does.
 */
function challengeCode(
  state: string,
  latest: Challenge | undefined,
  source: string | undefined,
) {
  const challenge = {
    state,
    get latest() {
      if (state === "errored") throw new Error("read an errored resource");
      return latest;
    },
  };
  return new Function(
    "challenge",
    "source",
    modalBlock("  const challengeCode = () => {"),
  )(challenge, () => source) as string | undefined;
}

/** Run the modal's `botUrl()` with the modal on `source`. */
function botUrl(source: string | undefined) {
  const asked: string[] = [];
  const url = new Function(
    "source",
    "importSourceBotUrl",
    modalBlock("  const botUrl = () => {"),
  )(
    () => source,
    (wanted: string) => {
      asked.push(wanted);
      return `https://bot.example/${wanted}`;
    },
  ) as string | undefined;
  return { url, asked };
}

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
  assert.equal(modalScreen("fluxer", undefined, true), "explain");
  assert.equal(modalScreen("fluxer", undefined, false), "unavailable");
  assert.equal(modalScreen("matrix", undefined, false), "unavailable");
});

test("Stoat and Fluxer have an explain screen, only when the instance offers them", () => {
  const on = () => true;
  const off = () => false;
  for (const source of ["stoat", "fluxer"]) {
    assert.equal(hasExplainScreen(source, on), true, source);
    assert.equal(hasExplainScreen(source, off), false, source);
    // The store is asked about this source, not another one.
    const asked: string[] = [];
    hasExplainScreen(source, (wanted) => {
      asked.push(wanted);
      return true;
    });
    assert.deepEqual(asked, [source]);
  }
  for (const source of ["matrix", undefined])
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

test("a Fluxer start sends the trimmed input to Fluxer and tracks a Fluxer job", async () => {
  const run = await start({
    source: "fluxer",
    input: "\t123456789012345678  ",
  });
  assert.deepEqual(run.requests, [["fluxer", "123456789012345678"]]);
  assert.deepEqual(run.tracked, [["job-1", "FluxerServer"]]);
  assert.deepEqual(run.startingLog, [true, false]);
  assert.deepEqual(run.errors, [undefined], "only the reset");
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
  // A source with no copy of its own gets the shared copy, not Stoat's or
  // Fluxer's. (Fluxer's own verification copy is pinned below.)
  for (const type of [
    "InvalidOperation",
    "ImportVerificationMissing",
    "ImportUpstreamUnavailable",
  ])
    assert.equal(
      startErrorMessage(type, "matrix"),
      importErrorMessage(type, "Matrix") ??
        "Could not start the import. Try again shortly.",
      type,
    );
});

const FLUXER_VERIFICATION_MISSING =
  "We couldn't verify your role. Create a new role, name it exactly your code, and give it Manage Server yourself. Renaming a role that already had Manage Server (including the \"Sloga Importer\" role) doesn't count. The importer bot also needs Administrator to read the audit log.";

test("Fluxer start errors: its own copy where the steps are Fluxer's", () => {
  for (const type of ["InvalidOperation", "FailedValidation"])
    assert.equal(
      startErrorMessage(type, "fluxer"),
      "That doesn't look like a Fluxer invite link or server ID.",
      type,
    );
  // The ownership rule, not the shared "add your code" copy: a new role named
  // exactly the code, given Manage Server by the user; renaming a role that
  // already had Manage Server never passes.
  const missing = startErrorMessage("ImportVerificationMissing", "fluxer");
  assert.equal(missing, FLUXER_VERIFICATION_MISSING);
  assert.notEqual(
    missing,
    importErrorMessage("ImportVerificationMissing", "Fluxer"),
  );
  assert.notEqual(
    missing,
    startErrorMessage("ImportVerificationMissing", "stoat"),
  );
  // A refused quick retry reads as Fluxer being unreachable: say how long.
  assert.equal(
    startErrorMessage("ImportUpstreamUnavailable", "fluxer"),
    "We couldn't reach Fluxer right now. Wait 30 seconds before trying again.",
  );
});

test("Fluxer's other start errors read from the shared copy, naming Fluxer", () => {
  assert.equal(
    startErrorMessage("ImportSourceNotFound", "fluxer"),
    "We couldn't find that server on Fluxer. Check the link and try again.",
  );
  for (const type of [
    "ImportBotNotInServer",
    "ImportAlreadyInProgress",
    "TooManyServers",
  ])
    assert.equal(
      startErrorMessage(type, "fluxer"),
      importErrorMessage(type, "Fluxer"),
      type,
    );
  for (const type of ["Bogus", undefined])
    assert.equal(
      startErrorMessage(type, "fluxer"),
      "Could not start the import. Try again shortly.",
      String(type),
    );
});

test("Fluxer's copy does not leak onto Stoat", () => {
  assert.equal(
    startErrorMessage("ImportUpstreamUnavailable", "stoat"),
    importErrorMessage("ImportUpstreamUnavailable", "Stoat"),
  );
  assert.notEqual(
    startErrorMessage("ImportVerificationMissing", "stoat"),
    FLUXER_VERIFICATION_MISSING,
  );
});

// ------------------------------------------------------ verification code --

test("the code fetch tags the code with the source it is for", async () => {
  const asked: string[] = [];
  const client = {
    fetchImportChallenge: async (source: string) => {
      asked.push(source);
      return { code: `code-${source}` };
    },
  };
  assert.deepEqual(await fetchChallenge(client, "fluxer"), {
    source: "fluxer",
    code: "code-fluxer",
  });
  assert.deepEqual(await fetchChallenge(client, "stoat"), {
    source: "stoat",
    code: "code-stoat",
  });
  assert.deepEqual(asked, ["fluxer", "stoat"]);
  // A reply with no body still says which source it was for.
  const empty = { fetchImportChallenge: async () => null };
  assert.deepEqual(await fetchChallenge(empty, "fluxer"), {
    source: "fluxer",
    code: undefined,
  });
  // What it returns is what the screen checks: Stoat's code, still held
  // while Fluxer's loads, is not shown on Fluxer's screen.
  const stoat = await fetchChallenge(client, "stoat");
  assert.equal(challengeCode("refreshing", stoat, "fluxer"), undefined);
  assert.equal(challengeCode("refreshing", stoat, "stoat"), "code-stoat");
});

test("a code is shown only on the screen of the source it was fetched for", () => {
  const stoat = { source: "stoat", code: "code-stoat" };
  const fluxer = { source: "fluxer", code: "code-fluxer" };

  assert.equal(challengeCode("ready", stoat, "stoat"), "code-stoat");
  assert.equal(challengeCode("ready", fluxer, "fluxer"), "code-fluxer");
  // After switching from Stoat to Fluxer the resource still holds Stoat's
  // code while Fluxer's loads: show nothing, never Stoat's code.
  assert.equal(challengeCode("refreshing", stoat, "fluxer"), undefined);
  assert.equal(challengeCode("ready", stoat, "fluxer"), undefined);
  assert.equal(challengeCode("refreshing", fluxer, "stoat"), undefined);
  assert.equal(challengeCode("ready", stoat, undefined), undefined);
  // Refetching the same source keeps its code up meanwhile.
  assert.equal(challengeCode("refreshing", fluxer, "fluxer"), "code-fluxer");
});

test("a code is shown only once fetched and well-formed", () => {
  for (const state of ["unresolved", "pending", "errored"])
    assert.equal(
      challengeCode(state, { source: "fluxer", code: "abc" }, "fluxer"),
      undefined,
      state,
    );
  assert.equal(challengeCode("ready", undefined, "fluxer"), undefined);
  for (const code of ["", 42, null, undefined, { code: "abc" }])
    assert.equal(
      challengeCode("ready", { source: "fluxer", code }, "fluxer"),
      undefined,
      JSON.stringify(code),
    );
});

test("the add-the-bot button reads the current source's page", () => {
  for (const source of ["stoat", "fluxer"]) {
    const run = botUrl(source);
    assert.equal(run.url, `https://bot.example/${source}`);
    assert.deepEqual(run.asked, [source]);
  }
  const none = botUrl(undefined);
  assert.equal(none.url, undefined);
  assert.deepEqual(none.asked, [], "no source, no lookup");
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
  assert.ok(modal.includes("const url = botUrl();"));
});

/**
 * The text of the ONE local JSX helper `head` opens (`head` ends with
 * `=> (`), up to its closing `);` at the component's indent.
 */
function helperJsx(head: string): string {
  const found = modal.split(head).length - 1;
  assert.equal(found, 1, `${SOURCE_FILE} must contain this once:\n${head}`);
  const open = modal.indexOf(head) + head.length;
  const close = modal.indexOf("\n  );\n", open);
  assert.ok(close > open, `${SOURCE_FILE}: helper never closed:\n${head}`);
  return modal.slice(open, close);
}

/** Every local JSX helper the explain screens share. */
const SHARED_EXPLAIN_PARTS = [
  "  const botButton = () => (",
  "  const codeBlock = () => (",
  "  const inviteField = (fieldLabel: string, placeholder: string) => (",
  "  const startErrorLine = () => (",
];

test("source pin: the explain screens' shared parts name no source", () => {
  for (const head of SHARED_EXPLAIN_PARTS) {
    const body = helperJsx(head);
    assert.ok(!/stoat|fluxer|matrix/i.test(body), `${head} names a source`);
  }
  assert.ok(
    helperJsx(SHARED_EXPLAIN_PARTS[0]).includes("isDisabled={!botUrl()}"),
    "the bot button is enabled by the current source's page",
  );
  // No source's bot page is hard-coded anywhere in the modal.
  assert.equal(modal.split('importSourceBotUrl("').length - 1, 0);
  // The code shown is the one fetched for, and checked against, the source.
  assert.ok(
    modal.includes("(wanted) => fetchChallenge(props.client, wanted),"),
  );
  assert.ok(
    modal.includes("{(code) => ("),
    "the code renders from challengeCode()",
  );
  assert.ok(modal.includes("<Match when={challengeCode()}>"));
});

/** The explain screen of `source`: its `<Match>` up to its `</Match>`. */
function explainScreen(source: string): string {
  const head = `<Match when={screen() === "explain" && source() === "${source}"}>`;
  assert.equal(modal.split(head).length - 1, 1, head);
  const open = modal.indexOf(head);
  const close = modal.indexOf("\n        </Match>", open);
  assert.ok(close > open, `${head} never closed`);
  return modal.slice(open, close);
}

test("source pin: each explain screen is gated by its own source", () => {
  const heads = [
    ...modal.matchAll(/<Match\s+when=\{[^}]*screen\(\) === "explain"[^}]*\}>/g),
  ].map(([head]) => head);
  assert.deepEqual(heads, [
    '<Match when={screen() === "explain" && source() === "stoat"}>',
    '<Match when={screen() === "explain" && source() === "fluxer"}>',
  ]);

  for (const [own, other] of [
    ["stoat", "fluxer"],
    ["fluxer", "stoat"],
  ]) {
    const body = explainScreen(own);
    assert.ok(
      !new RegExp(other, "i").test(body),
      `${own} screen names ${other}`,
    );
    for (const part of [
      "{botButton()}",
      "{codeBlock()}",
      "{inviteField(",
      "{startErrorLine()}",
    ])
      assert.equal(body.split(part).length - 1, 1, `${own}: ${part}`);
  }

  // Stoat's screen keeps its field; Fluxer's has no guessed invite host.
  assert.ok(
    explainScreen("stoat").includes(
      'inviteField(\n              t`Stoat invite link or server ID`,\n              "https://stoat.chat/invite/xxxxxxxx",\n            )',
    ),
  );
  assert.ok(
    explainScreen("fluxer").includes(
      "inviteField(\n              t`Fluxer invite link or server ID`,\n              t`Invite link or server ID`,\n            )",
    ),
  );
  assert.ok(!modal.includes("fluxer.gg"));
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

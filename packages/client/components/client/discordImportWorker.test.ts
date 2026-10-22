/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/discordImportWorker.test.ts
 *
 * Covers how `DiscordImportWorker.tsx` tells the user an import finished or
 * failed: a Discord job (no kind, `Template`, `Stickers`) keeps the Discord
 * copy and modal byte for byte; another platform's job gets its own copy and
 * opens `import_source` on its source. Also covers the event handlers'
 * handling of a job this device was not tracking (started on another
 * device), which arrives kind-less and must not be announced as Discord's
 * when its row says otherwise.
 *
 * `node --test` cannot load the worker (Solid JSX, lingui macros), so the
 * decisions under test are written as plain-JavaScript function bodies and
 * this spec lifts each body out of the source TEXT and runs it with stubs (a
 * stand-in for lingui's `t` fills in the values, so the asserted copy is the
 * copy in the file). `kindToSource` and `sourceLabel` are the real store
 * functions, loaded with the `@revolt/common` hook `discordImport.test.ts`
 * documents.
 *
 * Known-bad control: set `IMPORT_WORKER_FILE` to the path of a copy of
 * `DiscordImportWorker.tsx` with a defect, and the matching specs fail.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

const WORKER_FILE =
  process.env.IMPORT_WORKER_FILE ??
  new URL("./DiscordImportWorker.tsx", import.meta.url).pathname;
const STORE_URL = new URL("./discordImport.ts", import.meta.url).href;
const COMMON_STUB = "discordimportworker-test:common";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@revolt/common" && context.parentURL === STORE_URL) {
      return { url: COMMON_STUB, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === COMMON_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const CONFIGURATION = { DEFAULT_API_URL: "https://api-host.test" };`,
      };
    }

    return nextLoad(url, context);
  },
});

const { kindToSource, sourceLabel }: typeof import("./discordImport.ts") =
  await import(STORE_URL);

const worker = readFileSync(WORKER_FILE, "utf8");

/**
 * The text inside the ONE block `head` opens (`head` ends with its `{`),
 * skipping strings, template literals and comments while matching braces.
 * Same walker as `../modal/modals/importShell.test.ts`.
 */
function blockAfter(source: string, head: string): string {
  const found = source.split(head).length - 1;
  assert.equal(
    found,
    1,
    `${WORKER_FILE} must contain this once, found ${found}:\n${head}`,
  );
  const open = source.indexOf(head) + head.length - 1;
  assert.equal(source[open], "{", "head must end with '{'");
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
  assert.fail(`${WORKER_FILE}: the block after this head is never closed`);
}

/** Stand-in for lingui's `t`: the message with its values filled in. */
function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce(
    (out, part, i) => out + part + (i < values.length ? String(values[i]) : ""),
    "",
  );
}

// ------------------------------------------------------------- announcing --

type Snack = {
  message: string;
  action: string;
  closeable: boolean;
  closeOnAction: boolean;
  onAction: () => void;
};

const announceBody = blockAfter(
  worker,
  `  function announceImportOutcome(
    modalClient: Client,
    kind: string | undefined,
    failed: boolean,
  ) {`,
);

/**
 * Run the worker's announce body with `open` as the set of open modal
 * types; returns what it asked about, showed and (on action) opened.
 */
function announce(kind: string | undefined, failed: boolean, open: string[]) {
  const asked: string[] = [];
  const shown: Snack[] = [];
  const opened: unknown[] = [];
  const client = { id: "client" };
  new Function(
    "t",
    "kindToSource",
    "importSourceLabel",
    "isOpen",
    "snackbar",
    "openModal",
    "modalClient",
    "kind",
    "failed",
    announceBody,
  )(
    t,
    kindToSource,
    sourceLabel,
    (type: string) => {
      asked.push(type);
      return open.includes(type);
    },
    { show: (snack: Snack) => shown.push(snack) },
    (modal: unknown) => opened.push(modal),
    client,
    kind,
    failed,
  );
  for (const snack of shown) snack.onAction();
  return { asked, shown, opened, client };
}

describe("announceImportOutcome", () => {
  it("keeps the Discord copy and modal for every Discord kind", () => {
    for (const kind of [undefined, "Template", "Stickers", "Bogus"]) {
      for (const failed of [false, true]) {
        const { asked, shown, opened, client } = announce(kind, failed, []);
        assert.deepEqual(asked, ["import_discord"], String(kind));
        assert.equal(shown.length, 1);
        assert.equal(
          shown[0].message,
          failed
            ? "Your Discord import failed."
            : "Your Discord import finished.",
        );
        assert.equal(shown[0].action, failed ? "Details" : "View");
        assert.equal(shown[0].closeable, true);
        assert.equal(shown[0].closeOnAction, true);
        assert.deepEqual(opened, [{ type: "import_discord", client }]);
      }
    }
  });

  it("stays quiet while the Discord modal is open", () => {
    assert.equal(
      announce("Template", false, ["import_discord"]).shown.length,
      0,
    );
    assert.equal(announce(undefined, true, ["import_discord"]).shown.length, 0);
  });

  it("names the source and opens import_source on it", () => {
    const sources: [string, string, string][] = [
      ["StoatServer", "stoat", "Stoat"],
      ["FluxerServer", "fluxer", "Fluxer"],
      ["MatrixSpace", "matrix", "Matrix"],
    ];
    for (const [kind, source, label] of sources) {
      for (const failed of [false, true]) {
        const { asked, shown, opened, client } = announce(kind, failed, [
          "import_discord",
        ]);
        assert.deepEqual(asked, ["import_source"], kind);
        assert.equal(shown.length, 1, kind);
        assert.equal(
          shown[0].message,
          failed
            ? `Your ${label} import failed.`
            : `Your ${label} import finished.`,
        );
        assert.equal(shown[0].action, failed ? "Details" : "View");
        assert.equal(shown[0].closeable, true);
        assert.equal(shown[0].closeOnAction, true);
        assert.deepEqual(opened, [{ type: "import_source", client, source }]);
      }
    }
  });

  it("stays quiet while an import_source modal is open", () => {
    assert.equal(
      announce("StoatServer", false, ["import_source"]).shown.length,
      0,
    );
  });
});

// --------------------------------------------------------- event handlers --

/** A deferred `fetchKind` result, resolved by the spec. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Run one of the worker's event handlers with stubbed store calls.
 * `trackingBefore`/`trackingAfter` are what `tracking(jobId)` answers before
 * and after the store applies the event.
 */
function handler(
  head: string,
  param: string,
  opts: {
    trackingBefore: boolean;
    trackingAfter?: boolean;
    viewKind?: string;
  },
) {
  const log: string[] = [];
  const announced: [unknown, string | undefined, boolean][] = [];
  const row = deferred<string | undefined>();
  let applied = false;
  const currentClient = { id: "client" };
  const fn = new Function(
    "tracking",
    "fetchKind",
    "applyDiscordImportProgress",
    "applyDiscordImportComplete",
    "applyDiscordImportFailed",
    "noteDiscordImportAnnounced",
    "announceImportOutcome",
    "discordImportView",
    "currentClient",
    param,
    blockAfter(worker, head),
  ).bind(
    null,
    () => (applied ? (opts.trackingAfter ?? true) : opts.trackingBefore),
    (jobId: string) => {
      log.push(`fetch ${jobId}`);
      return row.promise;
    },
    () => {
      applied = true;
      log.push("apply");
    },
    () => {
      applied = true;
      log.push("apply");
    },
    () => {
      applied = true;
      log.push("apply");
    },
    (jobId: string) => log.push(`note ${jobId}`),
    (client: unknown, kind: string | undefined, failed: boolean) => {
      log.push("announce");
      announced.push([client, kind, failed]);
    },
    () => ({ jobId: "job", kind: opts.viewKind }),
    currentClient,
  );
  return { fn, log, announced, row, currentClient };
}

const PROGRESS_HEAD = `    const onProgress = (progress: {
      jobId: string;
      stage: string;
      done: number;
      total: number;
    }) => {`;
const COMPLETE_HEAD = `    const onComplete = (result: {
      jobId: string;
      serverId: string;
      inviteCode: string;
    }) => {`;
const FAILED_HEAD = `    const onFailed = (failure: { jobId: string; error: string }) => {`;

describe("event handlers", () => {
  const progress = { jobId: "job", stage: "Channels", done: 1, total: 4 };
  const complete = { jobId: "job", serverId: "srv", inviteCode: "inv" };
  const failure = { jobId: "job", error: "nope" };

  it("progress on a tracked job fetches nothing (as before)", () => {
    const h = handler(PROGRESS_HEAD, "progress", { trackingBefore: true });
    h.fn(progress);
    assert.deepEqual(h.log, ["apply"]);
  });

  it("progress that adopts an untracked job reads its row once", () => {
    const h = handler(PROGRESS_HEAD, "progress", { trackingBefore: false });
    h.fn(progress);
    assert.deepEqual(h.log, ["apply", "fetch job"]);
  });

  it("progress the store ignores (another job tracked) fetches nothing", () => {
    const h = handler(PROGRESS_HEAD, "progress", {
      trackingBefore: false,
      trackingAfter: false,
    });
    h.fn(progress);
    assert.deepEqual(h.log, ["apply"]);
  });

  it("completion of a tracked job announces at once, with the view's kind", async () => {
    for (const viewKind of [undefined, "Template", "StoatServer"]) {
      const h = handler(COMPLETE_HEAD, "result", {
        trackingBefore: true,
        viewKind,
      });
      h.fn(complete);
      // Synchronous, before the row fetch resolves: Discord timing as before.
      assert.deepEqual(h.log, ["apply", "note job", "fetch job", "announce"]);
      assert.deepEqual(h.announced, [[h.currentClient, viewKind, false]]);
      h.row.resolve("Bogus");
      await settle();
      assert.equal(h.announced.length, 1, "announced exactly once");
    }
  });

  it("completion of an untracked job waits for the row's kind", async () => {
    const h = handler(COMPLETE_HEAD, "result", { trackingBefore: false });
    h.fn(complete);
    assert.deepEqual(h.log, ["apply", "note job", "fetch job"]);
    assert.equal(h.announced.length, 0);
    h.row.resolve("StoatServer");
    await settle();
    assert.deepEqual(h.announced, [[h.currentClient, "StoatServer", false]]);
  });

  it("an untracked completion whose row fetch fails still announces", async () => {
    const h = handler(COMPLETE_HEAD, "result", { trackingBefore: false });
    h.fn(complete);
    h.row.resolve(undefined);
    await settle();
    assert.deepEqual(h.announced, [[h.currentClient, undefined, false]]);
  });

  it("failure of a tracked job announces at once and fetches nothing", () => {
    for (const viewKind of [undefined, "Stickers", "FluxerServer"]) {
      const h = handler(FAILED_HEAD, "failure", {
        trackingBefore: true,
        viewKind,
      });
      h.fn(failure);
      assert.deepEqual(h.log, ["apply", "note job", "announce"]);
      assert.deepEqual(h.announced, [[h.currentClient, viewKind, true]]);
    }
  });

  it("failure of an untracked job waits for the row's kind", async () => {
    const h = handler(FAILED_HEAD, "failure", { trackingBefore: false });
    h.fn(failure);
    assert.deepEqual(h.log, ["apply", "note job", "fetch job"]);
    assert.equal(h.announced.length, 0);
    h.row.resolve("StoatServer");
    await settle();
    assert.deepEqual(h.announced, [[h.currentClient, "StoatServer", true]]);
  });
});

// ------------------------------------------------------------ source pins --

describe("source pins", () => {
  it("tracking and fetchKind read what the handlers assume", () => {
    assert.ok(
      worker.includes(
        "const tracking = (jobId: string) => discordImportView()?.jobId === jobId;",
      ),
      "tracking() must compare the store's job id",
    );
    const fetchKind = worker.slice(
      worker.indexOf("const fetchKind = (jobId: string) =>"),
      worker.indexOf("const onProgress"),
    );
    for (const piece of [
      ".fetchDiscordImportJob(jobId)",
      "applyDiscordImportJob(job);",
      "return job.kind;",
      ".catch(() => undefined);",
    ])
      assert.ok(fetchKind.includes(piece), `fetchKind lost: ${piece}`);
  });

  it("every snackbar goes through announceImportOutcome", () => {
    assert.equal(
      worker.split("snackbar.show(").length - 1,
      2,
      "exactly the two shows inside announceImportOutcome",
    );
    assert.equal(announceBody.split("snackbar.show(").length - 1, 2);
    const resume = blockAfter(
      worker,
      "resumeDiscordImport(currentClient).then((recovered) => {",
    );
    assert.ok(resume.includes("if (!recovered) return;"));
    assert.ok(
      resume.includes(
        `announceImportOutcome(
        currentClient,
        recovered.kind,
        recovered.status === "Failed",
      );`,
      ),
      "the resume path announces with the recovered row's kind",
    );
  });

  it("the poll fallback is unchanged", () => {
    assert.ok(worker.includes("const POLL_INTERVAL_MS = 5000;"));
    const tick = blockAfter(worker, "const timer = setInterval(() => {");
    assert.ok(
      tick.includes(
        `currentClient
        .fetchDiscordImportJob(jobId)
        .then(applyDiscordImportJob)`,
      ),
    );
    assert.ok(worker.includes("if (!discordImportInFlight()) return;"));
    assert.ok(worker.includes("onCleanup(() => clearInterval(timer));"));
  });
});

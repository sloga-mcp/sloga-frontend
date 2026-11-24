// Spec for the S2-D28 reconnect hook in `e2ee.ts` (FX-R addition 4): on a
// reconnect the text manager survives, members must admit the join requests
// the server stored meanwhile, so each open protected channel gets ONE
// refresh with a reason in `STORED_ADMIT_REASONS`. `e2ee.ts` cannot load
// under Node (Solid, the native bridge, stoat.js), so the REAL
// `#protectedOnReady` and `#protectedReconnected` are lifted out of the
// source with their types stripped and RUN over stubs (the
// protectedSeam.scan.test.ts S10-S13 pattern).
//
// Run: node --test --conditions=browser components/client/protectedReconnect.scan.test.ts
// `PROTECTED_SEAM_TS=<path>` scans another copy of e2ee.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import { STORED_ADMIT_REASONS } from "./protectedTextPolicy.ts";

const FILE =
  process.env.PROTECTED_SEAM_TS || new URL("./e2ee.ts", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

// ---- Source helpers (as in protectedSeam.scan.test.ts) ----------------------

/** Index just past the `}` matching the `{` at `open` (strings, comments skipped). */
function matchBrace(src: string, open: number): number {
  assert.equal(src[open], "{", "matchBrace: not at a brace");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return src.length;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
      }
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("matchBrace: unbalanced");
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** The body (braces included) of the class member declared by `head`. */
function member(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  let i = m.index + m[0].length;
  let parens = count(m[0], "(") - count(m[0], ")");
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    if (src[i] === ")") parens--;
    if (src[i] === "{" && parens === 0) break;
  }
  return src.slice(i, matchBrace(src, i));
}

/** The full declaration (head + body) of the class member `head` names. */
function memberDecl(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  const body = member(src, head);
  const start = m.index + (m[0].length - m[0].trimStart().length);
  return src.slice(start, src.indexOf(body, m.index) + body.length);
}

/** Strip `//` and block comments (strings kept) for statement checks. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const ON_READY = /\n {2}async #protectedOnReady\(\): Promise<void> /;
const RECONNECTED =
  /\n {2}#protectedReconnected\(manager: ProtectedTextManager\): void /;

// ---- Harness ---------------------------------------------------------------

type Refresh = [manager: number, channelId: string, reason: string];

type ReadyHarness = {
  /** `<user>:<device>` while capable, else null (`#protectedManagerKeyNow`). */
  key: string | null;
  builds: number;
  disposals: number;
  refreshes: Refresh[];
  warnings: unknown[][];
  failRefresh: boolean;
  index(id: string): void;
  open(id: string): void;
  close(id: string): void;
  ready(): Promise<void>;
};

/**
 * The REAL `#protectedOnReady` + `#protectedReconnected` over stubs: seeding
 * is a no-op, `#protectedBootManager` builds a counting manager whenever
 * none exists and the key is set, `#protectedDispose` drops it (and the
 * forwarded set, as the real one does), `#protectedForward` records the
 * hand-over.
 */
function readyHarness(): ReadyHarness {
  const members = [ON_READY, RECONNECTED].map((head) => memberDecl(SRC, head));
  const ts = `class ReadyHarness {
  #ptManager = null;
  #ptManagerKey = null;
  #ptIndexed = new Set();
  #ptOpen = new Set();
  #ptForwarded = new Set();
  #ptIndex = { markReady: () => {} };
  key = "U:D";
  builds = 0;
  disposals = 0;
  refreshes = [];
  warnings = [];
  failRefresh = false;
  index(id) { this.#ptIndexed.add(id); }
  open(id) { this.#ptOpen.add(id); }
  close(id) { this.#ptOpen.delete(id); }
  ready() { return this.#protectedOnReady(); }
  #protectedSubscribeDeletes() {}
  #protectedSeedIds() { return []; }
  async #protectedIndex() { return true; }
  #protectedManagerKeyNow() { return this.key; }
  #protectedDispose() {
    this.#ptManager = null;
    this.#ptManagerKey = null;
    this.#ptForwarded.clear();
    this.disposals++;
  }
  #protectedBootManager() {
    if (this.#ptManager || !this.key) return;
    const id = ++this.builds;
    this.#ptManager = {
      refresh: (channelId, reason) => {
        this.refreshes.push([id, channelId, reason]);
        return this.failRefresh
          ? Promise.reject(new Error("refresh"))
          : Promise.resolve();
      },
    };
    this.#ptManagerKey = this.key;
  }
  #protectedForward(id) { this.#ptForwarded.add(id); }
  #protectedFlushPreIndex() {}
  ${members.join("\n  ")}
}`;
  let h: ReadyHarness | null = null;
  const fakeConsole = {
    warn: (...a: unknown[]) => h?.warnings.push(a),
    error: (...a: unknown[]) => h?.warnings.push(["error", ...a]),
  };
  const Cls = new Function(
    "errorName",
    "console",
    `${stripTypeScriptTypes(ts)}\nreturn ReadyHarness;`,
  )((e: unknown) => (e instanceof Error ? e.name : "unknown"), fakeConsole);
  h = new Cls() as ReadyHarness;
  return h;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- Tests -----------------------------------------------------------------

test("FXR reconnect: a reconnect the manager survives refreshes each open, handed-over channel ONCE with a stored-admit reason (never an open)", async () => {
  const h = readyHarness();
  for (const id of ["C1", "C2", "C3"]) h.index(id);
  for (const id of ["C1", "C2", "C4"]) h.open(id); // C4: not protected
  await h.ready(); // first connect: the new manager opens its own channels
  assert.equal(h.builds, 1);
  assert.equal(h.refreshes.length, 0, "nothing on the connect that built it");

  await h.ready(); // reconnect, same account and device
  assert.equal(h.builds, 1, "the manager survived");
  assert.deepEqual(
    h.refreshes.map(([m, id]) => [m, id]),
    [
      [1, "C1"],
      [1, "C2"],
    ],
    "open AND handed over: C3 is closed, C4 never handed over",
  );
  for (const [, , reason] of h.refreshes) {
    assert.ok(
      STORED_ADMIT_REASONS.includes(reason as never),
      `${reason}: members admit stored join_requests on it`,
    );
    // An open would retry a capacity-refused join and reset the backoff.
    assert.notEqual(reason, "open");
    assert.notEqual(reason, "start");
  }

  h.close("C2");
  await h.ready();
  assert.deepEqual(
    h.refreshes.slice(2).map(([, id]) => id),
    ["C1"],
    "each reconnect, the channels open then",
  );
});

test("FXR reconnect: a rebuilt manager (another account or device) and a lost capability get no reconnect refresh", async () => {
  const h = readyHarness();
  h.index("C1");
  h.open("C1");
  await h.ready();
  h.key = "U:D2"; // the device changed
  await h.ready();
  assert.equal(h.disposals, 1);
  assert.equal(h.builds, 2);
  assert.equal(h.refreshes.length, 0, "the rebuilt manager opens C1 itself");

  h.key = null; // no longer capable
  await h.ready();
  assert.equal(h.disposals, 2);
  assert.equal(h.builds, 2);
  assert.equal(h.refreshes.length, 0);
});

test("FXR reconnect: a refresh that rejects is caught and logged by channel id, never thrown", async () => {
  const h = readyHarness();
  h.index("C1");
  h.open("C1");
  await h.ready();
  h.failRefresh = true;
  await h.ready();
  await settle();
  assert.equal(h.refreshes.length, 1);
  assert.deepEqual(h.warnings, [
    [
      "[protected] reconnect refresh failed",
      { channelId: "C1", error: "Error" },
    ],
  ]);
});

test("FXR reconnect: the hook is called from the seam's ready step only, after the hand-over", () => {
  assert.equal(count(SRC, "this.#protectedReconnected("), 1);
  const ready = stripComments(member(SRC, ON_READY));
  assert.match(
    ready,
    /for \(const channelId of this\.#ptIndexed\) \{\s*this\.#protectedForward\(channelId\);\s*\}\s*if \(kept !== null && kept === this\.#ptManager\) \{\s*this\.#protectedReconnected\(kept\);\s*\}/,
  );
});

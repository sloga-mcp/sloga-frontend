// Unit spec for the Protected channels shared types (W4 lane A1, S2 lane
// L0T). Run with Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextTypes.test.ts
// Focus: the runtime tables every later lane trusts. `TEXT_COMMANDS` is the
// bridge's text-command allow-list, so it must be exactly the 21 native
// commands, and each command's `TextCommandArgs` keys must be exactly the
// native Tauri parameters (all of them, always sent). `NATIVE_ERROR_TAGS` /
// `TEXT_NATIVE_ERROR_TAGS` drive the total error mapping (plan D17), so a
// native variant missing here would reach the UI untyped. All are pinned
// ALWAYS against the in-repo fixtures in `__fixtures__/protected/`. The
// native keys are generated from desktop 876c034 by
// /home/mcp/pc-logs/s2/w4/ctl/L0T/gen_native_fixtures.py; the design keys
// come from the S1 notes. Two extra tests re-parse the sources when present
// (the S1 notes in `/home/mcp/w4-notes/`, override `W4_NOTES_DIR`; the
// pinned desktop commit through `git show` in `/home/mcp/sd-protected-s2`,
// override `S2_NATIVE_REPO`) and skip, loudly, when they are absent.
//
// S2 D40 / OR-6 / design 7.5: `textApi`, `onEvent` and
// `joinIntentSignedFields` (e2ee.ts) are lifted out of the source with their
// types stripped and RUN against stubs (e2ee.ts cannot load under Node), to
// pin the audit-log reason header, the malformed join-intent drop and the
// `ProtectedChannelChanged` hand-off. `PROTECTED_TEXT_API_TS=<path>` lifts
// them from another copy of e2ee.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import type { Message } from "stoat.js";
import type { EncryptedPayload as SdkEncryptedPayload } from "stoat.js/lib/lib/protected";

import {
  type EncryptedPayload,
  type SeatListRejection,
  type TextApiHeaders,
  type TextApiResponse,
  type TextCommand,
  type TextCommandArgs,
  type _TextCommandArgsAlwaysSent,
  type _TextCommandArgsComplete,
  NATIVE_ERROR_TAGS,
  TEXT_COMMANDS,
  TEXT_LEFT_REASONS,
  TEXT_NATIVE_ERROR_TAGS,
} from "./protectedTextTypes.ts";

// ---------------------------------------------------------------------------
// Compile-time: A1's `EncryptedPayload` and the SDK's (stoat.js
// `src/lib/protected.ts`, and `Message.encrypted`) are mutually assignable.
// ---------------------------------------------------------------------------

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const _sdkPayloadMatches: Mutual<EncryptedPayload, SdkEncryptedPayload> =
  true;
export const _messageEncryptedMatches: Mutual<
  EncryptedPayload,
  NonNullable<Message["encrypted"]>
> = true;

// Compile-time: every command has args, and no arg is an optional key.
export const _argsComplete: _TextCommandArgsComplete = true;
export const _argsAlwaysSent: _TextCommandArgsAlwaysSent = true;

// ---------------------------------------------------------------------------
// Fixtures (always present) and the optional pinned sources
// ---------------------------------------------------------------------------

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/protected/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;

interface Source {
  file: string;
  sha256?: string;
  repo?: string;
  commit?: string;
}

const COMMANDS = fixture<{
  sources: Source[];
  design_8_3_table: string[];
  w3_additions: string[];
  s2_additions: string[];
  named_in_native_sources: string[];
  tauri_commands: string[];
  tauri_args: Record<string, string[]>;
}>("native-text-commands.json");

const ERRORS = fixture<{
  sources: Source[];
  error_enum: string[];
  w3_section: string[];
  s2_appended: string[];
  design_8_4_rows: string[];
  design_8_4_existing: string[];
  text_left_reason: string[];
  seat_list_rejection: string[];
}>("native-error-tags.json");

const ERROR_RS_PATH = "acutest-desktop/src-tauri/e2ee-core/src/error.rs";
const TEXT_RS_PATH = "acutest-desktop/src-tauri/src/e2ee_text.rs";

/** The fixture's record of a pinned desktop source. */
function pinned(sources: Source[], file: string): Required<Source> {
  const s = sources.find((x) => x.file === file);
  assert.ok(s?.commit && s.sha256 && s.repo, `pinned source ${file}`);
  return s as Required<Source>;
}

const NOTES = process.env.W4_NOTES_DIR ?? "/home/mcp/w4-notes";
// S1 sources: the Error enum at native ed207f1 (adds `protector_locked`,
// S1 F5), the S1 types and the design copy.
const ERROR_RS = join(NOTES, "w4_native_error.ed207f1.rs");
const TYPES_RS = join(NOTES, "w4_native_types.rs");
const DESIGN = join(NOTES, "w4_design.md");
const NOTES_PRESENT = [ERROR_RS, TYPES_RS, DESIGN].every((p) => existsSync(p));
const SKIP_NOTES = NOTES_PRESENT
  ? false
  : `pinned S1 notes not found in ${NOTES}`;

// S2 sources: the pinned desktop commit, read with `git show` (never a
// working tree), so a moving desktop branch cannot change what is checked.
const NATIVE_REPO =
  process.env.S2_NATIVE_REPO ?? pinned(ERRORS.sources, ERROR_RS_PATH).repo;
const NATIVE_COMMIT = pinned(ERRORS.sources, ERROR_RS_PATH).commit;
function gitShow(path: string): Buffer | null {
  try {
    return execFileSync(
      "git",
      ["-C", NATIVE_REPO, "show", `${NATIVE_COMMIT}:${path}`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
}
const NATIVE_ERROR_SRC = gitShow(ERROR_RS_PATH);
const NATIVE_TEXT_SRC = gitShow(TEXT_RS_PATH);
const SKIP_NATIVE =
  NATIVE_ERROR_SRC && NATIVE_TEXT_SRC
    ? false
    : `desktop ${NATIVE_COMMIT} not readable in ${NATIVE_REPO}`;

const read = (p: string) => readFileSync(p, "utf8");
const sorted = (xs: Iterable<string>) => [...xs].sort();
const has = (xs: readonly string[], x: string) => xs.includes(x);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** serde `rename_all = "snake_case"` for a PascalCase variant name. */
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c, i: number) => (i ? "_" : "") + c.toLowerCase());

/** Tauri's argument mapping: snake_case parameter -> camelCase key. */
const camel = (name: string) =>
  name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** The body of `pub enum <name> {` up to its closing `}` at column 0. */
function enumBody(src: string, name: string): string {
  const start = src.indexOf(`pub enum ${name} {`);
  assert.ok(start >= 0, `enum ${name} not found`);
  const end = src.indexOf("\n}", start);
  assert.ok(end > start, `enum ${name} not closed`);
  return src.slice(start, end);
}

/** Variant names of an enum body: the 4-space-indented PascalCase lines. */
const variants = (body: string) =>
  [...body.matchAll(/^ {4}([A-Z][A-Za-z0-9]*)\b/gm)].map((m) => m[1]);

/** Text between two markers (both must exist). */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `marker not found: ${to}`);
  return src.slice(a, b);
}

// ---------------------------------------------------------------------------
// Always: tables against the fixtures
// ---------------------------------------------------------------------------

test("TEXT_COMMANDS: 21 unique names, all text-plane", () => {
  assert.equal(TEXT_COMMANDS.length, 21);
  assert.equal(new Set(TEXT_COMMANDS).size, 21);
  for (const c of TEXT_COMMANDS) {
    assert.match(c, /^(e2ee_text_[a-z_]+[a-z]|e2ee_mls_group_kind)$/, c);
  }
  // never a call-plane or DM command
  for (const c of TEXT_COMMANDS) assert.doesNotMatch(c, /call|e2ee_pin_/, c);
});

test("TEXT_COMMANDS equals the pinned native command list", () => {
  assert.equal(COMMANDS.design_8_3_table.length, 18, "design 8.3 rows");
  assert.deepEqual(COMMANDS.s2_additions, ["e2ee_text_authority_sign"]);
  assert.deepEqual(
    sorted(TEXT_COMMANDS),
    sorted(
      new Set([
        ...COMMANDS.design_8_3_table,
        ...COMMANDS.w3_additions,
        ...COMMANDS.s2_additions,
      ]),
    ),
  );
  // Every Tauri command in the pinned e2ee_text.rs, and nothing else.
  assert.deepEqual(sorted(TEXT_COMMANDS), sorted(COMMANDS.tauri_commands));
  assert.ok(COMMANDS.named_in_native_sources.length >= 10);
  for (const c of COMMANDS.named_in_native_sources) {
    assert.ok(has(TEXT_COMMANDS, c), c);
  }
});

/**
 * The keys of every `TextCommandArgs[C]`, written out. tsc refuses a
 * missing or an extra key here, so the runtime check below compares the real
 * type's keys with the native parameter names.
 */
const ARG_KEYS: {
  [C in TextCommand]: { [K in keyof TextCommandArgs[C]]-?: true };
} = {
  e2ee_text_group_create: {
    channelId: true,
    userId: true,
    supersedes: true,
    recovery: true,
    supersedesGeneration: true,
  },
  e2ee_text_join: {
    groupId: true,
    channelId: true,
    generation: true,
    userId: true,
  },
  e2ee_text_admit: { request: true, claimed: true },
  e2ee_text_process: { envelope: true, userId: true, catchUpTip: true },
  e2ee_text_commit_won: {
    groupId: true,
    wonEpoch: true,
    storedCommitB64: true,
    rejoinIntents: true,
    removedReasons: true,
  },
  e2ee_text_commit_lost: { groupId: true },
  e2ee_text_pending_commit: { groupId: true },
  e2ee_text_encrypt: {
    channelId: true,
    userId: true,
    text: true,
    replies: true,
  },
  e2ee_text_decrypt: {
    channelId: true,
    messageId: true,
    authorUserId: true,
    nonce: true,
    encrypted: true,
    live: true,
  },
  e2ee_text_seat_list_sign: {
    channelId: true,
    userId: true,
    seats: true,
    deviceCap: true,
    serverList: true,
    format: true,
    authority: true,
    recovery: true,
    channelName: true,
    displayNames: true,
  },
  e2ee_text_seat_list_verify: {
    channelId: true,
    list: true,
    handovers: true,
    serverOwnerId: true,
    asOfEpoch: true,
    asOfGroupId: true,
    asOfGeneration: true,
  },
  e2ee_text_owner_pin_state: { channelId: true },
  e2ee_text_owner_confirm_change: {
    channelId: true,
    channelName: true,
    displayNames: true,
  },
  e2ee_text_owner_handover_sign: {
    channelId: true,
    userId: true,
    toUserId: true,
    toDeviceId: true,
    channelName: true,
    displayNames: true,
  },
  e2ee_text_authority_sign: {
    channelId: true,
    userId: true,
    ownerDevices: true,
    channelName: true,
    displayNames: true,
  },
  e2ee_text_remove: {
    groupId: true,
    targets: true,
    rejoinIntent: true,
    pendingRemovalUsers: true,
    pendingDeviceTargets: true,
  },
  e2ee_text_update: { groupId: true },
  e2ee_text_state: { channelId: true },
  e2ee_text_mark_left: { groupId: true, reason: true },
  e2ee_text_pin_own_devices: { userId: true, devices: true },
  e2ee_mls_group_kind: { groupId: true },
};

test("TextCommandArgs keys equal the native Tauri parameters", () => {
  assert.deepEqual(sorted(Object.keys(ARG_KEYS)), sorted(TEXT_COMMANDS));
  assert.deepEqual(
    sorted(Object.keys(COMMANDS.tauri_args)),
    sorted(TEXT_COMMANDS),
  );
  for (const c of TEXT_COMMANDS) {
    assert.deepEqual(
      sorted(Object.keys(ARG_KEYS[c])),
      sorted(COMMANDS.tauri_args[c]),
      c,
    );
  }
  // The S2 parameters, by name (all always sent).
  assert.ok(has(COMMANDS.tauri_args.e2ee_text_commit_won, "removedReasons"));
  assert.ok(has(COMMANDS.tauri_args.e2ee_text_remove, "pendingDeviceTargets"));
  assert.ok(has(COMMANDS.tauri_args.e2ee_text_process, "catchUpTip"));
  assert.ok(
    has(COMMANDS.tauri_args.e2ee_text_seat_list_verify, "asOfGeneration"),
  );
});

test("NATIVE_ERROR_TAGS equals the native Error enum, in order", () => {
  assert.ok(ERRORS.error_enum.length >= 60);
  assert.equal(new Set(ERRORS.error_enum).size, ERRORS.error_enum.length);
  assert.deepEqual([...NATIVE_ERROR_TAGS], ERRORS.error_enum);
});

test("S2: the two appended tags close the enum, in native order", () => {
  assert.deepEqual(ERRORS.s2_appended, [
    "catch_up_leaf_unresolvable",
    "unsupported_envelope_version",
  ]);
  assert.deepEqual(ERRORS.error_enum.slice(-2), ERRORS.s2_appended);
  assert.deepEqual(NATIVE_ERROR_TAGS.slice(-2), ERRORS.s2_appended);
  assert.equal(
    NATIVE_ERROR_TAGS[NATIVE_ERROR_TAGS.length - 3],
    "handover_target_invalid",
  );
  // Both are text-plane tags (the total mapping must name them).
  for (const t of ERRORS.s2_appended) {
    assert.ok(has(TEXT_NATIVE_ERROR_TAGS, t), t);
  }
});

test("protector_locked: right after protector, not a text-plane tag", () => {
  const i = NATIVE_ERROR_TAGS.indexOf("protector_locked");
  assert.ok(i > 0, "present");
  assert.equal(NATIVE_ERROR_TAGS[i - 1], "protector");
  // A locked device is not a group state: the fail-closed catch-all owns it.
  assert.equal(has(TEXT_NATIVE_ERROR_TAGS, "protector_locked"), false);
});

test("TEXT_NATIVE_ERROR_TAGS = W3 variants + design 8.4 existing", () => {
  const tags: readonly string[] = TEXT_NATIVE_ERROR_TAGS;
  assert.equal(new Set(tags).size, tags.length);
  for (const t of tags) assert.ok(has(NATIVE_ERROR_TAGS, t), t);
  assert.equal(ERRORS.w3_section.length, 29, "W3 variants + S2 appended");
  assert.equal(ERRORS.design_8_4_rows.length, 25, "design 8.4 rows");
  assert.equal(ERRORS.design_8_4_existing.length, 6, "8.4 existing");
  for (const r of ERRORS.design_8_4_rows) {
    assert.ok(ERRORS.w3_section.includes(r), `design row ${r} not in W3`);
  }
  assert.deepEqual(
    sorted(tags),
    sorted(new Set([...ERRORS.w3_section, ...ERRORS.design_8_4_existing])),
  );
});

test("TEXT_LEFT_REASONS equals the native TextLeftReason enum", () => {
  assert.deepEqual([...TEXT_LEFT_REASONS], ERRORS.text_left_reason);
});

/** Every `SeatListRejection`, written out (tsc refuses a missing or extra). */
const SEAT_LIST_REJECTIONS: Record<SeatListRejection, true> = {
  malformed: true,
  wrong_channel: true,
  unsorted: true,
  duplicate: true,
  signer_not_seated: true,
  signer_mismatch: true,
  too_many_seats: true,
  immutable_changed: true,
  authority_invalid: true,
};

test("SeatListRejection equals the native SeatListRejection enum", () => {
  assert.deepEqual(
    sorted(Object.keys(SEAT_LIST_REJECTIONS)),
    sorted(ERRORS.seat_list_rejection),
  );
});

test("the native keys are pinned to one full desktop commit with sha256s", () => {
  const e = pinned(ERRORS.sources, ERROR_RS_PATH);
  const t = pinned(COMMANDS.sources, TEXT_RS_PATH);
  for (const s of [e, t]) {
    assert.match(s.commit, /^[0-9a-f]{40}$/, s.file);
    assert.match(s.sha256, /^[0-9a-f]{64}$/, s.file);
  }
  assert.equal(e.commit, t.commit);
  assert.ok(e.commit.startsWith("876c034"), "desktop 876c034 (S2-W3 final)");
});

// ---------------------------------------------------------------------------
// Extra: the fixtures still match the pinned sources (skip when absent)
// ---------------------------------------------------------------------------

test("fixtures match the pinned S1 design notes", { skip: SKIP_NOTES }, () => {
  const design = read(DESIGN);
  const errorSrc = read(ERROR_RS);

  // commands: design 8.3 table, mentions in the S1 .rs files
  const s83 = between(design, "### 8.3 Commands", "### 8.4");
  const table = [...s83.matchAll(/^\| `(e2ee_[a-z_]+)` /gm)].map((m) => m[1]);
  assert.deepEqual(table, COMMANDS.design_8_3_table);
  // `_mark_left` is named by the native error source (its reason enum);
  // `_pin_own_devices` is W3 plan D7 / 3a (no pinned file names it).
  assert.match(errorSrc, /`e2ee_text_mark_left`/);
  const COMMAND_TOKEN =
    /\b(e2ee_text_[a-z][a-z_]*[a-z]|e2ee_mls_group_kind)\b/g;
  const mentioned = new Set(
    [errorSrc, read(TYPES_RS)].flatMap((s) =>
      [...s.matchAll(COMMAND_TOKEN)].map((m) => m[1]),
    ),
  );
  assert.deepEqual(sorted(mentioned), COMMANDS.named_in_native_sources);

  // design 8.4 rows and the existing set
  const s84 = between(design, "### 8.4 Typed errors", "## 9.");
  const ROW = /^\| `([A-Z][A-Za-z]+)` \|/gm;
  const rows = [...s84.matchAll(ROW)].map((m) => snake(m[1]));
  assert.deepEqual(rows, ERRORS.design_8_4_rows);
  const para = between(s84, "Existing ", "apply to text groups");
  const existing = [...para.matchAll(/`([A-Z][A-Za-z]+)`/g)].map((m) =>
    snake(m[1]),
  );
  assert.deepEqual(existing, ERRORS.design_8_4_existing);
});

test("fixtures match the pinned desktop commit", { skip: SKIP_NATIVE }, () => {
  const errB = NATIVE_ERROR_SRC as Buffer;
  const txtB = NATIVE_TEXT_SRC as Buffer;
  assert.equal(sha256(errB), pinned(ERRORS.sources, ERROR_RS_PATH).sha256);
  assert.equal(sha256(txtB), pinned(COMMANDS.sources, TEXT_RS_PATH).sha256);
  const errorSrc = errB.toString("utf8");
  const textSrc = txtB.toString("utf8");

  // errors: the whole enum, its W3 section, the S2 appended block
  const body = enumBody(errorSrc, "Error");
  assert.deepEqual(variants(body).map(snake), ERRORS.error_enum);
  const w3 = body.indexOf("// ---- protected-channel text MLS (W3");
  assert.ok(w3 > 0, "W3 section marker");
  assert.deepEqual(variants(body.slice(w3)).map(snake), ERRORS.w3_section);
  const s2 = body.indexOf("// Appended in slice order");
  assert.ok(s2 > w3, "S2 appended marker");
  assert.deepEqual(variants(body.slice(s2)).map(snake), ERRORS.s2_appended);
  const left = variants(enumBody(errorSrc, "TextLeftReason")).map(snake);
  assert.deepEqual(left, ERRORS.text_left_reason);
  const seat = variants(enumBody(errorSrc, "SeatListRejection")).map(snake);
  assert.deepEqual(seat, ERRORS.seat_list_rejection);

  // commands: every #[tauri::command], its parameters minus the carriers
  const COMMAND =
    /#\[tauri::command\]\npub (?:async )?fn (\w+)\(\n([\s\S]*?)\n\) ->/g;
  const args: Record<string, string[]> = {};
  for (const m of textSrc.matchAll(COMMAND)) {
    args[m[1]] = [...m[2].matchAll(/^ {4}(\w+): /gm)]
      .map((p) => p[1])
      .filter((p) => p !== "shell" && p !== "app")
      .map(camel);
  }
  assert.deepEqual(Object.keys(args), COMMANDS.tauri_commands);
  assert.deepEqual(args, COMMANDS.tauri_args);
});

// ---------------------------------------------------------------------------
// S2 D40: textApi, lifted from e2ee.ts and run against a stub fetch
// ---------------------------------------------------------------------------

const E2EE_FILE =
  process.env.PROTECTED_TEXT_API_TS || new URL("./e2ee.ts", import.meta.url);

/**
 * Index just past the `}` matching the `{` at `open`, skipping strings,
 * template literals and comments (the protectedSeam.scan.test.ts helper).
 */
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

/**
 * The declaration `head` matches in e2ee.ts (from its first non-space, up
 * to its body's closing brace). `head` must end at the parameter list's
 * opening parenthesis.
 */
function declOf(head: RegExp): string {
  const src = readFileSync(E2EE_FILE, "utf8");
  const m = head.exec(src);
  assert.ok(m, `not found in e2ee.ts: ${head}`);
  // The body brace: the first "{" after the parameter list closes.
  let i = m.index + m[0].length;
  let parens = 1;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    if (src[i] === ")") parens--;
    if (src[i] === "{" && parens === 0) break;
  }
  const start = m.index + m[0].length - m[0].trimStart().length;
  return src.slice(start, matchBrace(src, i));
}

/** `async textApi(...) { ... }` as written in e2ee.ts. */
const textApiDecl = () => declOf(/\n {2}async textApi\(/);

interface FetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    signal: AbortSignal | undefined;
  };
}

type TextApi = (
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  headers?: TextApiHeaders,
) => Promise<TextApiResponse>;

const AUTH = ["X-Session-Token", "session-token"] as const;
const BASE = "https://api.sloga.test";

/** A bridge holding only the real `textApi`, and the fetches it made. */
function liftTextApi(status = 200, text = "{}") {
  const calls: FetchCall[] = [];
  const fakeFetch = async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return {
      status,
      headers: { get: () => null },
      text: async () => text,
    };
  };
  const client = {
    authenticationHeader: AUTH,
    options: { baseURL: BASE },
  };
  const ts = `class Bridge {
  #client;
  constructor(client) {
    this.#client = client;
  }
  ${textApiDecl()}
}`;
  const bridge = new Function(
    "client",
    "fetch",
    `${stripTypeScriptTypes(ts)}\nreturn new Bridge(client);`,
  )(client, fakeFetch) as { textApi: TextApi };
  return { textApi: bridge.textApi.bind(bridge), calls };
}

const REASON = "X-Audit-Log-Reason";

test("textApi: the audit-log reason is trimmed and percent-encoded, as stoat.js sends it", async () => {
  const accents = String.fromCodePoint(0xdc, 0x6e, 0xef, 0x20, 0x2713);
  const cases: [string, string][] = [
    ["  Spam & abuse  ", "Spam%20%26%20abuse"],
    ["line\nbreak", "line%0Abreak"],
    ["100%", "100%25"],
    ["a/b?c#d", "a%2Fb%3Fc%23d"],
    [accents, encodeURIComponent(accents)],
    ["\t plain \n", "plain"],
  ];
  for (const [raw, sent] of cases) {
    const { textApi, calls } = liftTextApi();
    await textApi("PUT", "/channels/C1/seats", { body: "b" }, undefined, {
      [REASON]: raw,
    });
    assert.equal(calls.length, 1);
    // stoat.js `Server.kickUser`: `encodeURIComponent(reason.trim())`.
    assert.equal(calls[0].init.headers[REASON], sent, JSON.stringify(raw));
    assert.equal(sent, encodeURIComponent(raw.trim()));
  }
});

test("textApi: a blank, absent or non-string reason sends no audit-log header", async () => {
  const none: (TextApiHeaders | undefined)[] = [
    undefined,
    { [REASON]: "" },
    { [REASON]: "   \t\n " },
    { [REASON]: 5 as unknown as string },
    { [REASON]: null as unknown as string },
    {} as TextApiHeaders,
  ];
  for (const headers of none) {
    const { textApi, calls } = liftTextApi();
    await textApi(
      "PUT",
      "/channels/C1/seats",
      { body: "b" },
      undefined,
      headers,
    );
    assert.ok(
      !Object.hasOwn(calls[0].init.headers, REASON),
      JSON.stringify(headers),
    );
  }
});

test("textApi: only the audit-log header is added; the request is otherwise unchanged", async () => {
  const signal = new AbortController().signal;
  const { textApi, calls } = liftTextApi(409, '{"type":"Conflict"}');
  const extra = {
    [REASON]: "reason",
    "Idempotency-Key": "k",
  } as unknown as TextApiHeaders;
  const res = await textApi(
    "PUT",
    "/channels/C1/seats",
    { x: 1 },
    signal,
    extra,
  );
  assert.equal(calls[0].url, `${BASE}/channels/C1/seats`);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.body, '{"x":1}');
  assert.equal(calls[0].init.signal, signal);
  assert.deepEqual(calls[0].init.headers, {
    [AUTH[0]]: AUTH[1],
    "Content-Type": "application/json",
    [REASON]: "reason",
  });
  // A non-2xx still resolves with the parsed body (never thrown).
  assert.deepEqual(res, {
    status: 409,
    resetAfterMs: null,
    body: { type: "Conflict" },
  });

  // Without headers: exactly the S1 request.
  const plain = liftTextApi();
  await plain.textApi("GET", "/channels/C1/seats");
  assert.deepEqual(plain.calls[0].init.headers, { [AUTH[0]]: AUTH[1] });
  assert.equal(plain.calls[0].init.body, undefined);
});

// ---------------------------------------------------------------------------
// S2 OR-6 and design 7.5: onEvent, lifted from e2ee.ts and run. Every
// private member it names is declared; the ones these arms use are stubs,
// any other throws if reached.
// ---------------------------------------------------------------------------

/** `joinIntentSignedFields` as written in e2ee.ts (plain JS). */
const signedFieldsDecl = () =>
  declOf(/\nexport function joinIntentSignedFields\(/).replace(/^export /, "");

type SignedFields = (event: Record<string, unknown>) => {
  generation?: number;
  issued_at?: number;
} | null;

function liftSignedFields(): SignedFields {
  return new Function(
    `${stripTypeScriptTypes(signedFieldsDecl())}\nreturn joinIntentSignedFields;`,
  )() as SignedFields;
}

interface EventRig {
  onEvent(event: Record<string, unknown>): void;
  routed: { request: Record<string, unknown>; rejoin: boolean }[];
  sunk: unknown[];
  warned: unknown[][];
}

function liftOnEvent(
  opts: { route?: "call" | "handled"; manager?: unknown } = {},
): EventRig {
  const onEvent = declOf(
    /\n {2}onEvent\((?=event: E2EEServerEvent\): void \{)/,
  );
  const privates = [
    ...new Set([...onEvent.matchAll(/this\.#(\w+)/g)].map((m) => m[1])),
  ];
  const r: EventRig = {
    onEvent: () => undefined,
    routed: [],
    sunk: [],
    warned: [],
  };
  const stubs: Record<string, unknown> = {
    protectedRouteJoinRequest: (
      request: Record<string, unknown>,
      rejoin: boolean,
    ) => {
      r.routed.push({ request, rejoin });
      return opts.route ?? "call";
    },
    mlsSink: (e: unknown) => r.sunk.push(e),
    ptManager: opts.manager ?? null,
  };
  const missing = (name: string) => () => {
    throw new Error(`onEvent reached the unstubbed #${name}`);
  };
  const ts = `${signedFieldsDecl()}
class Bridge {
  ${privates.map((p) => `#${p};`).join("\n  ")}
  constructor(stubs) {
    ${privates
      .map((p) => {
        const k = JSON.stringify(p);
        return `this.#${p} = ${k} in stubs ? stubs[${k}] : missing(${k});`;
      })
      .join("\n    ")}
  }
  ${onEvent}
}`;
  const fakeConsole = {
    warn: (...a: unknown[]) => r.warned.push(a),
    error: (...a: unknown[]) => r.warned.push(a),
  };
  const bridge = new Function(
    "stubs",
    "console",
    "missing",
    `${stripTypeScriptTypes(ts)}\nreturn new Bridge(stubs);`,
  )(stubs, fakeConsole, missing) as { onEvent(e: unknown): void };
  r.onEvent = (e) => bridge.onEvent(e);
  return r;
}

const S1_INTENT = {
  type: "MlsJoinRequested",
  group_id: "a".repeat(64),
  channel_id: "01CHANNEL",
  user_id: "01PEER",
  device_id: "DEVPEER",
  key_package_ref: "KPR-SECRETLESS",
  signature: "SIG-BYTES",
};
const S1_FIELDS = (({ type: _type, ...rest }) => rest)(S1_INTENT);

test("joinIntentSignedFields: absent stays S1; present must be a safe non-negative integer", () => {
  const f = liftSignedFields();
  assert.deepEqual(f({}), {});
  assert.deepEqual(f({ generation: undefined, issued_at: undefined }), {});
  assert.deepEqual(f({ generation: 0, issued_at: 0 }), {
    generation: 0,
    issued_at: 0,
  });
  assert.deepEqual(f({ generation: 3 }), { generation: 3 });
  assert.deepEqual(f({ issued_at: Number.MAX_SAFE_INTEGER }), {
    issued_at: Number.MAX_SAFE_INTEGER,
  });
  for (const bad of [1.5, -1, "3", null, NaN, Infinity, 2 ** 53, {}, true]) {
    for (const key of ["generation", "issued_at"]) {
      assert.equal(f({ [key]: bad }), null, `${key}=${String(bad)}`);
      // One malformed field spoils a valid other one: never half an intent.
      const other = key === "generation" ? "issued_at" : "generation";
      assert.equal(f({ [key]: bad, [other]: 1 }), null, `${key} + ${other}`);
    }
  }
});

test("onEvent MlsJoinRequested (OR-6): an S1 intent keeps its six fields; v2 fields ride along", () => {
  const s1 = liftOnEvent();
  s1.onEvent(S1_INTENT);
  assert.deepEqual(s1.routed, [{ request: S1_FIELDS, rejoin: false }]);
  assert.deepEqual(s1.sunk, [
    { kind: "join_request", request: S1_FIELDS, rejoin: false },
  ]);
  assert.deepEqual(s1.warned, []);

  const v2 = liftOnEvent({ route: "handled" });
  v2.onEvent({
    ...S1_INTENT,
    generation: 3,
    issued_at: 1_731_400_000_000,
    rejoin: true,
  });
  assert.deepEqual(v2.routed, [
    {
      request: { ...S1_FIELDS, generation: 3, issued_at: 1_731_400_000_000 },
      rejoin: true,
    },
  ]);
  assert.deepEqual(v2.sunk, [], "a text intent never reaches the call sink");
});

test("onEvent MlsJoinRequested (OR-6): a present but malformed generation or issued_at drops the whole intent, ids only in the log", () => {
  for (const bad of [1.5, -1, "3", null, NaN, 2 ** 53, {}]) {
    for (const key of ["generation", "issued_at"]) {
      const r = liftOnEvent();
      r.onEvent({ ...S1_INTENT, [key]: bad });
      const why = `${key}=${String(bad)}`;
      assert.deepEqual(r.routed, [], `${why}: not handed to the manager`);
      assert.deepEqual(r.sunk, [], `${why}: not the call path either`);
      assert.equal(r.warned.length, 1, why);
      assert.deepEqual(r.warned[0], [
        "[protected] malformed join request dropped",
        { groupId: "a".repeat(64), userId: "01PEER", deviceId: "DEVPEER" },
      ]);
      const logged = JSON.stringify(r.warned);
      assert.ok(!logged.includes("SIG-BYTES"), "no signature in the log");
      assert.ok(!logged.includes("KPR-SECRETLESS"), "no key package ref");
    }
  }
});

test("onEvent ProtectedChannelChanged: id and scope to the manager's hook only, never the call path", () => {
  const seen: unknown[][] = [];
  const scope = ["seats", "text_group", "from_the_future"];
  const r = liftOnEvent({
    manager: { onChannelChanged: (...a: unknown[]) => seen.push(a) },
  });
  r.onEvent({ type: "ProtectedChannelChanged", id: "01CHANNEL", scope });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "01CHANNEL");
  assert.equal(seen[0][1], scope, "scope as received (the manager filters)");
  assert.deepEqual(r.routed, []);
  assert.deepEqual(r.sunk, []);
  // Malformed: nothing reaches the hook.
  for (const bad of [
    { id: 7, scope },
    { id: "01CHANNEL", scope: "seats" },
    { id: "01CHANNEL" },
  ]) {
    r.onEvent({ type: "ProtectedChannelChanged", ...bad });
  }
  assert.equal(seen.length, 1, "malformed events are dropped");
  // No hook yet (the W4-0 manager), or no manager: a no-op, never a throw.
  liftOnEvent({ manager: {} }).onEvent({
    type: "ProtectedChannelChanged",
    id: "01CHANNEL",
    scope,
  });
  liftOnEvent().onEvent({
    type: "ProtectedChannelChanged",
    id: "01CHANNEL",
    scope,
  });
});

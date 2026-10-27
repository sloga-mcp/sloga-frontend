// Source-scan spec for the Protected channels seam in `e2ee.ts` (W4 lane B5,
// plan 4.3 / §7). `e2ee.ts` cannot load under Node (Solid, the native
// bridge, stoat.js), so this reads it as text and pins the wiring rules:
//
//  S1  placement: every seam member sits in the BEGIN/END block right after
//      `mlsClaimKeyPackage` and before `mlsCreateGroup` (PA#10);
//  S2  `routeMls` runs BEFORE `#deliverMlsEnvelope` / `#mlsSink` in all three
//      MLS event arms, and a ctl never reaches the text manager;
//  S3  the pre-index buffer is cleared at every `#mlsBuffer.clear()` site;
//  S4  protected ids never enter `#encryptedIds`;
//  S5  `textInvoke` is the only text-command path and refuses unless
//      `protectedTextCapable()` (and outside `TEXT_COMMANDS`). S7 D9 / PA-7
//      amendment: the ONLY other text-command literals are the 3 dialog
//      routes in `CapacitorTransport.invoke` (each to its own plugin
//      method). Capability is `structuralState` (lane C4) over the bridge's
//      facts, ANDed with every W4 term plus C4's hold and `storeOwnerAllows`;
//  S6  no edit to `NativeTransport` or any transport class beyond the S7
//      additions (the region is byte-identical to the pinned S7 region);
//  S7  `markReady()` runs on EVERY `#onReady`, capable or not (W4a audit);
//  S8  the manager is built only once `status.device_id` is known; seeding
//      uses `Promise.allSettled`; `port.sleep` rejects after dispose;
//      dispose on the wipe and ownership paths; the D12 gate; no
//      `Idempotency-Key` and no draft-guard resolver in the seam.
//  S10 (W4c#2) decrypt requests that arrive before a manager exists are
//      held (Tauri main window only), bounded, deduped by id (live wins),
//      replayed in arrival order once `start()` settles, and cleared on
//      dispose. The hold logic is lifted out of the source and RUN.
//  S11 (W4d F#3) a strip the manager was handed is undone: a later
//      `onChannelProtected` (SDK latch clear) hands the channel over again,
//      once; forwarding stays deduped otherwise. The two hooks and
//      `#protectedForward` are lifted out of the source and RUN.
//
// Run: node --test --conditions=browser components/client/protectedSeam.scan.test.ts
// `PROTECTED_SEAM_TS=<path>` scans another copy (named controls; the
// 4363b406 e2ee.ts is the known-bad baseline and fails S1-S8; the W4 tip
// 5b61eef1 e2ee.ts fails the S7 S5 capability tests and S6).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import { fetchProtectedChannelsFlag } from "./protectedChannelsFlag.ts";
import {
  type ShellTransportKind,
  type StructuralInput,
  storeOwnerAllows,
  structuralState,
} from "./protectedPlatform.ts";
import {
  isProtectedSendError,
  ProtectedSendError,
  toProtectedSendError,
} from "./protectedSendError.ts";
import { TEXT_COMMANDS } from "./protectedTextTypes.ts";

const FILE =
  process.env.PROTECTED_SEAM_TS || new URL("./e2ee.ts", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

/**
 * sha256 of the transport region (`interface NativeTransport` up to
 * `function resumeRecordStorage`).
 *
 * W4 pinned it to origin/main 1dcdd1b4 (f1d615df...; before that the W4a
 * checkpoint 4363b406 value f34aa475...) and never edited it. S7 (plan D9,
 * PA-7) edits it ON PURPOSE, and this is the S7 lane C3 region (e2ee.ts
 * sha256 3b5b1b3c...). Against f1d615df... it only ADDS lines:
 * - `SlogaShellGlobal.e2ee.protectedText?: number` (the Electron D8 flag);
 * - the `E2eeCapacitorPlugin` entries `textSeatListSign`,
 *   `textOwnerConfirmChange`, `textOwnerHandoverSign` and `textCapability`;
 * - the 3 dialog routes in `CapacitorTransport.invoke` (S5 below);
 * - `CapacitorTransport.textCapability()` (the Android probe).
 * Any other change to the region is still a defect. Re-pin it only from a
 * reviewed change that states its reason here, or from main once S7 lands.
 *
 * Re-verified on the S7 x W4-final merge (S7 checkpoint 2c1b064c + W4
 * 19b5a693, which carries main v0.70.0): the value is unchanged, because
 * neither W4's S1-final fixes (0cdb58ce, 19b5a693) nor main touch the
 * region (W4's own region is still f1d615df...), so the merged region is
 * exactly the S7 one.
 */
const TRANSPORT_REGION_SHA256 =
  "b56392d20550bfe803558ae29689144d940269ba601ed2e23355e32876c9c2e8";

/**
 * S7 D9 / PA-7: the text commands Android signs only after a tap on a native
 * dialog, each routed by `CapacitorTransport.invoke` to its own
 * `E2eeCapacitorPlugin` method (the `enableGroup` pattern, lanes C3 / C12).
 * They are the only text-command literals S5 allows outside `textInvoke`.
 */
const CAPACITOR_DIALOG_ROUTES: Readonly<Record<string, string>> = {
  e2ee_text_seat_list_sign: "textSeatListSign",
  e2ee_text_owner_confirm_change: "textOwnerConfirmChange",
  e2ee_text_owner_handover_sign: "textOwnerHandoverSign",
};

/**
 * `#encryptedIds.add(` call sites at 4363b406 and at origin/main 1dcdd1b4;
 * the seam adds none.
 */
const ENCRYPTED_IDS_ADD_SITES = 2;

/**
 * `#mlsBuffer.clear()` sites at 4363b406 (plan D4) and at origin/main
 * 1dcdd1b4.
 */
const MLS_BUFFER_CLEAR_SITES = 4;

// ---- Source helpers ---------------------------------------------------------

/**
 * Index just past the `}` matching the `{` at `open`, skipping strings,
 * template literals and comments (good enough for this file's style).
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

/** The body (braces included) of the class member declared by `head`. */
function member(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  // The body brace: the first "{" after the closing ")" of the parameters
  // (and after any return type).
  let i = m.index + m[0].length;
  let parens = count(m[0], "(") - count(m[0], ")");
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    if (src[i] === ")") parens--;
    if (src[i] === "{" && parens === 0) break;
  }
  return src.slice(i, matchBrace(src, i));
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** Strip `//` and block comments (strings kept) for statement checks. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const BEGIN = "// BEGIN protected seam";
const END = "// END protected seam";

function seamBlock(): string {
  const b = SRC.indexOf(BEGIN);
  const e = SRC.indexOf(END);
  assert.ok(b >= 0 && e > b, "S1: BEGIN/END protected seam markers present");
  return SRC.slice(b, e);
}

/** The seam block without comments (code only). */
function seamCode(): string {
  return stripComments(seamBlock());
}

function caseSegment(body: string, label: string): string {
  const start = body.indexOf(label);
  assert.ok(start >= 0, `case not found: ${label}`);
  const next = body.indexOf('\n      case "', start + label.length);
  return body.slice(start, next < 0 ? body.length : next);
}

// ---- S1 placement -----------------------------------------------------------

test("S1: the seam block sits right after mlsClaimKeyPackage, before mlsCreateGroup", () => {
  const claim = SRC.indexOf("\n  mlsClaimKeyPackage(");
  const create = SRC.indexOf("\n  mlsCreateGroup(");
  assert.ok(claim >= 0 && create > claim, "anchors present");
  const claimEnd = matchBrace(SRC, SRC.indexOf("{", SRC.indexOf(")", claim)));
  const b = SRC.indexOf(BEGIN);
  const e = SRC.indexOf(END);
  assert.ok(b > claimEnd && e > b && e < create, "block between the anchors");
  // Nothing but the block's banner between mlsClaimKeyPackage and BEGIN.
  const gap = SRC.slice(claimEnd, b);
  assert.match(gap, /^\s*\/\/ =+\s*$/, "block starts right after the claim");
});

test("S1: every seam member is declared inside the block", () => {
  const block = seamBlock();
  const outside = SRC.replace(block, "");
  const decl =
    /^ {2}(?:readonly |static |async |get )*(#pt\w+|#protected\w+|#textInvoke|textApi|protectedTextCapable|protectedFlag|protectedOpen|protectedClose|seatsSnapshot|disposeProtected|setProtectedOutboxKeys|handleProtectedSend|onProtectedMessage|decryptProtectedHistory|onProtectedFlagStripped|onChannelProtected|protectedChannels|protectedViews|protectedTimelineMarkers|protectedToast|protectedUi)\b(?=\s*[(<=:])/gm;
  const inBlock = [...block.matchAll(decl)].map((m) => m[1]);
  const elsewhere = [...outside.matchAll(decl)].map((m) => m[1]);
  assert.deepEqual(elsewhere, [], "no seam member outside the block");
  for (const name of [
    "#ptIndex",
    "#ptPreIndex",
    "#textInvoke",
    "textApi",
    "protectedTextCapable",
    "#protectedOnReady",
    "#protectedRouteEnvelope",
    "#protectedRouteJoinRequest",
    "handleProtectedSend",
    "onChannelProtected",
  ]) {
    assert.ok(inBlock.includes(name), `declared in the block: ${name}`);
  }
});

// ---- S2 routing before the call path ----------------------------------------

test("S2: routeMls runs before #deliverMlsEnvelope / #mlsSink in all three arms", () => {
  const onEvent = member(SRC, /\n {2}onEvent\(event: E2EEServerEvent\): void /);
  // E2EEMessage (mailbox drain) and MlsCommit|MlsWelcome|MlsCtl: the call
  // delivery is reached only when the route answered "call".
  const guarded =
    /if \(\s*sinkEvent &&\s*this\.#protectedRouteEnvelope\([^;{}]*\)\s*===\s*"call"\s*\) \{\s*this\.#deliverMlsEnvelope\(sinkEvent\);\s*\}/;
  // (`case "MlsCommit":` and `case "MlsWelcome":` fall through to the
  // `case "MlsCtl"` body.)
  for (const label of ['case "E2EEMessage"', 'case "MlsCtl"']) {
    const seg = caseSegment(onEvent, label);
    assert.match(seg, guarded, `${label}: delivery guarded by the route`);
    assert.equal(count(seg, "#deliverMlsEnvelope("), 1, `${label}: one call`);
    assert.ok(
      seg.indexOf("#protectedRouteEnvelope(") <
        seg.indexOf("#deliverMlsEnvelope("),
      `${label}: routed first`,
    );
  }
  // MlsJoinRequested: routed first, the call sink only on "call".
  const join = caseSegment(onEvent, 'case "MlsJoinRequested"');
  assert.match(
    join,
    /if \(this\.#protectedRouteJoinRequest\(request, rejoin\) !== "call"\) \{\s*break;\s*\}\s*this\.#mlsSink\?\.\(/,
    "join request: routed before the call sink",
  );
  assert.equal(count(join, "#mlsSink"), 1, "join request: one sink call");
  // No other call-path delivery anywhere in onEvent.
  assert.equal(count(onEvent, "#deliverMlsEnvelope("), 2);
  assert.equal(count(onEvent, "#mlsSink"), 1);
});

test("S2: both route helpers evaluate routeMls; a ctl never reaches text", () => {
  const env = member(SRC, /\n {2}#protectedRouteEnvelope\(/);
  const ctl = env.indexOf('"mls_ctl"');
  const route = env.indexOf("routeMls(");
  assert.ok(ctl >= 0 && route > ctl, "ctl short-circuit precedes routeMls");
  assert.match(
    env.slice(0, route),
    /if \(contentType === "mls_ctl" \|\| event\.content_type === "mls_ctl"\) \{\s*return "call";\s*\}/,
    "a ctl (either type source) goes to the call path",
  );
  assert.match(env, /kind: "envelope"/);
  const text = env.indexOf('case "text"');
  assert.ok(text > route, "text arm present");
  assert.equal(count(env, "textSinkEnvelope("), 1);
  assert.ok(env.indexOf("textSinkEnvelope(") > text, "builder only for text");
  assert.equal(count(env, ".onEnvelope("), 1);
  assert.match(env, /case "pre_index_hold":\s*this\.#ptPreIndex\.push\(/);

  const join = member(SRC, /\n {2}#protectedRouteJoinRequest\(/);
  assert.match(join, /routeMls\(\{[\s\S]*kind: "join_request"/);
  assert.match(join, /recipientDeviceId: null/);
  assert.doesNotMatch(join, /#ptPreIndex/, "join requests are never held");
});

// ---- S3 pre-index buffer cleared with #mlsBuffer ------------------------------

test("S3: the pre-index buffer is cleared at every #mlsBuffer.clear() site", () => {
  const clears = [...SRC.matchAll(/this\.#mlsBuffer\.clear\(\);/g)];
  assert.equal(clears.length, MLS_BUFFER_CLEAR_SITES, "four clear sites");
  for (const m of clears) {
    const after = SRC.slice(m.index! + m[0].length, m.index! + 200);
    assert.match(
      after,
      /^\s*this\.#ptPreIndex\.clear\(\);/,
      `pre-index cleared right after the clear at offset ${m.index}`,
    );
  }
  // Nowhere else drains or clears it except the flush.
  assert.equal(count(SRC, "#ptPreIndex.clear()"), MLS_BUFFER_CLEAR_SITES);
  assert.equal(count(SRC, "#ptPreIndex.drain()"), 1);
});

// ---- S4 #encryptedIds untouched --------------------------------------------

test("S4: protected ids never enter #encryptedIds", () => {
  const block = seamCode();
  assert.equal(count(block, "#encryptedIds"), 0, "no #encryptedIds in seam");
  for (const t of ["trustEncryptedId", "adoptTrustedRow", "#seedOnly"]) {
    assert.equal(count(block, t), 0, `no ${t} in seam`);
  }
  assert.equal(
    count(SRC, "#encryptedIds.add("),
    ENCRYPTED_IDS_ADD_SITES,
    "no new #encryptedIds.add site",
  );
});

// ---- S5 textInvoke ------------------------------------------------------------

test("S5: textInvoke is allow-listed and refuses unless protectedTextCapable()", () => {
  const body = stripComments(member(SRC, /\n {2}#textInvoke</));
  const allow = body.indexOf("TEXT_COMMANDS");
  const guard = body.indexOf("if (!this.protectedTextCapable())");
  // S1-final A-1: the native call moved into `#protectedTextDispatch`, which
  // only textInvoke calls (wrapped in the store-owner escalation).
  const call = body.indexOf("this.#protectedTextDispatch(cmd, args)");
  assert.equal(count(body, "this.#invoke"), 0, "no direct #invoke here");
  assert.equal(
    count(SRC, "this.#protectedTextDispatch("),
    1,
    "the dispatch has one caller: textInvoke",
  );
  assert.ok(allow >= 0, "allow-list checked");
  assert.ok(guard >= 0, "capability checked");
  assert.ok(call > guard && call > allow, "native reached only after both");
  assert.match(
    body.slice(guard),
    /^if \(!this\.protectedTextCapable\(\)\) \{\s*return Promise\.reject\(/,
    "not capable → rejected",
  );
  // The port's invoke is textInvoke; no text command literal elsewhere.
  const port = member(SRC, /\n {2}#protectedPort\(/);
  assert.match(
    port,
    /invoke: <C extends TextCommand>\([^)]*\) =>\s*this\.#textInvoke\(cmd, args\)/,
  );
  // W4d L-IOSGATE: the names are literals now (iOS gate G6-fe-dynamic), but
  // only inside textInvoke's dispatch: each one is a case label plus its own
  // #invoke.
  // S7 D9 / PA-7 amendment (was: zero literals outside the dispatch): Android
  // shows the 3 dialog commands' prompts from dedicated plugin methods, so
  // `CapacitorTransport.invoke` names exactly those (S5 test below). They
  // are reached only through the dispatch's own arms (`this.#invoke`).
  const textLit = /"e2ee_text_\w+"|"e2ee_mls_group_kind"/g;
  const raw = member(SRC, /\n {2}#protectedTextDispatch</);
  assert.ok(SRC.includes(raw), "dispatch lifted verbatim");
  assert.equal(
    [...SRC.replace(raw, "").matchAll(textLit)].filter(
      (m) => !Object.hasOwn(CAPACITOR_DIALOG_ROUTES, m[0].slice(1, -1)),
    ).length,
    0,
    "no text command named outside the dispatch but a Capacitor dialog route",
  );
  const dispatch = stripComments(raw);
  assert.equal(
    [...dispatch.matchAll(textLit)].length,
    2 * TEXT_COMMANDS.length,
    "one case label and one #invoke per text command, nothing else",
  );
  for (const name of TEXT_COMMANDS) {
    assert.equal(
      count(
        dispatch,
        `case "${name}":\n        return this.#invoke<Out>("${name}", a);`,
      ),
      1,
      `${name} has exactly one arm, invoking its own name`,
    );
  }
  assert.equal(count(dispatch, "this.#invoke"), TEXT_COMMANDS.length);
  assert.match(
    dispatch,
    /default: \{\s*const _exhaustive: never = command;\s*return Promise\.reject\(\{ source: "client", reason: "not_allowed" \}\);\s*\}/,
    "the default is a never check that refuses",
  );
});

test("S5 (S7 D9): outside textInvoke's dispatch, only CapacitorTransport.invoke names a text command, as a dialog route", () => {
  const textLit = /"e2ee_text_\w+"|"e2ee_mls_group_kind"/g;
  // S1-final A-1 moved the literal arms into `#protectedTextDispatch`.
  const raw = member(SRC, /\n {2}#protectedTextDispatch</);
  const tiAt = SRC.indexOf(raw);
  assert.ok(tiAt >= 0 && SRC.indexOf(raw, tiAt + 1) < 0, "one dispatch");
  const capInvoke = member(
    member(SRC, /\nclass CapacitorTransport implements NativeTransport /),
    /\n {2}async invoke<T>\(/,
  );
  const capAt = SRC.indexOf(capInvoke);
  assert.ok(capAt >= 0 && SRC.indexOf(capInvoke, capAt + 1) < 0);
  const outside = [...SRC.matchAll(textLit)].filter(
    (m) => m.index! < tiAt || m.index! >= tiAt + raw.length,
  );
  for (const m of outside) {
    const name = m[0].slice(1, -1);
    assert.ok(
      Object.hasOwn(CAPACITOR_DIALOG_ROUTES, name),
      `${name} named outside the dispatch (offset ${m.index}): only a dialog command may be`,
    );
    assert.ok(
      m.index! > capAt && m.index! < capAt + capInvoke.length,
      `${name} named outside CapacitorTransport.invoke (offset ${m.index})`,
    );
  }
  for (const [name, method] of Object.entries(CAPACITOR_DIALOG_ROUTES)) {
    assert.ok(
      (TEXT_COMMANDS as readonly string[]).includes(name),
      `${name} is a text command`,
    );
    const named = outside.filter((m) => m[0] === `"${name}"`).length;
    assert.ok(named <= 1, `${name}: at most one route`);
    // Present or absent (C3's wiring scan and S6 pin presence), every
    // literal is the route to its OWN method, args passed as-is.
    const route = new RegExp(
      String.raw`if \(command === "${name}"\) \{\s*const \{ json \} = await this\.#plugin\.${method}\(\s*\(args as Record<string, unknown>\) \?\? \{\},\s*\);\s*return JSON\.parse\(json\) as T;\s*\}`,
      "g",
    );
    assert.equal(
      [...capInvoke.matchAll(route)].length,
      named,
      `${name}: each literal is a route to this.#plugin.${method}`,
    );
  }
  // No prefix or pattern dispatch of text commands in the transport.
  assert.equal(
    count(stripComments(capInvoke), "e2ee_text_"),
    outside.length,
    "CapacitorTransport.invoke names e2ee_text_ only in the routes",
  );
  assert.equal(count(stripComments(capInvoke), "e2ee_mls_group_kind"), 0);
});

test("S5 (S7 D9): #protectedStructural is structuralState over the bridge's facts, popout/overlay included", () => {
  const norm = (s: string) => stripComments(s).replace(/\s+/g, " ").trim();
  const structural = member(SRC, /\n {2}#protectedStructural\(\): boolean /);
  assert.equal(
    norm(structural),
    "{ return this.#protectedPlatformState().structural; }",
  );
  const state = member(
    SRC,
    /\n {2}#protectedPlatformState\(\): \{ structural: boolean; hold: boolean \} /,
  );
  assert.equal(
    norm(state),
    "{ return structuralState(this.#protectedPlatformInput()); }",
  );
  const input = stripComments(
    member(SRC, /\n {2}#protectedPlatformInput\(\): StructuralInput /),
  );
  // W4's `!IS_POPOUT_WINDOW && !IS_OVERLAY_WINDOW`, now C4 inputs.
  assert.match(input, /\n\s*popout: IS_POPOUT_WINDOW,\n/);
  assert.match(input, /\n\s*overlay: IS_OVERLAY_WINDOW,\n/);
  assert.match(input, /const transport = this\.#protectedTransportKind\(\);/);
  assert.match(input, /return \{\s*transport,\n/);
  const kind = stripComments(
    member(SRC, /\n {2}#protectedTransportKind\(\): ShellTransportKind /),
  );
  // W4's `this.#transport instanceof TauriTransport`, now the "tauri" kind.
  assert.match(
    kind,
    /^\{\s*const transport = this\.#transport;\s*if \(transport instanceof TauriTransport\) return "tauri";/,
  );
  assert.match(
    kind,
    /if \(transport instanceof ElectronTransport\) return "electron";/,
  );
  assert.match(
    kind,
    /if \(\s*transport instanceof CapacitorTransport &&\s*Capacitor\.isNativePlatform\(\)\s*\)\s*return "capacitor";/,
  );
  assert.match(kind, /return "web";\s*\}$/, "anything else is web (closed)");
  for (const [label, body] of [
    ["structural", structural],
    ["state", state],
    ["input", input],
    ["kind", kind],
  ]) {
    assert.doesNotMatch(body, /status/, `${label}: no status terms`);
  }
  assert.match(
    SRC,
    /^import \{ IS_OVERLAY_WINDOW, IS_POPOUT_WINDOW \} from "\.\/popout";$/m,
  );
  assert.match(
    SRC,
    /\n {2}structuralState,\n[\s\S]*?\} from "\.\/protectedPlatform";/,
    "C4's structuralState, imported",
  );
  assert.equal(count(SRC, "function structuralState"), 0, "not redefined");
  // And C4 closes a popout or overlay on every transport, whatever else.
  const open: StructuralInput[] = (
    ["tauri", "electron", "capacitor", "web"] as ShellTransportKind[]
  ).map((transport) => ({
    transport,
    platform: transport === "capacitor" ? "android" : "",
    electronProtocol: 1,
    androidProbe: { state: "ok", value: { protocol: 1, listenerBridge: true } },
    popout: false,
    overlay: false,
    flag: "on",
  }));
  for (const i of open) {
    for (const over of [{ popout: true }, { overlay: true }]) {
      assert.deepEqual(
        structuralState({ ...i, ...over }),
        { structural: false, hold: false },
        `${i.transport} ${JSON.stringify(over)}`,
      );
    }
  }
});

test("S5: protectedTextCapable ANDs every W4 term with C4's hold and storeOwnerAllows (D3, S7 D9)", () => {
  const capable = stripComments(
    member(SRC, /\n {2}protectedTextCapable\(\): boolean /),
  );
  assert.match(capable, /const status = this\.status\.get\("state"\);/);
  assert.match(capable, /const userId = this\.#client\.user\?\.id \?\? null;/);
  const ret = /return \(([\s\S]*)\);\s*\}$/.exec(capable);
  assert.ok(ret, "one parenthesised return");
  const expr = ret[1];
  assert.doesNotMatch(expr, /\|\||\?\?|\?\s/, "a pure conjunction");
  assert.doesNotMatch(expr, /\breturn\b/);
  const terms = expr
    .split("&&")
    .map((t) =>
      t.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/,? \)/g, ")").trim(),
    );
  for (const term of [
    // W4 D3
    "this.#protectedStructural()",
    "status?.enabled === true",
    "!!status.device_id",
    '!this.storeOwnedByAnotherAccount.has("state")',
    '!this.deviceOwnedElsewhere.has("state")',
    "!this.#storeOwnerUnread", // S1-final A-1
    // S7 D9: a pending probe / unknown flag reaches no native text command
    "!this.#protectedPlatformState().hold",
    // S7 Step 0 fold 1 (A8): a signed-in user and C4's store-owner rule
    "!!userId",
    "storeOwnerAllows(this.#protectedTransportKind(), this.#ptStoreOwner, userId)",
  ]) {
    assert.ok(terms.includes(term), `capable ANDs ${term}`);
  }
  assert.match(
    SRC,
    /\n {2}storeOwnerAllows,\n[\s\S]*?\} from "\.\/protectedPlatform";/,
    "C4's storeOwnerAllows, imported",
  );
  assert.equal(count(SRC, "function storeOwnerAllows"), 0, "not redefined");
});

// ---- S6 transports untouched ----------------------------------------------------

test("S6: NativeTransport and the transport classes carry only the S7 additions", () => {
  const start = SRC.indexOf("interface NativeTransport {");
  const end = SRC.indexOf("function resumeRecordStorage");
  assert.ok(start >= 0 && end > start, "transport region present");
  const sha = createHash("sha256").update(SRC.slice(start, end)).digest("hex");
  assert.equal(
    sha,
    TRANSPORT_REGION_SHA256,
    "transport region byte-identical to the pinned S7 region (C3 3b5b1b3c)",
  );
});

// ---- S7 markReady on every #onReady ---------------------------------------------

test("S7: #onReady always ends in #protectedOnReady (finally, unconditional)", () => {
  const onReady = member(SRC, /\n {2}async #onReady\(\): Promise<void> /);
  const fin = onReady.lastIndexOf("finally {");
  assert.ok(fin >= 0, "#onReady has a finally");
  const finBody = stripComments(
    onReady.slice(fin + 8, matchBrace(onReady, fin + 8)),
  );
  assert.match(
    finBody,
    /^\{\s*void this\.#protectedOnReady\(\);\s*\}$/,
    "the finally only (and always) runs the seam's ready step",
  );
});

test("S7: markReady() runs in a finally, unconditionally, after seeding", () => {
  const body = member(SRC, /\n {2}async #protectedOnReady\(\): Promise<void> /);
  const tryAt = body.indexOf("try {");
  const fin = body.lastIndexOf("finally {");
  assert.ok(tryAt >= 0 && fin > tryAt, "try/finally present");
  const tryBody = body.slice(tryAt, fin);
  assert.match(tryBody, /await Promise\.allSettled\(/, "seeding awaited");
  assert.ok(
    tryBody.indexOf("Promise.allSettled") <
      tryBody.indexOf("#protectedBootManager()"), // F4: the gated build
    "seeded before the manager is built",
  );
  const finBody = stripComments(body.slice(fin + 8, matchBrace(body, fin + 8)));
  assert.match(
    finBody,
    /^\{\s*this\.#ptIndex\.markReady\(\);\s*this\.#protectedFlushPreIndex\(\);\s*\}$/,
    "markReady is the first statement of the finally, under no condition",
  );
  assert.equal(count(SRC, ".markReady()"), 1, "markReady called exactly once");
});

// ---- S8 the rest of the binding notes ---------------------------------------------

test("S8: the manager is built only once status.device_id is known (and capable)", () => {
  const key = member(SRC, /\n {2}#protectedManagerKeyNow\(\)/);
  assert.match(key, /this\.protectedTextCapable\(\)/);
  assert.match(key, /device_id/);
  const ensure = stripComments(
    member(SRC, /\n {2}#protectedEnsureManager\(\): void /),
  );
  assert.match(
    ensure,
    /if \(!key \|\| !userId \|\| !deviceId\) return;[\s\S]*new ProtectedTextManager\(/,
  );
  assert.match(ensure, /owner: \{ protect, setSeats \}/);
  assert.match(
    ensure,
    /messages: \{ encryptAndSend, decryptRow, markerForError \}/,
  );
});

test("S8: port.sleep rejects on the manager's lifetime; dispose aborts it", () => {
  const port = member(SRC, /\n {2}#protectedPort\(/);
  assert.match(port, /if \(signal\.aborted \|\| life\.aborted\) \{\s*reject\(/);
  assert.match(port, /life\.addEventListener\("abort", onAbort/);
  const dispose = member(SRC, /\n {2}#protectedDispose\(\): void /);
  assert.match(dispose, /this\.#ptLife\?\.abort\(\);/);
  assert.match(dispose, /manager\.dispose\(\);/);
  // Dispose on the wipe (disable) and both ownership paths.
  assert.equal(count(SRC, 'await this.#invoke("e2ee_wipe");'), 1);
  assert.match(
    SRC,
    /await this\.#invoke\("e2ee_wipe"\);[\s\S]*?this\.#mlsBuffer\.clear\(\);\s*this\.#ptPreIndex\.clear\(\);\s*this\.#protectedDispose\(\);/,
    "disable (wipe) disposes the manager",
  );
  assert.match(
    member(SRC, /\n {2}#raiseStoreOwnedByAnotherAccount\(\): void /),
    /this\.#protectedDispose\(\);/,
  );
  assert.match(
    member(SRC, /\n {2}#noteDevicePresence\(/),
    /this\.#protectedDispose\(\);/,
  );
});

test("S8: onChannelProtected is deduped per manager; seeding is allSettled", () => {
  const fwd = member(
    SRC,
    /\n {2}#protectedForward\(channelId: string\): void /,
  );
  assert.match(fwd, /this\.#ptForwarded\.has\(channelId\)\) return;/);
  assert.match(
    member(SRC, /\n {2}onChannelProtected\(channelId: string\): void /),
    /this\.#protectedForward\(channelId\)/,
  );
});

test("S8 (W4d F#9, iOS G7): the text manager starts at each prepublish caller, not inside it", () => {
  // F#9: a shell whose call-plane media predicate is false still starts its
  // protected text plane, so the start cannot sit behind the prepublish's
  // platform gate; G7 needs that gate to stay the prepublish's first
  // statement, so the start lives at the callers.
  const pre = stripComments(
    member(SRC, /\n {2}async #prepublishMlsKeyPackages\(\)/),
  );
  assert.match(
    pre,
    /^\{\s*if \(!this\.mediaE2EEPlatformSupported\(\)\) return;/,
    "the platform gate is the prepublish's first statement",
  );
  assert.equal(count(pre, "#protectedEnsureManager"), 0, "no start inside");
  const calls = count(SRC, "this.#prepublishMlsKeyPackages()");
  assert.equal(calls, 2, "two prepublish callers (enable, re-enroll)");
  assert.equal(
    [
      ...SRC.matchAll(
        /\n {4}this\.#protectedEnsureManager\(\);\n {4}void this\.#prepublishMlsKeyPackages\(\);\n/g,
      ),
    ].length,
    calls,
    "each caller starts the manager on the line before the prepublish",
  );
});

test("S8: D12 gate, no Idempotency-Key, no draft-guard resolver", () => {
  // `!callsEnabled && !protectedWanted`, nested so the calls gate keeps the
  // statement iOS gate G7 pins (W4d L-IOSGATE).
  assert.match(
    stripComments(member(SRC, /\n {2}async #prepublishMlsKeyPackages\(\)/)),
    /if \(!this\.#protectedKeyPackagesWanted\(\)\) \{\s*if \(!this\.#callsEnabled\(\)\) return;\s*\}\s*try \{/,
  );
  const block = seamCode();
  assert.equal(count(block, "Idempotency-Key"), 0);
  assert.equal(count(SRC, "setProtectedChannelResolver"), 0);
  // The send body carries only content, reply ids and flags 0/1.
  const send = member(SRC, /\n {2}async handleProtectedSend\(/);
  assert.match(
    send,
    /if \(field === "content" \|\| field === "replies" \|\| field === "flags"\) \{\s*continue;/,
  );
  assert.match(send, /if \(flags !== 0 && flags !== 1\)/);
  // Rows map `?? null`, never undefined.
  const row = member(SRC, /\n {2}#protectedRow\(/);
  assert.match(row, /nonce: message\.nonce \?\? null/);
  assert.match(row, /encrypted: message\.encrypted \?\? null/);
});

// ---- S9 W4b audit fix round -----------------------------------------------------

test("S9 (M2): every handleProtectedSend rejection is ONE ProtectedSendError", () => {
  const send = stripComments(member(SRC, /\n {2}async handleProtectedSend\(/));
  // The whole body is one try whose catch wraps and rethrows.
  assert.match(send, /^\{\s*try \{/, "the body starts with try");
  assert.match(
    send,
    /\} catch \(error\) \{\s*throw toProtectedSendError\(error\);\s*\}\s*\}$/,
    "the catch wraps every failure and is the last statement",
  );
  assert.equal(count(send, "E2EESendError"), 0, "no developer-string error");
  assert.match(send, /throw new ProtectedFieldRefusedClient\(/, "D9b refusal");
  assert.match(send, /throw new ProtectedChannelUnavailable\(\)/);
  // Reply mention flags are validated, not silently mis-shaped.
  assert.match(
    send,
    /r\.mention !== undefined && typeof r\.mention !== "boolean"/,
  );
});

test("S9 (M2): ProtectedSendError carries the cause; wrapping is idempotent", () => {
  const failure = { source: "transport" };
  const e = new ProtectedSendError(failure);
  assert.ok(e instanceof Error);
  assert.equal(e.name, "ProtectedSendError");
  assert.equal(e.message, "ProtectedSendError", "no display copy in .message");
  assert.equal(e.failure, failure);
  assert.equal(toProtectedSendError(e), e, "never double-wrapped");
  const cause = new Error("x");
  const wrapped = toProtectedSendError(cause);
  assert.ok(wrapped instanceof ProtectedSendError);
  assert.equal(wrapped.failure, cause);
  assert.ok(isProtectedSendError(wrapped));
  assert.ok(!isProtectedSendError(cause));
  assert.ok(!isProtectedSendError({ name: "ProtectedSendError", failure }));
});

test("S9 (M4): setting the outbox accessor re-runs the orphan scan", () => {
  const set = member(SRC, /\n {2}setProtectedOutboxKeys\(/);
  assert.match(set, /this\.#ptOutboxKeys = accessor;/);
  assert.match(set, /manager\.rescanOrphans\(\);/);
});

test("S9 (d): deletes drop views; subscribed once, from #protectedOnReady", () => {
  const ready = member(
    SRC,
    /\n {2}async #protectedOnReady\(\): Promise<void> /,
  );
  assert.match(ready, /this\.#protectedSubscribeDeletes\(\);/);
  const sub = member(SRC, /\n {2}#protectedSubscribeDeletes\(\): void /);
  assert.match(
    sub,
    /if \(this\.#ptDeletesSubscribed\) return;\s*this\.#ptDeletesSubscribed = true;/,
  );
  assert.match(sub, /"messageDeleteId"/);
  assert.match(sub, /"messageDeleteBulk"/);
  assert.equal(
    count(SRC, 'this.#client.on("messageDeleteId"'),
    1,
    "one subscription",
  );
  const forget = member(SRC, /\n {2}#protectedForget\(/);
  assert.match(forget, /this\.protectedViews\.delete\(id\)/);
  assert.match(forget, /this\.#ptManager\?\.forget\(ids\)/);
});

test("S9 (L1): after seeding every indexed channel is forwarded (deduped)", () => {
  const ready = stripComments(
    member(SRC, /\n {2}async #protectedOnReady\(\): Promise<void> /),
  );
  assert.match(
    ready,
    // S1-final F4: the boot gate (builds only with protected work) in place
    // of the unconditional build.
    /this\.#protectedBootManager\(\);\s*for \(const channelId of this\.#ptIndexed\) \{\s*this\.#protectedForward\(channelId\);\s*\}/,
  );
});

test("S9 (M3 support): disposeProtected is idempotent and final", () => {
  const dispose = member(SRC, /\n {2}disposeProtected\(\): void /);
  assert.match(
    dispose,
    /this\.#ptSignedOut = true;\s*this\.#protectedDispose\(\);/,
  );
  const ensure = member(SRC, /\n {2}#protectedEnsureManager\(\): void /);
  assert.match(
    ensure,
    /if \(this\.#ptManager \|\| this\.#ptSignedOut\) return;/,
  );
  const inner = member(SRC, /\n {2}#protectedDispose\(\): void /);
  assert.match(inner, /this\.#ptLife\?\.abort\(\);/, "null-safe abort");
  assert.match(inner, /if \(manager\) \{/, "null-safe manager dispose");
});

test("S9 (F#5): E2EEBridge.dispose() calls disposeProtected() before any return", () => {
  const body = stripComments(
    member(SRC, /\n {2}async dispose\(\): Promise<void> /),
  );
  const call = body.indexOf("this.disposeProtected();");
  const firstReturn = body.search(/\breturn\b/);
  assert.ok(call >= 0, "dispose() stops the text manager");
  assert.equal(count(body, "this.disposeProtected();"), 1, "called once");
  assert.ok(
    firstReturn < 0 || call < firstReturn,
    "called ahead of dispose()'s first return (the iOS early return)",
  );
});

// ---- S10 W4c#2 hold + replay of early decrypt requests ----------------------

/** The full declaration (head + body) of the class member `head` names. */
function memberDecl(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  const body = member(src, head);
  const start = m.index + (m[0].length - m[0].trimStart().length);
  return src.slice(start, src.indexOf(body, m.index) + body.length);
}

const PENDING_DECL = /\n {2}readonly #ptPending = new Map<[\s\S]*?>\(\);/;
const PENDING_MAX_DECL = /\n {2}readonly #ptPendingMax = (\d+);/;

type Row = {
  id: string;
  channelId: string;
  authorId: string;
  nonce: string | null;
  encrypted: unknown;
};
type Call = ["live", string] | ["history", string, string[]];
type Harness = {
  setManager(m: unknown): void;
  setStructural(v: boolean): void;
  signOut(): void;
  pending(): [string, boolean][];
  replay(m: unknown): void;
  onProtectedMessage(message: unknown): void;
  decryptProtectedHistory(channel: unknown, messages: unknown[]): void;
};

/**
 * A class holding the seam's REAL hold members (`#ptPending`, its bound,
 * `#protectedHoldRequests`, `#protectedEnqueue`, `#protectedReplayPending`,
 * the two hooks, `#protectedRow`), lifted from the scanned source with
 * their types stripped, plus stubs for the rest of the bridge.
 */
function harness(warn: unknown[][] = []): Harness {
  const pending = PENDING_DECL.exec(SRC);
  const max = PENDING_MAX_DECL.exec(SRC);
  assert.ok(pending && max, "S10: #ptPending and #ptPendingMax declared");
  const members = [
    /\n {2}#protectedRow\(/,
    /\n {2}onProtectedMessage\(/,
    /\n {2}decryptProtectedHistory\(/,
    /\n {2}#protectedHoldRequests\(\): boolean /,
    /\n {2}#protectedEnqueue\(/,
    /\n {2}#protectedReplayPending\(/,
  ].map((head) => memberDecl(SRC, head));
  const ts = `class Harness {
  #ptManager = null;
  #ptSignedOut = false;
  #structural = true;
  ${pending[0].trim()}
  ${max[0].trim()}
  #protectedStructural() { return this.#structural; }
  setManager(m) { this.#ptManager = m; }
  setStructural(v) { this.#structural = v; }
  signOut() { this.#ptSignedOut = true; }
  pending() { return [...this.#ptPending.values()].map((e) => [e.row.id, e.live]); }
  replay(m) { this.#protectedReplayPending(m); }
  ${members.join("\n  ")}
}`;
  const Cls = new Function(
    "errorName",
    "console",
    `${stripTypeScriptTypes(ts)}\nreturn Harness;`,
  )(String, { warn: (...a: unknown[]) => warn.push(a), error: () => {} });
  return new Cls() as Harness;
}

function msg(id: string, channelId = "C1"): Row {
  return { id, channelId, authorId: "U", nonce: null, encrypted: "CT" };
}

function recorder(): { calls: Call[]; manager: unknown } {
  const calls: Call[] = [];
  return {
    calls,
    manager: {
      onMessage: (row: Row, live: boolean) => {
        assert.equal(live, true, "replayed through onMessage only when live");
        calls.push(["live", row.id]);
      },
      decryptHistory: (channelId: string, rows: Row[]) =>
        calls.push(["history", channelId, rows.map((r) => r.id)]),
    },
  };
}

test("S10: a request with no manager is held, not dropped; live wins a dedupe", () => {
  const h = harness();
  h.decryptProtectedHistory({ id: "C1" }, [msg("a"), msg("b"), msg("x", "C2")]);
  h.onProtectedMessage(msg("c"));
  h.onProtectedMessage(msg("b")); // live supersedes the held history row
  h.decryptProtectedHistory({ id: "C1" }, [msg("c"), msg("a")]); // dupes
  h.onProtectedMessage(msg("c")); // live dupe
  assert.deepEqual(h.pending(), [
    ["a", false],
    ["c", true],
    ["b", true],
  ]);
});

test("S10: the hold is bounded; the oldest go, logged by id only", () => {
  const warn: unknown[][] = [];
  const h = harness(warn);
  const max = Number(PENDING_MAX_DECL.exec(SRC)![1]);
  assert.ok(max >= 100 && max <= 5000, `bound is sane: ${max}`);
  const rows = Array.from({ length: max + 50 }, (_, i) => msg(`m${i}`));
  h.decryptProtectedHistory({ id: "C1" }, rows);
  const held = h.pending();
  assert.equal(held.length, max, "never more than the bound");
  assert.equal(held[0][0], "m50", "the oldest 50 were dropped");
  assert.equal(held[max - 1][0], `m${max + 49}`);
  assert.equal(warn.length, 1, "one log per enqueue");
  assert.match(String(warn[0][0]), /^\[protected\] /);
  const detail = JSON.stringify(warn[0].slice(1));
  assert.ok(detail.includes('"count":50'), "counts the drops");
  assert.ok(detail.includes('"m0"'), "names dropped ids");
  assert.ok(!detail.includes("CT"), "never logs a row body");
});

test("S10: replay hands every held request over in arrival order", () => {
  const h = harness();
  h.decryptProtectedHistory({ id: "C1" }, [msg("a"), msg("b")]);
  h.decryptProtectedHistory({ id: "C2" }, [msg("x", "C2")]);
  h.onProtectedMessage(msg("c"));
  h.decryptProtectedHistory({ id: "C1" }, [msg("d")]);
  const { calls, manager } = recorder();
  h.replay(manager); // not the current manager: nothing moves
  assert.deepEqual(calls, []);
  assert.equal(h.pending().length, 5, "kept for the current manager");
  h.setManager(manager);
  h.replay(manager);
  assert.deepEqual(calls, [
    ["history", "C1", ["a", "b"]],
    ["history", "C2", ["x"]],
    ["live", "c"],
    ["history", "C1", ["d"]],
  ]);
  assert.deepEqual(h.pending(), [], "the hold is empty after replay");
  // With a manager, requests go straight to it.
  h.onProtectedMessage(msg("e"));
  h.decryptProtectedHistory({ id: "C1" }, [msg("f")]);
  assert.deepEqual(calls.slice(4), [
    ["live", "e"],
    ["history", "C1", ["f"]],
  ]);
  assert.deepEqual(h.pending(), []);
});

test("S10: a non-capable shell holds nothing; neither does a signed-out bridge", () => {
  const h = harness();
  h.onProtectedMessage(msg("a"));
  h.setStructural(false); // web / iOS / popout, or a closed Electron / Android
  h.onProtectedMessage(msg("b"));
  h.decryptProtectedHistory({ id: "C1" }, [msg("c")]);
  assert.deepEqual(h.pending(), [], "nothing held, the old entry cleared");
  const s = harness();
  s.signOut();
  s.onProtectedMessage(msg("a"));
  s.decryptProtectedHistory({ id: "C1" }, [msg("b")]);
  assert.deepEqual(s.pending(), []);
});

test("S10: replay is wired to start() settling (both arms) for that manager", () => {
  const ensure = stripComments(
    member(SRC, /\n {2}#protectedEnsureManager\(\): void /),
  );
  assert.match(
    ensure,
    /this\.#ptManager = manager;[\s\S]*const started = manager;\s*started\.start\(\)\.then\(\s*\(\) => this\.#protectedReplayPending\(started\),\s*\(error: unknown\) => \{[^}]*this\.#protectedReplayPending\(started\);\s*\},\s*\);/,
    "replay after start() resolves, and after it rejects",
  );
  assert.equal(count(SRC, "#protectedReplayPending("), 3, "decl + two arms");
  const replay = stripComments(member(SRC, /\n {2}#protectedReplayPending\(/));
  assert.match(
    replay,
    /^\{\s*if \(this\.#ptManager !== manager\) return;\s*const held = \[\.\.\.this\.#ptPending\.values\(\)\];\s*this\.#ptPending\.clear\(\);/,
    "only the current manager drains the hold",
  );
});

test("S10: the hold is cleared on dispose (wipe, latches, sign-out) and on delete", () => {
  const dispose = member(SRC, /\n {2}#protectedDispose\(\): void /);
  assert.match(dispose, /this\.#ptPending\.clear\(\);/, "dispose clears it");
  // disposeProtected (sign-out) and the wipe / latch paths all reach it (S8).
  assert.match(
    member(SRC, /\n {2}disposeProtected\(\): void /),
    /this\.#protectedDispose\(\);/,
  );
  const forget = member(SRC, /\n {2}#protectedForget\(/);
  assert.match(forget, /this\.#ptPending\.delete\(id\);/, "deleted ids go");
  // Writers: one set (enqueue); clears: dispose, non-capable, replay.
  assert.equal(count(SRC, "#ptPending.set("), 1);
  assert.equal(count(SRC, "#ptPending.clear()"), 3);
  const hold = stripComments(
    member(SRC, /\n {2}#protectedHoldRequests\(\): boolean /),
  );
  assert.match(
    hold,
    /^\{\s*if \(!this\.#protectedStructural\(\) \|\| this\.#ptSignedOut\) \{\s*this\.#ptPending\.clear\(\);\s*return false;\s*\}\s*return this\.#ptManager === null;\s*\}$/,
  );
});

// ---- S11 W4d F#3 un-strip re-forward -----------------------------------------

const FORWARDED_DECL = /\n {2}readonly #ptForwarded = new Set<string>\(\);/;
const STRIPPED_DECL = /\n {2}readonly #ptStripped = new Set<string>\(\);/;

type Hand = ["protected", string] | ["stripped", string];
type StripHarness = {
  /** The SDK latch (`client.isProtectedFlagStripped`). */
  sdk: Set<string>;
  /** Channels `#protectedIndex` cannot index. */
  unindexable: Set<string>;
  /** `#protectedBootManager` calls (stubbed: it never builds here). */
  boots: number;
  /** `#protectedEnsureManager`'s hand-over (S11 pins its two clears). */
  build(m: unknown): void;
  /** `#protectedDispose`'s bookkeeping (S11 pins its two clears). */
  drop(): void;
  stripped(): string[];
  onProtectedFlagStripped(channelId: string): void;
  onChannelProtected(channelId: string): void;
};

/**
 * A class holding the seam's REAL `#ptForwarded` / `#ptStripped`,
 * `#protectedForward` and the two SDK hooks, lifted from the scanned source
 * with their types stripped. `#protectedIndex` is an async stub (indexes
 * every channel not in `unindexable`), so hook callbacks run a tick later,
 * in event order, as with the real per-channel index promise.
 */
function stripHarness(): StripHarness {
  const forwarded = FORWARDED_DECL.exec(SRC);
  const stripped = STRIPPED_DECL.exec(SRC);
  assert.ok(
    forwarded && stripped,
    "S11: #ptForwarded and #ptStripped declared",
  );
  const members = [
    /\n {2}#protectedForward\(channelId: string\): void /,
    /\n {2}onProtectedFlagStripped\(channelId: string\): void /,
    /\n {2}onChannelProtected\(channelId: string\): void /,
  ].map((head) => memberDecl(SRC, head));
  const ts = `class StripHarness {
  #ptManager = null;
  readonly #ptIndexed = new Set();
  sdk = new Set();
  unindexable = new Set();
  #client = { isProtectedFlagStripped: (id) => this.sdk.has(id) };
  boots = 0;
  // F4 (S12): the boot gate is its own spec; here it only counts.
  #protectedBootManager() { this.boots++; }
  ${forwarded[0].trim()}
  ${stripped[0].trim()}
  async #protectedIndex(channelId) {
    await null;
    if (this.unindexable.has(channelId)) return false;
    this.#ptIndexed.add(channelId);
    return true;
  }
  build(m) {
    this.#ptManager = m;
    this.#ptForwarded.clear();
    this.#ptStripped.clear();
    for (const channelId of this.#ptIndexed) this.#protectedForward(channelId);
  }
  drop() {
    this.#ptManager = null;
    this.#ptForwarded.clear();
    this.#ptStripped.clear();
  }
  stripped() { return [...this.#ptStripped]; }
  ${members.join("\n  ")}
}`;
  const Cls = new Function(
    `${stripTypeScriptTypes(ts)}\nreturn StripHarness;`,
  )();
  return new Cls() as StripHarness;
}

function handRecorder(): { hands: Hand[]; manager: unknown } {
  const hands: Hand[] = [];
  return {
    hands,
    manager: {
      channelProtected: (id: string) => hands.push(["protected", id]),
      flagStripped: (id: string) => hands.push(["stripped", id]),
    },
  };
}

/** Let every pending hook callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** SDK `applyProtectedFlag`: set or clear the latch, then fire the hook. */
async function strip(h: StripHarness, id: string): Promise<void> {
  h.sdk.add(id);
  h.onProtectedFlagStripped(id);
  await settle();
}

async function reprotect(h: StripHarness, id: string): Promise<void> {
  h.sdk.delete(id);
  h.onChannelProtected(id);
  await settle();
}

test("S11 (F#3): strip then re-protect hands the channel over again", async () => {
  const h = stripHarness();
  const { hands, manager } = handRecorder();
  h.build(manager);
  await reprotect(h, "C1"); // first sight
  assert.deepEqual(hands, [["protected", "C1"]]);
  await reprotect(h, "C1"); // a later Ready: deduped
  assert.deepEqual(hands, [["protected", "C1"]], "idempotent while unstripped");
  await strip(h, "C1");
  assert.deepEqual(hands.slice(1), [["stripped", "C1"]]);
  assert.deepEqual(h.stripped(), ["C1"]);
  await reprotect(h, "C1"); // un-strip: forwarded again
  assert.deepEqual(hands.slice(2), [["protected", "C1"]]);
  assert.deepEqual(h.stripped(), [], "the tracked strip is cleared");
  await reprotect(h, "C1"); // and deduped again afterwards
  assert.equal(hands.length, 3, "one re-forward per un-strip");
  await strip(h, "C1"); // a second cycle works the same way
  await reprotect(h, "C1");
  assert.deepEqual(hands.slice(3), [
    ["stripped", "C1"],
    ["protected", "C1"],
  ]);
});

test("S11 (F#3): a strip handed over with the first forward is undone too", async () => {
  const h = stripHarness();
  // Seen before any manager: nothing is handed over, no strip tracked.
  h.sdk.add("C1");
  h.onProtectedFlagStripped("C1");
  h.onChannelProtected("C2");
  await settle();
  assert.deepEqual(h.stripped(), [], "no manager, nothing tracked");
  const { hands, manager } = handRecorder();
  h.build(manager); // #protectedEnsureManager hands over every indexed id
  assert.deepEqual(hands, [
    ["protected", "C1"],
    ["stripped", "C1"],
    ["protected", "C2"],
  ]);
  assert.deepEqual(h.stripped(), ["C1"]);
  await reprotect(h, "C1");
  assert.deepEqual(hands.slice(3), [["protected", "C1"]]);
  await reprotect(h, "C2");
  assert.equal(hands.length, 4, "C2 was never stripped: still deduped");
});

test("S11 (F#3): event order wins; a newer strip keeps the latch", async () => {
  const h = stripHarness();
  const { hands, manager } = handRecorder();
  h.build(manager);
  await reprotect(h, "C1");
  // Strip, re-protect, strip again, all before any callback ran.
  h.sdk.add("C1");
  h.onProtectedFlagStripped("C1");
  h.sdk.delete("C1");
  h.onChannelProtected("C1");
  h.sdk.add("C1");
  h.onProtectedFlagStripped("C1");
  await settle();
  assert.deepEqual(hands.slice(1), [
    ["stripped", "C1"],
    ["stripped", "C1"],
  ]);
  assert.deepEqual(h.stripped(), ["C1"], "still latched, as the SDK is");
  await reprotect(h, "C1");
  assert.deepEqual(hands.slice(3), [["protected", "C1"]]);
});

test("S11 (F#3): a rebuilt manager starts clear; unindexed ids never move", async () => {
  const h = stripHarness();
  const first = handRecorder();
  h.build(first.manager);
  await reprotect(h, "C1");
  await strip(h, "C1");
  h.drop(); // #protectedDispose
  assert.deepEqual(h.stripped(), []);
  h.sdk.delete("C1"); // un-stripped while no manager exists
  h.onChannelProtected("C1");
  await settle();
  const second = handRecorder();
  h.build(second.manager);
  assert.deepEqual(second.hands, [["protected", "C1"]], "fresh, unlatched");
  await reprotect(h, "C1");
  assert.equal(second.hands.length, 1, "nothing to undo on the new manager");
  assert.equal(first.hands.length, 2, "the old manager got nothing more");
  h.unindexable.add("C9");
  await strip(h, "C9");
  await reprotect(h, "C9");
  assert.equal(second.hands.length, 1, "an unindexed channel is never handed");
});

test("S11 (F#3): the strip set is cleared with #ptForwarded, written only here", () => {
  const pair = /this\.#ptForwarded\.clear\(\);\s*this\.#ptStripped\.clear\(\);/;
  assert.match(
    member(SRC, /\n {2}#protectedEnsureManager\(\): void /),
    pair,
    "a new manager starts with no tracked strip",
  );
  assert.match(
    member(SRC, /\n {2}#protectedDispose\(\): void /),
    pair,
    "dispose drops the tracked strips",
  );
  assert.equal(count(SRC, "#ptForwarded.clear()"), 2);
  assert.equal(count(SRC, "#ptStripped.clear()"), 2);
  // Added where a strip is handed over (forward, strip hook); dropped only
  // by the re-protect in onChannelProtected.
  assert.equal(count(SRC, "#ptStripped.add("), 2);
  assert.equal(count(SRC, "#ptStripped.delete("), 1);
  assert.equal(
    count(SRC, ".flagStripped("),
    2,
    "every strip hand-over tracked",
  );
});

// ---- S12 S1-final F4: no protected work on a dark boot -------------------------

type BootHarness = {
  indexed: Set<string>;
  key: string | null;
  fetches: number;
  builds: number;
  requests: number;
  unread: boolean;
  /** The `GET /` advert; `fail` makes the request reject (no response). */
  answer: { enabled: boolean; fail?: boolean };
  signOut(): void;
  boot(): void;
  flag(): { enabled: boolean };
};

/**
 * The seam's REAL `#protectedBootManager`, `#protectedProbeFlag`,
 * `protectedFlag` and the probe state, lifted with types stripped, over the
 * REAL `fetchProtectedChannelsFlag`. `client.api.get("/")` and
 * `#protectedEnsureManager` (the pin write + device listing; it builds only
 * when capable, i.e. `key` set) are counting stubs.
 */
function bootHarness(): BootHarness {
  const decls = [
    /\n {2}#ptFlagProbed = false;/,
    /\n {2}#ptFlagProbing = false;/,
    /\n {2}#ptFlagProbeFailures = 0;/,
    /\n {2}readonly #ptFlagProbeMaxFailures = 5;/,
  ].map((re) => {
    const m = re.exec(SRC);
    assert.ok(m, `S12: declared ${re}`);
    return m[0].trim();
  });
  const members = [
    /\n {2}#protectedBootManager\(\): void /,
    /\n {2}async #protectedProbeFlag\(\): Promise<void> /,
    /\n {2}protectedFlag\(\): ProtectedChannelsFlag /,
  ].map((head) => memberDecl(SRC, head));
  const ts = `class BootHarness {
  #ptManager = null;
  #ptSignedOut = false;
  #client = { api: { get: (path) => this.get(path) } };
  #ptFlagState = new Map();
  indexed = new Set();
  get #ptIndexed() { return this.indexed; }
  key = "U:D";
  fetches = 0;
  builds = 0;
  requests = 0;
  unread = false;
  answer = { enabled: false };
  ${decls.join("\n  ")}
  get #storeOwnerUnread() { return this.unread; }
  #requestStoreOwnerRead() { this.requests++; }
  async get(path) {
    if (path !== "/") throw new Error("unexpected " + path);
    this.fetches++;
    await null;
    if (this.answer.fail) throw new Error("offline");
    return {
      features: {
        protected_channels: {
          enabled: this.answer.enabled,
          default_device_cap: 0,
        },
      },
    };
  }
  #protectedManagerKeyNow() { return this.key; }
  #protectedEnsureManager() {
    if (this.#ptManager || this.#ptSignedOut || !this.key) return;
    this.builds++;
    this.#ptManager = {};
  }
  // S7 audit fix 3: the probe routes its answer to the S7 flag (C3's scan).
  #protectedFlagEvent() {}
  signOut() { this.#ptSignedOut = true; }
  boot() { this.#protectedBootManager(); }
  flag() { return this.protectedFlag(); }
  ${members.join("\n  ")}
}`;
  const Cls = new Function(
    "fetchProtectedChannelsFlag",
    `${stripTypeScriptTypes(ts)}\nreturn BootHarness;`,
  )(fetchProtectedChannelsFlag);
  return new Cls() as BootHarness;
}

test("S12 (F4): a dark boot with nothing protected builds nothing; one GET / per bridge", async () => {
  const h = bootHarness();
  h.boot();
  await settle();
  assert.equal(h.fetches, 1, "the flag is probed once");
  assert.equal(h.builds, 0, "no manager: no pin write, no device GET");
  assert.equal(h.flag().enabled, false);
  h.boot(); // a reconnect
  h.boot();
  await settle();
  assert.equal(h.fetches, 1, "not re-probed after a response");
  assert.equal(h.builds, 0);
});

test("S12 (F4): an indexed channel or an enabled flag still builds the manager", async () => {
  const pinned = bootHarness();
  pinned.indexed.add("C1");
  pinned.boot();
  await settle();
  assert.equal(pinned.builds, 1, "a protected/pinned channel builds it");
  assert.equal(pinned.fetches, 0, "the manager fetches the flag itself");

  const lit = bootHarness();
  lit.answer = { enabled: true };
  lit.boot();
  assert.equal(lit.builds, 0, "not before the flag answers");
  await settle();
  assert.equal(lit.fetches, 1);
  assert.equal(lit.builds, 1, "the flag fetch says enabled: built");
  lit.boot();
  assert.equal(lit.builds, 1, "idempotent");

  // Dark first, a channel protected later: the hook's boot builds it.
  const later = bootHarness();
  later.boot();
  await settle();
  assert.equal(later.builds, 0);
  later.indexed.add("C2");
  later.boot();
  assert.equal(later.builds, 1, "a later protected channel starts it");
});

test("S12 (F4): a window that is not capable still reads the advert; it builds nothing", async () => {
  const h = bootHarness();
  h.key = null; // web / Electron / E2EE not on yet / owner unread
  h.answer = { enabled: true };
  h.boot();
  await settle();
  assert.equal(h.fetches, 1, "GET / runs regardless of capability");
  assert.equal(h.flag().enabled, true, "the settings tab can see the advert");
  assert.equal(h.builds, 0, "but no manager without capability");
  h.key = "U:D"; // enable() / owner read succeeded
  h.boot();
  assert.equal(h.builds, 1, "built once capable");
  assert.equal(h.fetches, 1, "the advert is not fetched again");

  const unread = bootHarness();
  unread.unread = true;
  unread.boot();
  await settle();
  assert.equal(unread.requests, 1, "an unread owner asks for the read");

  const s = bootHarness();
  s.signOut();
  s.indexed.add("C1");
  s.boot();
  s.indexed.clear();
  s.boot();
  await settle();
  assert.equal(s.fetches + s.builds, 0, "a signed-out bridge does nothing");
});

test("S12 (F4): a probe with no response is retried on the next boot, bounded", async () => {
  const h = bootHarness();
  h.answer = { enabled: true, fail: true };
  h.boot();
  h.boot(); // deduped while in flight
  await settle();
  assert.equal(h.fetches, 1);
  assert.equal(h.flag().enabled, false, "no response reads as off");
  h.boot(); // the next connect
  await settle();
  assert.equal(h.fetches, 2, "re-probed after a failure");
  h.answer = { enabled: true };
  h.boot();
  await settle();
  assert.equal(h.fetches, 3);
  assert.equal(h.flag().enabled, true);
  assert.equal(h.builds, 1, "the late answer still builds it");

  const down = bootHarness();
  down.answer = { enabled: false, fail: true };
  for (let i = 0; i < 9; i++) {
    down.boot();
    await settle();
  }
  assert.equal(down.fetches, 5, "at most five failed probes per bridge");
});

test("S12 (F4): the boot paths go through the gate; the hooks boot with no manager", async () => {
  // onReady (S9 pins its shape), the owner re-check and the two SDK hooks.
  // + the S7 platform flag flip (audit fix 3, #protectedPlatformApply).
  assert.equal(count(SRC, "this.#protectedBootManager();"), 5);
  const ready = stripComments(
    member(SRC, /\n {2}async #protectedOnReady\(\): Promise<void> /),
  );
  assert.equal(count(ready, "#protectedEnsureManager"), 0, "no ungated build");
  const h = stripHarness();
  h.onChannelProtected("C1");
  h.sdk.add("C2");
  h.onProtectedFlagStripped("C2");
  await settle();
  assert.equal(h.boots, 2, "each hook boots while no manager exists");
  const { hands, manager } = handRecorder();
  h.build(manager);
  await reprotect(h, "C3");
  assert.equal(h.boots, 2, "no boot once a manager exists");
  assert.deepEqual(hands, [
    ["protected", "C1"],
    ["protected", "C2"],
    ["stripped", "C2"],
    ["protected", "C3"],
  ]);
});

// ---- S13 S1-final A-1: the store-owner latch fails closed for the text plane -----

type OwnerHarness = {
  owner: () => Promise<string | null>;
  dispatch: () => Promise<unknown>;
  dispatches: number;
  reads: number;
  boots: number;
  disposes: number;
  structural: boolean;
  status: Map<string, { enabled: boolean; device_id: string | null }>;
  timers: { fn: () => void; delay: number; live: boolean }[];
  check(retry?: boolean): Promise<void>;
  request(): void;
  capable(): boolean;
  text(cmd: string, args: unknown): Promise<unknown>;
  latched(): boolean;
  signOut(): void;
};

/**
 * The REAL `#checkStoreOwner`, its state (`#storeOwnerUnread` starts SET),
 * `#scheduleStoreOwnerRetry`, `#requestStoreOwnerRead`,
 * `#raiseStoreOwnedByAnotherAccount`, `protectedTextCapable`, `#textInvoke`
 * and `disposeProtected`, lifted with types stripped. `e2ee_store_owner`,
 * the text dispatch, the timers and the manager teardown are stubs.
 */
function ownerHarness(): OwnerHarness {
  const decls = [
    // Either value lifts: the behaviour cases below pin that it starts set.
    /\n {2}#storeOwnerUnread = (?:true|false);/,
    /\n {2}#storeOwnerRetryTimer: ReturnType<typeof setTimeout> \| null = null;/,
    /\n {2}#storeOwnerRetries = 0;/,
    /\n {2}#storeOwnerReading: Promise<void> \| null = null;/,
  ].map((re) => {
    const m = re.exec(SRC);
    assert.ok(m, `S13: declared ${re}`);
    return m[0].trim();
  });
  const members = [
    /\n {2}async #checkStoreOwner\(/,
    /\n {2}#scheduleStoreOwnerRetry\(\): void /,
    /\n {2}#requestStoreOwnerRead\(\): void /,
    /\n {2}#raiseStoreOwnedByAnotherAccount\(\): void /,
    /\n {2}protectedTextCapable\(\): boolean /,
    /\n {2}#textInvoke</,
    /\n {2}disposeProtected\(\): void /,
  ].map((head) => memberDecl(SRC, head));
  const ts = `class OwnerHarness {
  ${decls.join("\n  ")}
  #client = { user: { id: "B" } };
  status = new Map([["state", { enabled: true, device_id: "D" }]]);
  storeOwnedByAnotherAccount = new Map();
  deviceOwnedElsewhere = new Map();
  #mlsBuffer = { clear() {} };
  #ptPreIndex = { clear() {} };
  #kept = { discardAll: async () => {} };
  #ptSignedOut = false;
  structural = true;
  owner = async () => "B";
  dispatch = async () => "ok";
  dispatches = 0;
  reads = 0;
  boots = 0;
  disposes = 0;
  timers = [];
  #protectedStructural() { return this.structural; }
  // S7 (merge re-anchor): the Tauri main window, never on hold; the A8
  // owner record and C4's real \`storeOwnerAllows\` (W4's latch on Tauri).
  #ptStoreOwner = { state: "unknown" };
  #protectedNoteStoreOwner(check) { this.#ptStoreOwner = check; }
  #protectedPlatformState() { return { structural: this.structural, hold: false }; }
  #protectedTransportKind() { return "tauri"; }
  #protectedBootManager() { this.boots++; }
  #protectedDispose() { this.disposes++; }
  #invoke(command) {
    if (command !== "e2ee_store_owner") throw new Error("unexpected " + command);
    this.reads++;
    return this.owner();
  }
  #protectedTextDispatch() { this.dispatches++; return this.dispatch(); }
  check(retry) { return this.#checkStoreOwner(retry); }
  request() { this.#requestStoreOwnerRead(); }
  capable() { return this.protectedTextCapable(); }
  text(cmd, args) { return this.#textInvoke(cmd, args); }
  latched() { return this.storeOwnedByAnotherAccount.has("state"); }
  signOut() { this.disposeProtected(); }
  ${members.join("\n  ")}
}`;
  const self: OwnerHarness[] = [];
  const setTimeoutFake = (fn: () => void, delay: number) => {
    self[0].timers.push({ fn, delay, live: true });
    return self[0].timers.length - 1;
  };
  const clearTimeoutFake = (id: number) => {
    if (self[0].timers[id]) self[0].timers[id].live = false;
  };
  const Cls = new Function(
    "TEXT_COMMANDS",
    "setTimeout",
    "clearTimeout",
    "console",
    "storeOwnerAllows",
    `${stripTypeScriptTypes(ts)}\nreturn OwnerHarness;`,
  )(
    TEXT_COMMANDS,
    setTimeoutFake,
    clearTimeoutFake,
    {
      error: () => {},
      warn: () => {},
    },
    storeOwnerAllows,
  );
  self.push(new Cls() as OwnerHarness);
  return self[0];
}

/** Fire the one live timer (asserted), then let its re-check settle. */
async function fire(h: OwnerHarness): Promise<number> {
  const live = h.timers.filter((t) => t.live);
  assert.equal(live.length, 1, "exactly one retry pending");
  live[0].live = false;
  live[0].fn();
  await settle();
  return live[0].delay;
}

const BUSY = { type: "busy" };
const NOT_OURS = {
  type: "mls_store_owned_by_another_account",
  owner_user_id: "A",
  requested_user_id: "B",
};

test("S13 (A-1): an enabled status before any owner read is NOT capable", async () => {
  const h = ownerHarness();
  // Status enabled (the `#ensureBootStatus` race), no owner read yet.
  assert.equal(h.capable(), false, "no successful read yet");
  await assert.rejects(h.text("e2ee_text_pin_own_devices", {}), {
    reason: "not_capable",
  });
  await assert.rejects(h.text("e2ee_text_decrypt", {}), {
    reason: "not_capable",
  });
  assert.equal(h.dispatches, 0, "no text command reaches native");
  let release: (owner: string | null) => void = () => {};
  h.owner = () =>
    new Promise<string | null>((resolve) => {
      release = resolve;
    });
  h.request();
  h.request(); // deduped while in flight
  assert.equal(h.reads, 1);
  assert.equal(h.capable(), false, "still not capable while the read runs");
  release("B");
  await settle();
  assert.equal(h.capable(), true, "capable once the read succeeds");
  assert.equal(h.boots, 1, "the read runs the boot gate");
  h.request();
  assert.equal(h.reads, 1, "no read once one succeeded");
  // An empty store (no MLS row) is a successful read too.
  const fresh = ownerHarness();
  fresh.owner = async () => null;
  await fresh.check();
  assert.equal(fresh.capable(), true);
  assert.equal(fresh.boots, 1);
  // Not asked where the text plane never runs, or before E2EE is on.
  const web = ownerHarness();
  web.structural = false;
  web.request();
  const off = ownerHarness();
  off.status.set("state", { enabled: false, device_id: null });
  off.request();
  assert.equal(web.reads + off.reads, 0);
});

test("S13 (A-1): an owner check that throws leaves the text plane NOT capable", async () => {
  const h = ownerHarness();
  h.owner = async () => {
    throw BUSY;
  };
  await h.check();
  assert.equal(h.capable(), false, "UNKNOWN owner is not an all-clear");
  assert.equal(h.latched(), false, "calls/DMs: no latch, as before");
  await assert.rejects(h.text("e2ee_text_decrypt", {}), {
    reason: "not_capable",
  });
  assert.equal(h.dispatches, 0, "no text command reaches native");
  h.owner = async () => "B";
  assert.equal(await fire(h), 2000);
  assert.equal(h.capable(), true, "capable again after a successful retry");
  assert.equal(h.boots, 1, "the retry starts the text plane");
  assert.equal(h.timers.filter((t) => t.live).length, 0, "no more retries");
  await h.text("e2ee_text_decrypt", {});
  assert.equal(h.dispatches, 1);
});

test("S13 (A-1): retries back off and are bounded; a connect check re-arms them", async () => {
  const h = ownerHarness();
  h.owner = async () => {
    throw BUSY;
  };
  await h.check();
  const delays: number[] = [];
  while (h.timers.some((t) => t.live)) delays.push(await fire(h));
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 64000]);
  assert.equal(h.capable(), false);
  assert.equal(h.boots, 0);
  await h.check(); // the next connect
  assert.equal(h.timers.filter((t) => t.live).length, 1, "re-armed");
  h.signOut();
  assert.equal(h.timers.filter((t) => t.live).length, 0, "sign-out cancels it");

  const other = ownerHarness();
  other.structural = false; // web / Electron / Android / iOS / popout
  other.owner = async () => {
    throw new Error("no accessor");
  };
  await other.check();
  assert.equal(
    other.timers.length,
    0,
    "no retry where the text plane never runs",
  );
});

test("S13 (A-1): a retry that reads another owner raises the latch", async () => {
  const h = ownerHarness();
  h.owner = async () => {
    throw BUSY;
  };
  await h.check();
  h.owner = async () => "A";
  await fire(h);
  assert.equal(h.latched(), true);
  assert.equal(h.capable(), false);
  assert.equal(h.disposes, 1, "the manager is torn down");
});

test("S13 (A-1): a text command refused as another account's store escalates", async () => {
  const h = ownerHarness();
  await h.check();
  assert.equal(h.capable(), true);
  h.dispatch = async () => {
    throw BUSY;
  };
  await assert.rejects(h.text("e2ee_text_state", {}), BUSY);
  assert.equal(h.latched(), false, "another error does not raise");
  h.dispatch = async () => {
    throw NOT_OURS;
  };
  await assert.rejects(h.text("e2ee_text_decrypt", {}), NOT_OURS);
  assert.equal(h.latched(), true, "latch raised");
  assert.equal(h.disposes, 1, "manager disposed");
  assert.equal(h.capable(), false, "so no manager is rebuilt");
  await assert.rejects(h.text("e2ee_text_decrypt", {}), {
    reason: "not_capable",
  });
  assert.equal(h.dispatches, 2, "nothing more reaches native");
});

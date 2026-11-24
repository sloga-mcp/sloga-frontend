// Source-scan spec for Protected channel rows in `Message.tsx` (W4 lane C6,
// plan D11 / D22 / D25, design 9.3). `Message.tsx` cannot load under Node
// (Solid JSX, stoat.js, the client context), so this reads it as text, and
// runs its two pure helpers from a type-stripped copy. Since S4 (W4 lane U2)
// the body decision lives in `messageProtectedView.ts`, which loads here, so
// P1 runs the real function (its own spec is `messageProtectedView.test.ts`):
//
//  P1  the body: no view (or `pending`) is the `pending` marker, a `marker`
//      view its kind, an unknown status fails closed; never server text;
//      P1b: with no protected text plane (bridge `protectedTextCapable()`
//      absent or not `true`) waiting is `not_available`, a marker wins;
//  P2  body order: the editor is gated off Protected rows, then the marker,
//      then the decrypted view, all BEFORE any branch that reads server
//      `content`; the decrypted branch renders `view().text` only and is
//      never translated, and carries the S2 files note (`ProtectedFilesNote`);
//  P3  attachments, encrypted attachments, embeds and components render
//      only inside `<Show when={!protectedRow()}>`;
//  P4  replies: server `replyIds` are dropped on Protected rows; the
//      preview reads the target's view, never server fields; the ids are
//      capped, deduplicated and ULID-checked (CLIENT-CLAIMED);
//  P5  hover picker: emoji only, GIF/sticker reply hidden via
//      `protectedActionsBlocked`;
//  P6  other server-set text (system, interaction, masquerade, crosspost,
//      published, thread, interactions) is gated off Protected rows;
//  P7  the non-protected body branches are byte-identical to 7a1e03ca;
//  P8  no `styled(ImportedComponent, ...)` (blank page at boot);
//  P9  (PB-5) a row is Protected when it carries `encrypted` OR its
//      channel is protected/pinned (the predicate is evaluated);
//  P10 (PB-2) the reply preview never fetches: an uncached target is
//      "not loaded", no request links the reply to its target.
//
// S4 W4-3 lane U2 (design 9.5): server-set fields are gated on `guardedRow()`
// (every Protected row except a `plain` one), the hover picker and the editor
// stay keyed on the channel (`protectedRow()`), and:
//
//  U2a `guardedRow` is evaluated: only an `ordinary` body opens the gate;
//  U2b the checking line takes every guarded row the marker and the
//      decrypted branch did not, before any branch that reads server text,
//      and renders fixed copy only;
//  U2c the notes under a decrypted body come from `protectedRowNotes`, and
//      `Message.tsx` reads none of the view's note flags itself;
//  U2d the placeholder marker is gone.
//
// Run: node --test --conditions=browser \
//   components/app/interface/channels/text/protectedMessage.scan.test.ts
// `PROTECTED_MESSAGE_TSX=<path>` scans another copy (named controls).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import { protectedRowBody } from "./messageProtectedView.ts";

const FILE =
  process.env.PROTECTED_MESSAGE_TSX ||
  new URL("./Message.tsx", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

/**
 * sha256 of the non-protected body branches (from the dice-roll Match up to
 * the body `</Switch>`) at the W4b checkpoint 7a1e03ca.
 */
const LEGACY_BODY_SHA256 =
  "009972f1233a12e9eab4ba53214e58620eb71e9cc2d395531fc928ec97672452";

// ---- Source helpers ---------------------------------------------------------

function between(src: string, start: string, end: string, from = 0): string {
  const a = src.indexOf(start, from);
  assert.ok(a >= 0, `missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end ${end} after ${start}`);
  return src.slice(a, b + end.length);
}

/** Source of a top-level `function name(` up to its closing `\n}\n`. */
function functionSource(name: string): string {
  return between(SRC, `function ${name}(`, "\n}\n");
}

/** The `Message` component body. */
const MESSAGE_FN = between(SRC, "export function Message(", "\n}\n");

/** The body `<Switch>` (the one holding the editor). */
const BODY_SWITCH = (() => {
  const editor = MESSAGE_FN.indexOf("<EditMessage");
  assert.ok(editor >= 0, "missing <EditMessage");
  const open = MESSAGE_FN.lastIndexOf("<Switch>", editor);
  assert.ok(open >= 0, "missing body <Switch>");
  const close = MESSAGE_FN.indexOf("\n        </Switch>", editor);
  assert.ok(close >= 0, "missing body </Switch>");
  return MESSAGE_FN.slice(open, close);
})();

/** Load the pure helpers from a type-stripped copy. */
function loadHelpers(): {
  protectedTextPlane: (bridge: unknown) => boolean;
  protectedReplyTargets: (replies: unknown, ownId: string) => string[];
  MAX_PROTECTED_REPLIES: number;
} {
  const consts = ["MAX_PROTECTED_REPLIES", "RE_MESSAGE_ID"].map((name) =>
    between(SRC, `const ${name} =`, ";\n"),
  );
  const ts = [
    "(() => {",
    ...consts,
    functionSource("protectedTextPlane"),
    functionSource("protectedReplyTargets"),
    "return { protectedTextPlane, protectedReplyTargets, MAX_PROTECTED_REPLIES };",
    "})()",
  ].join("\n");
  return new Function(`return ${stripTypeScriptTypes(ts)};`)();
}

const H = loadHelpers();

/**
 * The marker a Protected row shows in place of its body, as `Message.tsx`
 * reads it off `protectedRowBody`; the row always has server text to leak.
 */
function markerKind(view: unknown, capable: boolean): unknown {
  const body = protectedRowBody(view as never, capable, {
    content: "server text",
  });
  assert.notEqual(body.kind, "ordinary");
  return body.kind === "marker" ? body.marker : undefined;
}

const ULID = (n: number) =>
  `${"01HZ".padEnd(24, "Z")}${String(n).padStart(2, "0")}`;

// ---- P1 ---------------------------------------------------------------------

test("P1: a missing or pending view is the pending marker, never the body", () => {
  assert.equal(markerKind(null, true), "pending");
  assert.equal(markerKind(undefined, true), "pending");
  assert.equal(markerKind({ status: "pending" }, true), "pending");
  assert.equal(
    markerKind({ status: "marker", kind: "replay" }, true),
    "replay",
  );
  assert.equal(
    markerKind({ status: "marker", kind: "unencrypted_row" }, true),
    "unencrypted_row",
  );
  assert.equal(
    markerKind(
      {
        status: "ok",
        text: "hi",
        replies: [],
        senderVerified: true,
        tsSkew: false,
        cid: "c",
      },
      true,
    ),
    undefined,
  );
  // An unknown status at runtime fails closed (red), never the body.
  assert.equal(markerKind({ status: "weird" }, true), "error");
});

test("P1b: without the protected text plane, waiting is not_available", () => {
  assert.equal(markerKind(null, false), "not_available");
  assert.equal(markerKind(undefined, false), "not_available");
  assert.equal(markerKind({ status: "pending" }, false), "not_available");
  // A real marker view still wins; an ok view still renders.
  assert.equal(
    markerKind({ status: "marker", kind: "replay" }, false),
    "replay",
  );
  assert.equal(
    markerKind({ status: "ok", text: "", replies: [] }, false),
    undefined,
  );
  assert.equal(markerKind({ status: "weird" }, false), "error");

  // Capable only when the bridge method returns a literal `true`.
  assert.equal(H.protectedTextPlane(undefined), false);
  assert.equal(H.protectedTextPlane(null), false);
  assert.equal(H.protectedTextPlane({}), false);
  assert.equal(H.protectedTextPlane({ protectedTextCapable: true }), false);
  assert.equal(
    H.protectedTextPlane({ protectedTextCapable: () => false }),
    false,
  );
  assert.equal(H.protectedTextPlane({ protectedTextCapable: () => 1 }), false);
  assert.equal(
    H.protectedTextPlane({ protectedTextCapable: () => true }),
    true,
  );
});

// ---- P2 ---------------------------------------------------------------------

test("P2: body order puts the protected branches before any server text", () => {
  const matches = [
    ...BODY_SWITCH.matchAll(/<Match\s+when=\{([\s\S]*?)\}>/g),
  ].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.equal(matches[0], "props.editing && !protectedRow()");
  assert.equal(matches[1], "protectedMarker()");
  assert.equal(matches[2], "protectedOk()");
  // S4 (U2): then the checking line, still before any server text.
  assert.equal(matches[3], "guardedRow()");
  assert.match(matches[4], /^isDiceRollMessage\(/);

  const ok = between(BODY_SWITCH, "<Match when={protectedOk()}>", "</Match>");
  assert.match(ok, /<Markdown content=\{view\(\)\.text\} \/>/);
  assert.doesNotMatch(ok, /props\.message\.(content|embeds|attachments)/);
  assert.doesNotMatch(ok, /MessageTranslation/);
  assert.match(ok, /kind="ts_skew"/);
  // S4 (U2): the sender note is one of the bridge's row notes now (U2c), no
  // longer a `sender_not_verified` marker decided here.
  assert.doesNotMatch(ok, /kind="sender_not_verified"/);
  // S2 (OR-20): the files note, last and unwrapped (its count gate lives
  // inside ProtectedFilesNote, never a second gate here).
  assert.match(
    ok,
    /<\/For>\s*<ProtectedFilesNote view=\{view\(\)\} \/>\s*<\/>/,
  );
  assert.equal(MESSAGE_FN.split("<ProtectedFilesNote").length - 1, 1);

  const marker = between(
    BODY_SWITCH,
    "<Match when={protectedMarker()}>",
    "</Match>",
  );
  assert.match(marker, /<ProtectedMessageMarker kind=\{kind\(\)\} \/>/);

  // `protectedMarker` / `protectedOk` are keyed on the Protected predicate.
  assert.match(
    MESSAGE_FN,
    /const protectedRow = \(\) =>\s+props\.message\.encrypted !== undefined \|\|\s+client\(\)\.isProtectedChannel\(props\.message\.channelId\);/,
  );
  // S4 (U2): one decision, made in `messageProtectedView.ts` from the view,
  // the text plane and the row; marker and decrypted view are read off it.
  assert.match(
    MESSAGE_FN,
    /const protectedBody = \(\) =>\s+protectedRow\(\)\s+\? protectedRowBody\(\s+protectedView\(\),\s+protectedTextPlane\(client\(\)\.e2ee\),\s+props\.message,\s+\)\s+: undefined;/,
  );
  assert.match(
    MESSAGE_FN,
    /const protectedMarker = \(\) => \{\s+const body = protectedBody\(\);\s+return body\?\.kind === "marker" \? body\.marker : undefined;\s+\};/,
  );
  assert.match(
    MESSAGE_FN,
    /const protectedOk = \(\) => \{\s+const body = protectedBody\(\);\s+return body\?\.kind === "ok" \? body\.view : undefined;\s+\};/,
  );
  assert.equal(code(MESSAGE_FN).split("protectedRowBody(").length - 1, 1);
  assert.match(
    MESSAGE_FN,
    /useProtectedMessage\(\(\) =>\s+protectedRow\(\) \? props\.message\.id : undefined,?\s*\)/,
  );
});

// ---- P3 ---------------------------------------------------------------------

test("P3: attachments, embeds and components are never on a Protected row", () => {
  const guard = "<Show when={!guardedRow()}>";
  const start = MESSAGE_FN.indexOf(guard);
  assert.ok(start >= 0, "missing the !guardedRow() guard");
  // The guard's own </Show>: the first one at its indentation.
  const indent = MESSAGE_FN.slice(
    MESSAGE_FN.lastIndexOf("\n", start) + 1,
    start,
  );
  const end = MESSAGE_FN.indexOf(`\n${indent}</Show>`, start);
  assert.ok(end > start, "unterminated guard");
  const guarded = MESSAGE_FN.slice(start, end);

  for (const tag of [
    "<Attachment ",
    "<EncryptedAttachment",
    "<Embed ",
    "<MessageComponents ",
  ]) {
    const all = MESSAGE_FN.split(tag).length - 1;
    assert.equal(all, 1, `${tag} appears ${all} times in Message`);
    assert.ok(guarded.includes(tag), `${tag} outside the guard`);
  }
  assert.ok(guarded.includes("props.message.attachments"));
  assert.ok(guarded.includes("e2ee?.attachmentsFor(props.message.id)"));
  assert.ok(guarded.includes("props.message.embeds"));
});

// ---- P4 ---------------------------------------------------------------------

test("P4: reply previews come from the decrypted view only", () => {
  assert.match(
    MESSAGE_FN,
    /<For each=\{guardedRow\(\) \? undefined : props\.message\.replyIds\}>/,
  );
  assert.match(MESSAGE_FN, /<For each=\{protectedReplyIds\(\)\}>/);
  assert.match(
    MESSAGE_FN,
    /protectedReplyTargets\(view\.replies, props\.message\.id\)/,
  );

  const preview = functionSource("ProtectedReplyPreview");
  assert.match(preview, /useProtectedMessage\(/);
  assert.match(
    preview,
    /protectedViewClass\(view\(\), protectedTextPlane\(client\(\)\.e2ee\)\)/,
  );
  assert.match(preview, /message\?\.channelId === props\.channelId/);
  assert.doesNotMatch(
    preview,
    /\.(content|attachments|embeds|forwarded|masquerade|systemMessage|interactions)\b/,
  );
  // The target's own `username` folds in its masquerade / webhook name.
  assert.doesNotMatch(preview, /message\(\)\??\.username\b/);
  assert.doesNotMatch(preview, /<MessageReply\s+message=/);

  const ids = Array.from({ length: 8 }, (_, i) => ULID(i));
  assert.deepEqual(H.protectedReplyTargets(ids, ULID(99)), ids.slice(0, 5));
  assert.equal(H.MAX_PROTECTED_REPLIES, 5);
  assert.deepEqual(
    H.protectedReplyTargets(
      [ULID(1), ULID(1), ULID(2), "../../x", 7, null, ULID(3).toLowerCase()],
      ULID(2),
    ),
    [ULID(1)],
  );
  assert.deepEqual(H.protectedReplyTargets("nope", ULID(1)), []);
  assert.deepEqual(H.protectedReplyTargets(undefined, ULID(1)), []);
});

// ---- P5 ---------------------------------------------------------------------

test("P5: hover picker keeps reacting, hides the GIF and sticker reply", () => {
  const picker = between(
    MESSAGE_FN,
    "<CompositionMediaPicker",
    "</CompositionMediaPicker>",
  );
  assert.match(picker, /emojiOnly=\{protectedRow\(\)\}/);
  const onMessage = between(picker, "onMessage={", "sendMessage(");
  assert.match(onMessage, /protectedActionsBlocked\(protectedRow\(\), "gif"\)/);
  assert.match(
    onMessage,
    /protectedActionsBlocked\(protectedRow\(\), "stickers"\)/,
  );
  assert.match(onMessage, /return;/);
  const gif = between(
    picker,
    "onClickGif: (event, ref) => {",
    "trigProps.onClickGif(",
  );
  assert.match(
    gif,
    /protectedActionsBlocked\(protectedRow\(\), "gif"\)\) return;/,
  );
  const sticker = between(
    picker,
    "onClickSticker: (event, ref) => {",
    "trigProps.onClickSticker(",
  );
  assert.match(
    sticker,
    /protectedActionsBlocked\(protectedRow\(\), "stickers"\)/,
  );
  assert.doesNotMatch(picker, /setReactPicker\(trigProps\)/);
});

// ---- P6 ---------------------------------------------------------------------

test("P6: other server-set text is gated off Protected rows", () => {
  for (const re of [
    /<Show when=\{!guardedRow\(\) && props\.message\.systemMessage\}>/,
    /<Match when=\{!guardedRow\(\) && props\.message\.systemMessage\}>/,
    /\(!guardedRow\(\) && !!props\.message\.systemMessage\) \|\|/,
    /<Show\s+when=\{\s+!guardedRow\(\) &&\s+props\.message\.isInteractionResponse/,
    /<Show when=\{!guardedRow\(\) && props\.message\.isCrosspost\}>/,
    /<Show when=\{!guardedRow\(\) && props\.message\.isCrossposted\}>/,
    /<Show when=\{!guardedRow\(\) && props\.message\.thread\}>/,
    /masquerade=\{!guardedRow\(\) && !!props\.message\.masquerade\}/,
    /\(guardedRow\(\)\s+\? undefined\s+: props\.message\.masquerade\?\.name\)/,
    /interactions=\{\s*guardedRow\(\) \? undefined : props\.message\.interactions\s*\}/,
  ]) {
    assert.match(MESSAGE_FN, re);
  }
});

// ---- P7 ---------------------------------------------------------------------

test("P7: the non-protected body branches are unchanged from 7a1e03ca", () => {
  const start = BODY_SWITCH.indexOf(
    "<Match\n            when={isDiceRollMessage(",
  );
  assert.ok(start >= 0, "missing the dice-roll Match");
  const legacy = BODY_SWITCH.slice(start);
  const sha = createHash("sha256").update(legacy).digest("hex");
  assert.equal(sha, LEGACY_BODY_SHA256);
});

// ---- P8 ---------------------------------------------------------------------

test("P8: no styled() over an imported component", () => {
  assert.doesNotMatch(SRC, /\bstyled\(\s*[A-Za-z_$][\w$]*\s*[,)]/);
  for (const m of SRC.matchAll(/\bstyled\(\s*([^\s,)]+)/g)) {
    assert.match(m[1], /^"[a-z0-9]+"$/, `styled(${m[1]})`);
  }
});

// ---- P9 (PB-5) --------------------------------------------------------------

/** Code without comments, so prose never counts. */
function code(s: string): string {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("P9: a row carrying `encrypted` is Protected even off a protected channel", () => {
  const src = between(MESSAGE_FN, "const protectedRow = () =>", ";\n");
  const body = src.slice("const protectedRow = () =>".length, -2);
  const evalRow = new Function(
    "props",
    "client",
    `return (${stripTypeScriptTypes(body)});`,
  ) as (props: unknown, client: () => unknown) => boolean;

  const run = (encrypted: unknown, channelProtected: boolean) =>
    evalRow({ message: { encrypted, channelId: "C1" } }, () => ({
      isProtectedChannel: (id: string) => id === "C1" && channelProtected,
    }));

  assert.equal(run({ v: 1 }, false), true, "encrypted, channel not flagged");
  assert.equal(run(undefined, true), true, "channel flagged or pinned");
  assert.equal(run({ v: 1 }, true), true);
  assert.equal(run(undefined, false), false, "plain row stays plain");
  // `null` never comes out of hydration (`?? undefined`); fail closed.
  assert.equal(run(null, false), true);
});

// ---- P10 (PB-2) -------------------------------------------------------------

test("P10: the reply preview never fetches an uncached target", () => {
  const preview = code(functionSource("ProtectedReplyPreview"));
  // Resolves only from rows already loaded on this device.
  assert.match(preview, /client\(\)\.messages\.get\(props\.id\)/);
  for (const re of [
    /fetch/i,
    /\.api\b/,
    /onMount\(/,
    /createEffect\(/,
    /createResource\(/,
    /props\.channel\b/,
    /channels\.get\(/,
  ]) {
    assert.doesNotMatch(preview, re, `preview must not ${re}`);
  }
  // Uncached (or foreign) targets fall back to MessageReply's "not loaded".
  assert.match(preview, /<Switch fallback=\{<MessageReply \/>\}>/);
  // The only fetch left in Message.tsx is the legacy reply path, which a
  // Protected row never iterates (P4).
  const fetches = code(SRC).match(/fetchMessage\(/g) ?? [];
  assert.equal(fetches.length, 1, "exactly one fetchMessage( (legacy path)");
  const legacy = between(
    MESSAGE_FN,
    "<For each={guardedRow() ? undefined : props.message.replyIds}>",
    "</For>",
  );
  assert.match(legacy, /fetchMessage\(/);
});

// ---- U2 (S4 W4-3, design 9.5) -----------------------------------------------

test("U2a: only an ordinary body opens the server-text gate", () => {
  const src = between(MESSAGE_FN, "const guardedRow = () =>", ";\n");
  const body = src.slice("const guardedRow = () =>".length, -2);
  const evalGuard = new Function(
    "protectedRow",
    "protectedBody",
    `return (${stripTypeScriptTypes(body)});`,
  ) as (row: () => boolean, body: () => unknown) => boolean;
  const run = (row: boolean, kind: string | undefined) =>
    evalGuard(
      () => row,
      () => (kind === undefined ? undefined : { kind }),
    );

  assert.equal(run(true, "ordinary"), false, "a plain row is not guarded");
  for (const kind of ["checking", "marker", "ok", "plain", "weird", ""]) {
    assert.equal(run(true, kind), true, `a ${kind} body stays guarded`);
  }
  // A Protected row with no decision at all stays guarded.
  assert.equal(run(true, undefined), true);
  // Rows outside Protected channels were never guarded.
  assert.equal(run(false, undefined), false);
  assert.equal(run(false, "checking"), false);

  // Every server-set field hangs off this gate and nothing else reopens it:
  // the Protected predicate is left on the picker, the editor and the three
  // accessors only.
  const uses = code(MESSAGE_FN).match(/protectedRow\(\)/g) ?? [];
  assert.equal(uses.length, 9, "protectedRow() call sites");
  assert.doesNotMatch(code(MESSAGE_FN), /!protectedRow\(\) &&/);
});

test("U2b: the checking line takes every other guarded row, with fixed copy only", () => {
  const branch = between(
    BODY_SWITCH,
    "<Match when={guardedRow()}>",
    "</Match>",
  );
  assert.equal(
    code(branch).replace(/\s+/g, " "),
    "<Match when={guardedRow()}> <ProtectedCheckingLine /> </Match>",
  );
  // It sits before the first branch that reads server content.
  assert.ok(
    BODY_SWITCH.indexOf("<Match when={guardedRow()}>") <
      BODY_SWITCH.indexOf("props.message.content"),
  );

  const line = code(functionSource("ProtectedCheckingLine"));
  assert.match(line, /\{rowStateCopy\("checking"\)\}/);
  assert.doesNotMatch(line, /props|message|view|content|Markdown/);

  // The reply preview shows the same line for a target still being checked,
  // and reads nothing of a plain one (P4 keeps server fields out of it).
  const preview = code(functionSource("ProtectedReplyPreview"));
  assert.match(
    preview,
    /<Match when=\{body\(\)\.kind === "checking"\}>\s*<ReplyText>\s*<ProtectedCheckingLine \/>\s*<\/ReplyText>\s*<\/Match>/,
  );
  assert.match(preview, /if \(b\.kind !== "ok"\) return "";/);
});

test("U2c: the notes under a decrypted body are the bridge's, never recomputed here", () => {
  const ok = between(BODY_SWITCH, "<Match when={protectedOk()}>", "</Match>");
  assert.match(
    ok,
    /<For each=\{protectedRowNotes\(view\(\)\)\}>\s*\{\(note\) => <ProtectedRowNote kind=\{note\} \/>\}\s*<\/For>/,
  );
  assert.equal(code(SRC).split("protectedRowNotes(").length - 1, 1);
  // None of the flags the notes are built from is read in this file.
  assert.doesNotMatch(
    code(SRC),
    /senderVerified|timingUnverified|belowBoundary|historySender|okViewNotes|rowNotes\(/,
  );

  const note = code(functionSource("ProtectedRowNote"));
  assert.match(note, /<span>\{rowNoteCopy\(props\.kind\)\}<\/span>/);
  assert.match(note, /data-protected-note=\{props\.kind\}/);
  assert.doesNotMatch(note, /message|view|content/);
});

test("U2d: the plain and checking placeholder is gone", () => {
  assert.doesNotMatch(SRC, /S4-W4-0 placeholder/);
  assert.doesNotMatch(code(SRC), /function protectedMarkerKind\(/);
});

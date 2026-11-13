// Source-scan spec for `ProtectedMessageMarker.tsx` (S2 W4-3 lane U1,
// addendum OR-19 / OR-20, design 9.2). The component imports Solid, Panda
// and the UI kit, so Node cannot load it: this cuts its pure helpers out of
// the source, strips the types with Node's own stripper and runs them, and
// scans the JSX for what it renders.
//
//  M1  `unsupported_version` is a gray marker with the `key_off` glyph and
//      `markerCopy` copy, never the red box;
//  M2  every other kind keeps its tone; an unknown kind is red;
//  M3  the files note shows only when the ok view's `filesUnsupported` is a
//      number above 0;
//  M4  the files note is an info note with `messageCopy.filesUnsupported`
//      copy, rendered only through that gate;
//  M5  only copy is rendered: never ids, server text or file fields;
//  M6  no `styled(ImportedComponent, ...)` (blank page at boot).
//
// Run: node --conditions=browser --test \
//   components/app/interface/channels/text/protectedMessageMarker.scan.test.ts
// `PROTECTED_MESSAGE_MARKER_TSX=<path>` scans another copy (named controls).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const FILE =
  process.env.PROTECTED_MESSAGE_MARKER_TSX ||
  new URL("./ProtectedMessageMarker.tsx", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

// ---- Source helpers ---------------------------------------------------------

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end ${end} after ${start}`);
  return src.slice(a, b + end.length);
}

/** Source of a top-level `function name(` up to its closing `\n}\n`. */
function functionSource(name: string): string {
  return between(SRC, `function ${name}(`, "\n}\n");
}

/** Code without comments, so prose never counts. */
function code(s: string): string {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

/** Copy stubs: each returns a tag naming the copy function it stands for. */
const COPY = {
  markerCopy: (kind: string) => `markerCopy:${kind}`,
  messageCopy: {
    pending: () => "messageCopy.pending",
    tsSkew: () => "messageCopy.tsSkew",
    senderNotVerified: () => "messageCopy.senderNotVerified",
    filesUnsupported: () => "messageCopy.filesUnsupported",
  },
  shieldLabel: (state: string) => `shieldLabel:${state}`,
};

type Helpers = {
  markerTone: (kind: string) => string;
  markerText: (kind: string) => string;
  markerGlyph: (kind: string, tone: string) => string;
  filesNoteShown: (view: unknown) => boolean;
};

/** Load the pure helpers from a type-stripped copy, with the copy stubs. */
function loadHelpers(): Helpers {
  const ts = [
    "(() => {",
    between(SRC, "const TONE_GLYPH", "};\n"),
    functionSource("markerTone"),
    functionSource("markerText"),
    functionSource("markerGlyph"),
    functionSource("filesNoteShown"),
    "return { markerTone, markerText, markerGlyph, filesNoteShown };",
    "})()",
  ].join("\n");
  return new Function(
    "markerCopy",
    "messageCopy",
    "shieldLabel",
    `return ${stripTypeScriptTypes(ts)};`,
  )(COPY.markerCopy, COPY.messageCopy, COPY.shieldLabel);
}

const H = loadHelpers();

/** What `ProtectedMessageMarker` shows for a kind: tone, glyph, copy. */
function rendered(kind: string) {
  const tone = H.markerTone(kind);
  return { tone, glyph: H.markerGlyph(kind, tone), text: H.markerText(kind) };
}

const RED = [
  "decrypt_failed",
  "unverified_sender",
  "removed_sender",
  "replay",
  "malformed",
  "unencrypted_row",
  "error",
];

// ---- M1 ---------------------------------------------------------------------

test("U1: unsupported_version is a gray marker with the key_off glyph, never the red box", () => {
  assert.deepEqual(rendered("unsupported_version"), {
    tone: "gray",
    glyph: "key_off",
    text: "markerCopy:unsupported_version",
  });
  // Same look as the other expected gray markers.
  assert.deepEqual(
    { ...rendered("unsupported_version"), text: "" },
    { ...rendered("unknown_key"), text: "" },
  );
});

// ---- M2 ---------------------------------------------------------------------

test("U1: every other marker kind keeps its tone; an unknown kind is red", () => {
  for (const kind of RED) {
    assert.deepEqual(
      rendered(kind),
      { tone: "red", glyph: "gpp_bad", text: `markerCopy:${kind}` },
      kind,
    );
  }
  for (const kind of ["sent_before_join", "unknown_key"]) {
    assert.deepEqual(
      rendered(kind),
      { tone: "gray", glyph: "key_off", text: `markerCopy:${kind}` },
      kind,
    );
  }
  assert.deepEqual(rendered("not_available"), {
    tone: "gray",
    glyph: "remove_moderator",
    text: "shieldLabel:not_available",
  });
  assert.deepEqual(rendered("pending"), {
    tone: "pending",
    glyph: "hourglass_top",
    text: "messageCopy.pending",
  });
  assert.equal(H.markerTone("ts_skew"), "info");
  assert.equal(H.markerTone("sender_not_verified"), "info");
  // Fail closed: a kind this build does not know is loud.
  assert.equal(H.markerTone("some_future_kind"), "red");
});

// ---- M3 ---------------------------------------------------------------------

test("U1: the files note shows only when filesUnsupported is above 0", () => {
  assert.equal(H.filesNoteShown({ filesUnsupported: 0 }), false, "0");
  assert.equal(H.filesNoteShown({ filesUnsupported: 1 }), true, "1");
  assert.equal(H.filesNoteShown({ filesUnsupported: 2 }), true, "2");
  assert.equal(H.filesNoteShown({ filesUnsupported: 40 }), true, "40");
  // Not a count: no note (L2x only ever builds a safe integer >= 0).
  for (const bad of [-1, Number.NaN, undefined, null, "2", true]) {
    assert.equal(
      H.filesNoteShown({ filesUnsupported: bad }),
      false,
      String(bad),
    );
  }
  // A real ok view (v1 rows carry 0).
  const ok = {
    status: "ok",
    text: "hi",
    replies: [],
    senderVerified: true,
    tsSkew: false,
    cid: "c",
    filesUnsupported: 0,
  };
  assert.equal(H.filesNoteShown(ok), false);
  assert.equal(H.filesNoteShown({ ...ok, filesUnsupported: 3 }), true);
});

// ---- M4 ---------------------------------------------------------------------

test("U1: the files note is an info note with messageCopy.filesUnsupported copy, rendered behind the gate", () => {
  assert.deepEqual(rendered("files_unsupported"), {
    tone: "info",
    glyph: "info",
    text: "messageCopy.filesUnsupported",
  });

  const note = code(functionSource("ProtectedFilesNote"));
  assert.match(
    note,
    /^function ProtectedFilesNote\(props: \{ view: ProtectedOkView \}\)/,
  );
  // Exactly one Show, gated on filesNoteShown, holding the files marker.
  const shows = [...note.matchAll(/<Show\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(shows, ["<Show when={filesNoteShown(props.view)}>"]);
  const body = between(
    note,
    "<Show when={filesNoteShown(props.view)}>",
    "</Show>",
  );
  assert.match(body, /<ProtectedMessageMarker kind="files_unsupported" \/>/);
  assert.equal(
    code(SRC).split('kind="files_unsupported"').length - 1,
    1,
    "the files marker is rendered from ProtectedFilesNote only",
  );
  assert.match(SRC, /\nexport function ProtectedFilesNote\(/);

  // The ok arm's own type, not a hand-written shape.
  assert.match(
    SRC,
    /type ProtectedOkView = Extract<ProtectedMessageView, \{ status: "ok" \}>;/,
  );
});

// ---- M5 ---------------------------------------------------------------------

test("U1: only copy is rendered, never ids, server text or file fields", () => {
  // Every kind's text is one of the C0 copy functions.
  for (const kind of [
    ...RED,
    "sent_before_join",
    "unknown_key",
    "unsupported_version",
    "not_available",
    "pending",
    "ts_skew",
    "sender_not_verified",
    "files_unsupported",
  ]) {
    assert.match(
      H.markerText(kind),
      /^(markerCopy:[a-z_]+|messageCopy\.[A-Za-z]+|shieldLabel:not_available)$/,
      kind,
    );
  }

  const all = code(SRC);
  // No view or message field is read anywhere but the count.
  assert.doesNotMatch(
    all,
    /\.(text|cid|replies|files|name|names|id|ids|content|senderVerified|status)\b/,
  );
  const reads = [...all.matchAll(/\bprops\.([A-Za-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)].sort(), ["kind", "view"]);
  // The view only goes to the gate.
  assert.equal(all.split("props.view").length - 1, 1, "props.view read once");
  assert.match(all, /<Show when=\{filesNoteShown\(props\.view\)\}>/);
  assert.equal(
    all.split(".filesUnsupported").length - 1,
    2,
    "the count is read only in filesNoteShown (+ the copy function's name)",
  );
  assert.match(functionSource("filesNoteShown"), /view\.filesUnsupported/);

  // The marker renders the glyph and the copy, nothing else.
  const marker = code(functionSource("ProtectedMessageMarker"));
  const exprs = [...marker.matchAll(/>\s*\{([^}]*)\}\s*</g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(exprs, ["markerGlyph(props.kind, tone())", "text()"]);
});

// ---- M6 ---------------------------------------------------------------------

test("U1: no styled() over an imported component", () => {
  assert.doesNotMatch(SRC, /\bstyled\(\s*[A-Za-z_$][\w$]*\s*[,)]/);
  for (const m of SRC.matchAll(/\bstyled\(\s*([^\s,)]+)/g)) {
    assert.match(m[1], /^"[a-z0-9]+"$/, `styled(${m[1]})`);
  }
});

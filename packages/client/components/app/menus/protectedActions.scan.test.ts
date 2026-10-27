// Source-scan spec for the message actions on Protected channels (W4 lanes
// C8 + C9, plan D2 / D11, product choice 1): `MessageContextMenu.tsx` and
// `MessageToolbar.tsx` cannot load under Node (Solid JSX, stoat.js, the
// client context), so this reads them as text and runs the "Copy text"
// helper from a type-stripped copy:
//
//  A1  the trust predicate is channel-keyed (`client().isProtectedChannel`),
//      never `isEncryptedMessage`, and `hidden()` is A2's
//      `protectedActionsBlocked(protectedRow(), action)`;
//  A2  edit, forward, publish, create thread, polls, report and the server
//      file actions are gated by `hidden(<action>)` as the FIRST condition;
//  A3  "Copy text" copies the decrypted `view.text` of an ok view only;
//      with no ok view it is hidden and copies nothing; server `content` is
//      read only on non-protected rows (and by `canForward` after its gate);
//  A4  reply, react, pin, delete, mark unread, copy link and copy id carry
//      no protected gate (their blocks are byte-identical to main 7fde1662);
//  A5  toolbar: edit gated by `protectedActionsBlocked(protectedRow(),
//      "edit")`; reply, react and delete unchanged; no GIF/sticker button;
//  A6  with the protected additions removed, both files are byte-identical
//      to origin/main 7fde1662 (non-protected behaviour unchanged);
//  A7  A2's action lists keep/hide what these menus rely on;
//  A8  no `styled(ImportedComponent, ...)` (blank page at boot).
//
// Run: node --test --conditions=browser \
//   components/app/menus/protectedActions.scan.test.ts
// `PROTECTED_MENU_TSX=<path>` / `PROTECTED_TOOLBAR_TSX=<path>` scan other
// copies (named controls).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import {
  PROTECTED_HIDDEN_ACTIONS,
  PROTECTED_KEPT_ACTIONS,
  protectedActionsBlocked,
} from "../../client/protectedShield.ts";

const MENU = readFileSync(
  process.env.PROTECTED_MENU_TSX ||
    new URL("./MessageContextMenu.tsx", import.meta.url),
  "utf8",
);
const TOOLBAR = readFileSync(
  process.env.PROTECTED_TOOLBAR_TSX ||
    new URL(
      "../../ui/components/features/messaging/elements/MessageToolbar.tsx",
      import.meta.url,
    ),
  "utf8",
);

/**
 * sha256 of the two files on origin/main 7fde1662 (v0.70.0), merged into
 * this branch. The menu is unchanged since the W4b checkpoint 7a1e03ca;
 * main's toolbar adds only a `_modern` style block to `Base` (was 7d3c377a).
 */
const MENU_BASE_SHA256 =
  "2cc93b651f818f7de53fdd8edccf6124a26ca92f3c7fd8b6ca59859fc9905946";
const TOOLBAR_BASE_SHA256 =
  "1c7f892829c3135122ef391af6606f919d57d79bce125d38a95330812abd68b0";

// ---- Source helpers ---------------------------------------------------------

function between(src: string, start: string, end: string, from = 0): string {
  const a = src.indexOf(start, from);
  assert.ok(a >= 0, `missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end ${end} after ${start}`);
  return src.slice(a, b + end.length);
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** The `<Show ...>` opening tag (its `when`) enclosing `anchor`. */
function showWhen(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `missing: ${anchor}`);
  assert.equal(count(src, anchor), 1, `ambiguous: ${anchor}`);
  const open = src.lastIndexOf("<Show", at);
  assert.ok(open >= 0, `no <Show> before ${anchor}`);
  const tagEnd = src.indexOf("\n        >", open);
  const inline = src.indexOf(">\n", open);
  const end = tagEnd >= 0 && tagEnd < at ? tagEnd : inline;
  return src.slice(open, end);
}

/** The whole `<Show>...</Show>` block enclosing `anchor`. */
function showBlock(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `missing: ${anchor}`);
  const open = src.lastIndexOf("<Show", at);
  const close = src.indexOf("</Show>", at);
  assert.ok(open >= 0 && close >= 0, `no <Show> around ${anchor}`);
  return src.slice(open, close + "</Show>".length);
}

/** The first condition of a `when={ a && b }` / `if ( a || b )` list. */
function firstCondition(when: string): string {
  const m = /(?:when=\{\s*|if \(\s*|=>\s*)([^\n]+)/.exec(when);
  assert.ok(m, `no condition in ${when}`);
  return m![1].trim();
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const HELPERS = between(
  MENU,
  "  /**\n   * Whether this message is in a Protected channel",
  "\n  };\n",
);
const MENU_PROTECTED_ROW = between(MENU, "const protectedRow = () =>", ";\n");
const MENU_HIDDEN = between(MENU, "const hidden = (", ";\n");
const COPYABLE = between(MENU, "const copyableText = ", "\n  };\n");
const COPY_TEXT_FN = between(MENU, "function copyText() {", "\n  }\n");
const CAN_FORWARD = between(MENU, "const canForward = () =>", ";\n");
const CAN_PUBLISH = between(MENU, "const canPublish = () => {", "\n  };\n");

const TOOLBAR_PROTECTED_ROW = between(
  TOOLBAR,
  "const protectedRow = () =>",
  ";\n",
);

// ---- A1 ---------------------------------------------------------------------

test("A1: the predicate is channel-keyed, never isEncryptedMessage", () => {
  for (const def of [MENU_PROTECTED_ROW, TOOLBAR_PROTECTED_ROW]) {
    assert.match(def, /client\(\)\.isProtectedChannel\(/);
    assert.match(def, /\.channelId\)/);
    assert.doesNotMatch(def, /isEncrypted|serverActionsBlocked|e2ee/);
  }
  assert.match(
    MENU_HIDDEN,
    /protectedActionsBlocked\(protectedRow\(\), action\)/,
  );
  assert.match(
    MENU,
    /import \{\s*type ProtectedAction,\s*protectedActionsBlocked,\s*\} from "@revolt\/client\/protectedShield";/,
  );
  assert.match(
    TOOLBAR,
    /import \{ protectedActionsBlocked \} from "@revolt\/client\/protectedShield";/,
  );
  // The DM/group gates are untouched: no protected term leaks into them.
  for (const gate of [
    between(MENU, "const isEncrypted = () =>", ";\n"),
    between(MENU, "const actionsBlocked = () =>", ";\n"),
    between(TOOLBAR, "const encrypted = () =>", ";\n"),
    between(TOOLBAR, "const contentActionsBlocked = () =>", ";\n"),
  ]) {
    assert.doesNotMatch(gate, /protected|hidden\(/i);
  }
});

// ---- A2 ---------------------------------------------------------------------

test("A2: every hidden action is gated by hidden(<action>) first", () => {
  const gated: Array<[string, string]> = [
    ["<Trans>Edit message</Trans>", '!hidden("edit") &&'],
    ["<Trans>Create thread</Trans>", '!hidden("create_thread") &&'],
    ["<Trans>End poll now</Trans>", '!hidden("poll") &&'],
    ["<Trans>Report message</Trans>", '!hidden("report") &&'],
  ];
  for (const [anchor, gate] of gated) {
    assert.equal(firstCondition(showWhen(MENU, anchor)), gate, anchor);
  }
  assert.equal(firstCondition(CAN_FORWARD), '!hidden("forward") &&');
  assert.equal(
    firstCondition(CAN_PUBLISH.slice(CAN_PUBLISH.indexOf("if ("))),
    'hidden("publish") ||',
  );
  assert.match(
    showWhen(MENU, "<Trans>Open file</Trans>"),
    /<Show when=\{props\.file && !hidden\("attachments"\)\}/,
  );
  // Forward / Publish render only through their predicates.
  assert.match(
    showWhen(MENU, "<Trans>Forward</Trans>"),
    /when=\{canForward\(\)\}/,
  );
  assert.match(
    showWhen(MENU, "<Trans>Publish</Trans>"),
    /when=\{canPublish\(\)\}/,
  );
  // Choice 1: report hidden; the modal is opened from one place only.
  assert.equal(count(MENU, 'type: "report_content"'), 1);
  assert.equal(count(MENU, "onClick={report}"), 1);
});

// ---- A3 ---------------------------------------------------------------------

function loadCopyable(
  protectedRow: boolean,
  view: unknown,
  content: string,
): string | null {
  const ts = [
    "((protectedRow, protectedView, props) => {",
    COPYABLE.trim(),
    "return copyableText;",
    "})",
  ].join("\n");
  const make = new Function(`return ${stripTypeScriptTypes(ts)};`)();
  return make(
    () => protectedRow,
    () => view,
    { message: { content, id: "01M", channelId: "01C" } },
  )();
}

const OK = {
  status: "ok",
  text: "decrypted",
  replies: [],
  senderVerified: true,
  tsSkew: false,
  cid: "c",
};

test("A3: Copy text copies the decrypted view.text only", () => {
  assert.equal(loadCopyable(true, OK, "SERVER"), "decrypted");
  for (const view of [
    null,
    undefined,
    { status: "pending" },
    { status: "marker", kind: "replay" },
    { status: "bogus", text: "x" },
  ]) {
    assert.equal(loadCopyable(true, view, "SERVER"), null);
  }
  assert.equal(loadCopyable(false, OK, "plain"), "plain");
  assert.equal(loadCopyable(false, null, ""), "");

  assert.match(
    showWhen(MENU, "<Trans>Copy text</Trans>"),
    /<Show when=\{copyableText\(\) !== null\}/,
  );
  assert.match(COPY_TEXT_FN, /const text = copyableText\(\);/);
  assert.match(COPY_TEXT_FN, /if \(text === null\) return;/);
  assert.match(COPY_TEXT_FN, /navigator\.clipboard\.writeText\(text\);/);
  assert.doesNotMatch(COPY_TEXT_FN, /content/);

  // Server content is read in exactly two places: the non-protected branch
  // of copyableText, and canForward behind its hidden("forward") gate.
  const reads = MENU.match(/props\.message!?\.content\b/g) ?? [];
  assert.equal(reads.length, 2, "props.message.content reads");
  assert.match(
    COPYABLE,
    /if \(!protectedRow\(\)\) return props\.message!\.content;/,
  );
  assert.ok(
    CAN_FORWARD.indexOf('!hidden("forward")') < CAN_FORWARD.indexOf(".content"),
  );
  // The view is only asked for on a protected row.
  assert.match(
    HELPERS,
    /useProtectedMessage\(\(\) =>\s*protectedRow\(\) \? props\.message!\.id : undefined,?\s*\)/,
  );
});

// ---- A4 ---------------------------------------------------------------------

test("A4: kept actions carry no protected gate", () => {
  for (const anchor of [
    "<Trans>Reply</Trans>",
    "<Trans>React</Trans>",
    "<Trans>Unpin message</Trans>",
    "<Trans>Delete message</Trans>",
    "<Trans>Mark as unread</Trans>",
    "<Trans>Copy message ID</Trans>",
    "<Trans>Remove all reactions</Trans>",
    "<UnicodeEmoji emoji={emoji} />",
  ]) {
    assert.doesNotMatch(
      showBlock(MENU, anchor),
      /hidden\(|protectedRow|protectedView|isProtected/,
      anchor,
    );
  }
  // Copy message link sits outside any protected Show.
  const link = MENU.indexOf("<Trans>Copy message link</Trans>");
  const last = MENU.lastIndexOf("</Show>", link);
  const lastOpen = MENU.lastIndexOf("<Show", link);
  assert.ok(lastOpen < last, "Copy message link is not wrapped");
});

// ---- A5 ---------------------------------------------------------------------

/** The toolbar `<Show>` source up to the `<icon ` it wraps. */
function toolbarShow(icon: string): string {
  const at = TOOLBAR.indexOf(`<${icon} `);
  assert.ok(at >= 0, `missing <${icon}`);
  const open = TOOLBAR.lastIndexOf("<Show", at);
  assert.ok(open >= 0, `no <Show> before <${icon}`);
  return TOOLBAR.slice(open, at);
}

test("A5: toolbar hides edit only; no GIF/sticker button", () => {
  const edit = toolbarShow("MdEdit");
  assert.match(edit, /author\?\.self/);
  assert.equal(
    firstCondition(edit),
    '!protectedActionsBlocked(protectedRow(), "edit") &&',
  );
  assert.equal(count(TOOLBAR, "protectedActionsBlocked(protectedRow()"), 1);
  assert.equal(count(TOOLBAR, "protectedRow()"), 1);
  for (const icon of ["MdReply", "MdEmojiEmotions", "MdDelete"]) {
    assert.doesNotMatch(toolbarShow(icon), /protected/i, icon);
  }
  assert.doesNotMatch(
    TOOLBAR,
    /onClickGif|onClickSticker|MdGif|MdSticker|gif_box|"gif"|"stickers"/,
  );
});

// ---- A6 ---------------------------------------------------------------------

/** Undo exactly the protected additions; each must occur exactly once. */
function normalise(
  src: string,
  edits: Array<[string, string]>,
  cuts: Array<[string, string]>,
): string {
  let out = src;
  for (const [start, end] of cuts) {
    const block = between(out, start, end);
    out = out.replace(block, "");
  }
  for (const [now, base] of edits) {
    assert.equal(count(out, now), 1, `expected once: ${JSON.stringify(now)}`);
    out = out.replace(now, base);
  }
  return out;
}

test("A6: non-protected source is byte-identical to main 7fde1662", () => {
  const menu = normalise(
    MENU,
    [
      [
        'import {\n  type ProtectedAction,\n  protectedActionsBlocked,\n} from "@revolt/client/protectedShield";\nimport { useProtectedMessage } from "@revolt/client/useProtectedChannel";\n',
        "",
      ],
      ['    !hidden("forward") &&\n', ""],
      ['      hidden("publish") ||\n', ""],
      [' && !hidden("attachments")', ""],
      ['            !hidden("create_thread") &&\n', ""],
      ['            !hidden("edit") &&\n', ""],
      ['            !hidden("poll") &&\n', ""],
      ['            !hidden("report") &&\n', ""],
      [
        "    const text = copyableText();\n    if (text === null) return;\n    navigator.clipboard.writeText(text);\n",
        "    navigator.clipboard.writeText(props.message!.content);\n",
      ],
      [
        "        <Show when={copyableText() !== null}>\n          <ContextMenuButton icon={MdContentCopy} onClick={copyText}>\n            <Trans>Copy text</Trans>\n          </ContextMenuButton>\n        </Show>\n",
        "        <ContextMenuButton icon={MdContentCopy} onClick={copyText}>\n          <Trans>Copy text</Trans>\n        </ContextMenuButton>\n",
      ],
    ],
    [
      [
        "\n  /**\n   * Whether this message is in a Protected channel",
        "\n  };\n",
      ],
    ],
  );
  assert.equal(sha256(menu), MENU_BASE_SHA256, "MessageContextMenu.tsx");

  const toolbar = normalise(
    TOOLBAR,
    [
      [
        'import { useClient, useE2EE, useUser } from "@revolt/client";\nimport { protectedActionsBlocked } from "@revolt/client/protectedShield";\n',
        'import { useE2EE, useUser } from "@revolt/client";\n',
      ],
      ["  const client = useClient();\n", ""],
      [
        '      <Show\n        when={\n          !protectedActionsBlocked(protectedRow(), "edit") &&\n          !contentActionsBlocked() &&\n          message?.author?.self\n        }\n      >\n',
        "      <Show when={!contentActionsBlocked() && message?.author?.self}>\n",
      ],
    ],
    [
      [
        "\n  /**\n   * Whether this message is in a Protected channel",
        "channelId);\n",
      ],
    ],
  );
  assert.equal(sha256(toolbar), TOOLBAR_BASE_SHA256, "MessageToolbar.tsx");
});

// ---- A7 ---------------------------------------------------------------------

test("A7: A2 keeps and hides what these menus rely on", () => {
  for (const a of ["reply", "react", "pin", "delete", "copy", "mark_unread"]) {
    assert.ok((PROTECTED_KEPT_ACTIONS as readonly string[]).includes(a), a);
    assert.equal(protectedActionsBlocked(true, a as never), false, a);
  }
  for (const a of [
    "edit",
    "forward",
    "publish",
    "create_thread",
    "report",
    "poll",
    "attachments",
    "gif",
    "stickers",
  ]) {
    assert.ok((PROTECTED_HIDDEN_ACTIONS as readonly string[]).includes(a), a);
    assert.equal(protectedActionsBlocked(true, a as never), true, a);
    assert.equal(protectedActionsBlocked(false, a as never), false, a);
  }
  // Every action string the menus pass is a real ProtectedAction.
  const used = [
    ...(MENU.match(/hidden\("([a-z_]+)"\)/g) ?? []),
    ...(TOOLBAR.match(/protectedRow\(\), "([a-z_]+)"\)/g) ?? []),
  ].map((m) => /"([a-z_]+)"/.exec(m)![1]);
  assert.ok(used.length >= 8, "gates found");
  for (const a of used) {
    assert.ok(
      (PROTECTED_HIDDEN_ACTIONS as readonly string[]).includes(a),
      `${a} is not a hidden action`,
    );
  }
});

// ---- A8 ---------------------------------------------------------------------

test("A8: no styled(ImportedComponent, ...)", () => {
  for (const src of [MENU, TOOLBAR]) {
    for (const m of src.matchAll(/\bstyled\(\s*([^,\s)]+)/g)) {
      assert.match(m[1], /^["']/, `styled(${m[1]}, ...)`);
    }
  }
});

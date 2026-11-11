// Source-scan spec for the channel Overview settings page on Protected
// channels (W4 lane C13, plan D11, design 7.4): `Overview.tsx` cannot load
// under Node (Solid JSX, stoat.js, the client context), so this reads it as
// text and runs its refusal helper from a type-stripped copy:
//
//  O1  the predicate is channel-keyed (`client().isProtectedChannel`, the
//      server flag or this device's pin) and goes through A2's
//      `protectedActionsBlocked(..., "channel_type_toggles")`;
//  O2  the announcement, calls and AFK sections are hidden on a protected
//      channel (first condition of their `<Show when>`; for AFK, the first
//      term of `canConfigureAfk`, whose `<Show>` opening the AFK specs pin),
//      so a save the server refuses with `ChannelProtected` is never
//      offered;
//  O3  the announcement and calls handlers refuse first, before any write;
//  O4  one informational line from C0 (`settingsCopy.typeTogglesHidden`)
//      shows in their place;
//  O5  the edits the server allows (info form incl. slowmode, password,
//      spoiler, mature) carry no protected gate;
//  O6  a protected refusal is shown through `protectedNoticeForError(...,
//      { op: "action" })` + `errorUiCopy`, never `error.message`; every
//      other error keeps its handling; the info form save is never silent
//      on a protected channel;
//  O7  with the protected additions removed, the file is byte-identical to
//      the W4b checkpoint 7a1e03ca (non-protected behaviour unchanged);
//  O8  no `styled(ImportedComponent, ...)` (blank page at boot).
//
// Run: node --test --conditions=browser \
//   components/app/interface/settings/channel/protectedOverview.scan.test.ts
// `PROTECTED_OVERVIEW_TSX=<path>` scans another copy (named controls).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import {
  PROTECTED_HIDDEN_ACTIONS,
  PROTECTED_SERVER_ERROR_TYPES,
  protectedActionsBlocked,
  protectedNoticeForError,
} from "../../../../client/protectedShield.ts";

const SRC = readFileSync(
  process.env.PROTECTED_OVERVIEW_TSX ||
    new URL("./Overview.tsx", import.meta.url),
  "utf8",
);

/** sha256 of `Overview.tsx` at the W4b checkpoint 7a1e03ca. */
const BASE_SHA256 =
  "035eb58bde75a76fd9c0893175711960ee9b2c6d0a08be96adcb4732c55f58a9";

// ---- Source helpers ---------------------------------------------------------

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end ${end} after ${start}`);
  return src.slice(a, b + end.length);
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** The `<Show ...>` opening tag text up to the section's label `anchor`. */
function sectionShow(anchor: string): string {
  assert.equal(count(SRC, anchor), 1, `ambiguous or missing: ${anchor}`);
  const at = SRC.indexOf(anchor);
  const open = SRC.lastIndexOf("<Show", at);
  assert.ok(open >= 0, `no <Show> before ${anchor}`);
  const head = SRC.slice(open, at);
  const close = head.indexOf(">\n");
  assert.ok(close >= 0, `unterminated <Show> before ${anchor}`);
  return head.slice(0, close + 1);
}

/** The first condition of a `when={ a && b }`. */
function firstCondition(show: string): string {
  const m = /when=\{\s*([^\n]+)/.exec(show);
  assert.ok(m, `no condition in ${show}`);
  return m![1].trim();
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const GATE = "!typeTogglesHidden() &&";

// ---- O1 ---------------------------------------------------------------------

test("O1: the predicate is channel-keyed and goes through A2", () => {
  assert.equal(
    count(SRC, "client().isProtectedChannel(props.channel.id)"),
    1,
    "one trust predicate",
  );
  assert.match(
    SRC,
    /const isProtected = \(\) => client\(\)\.isProtectedChannel\(props\.channel\.id\);/,
  );
  assert.match(
    SRC,
    /const typeTogglesHidden = \(\) =>\s+protectedActionsBlocked\(isProtected\(\), "channel_type_toggles"\);/,
  );
  assert.ok(
    (PROTECTED_HIDDEN_ACTIONS as readonly string[]).includes(
      "channel_type_toggles",
    ),
  );
  assert.equal(protectedActionsBlocked(true, "channel_type_toggles"), true);
  assert.equal(protectedActionsBlocked(false, "channel_type_toggles"), false);
  assert.doesNotMatch(SRC, /isEncryptedMessage|\.isProtected\b/);
});

// ---- O2 ---------------------------------------------------------------------

test("O2: announcement, calls and AFK sections are hidden on protected", () => {
  for (const anchor of [
    "<Trans>Announcement Channel</Trans>",
    "<Trans>Voice and Video Calls</Trans>",
  ]) {
    const show = sectionShow(anchor);
    assert.equal(firstCondition(show).startsWith(GATE), true, show);
  }
  // The AFK section keeps its `<Show when={canConfigureAfk()}>` opening
  // byte-for-byte (the AFK specs anchor on it); the gate is the first term
  // of `canConfigureAfk` itself.
  assert.equal(
    sectionShow("<Trans>AFK Channel</Trans>"),
    "<Show when={canConfigureAfk()}>",
  );
  const afk = between(SRC, "const canConfigureAfk = () =>", ";\n");
  assert.match(
    afk,
    /^const canConfigureAfk = \(\) =>\s+!typeTogglesHidden\(\) &&/,
  );
});

// ---- O3 ---------------------------------------------------------------------

test("O3: the announcement and calls handlers refuse before any write", () => {
  for (const name of ["toggleAnnouncement", "toggleCalls"]) {
    const body = between(SRC, `async function ${name}() {\n`, "\n  }\n");
    const first = body.split("\n")[1].trim();
    assert.equal(first, "if (typeTogglesHidden()) return;", name);
  }
});

// ---- O4 ---------------------------------------------------------------------

test("O4: one C0 informational line replaces the hidden controls", () => {
  assert.equal(
    count(
      SRC,
      "      <Show when={typeTogglesHidden() && canManageChannel()}>\n        <Text>{settingsCopy.typeTogglesHidden()}</Text>\n      </Show>\n",
    ),
    1,
  );
  assert.equal(count(SRC, "settingsCopy."), 1, "no other settings copy");
  // Every use of the gate: three sections, two handlers, the info line.
  const uses = [...SRC.matchAll(/(?<!settingsCopy\.)typeTogglesHidden\(\)/g)];
  assert.equal(uses.length, 6);
});

// ---- O5 ---------------------------------------------------------------------

test("O5: edits the server allows carry no protected gate", () => {
  const kept: Array<[string, string]> = [
    [
      "label={t`Channel Slowmode`}",
      '<Show when={props.channel.type === "TextChannel"}>',
    ],
    ["<Trans>Channel Password</Trans>", "<Show when={!isThread()}>"],
    [
      "<Trans>Spoiler Channel</Trans>",
      '<Show when={props.channel.type === "TextChannel" && canManageChannel()}>',
    ],
    [
      "<Trans>Followers</Trans>",
      "<Show when={props.channel.isAnnouncement && canManageChannel()}>",
    ],
  ];
  for (const [anchor, show] of kept) {
    assert.equal(sectionShow(anchor), show, anchor);
  }
  // The mature toggle (a modal the server allows) is untouched.
  const mature = between(
    SRC,
    '<Text class="label">\n            <Trans>Mark as Mature</Trans>',
    "</Column>",
  );
  assert.doesNotMatch(mature, /typeTogglesHidden|isProtected|protected/i);
  // The info form (name, description, icon, slowmode) has no gate.
  const form = between(SRC, "<form onSubmit={submit}>", "</form>");
  assert.doesNotMatch(form, /typeTogglesHidden|isProtected\(\)/);
});

// ---- O6 ---------------------------------------------------------------------

const REFUSAL = between(
  SRC,
  "function protectedRefusal(",
  "    return true;\n  }\n",
);

function loadRefusal(errorUiCopy: (ui: unknown) => string | null) {
  const notices: Array<{ at: string; text: string }> = [];
  const make = new Function(
    "PROTECTED_SERVER_ERROR_TYPES",
    "protectedNoticeForError",
    "errorUiCopy",
    "setProtectedNotice",
    `return ${stripTypeScriptTypes(REFUSAL)};`,
  );
  const fn = make(
    PROTECTED_SERVER_ERROR_TYPES,
    protectedNoticeForError,
    errorUiCopy,
    (n: { at: string; text: string }) => notices.push(n),
  ) as (error: unknown, at: string) => boolean;
  return { fn, notices };
}

test("O6: protected refusals map through A2 + C0, others pass through", () => {
  const seen: unknown[] = [];
  const { fn, notices } = loadRefusal((ui) => {
    seen.push(ui);
    const u = ui as { kind: string; notice?: string };
    return u.kind === "notice" ? `copy:${u.notice}` : null;
  });

  // The design 9.2 answer for a refused edit (stoat-api throws the body).
  assert.equal(
    fn({ type: "ChannelProtected", location: "x" }, "announcement"),
    true,
  );
  assert.deepEqual(notices.at(-1), {
    at: "announcement",
    text: "copy:channel_protected",
  });
  assert.deepEqual(seen.at(-1), {
    kind: "notice",
    notice: "channel_protected",
    max: null,
    tag: "ChannelProtected",
  });
  assert.equal(fn({ type: "ProtectedChannelResecuring" }, "info"), true);
  assert.deepEqual(notices.at(-1), { at: "info", text: "copy:resecuring" });

  // Everything else keeps the page's existing handling.
  const before = notices.length;
  for (const other of [
    { type: "MissingPermission", permission: "ManageChannel" },
    { type: "InvalidOperation" },
    new TypeError("Failed to fetch"),
    "ChannelProtected",
    null,
    undefined,
    { type: 7 },
  ]) {
    assert.equal(fn(other, "spoiler"), false, JSON.stringify(other));
  }
  assert.equal(notices.length, before);

  // A mapping with no copy is not swallowed.
  const none = loadRefusal(() => null);
  assert.equal(none.fn({ type: "ChannelProtected" }, "password"), false);
  assert.equal(none.notices.length, 0);

  // Source: one mapping call, op `action`, never the error's own text.
  assert.equal(
    count(SRC, 'errorUiCopy(protectedNoticeForError(error, { op: "action" }))'),
    1,
  );
  assert.doesNotMatch(SRC, /error\.message\b(?!`)/);
  assert.equal(count(SRC, "error.message"), 1, "the doc comment only");
});

test("O6: every Overview channel save surfaces a protected refusal", () => {
  for (const [name, catchLine] of [
    [
      "toggleSpoiler",
      '      if (!protectedRefusal(error, "spoiler")) showError(error);\n',
    ],
    [
      "setChannelPassword",
      '      if (!protectedRefusal(error, "password")) showError(error);\n',
    ],
    [
      "toggleAnnouncement",
      '      if (!protectedRefusal(error, "announcement")) throw error;\n',
    ],
  ] as const) {
    const body = between(SRC, `async function ${name}() {\n`, "\n  }\n");
    assert.equal(count(body, catchLine), 1, name);
    assert.ok(body.includes("setProtectedNotice(null);"), `${name} clears`);
  }
  const submit = between(SRC, "async function onSubmitShown() {\n", "\n  }\n");
  assert.ok(submit.includes("setProtectedNotice(null);"));
  assert.ok(submit.includes("await onSubmit();"));
  assert.ok(
    submit.includes(
      '      if (!protectedRefusal(error, "info") && isProtected()) showError(error);\n      throw error;\n',
    ),
    "never silent on protected; rethrown so the form keeps the edits",
  );
  assert.equal(
    count(SRC, "Form2.useSubmitHandler(editGroup, onSubmitShown, onReset)"),
    1,
  );
  for (const at of ["info", "password", "announcement", "spoiler"]) {
    assert.equal(
      count(
        SRC,
        `<Show when={protectedNoticeAt("${at}")}>\n            {(text) => <Text>{text()}</Text>}\n          </Show>\n`,
      ),
      1,
      `notice rendered at ${at}`,
    );
  }
});

// ---- O7 ---------------------------------------------------------------------

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

test("O7: non-protected source is byte-identical to 7a1e03ca", () => {
  const notice = (at: string) =>
    `          <Show when={protectedNoticeAt("${at}")}>\n            {(text) => <Text>{text()}</Text>}\n          </Show>\n`;
  const gated = (cond: string) =>
    `      <Show\n        when={\n          !typeTogglesHidden() &&\n          ${cond} &&\n          canManageChannel()\n        }\n      >\n`;
  const out = normalise(
    SRC,
    [
      [
        'import { errorUiCopy, settingsCopy } from "@revolt/client/protectedCopy";\nimport {\n  PROTECTED_SERVER_ERROR_TYPES,\n  protectedActionsBlocked,\n  protectedNoticeForError,\n} from "@revolt/client/protectedShield";\n',
        "",
      ],
      [
        "    if (typeTogglesHidden()) return;\n    setProtectedNotice(null);\n    setAnnouncementSaving(true);\n",
        "    setAnnouncementSaving(true);\n",
      ],
      [
        '    } catch (error) {\n      // Only a protected refusal is caught (the channel was protected\n      // after this page loaded); every other error is rethrown as before.\n      if (!protectedRefusal(error, "announcement")) throw error;\n',
        "",
      ],
      [
        "    setProtectedNotice(null);\n    setSpoilerSaving(true);\n",
        "    setSpoilerSaving(true);\n",
      ],
      [
        '      if (!protectedRefusal(error, "spoiler")) showError(error);\n',
        "      showError(error);\n",
      ],
      [
        "    if (typeTogglesHidden()) return;\n    setCallsSaving(true);\n",
        "    setCallsSaving(true);\n",
      ],
      [
        "    setProtectedNotice(null);\n    setPwSaving(true);\n",
        "    setPwSaving(true);\n",
      ],
      [
        '      if (!protectedRefusal(error, "password")) showError(error);\n',
        "      showError(error);\n",
      ],
      [
        "Form2.useSubmitHandler(editGroup, onSubmitShown, onReset)",
        "Form2.useSubmitHandler(editGroup, onSubmit, onReset)",
      ],
      [notice("info"), ""],
      [notice("password"), ""],
      [notice("announcement"), ""],
      [notice("spoiler"), ""],
      [
        "      <Show when={typeTogglesHidden() && canManageChannel()}>\n        <Text>{settingsCopy.typeTogglesHidden()}</Text>\n      </Show>\n\n",
        "",
      ],
      [
        gated('props.channel.type === "TextChannel"'),
        '      <Show when={props.channel.type === "TextChannel" && canManageChannel()}>\n',
      ],
      [
        gated('props.channel.type === "Group"'),
        '      <Show when={props.channel.type === "Group" && canManageChannel()}>\n',
      ],
      [
        "   * Never on a Protected channel (plan D11): it is never a voice channel.\n",
        "",
      ],
      [
        "  const canConfigureAfk = () =>\n    !typeTogglesHidden() &&\n    props.channel.isVoice &&\n    !!props.channel.serverId &&\n    canManageServer();\n",
        "  const canConfigureAfk = () =>\n    props.channel.isVoice && !!props.channel.serverId && canManageServer();\n",
      ],
    ],
    [
      [
        "\n  /**\n   * Whether this is a Protected channel on this client",
        "    return true;\n  }\n",
      ],
      [
        "\n  /**\n   * The info form's save.",
        "      throw error;\n    }\n  }\n",
      ],
    ],
  );
  assert.equal(sha256(out), BASE_SHA256);
});

// ---- O8 ---------------------------------------------------------------------

test("O8: no styled(ImportedComponent, ...) and no legacy barrel", () => {
  for (const m of SRC.matchAll(/\bstyled\(\s*([^,\s)]+)/g)) {
    assert.match(m[1], /^["']/, `styled(${m[1]}, ...)`);
  }
  assert.doesNotMatch(SRC, /from "@revolt\/ui\/components\/features\/legacy"/);
  assert.doesNotMatch(SRC, /from "[^"]*features\/legacy"/);
});

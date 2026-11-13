// Source-scan spec for the Protected channel composer (W4 lane C4, plan D9c,
// D11, D17; design 9.1). `Composition.tsx` and `MessageBox.tsx` cannot load
// under Node (Solid, lingui, stoat.js), so this reads them as text and pins:
//
//  P1  the protected guard is the FIRST statement of `sendMessage` and only
//      hands off to `sendProtectedMessage` (before `/roll`, game lookups,
//      `/softres` and bot slash commands);
//  P2  `sendProtectedMessage` sends the draft through `sendDraft` only, needs
//      the `enabled` composer, and shows refusals through
//      `protectedNoticeForError` / `errorUiCopy`, never `.message`;
//  P3  the paste and drop collectors are inactive on a protected channel;
//  P4  every forbidden action (attach, camera, voice message, dice, GIF,
//      stickers, polls, soft-reserve, timelock, schedule, disappearing
//      timer, slash commands) is gated by the protected predicate;
//  P5  the predicate is declared before the eagerly evaluated memos (TDZ);
//      the composer is disabled while the shield loads (fail closed);
//  P6  MessageBox has a `protected` tone in BOTH variant records and keeps
//      its `never` exhaustiveness check.
//  F4  (W4d) the D10 `maybeUnsent` view flag renders a dismissible notice,
//      in every shield state, dismissed per channel for the session.
//  U4  (S2 W4-3) the composer rule in Composition.tsx's
//      `// protected-pure:begin` .. `// protected-pure:end` region (no
//      runtime imports) is cut out, type-stripped with Node's own stripper
//      and RUN against the real `explainShield` / `shieldPresentation`:
//      capacity (D35) and client_outdated (OR-4) hide the composer behind
//      their notice; the input exists only in `protected`; Review is
//      offered only on F1 `reviewOffered === true` (OR-10); Review opens
//      the D41 owner-review modal and the composer never calls
//      `confirmOwnerChange` itself.
//
// Run: node --test --conditions=browser \
//   src/interface/channels/text/protectedComposer.scan.test.ts
// `PROTECTED_COMPOSER_TSX=<path>` / `PROTECTED_MESSAGEBOX_TSX=<path>` scan
// another copy (named controls C-C4a/b/c, W4d C-F4, S2 W4-3 ctl/U4).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  type ProtectedComposerMode,
  type ProtectedNoticeKind,
  type ProtectedShieldState,
  type ShieldInputs,
  explainShield,
  PROTECTED_SHIELD_STATES,
  shieldPresentation,
} from "../../../../components/client/protectedShield.ts";
import type {
  ProtectedChannelView,
  TextChannelState,
} from "../../../../components/client/protectedTextTypes.ts";

const COMPOSITION = readFileSync(
  process.env.PROTECTED_COMPOSER_TSX ||
    new URL("./Composition.tsx", import.meta.url),
  "utf8",
);
const MESSAGE_BOX = readFileSync(
  process.env.PROTECTED_MESSAGEBOX_TSX ||
    new URL(
      "../../../../components/ui/components/features/messaging/composition/MessageBox.tsx",
      import.meta.url,
    ),
  "utf8",
);

// ---- Source helpers ---------------------------------------------------------

/**
 * Index just past the closer matching the opener at `open`, skipping
 * strings, template literals and comments (good enough for these files).
 */
function matchPair(src: string, open: number, a = "{", b = "}"): number {
  assert.equal(src[open], a, `matchPair: not at ${a}`);
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
    if (c === a) depth++;
    if (c === b) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  assert.fail(`matchPair: unbalanced ${a}${b}`);
}

/**
 * Body (between the braces) of the function whose header starts with
 * `header`: past its parameter list, so a typed `props: { … }` is skipped.
 */
function functionBody(src: string, header: string): string {
  const at = src.indexOf(header);
  assert.ok(at >= 0, `missing ${header}`);
  const params = src.indexOf("(", at);
  const open = src.indexOf("{", matchPair(src, params, "(", ")"));
  return src.slice(open + 1, matchPair(src, open) - 1);
}

/** Argument list of the first `createMemo(` after `const <name> =`. */
function memoBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = createMemo`);
  assert.ok(at >= 0, `missing memo ${name}`);
  const open = src.indexOf("(", at);
  return src.slice(open + 1, matchPair(src, open, "(", ")") - 1);
}

/** Drop comments and collapse whitespace. */
function code(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The `when={...}` conditions of every `<Show>` / `<Match>` enclosing
 * `at`, nearest first.
 */
function enclosingConditions(src: string, at: number): string[] {
  const tag = /<\/?(Show|Match)\b/g;
  const tags: { index: number; close: boolean }[] = [];
  for (const m of src.slice(0, at).matchAll(tag)) {
    tags.push({ index: m.index!, close: m[0].startsWith("</") });
  }
  const out: string[] = [];
  let depth = 0;
  for (let k = tags.length - 1; k >= 0; k--) {
    if (tags[k].close) {
      depth++;
      continue;
    }
    if (depth > 0) {
      depth--;
      continue;
    }
    const when = src.indexOf("when={", tags[k].index);
    const open = when + "when=".length;
    out.push(code(src.slice(open + 1, matchPair(src, open) - 1)));
  }
  return out;
}

/** Assert the UI at `marker` sits under a condition matching `gate`. */
function assertGated(marker: string, gate: RegExp) {
  const at = COMPOSITION.indexOf(marker);
  assert.ok(at >= 0, `missing marker ${marker}`);
  const conditions = enclosingConditions(COMPOSITION, at);
  assert.ok(
    conditions.some((c) => gate.test(c)),
    `${marker} is not gated by ${gate}; enclosing: ${JSON.stringify(conditions)}`,
  );
}

const SEND_MESSAGE = functionBody(
  COMPOSITION,
  "async function sendMessage(useContent?: unknown) {",
);
const SEND_PROTECTED = functionBody(
  COMPOSITION,
  "async function sendProtectedMessage(useContent: unknown) {",
);
const ERROR_TEXT = functionBody(
  COMPOSITION,
  "function protectedSendErrorText(error: unknown): string {",
);
const ERROR_UI = functionBody(COMPOSITION, "function protectedSendErrorUi(");

// ---- P1 ---------------------------------------------------------------------

test("P1 the protected guard is the first statement of sendMessage", () => {
  const body = code(SEND_MESSAGE);
  const guard = "if (client().isProtectedChannel(props.channel.id)) {";
  assert.ok(
    body.startsWith(guard),
    `first statement is not the guard: ${body.slice(0, 120)}`,
  );
  const guardAt = SEND_MESSAGE.indexOf(guard);
  const blockOpen = guardAt + guard.length - 1;
  const block = SEND_MESSAGE.slice(
    blockOpen,
    matchPair(SEND_MESSAGE, blockOpen),
  );
  assert.equal(
    code(block),
    "{ return sendProtectedMessage(useContent); }",
    "the guard must only hand off to sendProtectedMessage",
  );
  for (const later of [
    "/^\\/roll(\\s|$)/i",
    "parseGameCommand(",
    "/^\\/softres(\\s|$)/i",
    "sendInteraction(",
    "disappearAllowed()",
    "state.draft.sendDraft(",
  ]) {
    const at = SEND_MESSAGE.indexOf(later);
    assert.ok(at > guardAt, `${later} must come after the guard`);
  }
});

// ---- P2 ---------------------------------------------------------------------

test("P2 the protected path sends the draft only, through sendDraft", () => {
  const body = code(SEND_PROTECTED);
  assert.ok(
    body.startsWith('if (protectedComposer() !== "enabled") return;'),
    "sendProtectedMessage must first require the enabled composer",
  );
  assert.ok(
    body.includes("await state.draft.sendDraft(client(), props.channel)"),
  );
  for (const forbidden of [
    "sendRoll(",
    "runGameCommand(",
    "parseGameCommand(",
    "sendInteraction(",
    "create_softres",
    "disappear",
    ".sendMessage(",
    "sendModeNow",
    "addFile(",
  ]) {
    assert.ok(!body.includes(forbidden), `protected path calls ${forbidden}`);
  }
  // a picker string is refused, never sent
  assert.match(
    body,
    /if \(typeof useContent === "string"\) \{ openModal\(\{[^}]*\}\); return; \}/,
  );
});

test("P2 refusals go through protectedNoticeForError, never .message", () => {
  for (const [name, body] of [
    ["sendProtectedMessage", SEND_PROTECTED],
    ["protectedSendErrorText", ERROR_TEXT],
    ["protectedSendErrorUi", ERROR_UI],
  ] as const) {
    assert.ok(!/\.message\b/.test(code(body)), `${name} reads .message`);
  }
  const send = code(SEND_PROTECTED);
  assert.match(
    send,
    /catch \(error\) \{ openModal\(\{ type: "error2", error: new Error\(protectedSendErrorText\(error\)\), \}\); \}/,
  );
  const text = code(ERROR_TEXT);
  assert.ok(
    text.includes("isProtectedSendError(error) ? error.failure : error"),
  );
  // C5's bare files refusal gets the files copy, before the mapping
  assert.ok(
    text.includes(
      "if (isFilesRefusal(cause)) return composerCopy.filesRefused();",
    ),
  );
  const files = code(functionBody(COMPOSITION, "function isFilesRefusal("));
  assert.ok(files.includes('field === "attachments"'));
  assert.ok(!/\.message\b/.test(files), "isFilesRefusal reads .message");
  assert.ok(text.includes("errorUiCopy(protectedSendErrorUi(cause"));
  const ui = code(ERROR_UI);
  assert.ok(ui.includes("ProtectedChannelUnavailable"));
  assert.ok(ui.includes("ProtectedFieldRefusedClient"));
  assert.ok(ui.includes('protectedNoticeForError(cause, { op: "send" })'));
});

// ---- P3 ---------------------------------------------------------------------

test("P3 paste and drop collectors are inactive on a protected channel", () => {
  for (const tag of ["<FilePasteCollector", "<FileDropAnywhereCollector"]) {
    const at = COMPOSITION.indexOf(tag);
    assert.ok(at >= 0, `missing ${tag}`);
    const element = code(COMPOSITION.slice(at, COMPOSITION.indexOf("/>", at)));
    assert.ok(
      element.includes('active={() => !protectedHides("attachments")}'),
      `${tag} is not inactive on protected: ${element}`,
    );
  }
  assert.ok(!COMPOSITION.includes("active={() => true}"));
  // onFiles and addFile refuse as a second key. onFiles passes the target
  // of a drop/paste/pick so files bound for another channel are judged by
  // that channel's gesture, not by the one on screen when they arrive.
  for (const [header, first] of [
    [
      "function onFiles(files: File[], target?: ZipTarget) {",
      "if (refuseProtectedFiles(target)) return;",
    ],
    ["function addFile() {", "if (refuseProtectedFiles()) return;"],
    ["function addFolder() {", "if (refuseProtectedFiles()) return;"],
  ]) {
    assert.ok(
      code(functionBody(COMPOSITION, header)).startsWith(first),
      `${header} must refuse first`,
    );
  }
  // ...and the only pass refuseProtectedFiles gives is for files whose
  // channel is not the one on screen
  assert.ok(
    code(
      functionBody(
        COMPOSITION,
        "function refuseProtectedFiles(target?: ZipTarget) {",
      ),
    ).startsWith(
      "if (target && zipChannels.get(target.owner) !== props.channel.id) {",
    ),
  );
});

// ---- P4 ---------------------------------------------------------------------

test("P4 forbidden actions are gated by the protected predicate", () => {
  assertGated(
    "<IconButton onPress={addFile}>",
    /protectedHides\("attachments"\)/,
  );
  assertGated(
    "<IconButton onPress={addFolder}>",
    /protectedHides\("attachments"\)/,
  );
  assertGated("<CameraMessageButton", /protectedHides\("camera"\)/);
  assertGated("<VoiceMessageButton", /protectedHides\("voice_message"\)/);
  assertGated("<Symbol>casino</Symbol>", /protectedHides\("dice"\)/);
  assertGated("triggerProps.onClickSticker", /protectedHides\("stickers"\)/);
  assertGated("triggerProps.onClickGif", /protectedHides\("gif"\)/);
  // v0.70.0 moved the more-options toggle to the end of the bar
  assertGated("setShowMoreActions((v) => !v)", /!protectedChannel\(\)/);
  assert.equal(
    (COMPOSITION.match(/setShowMoreActions\(\(v\) => !v\)/g) ?? []).length,
    1,
    "exactly one more-options toggle",
  );

  const memoGates: [string, string, string][] = [
    ['type: "create_poll"', "pollAllowed", "poll"],
    ["t`Create soft-reserve sheet`", "softresAllowed", "softres"],
    ['type: "timelock_compose"', "timelockAllowed", "timelock"],
    ['type: "schedule_message"', "scheduleAllowed", "schedule"],
    ["onPress={toggleDisappearMenu}", "disappearAllowed", "disappearing_timer"],
  ];
  for (const [marker, memo, action] of memoGates) {
    assertGated(marker, new RegExp(`\\b${memo}\\(\\)`));
    assert.ok(
      memoBody(COMPOSITION, memo).includes(`!protectedHides("${action}")`),
      `${memo} does not hide on protected`,
    );
  }

  // The emoji picker drops its GIF and sticker tabs
  const picker = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("<CompositionMediaPicker"),
      COMPOSITION.indexOf("{(triggerProps) =>"),
    ),
  );
  assert.ok(
    picker.includes(
      'emojiOnly={protectedHides("gif") || protectedHides("stickers")}',
    ),
    `picker keeps its GIF / sticker tabs: ${picker}`,
  );
  // Slash commands: not offered, not fetched
  const resource = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("const [availableCommands] = createResource("),
      COMPOSITION.indexOf("const searchSpace = createMemo"),
    ),
  );
  assert.ok(resource.includes('protectedHides("slash_commands"),'));
  assert.ok(resource.includes("if ( protectedHidden ||"));
  // ArrowUp edit
  assert.match(
    code(COMPOSITION),
    /onEditLastMessage=\{\(\) => \{ if \(protectedHides\("edit"\)\) return;/,
  );
  // /roll from the dice popover
  assert.ok(
    code(
      functionBody(COMPOSITION, "async function sendRoll(notation: string) {"),
    ).startsWith('if (protectedHides("roll")) {'),
  );
});

// ---- P5 ---------------------------------------------------------------------

test("P5 predicate before the eager memos; fail closed while loading", () => {
  const predicate = COMPOSITION.indexOf("const protectedChannel = createMemo(");
  const hides = COMPOSITION.indexOf("const protectedHides = (");
  const composer = COMPOSITION.indexOf("const protectedComposer = createMemo");
  assert.ok(predicate > 0 && hides > predicate && composer > hides);
  for (const memo of [
    "plaintextFeaturesBlocked",
    "pollAllowed",
    "softresAllowed",
    "scheduleAllowed",
    "disappearAllowed",
    "timelockAllowed",
  ]) {
    assert.ok(
      COMPOSITION.indexOf(`const ${memo} = createMemo(`) > composer,
      `${memo} is declared before the protected predicate (TDZ)`,
    );
  }
  assert.match(
    code(memoBody(COMPOSITION, "protectedChannel")),
    /client\(\)\.isProtectedChannel\(props\.channel\.id\)/,
  );
  const composerBody = code(
    COMPOSITION.slice(composer, COMPOSITION.indexOf("const protectedNotice")),
  );
  assert.ok(
    composerBody.includes(
      'return shield ? shieldPresentation(shield.state).composer : "disabled";',
    ),
    "a loading shield must disable the composer",
  );
  const allowed = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("const sendingAllowed = () => {"),
      COMPOSITION.indexOf("const protectedBlockedText"),
    ),
  );
  assert.ok(
    allowed.includes(
      'if (protectedMode !== undefined && protectedMode !== "enabled") { return false; }',
    ),
  );
});

// ---- P6 ---------------------------------------------------------------------

test("P6 MessageBox: protected tone in both records, exhaustive", () => {
  for (const component of [
    "const Base = styled(",
    "const ActionBar = styled(",
  ]) {
    const at = MESSAGE_BOX.indexOf(component);
    assert.ok(at >= 0, `missing ${component}`);
    const open = MESSAGE_BOX.indexOf("{", at);
    const record = MESSAGE_BOX.slice(at, matchPair(MESSAGE_BOX, open));
    const toneAt = record.indexOf("tone: {");
    assert.ok(toneAt >= 0, `${component} has no tone record`);
    const tone = record.slice(
      toneAt,
      matchPair(record, toneAt + "tone: ".length),
    );
    for (const key of ["plain:", "encrypted:", "protected:"]) {
      assert.ok(tone.includes(key), `${component} tone lacks ${key}`);
    }
  }
  assert.match(MESSAGE_BOX, /const _exhaustive: never = tone;/);
  assert.equal(
    (MESSAGE_BOX.match(/tone=\{toneOf\(props\.tone\)\}/g) ?? []).length,
    3,
  );
});

// ---- P7 (follow-up) ---------------------------------------------------------

test("P7 protected reply preview shows the decrypted view, never server text", () => {
  const body = code(
    functionBody(COMPOSITION, "function ProtectedReplyPreview("),
  );
  assert.ok(body.includes("useProtectedMessage(() => props.messageId)"));
  assert.ok(body.includes("<ProtectedReplyText>{text()}</ProtectedReplyText>"));
  assert.ok(
    body.includes(
      'if (!v || v.status === "pending") return messageCopy.pending();',
    ),
  );
  assert.ok(
    body.includes('if (v.status === "marker") return markerCopy(v.kind);'),
  );
  for (const forbidden of [
    ".content",
    "MessageReply",
    "renderSimpleMarkdown",
    "forwarded",
    "attachments",
    "embeds",
  ]) {
    assert.ok(!body.includes(forbidden), `reply preview reads ${forbidden}`);
  }
  const forEach = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf("<For each={draft().replies ?? []}>"),
      COMPOSITION.indexOf("<Show when={lookupPending() || lookupNotice()}>"),
    ),
  );
  assert.match(
    forEach,
    /<Show when=\{protectedChannel\(\)\} fallback=\{ <MessageReplyPreview [^]*?\/> \} > <ProtectedReplyPreview messageId=\{reply\.id\}/,
  );
});

// ---- P8 (follow-up) ---------------------------------------------------------

// S2 W4-3 (U4): the gate is `composerReviewOffered` (D15 precondition AND
// F1 `reviewOffered`), and the click opens the D41 modal instead of calling
// `confirmOwnerChange` here (the modal owns the native dialog, its failure
// copy and "Still locked."). The old pins on `confirmOwnerChange` and
// `protectedOwnerErrorUi` moved with that call into ProtectedOwnerReview.tsx.
test("P8 'Review owner change' only for a same-user owner change, on click", () => {
  assertGated(
    "{panelCopy.reviewOwnerChange()}",
    /^composerReviewOffered\( protectedShield\(\)\?\.view, protectedShield\(\)\?\.reviewOffered, \)$/,
  );
  assertGated("{panelCopy.reviewOwnerChange()}", /state === "unverified"/);
  const reviewable = code(
    functionBody(COMPOSITION, "function ownerChangeReviewable("),
  );
  // Same condition as the C3 header pill: same_user === true AND pending
  assert.equal(
    reviewable,
    "const pin = view?.native?.owner_pin ?? null; " +
      "if (!pin || pin.pending_signer?.same_user !== true) return false; " +
      'return view?.ownerChangePending === true || pin.status === "changed";',
  );
  // The modal opens only from the button's click
  const calls = [...COMPOSITION.matchAll(/[^.\w]reviewOwnerChange\(\)/g)].map(
    (m) => m[0].trim(),
  );
  assert.deepEqual(calls.sort(), [
    "reviewOwnerChange()",
    "reviewOwnerChange()",
  ]);
  assert.ok(COMPOSITION.includes("onClick={() => reviewOwnerChange()}"));
  assert.ok(COMPOSITION.includes("function reviewOwnerChange() {"));
});

// ---- F4 (W4d final audit) ---------------------------------------------------

test("F4 the D10 maybe-unsent notice renders, dismissible per channel", () => {
  // Rendered from the view flag alone: no shield-state condition around it
  const marker = '{noticeCopy("maybe_unsent")}';
  const at = COMPOSITION.indexOf(marker);
  assert.ok(at >= 0, `missing marker ${marker}`);
  assert.deepEqual(enclosingConditions(COMPOSITION, at), [
    "maybeUnsentShown()",
  ]);
  const shownAt = COMPOSITION.indexOf("const maybeUnsentShown = () =>");
  assert.ok(shownAt >= 0, "missing maybeUnsentShown");
  assert.equal(
    code(COMPOSITION.slice(shownAt, COMPOSITION.indexOf(";\n", shownAt) + 1)),
    "const maybeUnsentShown = () => protectedChannel() && " +
      "protectedShield()?.view?.maybeUnsent === true && " +
      "!maybeUnsentDismissed().has(props.channel.id);",
  );

  // The notice carries a dismiss button with an existing msgid
  const notice = code(
    COMPOSITION.slice(
      COMPOSITION.lastIndexOf("<Show when={maybeUnsentShown()}>", at),
      COMPOSITION.indexOf("</Show>", at),
    ),
  );
  assert.ok(
    notice.includes(
      '<ProtectedBannerAction type="button" onClick={dismissMaybeUnsent}> ' +
        "{t`Dismiss`} </ProtectedBannerAction>",
    ),
    `no dismiss button: ${notice}`,
  );
  assert.ok(!/may not have been sent/i.test(COMPOSITION), "bare copy literal");

  // Dismissal: this channel only, session only (module scope, not stored)
  assert.equal(
    code(functionBody(COMPOSITION, "function dismissMaybeUnsent() {")),
    "const id = props.channel.id; " +
      "setMaybeUnsentDismissed((prev) => new Set(prev).add(id));",
  );
  const declared = COMPOSITION.indexOf(
    "const [maybeUnsentDismissed, setMaybeUnsentDismissed] = createSignal<",
  );
  assert.ok(
    declared >= 0 &&
      declared < COMPOSITION.indexOf("export function MessageComposition("),
    "the dismissed set must live at module scope",
  );
  assert.equal(
    (COMPOSITION.match(/setMaybeUnsentDismissed\b/g) ?? []).length,
    2,
    "the dismissed set is written only by dismissMaybeUnsent",
  );
});

// ---- U4 (S2 W4-3): capacity, client_outdated, Review -----------------------

type ComposerLine =
  | { kind: "input" }
  | { kind: "notice"; notice: ProtectedNoticeKind; draftKept: boolean }
  | { kind: "sending_blocked" };
interface ComposerRules {
  protectedComposerLine(i: {
    mode: ProtectedComposerMode;
    state: ProtectedShieldState | null;
    notice: ProtectedNoticeKind;
    hasDraft: boolean;
  }): ComposerLine;
  composerReviewOffered(
    view: ProtectedChannelView | null | undefined,
    reviewOffered: unknown,
  ): boolean;
}
const PURE_BEGIN = "// protected-pure:begin";
const PURE_END = "// protected-pure:end";
const RULE_NAMES = ["protectedComposerLine", "composerReviewOffered"] as const;

let rulesPromise: Promise<ComposerRules> | null = null;
/** The real region of Composition.tsx (or the env copy), types stripped. */
function loadRules(): Promise<ComposerRules> {
  rulesPromise ??= (async () => {
    const from = COMPOSITION.indexOf(PURE_BEGIN);
    const to = COMPOSITION.indexOf(PURE_END);
    assert.ok(from !== -1 && to > from, "protected-pure region missing");
    assert.equal(
      COMPOSITION.indexOf(PURE_BEGIN, from + 1),
      -1,
      "exactly one protected-pure region",
    );
    const region = COMPOSITION.slice(from, to);
    assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
    const js =
      stripTypeScriptTypes(region.replace(/^export /gm, ""), {
        mode: "strip",
      }) + `\nexport { ${RULE_NAMES.join(", ")} };\n`;
    const out = join(
      mkdtempSync(join(tmpdir(), "s2w43-U4-")),
      "protectedComposerPure.mjs",
    );
    writeFileSync(out, js);
    const mod = (await import(pathToFileURL(out).href)) as Record<
      string,
      unknown
    >;
    for (const name of RULE_NAMES) {
      assert.equal(typeof mod[name], "function", `${name} missing`);
    }
    return mod as unknown as ComposerRules;
  })();
  return rulesPromise;
}

/** Shield inputs past steps 1-3b; `native` stands in for a seated device. */
function inputs(over: Partial<ShieldInputs>): ShieldInputs {
  return {
    serverProtected: true,
    locallyPinned: true,
    capable: true,
    seatListError: null,
    groupError: null,
    native: { verdict: "ok" } as unknown as TextChannelState,
    serverGroup: null,
    rosterMismatchAgeMs: 0,
    signerLeafMissingRetries: 0,
    welcomeRetriesExhausted: false,
    capacity: null,
    clientOutdated: null,
    ...over,
  };
}

/** The composer line exactly as Composition.tsx feeds it. */
async function lineFor(i: ShieldInputs, hasDraft: boolean) {
  const { protectedComposerLine } = await loadRules();
  const ex = explainShield(i);
  assert.ok(ex, "no shield");
  const presentation = shieldPresentation(ex.state);
  return {
    ex,
    line: protectedComposerLine({
      mode: presentation.composer,
      state: ex.state,
      notice: ex.notice ?? presentation.notice ?? "unverified",
      hasDraft,
    }),
  };
}

test("U4 capacity hides the composer behind its D35 notice", async () => {
  for (const [reason, notice] of [
    ["device_cap", "capacity_device_cap"],
    ["group_full", "capacity_group_full"],
  ] as const) {
    const { ex, line } = await lineFor(inputs({ capacity: { reason } }), true);
    assert.equal(ex.state, "capacity");
    assert.deepEqual(line, { kind: "notice", notice, draftKept: false });
  }
});

test("U4 client_outdated hides the composer behind the update notice", async () => {
  for (const native of [
    null,
    { verdict: "ok" } as unknown as TextChannelState,
  ]) {
    const { ex, line } = await lineFor(
      inputs({ clientOutdated: 2, native }),
      true,
    );
    assert.deepEqual(
      [ex.state, ex.notice],
      ["not_available", "client_outdated"],
    );
    assert.deepEqual(line, {
      kind: "notice",
      notice: "client_outdated",
      draftKept: false,
    });
  }
});

test("U4 the input exists only in the protected state; loading fails closed", async () => {
  const { protectedComposerLine } = await loadRules();
  for (const state of PROTECTED_SHIELD_STATES) {
    const mode = shieldPresentation(state).composer;
    for (const hasDraft of [false, true]) {
      const line = protectedComposerLine({
        mode,
        state,
        notice: "not_available",
        hasDraft,
      });
      assert.equal(line.kind === "input", state === "protected", state);
      // a hidden composer is never the input, whatever the state
      assert.notEqual(
        protectedComposerLine({
          mode: "hidden",
          state,
          notice: "not_available",
          hasDraft,
        }).kind,
        "input",
        `hidden ${state}`,
      );
    }
  }
  assert.deepEqual(
    protectedComposerLine({
      mode: shieldPresentation("unverified").composer,
      state: "unverified",
      notice: "off_list_member",
      hasDraft: true,
    }),
    { kind: "sending_blocked" },
  );
  // re-securing keeps the draft; a loading shield is `disabled`, state null
  assert.deepEqual(
    protectedComposerLine({
      mode: shieldPresentation("resecuring").composer,
      state: "resecuring",
      notice: "resecuring",
      hasDraft: true,
    }),
    { kind: "notice", notice: "resecuring", draftKept: true },
  );
  assert.deepEqual(
    protectedComposerLine({
      mode: "disabled",
      state: null,
      notice: "resecuring",
      hasDraft: false,
    }),
    { kind: "notice", notice: "resecuring", draftKept: false },
  );
});

test("U4 the composer reads the line, with the channel's name for the notice", () => {
  const blocked = code(
    COMPOSITION.slice(
      COMPOSITION.indexOf(
        "const protectedBlockedText = (): string | undefined => {",
      ),
      COMPOSITION.indexOf("const blockedText = () => {"),
    ),
  );
  assert.ok(
    blocked.includes(
      "const line = protectedComposerLine({ mode, " +
        "state: protectedShield()?.state ?? null, " +
        "notice: protectedNotice(), " +
        'hasDraft: mode === "disabled" && !!draft().content?.trim(), });',
    ),
    `protectedBlockedText does not read the line: ${blocked}`,
  );
  assert.ok(
    blocked.includes(
      "noticeCopy( line.notice, null, null, props.channel.name ?? null, );",
    ),
    "the notice must carry the channel's display name",
  );
  assert.ok(blocked.includes('case "input": return undefined;'));
  assert.ok(
    blocked.includes(
      'case "sending_blocked": return composerCopy.sendingBlocked();',
    ),
  );
  assert.match(blocked, /const _exhaustive: never = line;/);
  assert.ok(!/channel\.id/.test(blocked), "an id reaches the copy");
});

test("U4 Review is offered only when the shield's reviewOffered is true (F1)", async () => {
  const { composerReviewOffered } = await loadRules();
  const view = (status: string, sameUser: boolean, pending: boolean) =>
    ({
      native: {
        owner_pin: { status, pending_signer: { same_user: sameUser } },
      },
      ownerChangePending: pending,
    }) as unknown as ProtectedChannelView;
  for (const v of [view("changed", true, false), view("pinned", true, true)]) {
    assert.equal(composerReviewOffered(v, true), true);
    for (const offered of [false, undefined, null, "true", 1]) {
      assert.equal(
        composerReviewOffered(v, offered),
        false,
        `offered ${String(offered)}`,
      );
    }
  }
  for (const v of [
    view("changed", false, true),
    view("pinned", true, false),
    null,
    undefined,
  ]) {
    assert.equal(composerReviewOffered(v, true), false);
  }
});

test("U4 Review opens the owner-review modal; the composer never confirms itself", () => {
  const body = code(
    functionBody(COMPOSITION, "function reviewOwnerChange() {"),
  );
  assert.equal(
    body,
    "const request: ProtectedOwnerReviewProps = { " +
      'type: "protected_owner_review", channel: props.channel, }; ' +
      "openModal(request as unknown as ModalRequest);",
  );
  const all = code(COMPOSITION);
  assert.ok(!all.includes("confirmOwnerChange"), "the composer confirms");
  assert.ok(!all.includes("protectedUiOf"), "the composer reaches the bridge");
  // ONE cast, only for the unregistered union member
  assert.equal((all.match(/as unknown as ModalRequest/g) ?? []).length, 1);
  assert.ok(
    COMPOSITION.includes(
      'import type { ProtectedOwnerReviewProps } from "@revolt/modal/modals/ProtectedOwnerReview";',
    ),
  );
});

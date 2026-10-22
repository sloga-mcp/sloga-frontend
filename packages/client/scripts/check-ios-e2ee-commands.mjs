#!/usr/bin/env node
/**
 * Gates G6, G7 and G8 of the iOS E2EE port (plan
 * discord-features-plans/ios-e2ee-messaging-port.md D1, D5, §5, D10, and the
 * W3 binding rules). A source scan of the Swift plugin package
 * (ios/App/SlogaE2ee), its generated uniffi bindings and the frontend sender
 * (components/client/e2ee.ts), so a routing or threading mistake in the iOS
 * shell fails here and not on a phone.
 *
 * Usage, from packages/client:
 *   node scripts/check-ios-e2ee-commands.mjs [--root <client dir>]
 *     [--sources <dir>] [--bindings <file>] [--fe <file>] [--list]
 * Paths are relative to --root (default: the client dir this script is in),
 * so a test can point every input at a mutated copy.
 * Exit 0 = pass. 1 = violations, one per line: `<rule> <file>:<line> <what>`.
 * 2 = an input could not be read or parsed (missing file, unbalanced
 * brackets, unterminated string or comment, a landmark not found).
 *
 * Every rule except the `DispatchQueue.main.sync` text rule runs on LEXED
 * source: comments (Swift block comments nest) and string literal contents
 * (multi-line `"""` and raw `#"…"#` included; interpolated code is kept as
 * code) are blanked with offsets preserved, so commented-out code can neither
 * pass nor fail a rule. Literal values (case labels, table names) come from
 * the lexer's literal table, never from raw text.
 *
 * G6, command table (E2eeCommands.swift, E2eePlugin.swift, bindings, e2ee.ts)
 *   G6-table-shape     each `table` line is exactly `("e2ee_x", .generic),`,
 *                      `.native`, `.out` or `.dedicated("m")`, one per line;
 *                      `dedicatedMethods` is one `"m",` per line
 *   G6-table-duplicate a name listed twice
 *   G6-count           generic 37 / native 2 / dedicated 6, equal to the
 *                      static genericCount/nativeCount/dedicatedCount;
 *                      outCount equals the number of `.out` lines
 *   G6-table-route     the generic, native and dedicated sets are exactly the
 *                      W3 contract's (names and dedicated method per name)
 *   G6-dedicated-order `dedicatedMethods` is the 12 methods in contract order
 *   G6-dedicated-method each dedicated method is an
 *                      `@objc func m(_ call: CAPPluginCall)`; no other @objc
 *                      CAPPluginCall method but `call`; pluginMethods is
 *                      "call" + dedicatedMethods
 *   G6-generic-case    runGeneric's `switch name` has one literal per case,
 *                      exactly the generic names, and a default that rejects
 *                      invalid_argument{name}; nativeJob's switch has exactly
 *                      the native names
 *   G6-generic-binding every generic name maps to an E2eeEngine method of the
 *                      bindings: the method whose uniffi symbol is
 *                      `..._fn_method_e2eeengine_<name minus "e2ee_">`; the
 *                      Swift name is that snake case in lowerCamelCase
 *                      (checked for every method), and the class and its
 *                      protocol export the same methods
 *   G6-generic-arm     each generic arm calls exactly its own engine method
 *   G6-plugin-engine-call an engine call in E2eePlugin.swift is either in a
 *                      generic arm or a gated call in its dedicated method
 *   G6-fe-unlisted     every `e2ee_*` string literal in e2ee.ts is in the table
 *                      (as IN or explicitly `.out`)
 *   G6-fe-dynamic      every `this.#invoke(` names its command with a literal;
 *                      `#transport.invoke` only inside `#invoke`
 *   G6-fe-route        CapacitorTransport's `command === "e2ee_x"` routes agree
 *                      with the table: a dedicated name goes to its method
 *                      only; accept-true peer downgrade goes to
 *                      confirmPeerDowngradeAccept; no other name reaches an
 *                      iOS dedicated method; every dedicated method has an FE
 *                      caller and the FE calls no plugin method iOS lacks
 *                      except for `.out` names (those reject, fail closed)
 * G7, threads and consent (all files under the Swift sources dir)
 *   G7-gated-case      no dedicated (confirm-gated) name is a case label
 *                      anywhere in E2eePlugin.swift
 *   G7-gated-call      wipe/downgrade/enableGroup/addGroupMember/markVerified/
 *                      acceptIdentityChange on an engine value only inside
 *                      their own dedicated @objc method, inside an
 *                      onDedicatedThread/runOnDedicatedThread closure;
 *                      confirmPeerDowngrade likewise in
 *                      confirmPeerDowngradeAccept, or in the generic arm when
 *                      its last argument is the literal `accept: false` and
 *                      the arm contains `optionalBool("accept")` and
 *                      `invalidArgument("accept")` (present, not ordered);
 *                      a `.wipe(`-style call on any receiver not known to be
 *                      a non-engine value fails
 *   G7-dedicated-thread every dedicated method hands off through
 *                      onDedicatedThread/runOnDedicatedThread, which reaches a
 *                      new `Thread`
 *   G7-generic-worker  runGeneric is called once, from an
 *                      `engineWorker.submit` closure
 *   G7-precondition    every function or closure body that calls a method on
 *                      an engine value starts with exactly
 *                      `dispatchPrecondition(condition: .notOnQueue(.main))`
 *   G7-confirm-precondition every `confirm` of a type conforming to
 *                      NativeConfirm starts with it too (one must exist)
 *   G7-engine-untracked an engine value in a shape this scan cannot follow
 *   G7-main-sync       the text `DispatchQueue.main.sync` nowhere under the
 *                      sources dir, any file, comments included (raw text,
 *                      whitespace-tolerant); in code also no `.main.asyncAndWait`,
 *                      `waitUntilDone: true` or `waitUntilFinished: true`
 * G8, unreachable from the webview
 *   G8a-export         the bindings export no call*, mls*, rc* or
 *                      pinCallIdentities function or uniffi symbol
 *   G8a-route          every e2ee_call_* / e2ee_mls_* / e2ee_rc_* /
 *                      e2ee_pin_call_identities table name is `.out`
 *   G8a-unclassified   every exported E2eeEngine method is a generic target,
 *                      a gated method or a native-only method listed here
 *   G8b-native-only    recovery* and backupTakePending* are named only in
 *                      RecoverySheet.swift, serveAttachmentForRender only in
 *                      AttachmentSchemeHandler.swift, attachmentCiphertext/
 *                      Store/ForExport/ExportName only in
 *                      AttachmentTransfer.swift; attachmentAttachBlob and
 *                      attachmentMarkUnavailable only in AttachmentTransfer.swift
 *                      and, in E2eePlugin.swift, their own generic arm; no
 *                      table name that maps to a native-only method is routed
 *   G8b-plugin-crossfile E2eePlugin.swift reaches RecoverySheet and
 *                      AttachmentTransfer only through the listed members,
 *                      each from its listed method or arm
 *                      (RecoverySheet.takeOrphanedBundle only from the
 *                      e2ee_backup_refresh_if_due arm: it returns a ciphertext
 *                      bundle, not an engine value)
 *   G8b-reach          REACHABILITY over a call graph of every Swift function
 *                      under the sources dir (below). (a) From each root, the
 *                      only native-only methods reachable are its own:
 *                      backupCreate/backupRotate the create/rotate recovery
 *                      set, backupRestore the restore set, attachmentUpload
 *                      attachmentCiphertext, attachmentFetch attachmentStore,
 *                      the copy_image / save native arms attachmentForExport
 *                      (+ attachmentExportName for save), the scheme handler's
 *                      webView(_:start:) and the bridge view controller's
 *                      webViewConfiguration(for:) (it builds the handler)
 *                      serveAttachmentForRender; every other root, none. A
 *                      violation prints the path, root first. (b) The set of
 *                      ALL functions that can reach a native-only method, root
 *                      or not, equals the pinned NATIVE_ONLY_CALLERS list, so
 *                      a closure captured at setup and called later through a
 *                      variable (invisible to (a)) still has to be listed
 *   G8b-return         what a native path can hand back: copyImage returns
 *                      only "null", save only "true"/"false" (function-level
 *                      returns; both must exist); a generic arm's return
 *                      expression, once `engine.<own>(…)` and
 *                      `args.<reader>(…)` are cut out, holds nothing but
 *                      try/jsonQuote/map/literals or a pinned extra (the
 *                      refresh arm's `orphaned`); and inside any function
 *                      that can reach a native-only method, `E2eeReject(json:`,
 *                      `invalidArgument(` and `Failure(message:` (all three
 *                      reach the webview through rejectJson) take one plain
 *                      literal
 *
 * The G8b call graph (conservative: it may report a path that cannot run,
 * it must not miss one that can):
 *   - nodes: every func/init/subscript/computed property (closures and
 *     accessors belong to their enclosing function; nested funcs are their
 *     own nodes), every stored-property initializer outside a function (one
 *     node per property, reached by naming the property), and one node per
 *     runGeneric / nativeJob arm;
 *   - edges: EVERY mention of a function or property name counts, called or
 *     not (a function passed as a value, a #selector, a default argument),
 *     except a declaration or an argument label. `T(` and `T.init` reach T's
 *     inits. Resolution: `self.`/`Self.`/bare → the current type's (any
 *     extension) and free functions of that name; `T.` for a type of these
 *     sources → T's; `super.` → the superclass only when it is declared here
 *     (today every superclass is an SDK class); anything else (an unknown
 *     receiver, an implicit `.member`, or a resolution that finds nothing) →
 *     EVERY function of that name;
 *   - a sink is any mention of a native-only method's name in a node;
 *   - roots: the plugin's `call` (its runGeneric/nativeJob calls are replaced
 *     by the arms, each its own root), every arm, every @objc dedicated
 *     method, every func named webView or userContentController, every
 *     `override` func of a type inheriting from a CAP* class, and the
 *     `confirm` of a NativeConfirm type (core calls it mid-command).
 *   Limits: a call through a value whose name is not a function or property
 *   of these sources (a closure parameter or a stored property with no
 *   initializer) adds no edge; (b) is what still catches the code that made
 *   the value. Dispatch from SDK code into our overrides (UIKit lifecycle,
 *   KVO/NotificationCenter blocks) is not followed beyond the code that
 *   registers it; such code is a root only by the rules above. Errors thrown
 *   by the engine itself pass through rejectJson (the core's scrubbed JSON).
 *
 * What "calls a method on an engine value" means (G7-precondition, G7-gated-call):
 *   - engine TYPES: E2eeEngine, E2eeEngineProtocol and any typealias of them;
 *   - engine FACTORIES: any `func f(...) -> E2eeEngine` (E2eeRuntime.engine,
 *     RecoverySheet.currentEngine) and any name declared with a function type
 *     returning one (`provider: (() throws -> E2eeEngine)?`);
 *   - engine NAMES: any identifier declared with an engine type (parameters,
 *     properties), or bound by `let`/`var`/`if let`/`guard let` to a factory
 *     call, a constructor call or another engine name (to a fixpoint);
 *   - an engine CALL is `<name>.member`, `<factory>(...).member` or
 *     `E2eeEngine(...)` (member reads count too, so `let f = engine.wipe`
 *     is caught). Names are pooled across all source files and are not
 *     scoped, which over-approximates: a same-named non-engine value is
 *     treated as an engine and must carry the precondition too.
 *   Limits (each one fails closed where it can): an engine passed in an
 *   argument tuple, array, dictionary, generic or function-type parameter,
 *   cast with `as`/`is`, or extended/subclassed is reported as
 *   G7-engine-untracked instead of followed. Not seen at all: an engine
 *   reached through a subscript or a key path, a tuple destructuring bind, a
 *   reassignment of a variable not declared with an engine type, or Objective-C
 *   dynamic dispatch. Only the first `func onDedicatedThread` of
 *   E2eePlugin.swift and the `runOnDedicatedThread` of Support.swift are
 *   checked to start a thread; a same-named helper elsewhere is trusted by
 *   name. The scan is lexical, not a type checker.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// --------------------------------------------------------------- contract

const PRECONDITION = "dispatchPrecondition(condition: .notOnQueue(.main))";

/** §5 IN column on the generic `call` mux (W3 contract, Plugin bridge). */
const GENERIC = [
  "e2ee_status",
  "e2ee_is_provisioned",
  "e2ee_store_owner",
  "e2ee_enable",
  "e2ee_mark_published",
  "e2ee_replenish",
  "e2ee_sign_claim",
  "e2ee_encrypt",
  "e2ee_decrypt",
  "e2ee_history",
  "e2ee_send_mode",
  "e2ee_conversation_state",
  "e2ee_reconcile_devices",
  "e2ee_handle_receipts",
  "e2ee_device_removed",
  "e2ee_send_mode_group",
  "e2ee_acknowledge_group_plaintext",
  "e2ee_encrypt_group",
  "e2ee_group_reconcile",
  "e2ee_group_state",
  "e2ee_safety_number",
  "e2ee_confirm_peer_downgrade",
  "e2ee_resend_downgrade",
  "e2ee_mark_downgrade_delivered",
  "e2ee_pending_downgrades",
  "e2ee_notify_downgrade",
  "e2ee_downgraded_conversations",
  "e2ee_attachment_prepare",
  "e2ee_attachment_attach_blob",
  "e2ee_attachment_mark_unavailable",
  "e2ee_attachment_recipients",
  "e2ee_attachment_recipients_group",
  "e2ee_backup_status",
  "e2ee_backup_refresh_if_due",
  "e2ee_backup_mark_uploaded",
  "e2ee_backup_forget_local",
  "e2ee_backup_rederive_republish",
];
const NATIVE = ["e2ee_attachment_copy_image", "e2ee_attachment_save"];
/** FE command → its dedicated plugin method. */
const DEDICATED = {
  e2ee_wipe: "wipe",
  e2ee_downgrade: "downgrade",
  e2ee_enable_group: "enableGroup",
  e2ee_add_group_member: "addGroupMember",
  e2ee_mark_verified: "markVerified",
  e2ee_accept_identity_change: "acceptIdentityChange",
};
/** The plugin's dedicated methods, in contract order (`call` excluded). */
const DEDICATED_METHODS = [
  "wipe",
  "downgrade",
  "confirmPeerDowngradeAccept",
  "enableGroup",
  "addGroupMember",
  "markVerified",
  "acceptIdentityChange",
  "backupCreate",
  "backupRotate",
  "backupRestore",
  "attachmentUpload",
  "attachmentFetch",
];
const COUNTS = { generic: 37, native: 2, dedicated: 6 };

/** Confirm-gated engine method → the one plugin method that may call it. */
const GATED = {
  wipe: "wipe",
  downgrade: "downgrade",
  enableGroup: "enableGroup",
  addGroupMember: "addGroupMember",
  markVerified: "markVerified",
  acceptIdentityChange: "acceptIdentityChange",
  confirmPeerDowngrade: "confirmPeerDowngradeAccept",
};
/** The generic arm that may call confirmPeerDowngrade, decline only. */
const PEER_DOWNGRADE_CASE = "e2ee_confirm_peer_downgrade";

/** Native-only (secret or plaintext) engine methods → the only files that may name them. */
const NATIVE_ONLY = {
  recoveryOpen: ["RecoverySheet.swift"],
  recoveryCreate: ["RecoverySheet.swift"],
  recoveryRotate: ["RecoverySheet.swift"],
  recoveryRestore: ["RecoverySheet.swift"],
  recoveryFinish: ["RecoverySheet.swift"],
  recoveryClosed: ["RecoverySheet.swift"],
  backupTakePendingUpload: ["RecoverySheet.swift"],
  backupTakePendingRepublish: ["RecoverySheet.swift"],
  serveAttachmentForRender: ["AttachmentSchemeHandler.swift"],
  attachmentCiphertext: ["AttachmentTransfer.swift"],
  attachmentStore: ["AttachmentTransfer.swift"],
  attachmentForExport: ["AttachmentTransfer.swift"],
  attachmentExportName: ["AttachmentTransfer.swift"],
};
/**
 * Generic engine methods the transfer path calls as well (W3 rule 3's
 * parenthesis). In E2eePlugin.swift they may appear only in their own arm.
 */
const TRANSFER_SHARED = {
  attachmentAttachBlob: ["E2eePlugin.swift", "AttachmentTransfer.swift"],
  attachmentMarkUnavailable: ["E2eePlugin.swift", "AttachmentTransfer.swift"],
};

/** `.wipe(` on these receivers zeroes a buffer we own; not an engine call. */
const NON_ENGINE_GATED_RECEIVERS = {
  "AttachmentSchemeHandler.swift": ["reply"],
  "RecoverySheet.swift": ["secret"],
};

/**
 * What E2eePlugin.swift may reach in the two files that own native-only
 * calls, and from where: `@m` = dedicated @objc method m, `case:x` = the
 * generic arm of x, a bare name = that helper function.
 */
const PLUGIN_CROSS_FILE = {
  "RecoverySheet.teardown": ["@wipe"],
  "RecoverySheet.runCreateOrRotate": ["@backupCreate", "@backupRotate"],
  "RecoverySheet.runRestore": ["@backupRestore"],
  "RecoverySheet.takeOrphanedBundle": ["case:e2ee_backup_refresh_if_due"],
  "AttachmentTransfer.upload": ["@attachmentUpload"],
  "AttachmentTransfer.fetch": ["@attachmentFetch"],
  "AttachmentTransfer.copyImage": ["nativeJob"],
  "AttachmentTransfer.save": ["nativeJob"],
};

/** e2ee.ts string literals shaped like commands that are not commands. */
const FE_NON_COMMANDS = [];

const OUT_EXPORT_NAME = /^(?:(?:call|mls|rc)[A-Z0-9]\w*|pinCallIdentities)$/;
const OUT_COMMAND = /^e2ee_(?:(?:call|mls|rc)_\w+|pin_call_identities)$/;
const OUT_FFI_SYMBOL =
  /\b\w*_(?:method_e2eeengine|func)_(?:(?:call|mls|rc)_\w*|pin_call_identities)\b/g;

const DEFAULTS = {
  sources: "ios/App/SlogaE2ee/Sources/SlogaE2ee",
  bindings: "ios/App/SlogaE2ee/Bindings/acutest_e2ee_ios.swift",
  fe: "components/client/e2ee.ts",
};

// ----------------------------------------------------------------- shared

class InputError extends Error {}

/**
 * Own-key membership. Never `key in table`: that also matches inherited keys,
 * so an export named `toString` would read as classified.
 */
function has(table, key) {
  return Object.hasOwn(table, key);
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function blanker(out) {
  return (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
}

/** Bracket pairs of lexed code (both directions); unbalanced = InputError. */
function matchBrackets(code, rel, starts) {
  const match = new Map();
  const stack = [];
  const opener = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") stack.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      const o = stack.pop();
      if (o === undefined || code[o] !== opener[c]) {
        throw new InputError(`${rel}:${lineAt(starts, i)}: unbalanced '${c}'`);
      }
      match.set(o, i);
      match.set(i, o);
    }
  }
  if (stack.length) {
    const o = stack[stack.length - 1];
    throw new InputError(`${rel}:${lineAt(starts, o)}: unclosed '${code[o]}'`);
  }
  return match;
}

function literalsIn(file, from, to) {
  const found = [];
  for (const s of file.strings.values()) {
    if (s.start >= from && s.start < to) found.push(s);
  }
  return found.sort((a, b) => a.start - b.start);
}

function skipSpace(code, k) {
  while (k < code.length && /\s/.test(code[k])) k++;
  return k;
}

function lowerCamel(snake) {
  return snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// ------------------------------------------------------------ Swift lexer

/**
 * Comments and literal contents blanked (newlines kept, so offsets and lines
 * match the source); each literal keeps a `"` at both ends. Interpolated code
 * stays code. Returns the masked code and a start-offset → literal table.
 */
function lexSwift(src, rel) {
  const out = src.split("");
  const blank = blanker(out);
  const n = src.length;
  const starts = lineStarts(src);
  const strings = new Map();
  const fail = (at, what) => {
    throw new InputError(`${rel}:${lineAt(starts, at)}: ${what}`);
  };

  const scanString = (start, hashes) => {
    const quote = start + hashes;
    const multi = src.startsWith('"""', quote);
    const openLength = multi ? 3 : 1;
    const close = (multi ? '"""' : '"') + "#".repeat(hashes);
    const escape = "\\" + "#".repeat(hashes);
    let k = quote + openLength;
    let segment = k;
    let value = "";
    let interpolated = false;
    for (;;) {
      if (k >= n) fail(start, "unterminated string literal");
      if (!multi && src[k] === "\n") fail(start, "unterminated string literal");
      if (src.startsWith(close, k)) break;
      if (src.startsWith(escape, k)) {
        const after = k + escape.length;
        if (src[after] === "(") {
          interpolated = true;
          blank(segment, after);
          k = scanCode(after + 1, true) + 1;
          segment = k;
          continue;
        }
        value += src.slice(k, after + 1);
        k = after + 1;
        continue;
      }
      value += src[k];
      k++;
    }
    blank(segment, k);
    const end = k + close.length;
    blank(start, quote + openLength);
    out[start] = '"';
    blank(k, end);
    out[end - 1] = '"';
    strings.set(start, { start, end, value, interpolated });
    return end;
  };

  // Scans code from `start`; inside an interpolation, stops at its `)`.
  const scanCode = (start, interpolation) => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        let end = src.indexOf("\n", i);
        if (end < 0) end = n;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        let nesting = 1;
        let j = i + 2;
        while (j < n && nesting > 0) {
          if (src[j] === "/" && src[j + 1] === "*") {
            nesting++;
            j += 2;
          } else if (src[j] === "*" && src[j + 1] === "/") {
            nesting--;
            j += 2;
          } else j++;
        }
        if (nesting > 0) fail(i, "unterminated block comment");
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '"' || c === "#") {
        let hashes = 0;
        while (src[i + hashes] === "#") hashes++;
        if (src[i + hashes] === '"') {
          i = scanString(i, hashes);
          continue;
        }
        i += Math.max(hashes, 1);
        continue;
      }
      if (interpolation) {
        if (c === "(") depth++;
        else if (c === ")") {
          if (depth === 0) return i;
          depth--;
        }
      }
      i++;
    }
    if (interpolation) fail(start, "unterminated string interpolation");
    return n;
  };

  scanCode(0, false);
  return { code: out.join(""), strings, starts };
}

// ----------------------------------------------------------- Swift frames

const TYPE_KEYWORDS = new Set([
  "class",
  "struct",
  "enum",
  "extension",
  "protocol",
  "actor",
]);
const CONTROL_KEYWORDS = new Set([
  "if",
  "guard",
  "for",
  "while",
  "switch",
  "catch",
  "do",
  "else",
  "defer",
  "repeat",
]);
const ACCESSORS = new Set(["get", "set", "willSet", "didSet"]);
const NOT_A_TYPE_NAME = new Set([
  "func",
  "var",
  "let",
  "init",
  "subscript",
  "static",
  "final",
  "override",
]);

/**
 * Every `{…}` of a lexed Swift file, classified: `func` (functions, inits,
 * accessors, computed properties), `type`, `control` (if/guard/switch/…,
 * else, defer, do, catch) or `closure` (anything else). A decl keyword
 * claims the next `{` at its own bracket depth; a `var`/`let` claim ends at
 * `=` or the end of its line.
 */
function buildFrames(code) {
  const tokenRe = /[A-Za-z_]\w*|#[A-Za-z_]\w*|@[A-Za-z_]\w*|\d[\w.]*|\S/g;
  const tokens = [];
  for (let m; (m = tokenRe.exec(code)); ) {
    tokens.push({ t: m[0], p: m.index });
  }
  const isIdent = (s) => /^[A-Za-z_]/.test(s);
  const frames = [];
  const stack = [];
  const pending = new Map();
  const currentFrame = () => {
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s].frame) return stack[s].frame;
    }
    return null;
  };
  const accessorBefore = (k) => {
    let j = k - 1;
    while (j >= 0 && (tokens[j].t === "throws" || tokens[j].t === "async")) {
      j--;
    }
    if (j >= 3 && tokens[j].t === ")" && tokens[j - 2].t === "(") j -= 3;
    if (j < 0 || !ACCESSORS.has(tokens[j].t)) return null;
    if (j > 0 && tokens[j - 1].t === ".") return null;
    return tokens[j].t;
  };

  for (let k = 0; k < tokens.length; k++) {
    const { t, p } = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const depth = stack.length;
    if (prev && code.slice(prev.p + prev.t.length, p).includes("\n")) {
      if (pending.get(depth)?.kind === "var") pending.delete(depth);
    }
    if (isIdent(t)) {
      if (prev && prev.t === ".") continue;
      if (t === "func") {
        const name = next && isIdent(next.t) ? next.t : "";
        pending.set(depth, { kind: "func", name, declPos: p });
      } else if (
        (t === "init" || t === "deinit" || t === "subscript") &&
        next &&
        ["(", "?", "!", "<", "{"].includes(next.t)
      ) {
        pending.set(depth, { kind: "func", name: t, declPos: p });
      } else if (
        TYPE_KEYWORDS.has(t) &&
        next &&
        isIdent(next.t) &&
        !NOT_A_TYPE_NAME.has(next.t)
      ) {
        pending.set(depth, { kind: "type", name: next.t, declPos: p });
      } else if (CONTROL_KEYWORDS.has(t)) {
        pending.set(depth, { kind: "control", name: t, declPos: p });
      } else if ((t === "var" || t === "let") && !pending.has(depth)) {
        const name = next && isIdent(next.t) ? next.t : "";
        pending.set(depth, { kind: "var", name, declPos: p });
      }
      continue;
    }
    if (t === "=" || t === ";") {
      const plainAssign =
        t === ";" ||
        (!"=!<>+-*/%&|^~?.".includes(code[p - 1]) && code[p + 1] !== "=");
      if (plainAssign && pending.get(depth)?.kind === "var") {
        pending.delete(depth);
      }
      continue;
    }
    if (t === "(" || t === "[") {
      stack.push({ p });
      continue;
    }
    if (t === "{") {
      let kind = "closure";
      let name = "";
      let declPos = p;
      const claim = pending.get(depth);
      if (claim) {
        kind = claim.kind === "var" ? "func" : claim.kind;
        name = claim.name;
        declPos = claim.declPos;
        pending.delete(depth);
      } else {
        const accessor = accessorBefore(k);
        if (accessor) {
          kind = "func";
          name = accessor;
        }
      }
      const frame = {
        open: p,
        close: -1,
        kind,
        name,
        declPos,
        parent: currentFrame(),
      };
      frames.push(frame);
      stack.push({ p, frame });
      continue;
    }
    if (t === ")" || t === "]" || t === "}") {
      const top = stack.pop();
      if (t === "}" && top && top.frame) top.frame.close = p;
      for (const d of [...pending.keys()]) {
        if (d > stack.length) pending.delete(d);
      }
    }
  }
  return frames;
}

/** Innermost frame containing `p` that satisfies `keep`. */
function frameAt(file, p, keep = () => true) {
  let best = null;
  for (const f of file.frames) {
    if (f.open < p && p < f.close && keep(f) && (!best || f.open > best.open)) {
      best = f;
    }
  }
  return best;
}

/** Innermost function or closure body around `p` (a type frame = none). */
function bodyAt(file, p) {
  const f = frameAt(file, p, (fr) => fr.kind !== "control");
  return f && f.kind !== "type" ? f : null;
}

/** Nearest enclosing `func` frame of `p`. */
function funcAt(file, p) {
  return frameAt(file, p, (fr) => fr.kind === "func");
}

function ancestors(frame) {
  const chain = [];
  for (let f = frame; f; f = f.parent) chain.push(f);
  return chain;
}

const CLOSURE_HEADER =
  /^\s*(?:@\w+(?:\([^()]*\))?\s*)*(?:\[[^\]]*\]\s*)?(?:\((?:[^()]|\([^()]*\))*\)|[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)?\s*(?:async\s+)?(?:(?:re)?throws\s*)?(?:->\s*[^{}\n]*?)?\s*\bin\b/;

/** Offset of the first statement of a function or closure body. */
function bodyStart(file, frame) {
  let s = frame.open + 1;
  if (frame.kind === "closure") {
    const head = CLOSURE_HEADER.exec(file.code.slice(s, frame.close));
    if (head) s += head[0].length;
  }
  return skipSpace(file.code, s);
}

function startsWithPrecondition(file, frame) {
  const s = bodyStart(file, frame);
  if (!file.code.startsWith(PRECONDITION, s)) return false;
  return /^[ \t]*(?:;|\n|\})/.test(
    file.code.slice(s + PRECONDITION.length, s + PRECONDITION.length + 80),
  );
}

function identEndingAt(code, j) {
  let i = j;
  while (i >= 0 && /\w/.test(code[i])) i--;
  return { name: code.slice(i + 1, j + 1), start: i + 1 };
}

/** Name of the function a closure is passed to (trailing or as an argument). */
function calleeOf(file, frame) {
  const { code, match } = file;
  let j = frame.open - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (code[j] === ")") j = match.get(j) - 1;
  else if (code[j] === "(" || code[j] === "," || code[j] === ":") {
    let depth = 0;
    for (j = frame.open - 1; j >= 0; j--) {
      const c = code[j];
      if (c === ")" || c === "]" || c === "}") depth++;
      else if (c === "(" || c === "[" || c === "{") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j < 0 || code[j] !== "(") return { name: "", start: frame.open };
    j--;
  }
  while (j >= 0 && /\s/.test(code[j])) j--;
  return identEndingAt(code, j);
}

const DEDICATED_HANDOFF = new Set([
  "onDedicatedThread",
  "runOnDedicatedThread",
]);

function onDedicatedThread(file, p, stopAt) {
  for (const f of ancestors(frameAt(file, p))) {
    if (f === stopAt) return false;
    if (f.kind === "closure" && DEDICATED_HANDOFF.has(calleeOf(file, f).name)) {
      return true;
    }
  }
  return false;
}

// --------------------------------------------------------------- TS lexer

const TS_EXPRESSION_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
]);

/** Same contract as lexSwift, for TypeScript (templates, regex literals). */
function lexTs(src, rel) {
  const out = src.split("");
  const blank = blanker(out);
  const n = src.length;
  const starts = lineStarts(src);
  const strings = new Map();
  const fail = (at, what) => {
    throw new InputError(`${rel}:${lineAt(starts, at)}: ${what}`);
  };
  const templates = [];
  let braces = 0;
  let last = "op";

  // From just inside a template (after ` or after an interpolation's }).
  const templateRun = (from, start) => {
    let k = from;
    let value = "";
    for (;;) {
      if (k >= n) fail(start, "unterminated template literal");
      const c = src[k];
      if (c === "\\") {
        value += src.slice(k, k + 2);
        k += 2;
        continue;
      }
      if (c === "`") {
        blank(from, k);
        return { end: k + 1, value, closed: true };
      }
      if (c === "$" && src[k + 1] === "{") {
        blank(from, k);
        return { end: k + 2, value, closed: false };
      }
      value += c;
      k++;
    }
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let end = src.indexOf("\n", i);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) fail(i, "unterminated block comment");
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      let value = "";
      for (;;) {
        if (k >= n || src[k] === "\n") fail(i, "unterminated string literal");
        if (src[k] === "\\") {
          value += src.slice(k, k + 2);
          k += 2;
          continue;
        }
        if (src[k] === c) break;
        value += src[k];
        k++;
      }
      blank(i + 1, k);
      strings.set(i, { start: i, end: k + 1, value, interpolated: false });
      i = k + 1;
      last = "str";
      continue;
    }
    if (c === "`") {
      const run = templateRun(i + 1, i);
      strings.set(i, {
        start: i,
        end: run.closed ? run.end : -1,
        value: run.value,
        interpolated: !run.closed,
      });
      if (!run.closed) {
        templates.push({ depth: braces, start: i });
        braces++;
      }
      i = run.end;
      last = run.closed ? "str" : "op";
      continue;
    }
    if (c === "{") {
      braces++;
      i++;
      last = "op";
      continue;
    }
    if (c === "}") {
      braces--;
      const top = templates[templates.length - 1];
      if (top && top.depth === braces) {
        templates.pop();
        const run = templateRun(i + 1, top.start);
        if (!run.closed) {
          templates.push(top);
          braces++;
        }
        i = run.end;
        last = run.closed ? "str" : "op";
        continue;
      }
      i++;
      last = "}";
      continue;
    }
    if (c === "/") {
      if (["id", "num", ")", "]", "}", "str"].includes(last)) {
        i++;
        last = "op";
        continue;
      }
      let k = i + 1;
      let inClass = false;
      for (;;) {
        if (k >= n || src[k] === "\n") fail(i, "unterminated regex literal");
        const d = src[k];
        if (d === "\\") {
          k += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        k++;
      }
      blank(i + 1, k);
      k++;
      while (k < n && /[a-z]/i.test(src[k])) k++;
      i = k;
      last = "str";
      continue;
    }
    if (/[A-Za-z_$#]/.test(c)) {
      let k = i + 1;
      while (k < n && /[\w$]/.test(src[k])) k++;
      last = TS_EXPRESSION_KEYWORDS.has(src.slice(i, k)) ? "op" : "id";
      i = k;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let k = i + 1;
      while (k < n && /[\w.]/.test(src[k])) k++;
      i = k;
      last = "num";
      continue;
    }
    last = c === ")" || c === "]" ? c : "op";
    i++;
  }
  if (templates.length) fail(templates[0].start, "unterminated template");
  return { code: out.join(""), strings, starts };
}

// ---------------------------------------------------------------- loading

function readText(path, rel) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new InputError(`cannot read ${rel}`);
  }
}

function loadSwift(path, rel) {
  const src = readText(path, rel);
  const lexed = lexSwift(src, rel);
  const match = matchBrackets(lexed.code, rel, lexed.starts);
  const file = { rel, src, ...lexed, match };
  file.frames = buildFrames(lexed.code);
  for (const f of file.frames) {
    if (f.close < 0) throw new InputError(`${rel}: unclosed block`);
  }
  file.line = (p) => lineAt(lexed.starts, p);
  return file;
}

function loadTs(path, rel) {
  const src = readText(path, rel);
  const lexed = lexTs(src, rel);
  const match = matchBrackets(lexed.code, rel, lexed.starts);
  const file = { rel, src, ...lexed, match };
  file.line = (p) => lineAt(lexed.starts, p);
  return file;
}

function parseArgs(argv) {
  const opts = {
    root: dirname(dirname(fileURLToPath(import.meta.url))),
    ...DEFAULTS,
    list: false,
  };
  const keys = {
    "--root": "root",
    "--sources": "sources",
    "--bindings": "bindings",
    "--fe": "fe",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") {
      opts.list = true;
      continue;
    }
    const key = keys[argv[i]];
    if (!key || i + 1 >= argv.length) {
      throw new InputError(`bad argument: ${argv[i]}`);
    }
    opts[key] = argv[++i];
  }
  const at = (p) => (isAbsolute(p) ? p : join(opts.root, p));
  return {
    root: opts.root,
    list: opts.list,
    sources: at(opts.sources),
    bindings: at(opts.bindings),
    fe: at(opts.fe),
  };
}

// ------------------------------------------------------- E2eeCommands.swift

function arrayLiteral(file, re, what) {
  const m = re.exec(file.code);
  if (!m) throw new InputError(`${file.rel}: ${what} not found`);
  const open = m.index + m[0].length - 1;
  return { open, close: file.match.get(open) };
}

/** Non-blank lines strictly inside an array literal, with their offsets. */
function arrayLines(file, { open, close }) {
  const lines = [];
  let offset = open + 1;
  for (const text of file.code.slice(open + 1, close).split("\n")) {
    if (text.trim()) lines.push({ text, p: offset });
    offset += text.length + 1;
  }
  return lines;
}

function parseCommands(file, add) {
  const entries = [];
  const shape =
    /^\s*\(\s*"\s*"\s*,\s*\.(generic|native|out|dedicated\s*\(\s*"\s*"\s*\))\s*\)\s*,\s*$/;
  const table = arrayLiteral(
    file,
    /\bstatic\s+let\s+table\s*:[^=]*=\s*\[/,
    "E2eeCommands.table",
  );
  for (const { text, p } of arrayLines(file, table)) {
    const raw = file.src.slice(p, p + text.length).trim();
    const m = shape.exec(text);
    const lits = m ? literalsIn(file, p, p + text.length) : [];
    const bad = (why) => add("G6-table-shape", file, p, `${why}: ${raw}`);
    if (!m) {
      bad(
        'table line is not `("e2ee_x", .generic|.native|.out|.dedicated("m")),`',
      );
      continue;
    }
    const [name, method] = lits;
    if (name.interpolated || !/^e2ee_[a-z0-9_]+$/.test(name.value)) {
      bad("table name is not a plain e2ee_ literal");
      continue;
    }
    const route = m[1].startsWith("dedicated") ? "dedicated" : m[1];
    if (
      route === "dedicated" &&
      (method.interpolated || !/^[a-z][A-Za-z0-9]*$/.test(method.value))
    ) {
      bad("dedicated method is not a plain identifier literal");
      continue;
    }
    entries.push({
      name: name.value,
      route,
      method: route === "dedicated" ? method.value : null,
      p,
    });
  }

  const methods = [];
  const list = arrayLiteral(
    file,
    /\bstatic\s+let\s+dedicatedMethods\s*:[^=]*=\s*\[/,
    "E2eeCommands.dedicatedMethods",
  );
  for (const { text, p } of arrayLines(file, list)) {
    const lits = literalsIn(file, p, p + text.length);
    if (!/^\s*"\s*"\s*,\s*$/.test(text) || lits[0].interpolated) {
      add(
        "G6-table-shape",
        file,
        p,
        `dedicatedMethods line is not \`"m",\`: ${file.src.slice(p, p + text.length).trim()}`,
      );
      continue;
    }
    methods.push({ name: lits[0].value, p });
  }

  const counts = {};
  for (const k of ["generic", "native", "dedicated", "out"]) {
    const m = new RegExp(
      `\\bstatic\\s+let\\s+${k}Count\\s*=\\s*(\\d+)\\b`,
    ).exec(file.code);
    counts[k] = m ? { value: Number(m[1]), p: m.index } : null;
  }
  return { entries, methods, counts };
}

function checkTable(file, parsed, add) {
  const byName = new Map();
  for (const e of parsed.entries) {
    if (byName.has(e.name)) {
      add("G6-table-duplicate", file, e.p, `${e.name} is listed twice`);
      continue;
    }
    byName.set(e.name, e);
  }
  const ofRoute = (r) => parsed.entries.filter((e) => e.route === r);
  for (const k of ["generic", "native", "dedicated", "out"]) {
    const actual = ofRoute(k).length;
    const stat = parsed.counts[k];
    if (!stat) {
      add("G6-count", file, null, `static let ${k}Count not found`);
    } else if (stat.value !== actual) {
      add(
        "G6-count",
        file,
        stat.p,
        `${k}Count = ${stat.value} but the table has ${actual} .${k} lines`,
      );
    }
    if (has(COUNTS, k) && actual !== COUNTS[k]) {
      add(
        "G6-count",
        file,
        null,
        `the table has ${actual} .${k} lines; the contract pins ${COUNTS[k]}`,
      );
    }
  }

  const sameSet = (route, expected) => {
    const got = new Set(ofRoute(route).map((e) => e.name));
    for (const name of expected) {
      if (!got.has(name)) {
        const e = byName.get(name);
        add(
          "G6-table-route",
          file,
          e ? e.p : null,
          `${name} must be .${route}${e ? `, is .${e.route}` : ", is missing"}`,
        );
      }
    }
    for (const e of ofRoute(route)) {
      if (!expected.includes(e.name)) {
        add(
          "G6-table-route",
          file,
          e.p,
          `${e.name} is .${route}; the contract does not route it so`,
        );
      }
    }
  };
  sameSet("generic", GENERIC);
  sameSet("native", NATIVE);
  sameSet("dedicated", Object.keys(DEDICATED));
  for (const e of ofRoute("dedicated")) {
    if (DEDICATED[e.name] && DEDICATED[e.name] !== e.method) {
      add(
        "G6-table-route",
        file,
        e.p,
        `${e.name} must be .dedicated("${DEDICATED[e.name]}"), is .dedicated("${e.method}")`,
      );
    }
  }
  for (const e of parsed.entries) {
    if (OUT_COMMAND.test(e.name) && e.route !== "out") {
      add(
        "G8a-route",
        file,
        e.p,
        `${e.name} is .${e.route}; call/mls/rc names are .out`,
      );
    }
  }

  const listed = parsed.methods.map((m) => m.name);
  if (listed.join(",") !== DEDICATED_METHODS.join(",")) {
    add(
      "G6-dedicated-order",
      file,
      parsed.methods[0]?.p ?? null,
      `dedicatedMethods is [${listed.join(", ")}]; the contract order is [${DEDICATED_METHODS.join(", ")}]`,
    );
  }
  for (const e of ofRoute("dedicated")) {
    if (!listed.includes(e.method)) {
      add(
        "G6-dedicated-method",
        file,
        e.p,
        `${e.name} routes to ${e.method}, which dedicatedMethods lacks`,
      );
    }
  }
  return byName;
}

// --------------------------------------------------------------- bindings

function parseBindings(file, add) {
  const cls = file.frames.find(
    (f) =>
      f.kind === "type" &&
      f.name === "E2eeEngine" &&
      file.code.startsWith("class", f.declPos),
  );
  if (!cls) throw new InputError(`${file.rel}: class E2eeEngine not found`);
  const methods = new Map();
  for (const f of file.frames) {
    if (f.kind !== "func" || f.parent !== cls) continue;
    const head = file.code.slice(
      file.code.lastIndexOf("\n", f.declPos) + 1,
      f.declPos,
    );
    if (!/\bopen\b/.test(head)) continue;
    const body = file.code.slice(f.open, f.close);
    const symbols = new Set(
      [...body.matchAll(/\buniffi_\w+?_fn_method_e2eeengine_(\w+?)\s*\(/g)].map(
        (m) => m[1],
      ),
    );
    const snake = symbols.size === 1 ? [...symbols][0] : null;
    methods.set(f.name, { name: f.name, snake, p: f.declPos });
    if (!snake) {
      add(
        "G6-generic-binding",
        file,
        f.declPos,
        `E2eeEngine.${f.name} has no single uniffi method symbol`,
      );
    } else if (lowerCamel(snake) !== f.name) {
      add(
        "G6-generic-binding",
        file,
        f.declPos,
        `E2eeEngine.${f.name} wraps ${snake}; the binding rule gives ${lowerCamel(snake)}`,
      );
    }
  }
  const proto = file.frames.find(
    (f) => f.kind === "type" && f.name === "E2eeEngineProtocol",
  );
  if (proto) {
    const declared = new Set(
      [
        ...file.code
          .slice(proto.open, proto.close)
          .matchAll(/\bfunc\s+(\w+)\s*\(/g),
      ].map((m) => m[1]),
    );
    const exported = new Set(methods.keys());
    for (const name of declared) {
      if (!exported.has(name)) {
        add(
          "G6-generic-binding",
          file,
          proto.declPos,
          `E2eeEngineProtocol.${name} has no open func in the class`,
        );
      }
    }
    for (const name of exported) {
      if (!declared.has(name)) {
        add(
          "G6-generic-binding",
          file,
          methods.get(name).p,
          `E2eeEngine.${name} is not in E2eeEngineProtocol`,
        );
      }
    }
  } else {
    add(
      "G6-generic-binding",
      file,
      null,
      "protocol E2eeEngineProtocol not found",
    );
  }

  // G8a: nothing call/mls/rc-shaped is exported at all.
  const seen = new Set();
  for (const m of file.code.matchAll(
    /\bfunc\s+((?:call|mls|rc)[A-Z0-9]\w*|pinCallIdentities)\s*[(<]/g,
  )) {
    seen.add(file.line(m.index));
    add("G8a-export", file, m.index, `the bindings export ${m[1]}`);
  }
  for (const m of file.code.matchAll(OUT_FFI_SYMBOL)) {
    const line = file.line(m.index);
    if (seen.has(line)) continue;
    seen.add(line);
    add(
      "G8a-export",
      file,
      m.index,
      `the bindings carry uniffi symbol ${m[0]}`,
    );
  }
  for (const method of methods.values()) {
    if (OUT_EXPORT_NAME.test(method.name)) {
      add("G8a-export", file, method.p, `E2eeEngine exports ${method.name}`);
    }
  }
  return methods;
}

// ------------------------------------------------------- engine values (G7)

const ENGINE_TYPES = ["E2eeEngine", "E2eeEngineProtocol"];

function engineModel(files) {
  const types = new Set(ENGINE_TYPES);
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of files) {
      for (const m of f.code.matchAll(
        /\btypealias\s+(\w+)\s*=\s*(?:any\s+)?(\w+)/g,
      )) {
        if (types.has(m[2]) && !types.has(m[1])) {
          types.add(m[1]);
          changed = true;
        }
      }
    }
  }
  const T = `(?:any\\s+|some\\s+)?(?:${[...types].join("|")})\\b`;
  const factories = new Set();
  const names = new Set();
  for (const f of files) {
    for (const m of f.code.matchAll(/\bfunc\s+(\w+)\s*(?:<[^>{]*>)?\s*\(/g)) {
      const close = f.match.get(m.index + m[0].length - 1);
      const tail = f.code.slice(close + 1, close + 200);
      if (
        new RegExp(
          `^\\s*(?:async\\s+)?(?:(?:re)?throws\\s+)?->\\s*${T}\\s*[?!]?\\s*(?:\\{|where\\b|$)`,
          "m",
        ).test(tail)
      ) {
        factories.add(m[1]);
      }
    }
    for (const m of f.code.matchAll(
      new RegExp(
        `\\b(\\w+)\\s*:\\s*(?:@escaping\\s+)?\\(*\\s*\\([^()]*\\)\\s*(?:async\\s+)?(?:throws\\s+)?->\\s*${T}`,
        "g",
      ),
    )) {
      factories.add(m[1]);
    }
    for (const m of f.code.matchAll(
      new RegExp(`\\b(\\w+)\\s*:\\s*${T}(?!\\s*\\()`, "g"),
    )) {
      names.add(m[1]);
    }
  }
  // `let x = <engine>` / `let p = <factory value>`, to a fixpoint.
  const classify = (f, at) => {
    const head =
      /^(?:(?:try|await)[?!]?\s+)*((?:[A-Za-z_]\w*\s*(?:\(\s*\))?\s*[?!]?\s*\.\s*)*)([A-Za-z_]\w*)/.exec(
        f.code.slice(at, at + 300),
      );
    if (!head) return null;
    const last = head[2];
    let k = at + head[0].length;
    while (k < f.code.length && (f.code[k] === " " || f.code[k] === "\t")) k++;
    let called = false;
    if (f.code[k] === "(") {
      called = true;
      k = f.match.get(k) + 1;
    }
    if (/^\s*[?!]?\s*\./.test(f.code.slice(k, k + 40))) return null;
    if (called && (factories.has(last) || types.has(last))) return "engine";
    if (!called && names.has(last)) return "engine";
    if (!called && factories.has(last)) return "factory";
    return null;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of files) {
      for (const m of f.code.matchAll(
        /\b(?:let|var)\s+(\w+)\s*(?::[^=\n]*)?=(?!=)\s*/g,
      )) {
        const kind = classify(f, m.index + m[0].length);
        const into =
          kind === "engine" ? names : kind === "factory" ? factories : null;
        if (into && !into.has(m[1])) {
          into.add(m[1]);
          changed = true;
        }
      }
    }
  }
  return { types, factories, names };
}

/** Engine calls in one file: `{p, member, memberPos}`. */
function engineCalls(f, model) {
  const calls = [];
  const seen = new Set();
  const push = (p, member, memberPos) => {
    if (seen.has(memberPos)) return;
    seen.add(memberPos);
    calls.push({ p, member, memberPos });
  };
  for (const m of f.code.matchAll(
    /\b([A-Za-z_]\w*)(?=(\s*[?!]?\s*\.\s*)([A-Za-z_]\w*))/g,
  )) {
    if (model.names.has(m[1])) {
      push(m.index, m[3], m.index + m[1].length + m[2].length);
    }
  }
  for (const m of f.code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (!model.factories.has(name) && !model.types.has(name)) continue;
    if (/\bfunc\s+$/.test(f.code.slice(Math.max(0, m.index - 20), m.index))) {
      continue;
    }
    const open = m.index + m[0].length - 1;
    const close = f.match.get(open);
    if (model.types.has(name)) {
      push(m.index, "<init>", m.index);
      continue;
    }
    const after = /^(\s*[?!]?\s*\.\s*)([A-Za-z_]\w*)/.exec(
      f.code.slice(close + 1, close + 200),
    );
    if (after) push(m.index, after[2], close + 1 + after[1].length);
  }
  for (const m of f.code.matchAll(
    new RegExp(
      `\\b(${[...model.types].join("|")})\\s*\\.\\s*([A-Za-z_]\\w*)`,
      "g",
    ),
  )) {
    if (m[2] === "self" || m[2] === "Type") continue;
    push(m.index, m[2], m.index + m[0].length - m[2].length);
  }
  return calls.sort((a, b) => a.p - b.p);
}

function checkUntracked(f, model, add) {
  const re = new RegExp(`\\b(?:${[...model.types].join("|")})\\b`, "g");
  for (const m of f.code.matchAll(re)) {
    const p = m.index;
    const before = f.code.slice(Math.max(0, p - 60), p);
    const after = f.code.slice(p + m[0].length, p + m[0].length + 8);
    if (/^\s*\(/.test(after)) continue;
    const prev = before.trimEnd().slice(-1);
    if (/\bextension\s+$/.test(before)) {
      add(
        "G7-engine-untracked",
        f,
        p,
        `extension of ${m[0]}: calls inside it cannot be followed`,
      );
    } else if (/\b(?:as|is)\s*[?!]?\s*$/.test(before)) {
      add(
        "G7-engine-untracked",
        f,
        p,
        `cast to ${m[0]}: the value cannot be followed`,
      );
    } else if ("(,<[".includes(prev) || /^\s*[?!]?\s*[\]>]/.test(after)) {
      add(
        "G7-engine-untracked",
        f,
        p,
        `${m[0]} inside a tuple, collection, generic or function type: the value cannot be followed`,
      );
    }
  }
  for (const fr of f.frames) {
    if (fr.kind !== "type") continue;
    const head = f.code.slice(fr.declPos, fr.open);
    if (
      new RegExp(`:[^{]*\\b(?:${[...model.types].join("|")})\\b`).test(head)
    ) {
      add(
        "G7-engine-untracked",
        f,
        fr.declPos,
        `type ${fr.name} inherits from an engine type`,
      );
    }
  }
}

// ------------------------------------------------------------ the checks

function caseArms(file, sw) {
  const arms = [];
  const re = /\b(case|default)\b/g;
  re.lastIndex = sw.open + 1;
  for (let m; (m = re.exec(file.code)) && m.index < sw.close; ) {
    if (frameAt(file, m.index) !== sw) continue;
    const before = file.code.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:\b(?:if|guard|while|for)\s*|,\s*)$/.test(before)) continue;
    let j = m.index + m[1].length;
    let depth = 0;
    for (; j < sw.close; j++) {
      const c = file.code[j];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === ":" && depth === 0) break;
    }
    const label = file.code.slice(m.index + m[1].length, j);
    const literalOnly =
      m[1] === "case" && /^\s*"\s*"(?:\s*,\s*"\s*")*\s*$/.test(label);
    const names = literalOnly
      ? literalsIn(file, m.index, j).map((s) =>
          s.interpolated ? null : s.value,
        )
      : [];
    arms.push({ kind: m[1], p: m.index, body: j + 1, names, literalOnly });
  }
  arms.forEach((a, i) => {
    a.end = i + 1 < arms.length ? arms[i + 1].p : sw.close;
  });
  return arms;
}

function switchOn(file, fn, subject) {
  return file.frames.find(
    (f) =>
      f.kind === "control" &&
      f.name === "switch" &&
      funcAt(file, f.open) === fn &&
      new RegExp(`^switch\\s+${subject}\\s*$`).test(
        file.code.slice(f.declPos, f.open).trim(),
      ),
  );
}

function onlyFunc(file, name) {
  const found = file.frames.filter((f) => f.kind === "func" && f.name === name);
  if (found.length !== 1) {
    throw new InputError(
      `${file.rel}: expected one func ${name}, found ${found.length}`,
    );
  }
  return found[0];
}

function literalArg(file, from, to, call) {
  const re = new RegExp(`\\b${call}\\s*\\(\\s*(?=")`, "g");
  re.lastIndex = from;
  const values = [];
  for (let m; (m = re.exec(file.code)) && m.index < to; ) {
    const s = file.strings.get(m.index + m[0].length);
    if (s && !s.interpolated) values.push(s.value);
  }
  return values;
}

/**
 * True when the call whose `(` is at `open` names its command statically: a
 * plain e2ee_ literal, or `cond ? "e2ee_a" : "e2ee_b"`.
 */
function staticCommand(fe, open) {
  if (fe.code[open] !== "(") return false;
  let end = open + 1;
  for (let depth = 0; end < fe.code.length; end++) {
    const c = fe.code[end];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  const lits = literalsIn(fe, open + 1, end);
  if (
    !lits.length ||
    lits.some((s) => s.interpolated || !/^e2ee_[a-z0-9_]+$/.test(s.value))
  ) {
    return false;
  }
  // Each literal becomes one backtick, so only the shape around them is
  // left (no other backtick can remain: a template is a literal here, or it
  // is interpolated and already refused above).
  let shape = "";
  let at = open + 1;
  for (const s of lits) {
    shape += fe.code.slice(at, s.start) + "`";
    at = s.end;
  }
  shape += fe.code.slice(at, end);
  return /^\s*`\s*$/.test(shape) || /^[^"'`?:]*\?\s*`\s*:\s*`\s*$/.test(shape);
}

// --------------------------------------------- G8b reachability call graph

const RECOVERY_CREATE = [
  "recoveryOpen",
  "recoveryClosed",
  "recoveryCreate",
  "recoveryRotate",
  "recoveryFinish",
  "backupTakePendingUpload",
];
const RECOVERY_RESTORE = [
  "recoveryOpen",
  "recoveryClosed",
  "recoveryRestore",
  "recoveryFinish",
  "backupTakePendingRepublish",
];
/** Root → the native-only methods it may reach. Any other root: none. */
const ROOT_MAY_REACH = {
  "E2eePlugin.backupCreate(_:)": RECOVERY_CREATE,
  "E2eePlugin.backupRotate(_:)": RECOVERY_CREATE,
  "E2eePlugin.backupRestore(_:)": RECOVERY_RESTORE,
  "E2eePlugin.attachmentUpload(_:)": ["attachmentCiphertext"],
  "E2eePlugin.attachmentFetch(_:)": ["attachmentStore"],
  "E2eePlugin.nativeJob[e2ee_attachment_copy_image]": ["attachmentForExport"],
  "E2eePlugin.nativeJob[e2ee_attachment_save]": [
    "attachmentExportName",
    "attachmentForExport",
  ],
  "AttachmentSchemeHandler.webView(_:start:)": ["serveAttachmentForRender"],
  "SlogaBridgeViewController.webViewConfiguration(for:)": [
    "serveAttachmentForRender",
  ],
};
/**
 * Every function (graph node) that can reach a native-only method, from a
 * root or not. Pinned so a closure captured at setup and called later, which
 * root reachability cannot see, still has to be listed here to exist.
 */
const NATIVE_ONLY_CALLERS = [
  "AttachmentSchemeHandler.init(decrypt:)",
  "serveFromEngine(_:_:)",
  "SlogaBridgeViewController.webViewConfiguration(for:)",
  "AttachmentTransfer.upload(localId:url:authHeader:authValue:recipientsJson:)",
  "AttachmentTransfer.fetch(localId:url:authHeader:authValue:)",
  "AttachmentTransfer.copyImage(messageId:idx:)",
  "AttachmentTransfer.save(messageId:idx:)",
  "E2eePlugin.attachmentUpload(_:)",
  "E2eePlugin.attachmentFetch(_:)",
  "E2eePlugin.backupCreate(_:)",
  "E2eePlugin.backupRotate(_:)",
  "E2eePlugin.backupRestore(_:)",
  "E2eePlugin.nativeJob[e2ee_attachment_copy_image]",
  "E2eePlugin.nativeJob[e2ee_attachment_save]",
  "RecoverySheet.runCreateOrRotate(rotate:userId:)",
  "RecoverySheet.runRestore(userId:blobsJson:)",
  "RecoverySheet.createLoop(_:flow:mode:generation:)",
  "RecoverySheet.restoreLoop(_:flow:generation:)",
  "RecoverySheet.openFlow(_:mode:userId:blobsJson:)",
  "RecoverySheet.mintCode(_:rotate:)",
  "RecoverySheet.restoreWithCode(_:code:)",
  "RecoverySheet.finishFlow(_:)",
  "RecoverySheet.closeFlow(_:generation:)",
  "RecoverySheet.courierUpload(_:flow:outcome:mode:)",
  "RecoverySheet.forgetMintedState(_:)",
  "RecoverySheet.takeRepublish(_:)",
];
/** Native export entry points: every function-level return is one of these. */
const FIXED_RESOLVES = {
  "AttachmentTransfer.copyImage(messageId:idx:)": ["null"],
  "AttachmentTransfer.save(messageId:idx:)": ["true", "false"],
};
/** Extra names a generic arm may return besides its own engine call. */
const ARM_RETURN_EXTRAS = { e2ee_backup_refresh_if_due: ["orphaned"] };

function subtractRanges(ranges, cut) {
  const out = [];
  for (const [a, b] of ranges) {
    if (cut[1] <= a || cut[0] >= b) out.push([a, b]);
    else {
      if (a < cut[0]) out.push([a, cut[0]]);
      if (cut[1] < b) out.push([cut[1], b]);
    }
  }
  return out;
}

/** `(label:label:)` of a func/init declaration at `declPos`, "" for none. */
function selectorOf(file, declPos) {
  const head =
    /^(?:func\s+\w+|init\s*[?!]?|subscript)\s*(?:<[^>{]*>)?\s*\(/.exec(
      file.code.slice(declPos, declPos + 300),
    );
  if (!head) return "";
  const open = declPos + head[0].length - 1;
  const params = file.code.slice(open + 1, file.match.get(open));
  const labels = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= params.length; i++) {
    const c = params[i];
    if (c === "(" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "]" || (c === ">" && params[i - 1] !== "-")) {
      depth--;
    } else if ((c === "," && depth === 0) || i === params.length) {
      const label = /^\s*(?:@\w+\s+)*([A-Za-z_]\w*)/.exec(
        params.slice(start, i),
      );
      if (label) labels.push(`${label[1]}:`);
      start = i + 1;
    }
  }
  return `(${labels.join("")})`;
}

/** End of a stored property's initializer starting at `from` (after `=`). */
function initializerEnd(code, match, from) {
  let k = skipSpace(code, from);
  while (k < code.length) {
    const c = code[k];
    if (c === "(" || c === "[" || c === "{") {
      k = match.get(k) + 1;
      continue;
    }
    if (c === ")" || c === "]" || c === "}" || c === ";") return k;
    if (c === "\n") {
      const next = skipSpace(code, k);
      if (!".+-*/?:&|".includes(code[next])) return k;
      k = next;
      continue;
    }
    k++;
  }
  return k;
}

function buildGraph(ctx) {
  const { swift, plugin, runGeneric, armNames, nativeJob, nativeArms } = ctx;
  const nodes = [];
  const typeAt = (f, p) =>
    frameAt(f, p, (fr) => fr.kind === "type")?.name ?? null;
  const callable = (fr) => fr.kind === "func" && !ACCESSORS.has(fr.name);
  const byFrame = new Map();
  const types = new Set();

  for (const f of swift) {
    for (const t of f.frames) if (t.kind === "type") types.add(t.name);
    for (const fr of f.frames) {
      if (!callable(fr)) continue;
      let ranges = [[fr.declPos, fr.close + 1]];
      for (const inner of f.frames) {
        if (
          inner !== fr &&
          callable(inner) &&
          inner.declPos > fr.declPos &&
          inner.close < fr.close
        ) {
          ranges = subtractRanges(ranges, [inner.declPos, inner.close + 1]);
        }
      }
      const type = typeAt(f, fr.declPos);
      const node = {
        id: `${type ? `${type}.` : ""}${fr.name}${selectorOf(f, fr.declPos)}`,
        name: fr.name,
        type,
        file: f,
        p: fr.declPos,
        ranges,
        frame: fr,
      };
      nodes.push(node);
      byFrame.set(fr, node);
    }
    // Stored-property initializers outside any function.
    for (const m of f.code.matchAll(/\b(?:let|var)\s+([A-Za-z_]\w*)\b/g)) {
      if (funcAt(f, m.index)) continue;
      let k = m.index + m[0].length;
      let start = -1;
      while (k < f.code.length) {
        const c = f.code[k];
        if (c === "(" || c === "[") k = f.match.get(k) + 1;
        else if (c === "=" && f.code[k + 1] !== "=") {
          start = k + 1;
          break;
        } else if (c === "{" || c === "\n" || c === ";") break;
        else k++;
      }
      if (start < 0) continue;
      const type = typeAt(f, m.index);
      nodes.push({
        id: `${type ? `${type}.` : ""}${m[1]}`,
        name: m[1],
        type,
        file: f,
        p: m.index,
        ranges: [[start, initializerEnd(f.code, f.match, start)]],
      });
    }
  }

  // One node per generic and native arm; the switch owners keep the rest.
  const armNodes = (owner, arms, label) => {
    const node = byFrame.get(owner);
    return arms.map((a) => {
      node.ranges = subtractRanges(node.ranges, [a.body, a.end]);
      const arm = {
        id: `E2eePlugin.${label}[${a.names[0] ?? "?"}]`,
        name: null,
        type: "E2eePlugin",
        file: plugin,
        p: a.p,
        ranges: [[a.body, a.end]],
        arm: a.names[0],
      };
      nodes.push(arm);
      return arm;
    });
  };
  const genericArmNodes = armNodes(
    runGeneric,
    [...armNames.values()],
    "runGeneric",
  );
  const nativeArmNodes = armNodes(nativeJob, nativeArms, "nativeJob");
  const dispatchers = new Map([
    [byFrame.get(runGeneric), genericArmNodes],
    [byFrame.get(nativeJob), nativeArmNodes],
  ]);
  const callNode = byFrame.get(ctx.objc.get("call")?.frame);

  const byName = new Map();
  for (const n of nodes) {
    if (!n.name) continue;
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name).push(n);
  }
  const ofType = (type, name) =>
    (byName.get(name) ?? []).filter((n) => n.type === type);
  const NOT_A_USE =
    /\b(?:func|let|var|case|class|struct|enum|extension|protocol|typealias)\s+$/;
  // Class → its first inherited name, when that is a type of these sources.
  const superclasses = new Map();
  for (const f of swift) {
    for (const t of f.frames) {
      if (t.kind !== "type" || !f.code.startsWith("class", t.declPos)) continue;
      const first = /:\s*([A-Za-z_]\w*)/.exec(f.code.slice(t.declPos, t.open));
      if (first && types.has(first[1])) superclasses.set(t.name, first[1]);
    }
  }

  // Edges: every reference to a function or property name, resolved by name.
  for (const n of nodes) {
    const out = new Set();
    const code = n.file.code;
    for (const [a, b] of n.ranges) {
      const re = /\b[A-Za-z_]\w*\b/g;
      re.lastIndex = a;
      for (let m; (m = re.exec(code)) && m.index < b; ) {
        const name = m[0];
        const after = code.slice(
          m.index + name.length,
          m.index + name.length + 12,
        );
        const before = code.slice(Math.max(0, m.index - 60), m.index);
        if (types.has(name)) {
          if (/^\s*(?:\(|\.\s*init\b)/.test(after)) {
            for (const t of ofType(name, "init")) out.add(t);
          }
          continue;
        }
        if (!byName.has(name)) continue;
        if (/^\s*:(?!:)/.test(after) || NOT_A_USE.test(before)) continue;
        let targets;
        const dotted = /\.\s*$/.test(before);
        const receiver = /([A-Za-z_]\w*)\s*[?!]?\s*\.\s*$/.exec(before)?.[1];
        if (dotted && receiver === "super") {
          // Only a superclass declared in these sources has code here; an
          // SDK superclass's own method is not ours (no fallback).
          const parent = superclasses.get(n.type);
          for (const t of parent ? ofType(parent, name) : []) out.add(t);
          continue;
        } else if (dotted && (receiver === "self" || receiver === "Self")) {
          targets = ofType(n.type, name);
        } else if (dotted && receiver && types.has(receiver)) {
          targets = ofType(receiver, name);
        } else if (dotted) {
          targets = byName.get(name);
        } else {
          targets = [...ofType(n.type, name), ...ofType(null, name)];
        }
        if (!targets.length) targets = byName.get(name);
        for (const t of targets) {
          if (dispatchers.has(t)) {
            if (n === callNode) continue;
            for (const arm of dispatchers.get(t)) out.add(arm);
          }
          out.add(t);
        }
      }
    }
    out.delete(n);
    n.edges = [...out];
    n.sinks = new Set();
    for (const [a, b] of n.ranges) {
      const text = code.slice(a, b);
      for (const method of Object.keys(NATIVE_ONLY)) {
        if (new RegExp(`\\b${method}\\b`).test(text)) n.sinks.add(method);
      }
    }
  }

  // Roots: the plugin's entries (call split into its arms) and every
  // method WebKit or Capacitor calls into.
  const roots = [];
  const addRoot = (n) => n && !roots.includes(n) && roots.push(n);
  addRoot(callNode);
  addRoot(byFrame.get(runGeneric));
  addRoot(byFrame.get(nativeJob));
  genericArmNodes.forEach(addRoot);
  nativeArmNodes.forEach(addRoot);
  for (const [name, o] of ctx.objc)
    if (name !== "call") addRoot(byFrame.get(o.frame));
  for (const n of nodes) {
    if (n.name === "webView" || n.name === "userContentController") addRoot(n);
    if (!n.frame) continue;
    const type = frameAt(n.file, n.p, (fr) => fr.kind === "type");
    // The NativeConfirm callback: core calls it during webview commands.
    if (
      n.name === "confirm" &&
      type &&
      /:[^{]*\bNativeConfirm\b/.test(n.file.code.slice(type.declPos, type.open))
    ) {
      addRoot(n);
    }
    const head = n.file.code.slice(n.file.code.lastIndexOf("\n", n.p) + 1, n.p);
    if (
      type &&
      /:\s*[^{]*\bCAP\w+/.test(n.file.code.slice(type.declPos, type.open)) &&
      /\boverride\b/.test(head)
    ) {
      addRoot(n);
    }
  }
  return { nodes, roots };
}

/** Shortest path from `from` to a node satisfying `goal`, as a node list. */
function pathTo(from, goal) {
  const parent = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const n = queue.shift();
    if (goal(n)) {
      const path = [];
      for (let x = n; x; x = parent.get(x)) path.unshift(x);
      return path;
    }
    for (const e of n.edges) {
      if (!parent.has(e)) {
        parent.set(e, n);
        queue.push(e);
      }
    }
  }
  return null;
}

function checkReach(ctx, add) {
  const { nodes, roots } = buildGraph(ctx);
  const show = (path, method) =>
    `${path.map((n) => n.id).join(" -> ")} -> ${method}`;

  // (a) From each root, only the native-only methods that root may reach.
  for (const root of roots) {
    const allowed = has(ROOT_MAY_REACH, root.id) ? ROOT_MAY_REACH[root.id] : [];
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
      const n = queue.shift();
      for (const e of n.edges) {
        if (!seen.has(e)) {
          seen.add(e);
          queue.push(e);
        }
      }
    }
    const reported = new Set();
    for (const n of seen) {
      for (const method of n.sinks) {
        if (allowed.includes(method) || reported.has(method)) continue;
        reported.add(method);
        const path = pathTo(root, (x) => x.sinks.has(method));
        add(
          "G8b-reach",
          root.file,
          root.p,
          `${show(path, method)} (root may reach: ${allowed.join(", ") || "none"})`,
        );
      }
    }
  }

  // (b) Every function that can reach a native-only method is pinned.
  const reaches = new Set(nodes.filter((n) => n.sinks.size));
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes) {
      if (!reaches.has(n) && n.edges.some((e) => reaches.has(e))) {
        reaches.add(n);
        changed = true;
      }
    }
  }
  for (const n of reaches) {
    if (NATIVE_ONLY_CALLERS.includes(n.id)) continue;
    const path = pathTo(n, (x) => x.sinks.size > 0);
    const last = path[path.length - 1];
    add(
      "G8b-reach",
      n.file,
      n.p,
      `${show(path, [...last.sinks].join("|"))} (not a listed native-only caller)`,
    );
  }
  for (const id of NATIVE_ONLY_CALLERS) {
    if (![...reaches].some((n) => n.id === id)) {
      add(
        "G8b-reach",
        null,
        null,
        `listed native-only caller ${id} not found or reaches nothing; update the list`,
      );
    }
  }

  // (c) What those paths can hand back to the webview.
  const returnsIn = (n, owner) => {
    const found = [];
    const code = n.file.code;
    for (const [a, b] of n.ranges) {
      const re = /\breturn\b/g;
      re.lastIndex = a;
      for (let m; (m = re.exec(code)) && m.index < b; ) {
        if (bodyAt(n.file, m.index) !== owner) continue;
        const end = initializerEnd(code, n.file.match, m.index + 6);
        found.push({ p: m.index, from: m.index + 6, to: end });
      }
    }
    return found;
  };
  for (const n of nodes) {
    if (!has(FIXED_RESOLVES, n.id)) continue;
    const fixed = FIXED_RESOLVES[n.id];
    for (const r of returnsIn(n, n.frame)) {
      const expr = n.file.code.slice(r.from, r.to).trim();
      const lit = n.file.strings.get(skipSpace(n.file.code, r.from));
      if (!/^"\s*"$/.test(expr) || !lit || !fixed.includes(lit.value)) {
        add(
          "G8b-return",
          n.file,
          r.p,
          `${n.id} may only return ${fixed.map((v) => `"${v}"`).join(" or ")}`,
        );
      }
    }
  }
  for (const id of Object.keys(FIXED_RESOLVES)) {
    if (!nodes.some((n) => n.id === id)) {
      add(
        "G8b-return",
        null,
        null,
        `pinned native export ${id} not found; update FIXED_RESOLVES`,
      );
    }
  }
  const readers = new Set(
    ctx.plugin.frames
      .filter(
        (f) =>
          f.kind === "func" &&
          frameAt(ctx.plugin, f.declPos, (t) => t.kind === "type")?.name ===
            "E2eeCallArgs",
      )
      .map((f) => f.name),
  );
  const runGenericFrame = ctx.runGeneric;
  for (const n of nodes) {
    if (!n.arm || n.id.indexOf("runGeneric[") < 0) continue;
    const own = ctx.targetOf(n.arm)?.name;
    for (const r of returnsIn(n, runGenericFrame)) {
      const code = n.file.code;
      // Cut `engine.<own>(…)` (its arguments go INTO the engine; only its
      // result comes out) and `args.<reader>(…)`; whatever is left must be
      // plumbing (try, jsonQuote, map, literals) or a pinned extra.
      const cuts = [];
      const span = new RegExp(
        `\\b(?:engine\\s*\\.\\s*${own ?? "\\b_never_\\b"}|args\\s*\\.\\s*(\\w+))\\s*\\(`,
        "g",
      );
      span.lastIndex = r.from;
      for (let m; (m = span.exec(code)) && m.index < r.to; ) {
        if (m[1] !== undefined && !readers.has(m[1])) continue;
        const open = m.index + m[0].length - 1;
        cuts.push([m.index, n.file.match.get(open) + 1]);
        span.lastIndex = n.file.match.get(open) + 1;
      }
      let expr = "";
      let at = r.from;
      for (const [a, b] of cuts) {
        expr += `${code.slice(at, a)} `;
        at = b;
      }
      expr += code.slice(at, r.to);
      const allowed = new Set([
        "try",
        "jsonQuote",
        "map",
        "true",
        "false",
        "nil",
        ...(has(ARM_RETURN_EXTRAS, n.arm) ? ARM_RETURN_EXTRAS[n.arm] : []),
      ]);
      const stray = [...expr.matchAll(/\b[A-Za-z_]\w*\b/g)]
        .map((x) => x[0])
        .filter((w) => !allowed.has(w));
      if (stray.length) {
        add(
          "G8b-return",
          n.file,
          r.p,
          `case "${n.arm}" returns [${[...new Set(stray)].join(", ")}]; an arm returns only its own engine call's result`,
        );
      }
    }
  }
  for (const n of reaches) {
    const code = n.file.code;
    for (const [a, b] of n.ranges) {
      const re =
        /\b(?:E2eeReject\s*\(\s*json\s*:|invalidArgument\s*\(|Failure\s*\(\s*message\s*:)\s*/g;
      re.lastIndex = a;
      for (let m; (m = re.exec(code)) && m.index < b; ) {
        const at = m.index + m[0].length;
        const lit = n.file.strings.get(at);
        const closing = lit ? skipSpace(code, lit.end) : -1;
        if (!lit || lit.interpolated || code[closing] !== ")") {
          add(
            "G8b-return",
            n.file,
            m.index,
            `${n.id} can reach a native-only method: its rejections must carry a plain literal`,
          );
        }
      }
    }
  }
  return {
    nodes: nodes.length,
    roots: roots.length,
    reaches: reaches.size,
    reachers: [...reaches].map((n) => n.id).sort(),
  };
}

function check(opts) {
  const violations = [];
  const add = (rule, file, p, what) => {
    let where = "-";
    if (file) where = p == null ? file.rel : `${file.rel}:${file.line(p)}`;
    violations.push(`${rule} ${where} ${what}`);
  };

  // Inputs.
  let listed;
  try {
    listed = readdirSync(opts.sources, { recursive: true });
  } catch {
    throw new InputError(`cannot read the sources dir ${opts.sources}`);
  }
  const allFiles = listed
    .map((n) => String(n).split(sep).join("/"))
    .filter((n) => statSync(join(opts.sources, n)).isFile())
    .sort();
  const swift = allFiles
    .filter((n) => n.endsWith(".swift"))
    .map((n) => loadSwift(join(opts.sources, n), n));
  const byFile = new Map(swift.map((f) => [f.rel, f]));
  const need = (n) => {
    const f = byFile.get(n);
    if (!f) throw new InputError(`missing ${n} in ${opts.sources}`);
    return f;
  };
  const commands = need("E2eeCommands.swift");
  const plugin = need("E2eePlugin.swift");
  const support = need("Support.swift");
  const relTo = (p) => relative(opts.root, p) || p;
  const bindings = loadSwift(opts.bindings, relTo(opts.bindings));
  const fe = loadTs(opts.fe, relTo(opts.fe));

  // G7-main-sync, raw text first (comments included), every file.
  for (const n of allFiles) {
    const raw = readText(join(opts.sources, n), n);
    const starts = lineStarts(raw);
    for (const m of raw.matchAll(/DispatchQueue\s*\.\s*main\s*\.\s*sync\b/g)) {
      violations.push(
        `G7-main-sync ${n}:${lineAt(starts, m.index)} DispatchQueue.main.sync (forbidden even in a comment)`,
      );
    }
  }
  for (const f of swift) {
    for (const m of f.code.matchAll(
      /\.\s*main\s*\.\s*asyncAndWait\b|\bwaitUntil(?:Done|Finished)\s*:\s*true\b/g,
    )) {
      add(
        "G7-main-sync",
        f,
        m.index,
        `synchronous wait on main: ${m[0].replace(/\s+/g, " ")}`,
      );
    }
  }

  // G6 table.
  const parsed = parseCommands(commands, add);
  const table = checkTable(commands, parsed, add);
  const routeOf = (name) => table.get(name)?.route ?? "out";
  const generic = parsed.entries.filter((e) => e.route === "generic");
  const native = parsed.entries.filter((e) => e.route === "native");
  const dedicatedMethods = parsed.methods.map((m) => m.name);

  // Bindings.
  const methods = parseBindings(bindings, add);
  const bySnake = new Map();
  for (const m of methods.values()) if (m.snake) bySnake.set(m.snake, m);
  const targetOf = (command) => bySnake.get(command.slice("e2ee_".length));
  const genericTargets = new Set();
  for (const e of generic) {
    const target = targetOf(e.name);
    if (!target) {
      add(
        "G6-generic-binding",
        commands,
        e.p,
        `${e.name} has no E2eeEngine method (no uniffi symbol ..._e2eeengine_${e.name.slice(5)})`,
      );
    } else genericTargets.add(target.name);
  }
  for (const e of parsed.entries) {
    const target = targetOf(e.name);
    if (e.route !== "out" && target && has(NATIVE_ONLY, target.name)) {
      add(
        "G8b-native-only",
        commands,
        e.p,
        `${e.name} is .${e.route} but maps to native-only ${target.name}`,
      );
    }
  }
  for (const m of methods.values()) {
    const known =
      genericTargets.has(m.name) ||
      has(GATED, m.name) ||
      has(NATIVE_ONLY, m.name) ||
      has(TRANSFER_SHARED, m.name);
    if (!known && !OUT_EXPORT_NAME.test(m.name)) {
      add(
        "G8a-unclassified",
        bindings,
        m.p,
        `E2eeEngine.${m.name} is neither a generic target, a gated method nor a listed native-only method`,
      );
    }
  }

  // Plugin surface.
  const objc = new Map();
  for (const m of plugin.code.matchAll(
    /@objc(?:\([^)]*\))?(?:\s+(?:public|internal|open|final|dynamic))*\s+func\s+(\w+)\s*\(\s*_\s+\w+\s*:\s*CAPPluginCall\s*\)/g,
  )) {
    const declPos = m.index + m[0].indexOf("func");
    const frame = plugin.frames.find(
      (f) => f.kind === "func" && f.declPos === declPos,
    );
    objc.set(m[1], { p: declPos, frame });
  }
  for (const name of ["call", ...DEDICATED_METHODS]) {
    if (!objc.get(name)?.frame) {
      add(
        "G6-dedicated-method",
        plugin,
        null,
        `no @objc func ${name}(_ call: CAPPluginCall) with a body`,
      );
    }
  }
  for (const [name, { p }] of objc) {
    if (name !== "call" && !dedicatedMethods.includes(name)) {
      add(
        "G6-dedicated-method",
        plugin,
        p,
        `@objc plugin method ${name} is not in dedicatedMethods`,
      );
    }
  }
  {
    const m = /\bpluginMethods\s*:[^=]*=/.exec(plugin.code);
    const end = m ? plugin.code.indexOf("\n\n", m.index) : -1;
    const region = m
      ? plugin.code.slice(m.index, end < 0 ? undefined : end)
      : "";
    const named = m
      ? [...region.matchAll(/\bname\s*:\s*(?=")/g)].map(
          (x) => plugin.strings.get(m.index + x.index + x[0].length)?.value,
        )
      : [];
    if (
      !m ||
      !/\bE2eeCommands\s*\.\s*dedicatedMethods\b/.test(region) ||
      named.join(",") !== "call"
    ) {
      add(
        "G6-dedicated-method",
        plugin,
        m ? m.index : null,
        'pluginMethods must be exactly "call" + E2eeCommands.dedicatedMethods',
      );
    }
  }

  // runGeneric / nativeJob switches.
  const runGeneric = onlyFunc(plugin, "runGeneric");
  const genericSwitch = switchOn(plugin, runGeneric, "name");
  if (!genericSwitch) {
    throw new InputError(`${plugin.rel}: runGeneric has no \`switch name\``);
  }
  const arms = caseArms(plugin, genericSwitch);
  const armNames = new Map();
  for (const a of arms) {
    if (a.kind === "default") {
      if (
        !literalArg(plugin, a.body, a.end, "invalidArgument").includes("name")
      ) {
        add(
          "G6-generic-case",
          plugin,
          a.p,
          'runGeneric default must reject invalid_argument{field:"name"}',
        );
      }
      continue;
    }
    if (!a.literalOnly || a.names.length !== 1 || a.names[0] === null) {
      add(
        "G6-generic-case",
        plugin,
        a.p,
        "runGeneric case must be exactly one plain string literal",
      );
      continue;
    }
    if (armNames.has(a.names[0])) {
      add("G6-generic-case", plugin, a.p, `case "${a.names[0]}" appears twice`);
    }
    armNames.set(a.names[0], a);
  }
  if (!arms.some((a) => a.kind === "default")) {
    add(
      "G6-generic-case",
      plugin,
      genericSwitch.open,
      "runGeneric switch has no default",
    );
  }
  for (const e of generic) {
    if (!armNames.has(e.name)) {
      add(
        "G6-generic-case",
        plugin,
        runGeneric.declPos,
        `generic ${e.name} has no case in runGeneric`,
      );
    }
  }
  for (const [name, a] of armNames) {
    if (routeOf(name) !== "generic") {
      add(
        "G6-generic-case",
        plugin,
        a.p,
        `case "${name}" in runGeneric, but the table routes it .${routeOf(name)}`,
      );
    }
  }
  const nativeJob = onlyFunc(plugin, "nativeJob");
  const nativeSwitch = switchOn(plugin, nativeJob, "name");
  if (!nativeSwitch) {
    throw new InputError(`${plugin.rel}: nativeJob has no \`switch name\``);
  }
  const nativeArms = caseArms(plugin, nativeSwitch).filter(
    (a) => a.kind === "case",
  );
  {
    const sw = nativeSwitch;
    const got = nativeArms.flatMap((a) =>
      a.literalOnly ? a.names : ["<non-literal>"],
    );
    const want = native.map((e) => e.name);
    if ([...got].sort().join(",") !== [...want].sort().join(",")) {
      add(
        "G6-generic-case",
        plugin,
        sw.open,
        `nativeJob cases [${got.join(", ")}] must be the native names [${want.join(", ")}]`,
      );
    }
  }
  // G7-gated-case: no confirm-gated name is a case label anywhere in the plugin.
  for (const m of plugin.code.matchAll(
    /\bcase\s+("\s*"(?:\s*,\s*"\s*")*)\s*:/g,
  )) {
    for (const s of literalsIn(plugin, m.index, m.index + m[0].length)) {
      if (has(DEDICATED, s.value)) {
        add(
          "G7-gated-case",
          plugin,
          m.index,
          `confirm-gated ${s.value} is a case label in E2eePlugin.swift`,
        );
      }
    }
  }

  // Engine model across the sources.
  const model = engineModel(swift);
  const calls = new Map(swift.map((f) => [f.rel, engineCalls(f, model)]));
  for (const f of swift) checkUntracked(f, model, add);

  // G7-precondition.
  let bodies = 0;
  for (const f of swift) {
    const reported = new Set();
    const checked = new Set();
    for (const c of calls.get(f.rel)) {
      const body = bodyAt(f, c.p);
      if (!body) {
        add(
          "G7-precondition",
          f,
          c.p,
          `engine .${c.member} outside any function or closure body`,
        );
        continue;
      }
      checked.add(body);
      if (!startsWithPrecondition(f, body) && !reported.has(body)) {
        reported.add(body);
        add(
          "G7-precondition",
          f,
          c.p,
          `body calling engine .${c.member} does not start with ${PRECONDITION}`,
        );
      }
    }
    bodies += checked.size;
  }

  // G7-confirm-precondition.
  let implementers = 0;
  for (const f of swift) {
    for (const t of f.frames) {
      if (t.kind !== "type") continue;
      if (!/:[^{]*\bNativeConfirm\b/.test(f.code.slice(t.declPos, t.open)))
        continue;
      implementers++;
      const confirms = f.frames.filter(
        (x) => x.kind === "func" && x.name === "confirm" && x.parent === t,
      );
      if (!confirms.length) {
        add(
          "G7-confirm-precondition",
          f,
          t.declPos,
          `${t.name} conforms to NativeConfirm but has no confirm body here`,
        );
      }
      for (const c of confirms) {
        if (!startsWithPrecondition(f, c)) {
          add(
            "G7-confirm-precondition",
            f,
            c.declPos,
            `${t.name}.confirm does not start with ${PRECONDITION}`,
          );
        }
      }
    }
  }
  if (!implementers) {
    add(
      "G7-confirm-precondition",
      null,
      null,
      "no type conforms to NativeConfirm",
    );
  }

  // Generic arms, gated calls, plugin engine calls.
  const armOf = (p) => {
    if (!(genericSwitch.open < p && p < genericSwitch.close)) return null;
    for (const [name, a] of armNames) if (a.body <= p && p < a.end) return name;
    return null;
  };
  const objcOf = (f, p) => {
    if (f !== plugin) return null;
    const fn = funcAt(f, p);
    for (const [name, o] of objc) if (o.frame && o.frame === fn) return name;
    return null;
  };
  const gatedHomes = new Map();
  for (const f of swift) {
    for (const c of calls.get(f.rel)) {
      if (!has(GATED, c.member)) continue;
      const arm = f === plugin ? armOf(c.p) : null;
      if (c.member === "confirmPeerDowngrade" && arm === PEER_DOWNGRADE_CASE) {
        const open = skipSpace(f.code, c.memberPos + c.member.length);
        const args =
          f.code[open] === "(" ? f.code.slice(open, f.match.get(open)) : "";
        const a = armNames.get(arm);
        const guarded =
          literalArg(f, a.body, a.end, "optionalBool").includes("accept") &&
          literalArg(f, a.body, a.end, "invalidArgument").includes("accept");
        if (!/\baccept\s*:\s*false\s*$/.test(args) || !guarded) {
          add(
            "G7-gated-call",
            f,
            c.p,
            "the generic peer-downgrade arm must reject accept == true and call with the literal accept: false",
          );
        }
        continue;
      }
      const home = GATED[c.member];
      const inHome = objcOf(f, c.p) === home;
      if (!inHome || !onDedicatedThread(f, c.p, objc.get(home)?.frame)) {
        add(
          "G7-gated-call",
          f,
          c.p,
          `engine .${c.member} outside a dedicated-thread closure of @objc ${home}`,
        );
      } else {
        gatedHomes.set(c.member, true);
      }
    }
    const gatedCall = new RegExp(
      `([A-Za-z_]\\w*|[)\\]])\\s*[?!]?\\s*\\.\\s*(${Object.keys(GATED).join("|")})\\s*\\(`,
      "g",
    );
    const engineMembers = new Set(calls.get(f.rel).map((c) => c.memberPos));
    for (const m of f.code.matchAll(gatedCall)) {
      const memberPos = m.index + m[0].lastIndexOf(m[2]);
      if (engineMembers.has(memberPos)) continue;
      if ((NON_ENGINE_GATED_RECEIVERS[f.rel] ?? []).includes(m[1])) continue;
      add(
        "G7-gated-call",
        f,
        m.index,
        `.${m[2]}( on ${m[1]}, not a known engine value and not a listed non-engine receiver`,
      );
    }
  }
  for (const member of Object.keys(GATED)) {
    if (!gatedHomes.has(member)) {
      add(
        "G7-gated-call",
        plugin,
        null,
        `@objc ${GATED[member]} never calls engine .${member} on a dedicated thread`,
      );
    }
  }
  for (const c of calls.get(plugin.rel)) {
    const arm = armOf(c.p);
    if (arm) continue;
    if (has(GATED, c.member) && objcOf(plugin, c.p) === GATED[c.member]) {
      continue;
    }
    add(
      "G6-plugin-engine-call",
      plugin,
      c.p,
      `engine .${c.member} in E2eePlugin.swift outside a generic arm or its gated dedicated method`,
    );
  }
  for (const [name, a] of armNames) {
    const target = targetOf(name);
    if (!target) continue;
    const members = new Set(
      calls
        .get(plugin.rel)
        .filter((c) => a.body <= c.p && c.p < a.end)
        .map((c) => c.member),
    );
    if (!members.has(target.name) || members.size !== 1) {
      add(
        "G6-generic-arm",
        plugin,
        a.p,
        `case "${name}" calls engine [${[...members].join(", ")}]; it must call exactly ${target.name}`,
      );
    }
  }

  // G7-dedicated-thread / G7-generic-worker.
  for (const name of DEDICATED_METHODS) {
    const fr = objc.get(name)?.frame;
    if (!fr) continue;
    const handsOff = plugin.frames.some(
      (f) =>
        f.kind === "closure" &&
        f.open > fr.open &&
        f.close < fr.close &&
        DEDICATED_HANDOFF.has(calleeOf(plugin, f).name),
    );
    if (!handsOff) {
      add(
        "G7-dedicated-thread",
        plugin,
        fr.declPos,
        `@objc ${name} does not hand off through onDedicatedThread/runOnDedicatedThread`,
      );
    }
  }
  {
    const wrapper = plugin.frames.find(
      (f) => f.kind === "func" && f.name === "onDedicatedThread",
    );
    const spawner = support.frames.find(
      (f) => f.kind === "func" && f.name === "runOnDedicatedThread",
    );
    const within = (file, fr, pred) =>
      file.frames.some(
        (f) => f.open > fr.open && f.close < fr.close && pred(file, f),
      );
    if (
      wrapper &&
      !within(
        plugin,
        wrapper,
        (file, f) =>
          f.kind === "closure" &&
          calleeOf(file, f).name === "runOnDedicatedThread",
      )
    ) {
      add(
        "G7-dedicated-thread",
        plugin,
        wrapper.declPos,
        "onDedicatedThread does not run its body through runOnDedicatedThread",
      );
    }
    if (
      !spawner ||
      !within(
        support,
        spawner,
        (file, f) =>
          f.kind === "closure" && calleeOf(file, f).name === "Thread",
      ) ||
      !/\.\s*start\s*\(\s*\)/.test(
        support.code.slice(spawner.open, spawner.close),
      )
    ) {
      add(
        "G7-dedicated-thread",
        support,
        spawner?.declPos ?? null,
        "runOnDedicatedThread must start a new Thread",
      );
    }
  }
  {
    const sites = [];
    for (const f of swift) {
      for (const m of f.code.matchAll(/\brunGeneric\s*\(/g)) {
        if (/\bfunc\s+$/.test(f.code.slice(Math.max(0, m.index - 20), m.index)))
          continue;
        sites.push({ f, p: m.index });
      }
    }
    const onWorker = (f, p) =>
      ancestors(frameAt(f, p)).some((fr) => {
        if (fr.kind !== "closure") return false;
        const callee = calleeOf(f, fr);
        return (
          callee.name === "submit" &&
          /\bengineWorker\s*\.\s*$/.test(
            f.code.slice(Math.max(0, callee.start - 40), callee.start),
          )
        );
      });
    if (
      sites.length !== 1 ||
      sites[0].f !== plugin ||
      !onWorker(sites[0].f, sites[0].p)
    ) {
      for (const s of sites.length ? sites : [{ f: plugin, p: null }]) {
        add(
          "G7-generic-worker",
          s.f,
          s.p,
          "runGeneric must be called once, from an engineWorker.submit closure",
        );
      }
    }
  }

  // G8b native-only names.
  for (const f of swift) {
    for (const [name, allowed] of Object.entries({
      ...NATIVE_ONLY,
      ...TRANSFER_SHARED,
    })) {
      for (const m of f.code.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
        let ok = allowed.includes(f.rel);
        if (ok && f === plugin) {
          const arm = armOf(m.index);
          ok =
            has(TRANSFER_SHARED, name) &&
            arm !== null &&
            targetOf(arm)?.name === name;
        }
        if (!ok) {
          add(
            "G8b-native-only",
            f,
            m.index,
            `${name} named in ${f.rel}; allowed only in ${allowed.join(", ")}${has(TRANSFER_SHARED, name) ? " (E2eePlugin.swift: its own arm)" : ""}`,
          );
        }
      }
    }
  }
  // G8b plugin cross-file reach.
  for (const m of plugin.code.matchAll(
    /\b(RecoverySheet|AttachmentTransfer)\s*\.\s*(\w+)/g,
  )) {
    const key = `${m[1]}.${m[2]}`;
    const arm = armOf(m.index);
    const fn = funcAt(plugin, m.index);
    const objcName = objcOf(plugin, m.index);
    const context = arm
      ? `case:${arm}`
      : objcName
        ? `@${objcName}`
        : fn
          ? fn.name
          : "";
    if (!(PLUGIN_CROSS_FILE[key] ?? []).includes(context)) {
      add(
        "G8b-plugin-crossfile",
        plugin,
        m.index,
        `${key} from ${context || "top level"}; allowed: ${(PLUGIN_CROSS_FILE[key] ?? ["nowhere"]).join(", ")}`,
      );
    }
  }
  // G8b reachability and what reaches the webview.
  const reach = checkReach(
    {
      swift,
      plugin,
      runGeneric,
      armNames,
      nativeJob,
      nativeArms,
      objc,
      targetOf,
    },
    add,
  );

  // FE sender (e2ee.ts).
  const feNames = [...fe.strings.values()].filter(
    (s) => !s.interpolated && /^e2ee_[a-z0-9_]+$/.test(s.value),
  );
  for (const s of feNames) {
    if (!table.has(s.value) && !FE_NON_COMMANDS.includes(s.value)) {
      add(
        "G6-fe-unlisted",
        fe,
        s.start,
        `${s.value} is not in E2eeCommands.table (add it, .out if not on iOS)`,
      );
    }
  }
  let invokeSites = 0;
  for (const m of fe.code.matchAll(/\.\s*#invoke\b/g)) {
    let k = skipSpace(fe.code, m.index + m[0].length);
    if (fe.code[k] === "<") {
      let depth = 0;
      for (; k < fe.code.length; k++) {
        if (fe.code[k] === "<") depth++;
        else if (fe.code[k] === ">" && fe.code[k - 1] !== "=") {
          depth--;
          if (depth === 0) break;
        }
      }
      k = skipSpace(fe.code, k + 1);
    }
    invokeSites++;
    if (!staticCommand(fe, k)) {
      add(
        "G6-fe-dynamic",
        fe,
        m.index,
        'this.#invoke must name its command with an e2ee_ literal (or `cond ? "e2ee_a" : "e2ee_b"`)',
      );
    }
  }
  {
    const def = /(?<![.\w$])#invoke\s*<[^>]*>\s*\(/.exec(fe.code);
    if (!def)
      throw new InputError(`${fe.rel}: the #invoke definition was not found`);
    const paramsClose = fe.match.get(def.index + def[0].length - 1);
    const bodyOpen = fe.code.indexOf("{", paramsClose);
    const bodyClose = fe.match.get(bodyOpen);
    for (const m of fe.code.matchAll(/#transport\s*\.\s*invoke\b/g)) {
      if (!(bodyOpen < m.index && m.index < bodyClose)) {
        add(
          "G6-fe-dynamic",
          fe,
          m.index,
          "#transport.invoke outside #invoke bypasses the literal-command rule",
        );
      }
    }
  }
  {
    const cls = /\bclass\s+CapacitorTransport\b[^{]*\{/.exec(fe.code);
    if (!cls)
      throw new InputError(`${fe.rel}: class CapacitorTransport not found`);
    const open = cls.index + cls[0].length - 1;
    const close = fe.match.get(open);
    const body = fe.code.slice(open, close);
    const pluginCall = /\bthis\s*\.\s*#plugin\s*\.\s*(\w+)\s*\(/g;
    const routes = [];
    for (const m of body.matchAll(/\bif\s*\(/g)) {
      const pOpen = open + m.index + m[0].length - 1;
      const pClose = fe.match.get(pOpen);
      const cond = fe.code.slice(pOpen, pClose);
      const cmds = [...cond.matchAll(/\bcommand\s*===\s*(?=["'`])/g)]
        .map((x) => fe.strings.get(pOpen + x.index + x[0].length))
        .filter((s) => s && !s.interpolated)
        .map((s) => s.value);
      if (!cmds.length) continue;
      const k = skipSpace(fe.code, pClose + 1);
      const end =
        fe.code[k] === "{" ? fe.match.get(k) : fe.code.indexOf(";", k);
      const called = [...fe.code.slice(k, end).matchAll(pluginCall)].map(
        (x) => x[1],
      );
      routes.push({ cmds, called, accept: /\baccept\b/.test(cond), p: pOpen });
    }
    const used = new Set([...body.matchAll(pluginCall)].map((x) => x[1]));
    const outMethods = new Set();
    const feDedicated = new Map();
    for (const r of routes) {
      for (const cmd of r.cmds) {
        // A branch that refuses in the webview reaches no plugin method:
        // that fails closed. A missing dedicated route is reported below.
        if (!r.called.length) continue;
        if (r.called.length > 1) {
          add(
            "G6-fe-route",
            fe,
            r.p,
            `the ${cmd} route calls [${r.called.join(", ")}]; expected one plugin method`,
          );
          continue;
        }
        const method = r.called[0];
        const entry = table.get(cmd);
        if (cmd === PEER_DOWNGRADE_CASE) {
          if (
            method !== GATED.confirmPeerDowngrade ||
            !r.accept ||
            routeOf(cmd) !== "generic"
          ) {
            add(
              "G6-fe-route",
              fe,
              r.p,
              `${cmd} with accept must go to ${GATED.confirmPeerDowngrade} (table: generic, decline only)`,
            );
          }
          feDedicated.set(method, cmd);
        } else if (entry?.route === "dedicated") {
          if (method !== entry.method) {
            add(
              "G6-fe-route",
              fe,
              r.p,
              `${cmd} goes to ${method}; the table says .dedicated("${entry.method}")`,
            );
          }
          feDedicated.set(method, cmd);
        } else if (dedicatedMethods.includes(method)) {
          add(
            "G6-fe-route",
            fe,
            r.p,
            `${cmd} (.${routeOf(cmd)}) goes to iOS dedicated method ${method}`,
          );
        } else if (routeOf(cmd) === "out") {
          outMethods.add(method);
        } else {
          add(
            "G6-fe-route",
            fe,
            r.p,
            `${cmd} (.${routeOf(cmd)}) goes to ${method}, which iOS does not implement`,
          );
        }
      }
    }
    for (const e of parsed.entries.filter((x) => x.route === "dedicated")) {
      if (feDedicated.get(e.method) !== e.name) {
        add(
          "G6-fe-route",
          fe,
          open,
          `CapacitorTransport has no ${e.name} → ${e.method} route`,
        );
      }
    }
    const allowed = new Set([
      "call",
      "addListener",
      ...dedicatedMethods,
      ...outMethods,
    ]);
    for (const m of used) {
      if (!allowed.has(m)) {
        add(
          "G6-fe-route",
          fe,
          open,
          `CapacitorTransport calls plugin method ${m}, which iOS does not implement`,
        );
      }
    }
    for (const m of dedicatedMethods) {
      if (!used.has(m)) {
        add(
          "G6-fe-route",
          fe,
          open,
          `iOS dedicated method ${m} has no CapacitorTransport caller`,
        );
      }
    }
  }

  const summary = {
    generic: generic.map((e) => e.name),
    native: native.map((e) => e.name),
    dedicated: parsed.entries
      .filter((e) => e.route === "dedicated")
      .map((e) => `${e.name}->${e.method}`),
    out: parsed.entries.filter((e) => e.route === "out").map((e) => e.name),
    exports: methods.size,
    feNames: new Set(feNames.map((s) => s.value)).size,
    invokeSites,
    engineCalls: [...calls.values()].reduce((n, c) => n + c.length, 0),
    bodies,
    files: swift.length,
    reach,
  };
  return { violations, summary };
}

function main() {
  let result;
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    result = check(opts);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`PARSE ${error.message}`);
    } else {
      console.error(`INTERNAL ${error?.stack ?? error}`);
    }
    process.exit(2);
  }
  const { violations, summary } = result;
  if (violations.length) {
    for (const v of violations) console.log(v);
    console.error(`${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(
    `ok: table generic ${summary.generic.length}, native ${summary.native.length}, dedicated ${summary.dedicated.length}, out ${summary.out.length}; ` +
      `bindings export ${summary.exports} E2eeEngine methods; e2ee.ts ${summary.feNames} e2ee_ names, ${summary.invokeSites} #invoke sites; ` +
      `${summary.engineCalls} engine calls in ${summary.bodies} preconditioned bodies across ${summary.files} Swift files; ` +
      `call graph ${summary.reach.nodes} nodes, ${summary.reach.roots} roots, ${summary.reach.reaches} native-only callers`,
  );
  if (opts.list) {
    for (const k of ["generic", "native", "dedicated", "out"]) {
      console.log(`${k} (${summary[k].length}): ${summary[k].join(" ")}`);
    }
    console.log(
      `native-only callers (${summary.reach.reachers.length}): ${summary.reach.reachers.join(" ")}`,
    );
  }
}

main();

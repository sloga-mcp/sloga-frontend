/**
 * check-ios-e2ee-commands.mjs (gates G6/G7/G8, plan D10), run as a child
 * process the way CI runs it.
 *
 * The real tree must pass. Every rule family must also FAIL on a known-bad
 * control (audit MAJOR 5): each mutant below is a fresh copy of the three
 * inputs (Swift sources, bindings, e2ee.ts) in a mkdtemp folder, changed in
 * exactly one place, and must exit 1 naming its rule. An unmutated copy
 * passes too, so each failure is the mutation's and not the copy's. A
 * mutation whose anchor is missing or not unique fails the test instead of
 * silently checking nothing.
 *
 * The phase 2 rules (call plane, two events, frame-key reach, the call audio
 * plugin, the caps user script) are ALSO pinned on an inline fixture world
 * (below): a small synthetic Swift/bindings/e2ee.ts tree written from the
 * strings in this file, so their positive and failing mutants do not depend
 * on the state of the real tree.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Override only to replay these mutants against an older checker (a
// fail-first control: a new mutant must fail there and pass here).
const SCRIPT =
  process.env.CHECK_IOS_E2EE_SCRIPT ??
  join(here, "check-ios-e2ee-commands.mjs");
// Override only to replay the real-tree mutants against a snapshot of the
// client dir (the three inputs at the same relative paths).
const ROOT = process.env.CHECK_IOS_E2EE_ROOT ?? dirname(here);

const SOURCES = "ios/App/SlogaE2ee/Sources/SlogaE2ee";
const BINDINGS = "ios/App/SlogaE2ee/Bindings/acutest_e2ee_ios.swift";
const FE = "components/client/e2ee.ts";
const PLUGIN = `${SOURCES}/E2eePlugin.swift`;
const COMMANDS = `${SOURCES}/E2eeCommands.swift`;

let tmp;
let counter = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ios-e2ee-commands-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], {
    encoding: "utf8",
  });
}

/** A fresh copy of the three inputs; returns its client root. */
function copyTree() {
  const root = join(tmp, String(counter++));
  for (const rel of [SOURCES, BINDINGS, FE]) {
    cpSync(join(ROOT, rel), join(root, rel), { recursive: true });
  }
  return root;
}

/** Replace the one occurrence of `search` in `rel`. */
function mutate(root, rel, search, replacement) {
  const file = join(root, rel);
  const text = readFileSync(file, "utf8");
  const at = text.indexOf(search);
  assert.notEqual(at, -1, `mutation anchor not found in ${rel}: ${search}`);
  assert.equal(
    text.indexOf(search, at + 1),
    -1,
    `mutation anchor not unique in ${rel}: ${search}`,
  );
  writeFileSync(
    file,
    text.slice(0, at) + replacement + text.slice(at + search.length),
  );
}

/** One mutation per entry; the checker must exit 1 with a `rule` line. */
function expectViolation(rule, ...mutations) {
  return expectViolationWith(rule, [], ...mutations);
}

/** As expectViolation, and one `rule` line must contain every `needles` text. */
function expectViolationWith(rule, needles, ...mutations) {
  const root = copyTree();
  for (const [rel, search, replacement] of mutations) {
    mutate(root, rel, search, replacement);
  }
  const result = run(root);
  assert.equal(
    result.status,
    1,
    `expected exit 1, got ${result.status}\n${result.stdout}${result.stderr}`,
  );
  const lines = result.stdout.split("\n");
  assert.ok(
    lines.some(
      (line) =>
        line.startsWith(`${rule} `) &&
        needles.every((needle) => line.includes(needle)),
    ),
    `expected a ${rule} violation with [${needles.join(", ")}], got:\n${result.stdout}`,
  );
}

describe("the real tree", () => {
  test("passes", () => {
    const result = run(ROOT);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      // Phase 2 C-W2-8: the call route and the 100-name split.
      /^ok: table generic 37, native 2, call 22, dedicated 7, out 32;/,
    );
  });

  test("an FE branch that refuses a command in the webview passes", () => {
    // Reaches no plugin method, so it fails closed: not a route violation.
    const root = copyTree();
    mutate(
      root,
      FE,
      '      if (command === "e2ee_wipe") {\n',
      '      if (command === "e2ee_rc_seal") throw { type: "invalid_argument" };\n      if (command === "e2ee_wipe") {\n',
    );
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test("an unmutated copy passes, so every mutant failure is its mutation", () => {
    const result = run(copyTree());
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

describe("G6 command table", () => {
  test("a table line with a bad shape", () => {
    expectViolation("G6-table-shape", [
      COMMANDS,
      '("e2ee_history", .generic),',
      '("e2ee_" + "history", .generic),',
    ]);
  });

  test("two entries on one line", () => {
    expectViolation("G6-table-shape", [
      COMMANDS,
      '("e2ee_history", .generic),',
      '("e2ee_history", .generic), ("e2ee_send_mode", .generic),',
    ]);
  });

  test("a changed count pin", () => {
    expectViolation("G6-count", [
      COMMANDS,
      "static let genericCount = 37",
      "static let genericCount = 38",
    ]);
  });

  test("a generic case removed from runGeneric", () => {
    expectViolation("G6-generic-case", [
      PLUGIN,
      '        case "e2ee_group_state":\n            return try engine.groupState(conversationId: args.string("conversationId"))\n',
      "",
    ]);
  });

  test("a dedicated method missing its @objc", () => {
    expectViolation("G6-dedicated-method", [
      PLUGIN,
      "@objc func markVerified(_ call: CAPPluginCall) {",
      "func markVerified(_ call: CAPPluginCall) {",
    ]);
  });

  test("dedicatedMethods out of contract order", () => {
    expectViolation("G6-dedicated-order", [
      COMMANDS,
      '        "backupRotate",\n        "backupRestore",',
      '        "backupRestore",\n        "backupRotate",',
    ]);
  });

  test("a generic arm that calls another engine method", () => {
    expectViolation("G6-generic-arm", [
      PLUGIN,
      "return try engine.backupStatus()",
      "return try engine.backupRederiveRepublish()",
    ]);
  });

  test("a generic name with no engine method in the bindings", () => {
    expectViolation(
      "G6-generic-binding",
      [
        COMMANDS,
        '("e2ee_pending_downgrades", .generic),',
        '("e2ee_pending_downgrade", .generic),',
      ],
      [
        PLUGIN,
        'case "e2ee_pending_downgrades":',
        'case "e2ee_pending_downgrade":',
      ],
    );
  });

  test("an FE #invoke of a command missing from the table", () => {
    expectViolation("G6-fe-unlisted", [
      FE,
      "  #invoke<T>(\n",
      '  async #probeNewThing(): Promise<void> {\n    await this.#invoke("e2ee_new_thing", {});\n  }\n\n  #invoke<T>(\n',
    ]);
  });

  test("an FE #invoke with a computed command name", () => {
    expectViolation("G6-fe-dynamic", [
      FE,
      "  #invoke<T>(\n",
      "  async #probeDynamic(name: string): Promise<void> {\n    await this.#invoke(`e2ee_${name}`, {});\n  }\n\n  #invoke<T>(\n",
    ]);
  });

  test("an FE dedicated route to the wrong plugin method", () => {
    expectViolation("G6-fe-route", [
      FE,
      "        await this.#plugin.wipe();",
      "        await this.#plugin.downgrade({});",
    ]);
  });
});

describe("G7 threads and consent", () => {
  test("a gated name added as a generic case", () => {
    expectViolation("G7-gated-case", [
      PLUGIN,
      '        case "e2ee_status":\n',
      '        case "e2ee_wipe":\n            try engine.wipe()\n            return "null"\n        case "e2ee_status":\n',
    ]);
  });

  test("confirmPeerDowngrade(accept: true) in runGeneric", () => {
    expectViolation("G7-gated-call", [
      PLUGIN,
      'accept: false)\n            return "null"',
      'accept: true)\n            return "null"',
    ]);
  });

  test("a gated call made from the wrong dedicated method", () => {
    expectViolation("G7-gated-call", [
      PLUGIN,
      "try E2eeRuntime.shared.engine().markVerified(",
      "try E2eeRuntime.shared.engine().acceptIdentityChange(",
    ]);
  });

  test("a dedicated method that does not leave the bridge queue", () => {
    expectViolation("G7-dedicated-thread", [
      PLUGIN,
      'Self.onDedicatedThread(call, "gg.sloga.e2ee.downgrade") {',
      "Self.settle(call) {",
    ]);
  });

  test("an engine-calling closure without the precondition", () => {
    expectViolation("G7-precondition", [
      `${SOURCES}/AttachmentTransfer.swift`,
      '"gg.sloga.e2ee.attachment-copy") { () throws -> ExportedAttachment in\n            dispatchPrecondition(condition: .notOnQueue(.main))\n',
      '"gg.sloga.e2ee.attachment-copy") { () throws -> ExportedAttachment in\n',
    ]);
  });

  test("the precondition as the SECOND statement", () => {
    expectViolation("G7-precondition", [
      `${SOURCES}/RecoverySheet.swift`,
      "            dispatchPrecondition(condition: .notOnQueue(.main))\n            if rotate {",
      "            let started = Date()\n            dispatchPrecondition(condition: .notOnQueue(.main))\n            _ = started\n            if rotate {",
    ]);
  });

  test("NativeConfirm.confirm without the precondition", () => {
    expectViolation("G7-confirm-precondition", [
      `${SOURCES}/NativeConfirm.swift`,
      "func confirm(req: ConfirmPayload) throws -> Bool {\n        dispatchPrecondition(condition: .notOnQueue(.main))\n",
      "func confirm(req: ConfirmPayload) throws -> Bool {\n",
    ]);
  });

  test("DispatchQueue.main.sync inside a comment", () => {
    expectViolation("G7-main-sync", [
      `${SOURCES}/Support.swift`,
      "import Foundation\n",
      "import Foundation\n// never DispatchQueue.main.sync from an engine thread\n",
    ]);
  });

  test("an engine handed to a closure the scan cannot follow", () => {
    expectViolation("G7-engine-untracked", [
      `${SOURCES}/AttachmentTransfer.swift`,
      "enum AttachmentTransfer {\n",
      "enum AttachmentTransfer {\n    static func withEngine(_ body: (E2eeEngine) throws -> Void) rethrows {}\n",
    ]);
  });
});

describe("G8 unreachable from the webview", () => {
  test("recoveryCreate called from E2eePlugin.swift", () => {
    expectViolation("G8b-native-only", [
      PLUGIN,
      "            try engine.backupForgetLocal()\n",
      "            try engine.backupForgetLocal()\n            _ = try engine.recoveryCreate()\n",
    ]);
  });

  test("recoveryDiscardPending called from a generic arm", () => {
    expectViolation("G8b-native-only", [
      PLUGIN,
      "            try engine.backupForgetLocal()\n",
      "            try engine.backupForgetLocal()\n            try engine.recoveryDiscardPending()\n",
    ]);
  });

  test("serveAttachmentForRender called from AttachmentTransfer.swift", () => {
    expectViolation("G8b-native-only", [
      `${SOURCES}/AttachmentTransfer.swift`,
      '            request.httpMethod = "GET"\n',
      '            request.httpMethod = "GET"\n            _ = try engine.serveAttachmentForRender(messageId: localId, idx: 0)\n',
    ]);
  });

  test("the orphaned recovery bundle taken from another arm", () => {
    expectViolationWith(
      "G8b-plugin-crossfile",
      ["RecoverySheet.takeOrphanedBundle from case:e2ee_backup_status"],
      [
        PLUGIN,
        "return try engine.backupStatus()",
        'return try RecoverySheet.takeOrphanedBundle(userId: "x") ?? engine.backupStatus()',
      ],
    );
  });

  test("the bundle-waiting hook assigned from a generic arm", () => {
    expectViolationWith(
      "G8b-plugin-crossfile",
      ["RecoverySheet.bundleWaitingHook from case:e2ee_backup_forget_local"],
      [
        PLUGIN,
        "            try engine.backupForgetLocal()\n",
        "            try engine.backupForgetLocal()\n            RecoverySheet.bundleWaitingHook = nil\n",
      ],
    );
  });

  test("load reaching a native-only method", () => {
    expectViolationWith(
      "G8b-reach",
      ["E2eePlugin.load() -> RecoverySheet.runRestore(userId:blobsJson:)"],
      [
        PLUGIN,
        "        super.load()\n",
        '        super.load()\n        _ = try? RecoverySheet.runRestore(userId: "", blobsJson: "")\n',
      ],
    );
  });

  test("G8b-event: the emitter posting a payload instead of [:]", () => {
    expectViolationWith(
      "G8b-event",
      ["the emitter may only call emit("],
      [
        PLUGIN,
        "emit(Self.backupBundleWaitingEvent, [:])",
        'emit(Self.backupBundleWaitingEvent, ["bundle": "x"])',
      ],
    );
  });

  test("G8b-event: notifyListeners outside the emitter closure", () => {
    expectViolationWith(
      "G8b-event",
      ["notifyListeners only in"],
      [
        PLUGIN,
        "        super.load()\n",
        '        super.load()\n        notifyListeners("backupBundleWaiting", data: ["x": 1])\n',
      ],
    );
  });

  test("G8b-event: the event renamed", () => {
    expectViolation("G8b-event", [
      PLUGIN,
      'static let backupBundleWaitingEvent = "backupBundleWaiting"',
      'static let backupBundleWaitingEvent = "backupBundleReady"',
    ]);
  });

  test("G8b-event: another page-script channel", () => {
    expectViolationWith(
      "G8b-event",
      ["triggerJSEvent"],
      [
        PLUGIN,
        "        super.load()\n",
        '        super.load()\n        bridge?.triggerJSEvent(eventName: "x", target: "window")\n',
      ],
    );
  });

  test("the bindings export callJoin", () => {
    expectViolation("G8a-export", [
      BINDINGS,
      "open func wipe()throws",
      "open func callJoin(groupId: String)throws  -> String  {\n    return try  FfiConverterString.lift(try rustCallWithError(FfiConverterTypeE2eeError_lift) {\n    uniffi_acutest_e2ee_ios_fn_method_e2eeengine_call_join(self.uniffiClonePointer(),\n        FfiConverterString.lower(groupId),$0\n    )\n})\n}\n\nopen func wipe()throws",
    ]);
  });

  test("the bindings export a method nobody classified", () => {
    expectViolation("G8a-unclassified", [
      BINDINGS,
      "open func wipe()throws",
      "open func debugDump()throws  -> String  {\n    return try  FfiConverterString.lift(try rustCallWithError(FfiConverterTypeE2eeError_lift) {\n    uniffi_acutest_e2ee_ios_fn_method_e2eeengine_debug_dump(self.uniffiClonePointer(),$0\n    )\n})\n}\n\nopen func wipe()throws",
    ]);
  });

  test("an unclassified export named like an inherited JS key", () => {
    // `toString` is a key of every JS object: a plain `in` lookup would
    // read it as classified.
    expectViolation("G8a-unclassified", [
      BINDINGS,
      "open func wipe()throws",
      "open func toString()throws  -> String  {\n    return try  FfiConverterString.lift(try rustCallWithError(FfiConverterTypeE2eeError_lift) {\n    uniffi_acutest_e2ee_ios_fn_method_e2eeengine_to_string(self.uniffiClonePointer(),$0\n    )\n})\n}\n\nopen func wipe()throws",
    ]);
  });

  test("an MLS command routed generic", () => {
    // Phase 2 reversed the route (.out → .call); off the call plane it is
    // still a G8a-route failure.
    expectViolation("G8a-route", [
      COMMANDS,
      '("e2ee_mls_replenish", .call),',
      '("e2ee_mls_replenish", .generic),',
    ]);
  });

  test("a remote-control command routed onto the call plane", () => {
    expectViolation("G8a-route", [
      COMMANDS,
      '("e2ee_rc_seal", .out),',
      '("e2ee_rc_seal", .call),',
    ]);
  });
});

// Pieces the reachability mutants share (each lexically valid Swift).
const SCHEME = `${SOURCES}/AttachmentSchemeHandler.swift`;
const TRANSFER = `${SOURCES}/AttachmentTransfer.swift`;
const SUPPORT = `${SOURCES}/Support.swift`;
const STORE = `${SOURCES}/E2eeStore.swift`;
const EXPORT_EXTENSION = [
  TRANSFER,
  "// MARK: - URLSession delegate\n",
  "extension AttachmentTransfer {\n    static func exportBase64(messageId: String, idx: UInt32) throws -> String {\n        dispatchPrecondition(condition: .notOnQueue(.main))\n        let engine = try E2eeRuntime.shared.engine()\n        return try engine.attachmentForExport(messageId: messageId, idx: idx).data.base64EncodedString()\n    }\n}\n\n// MARK: - URLSession delegate\n",
];
const RECIPIENTS_ARM =
  '            return try engine.attachmentRecipients(\n                peerUserId: args.string("peerUserId"),\n                selfUserId: args.string("selfUserId")\n            )\n';

describe("G8b reachability (audit M1)", () => {
  test("E1: a scheme-handler helper returns render plaintext to a generic arm", () => {
    expectViolationWith(
      "G8b-reach",
      [
        "E2eePlugin.runGeneric[e2ee_attachment_recipients] -> renderedBase64(_:_:) -> serveFromEngine(_:_:) -> serveAttachmentForRender",
      ],
      [
        SCHEME,
        "private final class StopFlag: @unchecked Sendable {",
        "func renderedBase64(_ messageId: String, _ idx: UInt32) throws -> String {\n    dispatchPrecondition(condition: .notOnQueue(.main))\n    return try serveFromEngine(messageId, idx).data.base64EncodedString()\n}\n\nprivate final class StopFlag: @unchecked Sendable {",
      ],
      [
        PLUGIN,
        RECIPIENTS_ARM,
        '            _ = try engine.attachmentRecipients(peerUserId: args.string("peerUserId"), selfUserId: args.string("selfUserId"))\n            return try renderedBase64(args.string("peerUserId"), 0)\n',
      ],
    );
  });

  test("E2: two hops, a Support.swift free function then a transfer extension", () => {
    expectViolationWith(
      "G8b-reach",
      [
        "E2eePlugin.runGeneric[e2ee_backup_status] -> exportForWebview(_:) -> AttachmentTransfer.exportBase64(messageId:idx:) -> attachmentForExport",
      ],
      EXPORT_EXTENSION,
      [
        SUPPORT,
        "/// Stack size of every thread that calls into the Rust core.\n",
        "func exportForWebview(_ messageId: String) throws -> String {\n    try AttachmentTransfer.exportBase64(messageId: messageId, idx: 0)\n}\n\n/// Stack size of every thread that calls into the Rust core.\n",
      ],
      [
        PLUGIN,
        "return try engine.backupStatus()",
        '_ = try engine.backupStatus()\n            return try exportForWebview(args.string("userId"))',
      ],
    );
  });

  test("three hops through an extension and a closure", () => {
    expectViolationWith(
      "G8b-reach",
      [
        "E2eePlugin.runGeneric[e2ee_pending_downgrades] -> E2eeRuntime.relayExport(_:) -> stagedExport(_:) -> AttachmentTransfer.exportBase64(messageId:idx:) -> attachmentForExport",
      ],
      EXPORT_EXTENSION,
      [
        STORE,
        "enum E2eeStore {",
        'extension E2eeRuntime {\n    func relayExport(_ id: String) throws -> String {\n        try withBackgroundTask("relay") { () throws -> String in\n            try stagedExport(id)\n        }\n    }\n}\n\nenum E2eeStore {',
      ],
      [
        SUPPORT,
        "/// Stack size of every thread that calls into the Rust core.\n",
        "func stagedExport(_ id: String) throws -> String {\n    try AttachmentTransfer.exportBase64(messageId: id, idx: 0)\n}\n\n/// Stack size of every thread that calls into the Rust core.\n",
      ],
      [
        PLUGIN,
        "return try engine.pendingDowngrades()",
        '_ = try engine.pendingDowngrades()\n            return try E2eeRuntime.shared.relayExport("x")',
      ],
    );
  });

  test("a stored closure property holding the render decrypt", () => {
    expectViolationWith(
      "G8b-reach",
      [
        "E2eePlugin.runGeneric[e2ee_group_state] -> leakedDecrypt -> serveFromEngine(_:_:) -> serveAttachmentForRender",
      ],
      [
        SCHEME,
        "private final class StopFlag: @unchecked Sendable {",
        "let leakedDecrypt: AttachmentSchemeHandler.Decrypt = serveFromEngine\n\nprivate final class StopFlag: @unchecked Sendable {",
      ],
      [
        PLUGIN,
        'return try engine.groupState(conversationId: args.string("conversationId"))',
        '_ = try engine.groupState(conversationId: args.string("conversationId"))\n            return try leakedDecrypt("x", 0).mime',
      ],
    );
  });

  test("a closure captured at setup, called later through a variable", () => {
    // No root reaches the capturing function by name, so only the pinned
    // caller list can see it.
    expectViolationWith(
      "G8b-reach",
      ["E2eeStore.prime()", "not a listed native-only caller"],
      [
        STORE,
        "enum E2eeStore {\n",
        "enum E2eeStore {\n    static var capturedExport: ((String) throws -> String)?\n\n    static func prime() {\n        capturedExport = { try AttachmentTransfer.copyImage(messageId: $0, idx: 0) }\n    }\n\n",
      ],
    );
  });

  test("a dedicated method reaching another method's native-only call", () => {
    expectViolationWith(
      "G8b-reach",
      ["E2eePlugin.attachmentUpload(_:)", "attachmentStore"],
      [
        PLUGIN,
        "            let json = try AttachmentTransfer.upload(",
        "            _ = try AttachmentTransfer.fetch(localId: input.localId, url: input.url, authHeader: input.authHeader, authValue: input.authValue)\n            let json = try AttachmentTransfer.upload(",
      ],
    );
  });
});

describe("G8b returns (audit M1)", () => {
  test("copyImage resolving something other than null", () => {
    expectViolationWith(
      "G8b-return",
      ["AttachmentTransfer.copyImage(messageId:idx:)"],
      [
        TRANSFER,
        '        written.wait()\n        return "null"',
        "        written.wait()\n        return identifier",
      ],
    );
  });

  test("a generic arm returning a helper's value", () => {
    expectViolationWith(
      "G8b-return",
      ['case "e2ee_send_mode"', "prepareStoreDirectory"],
      [
        PLUGIN,
        'return try engine.sendMode(peerUserId: args.string("peerUserId"))',
        '_ = try engine.sendMode(peerUserId: args.string("peerUserId"))\n            return try E2eeStore.prepareStoreDirectory().path',
      ],
    );
  });

  test("a generic arm returning a local named like an argument reader", () => {
    expectViolationWith(
      "G8b-return",
      ['case "e2ee_conversation_state"', "value"],
      [
        PLUGIN,
        'return try engine.conversationState(peerUserId: args.string("peerUserId"))',
        '_ = try engine.conversationState(peerUserId: args.string("peerUserId"))\n            let value = try E2eeStore.prepareStoreDirectory().path\n            return value',
      ],
    );
  });

  test("an E2eeError.Failure built from data on a native-only path", () => {
    expectViolationWith(
      "G8b-return",
      ["AttachmentTransfer.copyImage(messageId:idx:)", "plain literal"],
      [
        TRANSFER,
        'throw E2eeReject.invalidArgument("mime")',
        "throw E2eeError.Failure(message: exported.fileName)",
      ],
    );
  });

  test("a rejection carrying data on a native-only path", () => {
    expectViolationWith(
      "G8b-return",
      ["AttachmentTransfer.copyImage(messageId:idx:)", "plain literal"],
      [
        TRANSFER,
        'throw E2eeReject.invalidArgument("mime")',
        "throw E2eeReject.invalidArgument(exported.fileName)",
      ],
    );
  });
});

// Stage 6 audit MINOR-1 / MINOR-2 mutants (each exits 0 on the dee74233
// checker).
const RECOVERY = `${SOURCES}/RecoverySheet.swift`;
const MINT_HEAD =
  "    private static func mintCode(_ engine: E2eeEngine, rotate: Bool) throws -> RecoveryCodeRecord {\n        dispatchPrecondition(condition: .notOnQueue(.main))\n";
const REFRESH_BIND =
  "            if let orphaned = RecoverySheet.takeOrphanedBundle(userId: userId) {\n";
const RUNTIME_CACHED = "    private var cached: E2eeEngine?\n";
/** mintCode parks a closure over the upload bundle; `target` receives it. */
const mintStores = (target, value) => [
  RECOVERY,
  MINT_HEAD,
  `${MINT_HEAD}        ${target} = ${value}\n`,
];
const TAKE_CLOSURE =
  "{\n            dispatchPrecondition(condition: .notOnQueue(.main))\n            return try engine.backupTakePendingUpload()\n        }";

describe("G8b stash and raw FFI (Stage 6 audit)", () => {
  test("A2: a closure stashed in an uninitialized property, returned as `orphaned`", () => {
    const mutations = [
      [
        SUPPORT,
        RUNTIME_CACHED,
        `${RUNTIME_CACHED}    var stash: (() throws -> String)?\n`,
      ],
      mintStores("E2eeRuntime.shared.stash", TAKE_CLOSURE),
      [
        PLUGIN,
        REFRESH_BIND,
        `            if let orphaned = try E2eeRuntime.shared.stash?() {\n                return orphaned\n            }\n${REFRESH_BIND}`,
      ],
    ];
    expectViolationWith(
      "G8b-stash",
      ["E2eeRuntime.stash", "STORED_CLOSURES"],
      ...mutations,
    );
    expectViolationWith(
      "G8b-stash",
      [
        "RecoverySheet.mintCode(_:rotate:)",
        "a closure",
        "E2eeRuntime.shared.stash",
      ],
      ...mutations,
    );
    expectViolationWith(
      "G8b-return",
      ["orphaned may only be bound"],
      ...mutations,
    );
  });

  test("a closure stashed in a listed hook from a native-only caller", () => {
    expectViolationWith(
      "G8b-stash",
      [
        "RecoverySheet.mintCode(_:rotate:)",
        "a closure",
        "RecoverySheet.bundleWaitingHook",
      ],
      mintStores(
        "RecoverySheet.bundleWaitingHook",
        "{\n            dispatchPrecondition(condition: .notOnQueue(.main))\n            _ = try? engine.backupTakePendingUpload()\n        }",
      ),
    );
  });

  test("a function reference stashed from a native-only caller", () => {
    expectViolationWith(
      "G8b-stash",
      ["RecoverySheet.mintCode(_:rotate:)", "a reference to engine"],
      mintStores("RecoverySheet.engineForTesting", "E2eeRuntime.shared.engine"),
    );
  });

  test("a closure stashed through a local first", () => {
    expectViolationWith(
      "G8b-stash",
      [
        "RecoverySheet.mintCode(_:rotate:)",
        "take (a local holding a function)",
      ],
      [
        RECOVERY,
        MINT_HEAD,
        `${MINT_HEAD}        let take = ${TAKE_CLOSURE}\n        RecoverySheet.bundleWaitingHook = take\n`,
      ],
    );
  });

  test("`orphaned` bound from something other than takeOrphanedBundle", () => {
    expectViolationWith(
      "G8b-return",
      ["orphaned may only be bound"],
      [
        PLUGIN,
        REFRESH_BIND,
        `            if let orphaned = try? E2eeStore.prepareStoreDirectory().path {\n                return orphaned\n            }\n${REFRESH_BIND}`,
      ],
    );
  });

  test("a function-typed stored property with an initializer, not listed", () => {
    expectViolationWith(
      "G8b-stash",
      ["E2eeStore.relay", "STORED_CLOSURES"],
      [
        STORE,
        "enum E2eeStore {\n",
        "enum E2eeStore {\n    static var relay: (() throws -> String)? = nil\n",
      ],
    );
  });

  test("a stored property inferred as a closure, not listed", () => {
    expectViolationWith(
      "G8b-stash",
      ["E2eeStore.relay", "STORED_CLOSURES"],
      [
        STORE,
        "enum E2eeStore {\n",
        'enum E2eeStore {\n    static let relay = { () -> String in "" }\n',
      ],
    );
  });

  test("B: the raw FFI symbol called from the sources", () => {
    const mutations = [
      [
        SUPPORT,
        "import Foundation\n",
        "import Foundation\nimport acutest_e2ee_iosFFI\n\nfunc rawTake(_ engine: E2eeEngine) -> RustBuffer {\n    dispatchPrecondition(condition: .notOnQueue(.main))\n    var status = RustCallStatus()\n    return uniffi_acutest_e2ee_ios_fn_method_e2eeengine_backup_take_pending_upload(engine.uniffiClonePointer(), &status)\n}\n",
      ],
    ];
    expectViolationWith(
      "G8b-ffi",
      ["import acutest_e2ee_iosFFI"],
      ...mutations,
    );
    expectViolationWith(
      "G8b-ffi",
      [
        "uniffi_acutest_e2ee_ios_fn_method_e2eeengine_backup_take_pending_upload",
      ],
      ...mutations,
    );
    expectViolationWith("G8b-ffi", ["uniffiClonePointer"], ...mutations);
  });

  test("an FFI symbol bound by name in a string literal", () => {
    expectViolationWith(
      "G8b-ffi",
      ["string literal"],
      [
        SUPPORT,
        "import Foundation\n",
        'import Foundation\n\n@_silgen_name("uniffi_acutest_e2ee_ios_fn_method_e2eeengine_backup_take_pending_upload")\nfunc rawTake(_ p: UnsafeMutableRawPointer) -> Int\n',
      ],
    );
  });
});

describe("unreadable input exits 2", () => {
  test("an unbalanced brace", () => {
    const root = copyTree();
    mutate(
      root,
      `${SOURCES}/Support.swift`,
      "    init(name: String, threads: Int) {",
      "    init(name: String, threads: Int) ",
    );
    const result = run(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /^PARSE /);
  });

  test("a missing E2eeCommands.swift", () => {
    const root = copyTree();
    unlinkSync(join(root, COMMANDS));
    const result = run(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /^PARSE /);
  });
});

// ------------------------------------------------------------ fixture world
//
// A synthetic tree, written from the strings below, that satisfies every
// rule except the pinned lists naming functions of files it leaves out
// (RecoverySheet, AttachmentTransfer, AttachmentSchemeHandler): those
// "not found" lines are its only violations (WORLD_NOISE). The contract
// lists are restated here on purpose, independent of the checker's copy.

const W_GENERIC = [
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
const W_NATIVE = ["e2ee_attachment_copy_image", "e2ee_attachment_save"];
const W_CALL = [
  "e2ee_pin_call_identities",
  "e2ee_call_create",
  "e2ee_call_join_intent",
  "e2ee_call_verify_join_intent",
  "e2ee_call_admit",
  "e2ee_call_process",
  "e2ee_call_commit_won",
  "e2ee_call_commit_lost",
  "e2ee_call_pending_commit_epoch",
  "e2ee_call_leave_cleanup",
  "e2ee_call_local_groups",
  "e2ee_call_heartbeat",
  "e2ee_call_remove",
  "e2ee_call_state",
  "e2ee_call_roster_identities",
  "e2ee_call_frame_keys",
  "e2ee_call_announce",
  "e2ee_call_clear_downgrade",
  "e2ee_call_non_enrolled",
  "e2ee_mls_publish_key_packages",
  "e2ee_mls_replenish",
  "e2ee_mls_expire_key_packages",
];
const W_DEDICATED = {
  e2ee_wipe: "wipe",
  e2ee_downgrade: "downgrade",
  e2ee_enable_group: "enableGroup",
  e2ee_add_group_member: "addGroupMember",
  e2ee_mark_verified: "markVerified",
  e2ee_accept_identity_change: "acceptIdentityChange",
  e2ee_call_confirm_downgrade: "callConfirmDowngrade",
};
const W_DEDICATED_METHODS = [
  "wipe",
  "downgrade",
  "confirmPeerDowngradeAccept",
  "enableGroup",
  "addGroupMember",
  "markVerified",
  "acceptIdentityChange",
  "callConfirmDowngrade",
  "backupCreate",
  "backupRotate",
  "backupRestore",
  "attachmentUpload",
  "attachmentFetch",
];
const W_OUT = [
  "e2ee_attachment_ciphertext",
  "e2ee_attachment_store",
  "e2ee_backup_open_recovery",
  "e2ee_backup_take_pending_upload",
  "e2ee_backup_take_pending_republish",
  "e2ee_rc_open_apply",
  "e2ee_rc_seal",
  "e2ee_rc_set_local_user",
  "e2ee_rc_offer",
  "e2ee_rc_cancel",
  "e2ee_rc_accept",
  "e2ee_rc_start",
  "e2ee_text_group_create",
  "e2ee_text_join",
  "e2ee_text_admit",
  "e2ee_text_process",
  "e2ee_text_commit_won",
  "e2ee_text_commit_lost",
  "e2ee_text_pending_commit",
  "e2ee_text_encrypt",
  "e2ee_text_decrypt",
  "e2ee_text_seat_list_sign",
  "e2ee_text_seat_list_verify",
  "e2ee_text_owner_pin_state",
  "e2ee_text_owner_confirm_change",
  "e2ee_text_owner_handover_sign",
  "e2ee_text_remove",
  "e2ee_text_update",
  "e2ee_text_state",
  "e2ee_text_mark_left",
  "e2ee_text_pin_own_devices",
  "e2ee_mls_group_kind",
];
/** Gated engine method (snake) → its dedicated plugin method. */
const W_GATED = {
  wipe: "wipe",
  downgrade: "downgrade",
  enable_group: "enableGroup",
  add_group_member: "addGroupMember",
  mark_verified: "markVerified",
  accept_identity_change: "acceptIdentityChange",
  call_confirm_downgrade: "callConfirmDowngrade",
};
const W_NATIVE_ONLY = [
  "recovery_open",
  "recovery_create",
  "recovery_rotate",
  "recovery_restore",
  "recovery_finish",
  "recovery_closed",
  "backup_take_pending_upload",
  "backup_take_pending_republish",
  "recovery_discard_pending",
  "serve_attachment_for_render",
  "attachment_ciphertext",
  "attachment_store",
  "attachment_for_export",
  "attachment_export_name",
];
const camel = (snake) =>
  snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const bare = (command) => command.slice("e2ee_".length);

const W_COMMANDS_SWIFT = [
  "import Foundation",
  "",
  "enum E2eeRoute: Equatable {",
  "    case generic",
  "    case native",
  "    case call",
  "    case dedicated(String)",
  "    case out",
  "}",
  "",
  "enum E2eeCommands {",
  "    static let table: [(name: String, route: E2eeRoute)] = [",
  ...W_GENERIC.map((n) => `        ("${n}", .generic),`),
  ...W_NATIVE.map((n) => `        ("${n}", .native),`),
  ...W_CALL.map((n) => `        ("${n}", .call),`),
  ...Object.entries(W_DEDICATED).map(
    ([n, m]) => `        ("${n}", .dedicated("${m}")),`,
  ),
  ...W_OUT.map((n) => `        ("${n}", .out),`),
  "    ]",
  "",
  "    static let dedicatedMethods: [String] = [",
  ...W_DEDICATED_METHODS.map((m) => `        "${m}",`),
  "    ]",
  "",
  "    static let genericCount = 37",
  "    static let nativeCount = 2",
  "    static let callCount = 22",
  "    static let dedicatedCount = 7",
  "    static let outCount = 32",
  "",
  "    static func route(for name: String) -> E2eeRoute {",
  "        .out",
  "    }",
  "}",
  "",
].join("\n");

const W_ENGINE_SNAKES = [
  ...W_GENERIC.map(bare),
  ...Object.keys(W_GATED).filter((s) => !W_GENERIC.includes(`e2ee_${s}`)),
  ...W_CALL.map(bare),
  ...W_NATIVE_ONLY,
];
const bindingMethod = (snake) =>
  [
    `open func ${camel(snake)}()throws  -> String  {`,
    "    return try  FfiConverterString.lift(try rustCallWithError(FfiConverterTypeE2eeError_lift) {",
    `    uniffi_acutest_e2ee_ios_fn_method_e2eeengine_${snake}(self.uniffiClonePointer(),$0`,
    "    )",
    "})",
    "}",
    "",
  ].join("\n");
const W_BINDINGS = [
  "import Foundation",
  "",
  "public protocol E2eeEngineProtocol: AnyObject, Sendable {",
  ...W_ENGINE_SNAKES.map((s) => `    func ${camel(s)}() throws -> String`),
  "}",
  "",
  "open class E2eeEngine: E2eeEngineProtocol, @unchecked Sendable {",
  "",
  ...W_ENGINE_SNAKES.map(bindingMethod),
  "}",
  "",
  "private func uniffiChecksumsMatch() -> Bool {",
  "    return uniffi_acutest_e2ee_ios_checksum_method_e2eeengine_call_frame_keys() == 1",
  "}",
  "",
].join("\n");

const genericArm = (command) => {
  if (command === "e2ee_confirm_peer_downgrade") {
    return [
      `        case "${command}":`,
      '            if try args.optionalBool("accept") == true {',
      '                throw E2eeReject.invalidArgument("accept")',
      "            }",
      '            try engine.confirmPeerDowngrade(conversationId: args.string("conversationId"), accept: false)',
      '            return "null"',
    ];
  }
  if (command === "e2ee_backup_refresh_if_due") {
    return [
      `        case "${command}":`,
      '            let userId = try args.string("userId")',
      "            if let orphaned = RecoverySheet.takeOrphanedBundle(userId: userId) {",
      "                return orphaned",
      "            }",
      "            return try engine.backupRefreshIfDue(userId: userId)",
    ];
  }
  return [
    `        case "${command}":`,
    `            return try engine.${camel(bare(command))}()`,
  ];
};
const callArm = (command) => [
  `        case "${command}":`,
  `            return try engine.${camel(bare(command))}(groupId: args.string("groupId"))`,
];
const dedicatedMethod = (m) => {
  const gated = Object.entries(W_GATED).find(([, home]) => home === m)?.[0];
  const body = gated
    ? [`            try E2eeRuntime.shared.engine().${camel(gated)}()`]
    : m === "confirmPeerDowngradeAccept"
      ? [
          '            try E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: "c", accept: true)',
        ]
      : [];
  return [
    `    @objc func ${m}(_ call: CAPPluginCall) {`,
    `        Self.onDedicatedThread(call, "gg.sloga.e2ee.${m}") {`,
    "            dispatchPrecondition(condition: .notOnQueue(.main))",
    ...body,
    "            return .empty",
    "        }",
    "    }",
    "",
  ];
};
const W_PLUGIN = [
  "import Capacitor",
  "import Foundation",
  "",
  "@objc(E2eePlugin)",
  "public final class E2eePlugin: CAPPlugin, CAPBridgedPlugin {",
  '    public let identifier = "E2eePlugin"',
  '    public let jsName = "E2ee"',
  "    public let pluginMethods: [CAPPluginMethod] =",
  '        [CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise)]',
  "        + E2eeCommands.dedicatedMethods.map { method -> CAPPluginMethod in",
  "            CAPPluginMethod(name: method, returnType: CAPPluginReturnPromise)",
  "        }",
  "",
  "    static func arm() {}",
  "",
  '    static let backupBundleWaitingEvent = "backupBundleWaiting"',
  "",
  "    override public func load() {",
  "        super.load()",
  "        RecoverySheet.bundleWaitingHook = Self.backupBundleWaitingEmitter { [weak self] event, data in",
  "            self?.notifyListeners(event, data: data)",
  "        }",
  "    }",
  "",
  "    static func backupBundleWaitingEmitter(",
  "        _ emit: @escaping (_ event: String, _ data: [String: Any]) -> Void",
  "    ) -> () -> Void {",
  "        return {",
  "            DispatchQueue.main.async {",
  "                emit(Self.backupBundleWaitingEvent, [:])",
  "            }",
  "        }",
  "    }",
  "",
  "    @objc func call(_ call: CAPPluginCall) {",
  '        let name = call.getString("__cmd") ?? ""',
  "        switch E2eeCommands.route(for: name) {",
  "        case .generic:",
  "            E2eeRuntime.shared.engineWorker.submit {",
  "                dispatchPrecondition(condition: .notOnQueue(.main))",
  "                Self.settle(call) {",
  "                    .json(try Self.runGeneric(name, E2eeCallArgs(call)))",
  "                }",
  "            }",
  "        case .call:",
  "            E2eeRuntime.shared.callWorker.submit {",
  "                dispatchPrecondition(condition: .notOnQueue(.main))",
  "                Self.settle(call) {",
  "                    .json(try Self.runCallPlane(name, E2eeCallArgs(call)))",
  "                }",
  "            }",
  "        case .native:",
  "            guard let job = try? Self.nativeJob(name, E2eeCallArgs(call)) else {",
  "                return",
  "            }",
  '            Self.onDedicatedThread(call, "gg.sloga.e2ee.attachment-export", job)',
  "        case .dedicated, .out:",
  '            call.reject(E2eeReject.invalidArgument("name").json)',
  "        }",
  "    }",
  "",
  ...W_DEDICATED_METHODS.flatMap(dedicatedMethod),
  "    enum Resolution {",
  "        case json(String)",
  "        case empty",
  "    }",
  "",
  "    static func settle(_ call: CAPPluginCall, _ body: () throws -> Resolution) {",
  "        do {",
  "            switch try body() {",
  "            case .json(let json):",
  '                call.resolve(["json": json])',
  "            case .empty:",
  "                call.resolve([:])",
  "            }",
  "        } catch {",
  "            call.reject(rejectJson(for: error))",
  "        }",
  "    }",
  "",
  "    static func onDedicatedThread(_ call: CAPPluginCall, _ name: String, _ body: @escaping () throws -> Resolution) {",
  "        runOnDedicatedThread(name: name) {",
  "            dispatchPrecondition(condition: .notOnQueue(.main))",
  "            settle(call, body)",
  "        }",
  "    }",
  "",
  "    static func nativeJob(_ name: String, _ args: E2eeCallArgs) throws -> () throws -> Resolution {",
  "        switch name {",
  ...W_NATIVE.flatMap((n) => [
    `        case "${n}":`,
    '            throw E2eeReject.invalidArgument("name")',
  ]),
  "        default:",
  '            throw E2eeReject.invalidArgument("name")',
  "        }",
  "    }",
  "",
  "    static func runGeneric(_ name: String, _ args: E2eeCallArgs) throws -> String {",
  "        dispatchPrecondition(condition: .notOnQueue(.main))",
  "        let engine = try E2eeRuntime.shared.engine()",
  "        switch name {",
  ...W_GENERIC.flatMap(genericArm),
  "        default:",
  '            throw E2eeReject.invalidArgument("name")',
  "        }",
  "    }",
  "",
  "    static func runCallPlane(_ name: String, _ args: E2eeCallArgs) throws -> String {",
  "        dispatchPrecondition(condition: .notOnQueue(.main))",
  "        let engine = try E2eeRuntime.shared.engine()",
  "        switch name {",
  ...W_CALL.flatMap(callArm),
  "        default:",
  '            throw E2eeReject.invalidArgument("name")',
  "        }",
  "    }",
  "}",
  "",
  "private struct E2eeCallArgs {",
  "    let call: CAPPluginCall",
  "",
  "    init(_ call: CAPPluginCall) {",
  "        self.call = call",
  "    }",
  "",
  "    func string(_ key: String) throws -> String {",
  "        throw E2eeReject.invalidArgument(key)",
  "    }",
  "",
  "    func optionalBool(_ key: String) throws -> Bool? {",
  "        nil",
  "    }",
  "}",
  "",
].join("\n");

const W_SUPPORT = String.raw`import AcutestE2eeBindings
import Foundation

struct E2eeReject: Error {
    let json: String

    static func invalidArgument(_ field: String) -> E2eeReject {
        E2eeReject(json: "{}")
    }
}

func rejectJson(for error: Error) -> String {
    return "{}"
}

final class WorkerPool: @unchecked Sendable {
    private var jobs: [() -> Void] = []

    init(name: String, threads: Int) {}

    func submit(_ job: @escaping () -> Void) {
        jobs.append(job)
    }
}

func runOnDedicatedThread(name: String, _ body: @escaping () -> Void) {
    let thread = Thread {
        body()
    }
    thread.start()
}

final class E2eeRuntime: @unchecked Sendable {
    static let shared = E2eeRuntime()

    let engineWorker = WorkerPool(name: "gg.sloga.e2ee.engine", threads: 1)

    let callWorker = WorkerPool(name: "gg.sloga.e2ee.call", threads: 1)

    private var cached: E2eeEngine?

    func engine() throws -> E2eeEngine {
        dispatchPrecondition(condition: .notOnQueue(.main))
        if let engine = cached {
            return engine
        }
        let engine = try E2eeEngine(storeDir: "", confirm: NativeConfirmPresenter.shared, keysChanged: KeysChangedRelay.shared)
        cached = engine
        return engine
    }
}

final class NativeConfirmPresenter: NativeConfirm {
    static let shared = NativeConfirmPresenter()

    func confirm(req: ConfirmPayload) throws -> Bool {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return false
    }
}
`;

const W_RELAY = String.raw`import AcutestE2eeBindings
import Capacitor
import Foundation

final class KeysChangedRelay: NativeKeysChanged {
    static let event = "callKeysChanged"

    static let shared = KeysChangedRelay { groupId, epoch in
        DispatchQueue.main.async {
            KeysChangedRelay.plugin?.notifyListeners(
                KeysChangedRelay.event,
                data: ["group_id": groupId, "epoch": NSNumber(value: epoch)]
            )
        }
    }

    private static weak var plugin: CAPPlugin?

    static func attach(_ plugin: CAPPlugin) {
        Self.plugin = plugin
    }

    private let deliver: @Sendable (_ groupId: String, _ epoch: Int64) -> Void

    init(deliver: @escaping @Sendable (_ groupId: String, _ epoch: Int64) -> Void) {
        self.deliver = deliver
    }

    func keysChanged(groupId: String, epoch: Int64) throws {
        deliver(groupId, epoch)
    }
}
`;

const W_AUDIO = String.raw`import AVFoundation
import Capacitor
import Foundation

@objc(SlogaCallAudioPlugin)
public final class SlogaCallAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SlogaCallAudioPlugin"
    public let jsName = "SlogaCallAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private static let queue = DispatchQueue(label: "gg.sloga.call-audio", qos: .userInitiated)

    static func arm() {}

    @objc func start(_ call: CAPPluginCall) {
        Self.queue.async {
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        Self.queue.async {
            call.resolve()
        }
    }
}
`;

const W_CAPS_LINE = String.raw`        return "Object.defineProperty(window,\"__slogaIosCaps\",{value:Object.freeze({mediaE2EE:\(flag)}),writable:false,configurable:false,enumerable:false});"`;
const W_BRIDGE = String.raw`import Capacitor
import Foundation
import UIKit
import WebKit

@objc(SlogaBridgeViewController)
open class SlogaBridgeViewController: CAPBridgeViewController {
    static let mediaE2EEInfoKey = "SlogaMediaE2EE"

    static func capsScriptSource(mediaE2EE: Bool) -> String {
        let flag = mediaE2EE ? "true" : "false"
${W_CAPS_LINE}
    }

    open override func capacitorDidLoad() {
        super.capacitorDidLoad()
        if let capBridge = bridge as? CapacitorBridge {
            let mediaE2EE = (Bundle.main.object(forInfoDictionaryKey: Self.mediaE2EEInfoKey) as? String) == "YES"
            let script = WKUserScript(
                source: Self.capsScriptSource(mediaE2EE: mediaE2EE),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            capBridge.webViewDelegationHandler.contentController.addUserScript(script)
        }
        if let bridge = bridge {
            if MainFrameBridgeGuard.install(on: bridge) != nil {
                E2eePlugin.arm()
                SlogaCallAudioPlugin.arm()
                let e2ee = E2eePlugin()
                bridge.registerPluginInstance(e2ee)
                // The key push goes to this instance only.
                KeysChangedRelay.attach(e2ee)
                bridge.registerPluginInstance(SlogaCallAudioPlugin())
            }
        }
    }
}
`;

const W_FE = [
  "export class E2eeClient {",
  "  #transport: { invoke(command: string, args: object): Promise<unknown> } = null as never;",
  "",
  "  async status(): Promise<unknown> {",
  '    return this.#invoke<unknown>("e2ee_status", {});',
  "  }",
  "",
  "  #invoke<T>(command: string, args: object): Promise<T> {",
  "    return this.#transport.invoke(command, args) as Promise<T>;",
  "  }",
  "}",
  "",
  "class CapacitorTransport {",
  "  #plugin: any = null;",
  "",
  "  async invoke(command: string, args: any): Promise<unknown> {",
  ...Object.entries(W_DEDICATED).flatMap(([n, m]) => [
    `    if (command === "${n}") {`,
    `      await this.#plugin.${m}(args);`,
    "      return null;",
    "    }",
  ]),
  '    if (command === "e2ee_confirm_peer_downgrade" && args.accept === true) {',
  "      await this.#plugin.confirmPeerDowngradeAccept(args);",
  "      return null;",
  "    }",
  "    const { json } = await this.#plugin.call({ __cmd: command, ...args });",
  "    return json;",
  "  }",
  "",
  "  async others(): Promise<void> {",
  ...[
    "backupCreate",
    "backupRotate",
    "backupRestore",
    "attachmentUpload",
    "attachmentFetch",
  ].map((m) => `    await this.#plugin.${m}({});`),
  '    await this.#plugin.addListener("callKeysChanged", () => {});',
  "  }",
  "}",
  "",
].join("\n");

const W_RELAY_FILE = `${SOURCES}/KeysChangedRelay.swift`;
const W_AUDIO_FILE = `${SOURCES}/CallAudioSession.swift`;
const W_BRIDGE_FILE = `${SOURCES}/SlogaBridgeViewController.swift`;
const W_FILES = {
  [COMMANDS]: W_COMMANDS_SWIFT,
  [PLUGIN]: W_PLUGIN,
  [SUPPORT]: W_SUPPORT,
  [W_RELAY_FILE]: W_RELAY,
  [W_AUDIO_FILE]: W_AUDIO,
  [W_BRIDGE_FILE]: W_BRIDGE,
  [BINDINGS]: W_BINDINGS,
  [FE]: W_FE,
};
/** The world's only violations: pins naming files it does not carry. */
const WORLD_NOISE = [
  /^G8b-reach - listed native-only caller \S+ not found or reaches nothing; update the list$/,
  /^G8b-return - pinned native export \S+ not found; update FIXED_RESOLVES$/,
  /^G8b-stash - listed stored closure \S+ not found; update STORED_CLOSURES$/,
];
/** 26 native-only callers + 2 fixed resolves + 5 stored closures it lacks. */
const WORLD_NOISE_COUNT = 33;

function world() {
  const root = join(tmp, `world-${counter++}`);
  for (const [rel, text] of Object.entries(W_FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function violationsOf(result) {
  assert.ok(
    result.status === 0 || result.status === 1,
    `the checker must run to the end (exit 0/1), got ${result.status}\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.split("\n").filter((l) => l && !l.startsWith("ok: "));
}

/** World + mutations; the checker must report `rule` with every needle. */
function worldExpect(rule, needles, ...mutations) {
  const root = world();
  for (const [rel, search, replacement] of mutations) {
    mutate(root, rel, search, replacement);
  }
  const lines = violationsOf(run(root));
  // A needle is a substring, or a RegExp over the whole line (to pin WHERE
  // a violation is reported, not only what it says).
  const hit = (l, n) => (typeof n === "string" ? l.includes(n) : n.test(l));
  assert.ok(
    lines.some(
      (l) => l.startsWith(`${rule} `) && needles.every((n) => hit(l, n)),
    ),
    `expected a ${rule} violation with [${needles.join(", ")}], got:\n${lines.join("\n")}`,
  );
}

/** World + mutations; the checker must report NOTHING under `rule`. */
function worldClean(rule, ...mutations) {
  const root = world();
  for (const [rel, search, replacement] of mutations) {
    mutate(root, rel, search, replacement);
  }
  const lines = violationsOf(run(root));
  assert.deepEqual(
    lines.filter((l) => l.startsWith(`${rule} `)),
    [],
    lines.join("\n"),
  );
}

describe("fixture world (phase 2 rules, independent of the real tree)", () => {
  test("the unmutated world fails only on pins naming files it leaves out", () => {
    const result = run(world());
    const lines = violationsOf(result);
    assert.equal(result.status, 1);
    const stray = lines.filter((l) => !WORLD_NOISE.some((re) => re.test(l)));
    assert.deepEqual(stray, [], `unexpected violations:\n${stray.join("\n")}`);
    // The noise comes from the reachability pass, which runs last: so every
    // phase 2 rule ran on this world and found nothing.
    for (const re of WORLD_NOISE) {
      assert.ok(
        lines.some((l) => re.test(l)),
        `noise ${re} missing`,
      );
    }
    assert.equal(lines.length, WORLD_NOISE_COUNT, lines.join("\n"));
  });
});

describe("phase 2: the command table (C-W2-3)", () => {
  test("a .call line with a bad shape", () => {
    worldExpect(
      "G6-table-shape",
      ['("e2ee_call_state", .call()),'],
      [
        COMMANDS,
        '("e2ee_call_state", .call),',
        '("e2ee_call_state", .call()),',
      ],
    );
  });

  test("a duplicated .call line (L2a: was only an extra G6-table-shape)", () => {
    worldExpect(
      "G6-table-duplicate",
      ["e2ee_call_state is listed twice"],
      [
        COMMANDS,
        '        ("e2ee_call_state", .call),\n',
        '        ("e2ee_call_state", .call),\n        ("e2ee_call_state", .call),\n',
      ],
    );
  });

  test("callCount drift (L2a: was no violation at all)", () => {
    worldExpect(
      "G6-count",
      ["callCount = 21 but the table has 22 .call lines"],
      [COMMANDS, "static let callCount = 22", "static let callCount = 21"],
    );
  });

  test("callCount missing", () => {
    worldExpect(
      "G6-count",
      ["static let callCount not found"],
      [COMMANDS, "    static let callCount = 22\n", ""],
    );
  });

  test("a 33rd .out name, its static count kept in step", () => {
    worldExpect(
      "G6-count",
      ["the table has 33 .out lines; the contract pins 32"],
      [
        COMMANDS,
        '        ("e2ee_rc_start", .out),\n',
        '        ("e2ee_rc_start", .out),\n        ("e2ee_rc_extra", .out),\n',
      ],
      [COMMANDS, "static let outCount = 32", "static let outCount = 33"],
    );
  });

  test("a call-plane name routed generic", () => {
    const mutation = [
      COMMANDS,
      '("e2ee_call_state", .call),',
      '("e2ee_call_state", .generic),',
    ];
    worldExpect(
      "G6-table-route",
      ["e2ee_call_state must be .call, is .generic"],
      mutation,
    );
    worldExpect(
      "G8a-route",
      ["e2ee_call_state is .generic; the contract routes it .call"],
      mutation,
    );
  });

  test("an rc name, and the out-only mls name, on the call plane", () => {
    worldExpect(
      "G8a-route",
      ["e2ee_rc_seal is .call; the contract routes it .out"],
      [COMMANDS, '("e2ee_rc_seal", .out),', '("e2ee_rc_seal", .call),'],
    );
    worldExpect(
      "G8a-route",
      ["e2ee_mls_group_kind is .call; the contract routes it .out"],
      [
        COMMANDS,
        '("e2ee_mls_group_kind", .out),',
        '("e2ee_mls_group_kind", .call),',
      ],
    );
  });

  test("the whole-call downgrade confirm on the call plane", () => {
    worldExpect(
      "G8a-route",
      [
        "e2ee_call_confirm_downgrade is .call; the contract routes it .dedicated",
      ],
      [
        COMMANDS,
        '("e2ee_call_confirm_downgrade", .dedicated("callConfirmDowngrade")),',
        '("e2ee_call_confirm_downgrade", .call),',
      ],
    );
  });

  test("callConfirmDowngrade out of contract order", () => {
    worldExpect(
      "G6-dedicated-order",
      [
        "acceptIdentityChange, backupCreate, callConfirmDowngrade, backupRotate",
        "the contract order is [wipe, downgrade, confirmPeerDowngradeAccept, enableGroup, addGroupMember, markVerified, acceptIdentityChange, callConfirmDowngrade, backupCreate,",
      ],
      [
        COMMANDS,
        '        "callConfirmDowngrade",\n        "backupCreate",\n',
        '        "backupCreate",\n        "callConfirmDowngrade",\n',
      ],
    );
  });

  test("callConfirmDowngrade without its @objc method", () => {
    worldExpect(
      "G6-dedicated-method",
      ["callConfirmDowngrade(_ call: CAPPluginCall)"],
      [
        PLUGIN,
        "@objc func callConfirmDowngrade(_ call: CAPPluginCall) {",
        "func callConfirmDowngrade(_ call: CAPPluginCall) {",
      ],
    );
  });
});

describe("phase 2: the bindings' call-plane surface (G8a-export)", () => {
  const anchor = "open func callFrameKeys()throws";
  test("an extra call-shaped export", () => {
    worldExpect(
      "G8a-export",
      ["callDebugKeys"],
      [BINDINGS, anchor, `${bindingMethod("call_debug_keys")}\n${anchor}`],
    );
  });

  test("a remote-control export", () => {
    worldExpect(
      "G8a-export",
      ["rcSeal"],
      [BINDINGS, anchor, `${bindingMethod("rc_seal")}\n${anchor}`],
    );
  });

  test("a contract call-plane method missing from the bindings", () => {
    const mutation = [BINDINGS, bindingMethod("call_heartbeat"), ""];
    worldExpect(
      "G8a-export",
      ["callHeartbeat is not an E2eeEngine export"],
      mutation,
    );
    worldExpect(
      "G6-call-binding",
      ["e2ee_call_heartbeat has no E2eeEngine method"],
      mutation,
    );
  });

  test("an exported call-plane method the table leaves .out", () => {
    worldExpect(
      "G8a-export",
      ["callHeartbeat; its command e2ee_call_heartbeat must be .call, is .out"],
      [
        COMMANDS,
        '("e2ee_call_heartbeat", .call),',
        '("e2ee_call_heartbeat", .out),',
      ],
    );
  });

  test("a free func_call_ uniffi symbol", () => {
    worldExpect(
      "G8a-export",
      ["uniffi_acutest_e2ee_ios_fn_func_call_debug"],
      [
        BINDINGS,
        "private func uniffiChecksumsMatch() -> Bool {\n",
        "private func uniffiChecksumsMatch() -> Bool {\n    _ = uniffi_acutest_e2ee_ios_fn_func_call_debug\n",
      ],
    );
  });

  test("a non-call export nobody classified (call targets are classified)", () => {
    worldExpect(
      "G8a-unclassified",
      ["debugDump"],
      [BINDINGS, anchor, `${bindingMethod("debug_dump")}\n${anchor}`],
    );
  });
});

const W_STATE_ARM =
  '        case "e2ee_call_state":\n            return try engine.callState(groupId: args.string("groupId"))\n';
const W_LAST_CALL_ARM =
  '        case "e2ee_mls_expire_key_packages":\n            return try engine.mlsExpireKeyPackages(groupId: args.string("groupId"))\n        default:\n            throw E2eeReject.invalidArgument("name")\n';
describe("phase 2: runCallPlane (C-W2-4)", () => {
  test("a call-plane name with no case", () => {
    worldExpect(
      "G6-call-case",
      ["call e2ee_call_state has no case in runCallPlane"],
      [PLUGIN, W_STATE_ARM, ""],
    );
  });

  test("a generic name added to runCallPlane", () => {
    worldExpect(
      "G6-call-case",
      [
        'case "e2ee_backup_status" in runCallPlane, but the table routes it .generic',
      ],
      [
        PLUGIN,
        W_STATE_ARM,
        `${W_STATE_ARM}        case "e2ee_backup_status":\n            return try engine.backupStatus()\n`,
      ],
    );
  });

  test("a default that does not reject the name", () => {
    worldExpect(
      "G6-call-case",
      ['runCallPlane default must reject invalid_argument{field:"name"}'],
      [PLUGIN, W_LAST_CALL_ARM, W_LAST_CALL_ARM.replace('("name")', '("x")')],
    );
  });

  test("a call arm calling another engine method", () => {
    worldExpect(
      "G6-call-arm",
      [
        'case "e2ee_call_state" calls engine [callHeartbeat]; it must call exactly callState',
      ],
      [
        PLUGIN,
        "return try engine.callState(",
        "return try engine.callHeartbeat(",
      ],
    );
  });

  test("a call arm returning something besides its engine result", () => {
    worldExpect(
      "G8b-return",
      ['case "e2ee_call_state" returns [name]'],
      [
        PLUGIN,
        W_STATE_ARM,
        '        case "e2ee_call_state":\n            _ = try engine.callState(groupId: args.string("groupId"))\n            return jsonQuote(name)\n',
      ],
    );
  });

  test("runCallPlane run on the engine worker", () => {
    worldExpect(
      "G7-call-worker",
      ["runCallPlane must be called once, from a callWorker.submit closure"],
      [
        PLUGIN,
        "            E2eeRuntime.shared.callWorker.submit {",
        "            E2eeRuntime.shared.engineWorker.submit {",
      ],
    );
  });

  test("runGeneric nested in a callWorker closure inside the engine worker's", () => {
    // The nearest worker closure decides: this runs on the call worker.
    worldExpect(
      "G7-generic-worker",
      ["runGeneric must be called once"],
      [
        PLUGIN,
        "                    .json(try Self.runGeneric(name, E2eeCallArgs(call)))\n",
        "                    E2eeRuntime.shared.callWorker.submit {\n                        _ = try? Self.runGeneric(name, E2eeCallArgs(call))\n                    }\n                    return .empty\n",
      ],
    );
  });

  test("a call worker that is the engine worker's queue", () => {
    worldExpect(
      "G7-call-worker",
      ["E2eeRuntime.callWorker must be declared once"],
      [
        SUPPORT,
        'let callWorker = WorkerPool(name: "gg.sloga.e2ee.call", threads: 1)',
        'let callWorker = WorkerPool(name: "gg.sloga.e2ee.engine", threads: 1)',
      ],
    );
  });

  test("a call-plane engine call outside the arms", () => {
    worldExpect(
      "G6-plugin-engine-call",
      [
        "engine .callState in E2eePlugin.swift outside a generic or call-plane arm",
      ],
      [
        PLUGIN,
        "    static func arm() {}\n",
        "    static func arm() {}\n\n    static func peek() throws -> String {\n        dispatchPrecondition(condition: .notOnQueue(.main))\n        return try E2eeRuntime.shared.engine().callState()\n    }\n",
      ],
    );
  });

  test("the whole-call downgrade confirm called from a call arm", () => {
    worldExpect(
      "G7-gated-call",
      [
        "engine .callConfirmDowngrade outside a dedicated-thread closure of @objc callConfirmDowngrade",
      ],
      [
        PLUGIN,
        W_STATE_ARM,
        '        case "e2ee_call_state":\n            try engine.callConfirmDowngrade()\n            return try engine.callState(groupId: args.string("groupId"))\n',
      ],
    );
  });

  test("the whole-call downgrade confirm as a case label", () => {
    worldExpect(
      "G7-gated-case",
      ["e2ee_call_confirm_downgrade"],
      [
        PLUGIN,
        W_STATE_ARM,
        `${W_STATE_ARM}        case "e2ee_call_confirm_downgrade":\n            return "null"\n`,
      ],
    );
  });
});

describe("phase 2: callFrameKeys only from its own arm (G8b-frame-keys)", () => {
  test("a helper elsewhere fetching frame keys", () => {
    const mutation = [
      SUPPORT,
      "final class NativeConfirmPresenter",
      'func leakKeys() throws -> String {\n    dispatchPrecondition(condition: .notOnQueue(.main))\n    return try E2eeRuntime.shared.engine().callFrameKeys(groupId: "g")\n}\n\nfinal class NativeConfirmPresenter',
    ];
    worldExpect(
      "G8b-frame-keys",
      ["callFrameKeys named in Support.swift"],
      mutation,
    );
    worldExpect(
      "G8b-frame-keys",
      [
        "leakKeys() -> callFrameKeys (only E2eePlugin.runCallPlane[e2ee_call_frame_keys] may reach callFrameKeys)",
      ],
      mutation,
    );
  });

  test("a second arm fetching frame keys", () => {
    worldExpect(
      "G8b-frame-keys",
      ['outside runCallPlane\'s case "e2ee_call_frame_keys"'],
      [
        PLUGIN,
        W_STATE_ARM,
        '        case "e2ee_call_state":\n            _ = try engine.callFrameKeys(groupId: args.string("groupId"))\n            return try engine.callState(groupId: args.string("groupId"))\n',
      ],
    );
  });

  test("another webview entry calling runCallPlane for the keys", () => {
    worldExpect(
      "G8b-frame-keys",
      [
        "SlogaBridgeViewController.userContentController(_:didReceive:) -> E2eePlugin.runCallPlane[e2ee_call_frame_keys] -> callFrameKeys",
      ],
      [
        W_BRIDGE_FILE,
        "    open override func capacitorDidLoad() {",
        '    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {\n        _ = try? E2eePlugin.runCallPlane("e2ee_call_frame_keys", message.body)\n    }\n\n    open override func capacitorDidLoad() {',
      ],
    );
  });

  test("a stored closure over the frame keys", () => {
    worldExpect(
      "G8b-frame-keys",
      ["E2eeRuntime.keysRef"],
      [
        SUPPORT,
        "    private var cached: E2eeEngine?\n",
        '    private var cached: E2eeEngine?\n\n    static let keysRef = { () throws -> String in\n        dispatchPrecondition(condition: .notOnQueue(.main))\n        return try E2eeRuntime.shared.engine().callFrameKeys(groupId: "g")\n    }\n',
      ],
    );
  });

  test("the frame-keys arm no longer fetching them", () => {
    worldExpect(
      "G8b-frame-keys",
      [
        "E2eePlugin.runCallPlane[e2ee_call_frame_keys] not found or does not name callFrameKeys",
      ],
      [
        PLUGIN,
        'return try engine.callFrameKeys(groupId: args.string("groupId"))',
        'return try engine.callState(groupId: args.string("groupId"))',
      ],
    );
  });
});

const W_EMIT_DATA =
  'data: ["group_id": groupId, "epoch": NSNumber(value: epoch)]';
const W_EMIT_HOP = `        DispatchQueue.main.async {\n            KeysChangedRelay.plugin?.notifyListeners(\n                KeysChangedRelay.event,\n                ${W_EMIT_DATA}\n            )\n        }\n`;
describe("phase 2: the callKeysChanged event (G8b-event)", () => {
  test("the payload keys in the other order, epoch as a bare Int64", () => {
    worldClean("G8b-event", [
      W_RELAY_FILE,
      W_EMIT_DATA,
      'data: ["epoch": epoch, "group_id": groupId]',
    ]);
  });

  test("an extra payload key", () => {
    worldExpect(
      "G8b-event",
      ["the payload keys are exactly group_id and epoch"],
      [
        W_RELAY_FILE,
        W_EMIT_DATA,
        'data: ["group_id": groupId, "epoch": NSNumber(value: epoch), "keys": groupId]',
      ],
    );
  });

  test("a payload value that is not the pair", () => {
    worldExpect(
      "G8b-event",
      ['the payload is exactly ["group_id": groupId, "epoch": epoch]'],
      [
        W_RELAY_FILE,
        '"epoch": NSNumber(value: epoch)',
        '"epoch": NSNumber(value: groupId.count)',
      ],
    );
  });

  test("a payload that is not an inline dictionary", () => {
    worldExpect(
      "G8b-event",
      ["data an inline dictionary literal"],
      [
        W_RELAY_FILE,
        W_EMIT_DATA,
        "data: KeysChangedRelay.payload(groupId, epoch)",
      ],
    );
  });

  test("the event named by a literal, not the constant", () => {
    const mutation = [
      W_RELAY_FILE,
      "                KeysChangedRelay.event,\n",
      '                "callKeysChanged",\n',
    ];
    worldExpect(
      "G8b-event",
      ["the event must be the constant KeysChangedRelay.event"],
      mutation,
    );
    worldExpect(
      "G8b-event",
      ['the "callKeysChanged" literal outside KeysChangedRelay.event'],
      mutation,
    );
  });

  test("the constant renamed", () => {
    worldExpect(
      "G8b-event",
      ["KeysChangedRelay.event must be declared once"],
      [
        W_RELAY_FILE,
        'static let event = "callKeysChanged"',
        'static let event = "callKeysChangedV2"',
      ],
    );
  });

  test("the constant made mutable", () => {
    worldExpect(
      "G8b-event",
      ["KeysChangedRelay.event must be declared once"],
      [
        W_RELAY_FILE,
        'static let event = "callKeysChanged"',
        'static var event = "callKeysChanged"',
      ],
    );
  });

  test("an emit without the main-queue hop", () => {
    worldExpect(
      "G8b-event",
      ["inside DispatchQueue.main.async"],
      [
        W_RELAY_FILE,
        W_EMIT_HOP,
        `        KeysChangedRelay.plugin?.notifyListeners(\n            KeysChangedRelay.event,\n            ${W_EMIT_DATA}\n        )\n`,
      ],
    );
  });

  test("a second relay emit", () => {
    worldExpect(
      "G8b-event",
      ["must emit callKeysChanged exactly once (found 2"],
      [
        W_RELAY_FILE,
        "        deliver(groupId, epoch)\n",
        '        deliver(groupId, epoch)\n        KeysChangedRelay.plugin?.notifyListeners(KeysChangedRelay.event, data: ["group_id": groupId, "epoch": epoch])\n',
      ],
    );
  });

  test("the key event emitted from the E2ee plugin", () => {
    // A rule W3 already had: pinned here to the PLUGIN line, not the relay's.
    worldExpect(
      "G8b-event",
      [
        /^G8b-event E2eePlugin\.swift:\d+ notifyListeners only in E2eePlugin\.load/,
      ],
      [
        PLUGIN,
        "        super.load()\n",
        '        super.load()\n        notifyListeners(KeysChangedRelay.event, data: ["group_id": "g", "epoch": 1])\n',
      ],
    );
  });
});

describe("phase 2: webview entries are reachability roots", () => {
  test("an @objc plugin method of another file reaching a native-only method", () => {
    // Reported FROM start itself (root first): a path into start from
    // another root (thread.start() is a name edge) would not prove start
    // is a root.
    worldExpect(
      "G8b-reach",
      [
        /^G8b-reach CallAudioSession\.swift:\d+ SlogaCallAudioPlugin\.start\(_:\) -> attachmentForExport \(root may reach: none\)$/,
      ],
      [
        W_AUDIO_FILE,
        "            call.resolve()\n        }\n    }\n\n    @objc func stop(",
        "            call.resolve()\n        }\n        _ = attachmentForExport\n    }\n\n    @objc func stop(",
      ],
    );
  });

  test("the key-push callback reaching a native-only method", () => {
    worldExpect(
      "G8b-reach",
      [
        /^G8b-reach KeysChangedRelay\.swift:\d+ KeysChangedRelay\.keysChanged\(groupId:epoch:\) -> recoveryOpen \(root may reach: none\)$/,
      ],
      [
        W_RELAY_FILE,
        "        deliver(groupId, epoch)\n",
        "        deliver(groupId, epoch)\n        _ = recoveryOpen\n",
      ],
    );
  });
});

describe("phase 2: the SlogaCallAudio plugin (G8c-audio-plugin)", () => {
  test("a third @objc plugin method", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["an @objc member other than start/stop"],
      [
        W_AUDIO_FILE,
        "    @objc func stop(_ call: CAPPluginCall) {",
        "    @objc func setMode(_ call: CAPPluginCall) {\n        call.resolve()\n    }\n\n    @objc func stop(_ call: CAPPluginCall) {",
      ],
    );
  });

  test("a third plugin method in pluginMethods", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["pluginMethods must be exactly [start, stop]"],
      [
        W_AUDIO_FILE,
        '        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),\n',
        '        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),\n        CAPPluginMethod(name: "setMode", returnType: CAPPluginReturnPromise),\n',
      ],
    );
  });

  test("pluginMethods extended from a variable", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["pluginMethods must be exactly [start, stop]"],
      [
        W_AUDIO_FILE,
        '        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),\n    ]\n',
        '        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),\n        extraMethods,\n    ]\n',
      ],
    );
  });

  test("another jsName", () => {
    worldExpect(
      "G8c-audio-plugin",
      ['jsName must be "SlogaCallAudio"'],
      [
        W_AUDIO_FILE,
        'public let jsName = "SlogaCallAudio"',
        'public let jsName = "E2ee"',
      ],
    );
  });

  test("the audio plugin reaching for the E2EE core", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["names E2eeRuntime"],
      [
        W_AUDIO_FILE,
        "            call.resolve()\n        }\n    }\n\n    @objc func stop(",
        "            call.resolve()\n            _ = E2eeRuntime.shared\n        }\n    }\n\n    @objc func stop(",
      ],
    );
  });

  test("a third Capacitor plugin class", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["Capacitor plugin class DebugPlugin"],
      [
        SUPPORT,
        "final class NativeConfirmPresenter",
        "final class DebugPlugin: CAPPlugin {}\n\nfinal class NativeConfirmPresenter",
      ],
    );
  });

  test("the audio plugin registered without arming it", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["must be armed, then built once"],
      [W_BRIDGE_FILE, "                SlogaCallAudioPlugin.arm()\n", ""],
    );
  });

  test("the audio plugin registered outside the guarded block", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["must be armed, then built once"],
      [
        W_BRIDGE_FILE,
        "                bridge.registerPluginInstance(SlogaCallAudioPlugin())\n            }\n",
        "            }\n            bridge.registerPluginInstance(SlogaCallAudioPlugin())\n",
      ],
    );
  });

  test("CallAudioSession.swift missing", () => {
    const root = world();
    unlinkSync(join(root, W_AUDIO_FILE));
    const lines = violationsOf(run(root));
    assert.ok(
      lines.some(
        (l) =>
          l.startsWith("G8c-audio-plugin ") &&
          l.includes("CallAudioSession.swift not found"),
      ),
      lines.join("\n"),
    );
  });
});

describe("phase 2: the __slogaIosCaps user script (G8c-ios-caps)", () => {
  const capsExpect = (needles, search, replacement, rel = W_BRIDGE_FILE) =>
    worldExpect("G8c-ios-caps", needles, [rel, search, replacement]);

  test("injected into every frame", () => {
    capsExpect(
      ["WKUserScript must be exactly"],
      "forMainFrameOnly: true",
      "forMainFrameOnly: false",
    );
  });

  test("injected at document end", () => {
    capsExpect(
      ["WKUserScript must be exactly"],
      "injectionTime: .atDocumentStart",
      "injectionTime: .atDocumentEnd",
    );
  });

  test("a second capability next to mediaE2EE", () => {
    capsExpect(
      ["the __slogaIosCaps script must be exactly"],
      String.raw`mediaE2EE:\(flag)}`,
      String.raw`mediaE2EE:\(flag),voice:true}`,
    );
  });

  test("a writable global", () => {
    capsExpect(
      ["the __slogaIosCaps script must be exactly"],
      "}),writable:false,",
      "}),writable:true,",
    );
  });

  test("two interpolations", () => {
    capsExpect(
      ["the __slogaIosCaps script must be exactly"],
      String.raw`mediaE2EE:\(flag)}`,
      String.raw`mediaE2EE:\(flag)\(flag)}`,
    );
  });

  test("an interpolation that is not the literal bool", () => {
    capsExpect(
      ["must be a literal bool"],
      'let flag = mediaE2EE ? "true" : "false"',
      'let flag = mediaE2EE ? "true" : UserDefaults.standard.string(forKey: "caps") ?? ""',
    );
  });

  test("a reassignable flag", () => {
    capsExpect(
      ["must be a literal bool"],
      'let flag = mediaE2EE ? "true" : "false"',
      'var flag = mediaE2EE ? "true" : "false"',
    );
  });

  test("the bool forced on at the call site", () => {
    capsExpect(
      ["WKUserScript must be exactly"],
      "source: Self.capsScriptSource(mediaE2EE: mediaE2EE),",
      "source: Self.capsScriptSource(mediaE2EE: true),",
    );
  });

  test("the bool read from something other than the Info.plist YES", () => {
    capsExpect(["WKUserScript must be exactly"], '== "YES"\n', '!= "NO"\n');
  });

  test("the Info.plist key renamed", () => {
    capsExpect(
      ["WKUserScript must be exactly"],
      'static let mediaE2EEInfoKey = "SlogaMediaE2EE"',
      'static let mediaE2EEInfoKey = "SlogaMediaE2EEDebug"',
    );
  });

  test("a second WKUserScript", () => {
    capsExpect(
      ["exactly one WKUserScript( in the sources"],
      "        super.capacitorDidLoad()\n",
      '        super.capacitorDidLoad()\n        _ = WKUserScript(source: "window.x=1", injectionTime: .atDocumentStart, forMainFrameOnly: true)\n',
    );
  });

  test("a second addUserScript", () => {
    const line =
      "            capBridge.webViewDelegationHandler.contentController.addUserScript(script)\n";
    capsExpect(["exactly one addUserScript("], line, `${line}${line}`);
  });

  test("the global named in another file", () => {
    capsExpect(
      ["exactly one string literal may name __slogaIosCaps"],
      "func rejectJson(for error: Error) -> String {\n",
      'func rejectJson(for error: Error) -> String {\n    _ = "__slogaIosCaps"\n',
      SUPPORT,
    );
  });

  test("slogaShell anywhere", () => {
    capsExpect(
      ["names slogaShell"],
      "func rejectJson(for error: Error) -> String {\n",
      'func rejectJson(for error: Error) -> String {\n    _ = "window.slogaShell"\n',
      SUPPORT,
    );
  });

  test("the contract's other shape: the literal inline, built where it is added", () => {
    // A positive: the script literal passed straight as `source:`, its
    // interpolation a ternary over a let bound to the Info.plist read.
    worldClean(
      "G8c-ios-caps",
      [W_BRIDGE_FILE, `${W_CAPS_LINE}\n`, '        return ""\n'],
      [
        W_BRIDGE_FILE,
        "                source: Self.capsScriptSource(mediaE2EE: mediaE2EE),\n",
        `                source: ${W_CAPS_LINE.trim().slice("return ".length)},\n`,
      ],
      [
        W_BRIDGE_FILE,
        "            let script = WKUserScript(",
        '            let flag = mediaE2EE ? "true" : "false"\n            let script = WKUserScript(',
      ],
    );
  });
});

const W_ATTACH = "                KeysChangedRelay.attach(e2ee)\n";
const W_REGISTER_E2EE = "                bridge.registerPluginInstance(e2ee)\n";
describe("W2 Stage 5: the key push attached to the registered instance (G8b-relay-attach)", () => {
  test("attached from E2eePlugin.load (the MINOR 3 shape)", () => {
    const mutation = [
      PLUGIN,
      "        super.load()\n",
      "        super.load()\n        KeysChangedRelay.attach(self)\n",
    ];
    worldExpect(
      "G8b-relay-attach",
      ["KeysChangedRelay.attach in E2eePlugin.swift"],
      mutation,
    );
    worldExpect("G8b-relay-attach", ["(found 2)"], mutation);
  });

  test("never attached", () => {
    worldExpect(
      "G8b-relay-attach",
      ["(found 0)"],
      [W_BRIDGE_FILE, W_ATTACH, ""],
    );
  });

  test("attached to a fresh instance, not the registered one", () => {
    worldExpect(
      "G8b-relay-attach",
      ["exactly one KeysChangedRelay.attach(x)"],
      [
        W_BRIDGE_FILE,
        W_ATTACH,
        "                KeysChangedRelay.attach(E2eePlugin())\n",
      ],
    );
  });

  test("attached before the instance is registered", () => {
    worldExpect(
      "G8b-relay-attach",
      ["exactly one KeysChangedRelay.attach(x)"],
      [
        W_BRIDGE_FILE,
        `${W_REGISTER_E2EE}                // The key push goes to this instance only.\n${W_ATTACH}`,
        `${W_ATTACH}${W_REGISTER_E2EE}`,
      ],
    );
  });

  test("attached outside the guarded block", () => {
    worldExpect(
      "G8b-relay-attach",
      ["exactly one KeysChangedRelay.attach(x)"],
      [
        W_BRIDGE_FILE,
        "                E2eePlugin.arm()\n                SlogaCallAudioPlugin.arm()\n                let e2ee = E2eePlugin()\n" +
          `${W_REGISTER_E2EE}                // The key push goes to this instance only.\n${W_ATTACH}`,
        "                E2eePlugin.arm()\n                SlogaCallAudioPlugin.arm()\n",
      ],
      [
        W_BRIDGE_FILE,
        "        if let bridge = bridge {\n",
        `        let e2ee = E2eePlugin()\n        bridge?.registerPluginInstance(e2ee)\n        KeysChangedRelay.attach(e2ee)\n        if let bridge = bridge {\n`,
      ],
    );
  });

  test("a second E2eePlugin instance built next to the registered one", () => {
    worldExpect(
      "G8b-relay-attach",
      ["exactly one KeysChangedRelay.attach(x)"],
      [
        W_BRIDGE_FILE,
        "                let e2ee = E2eePlugin()\n",
        "                let e2ee = E2eePlugin()\n                _ = E2eePlugin()\n",
      ],
    );
  });

  test("the attach function taken as a value", () => {
    worldExpect(
      "G8b-relay-attach",
      ["(found 2)"],
      [
        SUPPORT,
        "func rejectJson(for error: Error) -> String {\n",
        "func rejectJson(for error: Error) -> String {\n    _ = KeysChangedRelay.attach\n",
      ],
    );
  });
});

describe("W2 Stage 5: the bridge's eval channels (G8b-event)", () => {
  for (const [what, line] of [
    ["eval(js:)", '            bridge.eval(js: "window.x = 1")\n'],
    [
      "evalWithPlugin",
      '            bridge.evalWithPlugin(E2eePlugin.self, js: "window.x = 1")\n',
    ],
  ]) {
    test(`${what} from the bridge view controller`, () => {
      worldExpect(
        "G8b-event",
        ["would reach the page outside the one pinned event"],
        [
          W_BRIDGE_FILE,
          "        if let bridge = bridge {\n",
          `        if let bridge = bridge {\n${line}`,
        ],
      );
    });
  }
});

describe("W2 Stage 5: no logging anywhere (G8b-log)", () => {
  for (const [what, line] of [
    ["print", "        print(groupId)\n"],
    ["debugPrint", "        debugPrint(epoch)\n"],
    ["NSLog", '        NSLog("%@", groupId)\n'],
    ["os_log", '        os_log("%{public}@", groupId)\n'],
    ["dump", "        dump(groupId)\n"],
    [
      "Logger",
      '        Logger(subsystem: "gg.sloga", category: "e2ee").debug("\\(groupId)")\n',
    ],
    ["CAPLog", '        CAPLog.print("x")\n'],
    ["print as a value", "        [groupId].forEach(print)\n"],
  ]) {
    test(`${what} in the key-push callback`, () => {
      worldExpect(
        "G8b-log",
        ["nothing here is logged"],
        [
          W_RELAY_FILE,
          "        deliver(groupId, epoch)\n",
          `        deliver(groupId, epoch)\n${line}`,
        ],
      );
    });
  }

  test("a parameter label named print is not logging", () => {
    worldClean("G8b-log", [
      SUPPORT,
      "func rejectJson(for error: Error) -> String {\n",
      "func rejectJson(for error: Error) -> String {\n    _ = String(describing: error, print: false)\n",
    ]);
  });
});

describe("W2 Stage 5: the call audio plugin is final (G8c-audio-plugin)", () => {
  test("not final", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["must be declared final"],
      [
        W_AUDIO_FILE,
        "public final class SlogaCallAudioPlugin",
        "public class SlogaCallAudioPlugin",
      ],
    );
  });

  test("open", () => {
    worldExpect(
      "G8c-audio-plugin",
      ["must be declared final"],
      [
        W_AUDIO_FILE,
        "public final class SlogaCallAudioPlugin",
        "open class SlogaCallAudioPlugin",
      ],
    );
  });

  test("the E2ee plugin registered inline still counts as its registration", () => {
    // The pre-Stage-5 form, without the attach the relay rule wants: only
    // the audio rule's view of the registration is checked here.
    worldClean(
      "G8c-audio-plugin",
      [
        W_BRIDGE_FILE,
        `                let e2ee = E2eePlugin()\n${W_REGISTER_E2EE}`,
        "                bridge.registerPluginInstance(E2eePlugin())\n",
      ],
      [W_BRIDGE_FILE, W_ATTACH, ""],
    );
  });
});

describe("phase 2 rules on the real tree's own shapes", () => {
  const REAL_RELAY = `${SOURCES}/KeysChangedRelay.swift`;
  const REAL_AUDIO = `${SOURCES}/CallAudioSession.swift`;
  const REAL_BRIDGE = `${SOURCES}/SlogaBridgeViewController.swift`;

  test("a second call arm fetching frame keys", () => {
    expectViolation("G8b-frame-keys", [
      PLUGIN,
      '            return try engine.callState(groupId: args.string("groupId"))\n',
      '            _ = try engine.callFrameKeys(groupId: args.string("groupId"))\n            return try engine.callState(groupId: args.string("groupId"))\n',
    ]);
  });

  test("an extra key in the relay payload", () => {
    expectViolationWith(
      "G8b-event",
      ["the payload keys are exactly group_id and epoch"],
      [
        REAL_RELAY,
        '"epoch": NSNumber(value: epoch)]',
        '"epoch": NSNumber(value: epoch), "x": groupId]',
      ],
    );
  });

  test("the key push attached back in E2eePlugin.load", () => {
    expectViolationWith(
      "G8b-relay-attach",
      ["KeysChangedRelay.attach in E2eePlugin.swift"],
      [
        PLUGIN,
        "        super.load()\n",
        "        super.load()\n        KeysChangedRelay.attach(self)\n",
      ],
    );
  });

  test("the call audio plugin no longer final", () => {
    expectViolationWith(
      "G8c-audio-plugin",
      ["must be declared final"],
      [
        REAL_AUDIO,
        "public final class SlogaCallAudioPlugin",
        "public class SlogaCallAudioPlugin",
      ],
    );
  });

  test("the caps script in every frame", () => {
    expectViolation("G8c-ios-caps", [
      REAL_BRIDGE,
      "forMainFrameOnly: true",
      "forMainFrameOnly: false",
    ]);
  });

  test("a third audio plugin method", () => {
    expectViolation("G8c-audio-plugin", [
      REAL_AUDIO,
      '        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),\n',
      '        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),\n        CAPPluginMethod(name: "route", returnType: CAPPluginReturnPromise),\n',
    ]);
  });
});

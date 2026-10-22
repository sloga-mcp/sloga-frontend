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
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
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
const SCRIPT = join(here, "check-ios-e2ee-commands.mjs");
const ROOT = dirname(here);

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
      /^ok: table generic 37, native 2, dedicated 6, out \d+;/,
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

  test("serveAttachmentForRender called from AttachmentTransfer.swift", () => {
    expectViolation("G8b-native-only", [
      `${SOURCES}/AttachmentTransfer.swift`,
      '            request.httpMethod = "GET"\n',
      '            request.httpMethod = "GET"\n            _ = try engine.serveAttachmentForRender(messageId: localId, idx: 0)\n',
    ]);
  });

  test("the orphaned recovery bundle taken from another arm", () => {
    expectViolation("G8b-plugin-crossfile", [
      PLUGIN,
      "return try engine.backupStatus()",
      "return try RecoverySheet.takeOrphanedBundle() ?? engine.backupStatus()",
    ]);
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
    expectViolation("G8a-route", [
      COMMANDS,
      '("e2ee_mls_replenish", .out),',
      '("e2ee_mls_replenish", .generic),',
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

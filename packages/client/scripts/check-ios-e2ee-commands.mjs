#!/usr/bin/env node
/**
 * Gates G6, G7 and G8 of the iOS E2EE port (plan
 * discord-features-plans/ios-e2ee-messaging-port.md D1, D5, §5, D10, and the
 * W3 binding rules), extended for iOS call E2EE phase 2 (plan
 * ios-call-e2ee-phase2.md, Wave 2 contracts C-W2-1..8: the `.call` route,
 * the callKeysChanged event, the SlogaCallAudio plugin and the
 * __slogaIosCaps user script). A source scan of the Swift plugin package
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
 *                      `.native`, `.call`, `.out` or `.dedicated("m")`, one
 *                      per line; `dedicatedMethods` is one `"m",` per line
 *   G6-table-duplicate a name listed twice (any route)
 *   G6-count           generic 37 / native 2 / call 22 / dedicated 7 / out 32,
 *                      each equal to its static <route>Count (all five must
 *                      exist)
 *   G6-table-route     the generic, native, call and dedicated sets are
 *                      exactly the contract's (names and dedicated method per
 *                      name; phase 2 adds the 22 call-plane names and
 *                      e2ee_call_confirm_downgrade → callConfirmDowngrade)
 *   G6-dedicated-order `dedicatedMethods` is the 13 methods in contract order
 *                      (callConfirmDowngrade right after acceptIdentityChange)
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
 *   G6-call-case       runCallPlane's `switch name`, as G6-generic-case, with
 *                      exactly the 22 call names
 *   G6-call-binding    every call name maps to an E2eeEngine method, as
 *                      G6-generic-binding
 *   G6-call-arm        each call arm calls exactly its own engine method
 *   G6-plugin-engine-call an engine call in E2eePlugin.swift is either in a
 *                      generic or call arm or a gated call in its dedicated
 *                      method
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
 *                      acceptIdentityChange/callConfirmDowngrade on an engine
 *                      value only inside
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
 *                      `engineWorker.submit` closure (the NEAREST worker
 *                      closure around the call decides)
 *   G7-call-worker     runCallPlane likewise, from a `callWorker.submit`
 *                      closure; and E2eeRuntime declares `let callWorker =
 *                      WorkerPool(name: "gg.sloga.e2ee.call", threads: 1)`
 *                      once (its own serial queue, C-W2-2)
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
 *   G8a-export         the call/mls/rc/pinCallIdentities-shaped surface of the
 *                      bindings (functions and uniffi symbols) is exactly the
 *                      23 contract call-plane methods (CALL_EXPORTS), each
 *                      exported and each routed as the contract says (22
 *                      `.call`, callConfirmDowngrade `.dedicated`); any rc,
 *                      extra call or mls, or free `func_call_` symbol fails
 *   G8a-route          a call/mls/rc/pin-shaped table name is routed only as
 *                      the contract says: the 22 call-plane names `.call`,
 *                      e2ee_call_confirm_downgrade `.dedicated`, every other
 *                      one (rc_*, mls_group_kind, …) `.out` (phase 2 reversed
 *                      the W3 "all .out")
 *   G8a-unclassified   every exported E2eeEngine method is a generic or call
 *                      target, a gated method or a native-only method listed
 *                      here
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
 *                      bundle, not an engine value; RecoverySheet.
 *                      bundleWaitingHook only from `load`)
 *   G8b-event          exactly two page events. (1) "backupBundleWaiting" with
 *                      an EMPTY payload: `notifyListeners(` appears in
 *                      E2eePlugin.swift only in load, inside the `[weak self]
 *                      event, data in` closure handed to
 *                      backupBundleWaitingEmitter, forwarding exactly
 *                      `(event, data: data)`; inside that emitter every
 *                      mention of its `emit` parameter is exactly
 *                      `emit(Self.backupBundleWaitingEvent, [:])`; and
 *                      backupBundleWaitingEvent is that literal name (audit M2:
 *                      never the bundle, never an id). (2) "callKeysChanged":
 *                      emitted exactly once, from KeysChangedRelay.swift, in
 *                      the DispatchQueue.main.async closure inside the
 *                      `{ groupId, epoch in }` closure of `static let shared =
 *                      KeysChangedRelay …`, as exactly
 *                      `(KeysChangedRelay.event, data: ["group_id": groupId,
 *                      "epoch": epoch | NSNumber(value: epoch)])`; the name
 *                      is the constant, declared once as `static let event =
 *                      "callKeysChanged"`, and that literal appears nowhere
 *                      else. No other file calls notifyListeners;
 *                      triggerJSEvent and the other page-script channels
 *                      (evaluateJavaScript, callAsyncJavaScript, the bridge's
 *                      eval(js:) and evalWithPlugin) are not used anywhere
 *   G8b-relay-attach   the key push goes to the ONE registered E2ee plugin:
 *                      `KeysChangedRelay.attach` is named exactly once in the
 *                      sources, as `KeysChangedRelay.attach(x)` in
 *                      SlogaBridgeViewController.swift, where `x` is bound
 *                      once as `let x = E2eePlugin()` (the only E2eePlugin
 *                      construction in the sources), and the call follows
 *                      `registerPluginInstance(x)` directly, in the same
 *                      guarded block; never in E2eePlugin.swift (a second
 *                      instance Capacitor creates by class name runs load()
 *                      and must not take the push; W2 Stage 5 MINOR 3)
 *   G8b-log            no logging in any Swift source (frame keys pass
 *                      through Swift): print, debugPrint, NSLog, os_log,
 *                      dump, Logger and CAPLog are not named at all (a call,
 *                      or a reference passed as a function)
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
 *                      refresh arm's `orphaned`, which must be bound only as
 *                      `if let orphaned = RecoverySheet.takeOrphanedBundle(
 *                      label: name)` and appear otherwise only as a bare
 *                      `return orphaned`); and inside any function
 *                      that can reach a native-only method, `E2eeReject(json:`,
 *                      `invalidArgument(` and `Failure(message:` (all three
 *                      reach the webview through rejectJson) take one plain
 *                      literal
 *   G8b-stash          (b) cannot see a closure parked in storage by a LISTED
 *                      caller. So (1) inside every NATIVE_ONLY_CALLERS
 *                      function, an assignment (`=`, `+=`) to anything but a
 *                      local let/var of that function has no `{`, no
 *                      function reference (a source function or engine
 *                      method named but not called, or an `f(a:b:)`
 *                      selector) and no local holding one on its right side
 *                      (an init may set its own type's listed property); and
 *                      (2) every function-typed stored property (`->`,
 *                      `@convention` or a function typealias in its type, or
 *                      an inferred/Any one initialized with a closure or a
 *                      function reference), initialized or not, is pinned in
 *                      STORED_CLOSURES, and no enum case has a function
 *                      payload
 *   G8b-frame-keys     callFrameKeys (frame-key material: the one key egress
 *                      to the webview) is named only in runCallPlane's
 *                      `case "e2ee_call_frame_keys"`, and in the call graph
 *                      the ONLY node that can reach a mention of it is that
 *                      arm (a helper, a stored closure, a second arm or a
 *                      second runCallPlane caller all fail)
 *   G8c-audio-plugin   the Capacitor plugin classes are exactly E2eePlugin and
 *                      SlogaCallAudioPlugin; the latter (CallAudioSession.swift)
 *                      is `@objc(SlogaCallAudioPlugin) … final class …:
 *                      CAPPlugin, CAPBridgedPlugin` (final, never open: a
 *                      subclass would escape this rule), jsName "SlogaCallAudio",
 *                      pluginMethods exactly the literal promise methods start
 *                      and stop, no other @objc member, and no name of the
 *                      E2EE core; it is armed then built once, in the
 *                      bridge view controller's guarded block with the E2ee
 *                      plugin
 *   G8c-ios-caps       one string literal names __slogaIosCaps (in
 *                      SlogaBridgeViewController.swift), decoded exactly
 *                      `Object.defineProperty(window,"__slogaIosCaps",{value:
 *                      Object.freeze({mediaE2EE:\(b)}),writable:false,
 *                      configurable:false,enumerable:false});` with ONE
 *                      interpolation, a literal bool (`let x = c ? "true" :
 *                      "false"`, c resolving, directly or through the one
 *                      Bool parameter of the function returning the literal,
 *                      to the Info.plist read `Bundle.main.object(
 *                      forInfoDictionaryKey: "SlogaMediaE2EE") as? String ==
 *                      "YES"`); one WKUserScript( in the sources, exactly
 *                      (source: <it>, injectionTime: .atDocumentStart,
 *                      forMainFrameOnly: true); one addUserScript( beside it;
 *                      slogaShell named nowhere. The script's location is not
 *                      pinned (Capacitor replaces webViewConfiguration's
 *                      userContentController, so it is added in
 *                      capacitorDidLoad)
 *   G8b-ffi            the sources never touch the raw FFI: no
 *                      acutest_e2ee_iosFFI (import or name), uniffi*,
 *                      ffi_acutest_*, RustCallStatus, rustCall*, RustBuffer,
 *                      ForeignBytes, FfiConverter*, @_silgen_name, @_cdecl,
 *                      dlsym/dlopen, and no string literal naming a uniffi /
 *                      ffi_acutest_ symbol
 *
 * The G8b call graph (conservative: it may report a path that cannot run,
 * it must not miss one that can):
 *   - nodes: every func/init/subscript/computed property (closures and
 *     accessors belong to their enclosing function; nested funcs are their
 *     own nodes), every stored-property initializer outside a function (one
 *     node per property, reached by naming the property), and one node per
 *     runGeneric / runCallPlane / nativeJob arm;
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
 *   - roots: the plugin's `call` (its runGeneric/runCallPlane/nativeJob
 *     calls are replaced by the arms, each its own root), every arm, every
 *     `@objc func m(_: CAPPluginCall)` of ANY file (the dedicated methods,
 *     SlogaCallAudio's start/stop), every func named webView or
 *     userContentController, every `override` func of a type inheriting from
 *     a CAP* class, and the `confirm` of a NativeConfirm type and the
 *     `keysChanged` of a NativeKeysChanged type (core calls both
 *     mid-command).
 *   Limits: a call through a value whose name is not a function or property
 *   of these sources (a closure parameter or a stored property with no
 *   initializer) adds no edge; (b) is what still catches the code that made
 *   the value when it is not a listed caller, and G8b-stash when it is.
 *   Not covered: a native-only RESULT (data, not a closure) written by a
 *   listed caller into storage another path reads; a closure handed as an
 *   ARGUMENT to a setter or method that stores it in an allowlisted
 *   property (G8b-stash looks at `=` / `+=` only). Dispatch from SDK code into our overrides (UIKit lifecycle,
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
/**
 * The MLS call plane on the `call` mux, run on the CALL worker by
 * runCallPlane (phase 2 C-W2-3): each name → the engine method of the same
 * camelCased name.
 */
const CALL = [
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
/** FE command → its dedicated plugin method. */
const DEDICATED = {
  e2ee_wipe: "wipe",
  e2ee_downgrade: "downgrade",
  e2ee_enable_group: "enableGroup",
  e2ee_add_group_member: "addGroupMember",
  e2ee_mark_verified: "markVerified",
  e2ee_accept_identity_change: "acceptIdentityChange",
  e2ee_call_confirm_downgrade: "callConfirmDowngrade",
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
  "callConfirmDowngrade",
  "backupCreate",
  "backupRotate",
  "backupRestore",
  "attachmentUpload",
  "attachmentFetch",
];
const COUNTS = { generic: 37, native: 2, call: 22, dedicated: 7, out: 32 };
/** Every route of the table, in the order the counts are reported. */
const ROUTES = ["generic", "native", "call", "dedicated", "out"];

/**
 * The call-plane engine methods the bindings must export (G8a-export): the
 * 22 `.call` targets and the confirm-gated callConfirmDowngrade. Every other
 * call/mls/rc-shaped export is refused.
 */
const CALL_EXPORTS = [
  ...CALL.map((name) => lowerCamel(name.slice("e2ee_".length))),
  "callConfirmDowngrade",
];

/** Confirm-gated engine method → the one plugin method that may call it. */
const GATED = {
  wipe: "wipe",
  downgrade: "downgrade",
  enableGroup: "enableGroup",
  addGroupMember: "addGroupMember",
  markVerified: "markVerified",
  acceptIdentityChange: "acceptIdentityChange",
  confirmPeerDowngrade: "confirmPeerDowngradeAccept",
  callConfirmDowngrade: "callConfirmDowngrade",
};

/** The one key egress to the webview, and the only arm that may reach it. */
const FRAME_KEYS_METHOD = "callFrameKeys";
const FRAME_KEYS_COMMAND = "e2ee_call_frame_keys";
const FRAME_KEYS_ARM = `E2eePlugin.runCallPlane[${FRAME_KEYS_COMMAND}]`;

/** G8b-event: the key-push event (phase 2 C-W2-1). */
const KEYS_EVENT = {
  file: "KeysChangedRelay.swift",
  type: "KeysChangedRelay",
  name: "callKeysChanged",
};

/** G8c-audio-plugin: the call audio plugin (phase 2 C-W2-5). */
const AUDIO = {
  file: "CallAudioSession.swift",
  type: "SlogaCallAudioPlugin",
  jsName: "SlogaCallAudio",
  methods: ["start", "stop"],
};
/** The Capacitor plugin classes of these sources; any other is new webview surface. */
const PLUGIN_CLASSES = ["E2eePlugin", AUDIO.type];
/** Names CallAudioSession.swift may not mention: it never reaches the core. */
const AUDIO_FORBIDDEN =
  /\b(?:E2eeEngine|E2eeEngineProtocol|E2eeRuntime|E2eePlugin|KeysChangedRelay|RecoverySheet|AttachmentTransfer|NativeConfirmPresenter)\b/g;

/** G8c-ios-caps: the one page global (phase 2 C-W2-6). */
const CAPS = {
  file: "SlogaBridgeViewController.swift",
  global: "__slogaIosCaps",
  before:
    'Object.defineProperty(window,"__slogaIosCaps",{value:Object.freeze({mediaE2EE:',
  after: "}),writable:false,configurable:false,enumerable:false});",
  /** The bool, whitespace-free outside literals; parenthesized form too. */
  bools: [
    'Bundle.main.object(forInfoDictionaryKey:"SlogaMediaE2EE")as?String=="YES"',
    '(Bundle.main.object(forInfoDictionaryKey:"SlogaMediaE2EE")as?String)=="YES"',
  ],
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
  recoveryDiscardPending: ["RecoverySheet.swift"],
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
  // M2: the plugin installs the "bundle waiting" notifier when it loads.
  "RecoverySheet.bundleWaitingHook": ["load"],
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
  /\b\w*_(method_e2eeengine|func)_((?:call|mls|rc)_\w*|pin_call_identities)\b/g;

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
    // Literal text runs and interpolated code spans, in order (G8c-ios-caps
    // needs to know WHERE the interpolations sit; `value` drops them).
    const parts = [];
    let text = "";
    for (;;) {
      if (k >= n) fail(start, "unterminated string literal");
      if (!multi && src[k] === "\n") fail(start, "unterminated string literal");
      if (src.startsWith(close, k)) break;
      if (src.startsWith(escape, k)) {
        const after = k + escape.length;
        if (src[after] === "(") {
          interpolated = true;
          blank(segment, after);
          const closeParen = scanCode(after + 1, true);
          parts.push({ text });
          parts.push({ code: [after + 1, closeParen] });
          text = "";
          k = closeParen + 1;
          segment = k;
          continue;
        }
        value += src.slice(k, after + 1);
        text += src.slice(k, after + 1);
        k = after + 1;
        continue;
      }
      value += src[k];
      text += src[k];
      k++;
    }
    parts.push({ text });
    blank(segment, k);
    const end = k + close.length;
    blank(start, quote + openLength);
    out[start] = '"';
    blank(k, end);
    out[end - 1] = '"';
    strings.set(start, {
      start,
      end,
      value,
      interpolated,
      parts,
      hashes,
      multi,
    });
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
    /^\s*\(\s*"\s*"\s*,\s*\.(generic|native|call|out|dedicated\s*\(\s*"\s*"\s*\))\s*\)\s*,\s*$/;
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
        'table line is not `("e2ee_x", .generic|.native|.call|.out|.dedicated("m")),`',
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
  for (const k of ROUTES) {
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
  for (const k of ROUTES) {
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
  sameSet("call", CALL);
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
  // G8a-route (phase 2 reversal): a call/mls/rc-shaped name is routed only
  // as the contract says (the 22 call-plane names .call, the whole-call
  // downgrade .dedicated); every other one, rc_* included, stays .out.
  for (const e of parsed.entries) {
    if (!OUT_COMMAND.test(e.name)) continue;
    const want = CALL.includes(e.name)
      ? "call"
      : has(DEDICATED, e.name)
        ? "dedicated"
        : "out";
    if (e.route !== want) {
      add(
        "G8a-route",
        file,
        e.p,
        `${e.name} is .${e.route}; the contract routes it .${want} (only the 22 call-plane names are .call and e2ee_call_confirm_downgrade .dedicated; every other call/mls/rc name is .out)`,
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

function parseBindings(file, add, table) {
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

  checkCallExports(file, methods, table, add);
  return methods;
}

/**
 * G8a-export (phase 2): the call/mls/rc-shaped surface of the bindings is
 * exactly CALL_EXPORTS, and each of them is routed as the contract says
 * (`.call`, or callConfirmDowngrade `.dedicated`). Anything else of that
 * shape (an rc* export, an extra call*, a free `func_call_*` symbol) fails,
 * as does a contract method the bindings do not export.
 */
function checkCallExports(file, methods, table, add) {
  const allowedSnakes = new Set([
    ...CALL.map((name) => name.slice("e2ee_".length)),
    ...Object.keys(DEDICATED)
      .filter((name) => OUT_COMMAND.test(name))
      .map((name) => name.slice("e2ee_".length)),
  ]);
  const seen = new Set();
  for (const m of file.code.matchAll(
    /\bfunc\s+((?:call|mls|rc)[A-Z0-9]\w*|pinCallIdentities)\s*[(<]/g,
  )) {
    if (CALL_EXPORTS.includes(m[1])) continue;
    seen.add(file.line(m.index));
    add(
      "G8a-export",
      file,
      m.index,
      `the bindings export ${m[1]}, not a contract call-plane method`,
    );
  }
  for (const m of file.code.matchAll(OUT_FFI_SYMBOL)) {
    if (m[1] === "method_e2eeengine" && allowedSnakes.has(m[2])) continue;
    const line = file.line(m.index);
    if (seen.has(line)) continue;
    seen.add(line);
    add(
      "G8a-export",
      file,
      m.index,
      `the bindings carry uniffi symbol ${m[0]}, not a contract call-plane method`,
    );
  }
  for (const method of methods.values()) {
    if (!OUT_EXPORT_NAME.test(method.name)) continue;
    if (!CALL_EXPORTS.includes(method.name)) {
      add("G8a-export", file, method.p, `E2eeEngine exports ${method.name}`);
      continue;
    }
    const command = `e2ee_${method.snake ?? ""}`;
    const want =
      method.name === GATED.callConfirmDowngrade
        ? `.dedicated("${method.name}")`
        : ".call";
    const entry = table.get(command);
    const got = !entry
      ? "missing"
      : entry.route === "dedicated"
        ? `.dedicated("${entry.method}")`
        : `.${entry.route}`;
    if (got !== want) {
      add(
        "G8a-export",
        file,
        method.p,
        `E2eeEngine exports ${method.name}; its command ${command} must be ${want}, is ${got}`,
      );
    }
  }
  for (const name of CALL_EXPORTS) {
    if (!methods.has(name)) {
      add(
        "G8a-export",
        file,
        null,
        `contract call-plane method ${name} is not an E2eeEngine export`,
      );
    }
  }
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
  "recoveryDiscardPending",
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
  "RecoverySheet.discardMintedState(_:)",
  "RecoverySheet.takeRepublish(_:)",
];
/** Native export entry points: every function-level return is one of these. */
const FIXED_RESOLVES = {
  "AttachmentTransfer.copyImage(messageId:idx:)": ["null"],
  "AttachmentTransfer.save(messageId:idx:)": ["true", "false"],
};
/**
 * Extra names a generic arm may return besides its own engine call, each
 * with the one call it must be bound from (audit S6 MINOR-1: a name alone
 * let `if let orphaned = <anything>` through).
 */
const ARM_RETURN_EXTRAS = {
  e2ee_backup_refresh_if_due: {
    orphaned: "RecoverySheet.takeOrphanedBundle",
  },
};
/**
 * The function-typed STORED properties of these sources (a closure type, a
 * collection or optional of one, or a typealias of one), as `Type.name`.
 * Any other one, initialized or not, is G8b-stash: a closure parked in a
 * stored property and called later is a path the call graph cannot follow.
 * Computed properties are not storage and are not listed.
 */
const STORED_CLOSURES = [
  "AttachmentSchemeHandler.decrypt",
  "FlowRegistry.provider",
  "FlowRegistry.waitingHook",
  // Phase 2 key push: the injectable delivery closure and the shared relay
  // built from one (KeysChangedRelay.swift; G8b-event pins what it emits).
  "KeysChangedRelay.deliver",
  "KeysChangedRelay.shared",
  "NativeConfirmPresenter.presenter",
  "RecoverySheetController.dismissWaiters",
  "WorkerPool.jobs",
];
/** Raw FFI in the sources: everything goes through the generated E2eeEngine. */
const RAW_FFI =
  /\bimport\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?acutest_e2ee_iosFFI\b|\bacutest_e2ee_iosFFI\b|\buniffi\w*|\bffi_acutest_\w*|\bRustCallStatus\b|\brustCall\w*|\bRustBuffer\b|\bForeignBytes\b|\bFfiConverter\w*|@_silgen_name\b|@_cdecl\b|\bdl(?:sym|open)\b/g;
const RAW_FFI_LITERAL = /uniffi|ffi_acutest_|acutest_e2ee_iosFFI/;
/** `@objc func m(_ call: CAPPluginCall)`: a method Capacitor can call. */
const OBJC_PLUGIN_CALL =
  /@objc(?:\([^)]*\))?(?:\s+(?:public|internal|open|final|dynamic))*\s+func\s+(\w+)\s*\(\s*_\s+\w+\s*:\s*CAPPluginCall\s*\)/g;

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
  const {
    swift,
    plugin,
    runGeneric,
    armNames,
    nativeJob,
    nativeArms,
    runCallPlane,
    callArmNames,
  } = ctx;
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
  const callArmNodes = armNodes(
    runCallPlane,
    [...callArmNames.values()],
    "runCallPlane",
  );
  const dispatchers = new Map([
    [byFrame.get(runGeneric), genericArmNodes],
    [byFrame.get(nativeJob), nativeArmNodes],
    [byFrame.get(runCallPlane), callArmNodes],
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
  addRoot(byFrame.get(runCallPlane));
  genericArmNodes.forEach(addRoot);
  nativeArmNodes.forEach(addRoot);
  callArmNodes.forEach(addRoot);
  for (const [name, o] of ctx.objc)
    if (name !== "call") addRoot(byFrame.get(o.frame));
  // Any Capacitor-callable method of ANY file (the SlogaCallAudio plugin's
  // start/stop, phase 2) is a webview entry too.
  for (const f of swift) {
    for (const m of f.code.matchAll(OBJC_PLUGIN_CALL)) {
      const declPos = m.index + m[0].indexOf("func");
      const fr = f.frames.find(
        (x) => x.kind === "func" && x.declPos === declPos,
      );
      if (fr) addRoot(byFrame.get(fr));
    }
  }
  for (const n of nodes) {
    if (n.name === "webView" || n.name === "userContentController") addRoot(n);
    if (!n.frame) continue;
    const type = frameAt(n.file, n.p, (fr) => fr.kind === "type");
    // The NativeConfirm and NativeKeysChanged callbacks: core calls them
    // during webview commands.
    if (
      ((n.name === "confirm" &&
        /:[^{]*\bNativeConfirm\b/.test(
          type ? n.file.code.slice(type.declPos, type.open) : "",
        )) ||
        (n.name === "keysChanged" &&
          /:[^{]*\bNativeKeysChanged\b/.test(
            type ? n.file.code.slice(type.declPos, type.open) : "",
          ))) &&
      type
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

  // (d) G8b-frame-keys: callFrameKeys (frame-key material, the one key
  // egress) is reachable ONLY from runCallPlane's own arm. Every node that
  // names it, or can reach a node that names it, must be that arm: a helper,
  // a stored closure, a second arm or another root calling runCallPlane (a
  // dispatcher edge reaches every arm) all fail.
  const fkRe = new RegExp(`\\b${FRAME_KEYS_METHOD}\\b`);
  const fkNames = new Set(
    nodes.filter((n) =>
      n.ranges.some(([a, b]) => fkRe.test(n.file.code.slice(a, b))),
    ),
  );
  const fkReach = new Set(fkNames);
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes) {
      if (!fkReach.has(n) && n.edges.some((e) => fkReach.has(e))) {
        fkReach.add(n);
        changed = true;
      }
    }
  }
  for (const n of fkReach) {
    if (n.id === FRAME_KEYS_ARM) continue;
    const path = pathTo(n, (x) => fkNames.has(x));
    add(
      "G8b-frame-keys",
      n.file,
      n.p,
      `${show(path, FRAME_KEYS_METHOD)} (only ${FRAME_KEYS_ARM} may reach ${FRAME_KEYS_METHOD})`,
    );
  }
  if (![...fkNames].some((n) => n.id === FRAME_KEYS_ARM)) {
    add(
      "G8b-frame-keys",
      ctx.plugin,
      null,
      `${FRAME_KEYS_ARM} not found or does not name ${FRAME_KEYS_METHOD}`,
    );
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
  for (const n of nodes) {
    if (!n.arm) continue;
    // A call-plane arm hands back only its own engine call's result, like a
    // generic arm (the frame-keys arm's result is the one key egress).
    const dispatcher = n.id.includes("runGeneric[")
      ? ctx.runGeneric
      : n.id.includes("runCallPlane[")
        ? ctx.runCallPlane
        : null;
    if (!dispatcher) continue;
    const own = ctx.targetOf(n.arm)?.name;
    for (const r of returnsIn(n, dispatcher)) {
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
        ...(has(ARM_RETURN_EXTRAS, n.arm)
          ? Object.keys(ARM_RETURN_EXTRAS[n.arm])
          : []),
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
  checkArmExtras(nodes, add);
  checkStash(ctx, nodes, reaches, add);
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

/**
 * An ARM_RETURN_EXTRAS name is bound ONLY as `if let`/`guard let <name> =
 * <its call>(label: ident, …)` and otherwise appears only as a bare
 * `return <name>`. Any other mention (a second binding, a reassignment, a
 * closure parameter, an argument) fails.
 */
function checkArmExtras(nodes, add) {
  for (const n of nodes) {
    if (!n.arm || n.id.indexOf("runGeneric[") < 0) continue;
    if (!has(ARM_RETURN_EXTRAS, n.arm)) continue;
    const code = n.file.code;
    for (const [name, source] of Object.entries(ARM_RETURN_EXTRAS[n.arm])) {
      const [recv, fn] = source.split(".");
      const bind = new RegExp(`^\\s*=\\s*${recv}\\s*\\.\\s*${fn}\\s*\\(`);
      let bound = 0;
      for (const [a, b] of n.ranges) {
        const re = new RegExp(`\\b${name}\\b`, "g");
        re.lastIndex = a;
        for (let m; (m = re.exec(code)) && m.index < b; ) {
          const before = code.slice(Math.max(a, m.index - 40), m.index);
          const after = code.slice(m.index + name.length, b);
          const head = bind.exec(after);
          if (/\b(?:if|guard)\s+let\s+$/.test(before) && head) {
            const open = m.index + name.length + head[0].length - 1;
            const close = n.file.match.get(open);
            const args = code.slice(open + 1, close);
            const plainArgs =
              /^\s*(?:[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*\s*(?:,\s*)?)*$/.test(
                args,
              ) && !/,\s*$/.test(args);
            if (plainArgs && /^\s*(?:\{|else\b)/.test(code.slice(close + 1))) {
              bound++;
              continue;
            }
          } else if (
            /\breturn\s+$/.test(before) &&
            /^[ \t]*(?:\n|;|\})/.test(after)
          ) {
            continue;
          }
          add(
            "G8b-return",
            n.file,
            m.index,
            `case "${n.arm}": ${name} may only be bound as \`if let ${name} = ${source}(label: name)\` and returned bare`,
          );
        }
      }
      if (!bound) {
        add(
          "G8b-return",
          n.file,
          n.p,
          `case "${n.arm}" never binds ${name} from ${source}(…); update ARM_RETURN_EXTRAS`,
        );
      }
    }
  }
}

/**
 * G8b-stash (audit S6 MINOR-1). Reachability follows names; a closure parked
 * in storage and called later through it is followed only when the storage
 * has an initializer. So:
 *   (1) inside every function that can reach a native-only method (the
 *       NATIVE_ONLY_CALLERS set), the right side of an assignment (`=`, `+=`)
 *       to anything but a local `let`/`var` of that function holds no `{`
 *       (closure literal, trailing closure), no function reference (a
 *       function or engine method named but not called, or a `f(a:b:)`
 *       selector) and no local that holds one; an init of a type may set its
 *       own STORED_CLOSURES property;
 *   (2) every function-typed stored property (type annotation with `->`,
 *       `@convention` or a function typealias; or an initializer holding a
 *       closure that is not called on the spot or a function reference),
 *       with an initializer or without, is listed in STORED_CLOSURES, and no
 *       enum case carries a function-typed payload.
 */
function checkStash(ctx, nodes, reaches, add) {
  const { swift, engineMethods } = ctx;
  const aliasDefs = new Map();
  for (const f of swift) {
    for (const m of f.code.matchAll(
      /\btypealias\s+([A-Za-z_]\w*)\s*(?:<[^=\n]*>)?\s*=([^\n;]*)/g,
    )) {
      aliasDefs.set(m[1], m[2]);
    }
  }
  const fnAliases = new Set();
  const isFnType = (t) =>
    /->|@convention\b/.test(t) ||
    [...t.matchAll(/[A-Za-z_]\w*/g)].some((x) => fnAliases.has(x[0]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [k, v] of aliasDefs) {
      if (!fnAliases.has(k) && isFnType(v)) {
        fnAliases.add(k);
        changed = true;
      }
    }
  }
  const funcNames = new Set([
    ...(engineMethods ?? []),
    ...Object.keys(NATIVE_ONLY),
  ]);
  for (const f of swift) {
    for (const fr of f.frames) {
      if (fr.kind === "func" && f.code.startsWith("func", fr.declPos)) {
        funcNames.add(fr.name);
      }
    }
  }

  /** `let|var NAME` at `m`: its annotation and initializer span. */
  const declAt = (f, m) => {
    const code = f.code;
    let k = m.index + m[0].length;
    while (k < code.length && /[ \t]/.test(code[k])) k++;
    let type = null;
    if (code[k] === ":" && code[k + 1] !== ":") {
      let e = k + 1;
      while (e < code.length) {
        const c = code[e];
        if (c === "(" || c === "[") {
          e = f.match.get(e) + 1;
          continue;
        }
        if (c === "=" && code[e + 1] !== "=") break;
        if ("{\n;,)]}".includes(c)) break;
        e++;
      }
      type = code.slice(k + 1, e);
      k = e;
      while (k < code.length && /[ \t]/.test(code[k])) k++;
    }
    let init = null;
    if (code[k] === "=" && code[k + 1] !== "=") {
      init = [k + 1, initializerEnd(code, f.match, k + 1)];
    }
    return { type, init, after: k };
  };

  /** Why [a, b) of `f` may hold a function value, or null. */
  const holdsFunction = (f, a, b, locals) => {
    const code = f.code;
    for (let k = a; k < b; k++) {
      if (code[k] !== "{") continue;
      return "a closure";
    }
    const re = /\b[A-Za-z_]\w*\b/g;
    re.lastIndex = a;
    for (let m; (m = re.exec(code)) && m.index < b; ) {
      const w = m[0];
      const after = code.slice(m.index + w.length, b);
      const member = /\.\s*$/.test(code.slice(a, m.index));
      if (/^\s*:(?!:)/.test(after)) continue; // an argument label
      const call = /^\s*\(/.exec(after);
      let selector = false;
      if (call) {
        const open = m.index + w.length + call[0].length - 1;
        const inner = code.slice(open + 1, f.match.get(open));
        selector = /^(?:\s*[A-Za-z_]\w*\s*:)+\s*$/.test(inner);
      }
      if (!member && locals.has(w)) {
        if (locals.get(w) && !call) return `${w} (a local holding a function)`;
        continue;
      }
      if (!funcNames.has(w)) continue;
      if (call && !selector) continue;
      return `a reference to ${w}`;
    }
    return null;
  };

  /** Locals of [a, b): name → holds a function value. */
  const localsIn = (f, a, b) => {
    const locals = new Map();
    const re = /\b(?:let|var)\s+([A-Za-z_]\w*)/g;
    re.lastIndex = a;
    const found = [];
    for (let m; (m = re.exec(f.code)) && m.index < b; ) found.push(m);
    for (let pass = 0; pass < 2; pass++) {
      for (const m of found) {
        const d = declAt(f, m);
        const fn =
          (d.type !== null && isFnType(d.type)) ||
          (d.init !== null &&
            holdsFunction(f, d.init[0], d.init[1], locals) !== null);
        locals.set(m[1], (locals.get(m[1]) ?? false) || fn);
      }
    }
    return locals;
  };

  // (1) Stashing from a native-only caller.
  for (const n of reaches) {
    const code = n.file.code;
    const owner = n.frame ?? funcAt(n.file, n.p);
    const scope = owner ? [owner.declPos, owner.close] : n.ranges[0];
    const locals = localsIn(n.file, scope[0], scope[1]);
    const ownType = n.frame && n.name === "init" && n.type ? n.type : null;
    for (const [a, b] of n.ranges) {
      const re = /\+?=/g;
      re.lastIndex = n.frame ? Math.max(a, n.frame.open) : a;
      for (let m; (m = re.exec(code)) && m.index < b; ) {
        const eq = m.index;
        const rhs = eq + m[0].length;
        if (code[rhs] === "=") {
          re.lastIndex = rhs + 1;
          continue;
        }
        if (m[0] === "=" && "=!<>-*/%&|^~?.+".includes(code[eq - 1])) continue;
        const line = code.slice(code.lastIndexOf("\n", eq) + 1, eq);
        if (
          m[0] === "=" &&
          /\b(?:let|var)\s+[A-Za-z_]\w*\s*(?::[^=]*)?$/.test(line)
        ) {
          continue; // a local's declaration
        }
        // The assigned postfix chain, read backwards.
        let j = eq - 1;
        while (j >= 0 && /[ \t]/.test(code[j])) j--;
        while (j >= 0) {
          const c = code[j];
          if (c === ")" || c === "]") {
            j = n.file.match.get(j) - 1;
          } else if (c === "?" || c === "!") {
            j--;
          } else if (/\w/.test(c)) {
            j = identEndingAt(code, j).start - 1;
            let q = j;
            while (q >= 0 && /\s/.test(code[q])) q--;
            if (code[q] !== ".") break;
            j = q - 1;
            while (j >= 0 && /\s/.test(code[j])) j--;
          } else break;
        }
        const chain = code.slice(j + 1, eq).trim();
        const bare = /^[A-Za-z_]\w*$/.test(chain) ? chain : null;
        if (bare && (bare === "_" || locals.has(bare))) continue;
        // An init may set its own type's listed stored closure.
        const target = bare ?? /^self\s*\.\s*([A-Za-z_]\w*)$/.exec(chain)?.[1];
        if (
          ownType &&
          target &&
          STORED_CLOSURES.includes(`${ownType}.${target}`)
        ) {
          continue;
        }
        const end = initializerEnd(code, n.file.match, rhs);
        const why = holdsFunction(n.file, rhs, end, locals);
        if (!why) continue;
        add(
          "G8b-stash",
          n.file,
          eq,
          `${n.id} can reach a native-only method and stores ${why} outside its locals (${chain.replace(/\s+/g, " ")})`,
        );
      }
    }
  }

  // (2) Function-typed stored properties and enum payloads.
  for (const f of swift) {
    const code = f.code;
    for (const m of code.matchAll(/\b(?:let|var)\s+([A-Za-z_]\w*)/g)) {
      if (/\.\s*$/.test(code.slice(Math.max(0, m.index - 4), m.index))) {
        continue;
      }
      const owner = frameAt(f, m.index, (fr) => fr.kind !== "control");
      if (owner && owner.kind !== "type") continue; // a local
      const d = declAt(f, m);
      if (d.init === null && code[d.after] === "{") {
        const fr = f.frames.find((x) => x.open === d.after);
        const first = /^\s*([A-Za-z_]\w*)/.exec(
          code.slice(d.after + 1, fr ? fr.close : d.after + 1),
        )?.[1];
        if (first !== "willSet" && first !== "didSet") continue; // computed
      }
      let fn = d.type !== null && isFnType(d.type);
      // An annotated non-function type cannot hold a closure, unless it is
      // Any/AnyObject; then the initializer decides.
      const inferred = d.type === null || /\bAny(?:Object)?\b/.test(d.type);
      if (!fn && inferred && d.init !== null) {
        const [a, b] = d.init;
        for (let k = a; k < b && !fn; k++) {
          if (code[k] !== "{") continue;
          const close = f.match.get(k);
          if (!/^\s*\(/.test(code.slice(close + 1, b + 1))) fn = true;
          k = close;
        }
        if (!fn) {
          const expr = code.slice(a, b).trim();
          const ref =
            /^(?:[A-Za-z_]\w*\s*\.\s*)*([A-Za-z_]\w*)(?:\s*\((?:\s*[A-Za-z_]\w*\s*:)+\s*\))?$/.exec(
              expr,
            );
          if (ref && funcNames.has(ref[1]) && !/\(\s*\)$/.test(expr)) {
            fn = true;
          }
        }
      }
      if (!fn) continue;
      const id = `${owner ? `${owner.name}.` : ""}${m[1]}`;
      if (STORED_CLOSURES.includes(id)) continue;
      add(
        "G8b-stash",
        f,
        m.index,
        `${id} is a function-typed stored property not in STORED_CLOSURES (a stashed closure is invisible to the call graph)`,
      );
    }
    for (const m of code.matchAll(/\bcase\s+([A-Za-z_]\w*)\s*\(/g)) {
      const owner = frameAt(f, m.index, (fr) => fr.kind !== "control");
      if (!owner || owner.kind !== "type") continue;
      const open = m.index + m[0].length - 1;
      if (!isFnType(code.slice(open + 1, f.match.get(open)))) continue;
      add(
        "G8b-stash",
        f,
        m.index,
        `${owner.name}.${m[1]} carries a function-typed payload`,
      );
    }
  }
  for (const id of STORED_CLOSURES) {
    const [type, name] = id.split(".");
    const found = swift.some((f) =>
      [
        ...f.code.matchAll(new RegExp(`\\b(?:let|var)\\s+${name}\\b`, "g")),
      ].some(
        (m) =>
          frameAt(f, m.index, (fr) => fr.kind !== "control")?.name === type,
      ),
    );
    if (!found) {
      add(
        "G8b-stash",
        null,
        null,
        `listed stored closure ${id} not found; update STORED_CLOSURES`,
      );
    }
  }
}

/** G8b-ffi (audit S6 MINOR-2): the sources never touch the raw FFI. */
function checkRawFfi(swift, add) {
  for (const f of swift) {
    for (const m of f.code.matchAll(RAW_FFI)) {
      add(
        "G8b-ffi",
        f,
        m.index,
        `raw FFI \`${m[0].replace(/\s+/g, " ")}\`; the sources call the core only through E2eeEngine`,
      );
    }
    for (const s of f.strings.values()) {
      if (RAW_FFI_LITERAL.test(s.value)) {
        add("G8b-ffi", f, s.start, `a string literal names an FFI symbol`);
      }
    }
  }
}

const EVENT_NAME = "backupBundleWaiting";

/** G8b-event: the one page event and its empty payload (audit M2). */
function checkEvents(swift, plugin, add) {
  const fn = (name) =>
    plugin.frames.find((f) => f.kind === "func" && f.name === name);
  const load = fn("load");
  const emitter = fn("backupBundleWaitingEmitter");
  let relaySites = 0;
  for (const f of swift) {
    for (const m of f.code.matchAll(/\bnotifyListeners\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      if (f.rel === KEYS_EVENT.file) {
        relaySites++;
        const why = relayEmitProblem(f, m.index, open);
        if (why) add("G8b-event", f, m.index, why);
        continue;
      }
      const args = f.code.slice(open, f.match.get(open) + 1);
      const closure = frameAt(f, m.index, (fr) => fr.kind === "closure");
      const ok =
        f === plugin &&
        load &&
        closure &&
        funcAt(f, m.index) === load &&
        calleeOf(f, closure).name === "backupBundleWaitingEmitter" &&
        /^\s*\[\s*weak\s+self\s*\]\s*event\s*,\s*data\s+in\b/.test(
          f.code.slice(closure.open + 1, closure.close),
        ) &&
        /^\(\s*event\s*,\s*data\s*:\s*data\s*\)$/.test(args);
      if (!ok) {
        add(
          "G8b-event",
          f,
          m.index,
          "notifyListeners only in E2eePlugin.load's backupBundleWaitingEmitter closure, forwarding exactly (event, data: data)",
        );
      }
    }
    // Capacitor's other ways to reach the page are not used at all,
    // including the bridge's eval(js:) and evalWithPlugin(_:js:)
    // (CapacitorBridge.swift:635,658; W2 Stage 5): any `.eval` member, an
    // `eval(js:` call, or evalWithPlugin named at all.
    for (const m of f.code.matchAll(
      /\b(?:triggerJSEvent|triggerWindowJSEvent|triggerDocumentJSEvent|evaluateJavaScript|callAsyncJavaScript|evalWithPlugin)\b|\.\s*eval\b|\beval\s*\(\s*js\s*:/g,
    )) {
      add(
        "G8b-event",
        f,
        m.index,
        `${m[0]} would reach the page outside the one pinned event`,
      );
    }
  }
  if (!emitter) {
    add("G8b-event", plugin, null, "func backupBundleWaitingEmitter not found");
  } else {
    const param = /\(\s*_\s+(\w+)\s*:/.exec(
      plugin.code.slice(emitter.declPos, emitter.open),
    )?.[1];
    let emits = 0;
    const re = new RegExp(`\\b${param ?? "emit"}\\b`, "g");
    re.lastIndex = emitter.open;
    for (let m; (m = re.exec(plugin.code)) && m.index < emitter.close; ) {
      const rest = plugin.code.slice(m.index + m[0].length, m.index + 120);
      if (
        /^\s*\(\s*Self\s*\.\s*backupBundleWaitingEvent\s*,\s*\[\s*:\s*\]\s*\)/.test(
          rest,
        )
      ) {
        emits++;
        continue;
      }
      add(
        "G8b-event",
        plugin,
        m.index,
        `the emitter may only call ${m[0]}(Self.backupBundleWaitingEvent, [:])`,
      );
    }
    if (!param || !emits) {
      add(
        "G8b-event",
        plugin,
        emitter.declPos,
        "backupBundleWaitingEmitter emits nothing it can be checked for",
      );
    }
  }
  const decls = [
    ...plugin.code.matchAll(/\bbackupBundleWaitingEvent\s*=\s*(?=")/g),
  ];
  const value =
    decls.length === 1
      ? plugin.strings.get(decls[0].index + decls[0][0].length)
      : null;
  if (!value || value.interpolated || value.value !== EVENT_NAME) {
    add(
      "G8b-event",
      plugin,
      decls[0]?.index ?? null,
      `backupBundleWaitingEvent must be declared once as "${EVENT_NAME}"`,
    );
  }

  // The second event, callKeysChanged: one emit site, in the relay.
  if (relaySites !== 1) {
    add(
      "G8b-event",
      swift.find((f) => f.rel === KEYS_EVENT.file) ?? null,
      null,
      `${KEYS_EVENT.file} must emit ${KEYS_EVENT.name} exactly once (found ${relaySites} notifyListeners)`,
    );
  }
  // Its name is the constant KeysChangedRelay.event, declared once as the
  // literal, and that literal names nothing else anywhere.
  const relay = swift.find((f) => f.rel === KEYS_EVENT.file);
  const relayType = relay?.frames.find(
    (f) => f.kind === "type" && f.name === KEYS_EVENT.type,
  );
  const eventDecls = relayType
    ? [...relay.code.matchAll(/\b(?:let|var)\s+event\b/g)].filter(
        (m) =>
          frameAt(relay, m.index, (fr) => fr.kind !== "control") === relayType,
      )
    : [];
  const constant =
    eventDecls.length === 1
      ? /^static\s+let\s+event\s*(?::\s*String\s*)?=\s*(?=")/.exec(
          relay.code
            .slice(eventDecls[0].index - "static ".length)
            .replace(/^\s+/, ""),
        )
      : null;
  let constantOk = false;
  if (constant) {
    const at = relay.code.indexOf("=", eventDecls[0].index) + 1;
    const lit = relay.strings.get(skipSpace(relay.code, at));
    constantOk =
      !!lit &&
      !lit.interpolated &&
      lit.value === KEYS_EVENT.name &&
      /^[ \t]*(?:;|\n|$)/.test(relay.code.slice(lit.end, lit.end + 40)) &&
      /\bstatic\s+$/.test(
        relay.code.slice(eventDecls[0].index - 20, eventDecls[0].index),
      );
  }
  if (!constantOk) {
    add(
      "G8b-event",
      relay ?? null,
      eventDecls[0]?.index ?? null,
      `${KEYS_EVENT.type}.event must be declared once, in ${KEYS_EVENT.type}, as static let event = "${KEYS_EVENT.name}"`,
    );
  }
  for (const f of swift) {
    for (const s of f.strings.values()) {
      if (s.value !== KEYS_EVENT.name) continue;
      const isConstant =
        constantOk &&
        f === relay &&
        s.start ===
          skipSpace(
            relay.code,
            relay.code.indexOf("=", eventDecls[0].index) + 1,
          );
      if (!isConstant) {
        add(
          "G8b-event",
          f,
          s.start,
          `the "${KEYS_EVENT.name}" literal outside ${KEYS_EVENT.type}.event (name the constant)`,
        );
      }
    }
  }
}

/**
 * Why the relay's notifyListeners at `at` (its `(` at `open`) is not the one
 * pinned emit, or null. Pinned: inside KeysChangedRelay, in the
 * `DispatchQueue.main.async` closure of the `{ groupId, epoch in … }`
 * closure that builds `static let shared = KeysChangedRelay …`, exactly
 * `(KeysChangedRelay.event, data: ["group_id": groupId, "epoch": epoch])`
 * (epoch also as `NSNumber(value: epoch)`), keys in either order.
 */
function relayEmitProblem(f, at, open) {
  const where = `${KEYS_EVENT.name} is emitted only from ${KEYS_EVENT.type}.shared`;
  const type = frameAt(f, at, (fr) => fr.kind === "type");
  if (type?.name !== KEYS_EVENT.type)
    return `${where}: notifyListeners outside ${KEYS_EVENT.type}`;
  const close = f.match.get(open);
  const head =
    /^\(\s*(?:KeysChangedRelay|Self)\s*\.\s*event\s*,\s*data\s*:\s*\[/.exec(
      f.code.slice(open, close),
    );
  if (!head) {
    return `${where}: the event must be the constant ${KEYS_EVENT.type}.event and data an inline dictionary literal`;
  }
  const dictOpen = open + head[0].length - 1;
  const dictClose = f.match.get(dictOpen);
  if (skipSpace(f.code, dictClose + 1) !== close) {
    return `${where}: nothing may follow the data dictionary`;
  }
  // Top-level entries of the dictionary literal.
  const entries = [];
  let from = dictOpen + 1;
  for (let k = dictOpen + 1; k <= dictClose; k++) {
    const c = f.code[k];
    if (c === "(" || c === "[" || c === "{") {
      k = f.match.get(k);
      continue;
    }
    if (c === "," || k === dictClose) {
      entries.push([from, k]);
      from = k + 1;
    }
  }
  if (entries.length && !f.code.slice(...entries[entries.length - 1]).trim()) {
    entries.pop(); // a trailing comma
  }
  const values = new Map();
  for (const [a, b] of entries) {
    const s = skipSpace(f.code, a);
    const key = f.strings.get(s);
    const colon = key ? /^\s*:/.exec(f.code.slice(key.end, b)) : null;
    if (!key || key.interpolated || !colon || values.has(key.value)) {
      return `${where}: the payload keys must be plain literals, each once`;
    }
    values.set(
      key.value,
      f.code.slice(key.end + colon[0].length, b).replace(/\s+/g, ""),
    );
  }
  const keys = [...values.keys()].sort().join(",");
  if (keys !== "epoch,group_id") {
    return `${where}: the payload keys are exactly group_id and epoch, got [${[...values.keys()].join(", ")}]`;
  }
  if (
    values.get("group_id") !== "groupId" ||
    !["epoch", "NSNumber(value:epoch)"].includes(values.get("epoch"))
  ) {
    return `${where}: the payload is exactly ["group_id": groupId, "epoch": epoch]`;
  }
  // One main-queue hop inside the delivery closure of `static let shared`.
  const hop = frameAt(f, at, (fr) => fr.kind === "closure");
  const hopCallee = hop ? calleeOf(f, hop) : null;
  const deliver = hop
    ? ancestors(hop.parent).find((fr) => fr.kind !== "control")
    : null;
  const deliverCallee =
    deliver?.kind === "closure" ? calleeOf(f, deliver) : null;
  const ok =
    hopCallee?.name === "async" &&
    /\bDispatchQueue\s*\.\s*main\s*\.\s*$/.test(
      f.code.slice(Math.max(0, hopCallee.start - 40), hopCallee.start),
    ) &&
    deliverCallee?.name === KEYS_EVENT.type &&
    /^\s*\(?\s*groupId\s*,\s*epoch\s*\)?\s+in\b/.test(
      f.code.slice(deliver.open + 1, deliver.close),
    ) &&
    /\bstatic\s+let\s+shared\s*(?::[^=\n]*)?=\s*$/.test(
      f.code.slice(
        f.code.lastIndexOf("\n", deliverCallee.start) + 1,
        deliverCallee.start,
      ),
    );
  if (!ok) {
    return `${where}: inside DispatchQueue.main.async in the { groupId, epoch in } closure of static let shared = ${KEYS_EVENT.type} …`;
  }
  return null;
}

/**
 * [a, b) of a lexed file with whitespace and comments dropped, each literal
 * written back as `"value"` (escapes as in the source); null when a literal
 * there is interpolated. Used to compare an expression with a pinned text.
 */
function normalized(file, a, b) {
  let out = "";
  for (let k = a; k < b; ) {
    const s = file.strings.get(k);
    if (s) {
      if (s.interpolated) return null;
      out += `"${s.value}"`;
      k = s.end;
      continue;
    }
    if (!/\s/.test(file.code[k])) out += file.code[k];
    k++;
  }
  return out;
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`. */
function callArgs(file, open) {
  const close = file.match.get(open);
  const args = [];
  let from = open + 1;
  for (let k = open + 1; k <= close; k++) {
    const c = file.code[k];
    if ((c === "(" || c === "[" || c === "{") && k !== close) {
      k = file.match.get(k);
      continue;
    }
    if (c === "," || k === close) {
      if (file.code.slice(from, k).trim()) args.push([from, k]);
      from = k + 1;
    }
  }
  return args;
}

/** A plain literal's text with its escapes decoded; null for any other escape. */
function decodeLiteralText(text, hashes) {
  const esc = "\\" + "#".repeat(hashes);
  let out = "";
  for (let k = 0; k < text.length; ) {
    if (text.startsWith(esc, k)) {
      const c = text[k + esc.length];
      if (c !== '"' && c !== "\\" && c !== "'") return null;
      out += c;
      k += esc.length + 1;
      continue;
    }
    out += text[k];
    k++;
  }
  return out;
}

/**
 * Every `registerPluginInstance(` of the E2ee plugin: with the construction
 * inline (`registerPluginInstance(E2eePlugin())`, instance "") or with a
 * `let x = E2eePlugin()` of the same function (instance "x").
 */
function e2eeRegistrations(swift) {
  const found = [];
  for (const f of swift) {
    for (const m of f.code.matchAll(/\bregisterPluginInstance\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = f.match.get(open);
      const arg = f.code.slice(open + 1, close).trim();
      let instance = null;
      if (/^E2eePlugin\s*(?:\.\s*init\s*)?\(\s*\)$/.test(arg)) instance = "";
      else if (/^[A-Za-z_]\w*$/.test(arg)) {
        const fn = funcAt(f, m.index);
        const bound =
          fn &&
          new RegExp(
            `\\blet\\s+${arg}\\s*(?::\\s*E2eePlugin\\s*)?=\\s*E2eePlugin\\s*(?:\\.\\s*init\\s*)?\\(\\s*\\)`,
          ).test(f.code.slice(fn.open, m.index));
        if (bound) instance = arg;
      }
      if (instance !== null)
        found.push({ f, p: m.index, open, close, instance });
    }
  }
  return found;
}

/**
 * G8b-relay-attach (W2 Stage 5 MINOR 3): the key push is attached to the one
 * E2ee plugin instance the bridge view controller registers, never from the
 * plugin itself (Capacitor can create a second instance by class name, and
 * its load() would run too). See the header for the exact shape.
 */
function checkRelayAttach(swift, add) {
  const rule = "G8b-relay-attach";
  const sites = [];
  for (const f of swift) {
    for (const m of f.code.matchAll(/\battach\b/g)) {
      const before = f.code.slice(Math.max(0, m.index - 40), m.index);
      const after = f.code.slice(m.index + m[0].length, m.index + 40);
      if (/\bfunc\s+$/.test(before) && f.rel === KEYS_EVENT.file) continue;
      if (/^\s*:(?!:)/.test(after)) continue; // an argument label
      sites.push({ f, p: m.index });
    }
  }
  for (const s of sites) {
    if (s.f.rel === "E2eePlugin.swift") {
      add(
        rule,
        s.f,
        s.p,
        "KeysChangedRelay.attach in E2eePlugin.swift: an instance Capacitor creates by class name would take the key push",
      );
    }
  }
  const shape = `exactly one KeysChangedRelay.attach(x) in the sources, in ${CAPS.file}, right after registerPluginInstance(x) of the one let x = E2eePlugin(), in the guarded block`;
  if (sites.length !== 1) {
    add(
      rule,
      sites[1]?.f ?? null,
      sites[1]?.p ?? null,
      `${shape} (found ${sites.length})`,
    );
    return;
  }
  const { f, p } = sites[0];
  const recv = /\bKeysChangedRelay\s*\.\s*$/.exec(
    f.code.slice(Math.max(0, p - 40), p),
  );
  const call = /^\s*\(\s*([A-Za-z_]\w*)\s*\)/.exec(
    f.code.slice(p + "attach".length),
  );
  const regs = e2eeRegistrations(swift);
  const built = swift.flatMap((x) =>
    [...x.code.matchAll(/\bE2eePlugin\s*(?:\.\s*init\s*)?\(/g)].map(() => x),
  );
  const reg = regs.length === 1 ? regs[0] : null;
  const blockOf = (x, at) => frameAt(x, at, (fr) => fr.kind !== "closure");
  const block = reg ? blockOf(f, reg.p) : null;
  const armed = swift.flatMap((x) =>
    [...x.code.matchAll(/\bE2eePlugin\s*\.\s*arm\s*\(/g)].map((m) => ({
      x,
      p: m.index,
    })),
  );
  const recvStart = recv ? p - recv[0].length : p;
  const ok =
    f.rel === CAPS.file &&
    !!recv &&
    !!call &&
    built.length === 1 &&
    !!reg &&
    reg.f === f &&
    reg.instance === call[1] &&
    // AFTER it, with nothing but whitespace (comments are blanked) between:
    // an attach before the registration slices to "" and must not pass.
    recvStart > reg.close &&
    /^[\s;]*$/.test(f.code.slice(reg.close + 1, recvStart)) &&
    block?.kind === "control" &&
    blockOf(f, p) === block &&
    /^\s*if\b[^{]*\b(?:bridgeGuard|MainFrameBridgeGuard)\b/.test(
      f.code.slice(block.declPos, block.open),
    ) &&
    armed.length === 1 &&
    armed[0].x === f &&
    armed[0].p < reg.p &&
    blockOf(f, armed[0].p) === block;
  if (!ok) add(rule, f, p, shape);
}

/** G8b-log (W2 Stage 5): no logging anywhere in the sources. */
const LOG_NAMES =
  /\b(?:print|debugPrint|NSLog|os_log|dump|Logger|CAPLog)\b(?!\s*:(?!:))/g;
function checkNoLogging(swift, add) {
  for (const f of swift) {
    for (const m of f.code.matchAll(LOG_NAMES)) {
      add(
        "G8b-log",
        f,
        m.index,
        `${m[0]} in the sources: nothing here is logged (frame keys pass through Swift)`,
      );
    }
  }
}

/**
 * G8c-audio-plugin (phase 2 C-W2-5): the plugin classes of these sources are
 * exactly E2eePlugin and SlogaCallAudioPlugin; SlogaCallAudioPlugin lives in
 * CallAudioSession.swift as `@objc(SlogaCallAudioPlugin) … class
 * SlogaCallAudioPlugin: CAPPlugin, CAPBridgedPlugin`, jsName "SlogaCallAudio",
 * pluginMethods exactly the two literal CAPPluginMethods start and stop, and
 * its only @objc members are those two `(_ call: CAPPluginCall)` methods; the
 * file names nothing of the E2EE core. It is constructed and armed only in
 * SlogaBridgeViewController.swift, armed before it is registered, in the
 * same block as the E2ee plugin (the main-frame guard's).
 */
function checkCallAudio(swift, add) {
  const rule = "G8c-audio-plugin";
  for (const f of swift) {
    for (const t of f.frames) {
      if (t.kind !== "type" || !f.code.startsWith("class", t.declPos)) continue;
      if (!/:[^{]*\bCAPPlugin\b/.test(f.code.slice(t.declPos, t.open)))
        continue;
      const home = t.name === AUDIO.type ? AUDIO.file : "E2eePlugin.swift";
      if (!PLUGIN_CLASSES.includes(t.name) || f.rel !== home) {
        add(
          rule,
          f,
          t.declPos,
          `Capacitor plugin class ${t.name} in ${f.rel}; the plugins are exactly ${PLUGIN_CLASSES.join(", ")} (each in its own file)`,
        );
      }
    }
  }
  const f = swift.find((x) => x.rel === AUDIO.file);
  if (!f) {
    add(rule, null, null, `${AUDIO.file} not found`);
    return;
  }
  const types = f.frames.filter(
    (t) => t.kind === "type" && t.name === AUDIO.type,
  );
  const cls = types.length === 1 ? types[0] : null;
  if (
    !cls ||
    !f.code.startsWith("class", cls.declPos) ||
    !/:\s*CAPPlugin\s*,\s*CAPBridgedPlugin\s*$/.test(
      f.code.slice(cls.declPos, cls.open),
    ) ||
    !new RegExp(
      `@objc\\s*\\(\\s*${AUDIO.type}\\s*\\)\\s*(?:(?:public|open|final)\\s+)*$`,
    ).test(f.code.slice(Math.max(0, cls.declPos - 80), cls.declPos))
  ) {
    add(
      rule,
      f,
      cls?.declPos ?? null,
      `${AUDIO.file} must declare @objc(${AUDIO.type}) class ${AUDIO.type}: CAPPlugin, CAPBridgedPlugin once`,
    );
    return;
  }
  // final (W2 Stage 5): a subclass declared elsewhere would be a plugin
  // class of its own that inherits start/stop and escapes this rule.
  const modifiers = new RegExp(
    `@objc\\s*\\(\\s*${AUDIO.type}\\s*\\)\\s*((?:(?:public|open|final)\\s+)*)$`,
  ).exec(f.code.slice(Math.max(0, cls.declPos - 80), cls.declPos))[1];
  if (!/\bfinal\b/.test(modifiers) || /\bopen\b/.test(modifiers)) {
    add(
      rule,
      f,
      cls.declPos,
      `${AUDIO.type} must be declared final (and not open): a subclass would escape this rule`,
    );
  }
  const inCls = (p) => frameAt(f, p, (fr) => fr.kind === "type") === cls;
  const js = [...f.code.matchAll(/\bjsName\s*=\s*/g)].filter((m) =>
    inCls(m.index),
  );
  const jsLit =
    js.length === 1 ? f.strings.get(js[0].index + js[0][0].length) : null;
  if (!jsLit || jsLit.interpolated || jsLit.value !== AUDIO.jsName) {
    add(
      rule,
      f,
      js[0]?.index ?? cls.declPos,
      `${AUDIO.type}.jsName must be "${AUDIO.jsName}", once`,
    );
  }
  // pluginMethods = [ CAPPluginMethod(name: "start", …), CAPPluginMethod(name: "stop", …) ]
  const pm = [...f.code.matchAll(/\bpluginMethods\s*:[^=]*=\s*/g)].filter((m) =>
    inCls(m.index),
  );
  let names = null;
  if (pm.length === 1 && f.code[pm[0].index + pm[0][0].length] === "[") {
    const open = pm[0].index + pm[0][0].length;
    const close = f.match.get(open);
    let rest = f.code.slice(open + 1, close);
    names = [];
    for (const m of f.code
      .slice(open, close)
      .matchAll(/\bCAPPluginMethod\s*\(/g)) {
      const p = open + m.index + m[0].length - 1;
      const args = callArgs(f, p);
      const nameArg = args[0] ? f.code.slice(...args[0]) : "";
      const lit = /^\s*name\s*:\s*/.exec(nameArg);
      const s = lit ? f.strings.get(args[0][0] + lit[0].length) : null;
      names.push(
        s &&
          !s.interpolated &&
          skipSpace(f.code, s.end) === args[0][1] &&
          args.length === 2 &&
          /^\s*returnType\s*:\s*CAPPluginReturnPromise\s*$/.test(
            f.code.slice(...args[1]),
          )
          ? s.value
          : "<not a plain promise method>",
      );
      const span = f.code.slice(open + m.index, f.match.get(p) + 1);
      rest = rest.replace(span, "");
    }
    if (!/^[\s,]*$/.test(rest)) names.push("<something else>");
  }
  if (
    !names ||
    [...names].sort().join(",") !== [...AUDIO.methods].sort().join(",")
  ) {
    add(
      rule,
      f,
      pm[0]?.index ?? cls.declPos,
      `${AUDIO.type}.pluginMethods must be exactly [${AUDIO.methods.join(", ")}] as literal CAPPluginMethod(name:, returnType: CAPPluginReturnPromise), got [${(names ?? []).join(", ")}]`,
    );
  }
  // @objc members: the class attribute and the two plugin methods only.
  const objcFuncs = new Set();
  for (const m of f.code.matchAll(/@objc\b/g)) {
    const after = f.code.slice(m.index, m.index + 300);
    if (
      new RegExp(
        `^@objc\\s*\\(\\s*${AUDIO.type}\\s*\\)\\s*(?:(?:public|open|final)\\s+)*class\\s+${AUDIO.type}\\b`,
      ).test(after)
    ) {
      continue;
    }
    const fn =
      /^@objc(?:\s+(?:public|internal|open|final|dynamic))*\s+func\s+(\w+)\s*\(\s*_\s+\w+\s*:\s*CAPPluginCall\s*\)/.exec(
        after,
      );
    if (
      fn &&
      AUDIO.methods.includes(fn[1]) &&
      !objcFuncs.has(fn[1]) &&
      inCls(m.index)
    ) {
      objcFuncs.add(fn[1]);
      continue;
    }
    add(
      rule,
      f,
      m.index,
      `${AUDIO.file}: an @objc member other than ${AUDIO.methods.join("/")}(_ call: CAPPluginCall)`,
    );
  }
  for (const name of AUDIO.methods) {
    if (!objcFuncs.has(name)) {
      add(
        rule,
        f,
        cls.declPos,
        `${AUDIO.type} has no @objc func ${name}(_ call: CAPPluginCall)`,
      );
    }
  }
  for (const m of f.code.matchAll(AUDIO_FORBIDDEN)) {
    add(
      rule,
      f,
      m.index,
      `${AUDIO.file} names ${m[0]}; the call audio plugin never reaches the E2EE core`,
    );
  }
  // Constructed and armed only by the bridge view controller, armed first,
  // in the E2ee plugin's (guarded) block.
  const sites = (re) =>
    swift.flatMap((x) =>
      [...x.code.matchAll(re)].map((m) => ({ f: x, p: m.index })),
    );
  const built = sites(
    new RegExp(`\\b${AUDIO.type}\\s*(?:\\.\\s*init\\s*)?\\(`, "g"),
  );
  const armed = sites(new RegExp(`\\b${AUDIO.type}\\s*\\.\\s*arm\\s*\\(`, "g"));
  // The E2ee plugin's registration, either form (W2 Stage 5 binds the
  // instance first so KeysChangedRelay can be attached to it).
  const e2ee = e2eeRegistrations(swift);
  const block = (s) => frameAt(s.f, s.p, (fr) => fr.kind !== "closure");
  const ok =
    built.length === 1 &&
    armed.length === 1 &&
    e2ee.length === 1 &&
    built[0].f.rel === CAPS.file &&
    armed[0].f === built[0].f &&
    e2ee[0].f === built[0].f &&
    armed[0].p < built[0].p &&
    block(built[0]) === block(armed[0]) &&
    block(built[0]) === block(e2ee[0]) &&
    block(built[0])?.kind === "control" &&
    /\bregisterPluginInstance\s*\(\s*$/.test(
      built[0].f.code.slice(Math.max(0, built[0].p - 40), built[0].p),
    );
  if (!ok) {
    add(
      rule,
      built[0]?.f ?? null,
      built[0]?.p ?? null,
      `${AUDIO.type} must be armed, then built once as registerPluginInstance(${AUDIO.type}()), in ${CAPS.file}'s guarded block with the E2ee plugin`,
    );
  }
}

/**
 * G8c-ios-caps (phase 2 C-W2-6): the one page global the shell adds.
 *   - exactly one string literal in the sources names __slogaIosCaps, in
 *     SlogaBridgeViewController.swift; decoded it is exactly CAPS.before +
 *     ONE interpolation + CAPS.after (so only mediaE2EE, frozen,
 *     non-writable, non-configurable, non-enumerable);
 *   - the interpolation is a literal bool: `\(x)` where x is bound once as
 *     `let x = c ? "true" : "false"` (or is a Bool itself), and the bool
 *     resolves to the Info.plist read `Bundle.main.object(forInfoDictionaryKey:
 *     "SlogaMediaE2EE") as? String == "YES"` (the key literal or a static let
 *     of it): directly, or through a Bool parameter of the one function that
 *     returns the literal, bound at the one call site;
 *   - exactly one WKUserScript( in the sources, its arguments exactly
 *     source: <that literal | a let of it | a call of that function>,
 *     injectionTime: .atDocumentStart, forMainFrameOnly: true; and exactly
 *     one addUserScript( in that file;
 *   - slogaShell (which selects the desktop paths) named nowhere.
 */
function checkIosCaps(swift, add) {
  const rule = "G8c-ios-caps";
  for (const f of swift) {
    for (const m of f.code.matchAll(/\bslogaShell\b/g)) {
      add(
        rule,
        f,
        m.index,
        "slogaShell named in the sources (it selects the desktop paths)",
      );
    }
    for (const s of f.strings.values()) {
      if (/slogaShell/.test(s.value)) {
        add(
          rule,
          f,
          s.start,
          "a string literal names slogaShell (it selects the desktop paths)",
        );
      }
    }
  }
  const lits = swift.flatMap((f) =>
    [...f.strings.values()]
      .filter((s) => s.value.includes(CAPS.global))
      .map((s) => ({ f, s })),
  );
  if (lits.length !== 1 || lits[0].f.rel !== CAPS.file) {
    for (const { f, s } of lits.length ? lits : [{ f: null, s: null }]) {
      add(
        rule,
        f,
        s?.start ?? null,
        `exactly one string literal may name ${CAPS.global}, in ${CAPS.file} (found ${lits.length})`,
      );
    }
    return;
  }
  const { f, s } = lits[0];
  const fail = (p, why) => add(rule, f, p, why);
  const texts = s.parts
    .filter((x) => "text" in x)
    .map((x) => decodeLiteralText(x.text, s.hashes));
  const codes = s.parts.filter((x) => "code" in x);
  if (
    s.multi ||
    codes.length !== 1 ||
    texts.length !== 2 ||
    texts[0] !== CAPS.before ||
    texts[1] !== CAPS.after
  ) {
    fail(
      s.start,
      `the ${CAPS.global} script must be exactly ${CAPS.before}\\(bool)${CAPS.after}`,
    );
    return;
  }
  const home = funcAt(f, s.start);
  const type = frameAt(f, s.start, (fr) => fr.kind === "type");
  const inFn = (fn, re) =>
    fn
      ? [...f.code.slice(fn.open, fn.close).matchAll(re)].map(
          (m) => fn.open + m.index,
        )
      : [];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** `let name … = <init>` bound exactly once in fn and never reassigned. */
  const boundOnce = (fn, name) => {
    const decls = inFn(
      fn,
      new RegExp(`\\b(?:let|var)\\s+${esc(name)}\\b`, "g"),
    );
    if (decls.length !== 1 || !f.code.startsWith("let", decls[0])) return null;
    const m = new RegExp(
      `^let\\s+${esc(name)}\\s*(?::\\s*(\\w+)\\s*)?=(?!=)`,
    ).exec(f.code.slice(decls[0]));
    if (!m) return null;
    const from = decls[0] + m[0].length;
    // Any other write to it (a let is immutable, but a same-named shadow or
    // capture would be a second binding the pin does not see).
    const writes = inFn(
      fn,
      new RegExp(`\\b${esc(name)}\\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)`, "g"),
    ).filter((w) => !(w >= decls[0] && w < from));
    if (writes.length) return null;
    return {
      type: m[1] ?? null,
      from,
      to: initializerEnd(f.code, f.match, from),
    };
  };
  // The Info.plist key: the literal, or a static let of this type holding it.
  const keyConst = (name) => {
    const decls = [
      ...f.code.matchAll(new RegExp(`\\b(?:let|var)\\s+${esc(name)}\\b`, "g")),
    ];
    if (
      decls.length !== 1 ||
      !/\bstatic\s+$/.test(f.code.slice(decls[0].index - 20, decls[0].index))
    )
      return false;
    if (!f.code.startsWith("let", decls[0].index)) return false;
    if (frameAt(f, decls[0].index, (fr) => fr.kind !== "control") !== type)
      return false;
    const eq = /^let\s+\w+\s*(?::\s*String\s*)?=\s*/.exec(
      f.code.slice(decls[0].index),
    );
    const lit = eq ? f.strings.get(decls[0].index + eq[0].length) : null;
    return !!lit && !lit.interpolated && lit.value === "SlogaMediaE2EE";
  };
  const isPinnedBool = (a, b) => {
    let text = normalized(f, a, b);
    if (text === null) return false;
    text = text.replace(
      /forInfoDictionaryKey:(?:(?:Self|SlogaBridgeViewController)\.)?([A-Za-z_]\w*)\)/,
      (whole, name) =>
        keyConst(name) ? 'forInfoDictionaryKey:"SlogaMediaE2EE")' : whole,
    );
    return CAPS.bools.includes(text);
  };
  /** How `name` in fn is a pinned bool: "pin", "param" (a Bool parameter) or null. */
  const boolOf = (fn, name) => {
    const params = fn ? f.code.slice(fn.declPos, fn.open) : "";
    if (
      new RegExp(`\\(\\s*(?:_\\s+)?${esc(name)}\\s*:\\s*Bool\\s*\\)`).test(
        params,
      )
    ) {
      return inFn(fn, new RegExp(`\\b${esc(name)}\\s*=(?!=)`, "g")).length
        ? null
        : "param";
    }
    const b = boundOnce(fn, name);
    if (!b || (b.type && b.type !== "Bool")) return null;
    return isPinnedBool(b.from, b.to) ? "pin" : null;
  };
  // The interpolation: \(x), x a "true"/"false" ternary local or a bool.
  const [ia, ib] = codes[0].code;
  const ident = /^\s*([A-Za-z_]\w*)\s*$/.exec(f.code.slice(ia, ib))?.[1];
  let how = null;
  if (ident) {
    const t = boundOnce(home, ident);
    const tern = t
      ? /^\s*([A-Za-z_]\w*)\s*\?\s*(?=")/.exec(f.code.slice(t.from, t.to))
      : null;
    if (tern) {
      const yes = f.strings.get(t.from + tern[0].length);
      const colon = yes ? /^\s*:\s*/.exec(f.code.slice(yes.end, t.to)) : null;
      const no = colon ? f.strings.get(yes.end + colon[0].length) : null;
      if (
        yes &&
        no &&
        !yes.interpolated &&
        !no.interpolated &&
        yes.value === "true" &&
        no.value === "false" &&
        skipSpace(f.code, no.end) >= t.to
      ) {
        how = boolOf(home, tern[1]);
      }
    } else {
      how = boolOf(home, ident);
    }
  }
  if (!how) {
    fail(
      ia,
      `the one ${CAPS.global} interpolation must be a literal bool: let x = <Info.plist SlogaMediaE2EE == "YES"> ? "true" : "false"`,
    );
    return;
  }
  // WKUserScript: once, in this file, with the pinned arguments.
  const ctors = swift.flatMap((x) =>
    [...x.code.matchAll(/\bWKUserScript\s*(?:\.\s*init\s*)?\(/g)].map((m) => ({
      x,
      p: m.index,
      open: m.index + m[0].length - 1,
    })),
  );
  if (ctors.length !== 1 || ctors[0].x !== f) {
    fail(
      ctors[0]?.p ?? null,
      `exactly one WKUserScript( in the sources, in ${CAPS.file} (found ${ctors.length})`,
    );
    return;
  }
  const ctor = ctors[0];
  const args = callArgs(f, ctor.open).map(([a, b]) => [
    a,
    b,
    normalized(f, a, b) ?? "",
  ]);
  const caller = funcAt(f, ctor.p);
  let sourceOk = false;
  // The source argument from lexed code (its literal, if any, is pinned by
  // position below, not by text: normalized() refuses interpolated ones).
  const sourceLabel =
    args.length === 3
      ? /^\s*source\s*:\s*/.exec(f.code.slice(args[0][0], args[0][1]))
      : null;
  if (sourceLabel) {
    const at = args[0][0] + sourceLabel[0].length;
    const expr = f.code.slice(at, args[0][1]).replace(/\s+/g, "");
    const local = /^[A-Za-z_]\w*$/.test(expr) ? boundOnce(caller, expr) : null;
    if (how === "pin" && home === caller) {
      // The literal itself, or a let of it, in the function that builds the script.
      sourceOk =
        at === s.start
          ? skipSpace(f.code, s.end) === args[0][1]
          : !!local &&
            skipSpace(f.code, local.from) === s.start &&
            skipSpace(f.code, s.end) >= local.to;
    } else if (how === "param" && home && home !== caller) {
      // A call of the one function that returns the literal, its Bool bound to the pin.
      const returns = inFn(home, /\breturn\b/g);
      const call =
        /^(?:(?:Self|SlogaBridgeViewController)\.)?([A-Za-z_]\w*)\(([A-Za-z_]\w*):([A-Za-z_]\w*)\)$/.exec(
          expr,
        );
      const label =
        /\(\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)?\s*:\s*Bool\s*\)|\(\s*([A-Za-z_]\w*)\s*:\s*Bool\s*\)/.exec(
          f.code.slice(home.declPos, home.open),
        );
      const homeLabel = label ? (label[1] ?? label[3]) : null;
      sourceOk =
        returns.length === 1 &&
        skipSpace(f.code, returns[0] + "return".length) === s.start &&
        /^[ \t]*(?:\n|;|\})/.test(f.code.slice(s.end, s.end + 40)) &&
        frameAt(f, home.declPos, (fr) => fr.kind === "type") === type &&
        !!call &&
        call[1] === home.name &&
        call[2] === homeLabel &&
        f.frames.filter((fr) => fr.kind === "func" && fr.name === home.name)
          .length === 1 &&
        [...f.code.matchAll(new RegExp(`\\b${esc(home.name)}\\b`, "g"))]
          .length === 2 &&
        boolOf(caller, call[3]) === "pin";
    }
  }
  if (
    !sourceOk ||
    args[1]?.[2] !== "injectionTime:.atDocumentStart" ||
    args[2]?.[2] !== "forMainFrameOnly:true"
  ) {
    fail(
      ctor.p,
      `WKUserScript must be exactly (source: <the pinned ${CAPS.global} script>, injectionTime: .atDocumentStart, forMainFrameOnly: true)`,
    );
  }
  const adds = swift.flatMap((x) =>
    [...x.code.matchAll(/\baddUserScript\s*\(/g)].map((m) => ({
      x,
      p: m.index,
    })),
  );
  if (adds.length !== 1 || adds[0].x !== f || funcAt(f, adds[0].p) !== caller) {
    fail(
      adds[0]?.p ?? null,
      `exactly one addUserScript( in the sources, beside the WKUserScript (found ${adds.length})`,
    );
  }
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
  const callEntries = parsed.entries.filter((e) => e.route === "call");
  const dedicatedMethods = parsed.methods.map((m) => m.name);

  // Bindings.
  const methods = parseBindings(bindings, add, table);
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
  const callTargets = new Set();
  for (const e of callEntries) {
    const target = targetOf(e.name);
    if (!target) {
      add(
        "G6-call-binding",
        commands,
        e.p,
        `${e.name} has no E2eeEngine method (no uniffi symbol ..._e2eeengine_${e.name.slice(5)})`,
      );
    } else callTargets.add(target.name);
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
      callTargets.has(m.name) ||
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

  // runGeneric / runCallPlane / nativeJob switches.
  const dispatcherSwitch = (fnName, route, entries, rule) => {
    const fn = onlyFunc(plugin, fnName);
    const sw = switchOn(plugin, fn, "name");
    if (!sw) {
      throw new InputError(`${plugin.rel}: ${fnName} has no \`switch name\``);
    }
    const arms = caseArms(plugin, sw);
    const named = new Map();
    for (const a of arms) {
      if (a.kind === "default") {
        if (
          !literalArg(plugin, a.body, a.end, "invalidArgument").includes("name")
        ) {
          add(
            rule,
            plugin,
            a.p,
            `${fnName} default must reject invalid_argument{field:"name"}`,
          );
        }
        continue;
      }
      if (!a.literalOnly || a.names.length !== 1 || a.names[0] === null) {
        add(
          rule,
          plugin,
          a.p,
          `${fnName} case must be exactly one plain string literal`,
        );
        continue;
      }
      if (named.has(a.names[0])) {
        add(rule, plugin, a.p, `case "${a.names[0]}" appears twice`);
      }
      named.set(a.names[0], a);
    }
    if (!arms.some((a) => a.kind === "default")) {
      add(rule, plugin, sw.open, `${fnName} switch has no default`);
    }
    for (const e of entries) {
      if (!named.has(e.name)) {
        add(
          rule,
          plugin,
          fn.declPos,
          `${route} ${e.name} has no case in ${fnName}`,
        );
      }
    }
    for (const [name, a] of named) {
      if (routeOf(name) !== route) {
        add(
          rule,
          plugin,
          a.p,
          `case "${name}" in ${fnName}, but the table routes it .${routeOf(name)}`,
        );
      }
    }
    return { fn, sw, named };
  };
  const {
    fn: runGeneric,
    sw: genericSwitch,
    named: armNames,
  } = dispatcherSwitch("runGeneric", "generic", generic, "G6-generic-case");
  // G6-call-case (phase 2): the call plane's own switch, the 22 names only.
  const {
    fn: runCallPlane,
    sw: callSwitch,
    named: callArmNames,
  } = dispatcherSwitch("runCallPlane", "call", callEntries, "G6-call-case");
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
  const callArmOf = (p) => {
    if (!(callSwitch.open < p && p < callSwitch.close)) return null;
    for (const [name, a] of callArmNames) {
      if (a.body <= p && p < a.end) return name;
    }
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
    const arm = armOf(c.p) ?? callArmOf(c.p);
    if (arm) continue;
    if (has(GATED, c.member) && objcOf(plugin, c.p) === GATED[c.member]) {
      continue;
    }
    add(
      "G6-plugin-engine-call",
      plugin,
      c.p,
      `engine .${c.member} in E2eePlugin.swift outside a generic or call-plane arm or its gated dedicated method`,
    );
  }
  const armCalls = (named, rule) => {
    for (const [name, a] of named) {
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
          rule,
          plugin,
          a.p,
          `case "${name}" calls engine [${[...members].join(", ")}]; it must call exactly ${target.name}`,
        );
      }
    }
  };
  armCalls(armNames, "G6-generic-arm");
  armCalls(callArmNames, "G6-call-arm");

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
  const workerSite = (fnName, worker, rule, message) => {
    const sites = [];
    for (const f of swift) {
      for (const m of f.code.matchAll(new RegExp(`\\b${fnName}\\s*\\(`, "g"))) {
        if (/\bfunc\s+$/.test(f.code.slice(Math.max(0, m.index - 20), m.index)))
          continue;
        sites.push({ f, p: m.index });
      }
    }
    // The NEAREST worker closure decides (a call nested in both workers'
    // closures runs on the inner one).
    const onWorker = (f, p) => {
      for (const fr of ancestors(frameAt(f, p))) {
        if (fr.kind !== "closure") continue;
        const callee = calleeOf(f, fr);
        if (callee.name !== "submit") continue;
        return new RegExp(`\\b${worker}\\s*\\.\\s*$`).test(
          f.code.slice(Math.max(0, callee.start - 40), callee.start),
        );
      }
      return false;
    };
    if (
      sites.length !== 1 ||
      sites[0].f !== plugin ||
      !onWorker(sites[0].f, sites[0].p)
    ) {
      for (const s of sites.length ? sites : [{ f: plugin, p: null }]) {
        add(rule, s.f, s.p, message);
      }
    }
  };
  workerSite(
    "runGeneric",
    "engineWorker",
    "G7-generic-worker",
    "runGeneric must be called once, from an engineWorker.submit closure",
  );
  workerSite(
    "runCallPlane",
    "callWorker",
    "G7-call-worker",
    "runCallPlane must be called once, from a callWorker.submit closure",
  );
  {
    // The call worker is its own serial WorkerPool (C-W2-2), not an alias
    // of the engine worker.
    const decls = [...support.code.matchAll(/\b(?:let|var)\s+callWorker\b/g)];
    const m =
      decls.length === 1
        ? /^let\s+callWorker\s*(?::\s*WorkerPool\s*)?=\s*WorkerPool\s*\(\s*name\s*:\s*(?=")/.exec(
            support.code.slice(decls[0].index),
          )
        : null;
    const lit = m ? support.strings.get(decls[0].index + m[0].length) : null;
    const tail = lit
      ? /^\s*,\s*threads\s*:\s*1\s*\)/.test(support.code.slice(lit.end))
      : false;
    const owner = decls.length
      ? frameAt(support, decls[0].index, (fr) => fr.kind !== "control")
      : null;
    if (
      !lit ||
      lit.interpolated ||
      lit.value !== "gg.sloga.e2ee.call" ||
      !tail ||
      owner?.kind !== "type" ||
      owner.name !== "E2eeRuntime"
    ) {
      add(
        "G7-call-worker",
        support,
        decls[0]?.index ?? null,
        'E2eeRuntime.callWorker must be declared once as let callWorker = WorkerPool(name: "gg.sloga.e2ee.call", threads: 1)',
      );
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
  // G8b-frame-keys, by name: callFrameKeys appears only in its own arm.
  for (const f of swift) {
    for (const m of f.code.matchAll(
      new RegExp(`\\b${FRAME_KEYS_METHOD}\\b`, "g"),
    )) {
      if (f === plugin && callArmOf(m.index) === FRAME_KEYS_COMMAND) continue;
      add(
        "G8b-frame-keys",
        f,
        m.index,
        `${FRAME_KEYS_METHOD} named in ${f.rel} outside runCallPlane's case "${FRAME_KEYS_COMMAND}"`,
      );
    }
  }
  checkEvents(swift, plugin, add);
  checkRawFfi(swift, add);
  checkCallAudio(swift, add);
  checkIosCaps(swift, add);
  checkRelayAttach(swift, add);
  checkNoLogging(swift, add);
  // G8b reachability and what reaches the webview.
  const reach = checkReach(
    {
      swift,
      plugin,
      runGeneric,
      armNames,
      nativeJob,
      nativeArms,
      runCallPlane,
      callArmNames,
      objc,
      targetOf,
      engineMethods: [...methods.values()].map((m) => m.name),
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
    call: callEntries.map((e) => e.name),
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
    `ok: table generic ${summary.generic.length}, native ${summary.native.length}, call ${summary.call.length}, dedicated ${summary.dedicated.length}, out ${summary.out.length}; ` +
      `bindings export ${summary.exports} E2eeEngine methods; e2ee.ts ${summary.feNames} e2ee_ names, ${summary.invokeSites} #invoke sites; ` +
      `${summary.engineCalls} engine calls in ${summary.bodies} preconditioned bodies across ${summary.files} Swift files; ` +
      `call graph ${summary.reach.nodes} nodes, ${summary.reach.roots} roots, ${summary.reach.reaches} native-only callers`,
  );
  if (opts.list) {
    for (const k of ROUTES) {
      console.log(`${k} (${summary[k].length}): ${summary[k].join(" ")}`);
    }
    console.log(
      `native-only callers (${summary.reach.reachers.length}): ${summary.reach.reachers.join(" ")}`,
    );
  }
}

main();

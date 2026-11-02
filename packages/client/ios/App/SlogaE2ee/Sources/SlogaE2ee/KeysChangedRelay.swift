// KeysChangedRelay.swift: the Swift side of the core's key push (iOS call
// E2EE phase 2, D4), uniffi's foreign trait `NativeKeysChanged`. The iOS
// analog of desktop's `e2ee:call-keys-changed` event and Android's
// `callKeysChanged`: after the core applies a new epoch for a call group
// (`call_create`, an epoch-advancing `call_process`, `call_commit_won`) it
// calls `keysChanged`, and the page is told `callKeysChanged {group_id,
// epoch}`. The push carries no key; the page pulls the new frame keys
// itself through `e2ee_call_frame_keys`.
//
// Threading: the core calls `keysChanged` on whichever engine thread is
// running the call command, from INSIDE that command, so it must return
// at once. It posts ONE `DispatchQueue.main.async` and returns: it never
// blocks, never waits on any queue (a sync hop onto the worker it is
// running on, or onto a thread that is itself waiting on the engine, is a
// deadlock), never calls back into the engine (the core is mid-command; the
// bindings' contract forbids re-entry), and never throws even though the
// generated signature is `throws`. The emit itself runs on main, where
// Capacitor clears a page's listeners on navigation, so it never walks the
// listener table while that reset runs (as `backupBundleWaiting` does).
// The plugin and bridge references are written (`attach`) and read (the
// posted emit) on the main thread only, so they need no lock. `attach`
// enforces that itself: called off main, it hops to main instead of
// crashing the app.
//
// Who attaches: SlogaBridgeViewController, right after it registers the
// E2ee plugin (`attach(plugin, bridge: bridge)`). Tests attach a plugin
// alone.
//
// Why the bridge lookup: Capacitor can replace the registered plugin. For
// an unknown pluginId its handleJSCall falls back to
// NSClassFromString(pluginId), and loadPlugin then stores the new instance
// under the same jsName, so the registered instance is freed and a weak
// plugin reference alone would go nil for good. At emit time the target is
// therefore whichever instance the bridge now holds under the E2ee jsName
// (the one the page talks to), falling back to the attached instance.
//
// Weak: the engine keeps its `NativeKeysChanged` alive for as long as the
// engine lives, and the engine holds the store's one-engine-per-directory
// claim. A strong path from this relay to the plugin, the bridge, the
// runtime or the engine would be a cycle that keeps that claim, and the
// next engine construction would be refused. The relay holds no strong
// reference to any of them; the plugin and the bridge are held weakly, and
// the last attach wins (as with `RecoverySheet.bundleWaitingHook`).
//
// Delivery may be dropped, by design of the transport: no plugin attached
// yet or already released, the page navigating between the post and the
// emit, or no listener registered at the moment of the emit (Capacitor does
// not keep the event for a later listener). A lost push is NOT fail-closed by
// itself: the device would keep sending on the previous epoch's key. The
// frontend must backstop it (Wave 3: after each epoch-advancing call
// resolves, check the installed epoch reached the outcome's epoch, and
// otherwise pull the keys itself or go loud).
//
// Nothing here is logged.
import AcutestE2eeBindings
import Capacitor
import Foundation

final class KeysChangedRelay: NativeKeysChanged {
    /// The event the page listens for. Its payload is exactly
    /// `{group_id: String, epoch: Number}`, the public pair and nothing else.
    static let event = "callKeysChanged"

    /// The jsName the E2ee plugin is registered under. Must equal
    /// `E2eePlugin.jsName` (E2eePlugin.swift); kept as a literal here so
    /// resolving it never constructs a plugin.
    static let targetJsName = "E2ee"

    /// The relay the engine is built with (Support.swift): one main-queue
    /// hop, then the event on the bridge's current E2ee plugin, or else the
    /// attached one, if there still is one.
    static let shared = KeysChangedRelay { groupId, epoch in
        DispatchQueue.main.async {
            let target = KeysChangedRelay.bridge?.plugin(withName: KeysChangedRelay.targetJsName)
                ?? KeysChangedRelay.plugin
            target?.notifyListeners(
                KeysChangedRelay.event,
                data: ["group_id": groupId, "epoch": NSNumber(value: epoch)]
            )
        }
    }

    /// Main thread only (written by `attach`, read by `shared`'s posted emit).
    private static weak var plugin: CAPPlugin?

    /// Main thread only, like `plugin`. Never held strongly.
    private static weak var bridge: CAPBridgeProtocol?

    /// Makes `plugin` (and, through `bridge`, whichever instance later holds
    /// the E2ee jsName) the target of `shared`; called by
    /// SlogaBridgeViewController after it registers the plugin. Replaces
    /// both references, so an attach without a bridge clears the bridge.
    /// The writes always happen on main: directly when called there,
    /// otherwise after an async hop. The hop captures both weakly, so it
    /// cannot keep alive a plugin or bridge released before it ran (a
    /// released plugin means nothing is attached).
    static func attach(_ plugin: CAPPlugin, bridge: CAPBridgeProtocol? = nil) {
        if Thread.isMainThread {
            Self.plugin = plugin
            Self.bridge = bridge
        } else {
            DispatchQueue.main.async { [weak plugin, weak bridge] in
                if let plugin {
                    Self.plugin = plugin
                    Self.bridge = bridge
                }
            }
        }
    }

    private let deliver: @Sendable (_ groupId: String, _ epoch: Int64) -> Void

    /// `deliver` runs on the core's calling thread, inside the engine call:
    /// it must not block, wait on any queue, or call the engine.
    init(deliver: @escaping @Sendable (_ groupId: String, _ epoch: Int64) -> Void) {
        self.deliver = deliver
    }

    func keysChanged(groupId: String, epoch: Int64) throws {
        deliver(groupId, epoch)
    }
}

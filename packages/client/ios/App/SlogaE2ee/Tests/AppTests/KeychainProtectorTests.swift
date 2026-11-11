// KeychainProtectorTests.swift: gate G9, keychain part (IE plan D3, D10).
//
// These tests drive the PRODUCTION iOS keychain protector through the real
// uniffi engine, inside the real app process, so they see exactly what a
// user's install sees: the app's entitlements, the production item identity
// and the data-protection keychain. There is no test-identity seam here, so
// the tests that delete or plant items under the production identity run on
// the Simulator only, and each one puts back exactly what it found.
//
// State rule every test keeps: afterwards the keychain holds the item it
// held before, or one correct item if it held none.
import AcutestE2eeBindings
import Foundation
import Security
import XCTest
@testable import SlogaE2ee

/// The item identity, copied from `e2ee-core/src/protect/ios_keychain.rs`
/// (`IosKeychainProtector::PRODUCTION`). Repeated here on purpose: if the core
/// constants move, these tests stop finding the item and fail.
private enum ProductionItem {
    static let service = "gg.sloga.app.e2ee"
    static let account = "e2ee-master-wrap"
    static let accessGroup = "M6UUDLK2XQ.gg.sloga.app.e2ee"
}

/// Label on every item these tests plant, so a crashed run's leftover can be
/// recognized and removed without touching anything else.
private let plantedLabel = "T1 KeychainProtectorTests planted item"

/// The core's exact error payloads (serde tag of `Error`).
private let protectorJson = #"{"type":"protector"}"#
private let protectorLockedJson = #"{"type":"protector_locked"}"#

private struct T1Failure: Error, CustomStringConvertible {
    let description: String
}

/// Never consents. Nothing in these tests reaches a confirm-gated method; if
/// one ever did, declining is the safe answer.
private final class DecliningConfirm: NativeConfirm {
    func confirm(req: ConfirmPayload) throws -> Bool {
        false
    }
}

private final class OutcomeBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: Result<T, Error>?

    func store(_ value: Result<T, Error>) {
        lock.lock()
        outcome = value
        lock.unlock()
    }

    func take() -> Result<T, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return outcome
    }
}

private struct ListedItem {
    let persistentRef: Data
    let attributes: [String: Any]
}

/// Class, service, account, access group, synchronizable=false: the same
/// identity the protector pins on its add and on every search.
private func identityQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: ProductionItem.service,
        kSecAttrAccount as String: ProductionItem.account,
        kSecAttrAccessGroup as String: ProductionItem.accessGroup,
        kSecAttrSynchronizable as String: false,
    ]
}

/// Every item under the production identity, attributes and persistent
/// reference only (no secret). With `includingSynchronizable` the search
/// also matches synchronizable items, so a hidden iCloud twin would show up.
private func listProductionItems(includingSynchronizable: Bool = false) throws -> [ListedItem] {
    var query = identityQuery()
    if includingSynchronizable {
        query[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
    }
    query[kSecReturnAttributes as String] = true
    query[kSecReturnPersistentRef as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    if status == errSecItemNotFound {
        return []
    }
    guard status == errSecSuccess else {
        throw T1Failure(description: "listing the production item failed, OSStatus \(status)")
    }
    guard let entries = out as? [[String: Any]] else {
        throw T1Failure(description: "listing returned an unexpected shape")
    }
    return try entries.map { entry in
        guard let ref = entry[kSecValuePersistentRef as String] as? Data, !ref.isEmpty else {
            throw T1Failure(description: "listing entry has no persistent reference")
        }
        return ListedItem(persistentRef: ref, attributes: entry)
    }
}

/// One item's secret bytes, by the persistent reference a scoped listing
/// returned. Callers zeroize what they get.
///
/// Deliberately class + reference only: on the iOS 26 Simulator a search that
/// pairs a persistent reference with any other attribute (service, account,
/// group, synchronizable) returns errSecParam (-50). That is also the shape
/// the core's phase-2 fetch uses, so this helper must not share it, or a core
/// failure would read as a harness failure.
private func itemData(_ ref: Data) throws -> Data {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecValuePersistentRef as String: ref,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    guard status == errSecSuccess, let data = out as? Data else {
        throw T1Failure(description: "reading an item's data failed, OSStatus \(status)")
    }
    return data
}

/// The group the keychain assigns an item added WITHOUT an explicit access
/// group: the first entry of the app's `keychain-access-groups`. Uses a
/// throwaway service, never the production one, and removes it again.
private func defaultAccessGroup() throws -> String {
    let service = "gg.sloga.app.e2ee.t1-probe"
    let account = UUID().uuidString
    let probe: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecValueData as String: Data([0x01]),
        kSecReturnAttributes as String: true,
    ]
    var out: CFTypeRef?
    let status = SecItemAdd(probe as CFDictionary, &out)
    defer {
        let cleanup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(cleanup as CFDictionary)
    }
    guard status == errSecSuccess,
        let attributes = out as? [String: Any],
        let group = attributes[kSecAttrAccessGroup as String] as? String
    else {
        throw T1Failure(description: "default-group probe failed, OSStatus \(status)")
    }
    return group
}

private func jsonObject(_ json: String) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
}

/// The core's typed error JSON carried by an engine error, or nil.
private func coreErrorJson<T>(_ result: Result<T, Error>) -> String? {
    guard case .failure(let error) = result,
        let failure = error as? E2eeError,
        case .Failure(let message) = failure
    else {
        return nil
    }
    return message
}

// MARK: - Destructive helpers (Simulator only)

#if targetEnvironment(simulator)
/// A saved production item: enough to put it back byte for byte.
private struct SavedItem {
    var data: Data
    let accessible: String
    let label: String?
}

/// Deletes every non-synchronizable item under the production identity.
private func deleteProductionItems() -> OSStatus {
    SecItemDelete(identityQuery() as CFDictionary)
}

/// Adds an item under the production identity with the given value and
/// class, labelled as planted.
private func plantProductionItem(_ data: Data, accessible: CFString) -> OSStatus {
    var query = identityQuery()
    query[kSecAttrAccessible as String] = accessible
    query[kSecAttrLabel as String] = plantedLabel
    query[kSecValueData as String] = data
    return SecItemAdd(query as CFDictionary, nil)
}

private func restoreProductionItem(_ item: SavedItem) -> OSStatus {
    var query = identityQuery()
    query[kSecAttrAccessible as String] = item.accessible
    if let label = item.label {
        query[kSecAttrLabel as String] = label
    }
    query[kSecValueData as String] = item.data
    return SecItemAdd(query as CFDictionary, nil)
}

/// A recognizable value that is not a usable wrap key.
private func pattern(length: Int, seed: UInt8) -> Data {
    Data((0..<length).map { seed &+ UInt8(truncatingIfNeeded: $0) })
}
#endif

final class KeychainProtectorTests: XCTestCase {
    private var storeDirs: [URL] = []

    override func setUpWithError() throws {
        try super.setUpWithError()
        #if targetEnvironment(simulator)
        // A run that crashed mid-test can leave a planted item, which would
        // make the protector fail closed for every later test. Remove only
        // items that carry our label.
        var query = identityQuery()
        query[kSecAttrLabel as String] = plantedLabel
        let status = SecItemDelete(query as CFDictionary)
        XCTAssertTrue(
            status == errSecSuccess || status == errSecItemNotFound,
            "removing a leftover planted item failed, OSStatus \(status)")
        #endif
    }

    override func tearDownWithError() throws {
        for dir in storeDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        storeDirs = []
        try super.tearDownWithError()
    }

    // MARK: Helpers

    /// A store directory that does not exist yet; the core creates it.
    private func makeStoreDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("T1-\(UUID().uuidString)", isDirectory: true)
        storeDirs.append(dir)
        return dir
    }

    /// Runs `body` on a dedicated 8 MiB thread and waits for it here. Engine
    /// calls must never run on the main thread (binding rule 1), and the test
    /// method itself runs on main.
    private func offMain<T>(_ label: String, _ body: @escaping () throws -> T) throws -> T {
        let box = OutcomeBox<T>()
        let finished = expectation(description: label)
        runOnDedicatedThread(name: "gg.sloga.e2ee.t1-tests") {
            box.store(Result { try body() })
            finished.fulfill()
        }
        wait(for: [finished], timeout: 30)
        guard let outcome = box.take() else {
            throw T1Failure(description: "\(label) did not finish in 30 s")
        }
        return try outcome.get()
    }

    /// `enable()` on a new engine over `dir`; the engine is released before
    /// this returns. Returns the device id from the publish payload.
    private func enableStore(_ dir: URL) throws -> String {
        let payload = try offMain("enable") { () throws -> String in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm())
            return try engine.enable()
        }
        return try XCTUnwrap(jsonObject(payload)?["device_id"] as? String, "enable payload has no device_id")
    }

    /// `status()` on a new engine over an existing store. On a provisioned
    /// store this opens it, which unseals `master.key` with the keychain key.
    private func reopenedStatus(_ dir: URL) throws -> [String: Any] {
        let json = try offMain("status") { () throws -> String in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm())
            return try engine.status()
        }
        return try XCTUnwrap(jsonObject(json), "status is not a JSON object")
    }

    private func fileExists(_ dir: URL, _ name: String) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path)
    }

    #if targetEnvironment(simulator)
    /// Positive baseline for the fail-closed tests: a correct 32-byte item
    /// planted under the identity IS adopted (enable on a fresh store
    /// succeeds), then removed again. Without it, a protector that fails on
    /// every existing item would pass those tests for the wrong reason.
    private func assertAdoptsAPlantedValidKey(_ tag: String) throws {
        var valid = pattern(length: 32, seed: 0x70)
        defer { zeroize(&valid) }
        XCTAssertEqual(
            plantProductionItem(valid, accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly),
            errSecSuccess, "planting the baseline key failed")
        let dir = makeStoreDir()
        let outcome = try offMain("enable-baseline") { () throws -> Result<String, Error> in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm())
            return Result { try engine.enable() }
        }
        XCTAssertNil(coreErrorJson(outcome), "\(tag) the core refused a valid planted key")
        XCTAssertTrue(fileExists(dir, "master.key"), "\(tag) the baseline store was not provisioned")
        let removed = deleteProductionItems()
        XCTAssertEqual(removed, errSecSuccess, "removing the baseline key failed")
    }

    /// Saves and removes the production item(s), runs `body` against an empty
    /// identity, then removes whatever `body` left and puts the saved items
    /// back byte for byte. Putting the original key back (rather than letting
    /// the next enable mint a new one) keeps any store already sealed under it
    /// on this Simulator openable.
    private func withProductionItemSetAside(_ body: () throws -> Void) throws {
        var saved: [SavedItem] = []
        for item in try listProductionItems() {
            let accessible = try XCTUnwrap(item.attributes[kSecAttrAccessible as String] as? String)
            saved.append(
                SavedItem(
                    data: try itemData(item.persistentRef),
                    accessible: accessible,
                    label: item.attributes[kSecAttrLabel as String] as? String))
        }
        XCTAssertLessThanOrEqual(saved.count, 1, "[pre] more than one production item before the test")
        defer {
            let cleared = deleteProductionItems()
            XCTAssertTrue(
                cleared == errSecSuccess || cleared == errSecItemNotFound,
                "clearing after the test failed, OSStatus \(cleared)")
            for index in saved.indices {
                let status = restoreProductionItem(saved[index])
                XCTAssertEqual(status, errSecSuccess, "putting the saved production item back failed")
                zeroize(&saved[index].data)
            }
        }
        let removed = deleteProductionItems()
        XCTAssertTrue(
            removed == errSecSuccess || removed == errSecItemNotFound,
            "removing the production item failed, OSStatus \(removed)")
        XCTAssertEqual(
            try listProductionItems(includingSynchronizable: true).count, 0,
            "[pre] the identity is not empty after setting the item aside")
        try body()
    }
    #endif

    // MARK: 1. Round trip

    /// Enable seals a master key under the keychain key; a NEW engine over the
    /// same directory opens the store again, which only works if the master
    /// key unwraps with the key read back from the keychain.
    func testEnableThenReopenUnwrapsTheMasterKey() throws {
        let dir = makeStoreDir()
        let first = try offMain("enable") { () throws -> (before: Bool, payload: String, after: Bool) in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm())
            let before = try engine.isProvisioned()
            let payload = try engine.enable()
            let after = try engine.isProvisioned()
            return (before, payload, after)
        }
        XCTAssertFalse(first.before, "[C1a] a fresh directory reads as provisioned")
        XCTAssertTrue(first.after, "[C1b] enable did not provision the store")
        let deviceId = try XCTUnwrap(jsonObject(first.payload)?["device_id"] as? String, "[C1c] no device_id")
        XCTAssertTrue(fileExists(dir, "master.key"), "[C1d] enable wrote no sealed master key")

        // The first engine is gone (released when its closure returned), so
        // the native one-engine-per-directory rule lets this one in.
        let reopenDir = dir
        let reopened = try offMain("reopen") { () throws -> (status: String, provisioned: Bool, owner: String?) in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let engine = try E2eeEngine(storeDir: reopenDir.path, confirm: DecliningConfirm())
            let status = try engine.status()
            let provisioned = try engine.isProvisioned()
            let owner = try engine.storeOwner()
            return (status, provisioned, owner)
        }
        let status = try XCTUnwrap(jsonObject(reopened.status), "status is not a JSON object")
        XCTAssertEqual(status["enabled"] as? Bool, true, "[C1e] the reopened store is not enabled")
        XCTAssertEqual(status["device_id"] as? String, deviceId, "[C1f] the reopened store has another device")
        XCTAssertTrue(reopened.provisioned, "[C1g] the reopened store is not provisioned")
        XCTAssertNil(reopened.owner, "[C1h] a store that never did MLS reports an owner")
    }

    // MARK: 2. One item, reused

    /// The first enable creates the item; a second store reuses it: still
    /// exactly one item, the same item (same persistent reference), the same
    /// key bytes, and no synchronizable twin. Both stores then open.
    func testSecondStoreReusesTheOneItem() throws {
        #if targetEnvironment(simulator)
        try withProductionItemSetAside {
            let a = makeStoreDir()
            let b = makeStoreDir()

            let idA = try enableStore(a)
            let afterA = try listProductionItems()
            XCTAssertEqual(afterA.count, 1, "[C2a] the first enable did not create exactly one item")
            let refA = try XCTUnwrap(afterA.first?.persistentRef)
            var keyA = try itemData(refA)
            defer { zeroize(&keyA) }

            let idB = try enableStore(b)
            let afterB = try listProductionItems()
            XCTAssertEqual(afterB.count, 1, "[C2b] the second enable added an item")
            let refB = try XCTUnwrap(afterB.first?.persistentRef)
            XCTAssertEqual(refB, refA, "[C2c] the second enable replaced the item")
            var keyB = try itemData(refB)
            defer { zeroize(&keyB) }
            XCTAssertEqual(keyB, keyA, "[C2d] the item's key changed")
            XCTAssertEqual(keyA.count, 32, "[C2e] the wrap key is not 32 bytes")
            XCTAssertEqual(
                try listProductionItems(includingSynchronizable: true).count, 1,
                "[C2f] a synchronizable item exists under the identity")
            XCTAssertNotEqual(idA, idB, "[C2g] the two stores share a device id")

            XCTAssertEqual(try reopenedStatus(a)["device_id"] as? String, idA, "[C2h] store A does not reopen")
            XCTAssertEqual(try reopenedStatus(b)["device_id"] as? String, idB, "[C2i] store B does not reopen")
        }
        #else
        throw XCTSkip("deletes the production keychain item: Simulator only")
        #endif
    }

    // MARK: 3. Attributes

    /// The item the core created carries exactly the D3 attributes. The access
    /// group check, together with the default-group probe, shows the app's
    /// `keychain-access-groups` entitlement (team prefix included) matches the
    /// core's constant: with any other prefix the core's add would have failed.
    func testItemAttributesAreExact() throws {
        // Make sure an item exists. Enable only when there is none, so this
        // test checks the attributes the core's add wrote and does not depend
        // on the core reading an existing item (covered by the tests above).
        if try listProductionItems().isEmpty {
            _ = try enableStore(makeStoreDir())
        }

        let items = try listProductionItems()
        XCTAssertEqual(items.count, 1, "[C3a] not exactly one production item")
        XCTAssertEqual(
            try listProductionItems(includingSynchronizable: true).count, 1,
            "[C3b] a synchronizable item exists under the identity")
        let attributes = try XCTUnwrap(items.first?.attributes)

        XCTAssertEqual(kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String, "aku")
        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
            "[C3c] pdmn is not WhenUnlockedThisDeviceOnly")

        let sync = try XCTUnwrap(attributes[kSecAttrSynchronizable as String], "[C3d] sync missing") as AnyObject
        XCTAssertEqual(CFGetTypeID(sync), CFNumberGetTypeID(), "[C3e] sync is not a CFNumber")
        XCTAssertEqual((sync as? NSNumber)?.intValue, 0, "[C3f] sync is not 0")

        XCTAssertEqual(
            attributes[kSecAttrAccessGroup as String] as? String, "M6UUDLK2XQ.gg.sloga.app.e2ee",
            "[C3g] agrp is not the core's access group")
        XCTAssertEqual(attributes[kSecAttrService as String] as? String, "gg.sloga.app.e2ee", "[C3h] svce")
        XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "e2ee-master-wrap", "[C3i] acct")

        XCTAssertEqual(
            try defaultAccessGroup(), "M6UUDLK2XQ.gg.sloga.app.e2ee",
            "[C3j] the app's first keychain access group is not the core's")
    }

    // MARK: 4 + 5. Wrong-length item

    /// A 16-byte item under our identity (correct class, not synchronizable)
    /// cannot be a wrap key. The core skips it, its add hits the duplicate,
    /// the re-read is still empty, and enable fails `protector`. The item is
    /// never replaced and the store is never provisioned. The baseline first
    /// shows a valid planted key IS adopted, so the refusal is about length.
    func testWrongLengthItemFailsClosedAndIsNeverReplaced() throws {
        #if targetEnvironment(simulator)
        try withProductionItemSetAside {
            try assertAdoptsAPlantedValidKey("[C4-base]")
            var planted = pattern(length: 16, seed: 0xA0)
            defer { zeroize(&planted) }
            XCTAssertEqual(
                plantProductionItem(planted, accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly),
                errSecSuccess, "planting the short item failed")
            let before = try listProductionItems()
            XCTAssertEqual(before.count, 1)
            let ref = try XCTUnwrap(before.first?.persistentRef)

            let dir = makeStoreDir()
            let outcome = try offMain("enable-short") {
                () throws -> (first: Result<String, Error>, second: Result<String, Error>, provisioned: Bool) in
                dispatchPrecondition(condition: .notOnQueue(.main))
                let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm())
                let first = Result { try engine.enable() }
                let second = Result { try engine.enable() }
                let provisioned = try engine.isProvisioned()
                return (first, second, provisioned)
            }
            XCTAssertEqual(coreErrorJson(outcome.first), protectorJson, "[C4a] enable did not fail protector")
            XCTAssertEqual(coreErrorJson(outcome.second), protectorJson, "[C4b] a retry did not fail protector")

            // 5: a protector failure leaves nothing provisioned behind.
            XCTAssertFalse(outcome.provisioned, "[C5a] the failed enable left a provisioned store")
            XCTAssertFalse(fileExists(dir, "master.key"), "[C5b] the failed enable wrote master.key")
            XCTAssertFalse(fileExists(dir, "store.db"), "[C5c] the failed enable wrote store.db")

            let after = try listProductionItems(includingSynchronizable: true)
            XCTAssertEqual(after.count, 1, "[C4c] an item was added next to the short one")
            XCTAssertEqual(after.first?.persistentRef, ref, "[C4d] the short item was replaced")
            var stored = try itemData(ref)
            defer { zeroize(&stored) }
            XCTAssertEqual(stored, planted, "[C4e] the short item's value changed")
            XCTAssertEqual(stored.count, 16, "[C4f] the short item is no longer 16 bytes")
            XCTAssertEqual(after.first?.attributes[kSecAttrLabel as String] as? String, plantedLabel, "[C4g]")
        }
        #else
        throw XCTSkip("plants an item under the production identity: Simulator only")
        #endif
    }

    // MARK: 5. Foreign accessibility class

    /// A 32-byte item under our identity but of a weaker class (what a dev or
    /// probe build could leave) is refused, not adopted (audit MINOR m3): the
    /// class is not part of the item's uniqueness key, so adopting it would be
    /// permanent. Enable fails `protector`, nothing is provisioned, the item
    /// stays as it was.
    func testForeignClassItemFailsClosedAndIsNeverReplaced() throws {
        #if targetEnvironment(simulator)
        try withProductionItemSetAside {
            try assertAdoptsAPlantedValidKey("[C5-base]")
            var planted = pattern(length: 32, seed: 0x40)
            defer { zeroize(&planted) }
            XCTAssertEqual(
                plantProductionItem(planted, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly),
                errSecSuccess, "planting the foreign-class item failed")
            let ref = try XCTUnwrap(try listProductionItems().first?.persistentRef)

            let dir = makeStoreDir()
            let outcome = try offMain("enable-foreign") { () throws -> (Result<String, Error>, Bool) in
                dispatchPrecondition(condition: .notOnQueue(.main))
                let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm())
                let enabled = Result { try engine.enable() }
                let provisioned = try engine.isProvisioned()
                return (enabled, provisioned)
            }
            XCTAssertEqual(coreErrorJson(outcome.0), protectorJson, "[C5d] a weaker-class item was accepted")
            XCTAssertFalse(outcome.1, "[C5e] the failed enable left a provisioned store")
            XCTAssertFalse(fileExists(dir, "master.key"), "[C5f] the failed enable wrote master.key")

            let after = try listProductionItems(includingSynchronizable: true)
            XCTAssertEqual(after.count, 1, "[C5g] an item was added next to the foreign one")
            XCTAssertEqual(after.first?.persistentRef, ref, "[C5h] the foreign item was replaced")
            XCTAssertEqual(
                after.first?.attributes[kSecAttrAccessible as String] as? String,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
                "[C5i] the foreign item's class changed")
            var stored = try itemData(ref)
            defer { zeroize(&stored) }
            XCTAssertEqual(stored, planted, "[C5j] the foreign item's value changed")
        }
        #else
        throw XCTSkip("plants an item under the production identity: Simulator only")
        #endif
    }

    // MARK: 5. Existing store, wrong key

    /// A provisioned store whose wrap key is not in the keychain (a different
    /// 32-byte key is) fails `protector` on open, stays provisioned, and its
    /// sealed master key is not rewritten. Once the right key is back the
    /// same store opens with the same device: nothing was regenerated.
    func testWrongKeyLeavesAnExistingStoreIntact() throws {
        #if targetEnvironment(simulator)
        let dir = makeStoreDir()
        let deviceId = try enableStore(dir)
        let sealedBefore = try Data(contentsOf: dir.appendingPathComponent("master.key"))

        try withProductionItemSetAside {
            var planted = pattern(length: 32, seed: 0x10)
            defer { zeroize(&planted) }
            XCTAssertEqual(
                plantProductionItem(planted, accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly),
                errSecSuccess, "planting the wrong key failed")

            let outcome = try offMain("open-wrong-key") { () throws -> (Result<String, Error>, Bool) in
                dispatchPrecondition(condition: .notOnQueue(.main))
                let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm())
                let status = Result { try engine.status() }
                let provisioned = try engine.isProvisioned()
                return (status, provisioned)
            }
            XCTAssertEqual(coreErrorJson(outcome.0), protectorJson, "[C6a] the store opened under the wrong key")
            XCTAssertTrue(outcome.1, "[C6b] the store stopped reading as provisioned")
            let sealedAfter = try Data(contentsOf: dir.appendingPathComponent("master.key"))
            XCTAssertEqual(sealedAfter, sealedBefore, "[C6c] the sealed master key was rewritten")
            XCTAssertEqual(try listProductionItems().count, 1, "[C6d] an item was added next to the wrong key")
        }

        let status = try reopenedStatus(dir)
        XCTAssertEqual(status["enabled"] as? Bool, true, "[C6e] the store does not reopen with its key back")
        XCTAssertEqual(status["device_id"] as? String, deviceId, "[C6f] the store came back as another device")
        #else
        throw XCTSkip("plants an item under the production identity: Simulator only")
        #endif
    }

    // MARK: 6. Locked device

    /// The Swift half of the locked-device path: the core's `protector_locked`
    /// (and `protector`) reach the webview verbatim, so the FE can show
    /// "unlock and retry" instead of the generic failure.
    func testProtectorTagsReachTheWebviewVerbatim() {
        XCTAssertEqual(
            rejectJson(for: E2eeError.Failure(message: protectorLockedJson)), protectorLockedJson,
            "[C7a] protector_locked was rewritten on the reject path")
        XCTAssertEqual(
            rejectJson(for: E2eeError.Failure(message: protectorJson)), protectorJson,
            "[C7b] protector was rewritten on the reject path")
    }

    /// The Rust half cannot be driven from here: the Simulator has no lock
    /// state, and the production engine has no way to inject a keychain
    /// status (by design; the selftest seam is not in this build).
    func testInjectedInteractionNotAllowedMapsToProtectorLocked() throws {
        throw XCTSkip(
            "-25308 -> protector_locked needs a status-injection seam the production engine does not have; "
                + "covered by core unit tests locked_status_maps_to_protector_locked_on_every_path and "
                + "protector_locked_serializes_to_exact_tag_with_no_fields, and by device leg L-R3")
    }
}

// E2eeStore.swift: where the core's store lives on disk and how it is
// protected (IE plan D4). Plain Foundation file work: no engine calls, no
// logging, safe on any non-main thread.
import Darwin
import Foundation

enum E2eeStore {
    /// `Library/Application Support/e2ee` (+ `attachments/`), created if absent with
    /// `.completeUntilFirstUserAuthentication`; the class is re-asserted on the directory,
    /// `attachments/` and every existing regular file under it; `isExcludedFromBackup = true`
    /// is set on the directory. Throws `E2eeReject.cryptoFailure` when any step fails.
    ///
    /// Why this class: under `.complete` SQLite's WAL writes, checkpoints and the
    /// mmapped `-shm` can fail or SIGBUS once the device locks with the store
    /// open. Secrets inside are column-encrypted under a key that needs the
    /// WhenUnlocked keychain item, so this class only exposes metadata.
    ///
    /// Why the backup exclusion is mandatory: a backup restored to the same
    /// device brings back an old store next to the still-valid key, which rolls
    /// the Olm ratchets back (key reuse across different plaintexts).
    static func prepareStoreDirectory() throws -> URL {
        do {
            let fm = FileManager.default
            // Application Support: backed up only if we fail to exclude it, never
            // purged by the OS (an emptied Caches/tmp dir would read as
            // never-provisioned) and not visible in the Files app.
            let support = try fm.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            let dir = support.appendingPathComponent("e2ee", isDirectory: true).standardizedFileURL
            let attachments = dir.appendingPathComponent("attachments", isDirectory: true)

            try ensureRealDirectory(dir)
            try ensureRealDirectory(attachments)

            // Files SQLite and the core created earlier keep whatever class they
            // were born with, so re-assert it on every launch before Rust opens them.
            try setProtection(dir.path)
            try setProtection(attachments.path)
            try reassertProtection(under: dir.path)

            // Set on every launch: the flag lives on this inode, so a store dir
            // that was recreated would otherwise silently start being backed up.
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var target = dir
            try target.setResourceValues(values)

            return dir
        } catch {
            // No path, errno or Foundation text leaves this function.
            throw E2eeReject.cryptoFailure
        }
    }

    /// `isExcludedFromBackup = true` on `Library/WebKit` (if it exists). Never throws.
    ///
    /// IndexedDB drafts and the outbox can hold E2EE plaintext, and a backup
    /// would carry it off the device; Android excludes `app_webview` the same
    /// way. Never creates the directory: WebKit owns it.
    static func excludeWebKitFromBackup() {
        guard let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else {
            return
        }
        var webKit = library.appendingPathComponent("WebKit", isDirectory: true)
        guard case .directory = entryKind(webKit.path) else {
            return
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? webKit.setResourceValues(values)
    }

    // MARK: - Private

    private static let protectionClass = FileProtectionType.completeUntilFirstUserAuthentication

    private enum EntryKind {
        case absent
        case directory
        case regularFile
        case other
    }

    private struct StoreFsError: Error {}

    /// What is at `path`, without following a symlink (lstat). A symlink is
    /// `.other`: following one would let the store or its protection change land
    /// outside the store directory.
    private static func entryKind(_ path: String) -> EntryKind? {
        var info = stat()
        if lstat(path, &info) != 0 {
            return errno == ENOENT ? .absent : nil
        }
        switch info.st_mode & S_IFMT {
        case S_IFDIR: return .directory
        case S_IFREG: return .regularFile
        default: return .other
        }
    }

    /// Create `url` with the store's class if absent; afterwards it must be a
    /// real directory. Anything else there (a file, a symlink) is refused rather
    /// than removed: we never delete or rename what might be a user's store.
    private static func ensureRealDirectory(_ url: URL) throws {
        guard let kind = entryKind(url.path) else {
            throw StoreFsError()
        }
        if case .absent = kind {
            // A concurrent creator is fine; the re-check below decides.
            try? FileManager.default.createDirectory(
                at: url,
                withIntermediateDirectories: false,
                attributes: [.protectionKey: protectionClass]
            )
        }
        guard case .directory = entryKind(url.path) else {
            throw StoreFsError()
        }
    }

    private static func setProtection(_ path: String) throws {
        try FileManager.default.setAttributes([.protectionKey: protectionClass], ofItemAtPath: path)
    }

    /// Re-assert the class on every regular file below `root`, descending only
    /// into real directories. Symlinks and special files are skipped, nothing is
    /// moved or removed. An entry that vanishes mid-walk is skipped; any other
    /// failure throws, because an unprotected store file is not acceptable.
    private static func reassertProtection(under root: String) throws {
        var pending = [root]
        while let directory = pending.popLast() {
            let names = try FileManager.default.contentsOfDirectory(atPath: directory)
            for name in names {
                let path = (directory as NSString).appendingPathComponent(name)
                guard let kind = entryKind(path) else {
                    throw StoreFsError()
                }
                switch kind {
                case .absent, .other:
                    continue
                case .directory:
                    pending.append(path)
                case .regularFile:
                    do {
                        try setProtection(path)
                    } catch {
                        // Removed between the lstat and the set (e.g. a stale
                        // journal): nothing left to protect.
                        if case .absent? = entryKind(path) {
                            continue
                        }
                        throw error
                    }
                }
            }
        }
    }
}

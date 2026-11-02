// The single auditable command table of the iOS `E2ee` plugin (plan D5, §5;
// the Electron `electron-shell/src/e2ee-commands.js` pattern). Every routing
// decision the plugin makes for an `e2ee_*` name is read from here, so a
// reviewer checks one list instead of a switch spread over several files.
//
// How the list was derived (so G6 can recompute it; FE base 8821aac9, run
// from `packages/client`):
//
//   grep -rhoE "[\"']e2ee_[a-z0-9_]+[\"']" \
//     --exclude-dir=node_modules --exclude-dir=android --exclude-dir=ios \
//     --exclude-dir=dist --include=*.ts --include=*.tsx \
//     --exclude=*.test.ts --exclude=*.harness.ts . | tr -d "\"'" | sort -u
//
// At that base it yielded 87 names. Seven are not native commands and are
// dropped: the modal ids e2ee_disable, e2ee_reenroll, e2ee_verify,
// e2ee_identity_change, e2ee_peer_downgrade, e2ee_group_plaintext_confirm
// (modals.tsx / types.ts), and e2ee_unverified, a call-chip state
// (rtc/chipInputs.ts). e2ee_enable and e2ee_enable_group are modal ids too,
// but they are also real commands, so they stay. The remaining 80 are all
// invoke targets: e2ee.ts `#invoke` plus CapacitorTransport's `command ===`
// arms, and rtc/remoteControl.ts (Tauri `invoke`).
//
// Protected channels (W4) add 20 more names: the 19 e2ee_text_* commands and
// e2ee_mls_group_kind (`TEXT_COMMANDS` in protectedTextTypes.ts), sent only by
// e2ee.ts `#textInvoke` on the Tauri main window. iOS never builds the text
// manager, so all 20 are `.out`. The same grep then yields 107 names, so the
// table has 100.
//
// iOS call E2EE phase 2 (W2) changes routes only, not the name set: the grep
// re-run at f46a4411 still yields the same 107 names. The 23 MLS call-plane
// names were `.out`; now:
//   - 22 are `.call`: the `call` mux runs them on the separate CALL worker
//     (`E2eeRuntime.callWorker`, gg.sloga.e2ee.call), not the engine worker,
//     so a burst of DM work cannot queue a call commit behind it (D5). Honest
//     limit: the core engine mutex is still shared, so the two planes still
//     serialise inside core.
//   - e2ee_call_frame_keys is the one key egress routed to the webview, as on
//     Android: its result is frame-key material for the LiveKit E2EE worker
//     (plan §7.2). Every other `.call` name moves public wire shapes or opaque
//     ciphertext. The `callKeysChanged` event (KeysChangedRelay) carries only
//     group_id and epoch, never a key.
//   - e2ee_call_confirm_downgrade is `.dedicated("callConfirmDowngrade")`:
//     taking a call to plaintext needs the native dialog, like the other
//     confirm-gated names.
// 100 = 37 generic + 2 native + 22 call + 7 dedicated + 32 out.
//
// e2ee_recovery_* (context/create/rotate/restore/finish) are NOT here: no FE
// file sends them (only the desktop recovery window does). They are unknown
// names, so `route(for:)` answers `.out` for them anyway.

import Foundation

enum E2eeRoute: Equatable {
    /// `call` mux on the engine worker → the engine method of the same (camelCased) name.
    case generic
    /// `call` mux, handled by native Swift (AttachmentTransfer) on a dedicated thread.
    case native
    /// `call` mux on the CALL worker → the engine method of the same camelCased name.
    case call
    /// Only through this dedicated plugin method; never handled by `call`.
    case dedicated(String)
    /// Not on iOS: `call` rejects `invalid_argument{field:"name"}`.
    case out
}

enum E2eeCommands {
    /// Every `e2ee_*` command name the frontend can send, one entry per line.
    static let table: [(name: String, route: E2eeRoute)] = [
        // Generic (37): `call` mux on the engine worker.
        // Device lifecycle
        ("e2ee_status", .generic),
        ("e2ee_is_provisioned", .generic),
        ("e2ee_store_owner", .generic),
        ("e2ee_enable", .generic),
        ("e2ee_mark_published", .generic),
        ("e2ee_replenish", .generic),
        ("e2ee_sign_claim", .generic),
        // DM messaging
        ("e2ee_encrypt", .generic),
        ("e2ee_decrypt", .generic),
        ("e2ee_history", .generic),
        ("e2ee_send_mode", .generic),
        ("e2ee_conversation_state", .generic),
        ("e2ee_reconcile_devices", .generic),
        ("e2ee_handle_receipts", .generic),
        ("e2ee_device_removed", .generic),
        // Group messaging. acknowledge_group_plaintext is the documented
        // no-dialog exception (plan §5): it records consent to send
        // unencrypted to a group this device has no record of, and core
        // refuses it if the state moved since the prompt was shown.
        ("e2ee_send_mode_group", .generic),
        ("e2ee_acknowledge_group_plaintext", .generic),
        ("e2ee_encrypt_group", .generic),
        ("e2ee_group_reconcile", .generic),
        ("e2ee_group_state", .generic),
        // Verification + downgrade defense
        ("e2ee_safety_number", .generic),
        // Generic for the DECLINE direction only. The FE sends accept == true
        // to the dedicated `confirmPeerDowngradeAccept` instead, and the mux
        // rejects accept == true, so opening plaintext always needs the
        // native dialog the webview cannot draw.
        ("e2ee_confirm_peer_downgrade", .generic),
        ("e2ee_resend_downgrade", .generic),
        ("e2ee_mark_downgrade_delivered", .generic),
        ("e2ee_pending_downgrades", .generic),
        ("e2ee_notify_downgrade", .generic),
        ("e2ee_downgraded_conversations", .generic),
        // Attachments (prepare takes base64 from JS; the ciphertext itself
        // moves natively through attachmentUpload/attachmentFetch)
        ("e2ee_attachment_prepare", .generic),
        ("e2ee_attachment_attach_blob", .generic),
        ("e2ee_attachment_mark_unavailable", .generic),
        ("e2ee_attachment_recipients", .generic),
        ("e2ee_attachment_recipients_group", .generic),
        // Backup: ciphertext courier only; the recovery code never reaches
        // the webview (backupCreate/Rotate/Restore + the native sheet)
        ("e2ee_backup_status", .generic),
        ("e2ee_backup_refresh_if_due", .generic),
        ("e2ee_backup_mark_uploaded", .generic),
        ("e2ee_backup_forget_local", .generic),
        ("e2ee_backup_rederive_republish", .generic),

        // Native (2): arrive through `call`, handled by AttachmentTransfer.
        // They are not forwarded to an engine method, so plaintext goes
        // from the engine to the pasteboard or file without the webview.
        ("e2ee_attachment_copy_image", .native),
        ("e2ee_attachment_save", .native),

        // Call (22): `call` mux on the CALL worker (media E2EE, MLS call
        // plane). call_frame_keys is the one key egress to the webview.
        ("e2ee_call_create", .call),
        ("e2ee_call_join_intent", .call),
        ("e2ee_call_verify_join_intent", .call),
        ("e2ee_call_admit", .call),
        ("e2ee_call_process", .call),
        ("e2ee_call_commit_won", .call),
        ("e2ee_call_commit_lost", .call),
        ("e2ee_call_pending_commit_epoch", .call),
        ("e2ee_call_leave_cleanup", .call),
        ("e2ee_call_local_groups", .call),
        ("e2ee_call_heartbeat", .call),
        ("e2ee_call_remove", .call),
        ("e2ee_call_state", .call),
        ("e2ee_call_roster_identities", .call),
        ("e2ee_call_frame_keys", .call),
        ("e2ee_call_announce", .call),
        ("e2ee_call_clear_downgrade", .call),
        ("e2ee_call_non_enrolled", .call),
        ("e2ee_pin_call_identities", .call),
        ("e2ee_mls_publish_key_packages", .call),
        ("e2ee_mls_replenish", .call),
        ("e2ee_mls_expire_key_packages", .call),

        // Dedicated (7): confirm-gated. Absent from the `call` switch so the
        // webview can only request the change; a native dialog commits it.
        ("e2ee_wipe", .dedicated("wipe")),
        ("e2ee_downgrade", .dedicated("downgrade")),
        ("e2ee_enable_group", .dedicated("enableGroup")),
        ("e2ee_add_group_member", .dedicated("addGroupMember")),
        ("e2ee_mark_verified", .dedicated("markVerified")),
        ("e2ee_accept_identity_change", .dedicated("acceptIdentityChange")),
        ("e2ee_call_confirm_downgrade", .dedicated("callConfirmDowngrade")),

        // Out (32): desktop-only. `call` rejects invalid_argument{field:"name"}.
        // Desktop binary attachment path (iOS moves ciphertext natively)
        ("e2ee_attachment_ciphertext", .out),
        ("e2ee_attachment_store", .out),
        // Desktop recovery window flow (iOS uses the native sheet instead,
        // and the pending bundles are taken by RecoverySheet only)
        ("e2ee_backup_open_recovery", .out),
        ("e2ee_backup_take_pending_upload", .out),
        ("e2ee_backup_take_pending_republish", .out),
        // Remote control (sent through the Tauri invoke, never Capacitor)
        ("e2ee_rc_open_apply", .out),
        ("e2ee_rc_seal", .out),
        ("e2ee_rc_set_local_user", .out),
        ("e2ee_rc_offer", .out),
        ("e2ee_rc_cancel", .out),
        ("e2ee_rc_accept", .out),
        ("e2ee_rc_start", .out),
        // Protected text channels (W4): the Tauri main window's text plane
        // only, through e2ee.ts `#textInvoke`. iOS never builds the manager.
        ("e2ee_text_group_create", .out),
        ("e2ee_text_join", .out),
        ("e2ee_text_admit", .out),
        ("e2ee_text_process", .out),
        ("e2ee_text_commit_won", .out),
        ("e2ee_text_commit_lost", .out),
        ("e2ee_text_pending_commit", .out),
        ("e2ee_text_encrypt", .out),
        ("e2ee_text_decrypt", .out),
        ("e2ee_text_seat_list_sign", .out),
        ("e2ee_text_seat_list_verify", .out),
        ("e2ee_text_owner_pin_state", .out),
        ("e2ee_text_owner_confirm_change", .out),
        ("e2ee_text_owner_handover_sign", .out),
        ("e2ee_text_remove", .out),
        ("e2ee_text_update", .out),
        ("e2ee_text_state", .out),
        ("e2ee_text_mark_left", .out),
        ("e2ee_text_pin_own_devices", .out),
        ("e2ee_mls_group_kind", .out),
    ]

    /// The dedicated plugin methods (D5), in this order, `call` excluded.
    static let dedicatedMethods: [String] = [
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
    ]

    /// Count pins (G6/G9).
    static let genericCount = 37
    static let nativeCount = 2
    static let callCount = 22
    static let dedicatedCount = 7
    /// Desktop-only FE names in the table; tests pin it with the others.
    static let outCount = 32

    // Built once. A duplicate name keeps its FIRST entry rather than
    // trapping: a crash here would be reachable from any webview message,
    // and the tests are what reject duplicates.
    private static let routes: [String: E2eeRoute] = {
        var map: [String: E2eeRoute] = [:]
        map.reserveCapacity(table.count)
        for entry in table where map[entry.name] == nil {
            map[entry.name] = entry.route
        }
        return map
    }()

    /// Route of `name`; anything not in the table is `.out`.
    static func route(for name: String) -> E2eeRoute {
        // Unknown means rejected: a name only reaches the engine through
        // `call` if it is listed here as generic or call.
        routes[name] ?? .out
    }
}

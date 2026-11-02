// Spec for the E2EE multi-device UI (W3 lane L-UI; plan
// e2ee-multi-device-restore D3, D5, D7, D8), run with Node's built-in runner
// from packages/client:
//   node --conditions=browser --test components/modal/modals/e2eeMultiDeviceUi.scan.test.ts
//
// The modals and the settings page import Solid, lingui and the UI kit, so
// Node cannot load them; their wiring is pinned by reading the sources with
// comments stripped (prose never counts).
//
//  U1  E2EEEnable.tsx no longer promises "will not see a security warning"
//      for a restore (a restore adds a NEW device, which contacts see) and
//      explains the two prompts before the first one (D3, Q6);
//  U2  the owned copy is verbatim, each string a whole lingui msgid
//      (`<Trans>` or t``) in the file that owns it; no JSX nested in a
//      `<Trans>` (it would not resolve);
//  U3  "Make this a separate device" is offered only under
//      `splitSupported.get("state") === true`, and only `useE2EESplit` calls
//      `splitDevice` (D5; an old server would sweep the shared device);
//  U4  Encryption.tsx keeps the backup-status guard
//      `if (!e2ee || !enabled()) return;` (e2eeIosGate E3) and `enabled()`
//      still needs `published`;
//  U5  the four modal ids are declared in types.ts and have their switch
//      arms in modals.tsx, before `default` (which only logs);
//  U6  the bridge's `reauth` callbacks are the house MFA flow and resolve
//      undefined on dismiss or failure; the multi-device modals never call
//      `finishReenroll` (a removed or new device must not re-add the old
//      identity);
//  U7  "Not now" on the shared-device modal and card dismisses the signal
//      (Q12); a finish-setup, removed or remove prompt never clears its own
//      signal from the UI;
//  U8  blank-page traps: no `styled(Component)` in the new files.
//
// Point `E2EE_MD_UI_ROOT` at another `components/` root (the known-bad
// control: the 144297ab tree) to scan that instead; it must fail.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.E2EE_MD_UI_ROOT || join(here, "../..");

/** A missing file reads as "" so every rule fails on its own line. */
function read(rel: string): string {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const FILES = {
  enable: "modal/modals/E2EEEnable.tsx",
  finish: "modal/modals/E2EEFinishSetup.tsx",
  shared: "modal/modals/E2EEDeviceShared.tsx",
  removed: "modal/modals/E2EEDeviceRemoved.tsx",
  remove: "modal/modals/E2EERemoveDevice.tsx",
  types: "modal/types.ts",
  modals: "modal/modals.tsx",
  settings: "app/interface/settings/user/Encryption.tsx",
} as const;
type FileKey = keyof typeof FILES;

const SRC = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, code(read(rel))]),
) as Record<FileKey, string>;

/** Every lingui msgid in a source: `<Trans>` bodies and t`` literals. */
function msgids(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<Trans>([\s\S]*?)<\/Trans>/g)) {
    out.push(norm(m[1]));
  }
  for (const m of src.matchAll(/\bt`([^`]*)`/g)) out.push(norm(m[1]));
  return out;
}

/** The text from `open` to its balanced closing tag (one tag name). */
function tagRegion(src: string, at: number, tag: string): string {
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  re.lastIndex = at;
  let depth = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return src.slice(at, m.index + m[0].length);
  }
  return src.slice(at);
}

/** The body of `function name(` / `async function name(`, brace-balanced. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\(`).exec(src);
  if (!m) return "";
  const open = src.indexOf("{", src.indexOf(")", m.index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const COPY = {
  twoPrompts:
    "Confirm your password twice: once to fetch your backup, once to register this device",
  finishTitle: "Finish setting up encryption on this device",
  recoveryCode: "Create a recovery code for this device",
  otherDevices:
    "Your other devices still work. If one of them is lost or replaced, remove it.",
  shared:
    "This app shares its encryption identity with another of your apps (it was restored from your recovery code). Messages can go missing on one of them. Make this app a separate device: it keeps its message history, and your contacts will see you added a device.",
  makeSeparate: "Make this a separate device",
  notNow: "Not now",
  removed:
    "This device was removed from your account's encryption. Set it up again as a new device?",
  setUpNew: "Set up as a new device",
  thisDevice: "This device",
  neverSeen: "never seen",
  remove: "Remove",
  alsoDeleteBackup: "Also delete this device's backup",
  busy: "Close the recovery code window first, then try again.",
  rotateScope: "This changes the recovery code for this device's backup only.",
};

const OWNED: Record<FileKey, (keyof typeof COPY)[]> = {
  enable: ["twoPrompts"],
  finish: ["finishTitle", "recoveryCode", "otherDevices", "notNow"],
  shared: ["shared", "makeSeparate", "notNow", "busy"],
  removed: ["removed", "setUpNew", "notNow", "recoveryCode"],
  remove: ["thisDevice", "neverSeen", "remove", "alsoDeleteBackup"],
  settings: [
    "finishTitle",
    "shared",
    "makeSeparate",
    "notNow",
    "removed",
    "setUpNew",
    "rotateScope",
  ],
  types: [],
  modals: [],
};

describe("E2EE multi-device UI (lane L-UI)", () => {
  it("U1 the restore lead no longer promises no security warning (Q6, D3)", () => {
    const raw = norm(read(FILES.enable));
    assert.ok(raw.length > 0, "E2EEEnable.tsx missing");
    assert.doesNotMatch(raw, /will not see a security warning/);
    const ids = msgids(SRC.enable);
    assert.ok(
      ids.some((id) =>
        id.endsWith(
          "message history on this device. It is added as a new device, and your contacts will see that you added one.",
        ),
      ),
      "Q6 restore lead sentence missing",
    );
    // The two-prompt explanation sits in the restore lead, i.e. on screen
    // before restore() asks for the first ticket.
    const lead = SRC.enable.indexOf("<Match when={leadRestore()}>");
    assert.ok(lead !== -1, "restore lead branch missing");
    assert.ok(
      msgids(tagRegion(SRC.enable, lead, "Match")).includes(COPY.twoPrompts),
      "the two-prompt explanation is not in the restore lead",
    );
  });

  it("U2 owned copy is verbatim, one whole msgid each, no JSX in <Trans>", () => {
    for (const [file, keys] of Object.entries(OWNED) as [
      FileKey,
      (keyof typeof COPY)[],
    ][]) {
      const ids = msgids(SRC[file]);
      for (const key of keys) {
        assert.ok(
          ids.includes(COPY[key]),
          `${FILES[file]} lacks the msgid ${JSON.stringify(COPY[key])}`,
        );
      }
      for (const m of SRC[file].matchAll(/<Trans>([\s\S]*?)<\/Trans>/g)) {
        assert.doesNotMatch(m[1], /[<{]/, `${FILES[file]}: JSX in <Trans>`);
      }
    }
    // US spelling in the new copy.
    for (const file of ["finish", "shared", "removed", "remove"] as const) {
      for (const id of msgids(SRC[file])) {
        assert.doesNotMatch(id, /\b(colour|organis|authoris|recognis)/i, id);
      }
    }
  });

  it("U3 the split is offered only under splitSupported === true (D5)", () => {
    // Only the shared hook calls the bridge, once.
    for (const file of Object.keys(FILES) as FileKey[]) {
      const n = count(SRC[file], /\.splitDevice\(/g);
      assert.equal(n, file === "shared" ? 1 : 0, `${FILES[file]} splitDevice`);
    }
    assert.match(
      fnBody(SRC.shared, "useE2EESplit"),
      /await e2ee\.splitDevice\(reauth\);/,
    );
    // Every read of the capability is a strict `=== true` (absent = unknown
    // = hidden).
    for (const file of ["shared", "settings"] as const) {
      const reads = [
        ...SRC[file].matchAll(
          /splitSupported\.get\("state"\)(\s*===\s*true)?/g,
        ),
      ];
      assert.ok(reads.length > 0, `${FILES[file]} never reads splitSupported`);
      for (const r of reads) {
        assert.ok(r[1], `${FILES[file]}: splitSupported read without === true`);
      }
    }

    // Modal: the action sits inside `splitSupported() ? [ ... ] : []`, and
    // makeSeparate re-checks it.
    const S = SRC.shared;
    assert.match(
      S,
      /const splitSupported = \(\) => e2ee\?\.splitSupported\.get\("state"\) === true;/,
    );
    assert.match(
      fnBody(S, "makeSeparate"),
      /^\{\s*if \(!splitSupported\(\)\) return;\s*if \(await split\.run\(\)\) setDone\(true\);\s*\}$/,
    );
    const gate = S.indexOf("...(splitSupported()");
    assert.ok(gate !== -1, "modal action not gated on splitSupported()");
    const gated = S.slice(gate, S.indexOf(": [])", gate));
    assert.match(gated, /<Trans>Make this a separate device<\/Trans>/);
    assert.equal(
      count(S, /(?<!function )makeSeparate\(\)/g),
      1,
      "one makeSeparate() call",
    );
    assert.ok(gated.includes("void makeSeparate();"), "call outside the gate");
    assert.equal(
      count(S, /split\.run\(\)/g),
      1,
      "split.run() only in makeSeparate",
    );

    // Card: the only split.run() sits inside the Show gated on === true.
    const C = SRC.settings;
    assert.equal(count(C, /split\.run\(\)/g), 1, "one split.run() in the card");
    const show = C.search(
      /<Show\s+when=\{\s*shared\(\) && !removed\(\) && e2ee\.splitSupported\.get\("state"\) === true\s*\}\s*>/,
    );
    assert.ok(show !== -1, "card not gated on splitSupported === true");
    const region = tagRegion(C, show, "Show");
    assert.ok(region.includes("onClick={() => void split.run()}"));
    assert.match(region, /<Trans>Make this a separate device<\/Trans>/);
    assert.equal(
      count(C, /<Trans>Make this a separate device<\/Trans>/g),
      1,
      "the card offers the split once",
    );
  });

  it("U4 Encryption.tsx keeps the backup-status guard (E3)", () => {
    const body = fnBody(SRC.settings, "reload");
    assert.match(
      body,
      /^\{\s*if \(!e2ee \|\| !enabled\(\)\) return;\s*try \{\s*setStatus\(await e2ee\.backupStatus\(\)\);/,
    );
    assert.match(
      fnBody(SRC.settings, "RecoveryBackupCard"),
      /const enabled = \(\) => \{\s*const state = e2ee\.status\.get\("state"\);\s*return !!state\?\.enabled && !!state\?\.published;\s*\};/,
    );
    assert.equal(count(SRC.settings, /\.backupStatus\(/g), 1);
    for (const file of ["finish", "shared", "removed", "remove"] as const) {
      assert.equal(count(SRC[file], /backupStatus/g), 0, FILES[file]);
    }
  });

  it("U5 the four modal ids are registered with switch arms", () => {
    const arms: [string, string][] = [
      ["e2ee_finish_setup", "E2EEFinishSetupModal"],
      ["e2ee_device_shared", "E2EEDeviceSharedModal"],
      ["e2ee_device_removed", "E2EEDeviceRemovedModal"],
      ["e2ee_remove_device", "E2EERemoveDeviceModal"],
    ];
    const def = SRC.modals.indexOf("default:");
    assert.ok(def !== -1, "modals.tsx default arm missing");
    for (const [id, component] of arms) {
      assert.equal(
        count(SRC.types, new RegExp(`type: "${id}";`, "g")),
        1,
        `types.ts declares ${id} once`,
      );
      const file = component.replace(/Modal$/, "");
      assert.match(
        SRC.modals,
        new RegExp(`import \\{ ${component} \\} from "\\./modals/${file}";`),
      );
      const arm = SRC.modals.indexOf(`case "${id}":`);
      assert.ok(arm !== -1 && arm < def, `modals.tsx has no arm for ${id}`);
      assert.equal(SRC.modals.indexOf(`case "${id}":`, arm + 1), -1, id);
      assert.match(
        SRC.modals.slice(arm),
        new RegExp(
          `^case "${id}":\\s*return <${component} \\{\\.\\.\\.modalProps\\} />;`,
        ),
      );
    }
    // The remove modal's pinned props.
    const at = SRC.types.indexOf('type: "e2ee_remove_device";');
    const entry = SRC.types.slice(at, SRC.types.indexOf("}", at));
    assert.match(entry, /\bdeviceId: string;/);
    assert.match(entry, /\bsessionName: string \| null;/);
    assert.match(entry, /\bonRemoved\?: \(\) => void;/);
  });

  it("U6 reauth is the house MFA flow and resolves undefined", () => {
    const body = fnBody(SRC.remove, "useE2EEReauth");
    assert.match(
      body,
      /return async \(\) => \{\s*try \{\s*const mfa = await client\(\)\.account\.mfa\(\);\s*const ticket = await mfaFlow\(mfa\);\s*return ticket\?\.token;\s*\} catch \(error\) \{\s*showError\(error\);\s*return undefined;\s*\}\s*\};/,
    );
    assert.match(SRC.shared, /const reauth = useE2EEReauth\(\);/);
    assert.match(SRC.removed, /await e2ee\.startOverAsNewDevice\(reauth\);/);
    assert.match(SRC.removed, /const reauth = useE2EEReauth\(\);/);
    assert.match(
      fnBody(SRC.remove, "remove"),
      /const token = await reauth\(\);[\s\S]*await e2ee\.removeDevice\(\s*props\.deviceId,\s*\{ deleteBackup: deleteBackup\(\) \},\s*tracked,\s*\);/,
    );
    // Off by default.
    assert.match(
      SRC.remove,
      /const \[deleteBackup, setDeleteBackup\] = createSignal\(false\);/,
    );
    assert.match(
      fnBody(SRC.finish, "finish"),
      /const token = await reauth\(\);\s*if \(!token\) return;\s*await e2ee\.finishSetup\(token\);/,
    );
    for (const file of ["finish", "shared", "removed", "remove"] as const) {
      assert.equal(count(SRC[file], /finishReenroll/g), 0, FILES[file]);
    }
  });

  it("U7 Not now dismisses the shared signal; other prompts never clear theirs", () => {
    assert.match(
      fnBody(SRC.shared, "notNow"),
      /e2ee\?\.dismissDeviceShared\(\);\s*props\.onClose\(\);/,
    );
    assert.match(
      SRC.shared,
      /onClick: \(\) => \{\s*notNow\(\);\s*return false;/,
    );
    assert.match(
      SRC.settings,
      /onClick=\{\(\) => e2ee\.dismissDeviceShared\(\)\}\s*>\s*<Trans>Not now<\/Trans>/,
    );
    for (const file of Object.keys(FILES) as FileKey[]) {
      assert.doesNotMatch(
        SRC[file],
        /\b(publishPending|deviceRemoved|deviceShared)\.(delete|set|clear)\(/,
        `${FILES[file]} writes a bridge signal`,
      );
    }
    // The settings entries open the auto-modals by their ids.
    assert.match(
      SRC.settings,
      /onClick=\{\(\) => openModal\(\{ type: "e2ee_device_removed" \}\)\}/,
    );
    assert.match(
      SRC.settings,
      /onClick=\{\(\) => openModal\(\{ type: "e2ee_finish_setup" \}\)\}/,
    );
  });

  it("U8 no blank-page traps in the new files", () => {
    for (const file of ["finish", "shared", "removed", "remove"] as const) {
      assert.ok(SRC[file].length > 0, `${FILES[file]} missing`);
      assert.doesNotMatch(SRC[file], /\bstyled\(\s*[A-Z]/, FILES[file]);
      assert.doesNotMatch(SRC[file], /features\/legacy/, FILES[file]);
    }
  });
});

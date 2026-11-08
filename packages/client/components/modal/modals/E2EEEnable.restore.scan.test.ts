// Source-scan spec for the restore copy (multi-device plan D1/D2): a restore
// adds this install as a NEW device and the other devices keep working, so
// no restore surface may say it replaces a device or warn the user off it.
// Run with Node's built-in runner:
//   node --conditions=browser --test components/modal/modals/E2EEEnable.restore.scan.test.ts
// The modal needs Solid and the native bridge, and the native dialog is
// Kotlin, so the wiring is pinned by reading the sources. Point
// `E2EE_ENABLE_TSX` / `E2EE_PLUGIN_KT` at other copies (the known-bad
// controls: the 144297ab files, and the replace-warning files of 96da186c)
// to scan those instead; they must fail.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";

const here = new URL(".", import.meta.url);
const read = (env: string | undefined, relative: string) =>
  readFileSync(env ?? new URL(relative, here), "utf8");

const tsx = read(process.env.E2EE_ENABLE_TSX, "./E2EEEnable.tsx");
const kt = read(
  process.env.E2EE_PLUGIN_KT,
  "../../../android/app/src/main/java/com/acutest/app/e2ee/E2eePlugin.kt",
);
const catalogs = new URL("../../i18n/catalogs/", here);

/** Strip block and line comments (no string here contains either marker). */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every `<Trans>` body as lingui extracts it: whitespace runs collapsed. */
const transMessages = (source: string) =>
  [...code(source).matchAll(/<Trans>([\s\S]*?)<\/Trans>/g)].map((m) =>
    m[1].replace(/\s+/g, " ").trim(),
  );

/** The source of the dialog action whose label is `label`, up to the next. */
function action(source: string, label: string): string {
  const body = code(source);
  const start = body.indexOf(`text: <Trans>${label}</Trans>`);
  assert.notEqual(start, -1, `no action labelled "${label}"`);
  const next = body.indexOf("text:", start + 1);
  return body.slice(start, next === -1 ? undefined : next);
}

/** Wording that belongs to the old clone semantics of restore. */
const REPLACE_WORDING =
  /replaces? (that|your other|the other) device|restore and replace|no longer runs Sloga|does not add a second/i;

/** The Android code-entry dialog's prompt text, string pieces joined. */
function androidPrompt(): string {
  const start = kt.indexOf("private fun showRestoreDialog(");
  assert.notEqual(start, -1, "showRestoreDialog");
  const dialog = kt.slice(start, kt.indexOf("val input =", start));
  return [...dialog.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1])
    .join("");
}

describe("E2EEEnable restore copy", () => {
  test("the restore button restores directly: no replace-warning step", () => {
    assert.match(action(tsx, "Restore from a recovery code"), /void restore\(\)/);
    assert.doesNotMatch(code(tsx), /confirmRestore/);
  });

  test("no modal copy says a restore replaces a device", () => {
    for (const m of transMessages(tsx)) {
      assert.doesNotMatch(m, REPLACE_WORDING, m);
    }
  });

  test("the restore lead says this is a new device and the others keep working", () => {
    const lead = transMessages(tsx).find((m) =>
      m.startsWith("You have encryption set up on your account."),
    );
    assert.ok(lead, "restore lead paragraph");
    assert.match(lead, /It is added as a new device/);
    assert.match(lead, /Your other devices keep working\./);
  });

  test("the Android code-entry dialog says the same", () => {
    const text = androidPrompt();
    assert.match(text, /added as a new device/);
    assert.match(text, /other devices keep working/);
    assert.doesNotMatch(text, REPLACE_WORDING);
  });

  test("every message in the modal has an entry in every catalog", () => {
    // A msgid missing from the compiled catalog renders as its hash id
    const escape = (m: string) => m.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const locales = readdirSync(catalogs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.ok(locales.length >= 60, `only ${locales.length} catalogs found`);
    for (const locale of locales) {
      const po = readFileSync(
        new URL(`${locale}/messages.po`, catalogs),
        "utf8",
      );
      for (const m of transMessages(tsx)) {
        assert.ok(
          po.includes(`\nmsgid "${escape(m)}"\n`),
          `${locale} is missing "${m}"`,
        );
      }
    }
  });
});

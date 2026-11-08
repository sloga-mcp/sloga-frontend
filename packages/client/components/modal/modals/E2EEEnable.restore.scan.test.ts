// Source-scan spec for the restore warning step (e2ee-key-backup-design.md
// §6.4: restore copies the device identity, so the restore screen must say
// "Only restore if that computer no longer runs Sloga"). Run with Node's
// built-in runner:
//   node --conditions=browser --test components/modal/modals/E2EEEnable.restore.scan.test.ts
// The modal needs Solid and the native bridge, and the native dialog is
// Kotlin, so the wiring is pinned by reading the sources. Point
// `E2EE_ENABLE_TSX` / `E2EE_PLUGIN_KT` at other copies (the known-bad
// control: the 144297ab files) to scan those instead; they must fail.
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

describe("E2EEEnable restore warning", () => {
  test("the restore button opens the warning step and restores nothing", () => {
    const button = action(tsx, "Restore from a recovery code");
    assert.match(button, /setConfirmRestore\(true\)/);
    assert.doesNotMatch(button, /restore\(\)/);
  });

  test("restore() runs from exactly one place: the warning step's action", () => {
    // Every call, not the declaration
    const calls = code(tsx).match(/(?<!function )\brestore\(\)/g) ?? [];
    assert.equal(calls.length, 1, "restore() call sites");
    assert.match(action(tsx, "Restore and replace"), /void restore\(\)/);
  });

  test("the warning step says restore replaces the other device", () => {
    const messages = transMessages(tsx);
    assert.ok(
      messages.some((m) =>
        m.startsWith("Only restore if that device no longer runs Sloga"),
      ),
      "warning paragraph",
    );
    assert.ok(
      messages.some((m) => m.includes("choose Start fresh instead")),
      "Start fresh pointer",
    );
    assert.match(action(tsx, "Start fresh"), /void enable\(\)/);
  });

  test("no copy invites restoring onto a second device", () => {
    for (const m of transMessages(tsx)) {
      assert.doesNotMatch(m, /recovery code from another device/i, m);
    }
  });

  test("the Android code-entry dialog repeats the warning", () => {
    const start = kt.indexOf("private fun showRestoreDialog(");
    assert.notEqual(start, -1, "showRestoreDialog");
    const dialog = kt.slice(start, kt.indexOf("val input =", start));
    const text = [...dialog.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1])
      .join("");
    assert.match(text, /no longer runs Sloga/);
    assert.match(text, /Start fresh/);
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

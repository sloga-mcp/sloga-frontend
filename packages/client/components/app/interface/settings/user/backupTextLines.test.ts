// Spec for `backupTextLines.ts` (S4 W4-3 lane U7, design 8.5, R-W4-12): which
// protected channel history lines the Encryption settings show about the key
// backup. Every call passes what `Encryption.tsx` passes: the bundle's
// `text_truncated` as the bridge holds it, the text summary of the last
// restore, and the history flag.
//
// The last section reads `Encryption.tsx` and `E2EEEnable.tsx` as text (Node
// cannot load them: Solid, Capacitor, the bridge) to pin how they call the
// helper.
//
// Run: node --conditions=browser --test \
//   components/app/interface/settings/user/backupTextLines.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  bundleTextTruncated,
  restoreTextSummary,
} from "../../../../client/e2eeProtectedHistorySeam.ts";
import {
  backupTextLines,
  lastRestoreText,
  onRestoreText,
  recordRestoreText,
} from "./backupTextLines.ts";

/** A restore summary as `restoreTextSummary` builds it. */
function summary(skipped: unknown, truncated: unknown = null, epochs = 3) {
  return { epochs, truncated, skipped };
}

/** What an older shell, iOS and the desktop recovery window read as. */
const UNREPORTED = restoreTextSummary(null);

const BUNDLE_LINE: [unknown, string[]][] = [
  ["none", []],
  ["oldest", ["oldest"]],
  ["all", ["all"]],
  [null, []],
  [undefined, []],
];

const RESTORE_LINE: [unknown, string[]][] = [
  [summary("none"), []],
  [summary("partial", "oldest"), ["skipped_partial"]],
  [summary("all"), ["skipped_all"]],
  [UNREPORTED, []],
  [null, []],
  [undefined, []],
];

test("backupTextLines: every truncated and skipped combination gives exactly the matching lines", () => {
  let cases = 0;
  for (const [truncated, bundle] of BUNDLE_LINE) {
    for (const [restore, restored] of RESTORE_LINE) {
      assert.deepEqual(
        backupTextLines(truncated, restore, true),
        [...bundle, ...restored],
        `truncated ${String(truncated)}, restore ${JSON.stringify(restore)}`,
      );
      cases++;
    }
  }
  assert.equal(cases, 30);
});

test("backupTextLines: nothing reported shows no line", () => {
  assert.deepEqual(UNREPORTED, {
    epochs: null,
    truncated: null,
    skipped: "none",
  });
  assert.deepEqual(backupTextLines(undefined, undefined, true), []);
  assert.deepEqual(backupTextLines(null, null, true), []);
  assert.deepEqual(backupTextLines(undefined, UNREPORTED, true), []);
  assert.deepEqual(backupTextLines(null, UNREPORTED, true), []);
  // A summary with no `skipped` at all
  assert.deepEqual(backupTextLines(undefined, {}, true), []);
  assert.deepEqual(backupTextLines(undefined, { skipped: null }, true), []);
  // A restore that went well is no line either: nothing here claims that
  // history is complete
  assert.deepEqual(backupTextLines("none", summary("none", "none"), true), []);
});

test("backupTextLines: oldest and all are different bundle lines", () => {
  assert.deepEqual(backupTextLines("oldest", undefined, true), ["oldest"]);
  assert.deepEqual(backupTextLines("all", undefined, true), ["all"]);
});

test("backupTextLines: partly and wholly skipped are different restore lines", () => {
  assert.deepEqual(backupTextLines(undefined, summary("partial"), true), [
    "skipped_partial",
  ]);
  assert.deepEqual(backupTextLines(undefined, summary("all"), true), [
    "skipped_all",
  ]);
  assert.deepEqual(backupTextLines(undefined, summary("none"), true), []);
});

test("backupTextLines: an unknown value shows the careful line, never nothing", () => {
  for (const value of ["newest", "OLDEST", "", 0, 1, true, false, {}, []]) {
    assert.deepEqual(
      backupTextLines(value, undefined, true),
      ["all"],
      `truncated ${JSON.stringify(value)}`,
    );
    assert.deepEqual(
      backupTextLines(undefined, summary(value), true),
      ["skipped_partial"],
      `skipped ${JSON.stringify(value)}`,
    );
  }
  // Something that is not a summary at all is not a report
  for (const value of ["all", "partial", 1, true]) {
    assert.deepEqual(backupTextLines(undefined, value, true), []);
  }
});

test("backupTextLines: with the history flag off the bundle line is not shown", () => {
  for (const flag of [false, undefined, null, "true", 1, {}]) {
    for (const truncated of ["oldest", "all", "newest"]) {
      assert.deepEqual(
        backupTextLines(truncated, undefined, flag),
        [],
        `flag ${JSON.stringify(flag)}, truncated ${truncated}`,
      );
    }
    // What a restore could not bring back is still said
    assert.deepEqual(backupTextLines("all", summary("partial"), flag), [
      "skipped_partial",
    ]);
    assert.deepEqual(backupTextLines("oldest", summary("all"), flag), [
      "skipped_all",
    ]);
  }
});

test("backupTextLines: a real native report and bundle, through the bridge's readers", () => {
  const lines = (bundle: unknown, report: unknown) =>
    backupTextLines(
      bundleTextTruncated(bundle),
      restoreTextSummary(report),
      true,
    );
  const bundle = { header: "h", ciphertext: "c", generation: 2 };
  const report = { device_id: "A", new_device_id: "B" };

  // An older shell: none of the three keys
  assert.deepEqual(lines(bundle, report), []);
  assert.deepEqual(lines(bundle, null), []);
  assert.deepEqual(
    lines(
      { ...bundle, text_truncated: "none" },
      { ...report, text_epochs: 4, text_truncated: "none" },
    ),
    [],
  );
  assert.deepEqual(lines({ ...bundle, text_truncated: "oldest" }, report), [
    "oldest",
  ]);
  assert.deepEqual(lines({ ...bundle, text_truncated: "all" }, report), [
    "all",
  ]);
  // R-W4-12: skipped with `text_truncated` is partial, without it all
  assert.deepEqual(
    lines(bundle, {
      ...report,
      text_epochs: 2,
      text_truncated: "oldest",
      text_skipped: true,
    }),
    ["skipped_partial"],
  );
  assert.deepEqual(lines(bundle, { ...report, text_skipped: true }), [
    "skipped_all",
  ]);
  // `text_skipped` must be exactly true
  assert.deepEqual(lines(bundle, { ...report, text_skipped: "true" }), []);
  assert.deepEqual(lines(bundle, { ...report, text_skipped: false }), []);
});

test("backupTextLines: epochs and the restored bundle's truncation add no line", () => {
  for (const epochs of [0, 1, 500]) {
    for (const truncated of ["none", "oldest", "all", null]) {
      assert.deepEqual(
        backupTextLines(undefined, summary("none", truncated, epochs), true),
        [],
      );
      assert.deepEqual(
        backupTextLines(undefined, summary("partial", truncated, epochs), true),
        ["skipped_partial"],
      );
    }
  }
});

test("restore text: kept per bridge, replaced by the next restore, listeners told", () => {
  const bridge = {};
  const other = {};
  assert.equal(lastRestoreText(bridge), undefined);

  let told = 0;
  const stop = onRestoreText(() => told++);
  const partial = summary("partial", "oldest");
  recordRestoreText(bridge, partial);
  assert.equal(told, 1);
  assert.equal(lastRestoreText(bridge), partial);
  assert.equal(lastRestoreText(other), undefined);
  assert.deepEqual(backupTextLines(undefined, lastRestoreText(bridge), true), [
    "skipped_partial",
  ]);
  assert.deepEqual(
    backupTextLines(undefined, lastRestoreText(other), true),
    [],
  );

  // The next result replaces the line, also when it reports nothing
  recordRestoreText(bridge, UNREPORTED);
  assert.equal(told, 2);
  assert.deepEqual(
    backupTextLines(undefined, lastRestoreText(bridge), true),
    [],
  );

  // A listener that throws does not fail the restore or the others
  const stopBad = onRestoreText(() => {
    throw new Error("redraw failed");
  });
  const error = console.error;
  console.error = () => {};
  try {
    recordRestoreText(bridge, summary("all"));
  } finally {
    console.error = error;
  }
  assert.equal(told, 3);
  stopBad();

  stop();
  recordRestoreText(bridge, summary("none"));
  assert.equal(told, 3);
});

// ---------------------------------------------------------------------------
// How the two files that cannot load call the helper
// ---------------------------------------------------------------------------

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

/** Comments out, whitespace collapsed, no space or comma before a closer. */
const code = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .replace(/,? ?([)\]}])/g, "$1")
    .replace(/([([{]) /g, "$1");

const SETTINGS = code(read("./Encryption.tsx"));
const ENABLE = code(read("../../../../modal/modals/E2EEEnable.tsx"));

const count = (source: string, needle: string) =>
  source.split(needle).length - 1;

test("wiring: the enable dialog restores through restoreFromBackupReport and records the text summary", () => {
  assert.equal(count(ENABLE, "restoreFromBackup("), 0);
  assert.equal(count(ENABLE, "restoreFromBackupReport("), 1);
  const call =
    "const {blobs: count, text} = await e2ee.restoreFromBackupReport(token);";
  const empty = "if (count === 0) {setNoBackup(true); setBusy(false); return;}";
  const record = "recordRestoreText(e2ee, text);";
  const close = 'e2ee.restoreAvailable.delete("state"); props.onClose();';
  assert.equal(count(ENABLE, "recordRestoreText("), 1);
  const at = [call, empty, record, close].map((part) => ENABLE.indexOf(part));
  assert.ok(
    at.every((index) => index !== -1),
    `missing: ${at.join(" ")}`,
  );
  // Nothing restored never records; a restore that ran records before the
  // dialog closes
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
  );
  assert.equal(at[1], at[0] + call.length + 1);
  assert.equal(at[2], at[1] + empty.length + 1);
  assert.equal(at[3], at[2] + record.length + 1);
});

test("wiring: the settings page feeds the bridge's values and the flag to backupTextLines", () => {
  assert.equal(count(SETTINGS, "backupTextLines("), 2);
  assert.ok(
    SETTINGS.includes(
      "const historyFlag = () => e2ee.protectedFlag().historySetting === true;",
    ),
    "the flag is read strictly",
  );
  assert.equal(count(SETTINGS, "historySetting"), 1);
  assert.ok(
    SETTINGS.includes(
      'const bundleLines = () => backupTextLines(e2ee.backupText.get("state")?.truncated, undefined, historyFlag());',
    ),
    "the bundle lines",
  );
  assert.ok(
    SETTINGS.includes(
      "const restoreLines = () => backupTextLines(undefined, restoreText().text, historyFlag());",
    ),
    "the restore lines",
  );
  assert.ok(
    SETTINGS.includes(
      "const [restoreText, setRestoreText] = createSignal({text: lastRestoreText(e2ee)}); onCleanup(onRestoreText(() => setRestoreText({text: lastRestoreText(e2ee)})));",
    ),
    "the page follows the recorded restore result",
  );
});

test("wiring: every line goes through the copy functions; the replaces-old-device line is not used", () => {
  const line = '{(kind) => <Text class="label">{backupTextCopy(kind)}</Text>}';
  assert.equal(count(SETTINGS, "backupTextCopy("), 2);
  assert.ok(
    SETTINGS.includes(
      `<Show when={hasBackup()}> <For each={bundleLines()}> ${line} </For> </Show>`,
    ),
    "the bundle line shows only while a backup exists",
  );
  assert.ok(
    SETTINGS.includes(`<For each={restoreLines()}> ${line} </For>`),
    "the restore lines",
  );
  assert.equal(count(SETTINGS, "backupNoteCopy."), 1);
  assert.ok(
    SETTINGS.includes(
      '<Show when={historyFlag()}> <Text class="label">{backupNoteCopy.textBudget()}</Text> </Show>',
    ),
    "the size note needs the flag",
  );
  // A restore adds a new device and the others keep working (multi-device
  // D1), so the design's "replaces your old device" line has no place
  for (const source of [SETTINGS, ENABLE]) {
    assert.equal(count(source, "replacesOldDevice"), 0);
  }
  assert.equal(count(ENABLE, "backupTextCopy"), 0);
  assert.equal(count(ENABLE, "backupNoteCopy"), 0);
});

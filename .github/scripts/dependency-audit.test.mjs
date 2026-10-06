// Tests for dependency-audit.mjs. Each case runs the real script against a
// saved report and baseline, so the gate's verdict is its exit status.
//
// Run from the repository root: `node --test .github/scripts/dependency-audit.test.mjs`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("./dependency-audit.mjs", import.meta.url),
);
const dir = mkdtempSync(join(tmpdir(), "dependency-audit-test-"));
let n = 0;

function run(report, advisories) {
  n += 1;
  const reportFile = join(dir, `report-${n}.json`);
  const baselineFile = join(dir, `baseline-${n}.json`);
  writeFileSync(reportFile, JSON.stringify(report));
  writeFileSync(baselineFile, JSON.stringify({ advisories }));
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      AUDIT_REPORT_FILE: reportFile,
      AUDIT_BASELINE_FILE: baselineFile,
    },
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

function advisory(id, moduleName, paths, severity = "high") {
  return {
    github_advisory_id: id,
    module_name: moduleName,
    severity,
    title: "test advisory",
    findings: [{ version: "1.0.0", paths }],
  };
}

function report(...advisories) {
  return {
    metadata: {
      vulnerabilities: {
        critical: 0,
        high: advisories.length,
        moderate: 0,
        low: 0,
      },
    },
    advisories: Object.fromEntries(advisories.map((a, i) => [String(i), a])),
  };
}

const SHARP = {
  "GHSA-test-0001": {
    package: "sharp",
    via: ["@huggingface/transformers>sharp"],
    reason: "test reason",
  },
};

test("a baselined advisory on its listed chain passes", () => {
  const r = run(
    report(
      advisory("GHSA-test-0001", "sharp", [
        "packages__client>@huggingface/transformers>sharp",
      ]),
    ),
    SHARP,
  );
  assert.equal(r.status, 0, r.out);
});

test("the same advisory through another parent fails", () => {
  const r = run(
    report(
      advisory("GHSA-test-0001", "sharp", [
        "packages__client>@huggingface/transformers>sharp",
        "packages__client>some-runtime-lib>sharp",
      ]),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /new path/);
  assert.match(r.out, /some-runtime-lib>sharp/);
});

test("chains match whole package names, not a suffix of one", () => {
  const r = run(
    report(
      advisory("GHSA-test-0001", "sharp", [
        "packages__client>not-@huggingface/transformers>sharp",
      ]),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
});

test("the same advisory id in another package fails", () => {
  const r = run(
    report(
      advisory("GHSA-test-0001", "other-pkg", ["packages__client>other-pkg"]),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /now reported in "other-pkg"/);
});

test("a baselined advisory with no paths fails rather than passing unchecked", () => {
  const r = run(report(advisory("GHSA-test-0001", "sharp", [])), SHARP);
  assert.equal(r.status, 1, r.out);
});

test("an unlisted high advisory fails", () => {
  const r = run(
    report(
      advisory("GHSA-test-0002", "left-pad", ["packages__client>left-pad"]),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /New dependency advisory/);
});

test("an unlisted moderate advisory passes", () => {
  const r = run(
    report(
      advisory(
        "GHSA-test-0002",
        "left-pad",
        ["packages__client>left-pad"],
        "moderate",
      ),
    ),
    SHARP,
  );
  assert.equal(r.status, 0, r.out);
});

test("an old-format string entry is rejected", () => {
  const r = run(report(), { "GHSA-test-0001": "sharp: some reason" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /must be \{"package"/);
});

test("a chain that does not end in its package is rejected", () => {
  const r = run(report(), {
    "GHSA-test-0001": {
      package: "sharp",
      via: ["@huggingface/transformers"],
      reason: "x",
    },
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /must end with its package/);
});

test("a registry error report fails", () => {
  const r = run({ error: { code: "ENOTFOUND" } }, SHARP);
  assert.equal(r.status, 1, r.out);
});

test("a path list at pnpm's cap passes with a warning when every listed path is covered", () => {
  const paths = Array.from(
    { length: 100 },
    (_, i) => `packages__client>pkg-${i}>@huggingface/transformers>sharp`,
  );
  const r = run(report(advisory("GHSA-test-0001", "sharp", paths)), SHARP);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::warning/);
});

test("the committed baseline is well formed", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      AUDIT_REPORT_FILE: (() => {
        const f = join(dir, "empty-report.json");
        writeFileSync(f, JSON.stringify(report()));
        return f;
      })(),
      AUDIT_BASELINE_FILE: "",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// Tests for dependency-audit.mjs. Each case runs the real script against a
// saved report and baseline, so the gate's verdict is its exit status, and
// every failing case also checks the error it printed: a crash exits 1 too.
//
// Run from the repository root: `node --test .github/scripts/dependency-audit.test.mjs`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("./dependency-audit.mjs", import.meta.url),
);
const dir = mkdtempSync(join(tmpdir(), "dependency-audit-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const MOVED = /::error title=Baselined advisory on a new path::/;
const NEW = /::error title=New dependency advisory::/;

function run(report, advisories, lockfile) {
  n += 1;
  const reportFile = join(dir, `report-${n}.json`);
  const baselineFile = join(dir, `baseline-${n}.json`);
  writeFileSync(reportFile, JSON.stringify(report));
  writeFileSync(baselineFile, JSON.stringify({ advisories }));
  const env = {
    ...process.env,
    AUDIT_REPORT_FILE: reportFile,
    AUDIT_BASELINE_FILE: baselineFile,
  };
  if (lockfile !== undefined) {
    env.AUDIT_LOCKFILE = join(dir, `lock-${n}.yaml`);
    if (lockfile !== null) writeFileSync(env.AUDIT_LOCKFILE, lockfile);
  }
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env,
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

function advisory(id, moduleName, paths, severity = "high", extra = []) {
  return {
    github_advisory_id: id,
    module_name: moduleName,
    severity,
    title: "test advisory",
    findings: [{ version: "1.0.0", paths }, ...extra],
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

const SEROVAL = {
  "GHSA-test-0003": {
    package: "seroval",
    via: ["solid-js>seroval", "solid-js>seroval-plugins>seroval"],
    reason: "test reason",
  },
};

// 100 reported paths (pnpm's cap), all covered, so the verdict comes from
// the lockfile walk.
const CAPPED = Array.from(
  { length: 100 },
  (_, i) => `packages__client>pkg-${i}>solid-js>seroval`,
);

const LOCK_OK = `lockfileVersion: '9.0'

importers:

  packages/client:
    dependencies:
      solid-js:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      seroval:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  seroval@1.0.0:
    resolution: {integrity: sha512-x}

snapshots:

  seroval-plugins@1.0.0(seroval@1.0.0):
    dependencies:
      seroval: 1.0.0

  seroval@1.0.0: {}

  solid-js@1.0.0:
    dependencies:
      seroval: 1.0.0
      seroval-plugins: 1.0.0(seroval@1.0.0)
    transitivePeerDependencies:
      - seroval
`;

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
  assert.match(r.out, MOVED);
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
  assert.match(r.out, MOVED);
});

test("the same advisory id in another package fails", () => {
  const r = run(
    report(
      advisory("GHSA-test-0001", "other-pkg", ["packages__client>other-pkg"]),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, MOVED);
  assert.match(r.out, /now reported in "other-pkg"/);
});

test("a baselined advisory with no paths fails rather than passing unchecked", () => {
  const r = run(report(advisory("GHSA-test-0001", "sharp", [])), SHARP);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, MOVED);
  assert.match(r.out, /no dependency paths/);
});

test("one finding without paths fails even when another finding has them", () => {
  const r = run(
    report(
      advisory(
        "GHSA-test-0001",
        "sharp",
        ["packages__client>@huggingface/transformers>sharp"],
        "high",
        [{ version: "2.0.0" }],
      ),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no dependency paths/);
});

test("every finding (version) is checked, not just the first", () => {
  const r = run(
    report(
      advisory(
        "GHSA-test-0001",
        "sharp",
        ["packages__client>@huggingface/transformers>sharp"],
        "high",
        [{ version: "2.0.0", paths: ["packages__client>runtime-lib>sharp"] }],
      ),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /runtime-lib>sharp/);
});

test("an unlisted high advisory fails", () => {
  const r = run(
    report(
      advisory("GHSA-test-0002", "left-pad", ["packages__client>left-pad"]),
    ),
    SHARP,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, NEW);
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

test("a chain of just the package name is rejected", () => {
  const r = run(report(), {
    "GHSA-test-0001": { package: "sharp", via: ["sharp"], reason: "x" },
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /must name at least the parent/);
});

test("a registry error report fails", () => {
  const r = run({ error: { code: "ENOTFOUND" } }, SHARP);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /unexpected pnpm audit report/);
});

test("at pnpm's path cap, parents read from the lockfile pass when covered", () => {
  const r = run(
    report(advisory("GHSA-test-0003", "seroval", CAPPED)),
    SEROVAL,
    LOCK_OK,
  );
  assert.equal(r.status, 0, r.out);
});

test("at pnpm's path cap, a lockfile parent the reported paths missed fails", () => {
  const lock = LOCK_OK.replace(
    "  seroval@1.0.0: {}\n",
    "  seroval@1.0.0: {}\n\n  zz-runtime-lib@1.0.0:\n    dependencies:\n      seroval: 1.0.0\n",
  );
  const r = run(
    report(advisory("GHSA-test-0003", "seroval", CAPPED)),
    SEROVAL,
    lock,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, MOVED);
  assert.match(r.out, /zz-runtime-lib>seroval/);
});

test("at pnpm's path cap, an importer depending on the package directly fails", () => {
  const lock = LOCK_OK.replace(
    "    devDependencies:\n      seroval:",
    "      seroval:\n        specifier: ^1.0.0\n        version: 1.0.0\n    devDependencies:\n      seroval:",
  );
  const r = run(
    report(advisory("GHSA-test-0003", "seroval", CAPPED)),
    SEROVAL,
    lock,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /packages__client>seroval/);
});

function cappedSeroval(lock) {
  return run(
    report(advisory("GHSA-test-0003", "seroval", CAPPED)),
    SEROVAL,
    lock,
  );
}

const withSnapshot = (entry) =>
  LOCK_OK.replace("  seroval@1.0.0: {}\n", `  seroval@1.0.0: {}\n\n${entry}`);

test("at pnpm's path cap, a parent that aliases the package fails", () => {
  const r = cappedSeroval(
    withSnapshot(
      "  zz-runtime-lib@1.0.0:\n    dependencies:\n      myser: seroval@1.0.0\n",
    ),
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /zz-runtime-lib>seroval/);
});

test("at pnpm's path cap, an importer that aliases the package fails", () => {
  const r = cappedSeroval(
    LOCK_OK.replace(
      "    devDependencies:\n",
      "      zz-ser:\n        specifier: npm:seroval@^1.0.0\n        version: seroval@1.0.0\n    devDependencies:\n",
    ),
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /packages__client>seroval/);
});

test("at pnpm's path cap, a quoted scoped parent with a peer suffix fails", () => {
  const r = cappedSeroval(
    withSnapshot(
      "  '@zz/runtime@1.0.0(solid-js@1.0.0)':\n    dependencies:\n      seroval: 1.0.0(solid-js@1.0.0)\n",
    ),
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /@zz\/runtime>seroval/);
});

test("at pnpm's path cap, an unreadable lockfile fails", () => {
  const r = run(
    report(advisory("GHSA-test-0003", "seroval", CAPPED)),
    SEROVAL,
    null,
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not be read/);
});

test("the committed baseline is well formed", () => {
  const reportFile = join(dir, "empty-report.json");
  writeFileSync(reportFile, JSON.stringify(report()));
  // No AUDIT_BASELINE_FILE: the script reads the committed baseline.
  const env = { ...process.env, AUDIT_REPORT_FILE: reportFile };
  delete env.AUDIT_BASELINE_FILE;
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\d+ baselined/);
});

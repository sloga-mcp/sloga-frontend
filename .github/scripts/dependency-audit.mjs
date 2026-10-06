// Dependency audit gate for the shipped (non-dev) dependency tree.
//
// Runs `pnpm audit --prod` and FAILS on any high or critical advisory that is
// not listed in ../dependency-audit-baseline.json. The baseline is what was
// already in the lockfile when this gate was added, each entry with a reason,
// so the gate starts green and still catches every NEW advisory: one brought
// in by a new or bumped dependency, or one newly published against a
// dependency we already ship (the workflow also runs daily for that case).
//
// A baseline entry is pinned to the package and the dependency chains its
// reason was written for, not just the advisory id. If the same advisory
// starts reaching the tree through a different parent (a runtime package
// picking up something we only accepted as a build tool), the gate fails
// even though the id is listed.
//
// Run from the repository root: `node .github/scripts/dependency-audit.mjs`.
// AUDIT_REPORT_FILE=<path> reads a saved `pnpm audit --prod --json` report
// instead of running pnpm, and AUDIT_BASELINE_FILE=<path> reads another
// baseline; both exist so the gate itself can be tested.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BLOCKING = new Set(["high", "critical"]);

// pnpm keeps at most this many paths per finding and silently drops the rest
// (MAX_PATHS_PER_FINDING in pnpm's audit code), so a list this long may be
// incomplete. Only the paths pnpm reports can be checked.
const PNPM_PATH_CAP = 100;

function fail(message) {
  console.log(`::error title=Dependency audit::${message}`);
  process.exit(1);
}

const baselineFile = process.env.AUDIT_BASELINE_FILE
  ? process.env.AUDIT_BASELINE_FILE
  : new URL("../dependency-audit-baseline.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselineFile, "utf8")).advisories;
if (!baseline || typeof baseline !== "object") {
  fail("dependency-audit-baseline.json has no `advisories` object");
}

// Every entry must say which package it covers, through which dependency
// chains, and why. A bare string (the old format) is rejected rather than
// treated as "any path", which is exactly the gap this format closes.
for (const [id, entry] of Object.entries(baseline)) {
  const shapeOk =
    entry &&
    typeof entry === "object" &&
    typeof entry.package === "string" &&
    entry.package.length > 0 &&
    typeof entry.reason === "string" &&
    entry.reason.length > 0 &&
    Array.isArray(entry.via) &&
    entry.via.length > 0 &&
    entry.via.every((chain) => typeof chain === "string" && chain.length > 0);
  if (!shapeOk) {
    fail(
      `baseline entry ${id} must be {"package", "via": [chains], "reason"}; got ${JSON.stringify(entry).slice(0, 200)}`,
    );
  }
  for (const chain of entry.via) {
    if (chain.split(">").at(-1) !== entry.package) {
      fail(
        `baseline entry ${id}: via chain "${chain}" must end with its package "${entry.package}"`,
      );
    }
  }
}

let raw;
if (process.env.AUDIT_REPORT_FILE) {
  raw = readFileSync(process.env.AUDIT_REPORT_FILE, "utf8");
} else {
  const run = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) fail(`could not run pnpm audit: ${run.error.message}`);
  // pnpm exits non-zero whenever it finds anything at all, so its exit code
  // carries no verdict here. The JSON report is the result.
  raw = run.stdout;
  if (run.stderr) process.stderr.write(run.stderr);
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  fail(`pnpm audit did not return JSON: ${String(raw).slice(0, 300)}`);
}
// A registry error comes back as JSON too. Without this check it would read
// as "no advisories" and pass having checked nothing.
if (report.error || !report.metadata || typeof report.advisories !== "object") {
  fail(`unexpected pnpm audit report: ${JSON.stringify(report).slice(0, 300)}`);
}

// A path such as `packages__client>@huggingface/transformers>sharp` is covered
// when it ends with one of the entry's chains, matched on whole package names.
function covered(path, chains) {
  return chains.some((chain) => path === chain || path.endsWith(`>${chain}`));
}

const seen = new Set();
const fresh = [];
const moved = [];
for (const advisory of Object.values(report.advisories)) {
  const id = advisory.github_advisory_id ?? `npm-${advisory.id}`;
  seen.add(id);
  if (!BLOCKING.has(advisory.severity)) continue;
  const findings = advisory.findings ?? [];
  const versions = [...new Set(findings.map((f) => f.version))];
  const label =
    `${id} (${advisory.severity}) in ${advisory.module_name} ${versions.join(", ")}: ` +
    `${advisory.title} ${advisory.url ?? ""}`.trim();

  const entry = baseline[id];
  if (!entry) {
    fresh.push(label);
    continue;
  }
  if (advisory.module_name !== entry.package) {
    moved.push(
      `${label}: baselined for package "${entry.package}", now reported in "${advisory.module_name}"`,
    );
    continue;
  }
  const paths = [...new Set(findings.flatMap((f) => f.paths ?? []))];
  if (paths.length === 0) {
    moved.push(`${label}: the report lists no dependency paths to check`);
    continue;
  }
  const uncovered = paths.filter((p) => !covered(p, entry.via));
  if (uncovered.length > 0) {
    moved.push(
      `${label}: reached through ${uncovered.length} path(s) the baseline reason does not cover, e.g. ` +
        uncovered.slice(0, 3).join(" ; "),
    );
    continue;
  }
  if (findings.some((f) => (f.paths ?? []).length >= PNPM_PATH_CAP)) {
    console.log(
      `::warning title=Dependency audit::${id}: pnpm reported ${PNPM_PATH_CAP} paths, its cap; paths past the cap were not checked.`,
    );
  }
}

for (const id of Object.keys(baseline)) {
  if (!seen.has(id)) {
    console.log(
      `::notice title=Dependency audit::${id} is in the baseline but no longer reported; delete its entry.`,
    );
  }
}

const counts = report.metadata.vulnerabilities;
console.log(
  `pnpm audit --prod: ${counts.critical} critical, ${counts.high} high, ` +
    `${counts.moderate} moderate, ${counts.low} low; ` +
    `${Object.keys(baseline).length} baselined, ${fresh.length} new high/critical, ` +
    `${moved.length} baselined but on a new path.`,
);

for (const line of fresh) {
  console.log(`::error title=New dependency advisory::${line}`);
}
for (const line of moved) {
  console.log(`::error title=Baselined advisory on a new path::${line}`);
}
if (fresh.length > 0 || moved.length > 0) {
  console.log(
    "Fix: bump the dependency to a patched version. If it truly cannot reach " +
      "users, add or extend its entry in .github/dependency-audit-baseline.json " +
      "with the package, the dependency chain, and the reason.",
  );
  process.exit(1);
}

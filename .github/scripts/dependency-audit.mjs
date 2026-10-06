// Dependency audit gate for the shipped (non-dev) dependency tree.
//
// Runs `pnpm audit --prod` and FAILS on any high or critical advisory that is
// not listed in ../dependency-audit-baseline.json. The baseline is what was
// already in the lockfile when this gate was added, each entry with a reason,
// so the gate starts green and still catches every NEW advisory: one brought
// in by a new or bumped dependency, or one newly published against a
// dependency we already ship (the workflow also runs daily for that case).
//
// Run from the repository root: `node .github/scripts/dependency-audit.mjs`.
// AUDIT_REPORT_FILE=<path> reads a saved `pnpm audit --prod --json` report
// instead of running pnpm, which is how the gate itself is tested.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BLOCKING = new Set(["high", "critical"]);

function fail(message) {
  console.log(`::error title=Dependency audit::${message}`);
  process.exit(1);
}

const baselineFile = new URL(
  "../dependency-audit-baseline.json",
  import.meta.url,
);
const baseline = JSON.parse(readFileSync(baselineFile, "utf8")).advisories;
if (!baseline || typeof baseline !== "object") {
  fail("dependency-audit-baseline.json has no `advisories` object");
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

const seen = new Set();
const fresh = [];
for (const advisory of Object.values(report.advisories)) {
  const id = advisory.github_advisory_id ?? `npm-${advisory.id}`;
  seen.add(id);
  if (!BLOCKING.has(advisory.severity) || id in baseline) continue;
  const versions = [
    ...new Set((advisory.findings ?? []).map((f) => f.version)),
  ];
  fresh.push(
    `${id} (${advisory.severity}) in ${advisory.module_name} ${versions.join(", ")}: ` +
      `${advisory.title} ${advisory.url ?? ""}`.trim(),
  );
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
    `${Object.keys(baseline).length} baselined, ${fresh.length} new high/critical.`,
);

if (fresh.length > 0) {
  for (const line of fresh) {
    console.log(`::error title=New dependency advisory::${line}`);
  }
  console.log(
    "Fix: bump the dependency to a patched version. If it truly cannot reach " +
      "users, add it to .github/dependency-audit-baseline.json with the reason.",
  );
  process.exit(1);
}

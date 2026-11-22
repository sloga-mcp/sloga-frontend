// Unit spec for the Take It Down queue helpers; run with Node's built-in
// runner:
//   node --conditions=browser --test components/modal/modals/takedownQueue.test.ts
// Focus: the 12 hour urgency line, open-only counts, queue order, the copy
// count a removal confirms (each file once, 0 without copies), the error
// answers the reviewer sees, which files get a preview, and the headers and
// paths the routes take.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type TakedownSummary,
  type TakedownTargetView,
  URGENT_WINDOW_MS,
  auditReasonHeader,
  classifyError,
  evidencePath,
  hiddenFileIds,
  isUrgent,
  plannedCopyCount,
  previewKind,
  queueCounts,
  removableTargets,
  sortQueue,
  splitDuration,
  tileGivesUp,
} from "./takedownQueue.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");

function summary(
  reference: string,
  status: string,
  deadlineInMs: number,
): TakedownSummary {
  return {
    id: reference.replace("TD-", ""),
    reference,
    status,
    received_at: new Date(NOW - 3_600_000).toISOString(),
    deadline_at: new Date(NOW + deadlineInMs).toISOString(),
    minor_claimed: false,
    in_app: false,
    targets: 1,
    opened: false,
    child_safety: false,
    throttled: false,
    bad_faith_history: false,
    auto_hidden: 0,
  };
}

function file(id: string, copies: number, hidden = false) {
  return {
    id,
    tag: "attachments",
    content_type: "image/png",
    size: 1,
    copies,
    hidden,
  };
}

function target(
  index: number,
  kind: string,
  files: ReturnType<typeof file>[],
): TakedownTargetView {
  return { index, kind, encrypted: false, files };
}

test("urgent means open with under 12 hours left, or overdue", () => {
  const hour = 3_600_000;
  assert.equal(isUrgent(summary("TD-A", "UnderReview", 13 * hour), NOW), false);
  assert.equal(
    isUrgent(summary("TD-A", "UnderReview", URGENT_WINDOW_MS), NOW),
    false,
  );
  assert.equal(
    isUrgent(summary("TD-A", "UnderReview", URGENT_WINDOW_MS - 1), NOW),
    true,
  );
  assert.equal(isUrgent(summary("TD-A", "Received", -hour), NOW), true);
  assert.equal(isUrgent(summary("TD-A", "NeedsInfo", hour), NOW), true);
  // Outcomes are never urgent, whatever their deadline
  for (const status of ["Removed", "PartiallyRemoved", "Declined", "Closed"]) {
    assert.equal(isUrgent(summary("TD-A", status, -hour), NOW), false, status);
  }
  // An unreadable deadline is not urgent (and not a crash)
  assert.equal(
    isUrgent({ ...summary("TD-A", "Received", 0), deadline_at: "x" }, NOW),
    false,
  );
});

test("the tile counts open requests only", () => {
  const hour = 3_600_000;
  assert.deepEqual(
    queueCounts(
      [
        summary("TD-A", "Received", 40 * hour),
        summary("TD-B", "Closed", -hour),
        summary("TD-C", "Declined", 40 * hour),
      ],
      NOW,
    ),
    { open: 1, urgent: false },
  );
  assert.deepEqual(
    queueCounts(
      [
        summary("TD-A", "Received", 40 * hour),
        summary("TD-B", "UnderReview", 2 * hour),
      ],
      NOW,
    ),
    { open: 2, urgent: true },
  );
  assert.deepEqual(queueCounts([], NOW), { open: 0, urgent: false });
});

test("durations split into whole hours and minutes", () => {
  assert.deepEqual(splitDuration(25 * 3_600_000 + 30 * 60_000 + 59_000), {
    overdue: false,
    hours: 25,
    minutes: 30,
  });
  assert.deepEqual(splitDuration(-(90 * 60_000)), {
    overdue: true,
    hours: 1,
    minutes: 30,
  });
});

test("queue order: open first, earliest deadline first", () => {
  const hour = 3_600_000;
  const sorted = sortQueue([
    summary("TD-CLOSED", "Closed", -50 * hour),
    summary("TD-LATER", "Received", 40 * hour),
    summary("TD-SOON", "UnderReview", 2 * hour),
    { ...summary("TD-BAD", "Received", 0), deadline_at: "x" },
    summary("TD-OVERDUE", "NeedsInfo", -hour),
  ]);
  assert.deepEqual(
    sorted.map((row) => row.reference),
    ["TD-OVERDUE", "TD-SOON", "TD-LATER", "TD-BAD", "TD-CLOSED"],
  );
});

test("copy count: selected targets, each file once, 0 without copies", () => {
  const targets = [
    target(0, "Message", [file("F1", 3), file("F2", 2)]),
    target(1, "File", [file("F1", 3)]),
    target(2, "User", [file("F3", 7)]),
    target(3, "Unresolvable", []),
  ];

  assert.equal(plannedCopyCount(targets, [0], true), 5);
  // F1 shown by both targets counts once
  assert.equal(plannedCopyCount(targets, [0, 1], true), 5);
  assert.equal(plannedCopyCount(targets, [1, 2], true), 10);
  assert.equal(plannedCopyCount(targets, [0, 1, 2, 3], true), 12);
  assert.equal(plannedCopyCount(targets, [0, 1, 2], false), 0);
  assert.equal(plannedCopyCount(targets, [], true), 0);

  assert.deepEqual(
    removableTargets(targets).map((t) => t.index),
    [0, 1, 2],
  );
});

test("hidden file ids are listed once", () => {
  assert.deepEqual(
    hiddenFileIds([
      target(0, "Message", [file("F1", 0, true), file("F2", 0)]),
      target(1, "File", [file("F1", 0, true)]),
      target(2, "User", [file("F3", 0, true)]),
    ]),
    ["F1", "F3"],
  );
});

test("error answers map to what the reviewer is told", () => {
  const failed = (error: string) => ({ type: "FailedValidation", error });
  assert.equal(classifyError(400, failed("TakedownBusy")), "busy");
  assert.equal(
    classifyError(400, failed("AuditLogReasonRequired")),
    "reasonRequired",
  );
  assert.equal(
    classifyError(400, failed("AuditLogReasonTooLong")),
    "reasonTooLong",
  );
  assert.equal(classifyError(400, failed("InvalidBody")), "invalidBody");
  assert.equal(classifyError(400, failed("Something")), "other");
  assert.equal(classifyError(401, { type: "NotPrivileged" }), "notPrivileged");
  assert.equal(classifyError(401, { type: "InvalidToken" }), "mfa");
  assert.equal(
    classifyError(400, { type: "InvalidOperation" }),
    "invalidOperation",
  );
  assert.equal(
    classifyError(400, { type: "FeatureDisabled", feature: "x" }),
    "featureDisabled",
  );
  assert.equal(classifyError(404, { type: "NotFound" }), "notFound");
  assert.equal(classifyError(429, "Too many requests"), "rateLimited");
  assert.equal(classifyError(500, "<html>"), "other");
  assert.equal(classifyError(500, null), "other");
});

test("the Home tile gives up on NotPrivileged and on a missing route only", () => {
  assert.equal(tileGivesUp(401, { type: "NotPrivileged" }), true);
  assert.equal(tileGivesUp(404, "<html>Not Found</html>"), true);
  assert.equal(tileGivesUp(404, undefined), true);
  // Transient failures keep the last good count
  assert.equal(tileGivesUp(500, { type: "InternalError" }), false);
  assert.equal(tileGivesUp(502, undefined), false);
  assert.equal(tileGivesUp(429, "Too many requests"), false);
  assert.equal(tileGivesUp(401, { type: "InvalidSession" }), false);
});

test("only images (not SVG) and videos get a preview", () => {
  assert.equal(previewKind("image/png"), "image");
  assert.equal(previewKind("IMAGE/JPEG; charset=binary"), "image");
  assert.equal(previewKind("video/mp4"), "video");
  assert.equal(previewKind("image/svg+xml"), undefined);
  assert.equal(previewKind("audio/ogg"), undefined);
  assert.equal(previewKind("application/pdf"), undefined);
  assert.equal(previewKind("text/html"), undefined);
});

test("evidence path and audit reason header", () => {
  assert.equal(
    evidencePath("01FILE", "01REQUEST"),
    "/takedown/evidence/01FILE?request=01REQUEST",
  );
  assert.equal(
    evidencePath("a/b?c", "x&y"),
    "/takedown/evidence/a%2Fb%3Fc?request=x%26y",
  );
  assert.equal(auditReasonHeader("   "), undefined);
  assert.equal(auditReasonHeader(" Confirmed NCII "), "Confirmed%20NCII");
  assert.equal(auditReasonHeader("Café\nok"), "Caf%C3%A9%0Aok");
});

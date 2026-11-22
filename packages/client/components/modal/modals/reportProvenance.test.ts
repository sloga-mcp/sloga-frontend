// Unit spec for the report queue's provenance labels. Run with Node's
// built-in runner from packages/client:
//   node --test --conditions=browser components/modal/modals/reportProvenance.test.ts
// Declared test count: 11 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// `REPORT_PROVENANCE_UNDER_TEST=<path>` loads another copy of the module and
// `REPORT_QUEUE_TSX=<path>` scans another copy of `ReportQueue.tsx` (for
// failing controls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type Provenance = typeof import("./reportProvenance.ts");

const override = process.env.REPORT_PROVENANCE_UNDER_TEST;
const { reportTargetOf, reportedAuthorOf, reporterCopyLabel } = (await import(
  override
    ? pathToFileURL(resolve(override)).href
    : new URL("./reportProvenance.ts", import.meta.url).href
)) as Provenance;

const reporter = (message: Record<string, unknown>) => ({
  content: { _type: "ReporterMessage", message, context: [] },
});

const server = (message: Record<string, unknown>) => ({
  content: {
    _type: "Message",
    prior_context: [],
    leading_context: [],
    message,
  },
});

const COPY = { id: "M1", channel: "C1", author: "U1", content: "hi" };
const SERVER = { _id: "M1", channel: "C1", author: "U1", content: "hi" };

test("a server copy with the same id verifies the reporter's copy", () => {
  const mine = reporter(COPY);
  assert.deepEqual(reporterCopyLabel(mine, [mine, server(SERVER)]), {
    unverified: false,
    markedEncrypted: false,
  });
});

test("no server copy: unverified", () => {
  const mine = reporter(COPY);
  assert.deepEqual(reporterCopyLabel(mine, [mine]), {
    unverified: true,
    markedEncrypted: false,
  });
});

test("no server copy and flagged encrypted: both labels", () => {
  const mine = reporter({ ...COPY, encrypted: true });
  assert.deepEqual(reporterCopyLabel(mine, [mine]), {
    unverified: true,
    markedEncrypted: true,
  });
});

test("a server copy wins over the encrypted flag", () => {
  const mine = reporter({ ...COPY, encrypted: true });
  assert.deepEqual(reporterCopyLabel(mine, [mine, server(SERVER)]), {
    unverified: false,
    markedEncrypted: false,
  });
});

test("only a literal true counts as the encrypted flag", () => {
  for (const encrypted of ["true", 1, false, null, undefined]) {
    const mine = reporter({ ...COPY, encrypted });
    assert.equal(
      reporterCopyLabel(mine, [mine]).markedEncrypted,
      false,
      String(encrypted),
    );
  }
});

test("a server copy of another message, or a copy with no id, does not verify", () => {
  const mine = reporter(COPY);
  const other = server({ ...SERVER, _id: "M2" });
  assert.equal(reporterCopyLabel(mine, [mine, other]).unverified, true);

  // The id is read from the server's `_id`, not a client-style `id`
  const wrongKey = server({ id: "M1", author: "U1" });
  assert.equal(reporterCopyLabel(mine, [mine, wrongKey]).unverified, true);

  for (const id of [undefined, "", 7]) {
    const blank = reporter({ ...COPY, id });
    const empty = server({ ...SERVER, _id: id });
    assert.equal(reporterCopyLabel(blank, [blank, empty]).unverified, true);
  }
});

test("other kinds of snapshot get no label", () => {
  for (const content of [
    { _type: "User", username: "x" },
    { _type: "Server", name: "x" },
    server(SERVER).content,
    null,
    undefined,
  ]) {
    assert.deepEqual(reporterCopyLabel({ content }, []), {
      unverified: false,
      markedEncrypted: false,
    });
  }
});

test("enforcement targets the server copy's author before the reporter's claim", () => {
  const claimed = reporter({ ...COPY, author: "FRAMED" });
  const real = server({ ...SERVER, author: "REAL" });
  assert.equal(reportedAuthorOf([claimed, real]), "REAL");
  assert.equal(reportedAuthorOf([real, claimed]), "REAL");
  assert.equal(reportedAuthorOf([claimed]), "FRAMED");
  assert.equal(reportedAuthorOf([{ content: { _type: "User" } }]), undefined);
  assert.equal(reportedAuthorOf([]), undefined);
});

const MESSAGE = { type: "Message", id: "M1" };

test("claimed author only: no server copy names an author", () => {
  const claimed = reporter({ ...COPY, author: "NAMED" });
  assert.deepEqual(reportTargetOf(MESSAGE, [claimed]), {
    id: "NAMED",
    claimedOnly: true,
  });

  // A server copy with no readable author proves nothing either
  for (const author of [undefined, "", 7]) {
    const blank = server({ ...SERVER, author });
    assert.deepEqual(
      reportTargetOf(MESSAGE, [blank, claimed]),
      { id: "NAMED", claimedOnly: true },
      String(author),
    );
  }

  // The encrypted flag does not change who is named, or on what evidence
  const flagged = reporter({ ...COPY, author: "NAMED", encrypted: true });
  assert.equal(reportTargetOf(MESSAGE, [flagged])?.claimedOnly, true);

  // Nobody named at all: nothing to act on
  const nobody = reporter({ ...COPY, author: "" });
  assert.equal(reportTargetOf(MESSAGE, [nobody]), undefined);
  assert.equal(reportTargetOf(MESSAGE, []), undefined);
});

test("a server copy's author or a reported user is not claimed-only", () => {
  const claimed = reporter({ ...COPY, author: "NAMED" });
  const real = server({ ...SERVER, author: "REAL" });
  for (const snapshots of [[claimed, real], [real, claimed], [real]]) {
    assert.deepEqual(reportTargetOf(MESSAGE, snapshots), {
      id: "REAL",
      claimedOnly: false,
    });
  }

  // A user report names its user; a reporter's copy cannot redirect it
  assert.deepEqual(reportTargetOf({ type: "User", id: "U9" }, [claimed]), {
    id: "U9",
    claimedOnly: false,
  });
  assert.equal(reportTargetOf({ type: "User", id: "" }, [claimed]), undefined);
});

/** Source text without comments, so a comment cannot satisfy a pin. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("wiring: a user only the reporter names needs a confirmation that repeats the Unverified line", () => {
  const path = process.env.REPORT_QUEUE_TSX;
  const queue = code(
    readFileSync(
      path ? resolve(path) : new URL("./ReportQueue.tsx", import.meta.url),
      "utf8",
    ),
  );
  const squash = (text: string) => text.replace(/\s+/g, " ");

  assert.match(queue, /reportTargetOf\(\s*report\.content,/);
  assert.doesNotMatch(queue, /reportedAuthorOf\(/);

  const at = (marker: string) => {
    const index = queue.indexOf(marker);
    assert.notEqual(index, -1, marker);
    return index;
  };
  const verified = at("<Match when={target()?.claimedOnly === false}>");
  const ask = at("<Match when={target()?.claimedOnly && !confirmClaimed()}>");
  const confirm = at(
    "<Match when={target()?.claimedOnly && confirmClaimed()}>",
  );
  const end = queue.indexOf("</Switch>", confirm);
  assert.ok(verified < ask && ask < confirm && confirm < end);

  // A verified author: one press opens suspension, label unchanged
  const one = squash(queue.slice(verified, ask));
  assert.match(one, /onClick=\{suspendReportedUser\}/);
  assert.match(
    one,
    /<Trans>Suspend \{username\(reportedUserId\(\)\)\}<\/Trans>/,
  );

  // A claimed author: the press only asks, and the label says who named them
  const two = squash(queue.slice(ask, confirm));
  assert.match(two, /onClick=\{\(\) => setConfirmClaimed\(true\)\}/);
  assert.doesNotMatch(two, /suspendReportedUser/);
  assert.match(
    two,
    /Suspend \{username\(reportedUserId\(\)\)\} \(named by the reporter\)/,
  );

  // The confirmation repeats the Unverified line before the real press
  const three = squash(queue.slice(confirm, end));
  const line = three.indexOf(
    "Unverified: this text was supplied by the reporter. Sloga has no copy " +
      "of this message (it was end-to-end encrypted or deleted) and cannot " +
      "confirm who sent it or what it said.",
  );
  assert.notEqual(line, -1, "the Unverified line");
  const press = three.indexOf("onClick={suspendReportedUser}");
  assert.ok(line < press, "the line comes before the suspend press");
});

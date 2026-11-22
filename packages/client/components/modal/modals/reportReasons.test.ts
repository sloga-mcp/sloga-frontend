// Unit spec for the report reason gating; run with Node's built-in runner:
//   node --conditions=browser --test components/modal/modals/reportReasons.test.ts
// Focus: without Take It Down the lists are exactly the ones from before it,
// with it the new reasons replace IllegalPornography, a picked reason
// survives the switch, the config answer is read strictly and asked once,
// and the role and email rules decide what an intimate image report sends.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type TakedownForm,
  isPlausibleEmail,
  reportReasons,
  takedownBody,
  takedownEnabledFrom,
  takedownFormState,
  takedownReportsEnabled,
} from "./reportReasons.ts";

const BEFORE_CONTENT = [
  "Illegal",
  "IllegalGoods",
  "IllegalExtortion",
  "IllegalPornography",
  "IllegalHacking",
  "ExtremeViolence",
  "PromotesHarm",
  "UnsolicitedSpam",
  "Raid",
  "SpamAbuse",
  "ScamsFraud",
  "Malware",
  "Harassment",
  "NoneSpecified",
];

const BEFORE_USER = [
  "UnsolicitedSpam",
  "SpamAbuse",
  "InappropriateProfile",
  "Impersonation",
  "BanEvasion",
  "Underage",
  "NoneSpecified",
];

const NEW_REASONS = ["NonConsensualIntimateImage", "ChildSexualAbuseMaterial"];

test("off: exactly the lists from before Take It Down", () => {
  assert.deepEqual(reportReasons("content", false), BEFORE_CONTENT);
  assert.deepEqual(reportReasons("user", false), BEFORE_USER);
});

test("on: new reasons replace IllegalPornography for content", () => {
  const list = reportReasons("content", true);
  assert.ok(!list.includes("IllegalPornography"));
  assert.deepEqual(list.slice(3, 5), NEW_REASONS);
  assert.deepEqual(
    list.filter((reason) => !NEW_REASONS.includes(reason)),
    BEFORE_CONTENT.filter((reason) => reason !== "IllegalPornography"),
  );
});

test("on: users get the intimate image reason only", () => {
  const list = reportReasons("user", true);
  assert.ok(list.includes("NonConsensualIntimateImage"));
  assert.ok(!list.includes("ChildSexualAbuseMaterial"));
  assert.deepEqual(
    list.filter((reason) => reason !== "NonConsensualIntimateImage"),
    BEFORE_USER,
  );
});

test("a reason picked before the switch stays offered, in place", () => {
  const list = reportReasons("content", true, "IllegalPornography");
  assert.equal(list[3], "IllegalPornography");
  assert.deepEqual(list.slice(4, 6), NEW_REASONS);

  // Reasons in both lists, and unknown values, change nothing
  assert.deepEqual(
    reportReasons("content", true, "Harassment"),
    reportReasons("content", true),
  );
  assert.deepEqual(
    reportReasons("content", false, "Bogus"),
    reportReasons("content", false),
  );
  // A content-only reason never leaks into the user list
  assert.deepEqual(
    reportReasons("user", false, "ChildSexualAbuseMaterial"),
    BEFORE_USER,
  );
});

test("config is on only for an explicit enabled: true", () => {
  assert.equal(takedownEnabledFrom({ enabled: true }), true);
  for (const answer of [
    { enabled: false },
    { enabled: "true" },
    { enabled: 1 },
    {},
    null,
    undefined,
    "<html>404</html>",
  ]) {
    assert.equal(takedownEnabledFrom(answer), false, JSON.stringify(answer));
  }
});

test("asked once per API base; a server error answer is kept", async () => {
  let calls = 0;
  const on = () => {
    calls++;
    return Promise.resolve({ enabled: true });
  };
  assert.equal(await takedownReportsEnabled("https://a.test/api", on), true);
  assert.equal(await takedownReportsEnabled("https://a.test/api", on), true);
  assert.equal(calls, 1);

  let old = 0;
  // stoat-api throws the response body (not an Error) for an error status
  const notFound = () => {
    old++;
    return Promise.reject("404 Not Found");
  };
  assert.equal(
    await takedownReportsEnabled("https://b.test/api", notFound),
    false,
  );
  assert.equal(
    await takedownReportsEnabled("https://b.test/api", notFound),
    false,
  );
  assert.equal(old, 1);
});

test("a request that never reached the server is asked again", async () => {
  let calls = 0;
  const flaky = () => {
    calls++;
    return calls === 1
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve({ enabled: true });
  };
  assert.equal(
    await takedownReportsEnabled("https://c.test/api", flaky),
    false,
  );
  assert.equal(await takedownReportsEnabled("https://c.test/api", flaky), true);
  assert.equal(calls, 2);
});

test("a fetcher that throws synchronously answers false", async () => {
  const boom = () => {
    throw new Error("boom");
  };
  assert.equal(await takedownReportsEnabled("https://d.test/api", boom), false);
});

const SIGNED: TakedownForm = {
  role: "Depicted",
  authorityNote: "",
  signature: "  Ana Silva ",
  signatureAck: true,
  statementAck: true,
  email: "",
  extra: "",
};

const NCII = "NonConsensualIntimateImage";

test("intimate image: nothing is sent until a role is picked", () => {
  const state = takedownFormState(NCII, { ...SIGNED, role: "" });
  assert.equal(state.ready, false);
  assert.equal(state.filesTakedown, false);
  assert.equal(
    takedownFormState(NCII, { ...SIGNED, role: "Bogus" }).ready,
    false,
  );
});

test("bystander: a plain report with no signature or boxes", () => {
  const state = takedownFormState(NCII, {
    ...SIGNED,
    role: "Bystander",
    signature: "",
    signatureAck: false,
    statementAck: false,
  });
  assert.deepEqual(state, {
    ready: true,
    filesTakedown: false,
    emailValid: true,
  });
});

test("person shown or authorized: signature, both boxes and a valid email", () => {
  for (const role of ["Depicted", "Authorized"]) {
    const form = { ...SIGNED, role };
    assert.deepEqual(takedownFormState(NCII, form), {
      ready: true,
      filesTakedown: true,
      emailValid: true,
    });
    assert.equal(
      takedownFormState(NCII, { ...form, signature: "  " }).ready,
      false,
    );
    assert.equal(
      takedownFormState(NCII, { ...form, signatureAck: false }).ready,
      false,
    );
    assert.equal(
      takedownFormState(NCII, { ...form, statementAck: false }).ready,
      false,
    );
    const typo = takedownFormState(NCII, { ...form, email: "ana@gmail" });
    assert.equal(typo.ready, false);
    assert.equal(typo.emailValid, false);
    assert.equal(
      takedownFormState(NCII, { ...form, email: " ana@example.com " }).ready,
      true,
    );
  }
});

test("other reasons never file a request", () => {
  const state = takedownFormState("Harassment", { ...SIGNED, role: "" });
  assert.equal(state.ready, true);
  assert.equal(state.filesTakedown, false);
});

test("email check: permissive but catches typos", () => {
  for (const ok of [
    "ana@example.com",
    "ana.silva+tida@mail.example.com.br",
    "o'brien@example.ie",
  ]) {
    assert.equal(isPlausibleEmail(ok), true, ok);
  }
  for (const bad of [
    "",
    "ana",
    "ana@",
    "@example.com",
    "ana@example",
    "ana@example.",
    "ana@@example.com",
    "ana silva@example.com",
    "ana@exa mple.com",
    `${"a".repeat(65)}@example.com`,
    `ana@${"a".repeat(250)}.com`,
  ]) {
    assert.equal(isPlausibleEmail(bad), false, bad);
  }
});

test("takedown body: trimmed, authority note only when authorized", () => {
  assert.deepEqual(takedownBody({ ...SIGNED, authorityNote: "parent" }), {
    role: "Depicted",
    authority_note: undefined,
    signature: "Ana Silva",
    signature_ack: true,
    statement_ack: true,
    email: undefined,
    extra: undefined,
  });
  assert.deepEqual(
    takedownBody({
      ...SIGNED,
      role: "Authorized",
      authorityNote: " parent ",
      email: " ana@example.com ",
      extra: " more ",
    }),
    {
      role: "Authorized",
      authority_note: "parent",
      signature: "Ana Silva",
      signature_ack: true,
      statement_ack: true,
      email: "ana@example.com",
      extra: "more",
    },
  );
});

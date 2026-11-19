/**
 * Which reasons the report dialog offers, and whether the server takes Take
 * It Down reports. Kept free of app imports so `node --test` can load it.
 */

/**
 * Content (message or server) reasons every server version accepts
 */
const LEGACY_CONTENT_REASONS = [
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
] as const;

/**
 * Content reasons once Take It Down is on: `IllegalPornography` is split into
 * the two reasons in its place (older reports still carry it)
 */
const TAKEDOWN_CONTENT_REASONS = [
  "Illegal",
  "IllegalGoods",
  "IllegalExtortion",
  "NonConsensualIntimateImage",
  "ChildSexualAbuseMaterial",
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
] as const;

const LEGACY_USER_REASONS = [
  "UnsolicitedSpam",
  "SpamAbuse",
  "InappropriateProfile",
  "Impersonation",
  "BanEvasion",
  "Underage",
  "NoneSpecified",
] as const;

const TAKEDOWN_USER_REASONS = [
  "UnsolicitedSpam",
  "SpamAbuse",
  "InappropriateProfile",
  "NonConsensualIntimateImage",
  "Impersonation",
  "BanEvasion",
  "Underage",
  "NoneSpecified",
] as const;

/**
 * Reasons for reporting a message or server. The `stoat-api` typings
 * predate the Take It Down reasons, so these are spelled out here.
 */
export type ContentReportReason =
  | (typeof LEGACY_CONTENT_REASONS)[number]
  | (typeof TAKEDOWN_CONTENT_REASONS)[number];

/**
 * Reasons for reporting a user
 */
export type UserReportReason =
  | (typeof LEGACY_USER_REASONS)[number]
  | (typeof TAKEDOWN_USER_REASONS)[number];

export type ReportReason = ContentReportReason | UserReportReason;

/**
 * Reasons to offer for a report.
 *
 * Without Take It Down (older server, feature off, or no answer yet) this is
 * exactly the list from before it existed. A reason the user already picked
 * stays in the list when it switches, at its place in the other list, so the
 * choice is never swapped for one they did not make.
 *
 * @param kind What is being reported
 * @param takedownEnabled Whether the server takes Take It Down reports
 * @param selected The reason picked so far, if any
 */
export function reportReasons(
  kind: "content" | "user",
  takedownEnabled: boolean,
  selected?: string,
): ReportReason[] {
  const [current, other]: [readonly ReportReason[], readonly ReportReason[]] =
    kind === "user"
      ? takedownEnabled
        ? [TAKEDOWN_USER_REASONS, LEGACY_USER_REASONS]
        : [LEGACY_USER_REASONS, TAKEDOWN_USER_REASONS]
      : takedownEnabled
        ? [TAKEDOWN_CONTENT_REASONS, LEGACY_CONTENT_REASONS]
        : [LEGACY_CONTENT_REASONS, TAKEDOWN_CONTENT_REASONS];

  const list = [...current];
  const kept = other.find((reason) => reason === selected);
  if (kept && !list.includes(kept)) {
    list.splice(Math.min(other.indexOf(kept), list.length), 0, kept);
  }

  return list;
}

/**
 * Read `GET /takedown/config`: on only for an explicit `enabled: true`
 */
export function takedownEnabledFrom(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    (response as { enabled?: unknown }).enabled === true
  );
}

/**
 * One answer per API base for the session
 */
const configCache = new Map<string, Promise<boolean>>();

/**
 * Whether the server at `apiBase` takes Take It Down reports, asked once per
 * session. Any failure answers false. A server's answer (including an error
 * status from an older server) is kept; a request that never reached the
 * server (thrown as an `Error`, e.g. offline) is asked again next time.
 *
 * @param apiBase API base URL, the cache key
 * @param fetchConfig Fetches `GET /takedown/config`
 */
export function takedownReportsEnabled(
  apiBase: string,
  fetchConfig: () => Promise<unknown>,
): Promise<boolean> {
  let answer = configCache.get(apiBase);

  if (!answer) {
    answer = Promise.resolve()
      .then(fetchConfig)
      .then(takedownEnabledFrom, (error: unknown) => {
        if (error instanceof Error) configCache.delete(apiBase);
        return false;
      });

    configCache.set(apiBase, answer);
  }

  return answer;
}

/**
 * Who is filing an intimate image report. `Depicted` and `Authorized` file
 * a Take It Down request with the report; `Bystander` is a client-only
 * choice that files a plain report with the same reason.
 */
export type TakedownRoleChoice = "Depicted" | "Authorized" | "Bystander";

/**
 * The Take It Down part of the report form
 */
export interface TakedownForm {
  role: string;
  authorityNote: string;
  signature: string;
  signatureAck: boolean;
  statementAck: boolean;
  email: string;
  extra: string;
}

/**
 * Loose email check, a little stricter than nothing and never stricter than
 * the server's on the part before the `@`, so a typo gets a field error
 * instead of the server's generic "invalid request body"
 */
export function isPlausibleEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(value)
  );
}

/**
 * Whether a report with this reason and form can be sent, and whether it
 * files a Take It Down request
 *
 * @param reason Picked report reason
 * @param form Take It Down part of the form
 */
export function takedownFormState(
  reason: string,
  form: TakedownForm,
): { ready: boolean; filesTakedown: boolean; emailValid: boolean } {
  const email = form.email.trim();
  const emailValid = !email || isPlausibleEmail(email);

  if (reason !== "NonConsensualIntimateImage") {
    return { ready: true, filesTakedown: false, emailValid };
  }

  switch (form.role as TakedownRoleChoice) {
    case "Bystander":
      return { ready: true, filesTakedown: false, emailValid };
    case "Depicted":
    case "Authorized":
      return {
        ready:
          !!form.signature.trim() &&
          form.signatureAck &&
          form.statementAck &&
          emailValid,
        filesTakedown: true,
        emailValid,
      };
    default:
      // No role picked yet
      return { ready: false, filesTakedown: false, emailValid };
  }
}

/**
 * The `takedown` field of the report body. Optional fields are left out when
 * empty: the server checks the email format on any value it gets.
 *
 * @param form Take It Down part of the form, with role Depicted or Authorized
 */
export function takedownBody(form: TakedownForm) {
  const authorized = form.role === "Authorized";
  const authorityNote = form.authorityNote.trim();
  const email = form.email.trim();
  const extra = form.extra.trim();

  return {
    role: authorized ? "Authorized" : "Depicted",
    authority_note: authorized && authorityNote ? authorityNote : undefined,
    signature: form.signature.trim(),
    signature_ack: form.signatureAck,
    statement_ack: form.statementAck,
    email: email || undefined,
    extra: extra || undefined,
  };
}

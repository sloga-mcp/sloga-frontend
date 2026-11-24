// Spec for the S2 protected-channel modal registrations (W4-5 lane L9), run
// with Node's built-in runner from packages/client:
//   node --conditions=browser --test components/modal/modals/protectedModalRegistration.scan.test.ts
//
// `types.ts` and `modals.tsx` import Solid, stoat.js and every modal, so Node
// cannot load them; this spec scans them as the seat picker's P1 does, with
// comments dropped first (a commented-out line never counts).
//
//  R1  `protected_device_cap` (S2-D38): the `Modals` union carries
//      `ProtectedDeviceCapProps` (a type-only import from the modal file,
//      whose props pin `type: "protected_device_cap"` and `channel`), and
//      `modals.tsx` has ONE arm for it, before `default` (which only logs,
//      so a missing arm never opens), rendering `ProtectedDeviceCapModal`;
//  R2  the same for `protected_owner_review` (S2-D41) and
//      `ProtectedOwnerReviewModal`.
//
// Point `PROTECTED_MODAL_TYPES_FILE` or `PROTECTED_MODALS_FILE` at another
// copy (a known-bad control) to check that instead; it must fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (env: string, fallback: string) =>
  readFileSync(process.env[env] || join(here, fallback), "utf8");

/** Drop block and whole-line comments so prose never counts as code. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const TYPES = code(read("PROTECTED_MODAL_TYPES_FILE", "../types.ts"));
const MODALS = code(read("PROTECTED_MODALS_FILE", "../modals.tsx"));

const count = (s: string, needle: string) => s.split(needle).length - 1;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One registered modal: its id, props type, component and file. */
interface Registration {
  id: string;
  props: string;
  modal: string;
  file: string;
}

function assertRegistered(r: Registration) {
  // types.ts: the props type comes from the modal file, type-only
  assert.equal(
    count(TYPES, `import type { ${r.props} } from "./modals/${r.file}";`),
    1,
    `types.ts imports ${r.props} (type-only) once`,
  );
  const union = TYPES.indexOf("export type Modals =");
  assert.ok(union !== -1, "types.ts lacks the Modals union");
  const members = TYPES.slice(union).match(
    new RegExp(`\\|\\s*${r.props}\\b`, "g"),
  );
  assert.equal(
    members?.length ?? 0,
    1,
    `the Modals union carries ${r.props} once`,
  );

  // the props pin the discriminant the arm switches on
  const modalSource = code(readFileSync(join(here, `${r.file}.tsx`), "utf8"));
  assert.match(
    modalSource,
    new RegExp(
      `export interface ${r.props} \\{\\s*type: "${r.id}";\\s*channel: Channel;\\s*\\}`,
    ),
  );
  assert.match(
    modalSource,
    new RegExp(
      `export function ${r.modal}\\(\\s*props: DialogProps & ${r.props},\\s*\\)`,
    ),
  );

  // modals.tsx: the component import and ONE arm before `default`
  assert.equal(
    count(MODALS, `import { ${r.modal} } from "./modals/${r.file}";`),
    1,
    `modals.tsx imports ${r.modal} once`,
  );
  const arm = MODALS.indexOf(`case "${r.id}":`);
  assert.ok(arm !== -1, `modals.tsx has no case "${r.id}"`);
  assert.equal(count(MODALS, `case "${r.id}":`), 1, "one arm only");
  const def = MODALS.indexOf("default:", arm);
  assert.ok(def !== -1, "the arm must sit before the default arm");
  assert.match(
    MODALS.slice(arm, def),
    new RegExp(
      `^case "${escape(r.id)}":\\s*return <${r.modal} \\{\\.\\.\\.modalProps\\} \\/>;`,
    ),
  );
}

describe("S2 protected modals are registered (lane L9)", () => {
  it("R1 protected_device_cap: union member, props and one switch arm", () => {
    assertRegistered({
      id: "protected_device_cap",
      props: "ProtectedDeviceCapProps",
      modal: "ProtectedDeviceCapModal",
      file: "ProtectedDeviceCap",
    });
  });

  it("R2 protected_owner_review: union member, props and one switch arm", () => {
    assertRegistered({
      id: "protected_owner_review",
      props: "ProtectedOwnerReviewProps",
      modal: "ProtectedOwnerReviewModal",
      file: "ProtectedOwnerReview",
    });
  });
});

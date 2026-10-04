/**
 * Duplicate role: what a copy of a server role is made of, and which of its
 * allow bits the acting member could not grant.
 *
 * The copy carries the name (with a suffix), server-wide permissions, colour
 * and hoist. Icon and channel permission overrides are not copied. The server
 * stays authoritative: these only build the requests and let the UI disable
 * the action before the server would refuse it.
 *
 * No runtime imports, so the module loads under node's native TypeScript
 * type-stripping. The caller passes the suffix already translated.
 */

/** Longest role name the server accepts, counted by code point
 * (`DataCreateRole.name`, `validate(length(min = 1, max = 32))`) */
export const ROLE_NAME_MAX = 32;

/** The parts of a role that a copy is built from */
export interface RoleCopySource {
  name: string;
  colour?: string | null;
  hoist?: boolean;
  /** Straight from `ServerRole.permissions`; stays bigint */
  permissions: { a: bigint; d: bigint };
}

/** Requests that make the copy: create, then set permissions, then edit */
export interface RoleCopyPlan {
  name: string;
  /** Absent when the source allows and denies nothing */
  permissions?: { allow: number; deny: number };
  /** Absent when the source has no colour and is not hoisted */
  edit?: { colour?: string; hoist?: true };
}

/**
 * Plan a copy of `source`, named `"<name> <suffix>"`.
 *
 * The name is cut by code point, never by UTF-16 unit, so an emoji is never
 * split, and the total fits ROLE_NAME_MAX. If nothing of the name survives the
 * cut and trim, the copy is named by the suffix alone.
 */
export function planRoleCopy(
  source: RoleCopySource,
  suffix: string,
): RoleCopyPlan {
  const tail = " " + suffix;
  const room = Math.max(0, ROLE_NAME_MAX - [...tail].length);
  const base = [...source.name].slice(0, room).join("").trimEnd();

  const plan: RoleCopyPlan = { name: base ? base + tail : suffix };

  const { a, d } = source.permissions;
  if (a !== 0n || d !== 0n) {
    // Exact: every permission bit is below 2^53
    plan.permissions = { allow: Number(a), deny: Number(d) };
  }

  const edit: NonNullable<RoleCopyPlan["edit"]> = {};
  if (source.colour) {
    edit.colour = source.colour;
  }

  if (source.hoist === true) {
    edit.hoist = true;
  }

  if (edit.colour !== undefined || edit.hoist) {
    plan.edit = edit;
  }

  return plan;
}

/**
 * Bits of `allow` that are missing from `have` (`allow & ~have`).
 *
 * BigInt operators only: permission bits reach 2^43 (UseWatchTogether, in
 * stoat.js `permissions/definitions.ts`), and JS `&` / `~` on numbers
 * truncate to 32 bits, which would drop every bit from 2^32 up and misread
 * bit 2^31 as the sign.
 */
export function missingAllowBits(allow: bigint, have: bigint): bigint {
  return allow & ~have;
}

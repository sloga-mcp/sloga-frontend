/**
 * FXU: whether THIS device makes the successor of a poisoned protected
 * group by itself (S2 D21), so the poisoned-group notice may say it is
 * re-securing (`noticeCopy(..., { signingDevice })`, FXT2). Every other
 * device holding the poisoned group reads that the owner has to re-create
 * it. FXP F-L6: a device holding no group at all (`"no_group"`, signer or
 * not) reads that the group failed this device's security check.
 *
 * Pure and node-testable: no runtime imports, ids are compared and never
 * returned. Feeds copy only; it never gates anything.
 */
import type { ProtectedChannelView } from "./protectedTextTypes.ts";

/**
 * `true`: the device that re-secures by itself (D21). `"no_group"` (FXP
 * F-L6): native holds no group of the channel (`joining`, `left` or
 * `none`): its own join was refused, there is no group of its own to
 * re-create from and no owner action it must wait for. `false`: any other
 * device (it holds the poisoned group and is not the signer).
 */
export type SigningDeviceRole = boolean | "no_group";

/**
 * The manager's D21 successor condition (`#afterRefresh` in
 * protectedText.ts), read from the published view: not refused as outdated
 * (`clientOutdated`), native holds the group `poisoned`, the server still
 * names that group as open (`serverGroup.group_id`), and this device signed
 * the current seat list (user AND device). Plus the server flag still on
 * (`serverProtected`): the manager runs no maintenance for a stripped
 * channel. Anything missing or unknown is false, so the copy never
 * promises a re-secure it cannot back. FXP F-L6: whatever device this is,
 * a native state that holds no group is `"no_group"` (checked first: no
 * group means neither re-securing nor an owner's re-create applies).
 * @param shield `useProtectedShield(...)()`: its view and server flag
 * @param self This session's user and E2EE device (`protectedSelfIds`)
 */
export function signingDeviceOf(
  shield:
    | {
        view?: ProtectedChannelView | null;
        serverProtected?: boolean;
      }
    | null
    | undefined,
  self: {
    userId: string | null | undefined;
    deviceId: string | null | undefined;
  },
): SigningDeviceRole {
  if (!shield || shield.serverProtected !== true) return false;
  const view = shield.view;
  const state = view?.native?.state;
  if (state === "joining" || state === "left" || state === "none") {
    return "no_group";
  }
  if (!view || view.clientOutdated !== null) return false;
  const n = view.native;
  const g = view.serverGroup;
  if (!n || n.state !== "poisoned" || !g || g.group_id !== n.group_id) {
    return false;
  }
  const list = n.seat_list;
  const userId = self.userId;
  const deviceId = self.deviceId;
  return (
    typeof userId === "string" &&
    userId.length > 0 &&
    typeof deviceId === "string" &&
    deviceId.length > 0 &&
    !!list &&
    list.signer_user_id === userId &&
    list.signer_device_id === deviceId
  );
}

/**
 * This session's user id and E2EE device id from the client, the same reads
 * as the header pill (`client.user.id`, the bridge's `status` state
 * `device_id`). A missing or non-string value is null.
 * @param client `useClient()()`
 */
export function protectedSelfIds(client: unknown): {
  userId: string | null;
  deviceId: string | null;
} {
  const c = client as
    | {
        user?: { id?: unknown } | null;
        e2ee?: { status?: { get?: unknown } | null } | null;
      }
    | null
    | undefined;
  const userId = c?.user?.id;
  const status = c?.e2ee?.status;
  const state: unknown =
    status && typeof status.get === "function"
      ? (status as { get(key: string): unknown }).get("state")
      : null;
  const deviceId =
    typeof state === "object" && state !== null
      ? (state as { device_id?: unknown }).device_id
      : undefined;
  return {
    userId: typeof userId === "string" ? userId : null,
    deviceId: typeof deviceId === "string" ? deviceId : null,
  };
}

/**
 * FXU: whether THIS device makes the successor of a poisoned protected
 * group by itself (S2 D21), so the poisoned-group notice may say it is
 * re-securing (`noticeCopy(..., { signingDevice })`, FXT2). Every other
 * device reads that the owner has to re-create the group.
 *
 * Pure and node-testable: no runtime imports, ids are compared and never
 * returned. Feeds copy only; it never gates anything.
 */
import type { ProtectedChannelView } from "./protectedTextTypes.ts";

/**
 * The manager's D21 successor condition (`#afterRefresh` in
 * protectedText.ts), read from the published view: not refused as outdated
 * (`clientOutdated`), native holds the group `poisoned`, the server still
 * names that group as open (`serverGroup.group_id`), and this device signed
 * the current seat list (user AND device). Plus the server flag still on
 * (`serverProtected`): the manager runs no maintenance for a stripped
 * channel. Anything missing or unknown is false, so the copy never
 * promises a re-secure it cannot back.
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
): boolean {
  if (!shield || shield.serverProtected !== true) return false;
  const view = shield.view;
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

import { createSignal } from "solid-js";

import { cva } from "styled-system/css";

import { useUser } from "@revolt/client";
import { Avatar, UserStatus, isSlogaStaff, usePresenceText } from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { UserMenu } from "../../src/interface/navigation/servers/UserMenu";

/**
 * Your own avatar, name and presence; clicking it opens the same menu as
 * the avatar in the server rail. This is the only way to change presence
 * from the friends window, which has no app chrome of its own.
 */
export function SelfBar() {
  const user = useUser();
  const presence = usePresenceText();
  const [anchor, setAnchor] = createSignal<HTMLDivElement>();

  return (
    <>
      <div class={selfBar()} ref={setAnchor}>
        <Avatar
          size={36}
          src={user()?.animatedAvatarURL}
          fallback={user()?.username}
          holepunch="bottom-right"
          overlay={<UserStatus.Graphic status={user()?.presence} />}
        />
        <div class={nameStack()}>
          <div class={selfName()}>
            <span class={ellipsis()}>
              <DisplayName
                user={user()}
                name={user()?.displayName ?? ""}
                brand={isSlogaStaff(user())}
              />
            </span>
            <Symbol size={18}>expand_more</Symbol>
          </div>
          <div class={`${statusText()} ${ellipsis()}`}>
            {user()?.status?.text ?? presence.pickerLabel(user()?.presence)}
          </div>
        </div>
      </div>
      {/* Below the bar: the bar spans the whole friends window, so the rail's
          right-hand placement put the menu past the window's edge */}
      <UserMenu anchor={anchor} placement="bottom-start" />
    </>
  );
}

const selfBar = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm)",
    marginBlockStart: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    userSelect: "none",
    color: "var(--md-sys-color-on-surface)",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

const selfName = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
    fontSize: "15px",
    fontWeight: 500,
  },
});

const nameStack = cva({
  base: {
    minWidth: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
});

const statusText = cva({
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ellipsis = cva({
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

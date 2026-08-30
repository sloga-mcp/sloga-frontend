import { createMemo, createSignal, For } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import { inviteUrl } from "@revolt/common";
import {
  Avatar,
  Checkbox,
  Column,
  Dialog,
  DialogProps,
  TextField,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Invite one or more friends to a server by DMing them an invite link
 */
export function InviteToServerModal(
  props: DialogProps & Modals & { type: "invite_to_server" },
) {
  const { t } = useLingui();
  const client = useClient();
  const { showError } = useModals();

  const [selected, setSelected] = createSignal<string[]>([]);
  const [filter, setFilter] = createSignal("");
  const [pending, setPending] = createSignal(false);

  const filterLowercase = createMemo(() => filter().toLowerCase());

  const friends = createMemo(() =>
    client()
      .users.filter((user) => user.relationship === "Friend")
      .filter((user) =>
        user.displayName.toLowerCase().includes(filterLowercase()),
      )
      .toSorted((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  function toggle(userId: string) {
    setSelected((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  }

  async function onSubmit() {
    if (selected().length === 0) return;
    setPending(true);

    try {
      // Find a channel in this server we can invite from
      const channel = props.server.orderedChannels
        .find((cat) =>
          cat.channels.find((ch) => ch.havePermission("InviteOthers")),
        )
        ?.channels.find((ch) => ch.havePermission("InviteOthers"));

      if (!channel) {
        showError(new Error(t`No channels available to create an invite for.`));
        return;
      }

      // Create one invite code shared across all DMs
      const invite = await channel.createInvite();
      const link = inviteUrl(invite._id);

      // DM each selected friend the invite link
      const selectedIds = selected();
      for (const userId of selectedIds) {
        const user = client().users.get(userId);
        if (!user) continue;
        const dm = await user.openDM();
        await dm.sendMessage(link);
      }

      props.onClose();
    } catch (err) {
      showError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Invite Friends to {props.server.name}</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Send Invites</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: selected().length === 0 || pending(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <TextField
          value={filter()}
          variant="filled"
          placeholder={t`Search friends...`}
          onKeyUp={(e) => setFilter(e.currentTarget.value)}
        />
        <Column>
          {/* `friends()` is reactive and filtered by the search box above, so
              this is the case the rule is actually about: with Array#map,
              every keystroke rebuilds every row's DOM. */}
          <For each={friends()}>
            {(user) => (
              <a
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "var(--gap-md)",
                  padding: "8px 12px",
                  "border-radius": "var(--borderRadius-md)",
                  cursor: "pointer",
                  background: selected().includes(user.id)
                    ? "var(--md-sys-color-secondary-container)"
                    : "transparent",
                }}
                onClick={() => toggle(user.id)}
              >
                <Avatar
                  src={user.animatedAvatarURL}
                  fallback={user.displayName}
                  size={32}
                />
                <span style={{ flex: 1 }}>{user.displayName}</span>
                <Checkbox checked={selected().includes(user.id)} />
              </a>
            )}
          </For>
        </Column>
      </Column>
    </Dialog>
  );
}

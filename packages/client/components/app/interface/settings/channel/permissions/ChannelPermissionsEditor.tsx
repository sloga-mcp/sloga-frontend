import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import {
  API,
  Channel,
  DEFAULT_PERMISSION_DIRECT_MESSAGE,
  Server,
} from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { Button, Checkbox2, OverrideSwitch, Row, Text } from "@revolt/ui";

type Props = (
  | { type: "server_default"; context: Server }
  | { type: "server_role"; context: Server; roleId: string }
  | { type: "channel_default"; context: Channel }
  | { type: "channel_role"; context: Channel; roleId: string }
  | { type: "group"; context: Channel }
) & {
  /** Called with true while the grid has unsaved changes, false once saved/reset or on unmount */
  onUnsavedChange?: (unsaved: boolean) => void;
};

// stoat-api's generated union predates threads; widen it locally. Threads
// carry no own overrides (permissions are edited on the parent), so "Thread"
// only ever hits the `desc.Any` fallback below.
type Context = API.Channel["channel_type"] | "Thread" | "Forum" | "Server";

/**
 * Generic editor for any channel permissions
 */
export function ChannelPermissionsEditor(props: Props) {
  const { t } = useLingui();

  const context: Context =
    // eslint-disable-next-line solid/reactivity
    props.context instanceof Server ? "Server" : props.context.type;

  /**
   * Current permission value, normalised to [allow, deny]
   * @returns [allow, deny] BigInts
   */
  function currentValue() {
    switch (props.type) {
      case "server_default":
        return [BigInt(props.context.defaultPermissions), BigInt(0)];
      case "server_role":
        return [
          BigInt(props.context.roles?.get(props.roleId)?.permissions.a || 0),
          BigInt(props.context.roles?.get(props.roleId)?.permissions.d || 0),
        ];
      case "channel_default":
        return [
          BigInt(props.context.defaultPermissions?.a || 0),
          BigInt(props.context.defaultPermissions?.d || 0),
        ];
      case "channel_role":
        return [
          BigInt(props.context.rolePermissions?.[props.roleId]?.a || 0),
          BigInt(props.context.rolePermissions?.[props.roleId]?.d || 0),
        ];
      case "group":
        return [
          BigInt(
            props.context.permissions ?? DEFAULT_PERMISSION_DIRECT_MESSAGE,
          ),
          BigInt(0),
        ];
    }
  }

  /**
   * Current edited values
   */
  const [value, setValue] = createSignal(currentValue());

  /**
   * Whether there is a pending save
   */
  function unsavedChanges() {
    const [a1, a2] = currentValue(),
      [b1, b2] = value();

    return a1 !== b1 || a2 !== b2;
  }

  /**
   * Tell the parent when the dirty state flips (initial value included), so a
   * page-level action such as Duplicate role can wait for these edits. Same
   * condition that enables Save below; it clears when the server's update
   * event lands, not when Save is pressed. The memo only notifies on a real
   * flip, and `on` reads the callback untracked, so a parent re-render cannot
   * loop back into this effect.
   */
  const dirty = createMemo(unsavedChanges);
  createEffect(on(dirty, (unsaved) => props.onUnsavedChange?.(unsaved)));
  onCleanup(() => props.onUnsavedChange?.(false));

  /**
   * Reset to the current value
   */
  function reset() {
    setValue(currentValue());
  }

  /**
   * Commit changes
   * @todo mutator
   */
  function save() {
    switch (props.type) {
      case "server_default":
        props.context.setPermissions(undefined, Number(value()[0]));
        break;
      case "server_role":
        props.context.setPermissions(props.roleId, {
          allow: Number(value()[0]),
          deny: Number(value()[1]),
        });
        break;
      case "channel_default":
        props.context.setPermissions(undefined, {
          allow: Number(value()[0]),
          deny: Number(value()[1]),
        });
        break;
      case "channel_role":
        props.context.setPermissions(props.roleId, {
          allow: Number(value()[0]),
          deny: Number(value()[1]),
        });
        break;
      case "group":
        props.context.setPermissions(undefined, Number(value()[0]));
        break;
    }
  }

  const Permissions: {
    heading?: string;
    key: string;
    value: bigint;
    title: string;
    description: Partial<Record<Context | "Any", string>>;
  }[] = [
    {
      heading: t`Admin`,
      key: "ManageChannel",
      value: 1n ** 0n,
      title: t`Manage Channel`,
      description: {
        Group: t`Edit group name and description`,
        // The generic wording reads as "the forum container only", which hid
        // that this is the forum's main moderation permission: deleting,
        // archiving and locking posts all go through it, as do moderated tags
        // and posting into a locked post.
        Forum: t`Edit the forum and its tags, and delete, archive or lock posts`,
        Any: t`Edit and delete channel`,
      },
    },
    {
      key: "ManageServer",
      value: 2n ** 1n,
      title: t`Manage Server`,
      description: {
        Server: t`Edit the server's information and settings`,
      },
    },
    {
      key: "ManagePermissions",
      value: 2n ** 2n,
      title: t`Manage Permissions`,
      description: {
        Group: t`Whether other users can edit these settings`,
        TextChannel: t`Edit channel-specific role and default permissions`,
        Forum: t`Edit forum-specific role and default permissions`,
        Server: t`Edit any permissions on the server`,
      },
    },
    {
      key: "ManageRole",
      value: 2n ** 3n,
      title: t`Manage Roles`,
      description: {
        // This bit is also enforced per-CHANNEL: a masquerade that carries a
        // color needs it, in both `message_send` and `forum_post_create`.
        // With only the server wording the row never rendered on a channel,
        // so the one thing it gates there could not be granted or denied
        // except by handing out server-wide role management.
        TextChannel: t`Allow members to set a color with Masquerade`,
        Forum: t`Allow members to set a color with Masquerade`,
        Server: t`Create and edit server roles`,
      },
    },
    {
      key: "ManageCustomisation",
      value: 2n ** 4n,
      title: t`Manage Customization`,
      description: {
        Server: t`Create server emoji`,
      },
    },
    {
      heading: t`Members`,
      key: "KickMembers",
      value: 2n ** 6n,
      title: t`Kick Members`,
      description: {
        Server: t`Kick lower-ranking members from the server`,
      },
    },
    {
      key: "BanMembers",
      value: 2n ** 7n,
      title: t`Ban Members`,
      description: {
        Server: t`Ban lower-ranking members from the server`,
      },
    },
    {
      key: "TimeoutMembers",
      value: 2n ** 8n,
      title: t`Timeout Members`,
      description: {
        Server: t`Temporarily prevent lower-ranking members from interacting`,
      },
    },
    {
      key: "AssignRoles",
      value: 2n ** 9n,
      title: t`Assign Roles`,
      description: {
        Server: t`Assign lower-ranked roles to lower-ranking members`,
      },
    },
    {
      key: "ChangeNickname",
      value: 2n ** 10n,
      title: t`Change Nickname`,
      description: {
        Server: t`Change own nickname`,
      },
    },
    {
      key: "ManageNicknames",
      value: 2n ** 11n,
      title: t`Manage Nicknames`,
      description: {
        Server: t`Change other members' nicknames`,
      },
    },
    {
      key: "ChangeAvavar",
      value: 2n ** 12n,
      title: t`Change Avatar`,
      description: {
        Server: t`Change own avatar`,
      },
    },
    {
      key: "RemoveAvatars",
      value: 2n ** 13n,
      title: t`Remove Avatars`,
      description: {
        Server: t`Remove other members' avatars`,
      },
    },
    {
      heading: t`Channels`,
      key: "ViewChannel",
      value: 2n ** 20n,
      title: t`View Channel`,
      description: {
        TextChannel: t`Able to access this channel`,
        Forum: t`Able to access this forum`,
        Server: t`Able to access channels on this server`,
      },
    },
    {
      key: "ReadMessageHistory",
      value: 2n ** 21n,
      title: t`Read Message History`,
      description: {
        TextChannel: t`Read past messages sent in channel`,
        // Since backend c48a7a2b the server withholds starter messages (and
        // any thread message fetched by id) without this permission, so it
        // governs what older posts SAY as well as their replies. Keep "past":
        // live delivery is not gated, so new posts and replies still arrive
        // for a connected member. The post list (titles, tags) is View
        // Channel only. 🔴 Must not ship before c48a7a2b is deployed.
        Forum: t`Read past posts and their replies. Without it, older posts show only their titles`,
        Server: t`Read past messages sent in channels`,
      },
    },
    {
      key: "SendMessage",
      value: 2n ** 22n,
      title: t`Send Messages`,
      description: {
        Group: t`Send messages in channel`,
        TextChannel: t`Send messages in channel`,
        Forum: t`Create posts and reply to them`,
        Server: t`Send messages in channels`,
      },
    },
    {
      key: "ManageMessages",
      value: 2n ** 23n,
      title: t`Manage Messages`,
      description: {
        Group: t`Delete and pin messages sent by other members`,
        TextChannel: t`Delete and pin messages sent by other members`,
        // Pinning is per-MESSAGE, and deleting a whole post goes through the
        // channel-delete route, which wants Manage Channel on the forum. The
        // permission named here does neither of those things to a post, so
        // the copy says where that power actually lives.
        Forum: t`Delete and pin messages by other members — deleting a whole post needs Manage Channel`,
        Server: t`Delete and pin messages sent by other members`,
      },
    },
    {
      key: "ManageWebhooks",
      value: 2n ** 24n,
      title: t`Manage Webhooks`,
      description: {
        Group: t`Create and edit webhooks`,
        TextChannel: t`Create and edit webhooks`,
        Server: t`Create and edit webhooks`,
      },
    },
    {
      key: "InviteOthers",
      value: 2n ** 25n,
      title: t`Invite Others`,
      description: {
        Group: t`Add new members to the group`,
        Any: t`Create invites for others to use`,
      },
    },
    {
      heading: t`Messaging`,
      key: "SendEmbeds",
      value: 2n ** 26n,
      title: t`Send Embeds`,
      description: {
        Any: t`Send embedded content such as link embeds or custom embeds`,
      },
    },
    {
      key: "UploadFiles",
      value: 2n ** 27n,
      title: t`Upload Files`,
      description: {
        Any: t`Send attachments to chat`,
      },
    },
    {
      key: "Masquerade",
      value: 2n ** 28n,
      title: t`Masquerade`,
      description: {
        Any: t`Allow members to change name and avatar per-message`,
      },
    },
    {
      key: "React",
      value: 2n ** 29n,
      title: t`React`,
      description: {
        Any: t`React to messages with emoji`,
      },
    },

    {
      key: "BypassSlowmode",
      value: 2n ** 39n,
      title: t`Bypass Slowmode`,
      description: {
        Server: t`Bypasses slowmode in channels`,
        TextChannel: t`Bypasses slowmode in channels`,
      },
    },
    {
      heading: t`Voice`,
      key: "Connect",
      value: 2n ** 30n,
      title: t`Connect`,
      description: {
        TextChannel: t`Connect to voice channel`,
        Server: t`Connect to voice channel`,
      },
    },
    {
      key: "Speak",
      value: 2n ** 31n,
      title: t`Speak`,
      description: {
        TextChannel: t`Able to speak in voice call`,
        Server: t`Able to speak in voice call`,
      },
    },
    {
      key: "Video",
      value: 2n ** 32n,
      title: t`Video`,
      description: {
        TextChannel: t`Share camera or screen in voice call`,
        Server: t`Share camera or screen in voice call`,
      },
    },
    {
      key: "MuteMembers",
      value: 2n ** 33n,
      title: t`Mute Members`,
      description: {
        TextChannel: t`Mute lower-ranking members in voice call`,
        Server: t`Mute lower-ranking members in voice call`,
      },
    },
    {
      key: "DeafenMembers",
      value: 2n ** 34n,
      title: t`Deafen Members`,
      description: {
        TextChannel: t`Deafen lower-ranking members in voice call`,
        Server: t`Deafen lower-ranking members in voice call`,
      },
    },
    {
      key: "MoveMembers",
      value: 2n ** 35n,
      title: t`Move Members`,
      description: {
        TextChannel: t`Move members between voice channels`,
        Server: t`Move members between voice channels`,
      },
    },
    {
      key: "Listen",
      value: 2n ** 36n,
      title: t`Listen`,
      description: {
        TextChannel: t`Hear other people and see their video`,
        Server: t`Hear other people and see their video`,
      },
    },
    {
      key: "UseSoundboard",
      value: 2n ** 40n,
      title: t`Use Soundboard`,
      description: {
        TextChannel: t`Play server soundboard sounds in a voice call`,
        Server: t`Play server soundboard sounds in a voice call`,
      },
    },
    {
      // Bit 41. Checked on the SHARER: it governs who may hand control of
      // their own shared screen to someone, never who may take control. It
      // had no row at all, so the only way to change it was a raw API call.
      // DMs and group DMs never consult it, hence no Group wording.
      key: "UseRemoteControl",
      value: 2n ** 41n,
      title: t`Remote Control`,
      description: {
        TextChannel: t`Hand control of their own shared screen to someone in the call`,
        Server: t`Hand control of their own shared screen to someone in the call`,
      },
    },
    {
      // Bit 42. Off by default (not in DEFAULT_PERMISSION), so this row is the
      // only way an ordinary member gets it — recording is the one voice action
      // whose output outlives the call. The description says everyone is told,
      // because granting this grants a disclosed capability, not a secret one.
      key: "RecordCall",
      value: 2n ** 42n,
      title: t`Record Call`,
      description: {
        TextChannel: t`Record call audio to their own device — everyone in the call is told`,
        Server: t`Record call audio to their own device — everyone in the call is told`,
      },
    },
    {
      // Bit 43. On by default (DEFAULT_PERMISSION + backend migration 68).
      // Gates STARTING and driving a watch-together session; watching along
      // needs only Connect, so this row is not "who may watch".
      key: "UseWatchTogether",
      value: 2n ** 43n,
      title: t`Watch Together`,
      description: {
        TextChannel: t`Start and control synced video playback in a voice call`,
        Server: t`Start and control synced video playback in a voice call`,
      },
    },
    {
      heading: t`Mentions`,
      key: "MentionEveryone",
      value: 2n ** 37n,
      title: t`Mention Everyone`,
      description: {
        Any: t`Mention everyone and online members inside the server`,
      },
    },
    {
      key: "MentionRoles",
      value: 2n ** 38n,
      title: t`Mention Roles`,
      description: {
        Any: t`Mention specific roles`,
      },
    },
  ];

  /**
   * Find description for this permission in context
   * If null, don't show this permission entry
   * @param entry Entry
   * @returns Description or null
   */
  function description(entry: (typeof Permissions)[number]) {
    const desc = entry.description;
    return desc[context] ?? desc.Any;
  }

  /**
   * The heading to draw above each entry.
   *
   * A heading is declared on the first entry of its section, but that entry
   * can be hidden in this context (no wording for it). Drawing the heading
   * only with its own entry took the whole section's title away with it, so
   * the section's remaining rows ran on under the previous heading. The
   * heading now goes above the first entry of the section that IS shown.
   */
  const headingFor = (() => {
    const headings = new Map<(typeof Permissions)[number], string>();
    let section: string | undefined;
    let drawn: string | undefined;
    for (const entry of Permissions) {
      if (entry.heading) section = entry.heading;
      if (!description(entry)) continue;
      if (section && section !== drawn) {
        headings.set(entry, section);
        drawn = section;
      }
    }
    return (entry: (typeof Permissions)[number]) => headings.get(entry);
  })();

  return (
    <div class={css({ display: "flex", flexDirection: "column" })}>
      <For each={Permissions}>
        {(entry) => (
          <Show when={description(entry)}>
            <Show when={headingFor(entry)}>
              <span class={css({ marginTop: "var(--gap-md)" })}>
                <Text class="label">{headingFor(entry)}</Text>
              </span>
            </Show>

            <Switch
              fallback={
                <ChannelPermissionToggle
                  key={entry.key}
                  title={entry.title}
                  description={description(entry) as string}
                  value={(value()[0] & entry.value) == entry.value}
                  onChange={() =>
                    setValue((v) => [v[0] ^ BigInt(entry.value), v[1]])
                  }
                  havePermission={
                    (props.context.permission & entry.value) === entry.value
                  }
                />
              }
            >
              <Match
                when={[
                  "channel_default",
                  "channel_role",
                  "server_role",
                ].includes(props.type)}
              >
                <ChannelPermissionOverride
                  key={entry.key}
                  title={entry.title}
                  description={description(entry) as string}
                  value={
                    (value()[0] & entry.value) == entry.value
                      ? "allow"
                      : (value()[1] & entry.value) == entry.value
                        ? "deny"
                        : "neutral"
                  }
                  onChange={(target) => {
                    let allow = value()[0] & ~entry.value;
                    let deny = value()[1] & ~entry.value;

                    if (target === "allow") allow |= entry.value;
                    if (target === "deny") deny |= entry.value;

                    setValue([allow, deny]);
                  }}
                  havePermission={
                    (props.context.permission & entry.value) === entry.value
                  }
                />
              </Match>
            </Switch>
          </Show>
        )}
      </For>

      <StickyPanel>
        <Row>
          <Button
            isDisabled={!unsavedChanges()}
            variant="text"
            size={unsavedChanges() ? "md" : "sm"}
            onPress={reset}
          >
            Reset
          </Button>
          <Button
            isDisabled={!unsavedChanges()}
            size={unsavedChanges() ? "md" : "sm"}
            onPress={save}
          >
            Save permissions
          </Button>
        </Row>
      </StickyPanel>
    </div>
  );
}

const StickyPanel = styled("div", {
  base: {
    position: "sticky",
    width: "fit-content",
    padding: "var(--gap-md)",
    bottom: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface)",
  },
});

function ChannelPermissionToggle(props: {
  key: string;
  title: string;
  description: string;

  value: boolean;
  onChange: (value: boolean) => void;

  havePermission: boolean;
}) {
  return (
    <Checkbox2
      name={props.key}
      checked={props.value}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
      disabled={!props.havePermission}
    >
      <div
        class={css({
          marginStart: "var(--gap-md)",
          display: "flex",
          flexDirection: "column",
        })}
      >
        <Text size="large">{props.title}</Text>
        <Text>{props.description}</Text>
      </div>
    </Checkbox2>
  );
}

function ChannelPermissionOverride(props: {
  key: string;
  title: string;
  description: string;

  value: "allow" | "deny" | "neutral";
  onChange: (value: "allow" | "deny" | "neutral") => void;

  havePermission: boolean;
}) {
  return (
    <div
      class={css({
        gap: "var(--gap-md)",
        display: "flex",
      })}
    >
      <div
        class={css({
          flexGrow: 1,
          display: "flex",
          flexDirection: "column",
        })}
      >
        <Text size="large">{props.title}</Text>
        <Text>{props.description}</Text>
      </div>
      <OverrideSwitch
        disabled={!props.havePermission}
        value={props.value}
        onChange={props.onChange}
      />
    </div>
  );
}

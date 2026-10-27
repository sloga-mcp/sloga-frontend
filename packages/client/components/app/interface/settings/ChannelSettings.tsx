import {
  BiRegularListUl,
  BiSolidCloud,
  BiSolidInfoCircle,
  BiSolidTrash,
} from "solid-icons/bi";
import { Match, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { type Client, Channel } from "stoat.js";

import { useClient } from "@revolt/client";
import { settingsCopy } from "@revolt/client/protectedCopy";
import { protectedUiOf } from "@revolt/client/useProtectedChannel";
import { channelNounOf } from "@revolt/common/lib/channelNoun";
import { TextWithEmoji } from "@revolt/markdown";
import { useModals } from "@revolt/modal";
import { ColouredText } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { SettingsConfiguration } from ".";
import ForumSettings from "./channel/ForumSettings";
import ChannelOverview from "./channel/Overview";
import { ChannelPermissionsEditor } from "./channel/permissions/ChannelPermissionsEditor";
import { ChannelPermissionsOverview } from "./channel/permissions/ChannelPermissionsOverview";
import {
  ProtectedChannelSettings,
  protectedSettingsVisibleFor,
} from "./channel/protected/ProtectedChannelSettings";
import { ViewWebhook } from "./channel/webhooks/ViewWebhook";
import { WebhooksList } from "./channel/webhooks/WebhooksList";
import { BackCard } from "./user/_AccountCard";

/** Channel types that have a Permissions page (see `render`). */
const PERMISSION_PAGE_TYPES: Channel["type"][] = [
  "Group",
  "TextChannel",
  "Forum",
];

// protected-tab:begin
/**
 * Whether the "Protected channel" tab and page exist for `channel` (S1
 * F2): the owner-only rule (product choice 4), and the feature stays
 * invisible while it is dark. Shown only when the D13 flag is on or the
 * channel is already protected or pinned. Web and Electron have no
 * protected bridge surface, so there only `isProtectedChannel` shows it.
 */
function protectedTabShown(
  channel: Channel,
  client: Client | undefined,
): boolean {
  if (!protectedSettingsVisibleFor(channel, client)) return false;
  return (
    client?.isProtectedChannel(channel.id) === true ||
    protectedUiOf(client?.e2ee)?.protectedFlag().enabled === true
  );
}
// protected-tab:end

const Config: SettingsConfiguration<Channel> = {
  /**
   * Page titles
   */
  title(ctx, key) {
    const client = useClient();
    const { t } = useLingui();

    if (key.startsWith("webhooks/")) {
      const webhook = client().channelWebhooks.get(key.substring(9));
      if (webhook) return webhook.name;
    }

    if (key.startsWith("permissions/")) {
      if (key === "permissions/default") return t`Default Permissions`;

      return ctx.context.server?.roles.get(key.substring(12))?.name ?? "";
    }

    return ctx.entries
      .flatMap((category) => category.entries)
      .find((entry) => entry.id === key)?.title as string;
  },

  /**
   * Render the current channel settings page
   */
  // we take care of the reactivity ourselves
  /* eslint-disable solid/components-return-once */
  render(props, channel) {
    const id = props.page();
    const client = useClient();

    if (id?.startsWith("webhooks/")) {
      const webhook = client().channelWebhooks.get(id.substring(9));
      return <ViewWebhook webhook={webhook!} />;
    }

    if (id?.startsWith("permissions/")) {
      if (id === "permissions/default") {
        return (
          <ChannelPermissionsEditor type="channel_default" context={channel} />
        );
      }

      return (
        <ChannelPermissionsEditor
          type="channel_role"
          context={channel}
          roleId={id.substring(12)}
        />
      );
    }

    switch (id) {
      case "overview":
        return <ChannelOverview channel={channel} />;
      case "forum":
        return <ForumSettings channel={channel} />;
      // Keep these arms in step with PERMISSION_PAGE_TYPES.
      case "permissions":
        switch (channel.type) {
          case "Group":
            return <ChannelPermissionsEditor type="group" context={channel} />;
          case "TextChannel":
          case "Forum":
            return <ChannelPermissionsOverview context={channel} />;
          default:
            return null;
        }
      case "webhooks":
        // The server refuses webhooks on protected channels (C13 note).
        return client().isProtectedChannel(channel.id) ? null : (
          <WebhooksList channel={channel} />
        );
      case "protected":
        // Server owner only (product choice 4), invisible while dark (F2);
        // the page re-checks ownership.
        return protectedTabShown(channel, client()) ? (
          <ProtectedChannelSettings channel={channel} />
        ) : null;
      default:
        return null;
    }
  },
  /* eslint-enable solid/components-return-once */

  /**
   * Generate list of categories / entries for channel settings
   * @returns List
   */
  list(channel, onClose) {
    const { openModal } = useModals();
    const client = useClient();

    return {
      context: channel,
      prepend: <BackCard onClose={onClose} />,
      entries: [
        {
          title: <TextWithEmoji content={channel.name} />,
          entries: [
            {
              id: "overview",
              icon: <BiSolidInfoCircle size={20} />,
              title: <Trans>Overview</Trans>,
            },
            {
              hidden:
                channel.type !== "Forum" ||
                !channel.havePermission("ManageChannel"),
              id: "forum",
              icon: <BiRegularListUl size={20} />,
              title: <Trans>Forum</Trans>,
            },
            {
              // Listed only for the types `render` has a page for. A thread
              // (a forum post included) takes its permissions from its parent
              // and has no overrides of its own, so it used to get an entry
              // that opened a blank page.
              hidden:
                !PERMISSION_PAGE_TYPES.includes(channel.type) ||
                !channel.havePermission("ManagePermissions"),
              id: "permissions",
              icon: <BiRegularListUl size={20} />,
              title: <Trans>Permissions</Trans>,
            },
            {
              hidden:
                // forums have no message stream, so no webhooks either
                channel.type === "Forum" ||
                // the server refuses webhooks on protected channels
                client().isProtectedChannel(channel.id) ||
                (!channel.havePermission("ManageWebhooks") &&
                  import.meta.env.DEV),
              id: "webhooks",
              icon: <BiSolidCloud size={20} />,
              title: <Trans>Webhooks</Trans>,
            },
            {
              // Server owner only (product choice 4), invisible while dark.
              hidden: !protectedTabShown(channel, client()),
              id: "protected",
              icon: <Symbol size={20}>verified_user</Symbol>,
              title: settingsCopy.title(),
            },
          ],
        },
        {
          hidden: !(
            channel.type !== "Group" && channel.havePermission("ManageChannel")
          ),
          entries: [
            {
              icon: (
                <BiSolidTrash size={20} color="var(--md-sys-color-error)" />
              ),
              title: (
                <ColouredText colour="var(--md-sys-color-error)">
                  <Switch fallback={<Trans>Delete Channel</Trans>}>
                    <Match when={channelNounOf(channel) === "post"}>
                      <Trans>Delete Post</Trans>
                    </Match>
                    <Match when={channelNounOf(channel) === "thread"}>
                      <Trans>Delete Thread</Trans>
                    </Match>
                  </Switch>
                </ColouredText>
              ),
              onClick() {
                openModal({
                  type: "delete_channel",
                  channel,
                });
              },
            },
          ],
        },
      ],
    };
  },
};

export default Config;

export type ChannelSettingsProps = {
  /**
   * Channel
   */
  channel: Channel;
};

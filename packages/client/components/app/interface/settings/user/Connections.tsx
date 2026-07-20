import { For, JSX, Show, createResource } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import {
  type StreamPlatform,
  type UserConnection,
  beginStreamLink,
  connectionUrl,
  fetchStreamingFlags,
  unlinkStream,
} from "@revolt/client/streamConnections";
import {
  Button,
  CategoryButton,
  Column,
  Text,
  useSnackbar,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Connections settings page — link your Twitch / YouTube channel so it
 * shows on your profile and friends + server members can see when you're
 * live.
 */
export function ConnectionsSettings() {
  const client = useClient();
  const { t } = useLingui();
  const snackbar = useSnackbar();

  // Which platforms the server has linking enabled for
  const [flags, { refetch: _refetchFlags }] = createResource(
    fetchStreamingFlags,
  );

  const connections = () => client().user?.connections ?? [];
  const forPlatform = (platform: StreamPlatform) =>
    connections().find(
      (connection) =>
        connection.platform === (platform === "twitch" ? "Twitch" : "YouTube"),
    );

  async function connect(platform: StreamPlatform) {
    try {
      const url = await beginStreamLink(client(), platform);

      // Webviews (Tauri / Capacitor) can't complete the flow in-place —
      // open the system browser; the link lands account-side and syncs
      // back over WebSocket
      if (window.native || navigator.userAgent.includes("Capacitor")) {
        window.open(url, "_blank");
      } else {
        window.location.assign(url);
      }
    } catch {
      snackbar.show({ message: t`Could not start linking, try again later.` });
    }
  }

  async function disconnect(platform: StreamPlatform) {
    try {
      await unlinkStream(client(), platform);
      snackbar.show({ message: t`Channel unlinked.` });
    } catch {
      snackbar.show({ message: t`Could not unlink the channel, try again.` });
    }
  }

  return (
    <Column gap="lg">
      <Text class="label">
        <Trans>
          Link your streaming channel to show it on your profile. When you go
          live, friends get a notification and members of your servers see a
          LIVE badge next to your name.
        </Trans>
      </Text>

      <PlatformCard
        platform="twitch"
        label="Twitch"
        icon={<Symbol size={22}>videocam</Symbol>}
        enabled={flags()?.twitch ?? false}
        connection={forPlatform("twitch")}
        onConnect={() => connect("twitch")}
        onDisconnect={() => disconnect("twitch")}
      />
      <PlatformCard
        platform="youtube"
        label="YouTube"
        icon={<Symbol size={22}>smart_display</Symbol>}
        enabled={flags()?.youtube ?? false}
        connection={forPlatform("youtube")}
        onConnect={() => connect("youtube")}
        onDisconnect={() => disconnect("youtube")}
      />

      <Show
        when={
          flags.state === "ready" && !flags()?.twitch && !flags()?.youtube
        }
      >
        <Text class="label">
          <Trans>Channel linking is not enabled on this server yet.</Trans>
        </Text>
      </Show>
    </Column>
  );
}

/**
 * One platform's card: connect button when unlinked, channel + live state
 * + disconnect when linked.
 */
function PlatformCard(props: {
  platform: StreamPlatform;
  label: string;
  icon: JSX.Element;
  enabled: boolean;
  connection?: UserConnection;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <Show when={props.enabled || props.connection}>
      <CategoryButton.Group>
        <Show
          when={props.connection}
          fallback={
            <CategoryButton
              icon={props.icon}
              description={
                <Trans>Sign in with your account to link your channel.</Trans>
              }
              action={
                <Show when={props.enabled}>
                  <Button size="sm" onPress={props.onConnect}>
                    <Trans>Connect</Trans>
                  </Button>
                </Show>
              }
            >
              {props.label}
            </CategoryButton>
          }
        >
          {(connection) => (
            <CategoryButton
              icon={props.icon}
              description={
                <>
                  <a
                    href={connectionUrl(connection())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {connection().display_name}
                  </a>
                  <Show when={connection().live}>
                    {" — "}
                    <Trans>LIVE</Trans>
                    <For each={[connection().live_title].filter(Boolean)}>
                      {(title) => <>: {title}</>}
                    </For>
                  </Show>
                </>
              }
              action={
                <Button size="sm" variant="text" onPress={props.onDisconnect}>
                  <Trans>Disconnect</Trans>
                </Button>
              }
            >
              {props.label}
            </CategoryButton>
          )}
        </Show>
      </CategoryButton.Group>
    </Show>
  );
}

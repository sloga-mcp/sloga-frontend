import { createFormControl, createFormGroup } from "solid-forms";
import {
  For,
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { API } from "stoat.js";

import {
  buildDescriptionWithHash,
  hashPassword,
  parseChannelPassword,
} from "../../../../../src/lib/channelPassword";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import {
  Button,
  CircularProgress,
  Column,
  Form2,
  MenuItem,
  Row,
  Text,
} from "@revolt/ui";

import { ChannelSettingsProps } from "../ChannelSettings";

/**
 * Channel overview
 */
export default function ChannelOverview(props: ChannelSettingsProps) {
  const { t } = useLingui();
  const client = useClient();
  const { openModal } = useModals();

  const canManageChannel = () => props.channel.havePermission("ManageChannel");

  const [announcementSaving, setAnnouncementSaving] = createSignal(false);

  /** Toggle this text channel's announcement-channel flag. */
  async function toggleAnnouncement() {
    setAnnouncementSaving(true);
    try {
      await props.channel.edit({
        // stoat-api predates `announcement` — pass it through verbatim.
        announcement: !props.channel.isAnnouncement,
      } as never);
    } finally {
      setAnnouncementSaving(false);
    }
  }

  // Follower list (source-side): refetched on the source-topic
  // channelFollowersUpdate signal and on any follow deletion.
  const [followers, { refetch: refetchFollowers }] = createResource(
    () => props.channel.id,
    () => props.channel.fetchFollowers(),
  );

  onMount(() => {
    const onUpdate = (channelId: string) => {
      if (channelId === props.channel.id) refetchFollowers();
    };
    const onDelete = (ref: { sourceChannel: string }) => {
      if (ref.sourceChannel === props.channel.id) refetchFollowers();
    };
    client().on("channelFollowersUpdate", onUpdate);
    client().on("channelFollowCreate", refetchFollowers);
    client().on("channelFollowDelete", onDelete);
    onCleanup(() => {
      client().off("channelFollowersUpdate", onUpdate);
      client().off("channelFollowCreate", refetchFollowers);
      client().off("channelFollowDelete", onDelete);
    });
  });

  /** Sever a follow from the source side, then refresh the list. */
  async function unfollow(followId: string) {
    await props.channel.unfollow(followId);
    refetchFollowers();
  }

  /** Human label for a follower row's target (resolved when visible). */
  function followerLabel(follow: {
    target_server: string;
    target_channel: string;
  }): string {
    const server = client().servers.get(follow.target_server);
    const channel = client().channels.get(follow.target_channel);
    if (server && channel) {
      return `${server.name} • #${channel.name ?? channel.id}`;
    }
    return t`Another server`;
  }

  const { cleanDescription, passwordHash: existingHash } =
    parseChannelPassword(props.channel.description);

  const [pwInput, setPwInput] = createSignal("");
  const [pwSaving, setPwSaving] = createSignal(false);
  const [pwStatus, setPwStatus] = createSignal<"idle" | "saved" | "removed">("idle");

  async function setChannelPassword() {
    const pw = pwInput().trim();
    setPwSaving(true);
    const hash = pw ? await hashPassword(pw) : null;
    const newDesc = hash
      ? buildDescriptionWithHash(cleanDescription, hash)
      : cleanDescription;
    await props.channel.edit({ description: newDesc || undefined, remove: newDesc ? [] : ["Description"] });
    setPwInput("");
    setPwStatus(pw ? "saved" : "removed");
    setPwSaving(false);
    setTimeout(() => setPwStatus("idle"), 2500);
  }

  /* eslint-disable solid/reactivity */
  // we want to take the initial value only
  const editGroup = createFormGroup({
    name: createFormControl(props.channel.name),
    description: createFormControl(cleanDescription),
    icon: createFormControl<string | File[] | null>(
      props.channel.animatedIconURL,
    ),
    slowmode: createFormControl<string>(
      props.channel.slowmode.toString() ?? "0",
    ),
  });
  /* eslint-enable solid/reactivity */

  function onReset() {
    editGroup.controls.name.setValue(props.channel.name);
    editGroup.controls.description.setValue(props.channel.description || "");
    editGroup.controls.icon.setValue(props.channel.animatedIconURL ?? null);
    editGroup.controls.slowmode.setValue(
      props.channel.slowmode.toString() ?? "0",
    );
  }

  async function onSubmit() {
    const changes: API.DataEditChannel = {
      remove: [],
    };

    if (editGroup.controls.name.isDirty) {
      changes.name = editGroup.controls.name.value.trim();
    }

    if (editGroup.controls.description.isDirty) {
      const description = editGroup.controls.description.value.trim();
      const { passwordHash: currentHash } = parseChannelPassword(
        props.channel.description,
      );

      if (description || currentHash) {
        changes.description = currentHash
          ? buildDescriptionWithHash(description, currentHash)
          : description;
      } else {
        changes.remove!.push("Description");
      }
    }

    if (editGroup.controls.icon.isDirty) {
      if (!editGroup.controls.icon.value) {
        changes.remove!.push("Icon");
      } else if (Array.isArray(editGroup.controls.icon.value)) {
        const body = new FormData();
        body.append("file", editGroup.controls.icon.value[0]);

        const [key, value] = client().authenticationHeader;
        const data: { id: string } = await fetch(
          `${CONFIGURATION.DEFAULT_MEDIA_URL}/icons`,
          {
            method: "POST",
            body,
            headers: {
              [key]: value,
            },
          },
        ).then((res) => res.json());

        changes.icon = data.id;
      }
    }

    if (editGroup.controls.slowmode.isDirty) {
      changes.slowmode = Number(editGroup.controls.slowmode.value);
    }

    await props.channel.edit(changes);
  }

  const submit = Form2.useSubmitHandler(editGroup, onSubmit, onReset);

  return (
    <Column gap="xl">
      <form onSubmit={submit}>
        <Column>
          <Text class="label">
            <Trans>Channel Info</Trans>
          </Text>
          <Form2.FileInput control={editGroup.controls.icon} accept="image/*" />
          <Form2.TextField
            minlength={1}
            maxlength={32}
            counter
            name="name"
            control={editGroup.controls.name}
            label={t`Channel Name`}
          />
          <Form2.TextField
            autosize
            min-rows={2}
            maxlength={1024}
            counter
            name="description"
            control={editGroup.controls.description}
            label={t`Channel Description`}
            placeholder={t`This channel is about...`}
          />
          <Show when={props.channel.type === "TextChannel"}>
            <Form2.Select
              label={t`Channel Slowmode`}
              control={editGroup.controls.slowmode}
            >
              <MenuItem value="0">
                <Trans>Slowmode off</Trans>
              </MenuItem>
              <MenuItem value="5">
                <Trans>5 seconds</Trans>
              </MenuItem>
              <MenuItem value="10">
                <Trans>10 seconds</Trans>
              </MenuItem>
              <MenuItem value="30">
                <Trans>30 seconds</Trans>
              </MenuItem>
              <MenuItem value="60">
                <Trans>1 minute</Trans>
              </MenuItem>
              <MenuItem value="300">
                <Trans>5 minutes</Trans>
              </MenuItem>
              <MenuItem value="600">
                <Trans>10 minutes</Trans>
              </MenuItem>
              <MenuItem value="1800">
                <Trans>30 minutes</Trans>
              </MenuItem>
              <MenuItem value="3600">
                <Trans>1 hour</Trans>
              </MenuItem>
              <MenuItem value="7200">
                <Trans>2 hours</Trans>
              </MenuItem>
              <MenuItem value="21600">
                <Trans>6 hours</Trans>
              </MenuItem>
            </Form2.Select>
          </Show>
          <Row>
            <Form2.Reset group={editGroup} onReset={onReset} />
            <Form2.Submit group={editGroup} requireDirty>
              <Trans>Save</Trans>
            </Form2.Submit>
            <Show when={editGroup.isPending}>
              <CircularProgress />
            </Show>
          </Row>
        </Column>
      </form>
      <Column>
        <Text class="label">
          <Trans>Channel Password</Trans>
        </Text>
        <Text>
          <Show when={existingHash} fallback={
            <Trans>Set a password that users must enter before viewing this channel.</Trans>
          }>
            <Trans>This channel is currently password protected.</Trans>
          </Show>
        </Text>
        <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
          <input
            type="password"
            placeholder={existingHash ? "New password (leave blank to remove)" : "Set password..."}
            value={pwInput()}
            onInput={(e) => setPwInput(e.currentTarget.value)}
            style={{
              padding: "8px 12px",
              "border-radius": "8px",
              border: "1.5px solid var(--md-sys-color-outline)",
              background: "var(--md-sys-color-surface-container)",
              color: "var(--md-sys-color-on-surface)",
              "font-size": "0.9rem",
              width: "220px",
              outline: "none",
            }}
          />
          <Button
            onPress={setChannelPassword}
            isDisabled={pwSaving() || (!pwInput().trim() && !existingHash)}
          >
            <Switch fallback={<Trans>{existingHash ? "Update Password" : "Set Password"}</Trans>}>
              <Match when={pwSaving()}><Trans>Saving...</Trans></Match>
              <Match when={pwStatus() === "saved"}><Trans>Password set!</Trans></Match>
              <Match when={pwStatus() === "removed"}><Trans>Password removed!</Trans></Match>
            </Switch>
          </Button>
          <Show when={existingHash}>
            <Button
              onPress={() => { setPwInput(""); setChannelPassword(); }}
              isDisabled={pwSaving()}
            >
              <Trans>Remove Password</Trans>
            </Button>
          </Show>
        </div>
      </Column>

      <Show when={props.channel.type === "TextChannel" && canManageChannel()}>
        <Column>
          <Text class="label">
            <Trans>Announcement Channel</Trans>
          </Text>
          <Text>
            <Trans>
              Announcement channels can be followed by other servers, and
              their messages published into those servers' channels.
            </Trans>
          </Text>
          <div>
            <Button
              onPress={toggleAnnouncement}
              isDisabled={announcementSaving()}
            >
              <Switch
                fallback={<Trans>Make Announcement Channel</Trans>}
              >
                <Match when={props.channel.isAnnouncement}>
                  <Trans>Stop being an Announcement Channel</Trans>
                </Match>
              </Switch>
            </Button>
          </div>
        </Column>
      </Show>

      <Show when={props.channel.isAnnouncement && canManageChannel()}>
        <Column>
          <Text class="label">
            <Trans>Followers</Trans>
          </Text>
          <Text>
            <Trans>
              Channels in other servers that receive this channel's published
              messages.
            </Trans>
          </Text>
          <Switch
            fallback={
              <Text>
                <Trans>No channels are following yet.</Trans>
              </Text>
            }
          >
            <Match when={followers.loading}>
              <CircularProgress />
            </Match>
            <Match when={followers()?.length}>
              <Column gap="sm">
                <For each={followers()}>
                  {(follow) => (
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "space-between",
                        gap: "8px",
                      }}
                    >
                      <Text>{followerLabel(follow)}</Text>
                      <Button onPress={() => unfollow(follow._id)}>
                        <Trans>Remove</Trans>
                      </Button>
                    </div>
                  )}
                </For>
              </Column>
            </Match>
          </Switch>
        </Column>
      </Show>

      <Column>
        <Text class="label">
          <Trans>Mark as Mature</Trans>
        </Text>
        <Text>
          <Trans>
            Users will be asked to confirm their age before opening this
            channel.
          </Trans>
        </Text>
        <div>
          <Button
            onPress={() =>
              openModal({
                type: "channel_toggle_mature",
                channel: props.channel,
              })
            }
          >
            <Switch fallback={<Trans>Mark as Mature</Trans>}>
              <Match when={props.channel.mature}>
                <Trans>Unmark as Mature</Trans>
              </Match>
            </Switch>
          </Button>
        </div>
      </Column>
    </Column>
  );
}

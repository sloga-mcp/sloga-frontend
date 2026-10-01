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

import { channelHasClientGate } from "../../../../../src/interface/channels/memberGate";
import {
  afkDesignationEdit,
  afkTimeoutChoice,
  afkTimeoutEdit,
  parseAfkTimeoutChoice,
} from "../../../../../src/lib/afkChannelSettings";
import {
  buildDescriptionWithHash,
  hashPassword,
  parseChannelPassword,
} from "../../../../../src/lib/channelPassword";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { channelNounOf } from "@revolt/common/lib/channelNoun";
import { useModals } from "@revolt/modal";
import { isAfkChannel } from "@revolt/rtc/afkPolicy";
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
  const { openModal, showError } = useModals();

  const canManageChannel = () => props.channel.havePermission("ManageChannel");

  /** What this channel is called in the labels below: post, thread or channel. */
  const noun = () => channelNounOf(props.channel);

  /**
   * Threads (forum posts included) do not get their own password or mature
   * check: once the parent is loaded, both resolve to the parent channel
   * (`gateSource` in `channelGates.ts`), so the controls would do nothing here.
   */
  const isThread = () => props.channel.type === "Thread";

  /**
   * 🔴 The AFK gate is ManageServer, NOT `canManageChannel()`.
   *
   * The designation lives on the SERVER (`Server.afk_channel_id`) even though
   * this UI sits in channel settings, and the routes that write it require
   * ManageServer. Gating on ManageChannel would show the toggle to a moderator
   * who holds only that bit; they would press it and take a 403 from a route
   * they were never allowed to call.
   */
  const canManageServer = () =>
    !!props.channel.serverId &&
    !!props.channel.server?.havePermission("ManageServer");

  /**
   * Whether to offer the AFK section at all.
   *
   * 🔴 `isVoice && serverId`, not `type === "TextChannel"`. The gate used by
   * the announcement, spoiler and slowmode sections above is the latter, which
   * is why those three already render on voice channels — a real bug, out of
   * scope here. `isVoice` on its own is also true for DMs and group DMs, which
   * have no server to designate anything on, hence the `serverId` term.
   */
  const canConfigureAfk = () =>
    props.channel.isVoice && !!props.channel.serverId && canManageServer();

  /** Whether this channel is the one the server currently points at. */
  const isDesignatedAfk = () =>
    isAfkChannel(props.channel.server?.afkChannelId, props.channel.id);

  /**
   * 🔴 The AFK channel can't be behind an age, password or spoiler check. The
   * idle sweep moves members into it without asking, including members who
   * never passed the check. The backend refuses both directions: designating
   * a checked channel answers `InvalidProperty`, and an edit that turns a
   * check ON for the designated channel answers `InvalidOperation`, for the
   * owner too. These mirror it so the controls say why instead of failing.
   * Turning a check OFF is always allowed.
   *
   * `channelHasClientGate` mirrors the backend's `Channel::has_client_gate`.
   */
  const gateBlocksAfk = () =>
    !isDesignatedAfk() && channelHasClientGate(props.channel);

  /**
   * Whether the control that turns one check ON is refused. Asked per check,
   * so a check that is on can always be turned off. The backend refuses only
   * an edit that takes the channel from no check at all to some check, so on
   * an AFK channel that already carries one (reachable only through a race
   * between two admins) this refuses a second check the server would allow.
   * That is the fail-closed side.
   */
  const afkBlocksGate = (gateIsOn: boolean) => isDesignatedAfk() && !gateIsOn;

  /* eslint-disable solid/reactivity */
  // Initial value only. Seeded from the timeout the SERVER already holds, not
  // from a constant: designating a channel without naming a timeout makes the
  // backend keep the existing one, which may have been chosen for a different
  // channel. The toggle sends this value back explicitly, so the timeout that
  // gets adopted is the timeout the user could see. A server with no timeout
  // seeds "never", not five minutes: nobody is moved on such a server, and
  // the select must not say otherwise.
  const afkTimeoutControl = createFormControl<string>(
    String(afkTimeoutChoice(props.channel.server?.afkTimeout)),
  );
  /* eslint-enable solid/reactivity */

  const [afkSaving, setAfkSaving] = createSignal(false);
  const [afkFailed, setAfkFailed] = createSignal(false);

  /**
   * Designate this voice channel as the server's AFK channel, or clear the
   * designation.
   *
   * 🔴 This is `server.edit(...)`, not `channel.edit(...)`. The channel route
   * does not carry these fields and would drop them without complaining.
   *
   * 🔴 Clearing goes through `remove: ["AfkChannel"]`, built by the tested
   * mapper. A clear written as `afk_channel_id: null` is answered with a 200
   * and changes nothing, which is indistinguishable from success here.
   *
   * 🔴 Unlike the announcement and calls toggles in this file, this one
   * catches. Those are `try { … } finally { setSaving(false) }` with no
   * error path, so a refused edit flips the label back and says nothing at
   * all. That is not safe to copy onto a route whose whole point is that a
   * permission refusal is possible.
   */
  async function toggleAfkChannel() {
    const server = props.channel.server;
    if (!server) return;

    // 🔴 Parsed, never `Number(...)`: "never" is NaN as a number and would be
    // saved as the five-minute fallback. The select cannot hold anything the
    // parser refuses, so `undefined` is refused here rather than guessed.
    const timeout = parseAfkTimeoutChoice(afkTimeoutControl.value);
    if (timeout === undefined) {
      setAfkFailed(true);
      return;
    }

    setAfkSaving(true);
    setAfkFailed(false);
    try {
      await server.edit(
        afkDesignationEdit({
          designate: !isDesignatedAfk(),
          channelId: props.channel.id,
          timeout,
        }) as never,
      );
      afkTimeoutControl.markDirty(false);
    } catch (error) {
      setAfkFailed(true);
      showError(error);
    } finally {
      setAfkSaving(false);
    }
  }

  /**
   * Save a changed idle timeout for a channel that is already designated.
   *
   * The mapper returns `undefined` for every request the backend would refuse
   * — no channel designated, a different channel designated, or a value
   * outside the presets — and the button is only offered when it will not.
   * "Never" saves as a removal of the timeout; the designation stays.
   */
  async function saveAfkTimeout() {
    const server = props.channel.server;
    const timeout = parseAfkTimeoutChoice(afkTimeoutControl.value);
    const payload =
      timeout === undefined
        ? undefined
        : afkTimeoutEdit({
            afkChannelId: server?.afkChannelId,
            channelId: props.channel.id,
            timeout,
          });
    if (!server || !payload) return;

    setAfkSaving(true);
    setAfkFailed(false);
    try {
      await server.edit(payload as never);
      afkTimeoutControl.markDirty(false);
    } catch (error) {
      setAfkFailed(true);
      showError(error);
    } finally {
      setAfkSaving(false);
    }
  }

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

  const [spoilerSaving, setSpoilerSaving] = createSignal(false);
  const [spoilerFailed, setSpoilerFailed] = createSignal(false);

  /**
   * Toggle this channel's click-to-reveal spoiler flag. Catches, like the AFK
   * toggle: marking the AFK channel as a spoiler is refused by the backend,
   * and a refusal must not look like nothing happened.
   */
  async function toggleSpoiler() {
    setSpoilerSaving(true);
    setSpoilerFailed(false);
    try {
      await props.channel.edit({
        // stoat-api predates `spoiler` — pass it through verbatim.
        spoiler: !props.channel.isSpoiler,
      } as never);
    } catch (error) {
      setSpoilerFailed(true);
      showError(error);
    } finally {
      setSpoilerSaving(false);
    }
  }

  const [callsSaving, setCallsSaving] = createSignal(false);

  /**
   * Turn this group's voice and video calling on or off. Group calling is on
   * by default server-side, and every group carries a `voice` object; calling
   * is off only while it holds `disabled: true`. This replaces the whole
   * object, so a saved `max_users` is not kept. stoat-api predates the field,
   * so the payload passes through verbatim. `isVoice` reads the server's
   * answer back after the update.
   */
  async function toggleCalls() {
    setCallsSaving(true);
    try {
      await props.channel.edit({
        voice: { disabled: props.channel.isVoice },
      } as never);
    } finally {
      setCallsSaving(false);
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

  const { cleanDescription, passwordHash: existingHash } = parseChannelPassword(
    props.channel.description,
  );

  const [pwInput, setPwInput] = createSignal("");
  const [pwSaving, setPwSaving] = createSignal(false);
  const [pwStatus, setPwStatus] = createSignal<"idle" | "saved" | "removed">(
    "idle",
  );
  const [pwFailed, setPwFailed] = createSignal(false);

  /**
   * Whether the channel has a password now. Read live for the AFK rule;
   * `existingHash` above is taken once, when the page opens.
   */
  const hasPassword = () =>
    !!parseChannelPassword(props.channel.description).passwordHash;

  /**
   * Set, change or remove the channel password. Catches, and clears the
   * saving flag in `finally`: setting a password on the AFK channel is
   * refused by the backend, and without both a refusal was invisible and
   * left the buttons disabled for good. The typed password is kept on a
   * failure so the user can try again.
   */
  async function setChannelPassword() {
    const pw = pwInput().trim();
    setPwSaving(true);
    setPwFailed(false);
    try {
      const hash = pw ? await hashPassword(pw) : null;
      const newDesc = hash
        ? buildDescriptionWithHash(cleanDescription, hash)
        : cleanDescription;
      await props.channel.edit({
        description: newDesc || undefined,
        remove: newDesc ? [] : ["Description"],
      });
      setPwInput("");
      setPwStatus(pw ? "saved" : "removed");
      setTimeout(() => setPwStatus("idle"), 2500);
    } catch (error) {
      setPwFailed(true);
      showError(error);
    } finally {
      setPwSaving(false);
    }
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
            <Switch fallback={<Trans>Channel Info</Trans>}>
              <Match when={noun() === "post"}>
                <Trans>Post Info</Trans>
              </Match>
              <Match when={noun() === "thread"}>
                <Trans>Thread Info</Trans>
              </Match>
            </Switch>
          </Text>
          <Form2.FileInput control={editGroup.controls.icon} accept="image/*" />
          <Form2.TextField
            minlength={1}
            maxlength={32}
            counter
            name="name"
            control={editGroup.controls.name}
            label={
              noun() === "post"
                ? t`Title`
                : noun() === "thread"
                  ? t`Thread Name`
                  : t`Channel Name`
            }
          />
          <Form2.TextField
            autosize
            min-rows={2}
            maxlength={1024}
            counter
            name="description"
            control={editGroup.controls.description}
            label={
              noun() === "post"
                ? t`Post Description`
                : noun() === "thread"
                  ? t`Thread Description`
                  : t`Channel Description`
            }
            placeholder={
              noun() === "post"
                ? t`This post is about...`
                : noun() === "thread"
                  ? t`This thread is about...`
                  : t`This channel is about...`
            }
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
      <Show when={!isThread()}>
        <Column>
          <Text class="label">
            <Trans>Channel Password</Trans>
          </Text>
          <Text>
            <Show
              when={existingHash}
              fallback={
                <Trans>
                  Set a password that users must enter before viewing this
                  channel.
                </Trans>
              }
            >
              <Trans>This channel is currently password protected.</Trans>
            </Show>
          </Text>
          <div
            style={{
              display: "flex",
              gap: "8px",
              "align-items": "center",
              "flex-wrap": "wrap",
            }}
          >
            <input
              type="password"
              placeholder={
                existingHash
                  ? "New password (leave blank to remove)"
                  : "Set password..."
              }
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
              isDisabled={
                pwSaving() ||
                (!pwInput().trim() && !existingHash) ||
                (!!pwInput().trim() && afkBlocksGate(hasPassword()))
              }
            >
              <Switch
                fallback={
                  <Trans>
                    {existingHash ? "Update Password" : "Set Password"}
                  </Trans>
                }
              >
                <Match when={pwSaving()}>
                  <Trans>Saving...</Trans>
                </Match>
                <Match when={pwStatus() === "saved"}>
                  <Trans>Password set!</Trans>
                </Match>
                <Match when={pwStatus() === "removed"}>
                  <Trans>Password removed!</Trans>
                </Match>
              </Switch>
            </Button>
            <Show when={existingHash}>
              <Button
                onPress={() => {
                  setPwInput("");
                  setChannelPassword();
                }}
                isDisabled={pwSaving()}
              >
                <Trans>Remove Password</Trans>
              </Button>
            </Show>
          </div>
          <Show when={afkBlocksGate(hasPassword())}>
            <Text>
              <Trans>
                This is the server's AFK channel, so it can't have an age,
                password or spoiler check. Choose another AFK channel first.
              </Trans>
            </Text>
          </Show>
          <Show when={pwFailed()}>
            <Text>
              <Trans>That change was not saved.</Trans>
            </Text>
          </Show>
        </Column>
      </Show>

      <Show when={props.channel.type === "TextChannel" && canManageChannel()}>
        <Column>
          <Text class="label">
            <Trans>Announcement Channel</Trans>
          </Text>
          <Text>
            <Trans>
              Announcement channels can be followed by other servers, and their
              messages published into those servers' channels.
            </Trans>
          </Text>
          <div>
            <Button
              onPress={toggleAnnouncement}
              isDisabled={announcementSaving()}
            >
              <Switch fallback={<Trans>Make Announcement Channel</Trans>}>
                <Match when={props.channel.isAnnouncement}>
                  <Trans>Stop being an Announcement Channel</Trans>
                </Match>
              </Switch>
            </Button>
          </div>
        </Column>
      </Show>

      <Show when={props.channel.type === "TextChannel" && canManageChannel()}>
        <Column>
          <Text class="label">
            <Trans>Spoiler Channel</Trans>
          </Text>
          <Text>
            <Trans>
              Members must choose to reveal a spoiler channel before its
              contents are shown, without marking the channel as mature.
            </Trans>
          </Text>
          <div>
            <Button
              onPress={toggleSpoiler}
              isDisabled={
                spoilerSaving() || afkBlocksGate(props.channel.isSpoiler)
              }
            >
              <Switch fallback={<Trans>Mark as Spoiler</Trans>}>
                <Match when={props.channel.isSpoiler}>
                  <Trans>Remove Spoiler Mark</Trans>
                </Match>
              </Switch>
            </Button>
          </div>
          <Show when={afkBlocksGate(props.channel.isSpoiler)}>
            <Text>
              <Trans>
                This is the server's AFK channel, so it can't have an age,
                password or spoiler check. Choose another AFK channel first.
              </Trans>
            </Text>
          </Show>
          <Show when={spoilerFailed()}>
            <Text>
              <Trans>That change was not saved.</Trans>
            </Text>
          </Show>
        </Column>
      </Show>

      <Show when={props.channel.type === "Group" && canManageChannel()}>
        <Column>
          <Text class="label">
            <Trans>Voice and Video Calls</Trans>
          </Text>
          <Text>
            <Trans>
              Group calls are on by default. Turn them off to stop anyone from
              starting or joining voice and video calls here.
            </Trans>
          </Text>
          <div>
            <Button onPress={toggleCalls} isDisabled={callsSaving()}>
              <Switch fallback={<Trans>Turn on calls</Trans>}>
                <Match when={props.channel.isVoice}>
                  <Trans>Turn off calls</Trans>
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

      <Show when={!isThread()}>
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
              isDisabled={afkBlocksGate(props.channel.mature)}
            >
              <Switch fallback={<Trans>Mark as Mature</Trans>}>
                <Match when={props.channel.mature}>
                  <Trans>Unmark as Mature</Trans>
                </Match>
              </Switch>
            </Button>
          </div>
          <Show when={afkBlocksGate(props.channel.mature)}>
            <Text>
              <Trans>
                This is the server's AFK channel, so it can't have an age,
                password or spoiler check. Choose another AFK channel first.
              </Trans>
            </Text>
          </Show>
        </Column>
      </Show>

      <Show when={canConfigureAfk()}>
        <Column>
          <Text class="label">
            <Trans>AFK Channel</Trans>
          </Text>
          <Text>
            <Trans>
              Nobody can speak, share video or share their screen in the AFK
              channel, including you. A server has one AFK channel, so making
              this one replaces any previous choice.
            </Trans>
          </Text>

          {/* AFK_TIMEOUT_PRESETS contract: the five numeric options are pinned
              to AFK_TIMEOUT_PRESETS by src/lib/afkChannelSettings.test.ts,
              which fails if they drift, and the one "never" option is pinned
              to AFK_TIMEOUT_NEVER by the same file. Written out rather than
              generated from the list because each needs its own lingui
              message, and because the slowmode select above — the select this
              copies — is written the same way. The backend rejects any number
              outside the five; it does not clamp. "Never" is the server
              holding no timeout at all, and is saved as a removal. */}
          <Form2.Select
            label={t`Move idle members here after`}
            control={afkTimeoutControl}
          >
            <MenuItem value="never">
              <Trans>Never</Trans>
            </MenuItem>
            <MenuItem value="60">
              <Trans>1 minute</Trans>
            </MenuItem>
            <MenuItem value="300">
              <Trans>5 minutes</Trans>
            </MenuItem>
            <MenuItem value="900">
              <Trans>15 minutes</Trans>
            </MenuItem>
            <MenuItem value="1800">
              <Trans>30 minutes</Trans>
            </MenuItem>
            <MenuItem value="3600">
              <Trans>1 hour</Trans>
            </MenuItem>
          </Form2.Select>

          <Show when={!isDesignatedAfk()}>
            <Text>
              <Trans>
                This is the idle timeout that will be used once this channel is
                the AFK channel. It starts from whatever this server already
                has.
              </Trans>
            </Text>
          </Show>

          <Row>
            <Button
              onPress={toggleAfkChannel}
              isDisabled={afkSaving() || gateBlocksAfk()}
            >
              <Switch fallback={<Trans>Make AFK Channel</Trans>}>
                <Match when={isDesignatedAfk()}>
                  <Trans>Stop being the AFK Channel</Trans>
                </Match>
              </Switch>
            </Button>
            <Show when={isDesignatedAfk()}>
              <Button
                onPress={saveAfkTimeout}
                isDisabled={afkSaving() || !afkTimeoutControl.isDirty}
              >
                <Trans>Save idle timeout</Trans>
              </Button>
            </Show>
            <Show when={afkSaving()}>
              <CircularProgress />
            </Show>
          </Row>

          <Show when={gateBlocksAfk()}>
            <Text>
              <Trans>
                A channel with an age, password or spoiler check can't be the
                AFK channel. Remove the check first.
              </Trans>
            </Text>
          </Show>

          <Show when={afkFailed()}>
            <Text>
              {/* Deliberately does not guess WHY. The real error is shown in
                  the modal that `showError` opens; naming a cause here would
                  be wrong for a network failure or a validation refusal. */}
              <Trans>That change was not saved.</Trans>
            </Text>
          </Show>
        </Column>
      </Show>
    </Column>
  );
}

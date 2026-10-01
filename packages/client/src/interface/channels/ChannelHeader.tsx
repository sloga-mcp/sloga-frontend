import { Accessor, createMemo, Match, Setter, Show, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useDevice } from "@revolt/common";
import { channelNounOf } from "@revolt/common/lib/channelNoun";
import { TextWithEmoji } from "@revolt/markdown";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import {
  Button,
  IconButton,
  isSlogaStaff,
  NonBreakingText,
  OverflowingText,
  Spacer,
  typography,
  UserStatus,
} from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { parseChannelPassword } from "../../lib/channelPassword";

import MdGroup from "@material-design-icons/svg/outlined/group.svg?component-solid";
import MdPersonAdd from "@material-design-icons/svg/outlined/person_add.svg?component-solid";
import MdSettings from "@material-design-icons/svg/outlined/settings.svg?component-solid";

import MdKeep from "../../svg/keep.svg?component-solid";
import { HeaderIcon } from "../common/CommonHeader";

import { canIHasSidebar, SidebarState } from "./text/TextChannel";

interface Props {
  /**
   * Channel to render header for
   */
  channel: Channel;

  /**
   * Sidebar state
   */
  sidebarState?: Accessor<SidebarState>;

  /**
   * Set sidebar state
   */
  setSidebarState?: Setter<SidebarState>;
}

/**
 * Common channel header component
 */
export function ChannelHeader(props: Props) {
  const { openModal } = useModals();
  const client = useClient();
  const { t } = useLingui();
  const cleanDescription = createMemo(
    () => parseChannelPassword(props.channel.description).cleanDescription,
  );
  const state = useState();
  const voice = useVoice();
  const { layout } = useDevice();

  // Tags on a forum post can be changed after posting by its author or by
  // anyone who manages the forum (the same rule delta's channel edit
  // applies); until this button there was no way to reach that.
  const canEditPostTags = () => {
    const forum = props.channel.isForumPost ? props.channel.parent : undefined;
    if (!forum?.tags.length) return false;

    return (
      props.channel.creatorId === client().user?.id ||
      forum.havePermission("ManageChannel")
    );
  };

  const searchValue = () => {
    if (!props.sidebarState) return null;

    const state = props.sidebarState();
    if (state.state === "search") return state.query;
    return "";
  };

  return (
    <>
      <Switch>
        <Match
          when={
            props.channel.type === "TextChannel" ||
            props.channel.type === "Group"
          }
        >
          <HeaderIcon>
            <Symbol>grid_3x3</Symbol>
          </HeaderIcon>
          <NonBreakingText
            class={
              typography({ class: "title", size: "medium" }) +
              " " +
              mobileOverflow
            }
            onClick={() =>
              openModal({
                type: "channel_info",
                channel: props.channel,
              })
            }
          >
            <TextWithEmoji content={props.channel.name!} />
          </NonBreakingText>
          <Show when={layout() !== "phone" && cleanDescription()}>
            <Divider />
            <a
              class={descriptionLink}
              onClick={() =>
                openModal({
                  type: "channel_info",
                  channel: props.channel,
                })
              }
              use:floating={{
                tooltip: {
                  placement: "bottom",
                  content: t`Click to show full description`,
                },
              }}
            >
              <OverflowingText
                class={typography({ class: "title", size: "small" })}
              >
                <TextWithEmoji
                  content={cleanDescription().split("\n").shift()}
                />
              </OverflowingText>
            </a>
          </Show>
        </Match>
        <Match when={props.channel.type === "DirectMessage"}>
          <HeaderIcon>
            <Symbol>alternate_email</Symbol>
          </HeaderIcon>
          <OverflowingText>
            <DisplayName
              user={props.channel.recipient}
              name={props.channel.recipient?.username ?? ""}
              brand={isSlogaStaff(props.channel.recipient)}
            />
          </OverflowingText>
          <UserStatus status={props.channel.recipient?.presence} size="8px" />
        </Match>
        <Match when={props.channel.type === "SavedMessages"}>
          <HeaderIcon>
            <Symbol>note_stack</Symbol>
          </HeaderIcon>
          <Trans>Saved Notes</Trans>
        </Match>
        <Match when={props.channel.type === "Thread"}>
          <HeaderIcon>
            <Symbol>forum</Symbol>
          </HeaderIcon>
          <NonBreakingText
            class={
              typography({ class: "title", size: "medium" }) +
              " " +
              mobileOverflow
            }
          >
            <TextWithEmoji content={props.channel.name!} />
          </NonBreakingText>
        </Match>
        <Match when={props.channel.type === "Forum"}>
          <HeaderIcon>
            <Symbol>forum</Symbol>
          </HeaderIcon>
          <NonBreakingText
            class={
              typography({ class: "title", size: "medium" }) +
              " " +
              mobileOverflow
            }
            onClick={() =>
              openModal({
                type: "channel_info",
                channel: props.channel,
              })
            }
          >
            <TextWithEmoji content={props.channel.name!} />
          </NonBreakingText>
          <Show when={layout() !== "phone" && cleanDescription()}>
            <Divider />
            <a
              class={descriptionLink}
              onClick={() =>
                openModal({
                  type: "channel_info",
                  channel: props.channel,
                })
              }
              use:floating={{
                tooltip: {
                  placement: "bottom",
                  content: t`Click to show full description`,
                },
              }}
            >
              <OverflowingText
                class={typography({ class: "title", size: "small" })}
              >
                <TextWithEmoji
                  content={cleanDescription().split("\n").shift()}
                />
              </OverflowingText>
            </a>
          </Show>
        </Match>
      </Switch>

      <Show when={canEditPostTags()}>
        <IconButton
          onPress={() =>
            openModal({
              type: "edit_forum_post_tags",
              post: props.channel,
            })
          }
          use:floating={{
            tooltip: {
              placement: "bottom",
              content: t`Edit tags`,
            },
          }}
        >
          <Symbol>sell</Symbol>
        </IconButton>
      </Show>

      <Show when={props.channel.isAnnouncement}>
        <IconButton
          onPress={() =>
            openModal({
              type: "follow_channel",
              channel: props.channel,
            })
          }
          use:floating={{
            tooltip: {
              placement: "bottom",
              content: t`Follow this announcement channel`,
            },
          }}
        >
          <Symbol>campaign</Symbol>
        </IconButton>
      </Show>

      {/* Inert while a join is in flight or after a terminal refusal for
          this channel (joinRefusalPolicy): these buttons re-render the
          instant a failed attempt ends, which is how one refusal became
          dozens of attempts on 2026-09-06. The tooltip carries the refusal
          so the disabled state explains itself. */}
      <Show when={props.channel.isVoice && !voice.showCard(props.channel)}>
        <IconButton
          isDisabled={!!voice.joinBlocked(props.channel)}
          onPress={() => voice.connect(props.channel)}
          use:floating={{
            tooltip: {
              placement: "bottom",
              content:
                voice.joinRefusalMessage(props.channel) ??
                t`Join the voice channel`,
            },
          }}
        >
          <Symbol>call</Symbol>
        </IconButton>
        <IconButton
          isDisabled={!!voice.joinBlocked(props.channel)}
          onPress={async () => {
            if (await voice.connect(props.channel)) await voice.toggleCamera();
          }}
          use:floating={{
            tooltip: {
              placement: "bottom",
              content:
                voice.joinRefusalMessage(props.channel) ??
                t`Start a video call`,
            },
          }}
        >
          <Symbol>videocam</Symbol>
        </IconButton>
      </Show>

      <Show
        when={
          (props.channel.type === "Group" || props.channel.serverId) &&
          props.channel.orPermission("ManageChannel", "ManagePermissions")
        }
      >
        <IconButton
          onPress={() =>
            openModal({
              type: "settings",
              config: "channel",
              context: props.channel,
            })
          }
          use:floating={{
            tooltip: {
              placement: "bottom",
              // one literal per noun; the accessor is read on hover
              content:
                channelNounOf(props.channel) === "post"
                  ? t`Post Settings`
                  : channelNounOf(props.channel) === "thread"
                    ? t`Thread Settings`
                    : t`Channel Settings`,
            },
          }}
        >
          <MdSettings />
        </IconButton>
      </Show>

      <Show when={props.channel.type === "Group"}>
        <Button
          variant="text"
          size="icon"
          onPress={() =>
            openModal({
              type: "add_members_to_group",
              group: props.channel,
              client: client(),
            })
          }
          use:floating={{
            tooltip: {
              placement: "bottom",
              content: t`Add friends to group`,
            },
          }}
        >
          <MdPersonAdd />
        </Button>
      </Show>

      <Show when={props.sidebarState && props.channel.type === "TextChannel"}>
        <IconButton
          use:floating={{
            tooltip: {
              placement: "bottom",
              content: t`View threads`,
            },
          }}
          onPress={() =>
            props.sidebarState!().state === "threads_list"
              ? props.setSidebarState!({
                  state: "default",
                })
              : props.setSidebarState!({
                  state: "threads_list",
                })
          }
        >
          <Symbol>forum</Symbol>
        </IconButton>
      </Show>

      <Show when={props.sidebarState}>
        <IconButton
          use:floating={{
            tooltip: {
              placement: "bottom",
              content: t`View pinned messages`,
            },
          }}
          onPress={() =>
            props.sidebarState!().state === "pins"
              ? props.setSidebarState!({
                  state: "default",
                })
              : props.setSidebarState!({
                  state: "pins",
                })
          }
        >
          <MdKeep />
        </IconButton>
      </Show>

      <Show when={props.sidebarState && canIHasSidebar(props.channel)}>
        <IconButton
          onPress={() => {
            // At phone layout `useLayoutSides()` short-circuits, so the
            // channel view never renders a member column and the only member
            // list is `ServerSidebar`'s — which the slide drawer parks
            // off-screen while a channel is open. Toggling the section state
            // here would govern a subtree the user cannot see, and turning it
            // off would take away the one member list a phone has. So turn it
            // on and bring the navigation column in instead.
            //
            // `setShown(false)` really does *show* the navigation: the drawer
            // is constructed over the channel pane, so `show` means "content
            // shown" and pushing the content off leaves the absolutely
            // positioned nav visible. `CommonHeader`'s phone back arrow makes
            // the identical call. It early-returns `false` mid-animation;
            // every call site ignores that, as here.
            //
            // Gated to the channel types `ServerSidebar` hosts a member list
            // for. A Group DM keeps its own inline member column in this view
            // (working and toggleable on a phone), and at phone layout the
            // navigation column mounts `HomeSidebar`, which has no member list
            // at all — so a Group falls through to the toggle below.
            const ad = state.appDrawer();
            if (
              ad &&
              (props.channel.type === "TextChannel" || props.channel.isThread)
            ) {
              state.layout.setSectionState(
                LAYOUT_SECTIONS.MEMBER_SIDEBAR,
                true,
                true,
              );
              // Same reset the non-phone `else` arm below does, and for the
              // same reason: pins/search/threads render into the sidebar slot
              // at a hard 360px, which on a 412px phone is the whole channel.
              // Without this the user taps members, slides to the navigation,
              // slides back and lands on a pins column instead of the channel.
              props.setSidebarState!({
                state: "default",
              });
              ad.setShown(false);
              return;
            }

            if (props.sidebarState!().state === "default") {
              state.layout.toggleSectionState(
                LAYOUT_SECTIONS.MEMBER_SIDEBAR,
                true,
              );
            } else {
              state.layout.setSectionState(
                LAYOUT_SECTIONS.MEMBER_SIDEBAR,
                true,
                true,
              );

              props.setSidebarState!({
                state: "default",
              });
            }
          }}
          use:floating={{
            tooltip: {
              placement: "bottom",
              content: t`View members`,
            },
          }}
        >
          <MdGroup />
        </IconButton>
      </Show>

      <Spacer />

      <Show when={searchValue() !== null}>
        <Show
          when={
            layout() === "desktop" || props.sidebarState!().state !== "default"
          }
          fallback={
            <IconButton
              onPress={() =>
                props.setSidebarState!({ state: "search", query: "" })
              }
              use:floating={{
                tooltip: {
                  placement: "bottom",
                  content: t`Search`,
                },
              }}
            >
              <Symbol>search</Symbol>
            </IconButton>
          }
        >
          <SearchBox
            placeholder="Search messages..."
            value={searchValue()!}
            onChange={(e) =>
              e.currentTarget.value
                ? props.setSidebarState!({
                    state: "search",
                    query: e.currentTarget.value,
                  })
                : props.setSidebarState!({
                    state: "default",
                  })
            }
          />
        </Show>
      </Show>
    </>
  );
}

const SearchBox = styled("input", {
  base: {
    height: "40px",
    width: "240px",
    paddingInline: "16px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

/**
 * Vertical divider between name and topic
 */
const Divider = styled("div", {
  base: {
    height: "20px",
    margin: "0px 5px",
    paddingLeft: "1px",
    backgroundColor: "var(--md-sys-color-outline-variant)",
  },
});

/**
 * Link for the description
 */
const descriptionLink = css({
  minWidth: 0,
});

const mobileOverflow = css({
  _phone: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

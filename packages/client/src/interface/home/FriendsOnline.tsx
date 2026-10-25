import { For, Show, createMemo } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";

import { useClient } from "@revolt/client";
import { useUserActions } from "@revolt/client/popoutBridge";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import {
  Avatar,
  Button,
  UserStatus,
  iconSize,
  usePresenceText,
} from "@revolt/ui";

import MdChat from "@material-design-icons/svg/filled/chat.svg?component-solid";
import MdPeople from "@material-design-icons/svg/filled/people.svg?component-solid";

import { voiceChannelOf } from "../../../components/client/voicePresence";
import { isChannelGatedForMember } from "../channels/memberGate";

import {
  Empty,
  List,
  Panel,
  PanelHead,
  PanelLink,
  PanelTitle,
  Row,
  RowButton,
  RowMeta,
  RowName,
  RowText,
} from "./cardParts";
import { pickOnlineFriends } from "./homeHub";

/**
 * Friends who are online right now, the ones in a call first, with what they
 * are doing and a button to message them.
 */
export function FriendsOnline() {
  const client = useClient();
  const state = useState();
  const navigate = useNavigate();
  const { openModal } = useModals();
  const presence = usePresenceText();
  const { t } = useLingui();
  const userActions = useUserActions();

  /** Whether a mature gate stands between the viewer and this channel */
  const gated = (channel: Channel) =>
    isChannelGatedForMember(
      channel,
      (key) => state.layout.getSectionState(key, false),
      LAYOUT_SECTIONS.MATURE,
    );

  const friends = createMemo(() => {
    const c = client();
    if (!c) return [];
    return pickOnlineFriends(
      c.users
        .toList()
        .filter((user) => user.relationship === "Friend" && user.online)
        .map((user) => {
          const call = voiceChannelOf(c, user.id);
          return {
            id: user.id,
            name: user.displayName,
            user,
            call,
            inVoice: call !== undefined,
            playing: user.activity !== undefined,
          };
        }),
    );
  });

  /** What a friend is doing, in one line */
  const doing = (entry: ReturnType<typeof friends>[number]) => {
    if (entry.call) {
      // Which gated channel someone sits in is that channel's content, as in
      // the sidebar: say only that they are in a call
      if (gated(entry.call)) return t`In voice`;
      const place = [entry.call.displayName, entry.call.server?.name]
        .filter(Boolean)
        .join(" · ");
      return t`In voice · ${place}`;
    }
    const game = entry.user.activity?.name;
    if (game) return t`Playing ${game}`;
    return (
      entry.user.statusMessage(presence.label) ??
      presence.label(entry.user.presence)
    );
  };

  return (
    <Panel aria-labelledby="home-friends-title">
      <PanelHead>
        <PanelTitle id="home-friends-title">
          <MdPeople />
          <Trans>Friends online</Trans>
        </PanelTitle>
        <PanelLink type="button" onClick={() => navigate("/friends")}>
          <Trans>All friends</Trans>
        </PanelLink>
      </PanelHead>
      <Show
        when={friends().length > 0}
        fallback={
          <Empty>
            <span>
              <Trans>None of your friends are online.</Trans>
            </span>
            <Button
              variant="tonal"
              size="sm"
              onPress={() =>
                openModal({ type: "add_friend", client: client()! })
              }
            >
              <Trans>Add friends</Trans>
            </Button>
          </Empty>
        }
      >
        <List>
          <For each={friends()}>
            {(entry) => {
              const label = () => {
                const name = entry.name;
                return t`Message ${name}`;
              };
              return (
                <li>
                  <Row>
                    <Avatar
                      size={34}
                      src={entry.user.animatedAvatarURL ?? entry.user.avatarURL}
                      fallback={entry.name}
                      holepunch="bottom-right"
                      overlay={
                        <UserStatus.Graphic status={entry.user.presence} />
                      }
                    />
                    <RowText>
                      <RowName>{entry.name}</RowName>
                      <RowMeta>{doing(entry)}</RowMeta>
                    </RowText>
                    <RowButton
                      type="button"
                      aria-label={label()}
                      // the friends list's own path: a chat window or the
                      // DM, and a snackbar when the DM cannot be opened
                      onClick={() => void userActions.run("dm", entry.user.id)}
                    >
                      <MdChat {...iconSize(18)} />
                    </RowButton>
                  </Row>
                </li>
              );
            }}
          </For>
        </List>
      </Show>
    </Panel>
  );
}

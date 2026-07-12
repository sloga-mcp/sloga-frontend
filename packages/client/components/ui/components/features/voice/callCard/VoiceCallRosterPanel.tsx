import { For, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useUsers } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { Avatar, Text } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { participantUserId } from "../participantIdentity";

/**
 * The §4.4 call roster / verification panel (slice 6.5). Rendered from the
 * VERIFIED MLS ROSTER (crypto truth) — NOT the LiveKit tracks — so a trackless
 * MLS leaf is visible and a divergent ghost / non-enrolled SFU identity is
 * flagged. Each member links to the slice-5 safety-number screen (§1.3: the
 * number shown IS the slice-5 number). Opened by clicking the encryption chip.
 */
export function VoiceCallRosterPanel() {
  const voice = useVoice();
  const { openModal } = useModals();

  const members = () => voice.callRoster().members;
  const ghosts = () => voice.callRoster().ghosts;
  const nonEnrolled = () => voice.callNonEnrolled();

  const memberIds = () => members().map((m) => m.user_id);
  const memberUsers = useUsers(memberIds);
  const nonEnrolledIds = () =>
    nonEnrolled().map((identity) => participantUserId(identity));
  const nonEnrolledUsers = useUsers(nonEnrolledIds);

  return (
    <Show when={voice.callRosterPanelOpen()}>
      <Panel>
        <Header>
          <Text class="title">
            <Trans>Call encryption</Trans>
          </Text>
          <CloseButton
            title="Close"
            onClick={() => voice.toggleCallRosterPanel()}
          >
            <Symbol size={18}>close</Symbol>
          </CloseButton>
        </Header>

        <List>
          <For each={members()}>
            {(member, i) => (
              <Row
                onClick={() =>
                  openModal({
                    type: "e2ee_verify",
                    peerUserId: member.user_id,
                    context: "call",
                  })
                }
              >
                <Avatar
                  size={28}
                  src={memberUsers()[i()]?.avatar}
                  fallback={memberUsers()[i()]?.username ?? member.user_id}
                />
                <RowText>
                  <Text class="body">
                    {memberUsers()[i()]?.username ?? member.user_id}
                  </Text>
                  <Show
                    when={ghosts().includes(
                      `${member.user_id}:${member.device_id}`,
                    )}
                  >
                    <Flag divergent>
                      <Trans>no media — divergent leaf</Trans>
                    </Flag>
                  </Show>
                </RowText>
                <Symbol
                  size={18}
                  color={
                    member.user_verified
                      ? "var(--md-sys-color-primary)"
                      : "var(--md-sys-color-outline)"
                  }
                >
                  {member.user_verified ? "verified_user" : "shield"}
                </Symbol>
              </Row>
            )}
          </For>

          <For each={nonEnrolled()}>
            {(_identity, i) => (
              <Row inert>
                <Avatar
                  size={28}
                  src={nonEnrolledUsers()[i()]?.avatar}
                  fallback={nonEnrolledUsers()[i()]?.username ?? "?"}
                />
                <RowText>
                  <Text class="body">
                    {nonEnrolledUsers()[i()]?.username ?? "Unknown"}
                  </Text>
                  <Flag>
                    <Trans>not encrypted</Trans>
                  </Flag>
                </RowText>
                <Symbol size={18} color="var(--md-sys-color-error)">
                  no_encryption
                </Symbol>
              </Row>
            )}
          </For>
        </List>
      </Panel>
    </Show>
  );
}

const Panel = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-lg)",
    right: "var(--gap-lg)",
    zIndex: 6,
    width: "min(280px, calc(100% - 2 * var(--gap-lg)))",
    maxHeight: "70%",
    overflowY: "auto",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-highest)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
});

const CloseButton = styled("button", {
  base: {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    display: "flex",
  },
});

const List = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    _hover: { background: "var(--md-sys-color-surface-container-high)" },
  },
  variants: {
    inert: {
      true: { cursor: "default", _hover: { background: "transparent" } },
    },
  },
});

const RowText = styled("div", {
  base: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
});

const Flag = styled("span", {
  base: {
    fontSize: "0.6875rem",
    color: "var(--md-sys-color-error)",
  },
  variants: {
    divergent: { true: { color: "var(--md-sys-color-on-surface-variant)" } },
  },
});

import { Show, createSignal, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { useMutation } from "@tanstack/solid-query";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import { streamerModeHides } from "@revolt/state/streamer";
import { Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Code block which displays invite
 */
const Invite = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",

    "& code": {
      padding: "1em",
      userSelect: "all",
      fontSize: "1.4em",
      textAlign: "center",
      fontFamily: "var(--fonts-monospace)",
    },
  },
  variants: {
    // Streamer Mode: keep the link off-screen unless deliberately hovered
    concealed: {
      true: {
        "& code": {
          filter: "blur(8px)",
          transition: "filter 0.15s ease",
          _hover: {
            filter: "none",
          },
        },
      },
    },
  },
});

/**
 * Modal to create a new invite
 */
export function CreateInviteModal(
  props: DialogProps & Modals & { type: "create_invite" },
) {
  const { showError } = useModals();
  const state = useState();
  const [link, setLink] = createSignal("...");

  const concealed = () => streamerModeHides(state.settings, "invites");

  const fetchInvite = useMutation(() => ({
    mutationFn: () =>
      props.channel
        .createInvite()
        .then(({ _id }) =>
          setLink(
            CONFIGURATION.IS_STOAT
              ? `https://stt.gg/${_id}`
              : `${window.location.protocol}//${window.location.host}/invite/${_id}`,
          ),
        ),
    onError: showError,
  }));

  onMount(() => fetchInvite.mutate());

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Create Invite</Trans>}
      actions={[
        { text: <Trans>OK</Trans> },
        {
          text: <Trans>Copy Link</Trans>,
          onClick: () => {
            navigator.clipboard.writeText(link());
            return false;
          },
        },
      ]}
    >
      <Show
        when={!fetchInvite.isPending}
        fallback={<Trans>Generating invite…</Trans>}
      >
        <Invite concealed={concealed()}>
          <Trans>
            Here is your new invite code: <code>{link()}</code>
          </Trans>
          <Show when={concealed()}>
            <Text class="label">
              <Trans>
                Streamer Mode is hiding your invite link — hover over it to
                reveal.
              </Trans>
            </Text>
          </Show>
        </Invite>
      </Show>
    </Dialog>
  );
}

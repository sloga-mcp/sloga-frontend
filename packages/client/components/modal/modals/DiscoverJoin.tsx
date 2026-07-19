import { Show } from "solid-js";

import { Plural, Trans } from "@lingui-solid/solid/macro";
import { useNavigate } from "@solidjs/router";
import { useMutation } from "@tanstack/solid-query";

import { Avatar, Dialog, DialogProps, Row } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to join a publicly discoverable server (no invite required).
 * Post-join navigation mirrors the invite modal.
 */
export function DiscoverJoinModal(
  props: DialogProps & Modals & { type: "discover_join" },
) {
  const navigate = useNavigate();
  const { showError } = useModals();

  const join = useMutation(() => ({
    mutationFn: () => props.server.join(),
    onSuccess(server) {
      navigate(server.path);
    },
    onError: showError,
  }));

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        <Row>
          <Avatar
            size={32}
            src={props.server.icon?.previewUrl}
            fallback={props.server.name}
          />
          <span>{props.server.name}</span>
        </Row>
      }
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: (
            <Show when={!props.server.server} fallback={<Trans>Open</Trans>}>
              <Trans>Join</Trans>
            </Show>
          ),
          onClick: join.mutateAsync,
        },
      ]}
      isDisabled={join.isPending}
      scrimBackground={props.server.banner?.originalUrl}
    >
      <Show
        when={!props.server.server}
        fallback={<Trans>You're already part of this server.</Trans>}
      >
        <Show when={props.server.description}>
          <span>{props.server.description}</span>
          <br />
        </Show>
        <Plural
          value={props.server.memberCount}
          one="# member"
          other="# members"
        />
        <br />
        <Trans>Would you like to join this server?</Trans>
      </Show>
    </Dialog>
  );
}

import { createEffect, on } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Shown once an account deletion request went through: the server has
 * emailed the confirm link, and this device signs out when the notice closes.
 *
 * Every way of closing it signs out: OK, a backdrop click and Escape. The
 * first two call `onClose`, but Escape removes the modal through the
 * controller (`popWhere`) without calling it, so the sign-out hangs off
 * `show` turning false instead of off `onClose`. That covers all three, and
 * `closeAll()` too.
 *
 * Close first, then `logout()`, as SignOut.tsx does: logout transitions the
 * lifecycle out from under this tree. `closeAll()` rather than closing just
 * this one, because the request is made from Settings, which is itself a
 * modal and would otherwise stay open over the sign-in screen.
 *
 * Logout is local: only this session ends. Other devices stay signed in, and
 * signing in again before the emailed link is used cancels the request.
 */
export function DeleteAccountRequestedModal(
  props: DialogProps & Modals & { type: "delete_account_requested" },
) {
  const { logout } = useClientLifecycle();
  const { closeAll } = useModals();

  // One sign-out per notice: closeAll() below removes this modal again, and
  // the effect must not answer its own close.
  let signedOut = false;

  createEffect(
    on(
      () => props.show,
      (show) => {
        if (show || signedOut) return;
        signedOut = true;
        closeAll();
        logout();
      },
      // Only a change counts: a renderer that remounts this modal mid-exit
      // (a chat window handing its modals back to main) must not sign out
      // a second time.
      { defer: true },
    ),
  );

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Check your email</Trans>}
      actions={[{ text: <Trans>OK</Trans> }]}
    >
      <Column>
        <Text>
          <Trans>
            We've sent a link to the email address on your account. Open it and
            press Delete permanently to finish deleting your account. Once you
            confirm, there is no going back.
          </Trans>
        </Text>
        <Text>
          <Trans>
            The link works for 24 hours. Changed your mind? Just sign in again
            before you use the link, and the request is cancelled.
          </Trans>
        </Text>
      </Column>
    </Dialog>
  );
}

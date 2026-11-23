import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClient, useClientLifecycle } from "@revolt/client";
import { deviceStateOf } from "@revolt/client/encryptedOnlyGuard";
import { latchedForClient } from "@revolt/client/encryptedOnlyLatch";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Modal to confirm signing out of the current session.
 *
 * `logout()` drops the stored session and tears the client down — there is no
 * undo — so the user menu entry routes through here instead of calling it
 * straight from a single click.
 *
 * For an Encrypted-only account it says what stays: sign-out keeps the
 * session on the server and does not wipe this device's encryption store, so
 * the keys and encrypted history stay here and come back on the next sign-in
 * on this device. The account setting stays on.
 */
export function SignOutModal(
  props: DialogProps & Modals & { type: "sign_out" },
) {
  const { logout } = useClientLifecycle();
  const client = useClient();

  const encryptedOnly = () => {
    const user = client().user;
    return latchedForClient(user?.id) || user?.e2eeOnly === true;
  };
  const keysHere = () => deviceStateOf(client()) === "ready";

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Are you sure you want to Sign out?</Trans>}
      actions={[
        {
          text: <Trans>No</Trans>,
          onClick: () => {
            props.onClose();
            return false;
          },
        },
        {
          text: <Trans>Yes</Trans>,
          onClick: () => {
            // Close first: logout() transitions the lifecycle out from under
            // this tree, and the modal must not be left on the stack.
            props.onClose();
            logout();
            return false;
          },
        },
      ]}
    >
      <Column>
        <Text>
          <Trans>
            You'll need to log in again to get back to your messages.
          </Trans>
        </Text>
        <Show when={encryptedOnly()}>
          <Text>
            <Trans>
              Encrypted-only chats stays on for your account after you sign out.
            </Trans>
          </Text>
          <Show
            when={keysHere()}
            fallback={
              <Text>
                <Trans>
                  To send direct messages and group messages, use a Sloga app
                  where encryption is set up.
                </Trans>
              </Text>
            }
          >
            <Text>
              <Trans>
                Your encryption keys and encrypted chats stay on this device.
                Sign in here again to use them.
              </Trans>
            </Text>
          </Show>
        </Show>
      </Column>
    </Dialog>
  );
}

import type { PasskeyLoginResponse } from "stoat.js";

import { useLingui } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import {
  SessionInUseError,
  State,
  sessionFriendlyName,
} from "@revolt/client/Controller";
import { useModals } from "@revolt/modal";

/**
 * Enter the app with the session a passkey sign-up or recovery ended with.
 *
 * The last request of either flow makes a session on the server, and the SDK
 * client keeps its token the moment the reply arrives. So a page that already
 * has a session in use must not send that request at all: call `ensureFree`
 * before the passkey prompt and again right before the last request, then
 * `adopt` with the reply. Both throw an error the page shows; neither ever
 * returns quietly without a session.
 */
export function usePasskeySession() {
  const { t } = useLingui();
  const modals = useModals();
  const { lifecycle, completeLogin } = useClientLifecycle();

  /** What the person reads when this page cannot take a new session */
  function inUse(): Error {
    return new Error(
      t`This device is already signed in, so the new sign-in was not kept. Sign out, then sign in with your passkey.`,
    );
  }

  return {
    /** Session name to ask the server for, as every other login sends it */
    friendlyName: sessionFriendlyName,

    /**
     * Throw unless this page can take a new session
     */
    ensureFree() {
      if (lifecycle.state() !== State.Ready) throw inUse();
    },

    /**
     * Store the session and start the logged-in lifecycle. Throws for a
     * disabled account (shown by the form's error line, with a countdown
     * when it is timed) and when the session could not be stored.
     * @param reply Reply of the sign-up or recovery
     * @param friendlyName Session name the reply was asked for with
     */
    async adopt(reply: PasskeyLoginResponse, friendlyName?: string) {
      try {
        await completeLogin(reply, modals, friendlyName);
      } catch (failure) {
        throw failure instanceof SessionInUseError ? inUse() : failure;
      }
    },
  };
}

import type { PasskeyLoginResponse } from "stoat.js";

import { useLingui } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import {
  SessionInUseError,
  State,
  sessionFriendlyName,
} from "@revolt/client/Controller";
import { useModals } from "@revolt/modal";

import { isSessionAlreadyPresent } from "./passkeySignup";

/**
 * Enter the app with the session a passkey sign-up or recovery ended with.
 *
 * The last request of either flow makes a session on the server, and the SDK
 * client keeps its token the moment the reply arrives. So a page that already
 * has a session in use must not send that request at all: call `ensureFree`
 * before the passkey prompt and again right before the last request, send
 * that request through `finish`, then `adopt` with the reply. All three
 * throw an error the page shows; none ever returns quietly without a
 * session.
 *
 * `ensureFree` cannot see a login that completes while the last request is
 * on its way. The SDK client covers that: it never replaces a session it
 * holds and throws instead, which `finish` turns into the same message.
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

    /** The error a page shows when it cannot take a new session */
    inUse,

    /**
     * Throw unless this page can take a new session
     */
    ensureFree() {
      if (lifecycle.state() !== State.Ready) throw inUse();
    },

    /**
     * Send the last request of the flow. When the SDK client would not keep
     * the new session because it already holds one, throws the "already
     * signed in" error; every other failure is thrown as it is.
     * @param run Sends the request and resolves with its reply
     * @returns The reply
     */
    async finish<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run();
      } catch (failure) {
        throw isSessionAlreadyPresent(failure) ? inUse() : failure;
      }
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

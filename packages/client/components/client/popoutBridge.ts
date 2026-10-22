/**
 * Message / call actions on a user, run in the realm that asked: the main
 * window, or a chat window or the friends window (same realm as main).
 *
 * The name is historical: the web friends popout that used to forward these
 * to main by `postMessage` is retired (see src/interface/FriendsPopout.tsx).
 */
import { useLingui } from "@lingui-solid/solid/macro";
import { useNavigate } from "@solidjs/router";
import type { Channel } from "stoat.js";

import { CONFIGURATION } from "@revolt/common";
import { useError } from "@revolt/i18n/errors";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
// The file, not the `@revolt/ui` barrel: ProfileActions (inside
// components/ui) imports this module, and a barrel edge back into
// components/ui can reorder its module init into a TDZ blank page.
import { useSnackbar } from "@revolt/ui/components/design/Snackbar";

import { useClient } from ".";
import {
  chatWindowsMode,
  routeConversation,
} from "../chatWindows/openConversation";
import { apiErrorType } from "./apiErrorType";
import * as chatShell from "./chatShell";
import { type PopoutAction } from "./shellToMain";
import { useWindowCtx } from "./windowCtx";

// The validator lives in an import-free module so node can spec it; every
// name stays importable from here.
export {
  type PopoutAction,
  type ShellToMain,
  isPopoutAction,
  isShellToMain,
  POPOUT_ACTIONS,
  POPOUT_WEB_MESSAGE_TYPE,
  TOAST_ID_RE,
  ULID_RE,
} from "./shellToMain";

/**
 * Message / call actions on a user. Call in component setup (it takes the
 * router, voice, state, snackbar and window contexts).
 *
 * Started from a chat window or the friends window, an action that lands in
 * the main window (a call, or a DM that is not routed to a chat-window tab)
 * brings main forward first: main may be hidden, and a call's mic prompt and
 * screen picker render there.
 *
 * `run` never rejects: failures surface as a snackbar, as the context menu
 * always has. It settles when the action has finished, so a caller closing
 * a menu should do that without awaiting it.
 */
export function useUserActions(): {
  run(action: PopoutAction, userId: string): Promise<void>;
} {
  const client = useClient();
  const navigate = useNavigate();
  const voice = useVoice();
  const state = useState();
  const snackbar = useSnackbar();
  const { t } = useLingui();
  const describeError = useError();
  // The window this hook's component renders in, fixed at setup
  const windowCtx = useWindowCtx();

  /**
   * Surface an openDM failure — otherwise a denied DM reads as a dead button.
   * Paused DMs (the account is under anti-spam review) get the errors
   * mapper's explanation; anything else keeps the generic message rather
   * than a raw server string.
   */
  function dmFailed(err: unknown) {
    console.error(err);
    snackbar.show({
      message:
        apiErrorType(err) === "DirectMessagesPaused"
          ? describeError(err)
          : t`Couldn't open a conversation with this user.`,
    });
  }

  /**
   * Enter the DM channel; on phones the navigation happens in the content
   * pane, which may be slid off-screen behind the sidebar
   */
  function enterDm(channel: Channel) {
    navigate(channel.path);
    state.appDrawer()?.setShown(true);
  }

  async function runHere(action: PopoutAction, userId: string) {
    // Video and screen share are build-gated; their entries are hidden when
    // off, so this is a guard against a stray caller.
    if (
      (action === "video" || action === "screenshare") &&
      !CONFIGURATION.ENABLE_VIDEO
    ) {
      console.warn(`[popoutBridge] ${action} is disabled in this build`);
      return;
    }

    try {
      const user = client().users.get(userId);
      if (!user) throw new Error("popout bridge: unknown user");

      // Every call entry is offered only for a user we can DM; hold the
      // same line here rather than trust the caller.
      if (
        action !== "dm" &&
        (user.self ||
          user.relationship === "Blocked" ||
          user.relationship === "BlockedOther")
      )
        throw new Error("popout bridge: user cannot be called");

      const channel = await user.openDM();

      // A message may open as a chat-window tab; calls always enter the DM
      // in main, where voice and its device pickers live. Main may be
      // hidden behind the window this started in, so whatever lands there
      // raises it first; a shell that cannot (web) just carries on. Nothing
      // awaits between this mode read and routeConversation's, so they agree.
      const toTab = action === "dm" && chatWindowsMode(state);
      if (windowCtx.id !== "main" && !toTab) await chatShell.focusMain();

      if (action === "dm") {
        routeConversation(state, channel.id, () => enterDm(channel));
        return;
      }
      enterDm(channel);

      switch (action) {
        case "call":
          await voice.connect(channel);
          return;
        case "video":
          if (await voice.connect(channel)) await voice.toggleCamera();
          return;
        case "screenshare":
          if (await voice.connect(channel)) await voice.toggleScreenshare();
          return;
      }
    } catch (err) {
      dmFailed(err);
    }
  }

  return { run: runHere };
}

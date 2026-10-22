import { Show, onMount } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import * as chatShell from "@revolt/client/chatShell";
import { useWindowCtx } from "@revolt/client/windowCtx";
import { useState } from "@revolt/state";
import { FloatingSelect, MenuItem, Text } from "@revolt/ui";

/**
 * Where the friends list and direct messages open, as one choice: both in
 * the main window, or both in the shell's own windows (the friends window
 * plus tabbed chat windows). Calls still run in the main window either way.
 * `supported()` only says a bridge exists, and a shell from before
 * chat windows has one too, so `chatShell` asks the shell to do something
 * harmless once per session and caches the answer. The row stays hidden
 * until it answers, and for good if it cannot, unless chat windows are
 * already chosen: then it shows anyway so the user can switch back.
 *
 * Only the main window starts the probe. Its harmless request is "focus
 * main", which from a chat window would pull main in front of the window the
 * user is working in; there the cached answer is read as it stands.
 *
 * Lives under Appearance rather than the Desktop page: that page is only
 * reachable where `window.native` exists, which the Electron shell on macOS
 * and Linux does not expose.
 */
export function DmWindowsChoice() {
  const state = useState();
  const { t } = useLingui();
  const ctx = useWindowCtx();

  onMount(() => {
    if (ctx.id === "main") void chatShell.probeChatWindows();
  });

  const visible = () =>
    chatShell.chatWindowsAvailable() === true ||
    state.settings.getValue("appearance:dm_windows") === "chat_windows";

  return (
    <Show when={visible()}>
      <FloatingSelect
        label={t`Friends and direct messages`}
        value={state.settings.getValue("appearance:dm_windows")}
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (value === "main" || value === "chat_windows") {
            state.settings.setValue("appearance:dm_windows", value);
          }
        }}
      >
        <MenuItem value="main">
          <Trans>In the main window</Trans>
        </MenuItem>
        <MenuItem value="chat_windows">
          <Trans>In their own windows, like Steam</Trans>
        </MenuItem>
      </FloatingSelect>
      <Text class="label" size="small">
        <Trans>
          In their own windows, the friends list and your conversations open
          outside the main window. Drag a tab out to pop it out, or onto another
          window to merge. Calls still show in the main window.
        </Trans>
      </Text>
    </Show>
  );
}

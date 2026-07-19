import { Show, createEffect, onCleanup } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useSound } from "@revolt/client";
import { useNavigate } from "@revolt/routing";
import {
  INCOMING_CALL_TIMEOUT_MS,
  dismissIncomingCall,
  incomingCall,
  useVoice,
} from "@revolt/rtc";
import { Avatar, Button } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Global incoming-call popup. Shown anywhere in the app when a DM/Group call
 * starts ringing (state set by NotificationsWorker) — Accept joins the call
 * and navigates to the conversation in one click, Decline just dismisses.
 */
export function IncomingCallOverlay() {
  const voice = useVoice();
  const sound = useSound();
  const navigate = useNavigate();
  const { t } = useLingui();

  // Auto-dismiss after the ring window elapses (caller gave up / unanswered)
  createEffect(() => {
    const call = incomingCall();
    if (!call) return;
    const timer = setTimeout(() => {
      sound.stopRingtone();
      dismissIncomingCall(call.channel.id);
    }, INCOMING_CALL_TIMEOUT_MS);
    onCleanup(() => clearTimeout(timer));
  });

  function accept() {
    const call = incomingCall();
    if (!call) return;
    sound.stopRingtone();
    dismissIncomingCall();
    navigate(call.channel.path);
    voice.connect(call.channel).catch(console.error);
  }

  function decline() {
    sound.stopRingtone();
    dismissIncomingCall();
  }

  const caller = () => incomingCall()?.caller;

  const callerName = () =>
    caller()?.displayName ?? caller()?.username ?? t`Incoming Call`;

  // Group calls: "{callerName} is calling in {channelName}" (existing msgid —
  // keep the identifier names so the macro reuses it); DMs: "Incoming Call"
  const groupSubtitle = () => {
    const call = incomingCall();
    if (!call || call.channel.type !== "Group") return undefined;
    const callerName = caller()?.displayName ?? caller()?.username ?? "?";
    const channelName = call.channel.name;
    return t`${callerName} is calling in ${channelName}`;
  };

  return (
    <Show when={incomingCall()}>
      <Popup role="alertdialog" aria-label={t`Incoming Call`}>
        <PulsingAvatar>
          <Avatar
            size={48}
            src={caller()?.animatedAvatarURL ?? caller()?.avatarURL}
            fallback={callerName()}
          />
        </PulsingAvatar>
        <Details>
          <Name>{callerName()}</Name>
          <Subtitle>
            <Show
              when={groupSubtitle()}
              fallback={<Trans>Incoming Call</Trans>}
            >
              {groupSubtitle()}
            </Show>
          </Subtitle>
        </Details>
        <Actions>
          <Button variant="filled" size="sm" onPress={accept}>
            <Symbol>call</Symbol> <Trans>Accept</Trans>
          </Button>
          <Button variant="_error" size="sm" onPress={decline}>
            <Symbol>call_end</Symbol> <Trans>Decline</Trans>
          </Button>
        </Actions>
      </Popup>
    </Show>
  );
}

const Popup = styled("div", {
  base: {
    position: "fixed",
    top: "48px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 9999,

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
    maxWidth: "min(420px, calc(100vw - 2 * var(--gap-lg)))",

    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.4)",

    animation: "slideIn 0.24s ease-out",
    "--translateY": "-64px",
  },
});

const PulsingAvatar = styled("div", {
  base: {
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    flexShrink: 0,
    animation: "incomingCallPulse 1.6s ease-out infinite",
  },
});

const Details = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
});

const Name = styled("div", {
  base: {
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const Subtitle = styled("div", {
  base: {
    fontSize: "0.8em",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    flexShrink: 0,
  },
});

import { Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * The §4.4 dual-gated media-E2EE encryption chip (slice 6.5). Renders the
 * `callEncryptionChip()` state (never from server flags): a green lock only
 * when native control-plane health AND LiveKit-observed media-plane encryption
 * AND verification all hold; loud NOT ENCRYPTED on any mix/failure. Clicking it
 * opens the roster panel (§1.3 safety-number entry point). Hidden entirely on
 * a plain (non-E2EE) call — `none` — so a normal voice call shows no chrome.
 */
export function VoiceCallEncryptionChip() {
  const voice = useVoice();
  const { t } = useLingui();

  const chip = () => voice.callEncryptionChip();

  const label = () => {
    switch (chip()) {
      case "e2ee":
        return t`End-to-end encrypted`;
      case "e2ee_unverified":
        return t`Encrypted · unverified`;
      case "resecuring":
        return t`Re-securing…`;
      case "not_encrypted":
        return t`Not encrypted`;
      default:
        return "";
    }
  };

  const symbol = () => {
    switch (chip()) {
      case "e2ee":
        return "lock";
      case "e2ee_unverified":
        return "lock";
      case "resecuring":
        return "sync";
      case "not_encrypted":
        return "no_encryption";
      default:
        return "";
    }
  };

  return (
    <Show when={chip() !== "none"}>
      <EncryptionChip
        chip={chip()}
        title={label()}
        onClick={() => voice.toggleCallRosterPanel()}
      >
        <Symbol size={16}>{symbol()}</Symbol>
        <span>{label()}</span>
      </EncryptionChip>
    </Show>
  );
}

const EncryptionChip = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    flexShrink: 0,
    padding: "2px var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    background: "transparent",
  },
  variants: {
    chip: {
      none: {},
      e2ee: { color: "var(--md-sys-color-primary)" },
      e2ee_unverified: { color: "var(--md-sys-color-on-surface-variant)" },
      resecuring: { color: "var(--md-sys-color-on-surface-variant)" },
      not_encrypted: {
        color: "var(--md-sys-color-on-error-container)",
        background: "var(--md-sys-color-error-container)",
      },
    },
  },
});

export function VoiceCallCardStatus(props: { pip?: boolean }) {
  const voice = useVoice();

  const symbol = () => {
    switch (voice.state()) {
      case "CONNECTED":
        return "wifi_tethering";
      case "CONNECTING":
        return "wifi_tethering";
      case "DISCONNECTED":
        return "wifi_tethering_error";
      case "RECONNECTING":
        return "wifi_tethering";
      default:
        return "";
    }
  };

  const text = () => {
    switch (voice.state()) {
      case "CONNECTED":
        return <Trans>Connected</Trans>;
      case "CONNECTING":
        return <Trans>Connecting</Trans>;
      case "DISCONNECTED":
        return <Trans>Disconnected</Trans>;
      case "RECONNECTING":
        return <Trans>Reconnecting</Trans>;
      default:
        return null;
    }
  };

  return (
    <Status status={voice.state()} pip={props.pip}>
      <Symbol>{symbol()}</Symbol>{" "}
      <FadeOut fade={voice.state() === "CONNECTED"}>{text()}</FadeOut>
    </Status>
  );
}

const FadeOut = styled("div", {
  base: {
    paddingLeft: "var(--gap-md)",
  },
  variants: {
    fade: {
      true: {
        opacity: 0,
        fontSize: 0,
        paddingLeft: 0,
        transition:
          "opacity .3s 5s ease, font-size .3s 6s, padding-left .3s 6s",
      },
    },
  },
});

const Status = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    justifyContent: "center",
    zIndex: 1,

    _hover: {
      "& div": {
        opacity: 1,
        fontSize: "inherit",
        paddingLeft: "var(--gap-md)",
        transition: "opacity 0s 0s, font-size 0s 0s, padding-left 0s 0s",
      },
    },
  },
  variants: {
    status: {
      READY: {},
      CONNECTED: {
        color: "var(--md-sys-color-primary)",
      },
      CONNECTING: {
        color: "var(--md-sys-color-outline)",
      },
      DISCONNECTED: {
        color: "var(--md-sys-color-outline)",
      },
      RECONNECTING: {
        color: "var(--md-sys-color-outline)",
      },
    },
    pip: {
      true: {
        position: "absolute",
        left: "var(--gap-md)",
        top: "var(--gap-md)",
      },
    },
  },
});

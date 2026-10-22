import { useFloating } from "solid-floating-ui";
import {
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";

import { autoUpdate, flip, offset, shift } from "@floating-ui/dom";
import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useUser } from "@revolt/client";
import {
  desktopUpdateInstalling,
  desktopUpdatePending,
  installDesktopUpdate,
  watchDesktopUpdate,
} from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { Avatar, UserStatus, isSlogaStaff } from "@revolt/ui";
import { IconButton } from "@revolt/ui/components/design";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { DeviceSection } from "@revolt/ui/components/features/voice/callCard/VoiceDeviceSelector";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { UserMenu } from "./servers/UserMenu";

/**
 * Persistent quick-access bar pinned to the bottom of the channel sidebar:
 * the signed-in user (click for the presence menu) plus mute / deafen
 * toggles that work in and out of calls, per-toggle device pickers, and a
 * shortcut into voice settings.
 *
 * When the channel sidebar is collapsed only the server rail is left to
 * sit on; `stacked` turns the pill into a vertical column narrow enough
 * for the icons-only rail (names and device chevrons hidden — the pickers
 * stay reachable through voice settings).
 */
export function UserFooter(props: { stacked?: boolean }) {
  const { t } = useLingui();
  const user = useUser();
  const voice = useVoice();
  const { openModal } = useModals();

  const [menuAnchor, setMenuAnchor] = createSignal<HTMLDivElement>();

  /**
   * In a live call the channel's voice permissions apply — mirror the call
   * card's disabled states. Out of call the toggles are always available
   * (they only flip the persisted preference).
   */
  const inCall = () => !!voice.room();

  // No-op off the Windows desktop shell, and idempotent, so the footer
  // remounting (collapsing the sidebar swaps variants) starts no second poll.
  onMount(watchDesktopUpdate);

  // Publish this bar's real height to the nav block it floats over, as
  // `--user-footer-height`, so the columns under it can reserve exactly that
  // much (Sidebar.tsx's `footer: "stack"`). The stacked column grows with
  // whatever it holds: the hang-up while in a call, the update arrow while
  // one is pending. A fixed reservation let the last rail item slide under it.
  let base!: HTMLDivElement;
  onMount(() => {
    const host = base.parentElement;
    if (!host) return;
    const observer = new ResizeObserver(() =>
      host.style.setProperty("--user-footer-height", `${base.offsetHeight}px`),
    );
    observer.observe(base);
    onCleanup(() => {
      observer.disconnect();
      host.style.removeProperty("--user-footer-height");
    });
  });

  return (
    <Base ref={base} data-user-footer stacked={props.stacked}>
      <UserArea ref={setMenuAnchor} stacked={props.stacked}>
        <Avatar
          size={32}
          src={user()?.avatarURL}
          fallback={user()?.username}
          holepunch="bottom-right"
          overlay={<UserStatus.Graphic status={user()?.presence} />}
          interactive
        />
        <Show when={!props.stacked && user()}>
          <Names>
            <NameText>
              <DisplayName
                user={user()}
                name={user()?.displayName ?? ""}
                brand={isSlogaStaff(user())}
              />
            </NameText>
            <Username>
              {user()?.username}#{user()?.discriminator}
            </Username>
          </Names>
        </Show>
      </UserArea>
      <UserMenu anchor={menuAnchor} placement="top-start" />

      <IconButton
        size="xs"
        variant="standard"
        onPress={() => voice.toggleMuteAnywhere()}
        isDisabled={inCall() && !voice.speakingPermission}
        style={
          voice.microphone()
            ? undefined
            : { "--colour": "var(--md-sys-color-error)" }
        }
        use:floating={{
          tooltip: {
            placement: props.stacked ? "right" : "top",
            content:
              inCall() && !voice.speakingPermission
                ? t`Missing permission`
                : voice.microphone()
                  ? t`Mute`
                  : t`Unmute`,
          },
        }}
      >
        <Show when={voice.microphone()} fallback={<Symbol>mic_off</Symbol>}>
          <Symbol>mic</Symbol>
        </Show>
      </IconButton>
      <Show when={!props.stacked}>
        <DevicePopover
          kind="audioinput"
          tooltip={t`Change input device`}
          openSettings={() =>
            openModal({
              type: "settings",
              config: "user",
              context: { page: "voice" },
            })
          }
        />
      </Show>

      <IconButton
        size="xs"
        variant="standard"
        onPress={() => voice.toggleDeafenAnywhere()}
        isDisabled={inCall() && !voice.listenPermission}
        style={
          voice.deafen()
            ? { "--colour": "var(--md-sys-color-error)" }
            : undefined
        }
        use:floating={{
          tooltip: {
            placement: props.stacked ? "right" : "top",
            content:
              inCall() && !voice.listenPermission
                ? t`Missing permission`
                : voice.deafen()
                  ? t`Undeafen`
                  : t`Deafen`,
          },
        }}
      >
        <Show when={voice.deafen()} fallback={<Symbol>headset</Symbol>}>
          <Symbol>headset_off</Symbol>
        </Show>
      </IconButton>
      <Show when={!props.stacked}>
        <DevicePopover
          kind="audiooutput"
          tooltip={t`Change output device`}
          openSettings={() =>
            openModal({
              type: "settings",
              config: "user",
              context: { page: "voice" },
            })
          }
        />
      </Show>

      {/*
        Desktop update arrow. Sits inside the same icon row as the toggles so
        the collapsed rail gets it for free — `stacked` turns the row into a
        column and this comes along, where a separate surface (a titlebar
        strip, say) would have vanished at exactly the width where the footer
        is the only chrome left.

        One press and the shell is gone: it downloads, installs silently and
        relaunches. That is the whole point of the button, so the tooltip says
        so rather than a dialog asking again.
      */}
      <Show when={desktopUpdatePending()}>
        <IconButton
          size="xs"
          variant="standard"
          onPress={installDesktopUpdate}
          isDisabled={desktopUpdateInstalling()}
          // The active theme exposes no semantic "success" colour -- the
          // customColours success/warning/error keys exist in the legacy
          // generator's TYPE only, and are emitted just for themes that
          // actually declare them, so var(--customColours-success-color)
          // resolves to nothing and the icon falls back to the row's grey.
          // --brand-presence-online is the one green the theme really
          // defines; the arrow tracks it deliberately.
          style={{ "--colour": "var(--brand-presence-online)" }}
          use:floating={{
            tooltip: {
              placement: props.stacked ? "right" : "top",
              content: t`Update to ${desktopUpdatePending()} and restart Sloga`,
            },
          }}
        >
          <Symbol>download</Symbol>
        </IconButton>
      </Show>

      {/*
        Hang up, from the bar that is on screen on every page and in the
        drawer. The call card's own button is the only other way out, and the
        card is exactly what can end up somewhere the user cannot reach (a
        phone report: card stuck over the wrong page or squeezed to nothing,
        no way to leave short of force-closing the app).
      */}
      <Show when={voice.channel()}>
        <IconButton
          size="xs"
          variant="standard"
          onPress={() => voice.disconnect()}
          style={{ "--colour": "var(--md-sys-color-error)" }}
          use:floating={{
            tooltip: {
              placement: props.stacked ? "right" : "top",
              content: t`End call`,
            },
          }}
        >
          <Symbol>call_end</Symbol>
        </IconButton>
      </Show>

      <IconButton
        size="xs"
        variant="standard"
        onPress={() => openModal({ type: "settings", config: "user" })}
        use:floating={{
          tooltip: {
            placement: props.stacked ? "right" : "top",
            content: t`Settings`,
          },
        }}
      >
        <Symbol>settings</Symbol>
      </IconButton>
    </Base>
  );
}

/**
 * Chevron next to a toggle that opens the matching device picker above the
 * bar. Portalled to #floating so the sidebar's overflow can't clip it.
 */
function DevicePopover(props: {
  kind: "audioinput" | "audiooutput";
  tooltip: string;
  openSettings: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const [popover, setPopover] = createSignal<HTMLDivElement>();

  const position = useFloating(anchor, popover, {
    placement: "top-end",
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });

  function onPointerDown(event: PointerEvent) {
    const target = event.target as Node;
    if (anchor()?.contains(target) || popover()?.contains(target)) return;
    setOpen(false);
  }

  // Only listen while the popover is open; cleanup covers close and unmount.
  createEffect(
    on(open, (isOpen) => {
      if (isOpen) {
        document.addEventListener("pointerdown", onPointerDown);
        onCleanup(() =>
          document.removeEventListener("pointerdown", onPointerDown),
        );
      }
    }),
  );

  return (
    <>
      <button
        class={chevron}
        ref={setAnchor}
        onClick={() => setOpen((v) => !v)}
        use:floating={{
          tooltip: {
            placement: "top",
            content: props.tooltip,
          },
        }}
      >
        <Symbol size={16}>{open() ? "expand_more" : "expand_less"}</Symbol>
      </button>
      <Portal mount={document.getElementById("floating")!}>
        <Show when={open()}>
          <PopoverBase
            ref={setPopover}
            style={{
              position: position.strategy,
              top: `${position.y ?? 0}px`,
              left: `${position.x ?? 0}px`,
            }}
          >
            <DeviceSection kind={props.kind} />
            <PopoverDivider />
            <SettingsRow
              onClick={() => {
                setOpen(false);
                props.openSettings();
              }}
            >
              <Trans>Voice Settings</Trans>
              <Symbol size={18}>settings</Symbol>
            </SettingsRow>
          </PopoverBase>
        </Show>
      </Portal>
    </>
  );
}

// Floats over the bottom of the whole nav block (server rail + channel
// list); the columns reserve matching space via MainBar's footer
// variant so scrolled content is never trapped underneath.
const Base = styled("div", {
  base: {
    position: "absolute",
    left: "10px",
    right: "10px",
    bottom: "10px",
    zIndex: 30,

    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "var(--gap-sm) var(--gap-md)",

    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    borderRadius: "var(--borderRadius-lg)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
  },
  variants: {
    // Vertical column narrow enough for the 56px icons-only rail.
    stacked: {
      true: {
        left: "5px",
        right: "5px",
        flexDirection: "column",
        padding: "var(--gap-sm) 2px",
      },
      false: {},
    },
  },
  defaultVariants: {
    stacked: false,
  },
});

const UserArea = styled("div", {
  base: {
    flexGrow: 1,
    minWidth: 0,

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm)",

    cursor: "pointer",
    userSelect: "none",
    borderRadius: "var(--borderRadius-md)",
    transition: "var(--transitions-fast) background",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
  variants: {
    stacked: {
      true: {
        flexGrow: 0,
      },
      false: {},
    },
  },
  defaultVariants: {
    stacked: false,
  },
});

const Names = styled("div", {
  base: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
});

const NameText = styled("span", {
  base: {
    fontSize: "0.85rem",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const Username = styled("span", {
  base: {
    fontSize: "0.7rem",
    opacity: 0.7,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const chevron = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",

  width: "16px",
  height: "32px",
  flexShrink: 0,

  border: "none",
  background: "transparent",
  cursor: "pointer",
  borderRadius: "var(--borderRadius-md)",
  color: "var(--md-sys-color-on-surface-variant)",
  fill: "var(--md-sys-color-on-surface-variant)",
  transition: "var(--transitions-fast) background",

  "&:hover": {
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const PopoverBase = styled("div", {
  base: {
    zIndex: 100,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    padding: "var(--gap-md)",
    maxHeight: "min(420px, 60vh)",
    minWidth: "260px",
    maxWidth: "320px",
    overflowY: "auto",

    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
});

const PopoverDivider = styled("div", {
  base: {
    height: "1px",
    flexShrink: 0,
    background: "var(--md-sys-color-outline-variant)",
    marginInline: "var(--gap-sm)",
  },
});

const SettingsRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",

    padding: "var(--gap-sm) var(--gap-md)",
    fontSize: "0.85rem",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    userSelect: "none",

    transition: "background 0.1s",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

import { useFloating } from "solid-floating-ui";
import {
  Accessor,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";

import { Placement, autoUpdate, flip, offset, shift } from "@floating-ui/dom";
import { Trans } from "@lingui-solid/solid/macro";
import { API } from "stoat.js";
import { styled } from "styled-system/jsx";

import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
  ContextMenuItem,
} from "@revolt/app/menus/ContextMenu";
import { useClient, useUser } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  type PresenceValue,
  Avatar,
  Column,
  Row,
  Text,
  UserStatus,
  usePresenceText,
} from "@revolt/ui";

import MdContactPage from "@material-design-icons/svg/outlined/contact_page.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdEditNote from "@material-design-icons/svg/outlined/edit_note.svg?component-solid";
import MdLogout from "@material-design-icons/svg/outlined/logout.svg?component-solid";

interface Props {
  anchor: Accessor<HTMLDivElement | undefined>;

  /**
   * Where to place the menu relative to the anchor (defaults to the server
   * rail's right-hand placement; the sidebar user bar opens upwards).
   */
  placement?: Placement;
}

/**
 * Presences offered in the picker, in menu order
 */
const PRESENCE_OPTIONS: PresenceValue[] = [
  "Online",
  "Idle",
  "Focus",
  "Busy",
  "LookingForGroup",
  "LookingForMore",
  "Invisible",
];

const TruncatedStatusText = styled("div", {
  base: {
    maxWidth: "var(--layout-width-user-context-menu-truncate)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/**
 * User menu attached to the server list
 */
export function UserMenu(props: Props) {
  const presence = usePresenceText();
  const { openModal } = useModals();
  const client = useClient();
  const user = useUser();
  const state = useState();

  const [show, setShow] = createSignal(false);
  const [ref, setRef] = createSignal<HTMLDivElement>();

  const position = useFloating(() => props.anchor(), ref, {
    placement: props.placement ?? "right-start",
    whileElementsMounted: autoUpdate,
    middleware: [offset(5), flip(), shift({ padding: 8 })],
  });

  function toggle() {
    setShow((v) => !v);
  }

  function close() {
    setShow(false);
  }

  function onMouseDown(event: MouseEvent) {
    const target = event.target as Node;
    // Ignore clicks on the anchor (avatar) — the click handler on the anchor
    // will toggle the menu. Ignore clicks inside the menu itself too.
    if (props.anchor()?.contains(target)) return;
    close();
  }

  onMount(() => document.addEventListener("mousedown", onMouseDown));
  onCleanup(() => document.removeEventListener("mousedown", onMouseDown));

  createEffect(
    on(
      () => props.anchor(),
      (anchor) => {
        if (anchor) {
          anchor.addEventListener("click", toggle);
          onCleanup(() => anchor.removeEventListener("click", toggle));
        }
      },
    ),
  );

  // `presence` is widened past what `stoat-api` declares -- see the `Presence`
  // type next to UserStatus -- so the value is cast back at the edit call.
  const setPresence = (presence: PresenceValue) =>
    user()?.edit({
      status: {
        presence: presence as (API.DataEditUser["status"] & {})["presence"],
      },
    });

  function copyId() {
    navigator.clipboard.writeText(user()!.id);
  }

  return (
    <Portal mount={document.getElementById("floating")!}>
      <Presence>
        <Show when={show()}>
          <Motion
            ref={setRef}
            style={{
              position: position.strategy,
              top: `${position.y ?? 0}px`,
              left: `${position.x ?? 0}px`,
            }}
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, easing: [0.87, 0, 0.13, 1] }}
          >
            <ContextMenu>
              <ContextMenuItem
                onClick={() => navigator.clipboard.writeText(`${user()?.username}#${user()?.discriminator}`)}
                action
              >
                <Row align>
                  <Avatar
                    size={32}
                    fallback={user()?.username}
                    src={user()?.animatedAvatarURL}
                  />
                  <Column gap="none">
                    <Text>{user()?.displayName}</Text>
                    <Text class="label">
                      {user()?.username}#{user()?.discriminator}
                    </Text>
                  </Column>
                </Row>
              </ContextMenuItem>

              <ContextMenuDivider />

              <For each={PRESENCE_OPTIONS}>
                {(option) => (
                  <ContextMenuButton
                    icon={
                      <Status>
                        <UserStatus size="10" status={option} noTooltip />
                      </Status>
                    }
                    onClick={() => setPresence(option)}
                    _titleCase={false}
                  >
                    <PresenceOption>
                      <div>{presence.pickerLabel(option)}</div>
                      <PresenceDescription>
                        {presence.pickerDescription(option)}
                      </PresenceDescription>
                    </PresenceOption>
                  </ContextMenuButton>
                )}
              </For>

              <ContextMenuDivider />

              <Show
                when={user()?.status?.text}
                fallback={
                  <ContextMenuButton
                    icon={MdEditNote}
                    onClick={() =>
                      openModal({ type: "custom_status", client: client() })
                    }
                  >
                    <Trans>Add status text</Trans>
                  </ContextMenuButton>
                }
              >
                <ContextMenuButton
                  icon={MdEditNote}
                  onClick={() =>
                    openModal({ type: "custom_status", client: client() })
                  }
                  _titleCase={false}
                >
                  <TruncatedStatusText>
                    {user()!.status!.text}
                  </TruncatedStatusText>
                </ContextMenuButton>
                <ContextMenuButton
                  icon={MdDelete}
                  onClick={() => user()?.edit({ remove: ["StatusText"] })}
                >
                  <Trans>Clear status</Trans>
                </ContextMenuButton>
              </Show>

              <Show when={state.settings.getValue("advanced:copy_id")}>
                <ContextMenuButton icon={MdContactPage} onClick={copyId}>
                  <Trans>Copy user ID</Trans>
                </ContextMenuButton>
              </Show>

              <ContextMenuDivider />

              <ContextMenuButton
                icon={MdLogout}
                destructive
                onClick={() => {
                  close();
                  openModal({ type: "sign_out" });
                }}
              >
                <Trans>Sign out</Trans>
              </ContextMenuButton>
            </ContextMenu>
          </Motion>
        </Show>
      </Presence>
    </Portal>
  );
}

const Status = styled("div", {
  base: {
    width: "16px",
    display: "flex",
    justifyContent: "center",
  },
});

/**
 * Presence name over what choosing it does. Divs, not spans: the menu item
 * stretches every nested span.
 */
const PresenceOption = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

/**
 * What choosing a presence does. Wraps rather than truncates, at the same
 * width the custom status text truncates at, and never wider than a phone
 * leaves room for.
 */
const PresenceDescription = styled("div", {
  base: {
    maxWidth:
      "min(var(--layout-width-user-context-menu-truncate), calc(100vw - 96px))",
    whiteSpace: "normal",
    fontSize: "0.75rem",
    lineHeight: "1.2em",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

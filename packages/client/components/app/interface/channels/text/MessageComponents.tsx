import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { ComponentData, Message } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * How long a clicked component stays pending before we give up on the bot
 * answering (matches the invoke-side indicator; the interaction itself
 * stays valid server-side for 15 minutes).
 */
const RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Interactive component rows (buttons / selects) on a bot message.
 *
 * Clicks POST a Component interaction; the clicked control shows a pending
 * spinner and disables until the bot answers — by editing this message
 * (components/edited change) or replying to it — or until a 15s timeout.
 */
export function MessageComponents(props: { message: Message }) {
  const client = useClient();
  const e2ee = useE2EE();
  const { openModal } = useModals();
  const { t } = useLingui();

  const [pending, setPending] = createSignal<Record<string, boolean>>({});
  const timers = new Map<string, number>();

  function clearPending(customId?: string) {
    if (customId) {
      const timer = timers.get(customId);
      if (timer) window.clearTimeout(timer);
      timers.delete(customId);
      setPending((entries) => ({ ...entries, [customId]: false }));
    } else {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      setPending({});
    }
  }

  onCleanup(() => {
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
  });

  // Edit-response path: the bot answered by updating this message.
  createEffect(
    on(
      () => [props.message.editedAt?.getTime(), props.message.components],
      () => clearPending(),
      { defer: true },
    ),
  );

  // Components are bot-only server-side; only rendering for bot authors is
  // defence-in-depth against a hostile server stamping them onto arbitrary
  // messages. Fetch-on-miss so an unhydrated author doesn't hide valid
  // components (InteractionContext precedent).
  const author = () => props.message.author;
  onMount(() => {
    if (!author() && props.message.authorId) {
      client()
        .users.fetch(props.message.authorId)
        .catch(() => undefined);
    }
  });

  // Follow-up path: the bot answered with a new message replying to this one.
  onMount(() => {
    const handler = (message: Message) => {
      if (
        message.channelId === props.message.channelId &&
        message.authorId === props.message.authorId &&
        message.replyIds?.includes(props.message.id)
      ) {
        clearPending();
      }
    };
    client().addListener("messageCreate", handler);
    onCleanup(() => client().removeListener("messageCreate", handler));
  });

  async function interact(component: ComponentData, values?: string[]) {
    if (component.disabled || pending()[component.custom_id]) return;

    const channel = props.message.channel;
    if (!channel) return;

    // Fail closed, mirroring slash-command invocation: never fan component
    // metadata out of an encrypted or blocked conversation. Awaits the
    // AUTHORITATIVE native verdict, not the cached indicator.
    if (
      e2ee &&
      (channel.type === "DirectMessage" || channel.type === "Group")
    ) {
      let mode: "encrypt" | "blocked" | "plaintext" | null;
      try {
        mode = await e2ee.sendModeNowFor(channel);
      } catch {
        openModal({
          type: "error2",
          error: t`Encryption status could not be verified. Nothing was sent.`,
        });
        return;
      }
      if (mode === "encrypt" || mode === "blocked") {
        openModal({
          type: "error2",
          error: t`Interactions are unavailable in encrypted conversations.`,
        });
        return;
      }
    }

    setPending((entries) => ({ ...entries, [component.custom_id]: true }));

    try {
      await channel.interactWithMessage(
        props.message.id,
        component.custom_id,
        values,
      );

      timers.set(
        component.custom_id,
        window.setTimeout(() => {
          clearPending(component.custom_id);
          openModal({
            type: "error2",
            error: t`The bot did not respond in time.`,
          });
        }, RESPONSE_TIMEOUT_MS),
      );
    } catch (error) {
      clearPending(component.custom_id);
      const type = (error as { type?: string })?.type;
      openModal({
        type: "error2",
        error:
          type === "BotOffline"
            ? t`That bot is currently offline — try again once it reconnects.`
            : new Error(
                type ??
                  (error instanceof Error ? error.message : String(error)),
              ),
      });
    }
  }

  return (
    <Show when={author()?.bot}>
      <Rows>
        <For each={props.message.components}>
          {(row) => (
            <Row>
              <For each={row.components}>
                {(component) => (
                  <Switch>
                    <Match when={component.type === "Button"}>
                      <ComponentButton
                        buttonStyle={
                          (component.type === "Button"
                            ? component.style
                            : "Secondary") as
                            | "Primary"
                            | "Secondary"
                            | "Success"
                            | "Danger"
                        }
                        disabled={
                          component.disabled || pending()[component.custom_id]
                        }
                        onClick={() => interact(component)}
                      >
                        <Switch
                          fallback={
                            component.type === "Button" ? component.label : ""
                          }
                        >
                          <Match when={pending()[component.custom_id]}>
                            <Spinner>
                              <Symbol size={16}>progress_activity</Symbol>
                            </Spinner>
                            {component.type === "Button" ? component.label : ""}
                          </Match>
                        </Switch>
                      </ComponentButton>
                    </Match>
                    <Match when={component.type === "StringSelect"}>
                      <ComponentSelect
                        disabled={
                          component.disabled || pending()[component.custom_id]
                        }
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          const element = event.currentTarget;
                          if (value)
                            // Reset to the placeholder afterwards so the same
                            // option can be picked again (a native select
                            // fires no change event for a repeat pick)
                            void interact(component, [value]).then(() => {
                              element.value = "";
                            });
                        }}
                      >
                        <option value="" disabled selected>
                          {(component.type === "StringSelect"
                            ? component.placeholder
                            : undefined) ?? t`Make a selection`}
                        </option>
                        <For
                          each={
                            component.type === "StringSelect"
                              ? component.options
                              : []
                          }
                        >
                          {(option) => (
                            <option value={option.value}>{option.label}</option>
                          )}
                        </For>
                      </ComponentSelect>
                    </Match>
                  </Switch>
                )}
              </For>
            </Row>
          )}
        </For>
      </Rows>
    </Show>
  );
}

const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    marginTop: "var(--gap-sm)",
    userSelect: "none",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const ComponentButton = styled("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-sm) var(--gap-lg)",
    borderRadius: "var(--borderRadius-md)",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "filter 0.15s ease",
    "&:hover:not(:disabled)": {
      filter: "brightness(1.1)",
    },
    "&:disabled": {
      cursor: "not-allowed",
      opacity: 0.55,
    },
  },
  variants: {
    buttonStyle: {
      Primary: {
        background: "var(--md-sys-color-primary)",
        color: "var(--md-sys-color-on-primary)",
      },
      Secondary: {
        background: "var(--md-sys-color-surface-container-high)",
        color: "var(--md-sys-color-on-surface)",
      },
      Success: {
        background: "var(--customColours-success-color)",
        color: "var(--customColours-success-onColour)",
      },
      Danger: {
        background: "var(--md-sys-color-error)",
        color: "var(--md-sys-color-on-error)",
      },
    },
  },
  defaultVariants: {
    buttonStyle: "Secondary",
  },
});

const ComponentSelect = styled("select", {
  base: {
    minWidth: "220px",
    maxWidth: "400px",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    fontSize: "14px",
    cursor: "pointer",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    "&:disabled": {
      cursor: "not-allowed",
      opacity: 0.55,
    },
  },
});

const Spinner = styled("span", {
  base: {
    display: "inline-flex",
    // house precedent (EncryptedAttachment): static progress glyph, no
    // spin keyframe is defined in the panda config
    opacity: 0.8,
  },
});

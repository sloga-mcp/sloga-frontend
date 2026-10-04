import { Match, Show, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { SupporterClaimCode } from "stoat.js";
import { css } from "styled-system/css";

import { KOFI_PAGE_URL, useClient } from "@revolt/client";
import { useError } from "@revolt/i18n";
import {
  Button,
  CategoryButton,
  CircularProgress,
  Column,
  Dialog,
  DialogProps,
  SupportSlogaIcon,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

import { createSupportSlogaFlow } from "./supportSlogaFlow";

/**
 * "Support Sloga" step before Ko-fi: hands out the account's supporter code so
 * the donation can be pasted into the Ko-fi message and linked automatically.
 * Without it a payment only links when it comes from the account's email.
 *
 * Only opened from buttons that sit behind `allowsDonationLinks()`.
 */
export function SupportSlogaModal(
  props: DialogProps & Modals & { type: "support_sloga" },
) {
  const client = useClient();
  const { openModal } = useModals();
  const err = useError();
  const { t } = useLingui();

  const flow = createSupportSlogaFlow({
    fetchCode: () =>
      client().api.post(
        "/users/@me/supporter/code" as never,
      ) as unknown as Promise<SupporterClaimCode>,
    writeClipboard: (value) => navigator.clipboard.writeText(value),
    openKofi: () => window.open(KOFI_PAGE_URL, "_blank", "noopener"),
    close: () => props.onClose(),
  });

  function codeDescription(ms: number) {
    const expires = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(ms);
    return t`Your supporter code · Expires ${expires}`;
  }

  function openSupporterPage() {
    props.onClose();
    openModal({
      type: "settings",
      config: "user",
      context: { page: "supporter" },
    });
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      icon={<SupportSlogaIcon size={40} />}
      title={<Trans>Support Sloga</Trans>}
    >
      <Column gap="md">
        <Text class="label">
          <Trans>
            Paste this code into your Ko-fi message so the donation is added to
            your account and any perks it earns unlock automatically.
          </Trans>
        </Text>

        <Switch>
          <Match when={flow.code.loading}>
            <div class={css({ height: "56px" })}>
              <CircularProgress />
            </div>
          </Match>
          <Match when={flow.code.error}>
            <Text class="label">
              <Trans>Couldn't get your supporter code.</Trans>{" "}
              {err(flow.code.error)}
            </Text>
          </Match>
          <Match when={flow.value()}>
            {(current) => (
              <CategoryButton
                icon={<Symbol size={22}>key</Symbol>}
                description={codeDescription(current().expires_at)}
                action="copy"
                onClick={() => flow.copy(current().code)}
              >
                <span class={css({ userSelect: "all" })}>{current().code}</span>
              </CategoryButton>
            )}
          </Match>
        </Switch>

        <Show when={flow.copyFailed()}>
          <Text class="label">
            <Trans>
              Couldn't copy to the clipboard. Select the code and copy it
              yourself.
            </Trans>
          </Text>
        </Show>

        <Column gap="sm">
          {/* Brand orange, like the other Support Sloga buttons */}
          <div
            style={{
              "--md-sys-color-primary": "#FF8A00",
              "--md-sys-color-on-primary": "#05090F",
              display: "grid",
            }}
          >
            <Button
              variant="filled"
              onPress={flow.copyAndOpen}
              isDisabled={flow.code.loading}
            >
              <Show when={flow.value()} fallback={<Trans>Open Ko-fi</Trans>}>
                <Trans>Copy code and open Ko-fi</Trans>
              </Show>
            </Button>
          </div>
          {/* Without a code the main button already opens Ko-fi on its own */}
          <Show when={flow.value()}>
            <Button variant="text" onPress={flow.donateWithoutCode}>
              <Trans>Donate without a code</Trans>
            </Button>
          </Show>
          <Button variant="text" onPress={openSupporterPage}>
            <Trans>Already donated? Claim it in Supporter settings</Trans>
          </Button>
        </Column>
      </Column>
    </Dialog>
  );
}

import { Match, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useE2EE } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { CategoryButton, Checkbox, Column, iconSize } from "@revolt/ui";

import MdLock from "@material-design-icons/svg/outlined/lock.svg?component-solid";

/**
 * Security & Privacy settings page.
 *
 * Currently hosts the per-device end-to-end encryption opt-in (moved out of
 * Sessions). The E2EE card renders only where a native crypto layer exists
 * (Tauri desktop); the web build has no key material and the server refuses
 * its E2EE routes.
 */
export function SecurityAndPrivacy() {
  return (
    <Column gap="lg">
      <EncryptionCard />
    </Column>
  );
}

/**
 * End-to-end encryption opt-in for this device (implementation plan slice 3).
 */
function EncryptionCard() {
  const e2ee = useE2EE();
  const { openModal } = useModals();

  if (!e2ee) return null;

  const state = () => e2ee.status.get("state");
  const enabled = () => !!state()?.enabled && !!state()?.published;

  return (
    <CategoryButton.Group>
      <CategoryButton
        // A checkbox as a pure indicator (clicks pass through to the row via
        // pointer-events:none), so it always reflects the real native status
        // and never desyncs on a cancelled flow. The row toggles: checked →
        // disable flow, unchecked → enable flow.
        action={
          <span style={{ "pointer-events": "none", display: "flex" }}>
            <Checkbox checked={enabled()} />
          </span>
        }
        icon={<MdLock {...iconSize(24)} />}
        description={
          enabled() ? (
            <Trans>
              Direct messages with contacts who also have encryption on are
              end-to-end encrypted on this device. Encrypted history is stored
              only here — uncheck to turn encryption off on this device.
            </Trans>
          ) : (
            <Trans>
              Turn on end-to-end encrypted direct messages for this device.
            </Trans>
          )
        }
        onClick={() =>
          openModal({ type: enabled() ? "e2ee_disable" : "e2ee_enable" })
        }
      >
        <Switch>
          <Match when={enabled()}>
            <Trans>Encrypted messaging is on</Trans>
          </Match>
          <Match when={!enabled()}>
            <Trans>Encrypted direct messages</Trans>
          </Match>
        </Switch>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

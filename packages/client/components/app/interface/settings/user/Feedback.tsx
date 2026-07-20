import { useNavigate } from "@solidjs/router";
import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import MdGroups3 from "@material-design-icons/svg/filled/groups_3.svg?component-solid";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { CategoryButton, Column } from "@revolt/ui";

/**
 * "Welcome to Sloga" server, which every user is auto-joined to on onboarding
 */
const LOUNGE_SERVER_ID = "01KXJPE1HBR1A4W996QNB3DG1A";

/**
 * Feedback
 */
export function Feedback() {
  const { pop } = useModals();
  const navigate = useNavigate();
  const client = useClient();

  const isInLounge = client()!.servers.get(LOUNGE_SERVER_ID) !== undefined;

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <Show when={isInLounge}>
          <CategoryButton
            onClick={() => {
              navigate(`/server/${LOUNGE_SERVER_ID}`);
              pop();
            }}
            description={
              <Trans>
                You can report issues and discuss improvements with us directly
                here.
              </Trans>
            }
            icon={<MdGroups3 />}
          >
            <Trans>Go to the Sloga Lounge</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
    </Column>
  );
}

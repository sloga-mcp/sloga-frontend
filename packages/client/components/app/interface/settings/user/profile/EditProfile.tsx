import { For } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import { createOwnProfileResource } from "@revolt/client/resources";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  Avatar,
  CategoryButton,
  Checkbox,
  Column,
  Text,
  iconSize,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdGroups from "@material-design-icons/svg/outlined/groups.svg?component-solid";

import { UserSummary } from "../account/index";

import { UserProfileEditor } from "./UserProfileEditor";

/**
 * Edit profile
 */
export function EditProfile() {
  const client = useClient();
  const state = useState();
  const { openModal } = useModals();
  const profile = createOwnProfileResource();

  return (
    <Column gap="lg">
      <UserSummary
        user={client().user!}
        bannerUrl={profile.data?.animatedBannerURL}
      />

      <CategoryButton.Group>
        <CategoryButton.Collapse
          icon={<MdGroups {...iconSize(22)} />}
          title={<Trans>Server Identities</Trans>}
          description={<Trans>Change your profile per-server</Trans>}
          scrollable
        >
          <For each={client().servers.toList()}>
            {(server) => (
              <CategoryButton
                icon={
                  <Avatar
                    src={server.animatedIconURL}
                    size={24}
                    fallback={server.name}
                  />
                }
                onClick={() =>
                  openModal({
                    type: "server_identity",
                    member: server.member!,
                  })
                }
              >
                {server.name}
              </CategoryButton>
            )}
          </For>
        </CategoryButton.Collapse>
      </CategoryButton.Group>

      <CategoryButton.Group>
        <CategoryButton
          action={
            <Checkbox checked={state.settings.getValue("activity:share")} />
          }
          onClick={() =>
            state.settings.setValue(
              "activity:share",
              !state.settings.getValue("activity:share"),
            )
          }
          icon={<Symbol>sports_esports</Symbol>}
          description={
            <Trans>
              Show friends what game you are playing (desktop app only).
            </Trans>
          }
        >
          <Trans>Share Game Activity</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Column>
        <Text class="title" size="large">
          <Trans>Edit Global Profile</Trans>
        </Text>
        <UserProfileEditor user={client().user!} />
      </Column>
    </Column>
  );
}

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import {
  anyImportSourceEnabled,
  importDiscordEnabled,
} from "@revolt/client/discordImport";
import { useModals } from "@revolt/modal";
import { importActionFor } from "@revolt/modal/modals/importEntry";
import { Button } from "@revolt/ui";

import MdMoveDown from "@material-design-icons/svg/filled/move_down.svg?component-solid";

import { Panel, PanelHead, PanelTitle } from "./cardParts";

const Body = styled("div", {
  base: {
    padding: "0 6px 4px",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "10px",
    fontSize: "14px",
    lineHeight: 1.45,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Which import the card offers, by the same rule as the Create menu: the
 * picker once any other platform is switched on, else Discord's own import,
 * else none (the card then stays out of Home)
 */
export function importCardAction() {
  return importActionFor(importDiscordEnabled(), anyImportSourceEnabled());
}

/**
 * "Bring your community over": one line and a button into the import flow.
 */
export function ImportCard() {
  const client = useClient();
  const { openModal } = useModals();

  function open() {
    if (importCardAction() === "picker") {
      openModal({ type: "import_source", client: client()! });
    } else {
      openModal({ type: "import_discord", client: client()! });
    }
  }

  return (
    <Panel aria-labelledby="home-import-title">
      <PanelHead>
        <PanelTitle id="home-import-title">
          <MdMoveDown />
          <Trans>Bring your community over</Trans>
        </PanelTitle>
      </PanelHead>
      <Body>
        <span>
          {importCardAction() === "picker" ? (
            <Trans>Import a server from another platform.</Trans>
          ) : (
            <Trans>Import a server from Discord.</Trans>
          )}
        </span>
        <Button variant="tonal" size="sm" onPress={open}>
          <Trans>Import a server</Trans>
        </Button>
      </Body>
    </Panel>
  );
}

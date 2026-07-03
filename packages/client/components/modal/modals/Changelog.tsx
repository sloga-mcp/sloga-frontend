import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useTime } from "@revolt/i18n";
import { renderChangelogMarkdown } from "@revolt/markdown";
import { Column, Dialog, DialogProps } from "@revolt/ui";
import type { DialogAction } from "@revolt/ui/components/design/Dialog";

import { Modals } from "../types";

export interface ChangelogResponse {
  id: string;
  title: string;
  markdown_content: string;
  ios_version?: string;
  android_version?: string;
  web_version?: string;
  published_at: string;
  created_at?: string;
  updated_at?: string;
}

export async function fetchLatestChangelog(): Promise<ChangelogResponse | null> {
  // Patch notes are maintained locally in changelogData.ts (newest first)
  const { CHANGELOGS } = await import("./changelogData");
  return CHANGELOGS[0] ?? null;
}

export function ChangelogModal(
  props: DialogProps & Modals & { type: "changelog" },
) {
  const dayjs = useTime();
  const actions: DialogAction[] = [{ text: <Trans>Close</Trans> }];

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Patch Notes</Trans>}
      actions={actions}
    >
      <Column>
        <Subtitle>{dayjs(props.changelog.published_at).format("LL")}</Subtitle>
        <div>{renderChangelogMarkdown(props.changelog.markdown_content)}</div>
      </Column>
    </Dialog>
  );
}

const Subtitle = styled("span", {
  base: {
    marginBlockEnd: "var(--gap-md)",
    fontSize: "0.875rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

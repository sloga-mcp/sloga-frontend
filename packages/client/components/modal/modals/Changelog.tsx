import { For, Show, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useTime } from "@revolt/i18n";
import { renderChangelogMarkdown } from "@revolt/markdown";
import { useState } from "@revolt/state";
import { Checkbox, Column, Dialog, DialogProps } from "@revolt/ui";
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

export async function fetchAllChangelogs(): Promise<ChangelogResponse[]> {
  // Full patch notes history, newest first (see changelogData.ts)
  const { CHANGELOGS } = await import("./changelogData");
  return CHANGELOGS;
}

export function ChangelogModal(
  props: DialogProps & Modals & { type: "changelog" },
) {
  const dayjs = useTime();
  const state = useState();
  const [dontShowAgain, setDontShowAgain] = createSignal(false);

  function onClose() {
    if (dontShowAgain()) {
      state["release-notes"].markSeen(
        props.changelog.id,
        props.changelog.published_at,
      );
    }
    props.onClose();
  }

  const actions: DialogAction[] = [{ text: <Trans>Close</Trans> }];

  return (
    <Dialog
      show={props.show}
      onClose={onClose}
      title={
        <TitleRow>
          <Trans>Patch Notes</Trans>
          <img
            src="/assets/web/sloga-icon.png"
            alt="Sloga"
            width={30}
            height={30}
          />
        </TitleRow>
      }
      actions={actions}
    >
      <Column>
        <Subtitle>{dayjs(props.changelog.published_at).format("LL")}</Subtitle>
        <div>{renderChangelogMarkdown(props.changelog.markdown_content)}</div>
        <Checkbox
          checked={dontShowAgain()}
          onChange={(event) => setDontShowAgain(event.currentTarget.checked)}
        >
          <Trans>Don't show this again until the next update</Trans>
        </Checkbox>
      </Column>
    </Dialog>
  );
}

/**
 * Full patch notes history — every entry, newest first, in one scrollable
 * dialog. Opened from Settings → Patch Notes. Unlike the launch popup this has
 * no "don't show again" checkbox and never touches the release-notes store.
 */
export function ChangelogHistoryModal(
  props: DialogProps & Modals & { type: "changelog_history" },
) {
  const dayjs = useTime();

  const actions: DialogAction[] = [{ text: <Trans>Close</Trans> }];

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        <TitleRow>
          <Trans>Patch Notes</Trans>
          <img
            src="/assets/web/sloga-icon.png"
            alt="Sloga"
            width={30}
            height={30}
          />
        </TitleRow>
      }
      actions={actions}
    >
      <History>
        <For each={props.changelogs}>
          {(entry, index) => (
            <Entry>
              <Show when={index() > 0}>
                <Divider />
              </Show>
              <Subtitle>{dayjs(entry.published_at).format("LL")}</Subtitle>
              <div>{renderChangelogMarkdown(entry.markdown_content)}</div>
            </Entry>
          )}
        </For>
      </History>
    </Dialog>
  );
}

const History = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "60vh",
    overflowY: "auto",
    // room so the scrollbar doesn't overlap content
    paddingInlineEnd: "var(--gap-md)",
  },
});

const Entry = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
  },
});

const Divider = styled("hr", {
  base: {
    width: "100%",
    border: "none",
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
    marginBlock: "var(--gap-lg)",
  },
});

const TitleRow = styled("span", {
  base: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",
    "& img": {
      flexShrink: 0,
      display: "block",
    },
  },
});

const Subtitle = styled("span", {
  base: {
    marginBlockEnd: "var(--gap-md)",
    fontSize: "0.875rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

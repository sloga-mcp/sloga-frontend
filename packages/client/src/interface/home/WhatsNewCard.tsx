import { type JSX, createSignal, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useModals } from "@revolt/modal";
import { fetchAllChangelogs } from "@revolt/modal/modals/Changelog";
import { iconSize } from "@revolt/ui";

import MdArrowForward from "@material-design-icons/svg/filled/arrow_forward.svg?component-solid";
import MdCallEnd from "@material-design-icons/svg/filled/call_end.svg?component-solid";
import MdClose from "@material-design-icons/svg/filled/close.svg?component-solid";
import MdFolder from "@material-design-icons/svg/filled/folder.svg?component-solid";
import MdWebAsset from "@material-design-icons/svg/filled/web_asset.svg?component-solid";

import pkg from "../../../../../package.json";

import { showWhatsNew, WHATS_NEW_KEY } from "./homeHub";

/**
 * The release these highlights were written for. Update it together with
 * HIGHLIGHTS each release; until both are updated the card stays hidden.
 */
const HIGHLIGHTS_RELEASE = "0.69";

const ACCENT = "#3BB8ED";

/** Two or three headline changes, short enough for one line each */
const HIGHLIGHTS: { icon: () => JSX.Element; text: () => JSX.Element }[] = [
  {
    icon: () => <MdFolder {...iconSize(18)} />,
    text: () => <Trans>Sort your friends into categories</Trans>,
  },
  {
    icon: () => <MdWebAsset {...iconSize(18)} />,
    text: () => <Trans>A new title bar for chat windows</Trans>,
  },
  {
    icon: () => <MdCallEnd {...iconSize(18)} />,
    text: () => <Trans>Push to talk fixes and a hang-up button</Trans>,
  },
];

const Card = styled("section", {
  base: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px 20px",
    borderRadius: "20px",
    background: "var(--md-sys-color-surface-container)",
    // Modern: same ring and shadow as the other Home cards (cardParts Panel)
    _modern: {
      boxShadow:
        "inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent), 0 10px 26px -14px rgb(0 0 0 / 0.55)",
    },
    color: "var(--md-sys-color-on-surface)",

    "@media (max-width: 640px)": {
      padding: "14px",
    },
  },
});

const Tag = styled("span", {
  base: {
    alignSelf: "flex-start",
    padding: "2px 8px",
    borderRadius: "var(--borderRadius-sm)",
    fontSize: "12px",
    fontWeight: 600,
    color: ACCENT,
    background: "color-mix(in srgb, #3BB8ED 16%, transparent)",
  },
});

const Title = styled("h2", {
  base: {
    margin: 0,
    paddingRight: "28px",
    fontSize: "16px",
    fontWeight: 700,
    lineHeight: 1.3,
  },
});

const List = styled("ul", {
  base: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "grid",
    // three across in the wide column, one per line in the narrow one
    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
    gap: "10px",

    "@media (max-width: 640px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      gap: "6px",
    },
  },
});

const Item = styled("li", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    fontSize: "13px",
    lineHeight: 1.4,
    color: "var(--md-sys-color-on-surface-variant)",

    "& svg": {
      flexShrink: 0,
      fill: ACCENT,
    },
  },
});

const NotesLink = styled("button", {
  base: {
    alignSelf: "flex-start",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: 0,
    border: 0,
    background: "none",
    font: "inherit",
    fontSize: "13px",
    fontWeight: 600,
    color: ACCENT,
    cursor: "pointer",

    "& svg": { fill: "currentColor" },
    "&:hover": { textDecoration: "underline" },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

const Close = styled("button", {
  base: {
    position: "absolute",
    top: "8px",
    right: "8px",
    width: "32px",
    height: "32px",
    display: "grid",
    placeItems: "center",
    border: 0,
    borderRadius: "var(--borderRadius-full)",
    background: "transparent",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",

    "& svg": { fill: "currentColor" },
    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

function readDismissed(): string | null {
  try {
    return localStorage.getItem(WHATS_NEW_KEY);
  } catch {
    return null;
  }
}

/**
 * Whether the What's New card shows, and its dismiss. Kept apart from the
 * card so Home can ask before it draws a frame for it.
 */
export function createWhatsNewState() {
  const [dismissed, setDismissed] = createSignal(readDismissed());

  const visible = () =>
    showWhatsNew({
      appVersion: pkg.version,
      highlightsRelease: HIGHLIGHTS_RELEASE,
      dismissed: dismissed(),
    });

  function dismiss() {
    setDismissed(HIGHLIGHTS_RELEASE);
    try {
      localStorage.setItem(WHATS_NEW_KEY, HIGHLIGHTS_RELEASE);
    } catch {
      // Private mode: hidden for this visit only
    }
  }

  return { visible, dismiss };
}

/**
 * "New in vX" card: this release's headline changes and a link to the full
 * patch notes. Dismissed per release.
 */
export function WhatsNewCard(props: {
  state: ReturnType<typeof createWhatsNewState>;
}) {
  const { openModal } = useModals();
  const { t } = useLingui();

  async function openNotes() {
    const changelogs = await fetchAllChangelogs().catch(() => []);
    if (changelogs.length) openModal({ type: "changelog_history", changelogs });
  }

  return (
    <Show when={props.state.visible()}>
      <Card aria-labelledby="home-whats-new-title">
        <Close
          type="button"
          aria-label={t`Dismiss`}
          onClick={() => props.state.dismiss()}
        >
          <MdClose {...iconSize(18)} />
        </Close>
        <Tag>
          <Trans>New in v{HIGHLIGHTS_RELEASE}</Trans>
        </Tag>
        <Title id="home-whats-new-title">
          <Trans>Friend categories, a new title bar and call fixes</Trans>
        </Title>
        <List>
          {/* eslint-disable-next-line solid/prefer-for -- HIGHLIGHTS is a
              module-level constant; nothing here is reactive. */}
          {HIGHLIGHTS.map((highlight) => (
            <Item>
              {highlight.icon()}
              <span>{highlight.text()}</span>
            </Item>
          ))}
        </List>
        <NotesLink type="button" onClick={openNotes}>
          <Trans>Read the patch notes</Trans>
          <MdArrowForward {...iconSize(16)} />
        </NotesLink>
      </Card>
    </Show>
  );
}

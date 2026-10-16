import { For, JSX, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { DiscordImportStatus, DiscordImportSummary } from "stoat.js";
import { styled } from "styled-system/jsx";

import { Column, Text } from "@revolt/ui";

/**
 * Screens shared by every "Import from …" modal (Discord, Stoat, and the
 * sources after it). Each source modal owns its explain screen, its start
 * request and anything source-specific (Discord's sticker step); the
 * progress, done and failed screens, the stage copy and the error copy for
 * the error types every source shares live here.
 *
 * Everything here is source-neutral: copy that names a source takes it as a
 * prop or parameter.
 */

/** The screens an import modal moves through. */
export type ImportScreen = "explain" | "importing" | "done" | "failed";

/**
 * Which screen to show for the tracked job. No job is the explain screen.
 * @param job Tracked job, if any
 */
export function importScreen(
  job: { status: DiscordImportStatus } | undefined,
): ImportScreen {
  if (!job) return "explain";
  if (job.status === "Completed") return "done";
  if (job.status === "Failed") return "failed";
  return "importing";
}

/**
 * Human label for an opaque server stage string, as a hook (the copy is
 * translated with the caller's lingui context).
 *
 * The returned function takes the stage and the job's `kind` wire value.
 * `kind` only changes the `Fetching` copy: `Template` reads the Discord
 * template, `StoatServer` the user's Stoat server, any other kind (or none)
 * gets the neutral copy. Unknown stages fall back to the raw value rather
 * than rendering "undefined", since later releases add stages that this
 * build has never heard of.
 *
 * The returned function's body is evaluated by `importShell.test.ts`: keep it
 * plain JavaScript (no type syntax inside the braces).
 */
export function useStageLabel(): (stage: string, kind?: string) => string {
  const { t } = useLingui();

  return (stage: string, kind?: string): string => {
    switch (stage) {
      case "Verifying":
        return t`Checking your verification code…`;
      case "Fetching":
        if (kind === "Template") return t`Reading the Discord template…`;
        if (kind === "StoatServer") return t`Reading your Stoat server…`;
        return t`Reading the source server…`;
      case "Server":
        return t`Creating your server…`;
      case "Roles":
        return t`Recreating roles and permissions…`;
      case "Channels":
        return t`Recreating channels…`;
      case "Assets":
        return t`Copying icons and emoji…`;
      case "Membership":
        return t`Setting you up as the owner…`;
      case "Invite":
        return t`Generating an invite…`;
      case "Stickers":
        return t`Importing stickers…`;
      case "Done":
        return t`Finishing up…`;
      case "":
        return t`Waiting for a worker…`;
      default:
        return stage;
    }
  };
}

/**
 * Copy for the start-request error types every import source shares, as a
 * hook (the copy is translated with the caller's lingui context).
 *
 * The returned function takes the error's `type` tag (the raw-fetch helpers
 * throw the parsed body, so read it with `discordImportErrorType`) and the
 * source's display name ("Discord", "Stoat"), which only the copy that has to
 * name the source uses. It returns `undefined` for any other type, so the
 * caller maps its own source-specific types and picks its own fallback.
 *
 * Side effects stay with the caller: on `ImportAlreadyInProgress` the caller
 * should still adopt the job it collided with.
 *
 * The returned function's body is evaluated by `importShell.test.ts`: keep it
 * plain JavaScript (no type syntax inside the braces).
 */
export function useImportErrorMessage(): (
  type: string | undefined,
  source: string,
) => string | undefined {
  const { t } = useLingui();

  return (type: string | undefined, source: string): string | undefined => {
    switch (type) {
      case "ImportAlreadyInProgress":
        return t`You already have an import running. Wait for it to finish before starting another.`;
      case "TooManyServers":
        return t`You've reached the maximum number of servers you can be in.`;
      case "ImportSourceNotFound":
        return t`We couldn't find that server on ${source}. Check the link and try again.`;
      case "ImportVerificationMissing":
        return t`We couldn't find your verification code on that server. Copy your code again, add it as the steps above describe, and try again.`;
      case "ImportBotNotInServer":
        return t`Our importer bot isn't in that server yet. Add it, then try again.`;
      case "ImportUpstreamUnavailable":
        return t`We couldn't reach ${source} right now. Try again in a few minutes.`;
      case "ImportSourceUnavailable":
        return t`Importing from ${source} is not available right now.`;
      default:
        return undefined;
    }
  };
}

/**
 * Track that reads as indeterminate when the server has not told us how many
 * items the current stage has.
 */
const ProgressTrack = styled("div", {
  base: {
    height: "6px",
    width: "100%",
    overflow: "hidden",
    borderRadius: "999px",
    background: "var(--md-sys-color-surface-container-highest)",
  },
});

const ProgressFill = styled("div", {
  base: {
    height: "100%",
    borderRadius: "999px",
    background: "var(--md-sys-color-primary)",
    transition: "width 0.3s ease",
  },
  variants: {
    // No usable total: sweep instead of pretending to know a percentage.
    // Reuses the existing `skeletonShimmer` keyframe rather than adding a new
    // one, so this needs no panda config change.
    indeterminate: {
      true: {
        width: "100%",
        background: "transparent",
        backgroundImage:
          "linear-gradient(90deg, transparent 0%, var(--md-sys-color-primary) 50%, transparent 100%)",
        backgroundSize: "200% 100%",
        animationName: "skeletonShimmer",
        animationDuration: "1.4s",
        animationIterationCount: "infinite",
        animationTimingFunction: "linear",
      },
    },
  },
});

/**
 * Invite block, mirroring the create-invite modal (including the Streamer Mode
 * blur, so finishing an import on stream does not leak the link).
 */
const Invite = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",

    "& code": {
      padding: "1em",
      userSelect: "all",
      wordBreak: "break-all",
      fontSize: "1.1em",
      textAlign: "center",
      fontFamily: "var(--fonts-monospace)",
    },
  },
  variants: {
    concealed: {
      true: {
        "& code": {
          filter: "blur(8px)",
          transition: "filter 0.15s ease",
          _hover: {
            filter: "none",
          },
        },
      },
    },
  },
});

/** Props for {@link ImportProgressScreen}. */
export type ImportProgressScreenProps = {
  /** Opaque server stage string */
  stage: string;
  /** Job kind wire value; only picks the `Fetching` copy */
  kind?: string;
  /** Items completed within the current stage */
  done: number;
  /** Items in the current stage; 0 means indeterminate */
  total: number;
};

/**
 * Importing screen: the stage, a progress bar, and a note that the modal can
 * be closed while the job runs.
 */
export function ImportProgressScreen(props: ImportProgressScreenProps) {
  const stageLabel = useStageLabel();

  return (
    <Column>
      <Text>{stageLabel(props.stage, props.kind)}</Text>
      <ProgressTrack>
        {/* `total` is legitimately 0 while a stage is indeterminate —
            dividing by it would render a NaN-wide bar. */}
        <ProgressFill
          indeterminate={!(props.total > 0)}
          style={
            props.total > 0
              ? {
                  width: `${Math.min(
                    100,
                    Math.round((props.done / props.total) * 100),
                  )}%`,
                }
              : undefined
          }
        />
      </ProgressTrack>
      <Show when={props.total > 0}>
        <Text class="label">
          {props.done} / {props.total}
        </Text>
      </Show>
      <Text class="label">
        <Trans>
          You can close this — the import keeps going and we'll let you know
          when it's ready.
        </Trans>
      </Text>
    </Column>
  );
}

/** Props for {@link ImportDoneScreen}. */
export type ImportDoneScreenProps = {
  /**
   * Opening copy, rendered in a `Text`. Source-specific: it says where to
   * paste the invite.
   */
  intro: JSX.Element;
  /** Full invite URL */
  inviteLink: string;
  /** Whether Streamer Mode hides invites (blurs the link) */
  concealed: boolean;
  /** What the import did; absent until the job fetch fills it */
  summary?: DiscordImportSummary;
  /** Error from the modal's last action, shown at the bottom */
  actionError?: string;
  /** Source-specific sections after the summary (Discord: the sticker offer) */
  children?: JSX.Element;
};

/**
 * Done screen for a server import: the invite to bring members over and the
 * import summary.
 */
export function ImportDoneScreen(props: ImportDoneScreenProps) {
  const { t } = useLingui();

  return (
    <Column>
      {/* No invite when the server has no channel everyone can view */}
      <Show
        when={props.inviteLink}
        fallback={
          <Text>
            <Trans>Your server is ready.</Trans>
          </Text>
        }
      >
        <Text>{props.intro}</Text>

        <Invite concealed={props.concealed}>
          <code>{props.inviteLink}</code>
          <Show when={props.concealed}>
            <Text class="label">
              <Trans>
                Streamer Mode is hiding your invite link — hover over it to
                reveal.
              </Trans>
            </Text>
          </Show>
        </Invite>
      </Show>

      <Show when={props.summary}>
        <Text class="label">
          <Trans>Notes</Trans>
        </Text>
        <Text>
          {t`Created ${props.summary!.channels_created} channels, ${props.summary!.categories_created} categories and ${props.summary!.roles_created ?? 0} roles.`}
        </Text>
        {/* Server-generated English; intentionally rendered verbatim. */}
        <For each={props.summary!.notes}>
          {(note) => <Text class="label">{note}</Text>}
        </For>
      </Show>

      {props.children}

      <Show when={props.actionError}>
        <Text class="label">{props.actionError}</Text>
      </Show>
    </Column>
  );
}

/** Props for {@link ImportFailedScreen}. */
export type ImportFailedScreenProps = {
  /** The job's failure text; already user-safe server-side */
  error?: string;
  /** Error from the modal's last action, shown at the bottom */
  actionError?: string;
  /** Source-specific help after the failure text (Discord: the bot link) */
  children?: JSX.Element;
};

/**
 * Failed screen: a heading and the job's failure text, verbatim.
 */
export function ImportFailedScreen(props: ImportFailedScreenProps) {
  return (
    <Column>
      <Text>
        <Trans>The import didn't finish.</Trans>
      </Text>
      {/* Already user-safe server-side; shown verbatim. */}
      <Text>{props.error}</Text>
      {props.children}
      <Show when={props.actionError}>
        <Text class="label">{props.actionError}</Text>
      </Show>
    </Column>
  );
}

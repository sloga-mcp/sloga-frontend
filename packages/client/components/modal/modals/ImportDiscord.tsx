import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { ImportSource } from "stoat.js";

import {
  clearDiscordImport,
  discordImportErrorType,
  discordImportView,
  importDiscordStickerClientId,
  sourceLabel as importSourceLabel,
  resumeDiscordImport,
  trackDiscordImport,
  trackDiscordImportJob,
  trackedImportSource,
} from "@revolt/client/discordImport";
import { inviteUrl } from "@revolt/common";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { streamerModeHides } from "@revolt/state/streamer";
import { Column, Dialog, DialogProps, Text, TextField } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  ImportDoneScreen,
  ImportFailedScreen,
  ImportProgressScreen,
  importScreen,
  useImportErrorMessage,
} from "./ImportShell";

/**
 * Where the user finds a template link in Discord.
 */
const BREADCRUMB = "Discord → Server Settings → Templates → Create Template";

/**
 * Whether a job kind belongs in this modal. The import store holds one job
 * of any source; this hides every job whose kind names another source.
 *
 * It cannot hide a job whose kind is not known yet, and no kind counts as a
 * Discord job: a template job tracked straight from its POST
 * (`trackDiscordImport(job_id)`) has no kind until a job fetch, and rows
 * written before kinds existed carry none. Other-platform jobs are tracked
 * with their kind from their POST, and one this device first hears of
 * through an event (started on another device) gets its kind from the
 * worker's job fetch; until that fetch lands, or if it fails, such a job
 * reads kind-less and so shows here.
 *
 * The body is evaluated by `importShell.test.ts`: keep it plain JavaScript.
 * @param kind Job kind wire value
 */
function isDiscordJobKind(kind: string | undefined): boolean {
  return kind === undefined || kind === "Template" || kind === "Stickers";
}

/**
 * Import a Discord server's structure from a guild-template link.
 */
export function ImportDiscordModal(
  props: DialogProps & Modals & { type: "import_discord" },
) {
  const { t } = useLingui();
  const state = useState();
  const navigate = useNavigate();
  const { openModal } = useModals();

  const [template, setTemplate] = createSignal("");
  const [starting, setStarting] = createSignal(false);
  const [startError, setStartError] = createSignal<string | undefined>();
  /**
   * Another platform's import that the last start request collided with.
   * The store then holds that job, which this modal does not show, so the
   * explain screen names it and offers to open it in its own modal.
   */
  const [otherSource, setOtherSource] = createSignal<
    ImportSource | undefined
  >();

  const importErrorMessage = useImportErrorMessage();

  /**
   * The tracked job, if it is a Discord one. Every read of the store in this
   * modal goes through here, so the three `kind` branches below (the sticker
   * screens, the navigate-on-complete effect and the failed screen's retry)
   * only ever see Template or Sticker jobs; another source's job leaves this
   * modal on its explain screen.
   */
  const view = () => {
    const current = discordImportView();
    return current && isDiscordJobKind(current.kind) ? current : undefined;
  };
  const concealed = () => streamerModeHides(state.settings, "invites");

  /**
   * Which screen to show. Derived entirely from the shared store so the modal
   * can be dismissed and reopened without losing the job.
   */
  const screen = () => importScreen(view());

  const link = () => {
    const code = view()?.inviteCode;
    return code ? inviteUrl(code) : "";
  };

  /** Whether the tracked job is a sticker run rather than a template import. */
  const isStickerJob = () => view()?.kind === "Stickers";

  /**
   * Whether the finished template import can offer the sticker step: the
   * instance has the bot configured AND the job knows its source guild
   * (pre-slice-2 jobs don't).
   */
  const stickerOffer = () =>
    !isStickerJob() && !!view()?.sourceGuildId && !!importDiscordStickerClientId();

  /**
   * Bot-invite URL, guild preselected. `permissions=0` on purpose — reading
   * the sticker list needs no permission bits, and asking for none is the
   * honest ask.
   */
  const botInviteUrl = () => {
    const clientId = importDiscordStickerClientId();
    const guildId = view()?.sourceGuildId;
    return clientId && guildId
      ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=0&guild_id=${guildId}&disable_guild_select=true`
      : "";
  };

  // Land the user in the server they just imported. Deferred a tick, as in the
  // create-server modal, so the navigation does not race the modal's own
  // render. The modal is portaled and survives the route change, so the invite
  // stays on screen.
  // Keyed by job id, not a plain boolean, so a second import started from this
  // same modal instance still navigates.
  let navigatedJobId: string | undefined;
  createEffect(() => {
    const current = view();
    if (!current || current.status !== "Completed" || !current.serverId) return;
    // A finished STICKER run must not re-navigate: it has a fresh job id and
    // carries `serverId`, but the user is already wherever they want to be —
    // yanking them to the server mid-flow reads as a glitch.
    if (current.kind === "Stickers") return;
    if (navigatedJobId === current.jobId) return;
    navigatedJobId = current.jobId;
    setTimeout(() => navigate(`/server/${current.serverId}`));
  });

  /**
   * Adopt the job a start request collided with (`ImportAlreadyInProgress`),
   * so the user lands on its progress instead of a dead-end error. When that
   * job is another platform's, this modal cannot show it: say which source
   * it is from instead, and let the explain screen offer to open it.
   *
   * The body is evaluated by `importDiscordCollision.test.ts`: keep it plain
   * JavaScript (no type syntax inside the braces).
   */
  function adoptCollidedJob() {
    resumeDiscordImport(props.client).then(() => {
      const source = trackedImportSource();
      if (!source) return;
      const sourceLabel = importSourceLabel(source);
      setOtherSource(source);
      setStartError(t`You already have an import from ${sourceLabel} running.`);
    });
  }

  /**
   * Kick off the import.
   */
  async function start() {
    const value = template().trim();
    if (!value || starting()) return;

    setStarting(true);
    setStartError(undefined);
    setOtherSource(undefined);

    try {
      const { job_id } = await props.client.importDiscordTemplate(value);
      trackDiscordImport(job_id);
    } catch (error) {
      // The raw-fetch helper throws the PARSED BODY, not an Error, and drops
      // the status code — 409 is only identifiable by this tag.
      const type = discordImportErrorType(error);
      switch (type) {
        case "InvalidOperation":
          setStartError(
            t`That doesn't look like a Discord server template link.`,
          );
          break;
        case "OperationFailed":
          setStartError(t`Importing from Discord is not available right now.`);
          break;
        default:
          // The shared types (ImportAlreadyInProgress, TooManyServers, …)
          // read the same from every source.
          setStartError(
            importErrorMessage(type, "Discord") ??
              t`Could not start the import. Try again shortly.`,
          );
      }
      // Adopt the job we collided with, so the user lands on its progress
      // instead of a dead-end error.
      if (type === "ImportAlreadyInProgress") adoptCollidedJob();
    } finally {
      setStarting(false);
    }
  }

  /**
   * Kick off the sticker step against a Completed template job. The modal
   * flips back to the importing screen the moment the returned job row is
   * tracked; all the existing worker/poll/resume machinery follows the new
   * job unchanged.
   * @param parentJobId The Completed TEMPLATE job's id
   */
  async function startStickers(parentJobId: string) {
    if (starting()) return;

    setStarting(true);
    setStartError(undefined);
    setOtherSource(undefined);

    try {
      const job = await props.client.importDiscordStickers(parentJobId);
      trackDiscordImportJob(job);
    } catch (error) {
      switch (discordImportErrorType(error)) {
        case "ImportAlreadyInProgress":
          setStartError(
            t`You already have an import running. Wait for it to finish before starting another.`,
          );
          adoptCollidedJob();
          break;
        case "InvalidOperation":
          setStartError(
            t`Stickers can't be imported for this server. Try running the import again first.`,
          );
          break;
        case "OperationFailed":
          setStartError(t`Sticker import is not available right now.`);
          break;
        default:
          setStartError(t`Could not start the sticker import. Try again shortly.`);
      }
    } finally {
      setStarting(false);
    }
  }

  /**
   * Acknowledge a finished import and reset back to the explain screen.
   */
  function finish() {
    clearDiscordImport();
    setTemplate("");
    setStartError(undefined);
    setOtherSource(undefined);
    props.onClose();
  }

  /**
   * Actions per screen. Every handler returns `false`: a Dialog action that
   * returns a promise (or undefined) auto-closes the dialog, which would
   * unmount this the instant the import starts.
   */
  const actions = () => {
    switch (screen()) {
      case "explain":
        return [
          { text: <Trans>Cancel</Trans> },
          ...(otherSource()
            ? [
                {
                  text: <Trans>View it</Trans>,
                  // Returns nothing on purpose: this dialog closes as the
                  // other source's opens, like the create-server fan-outs.
                  onClick: () => {
                    openModal({
                      type: "import_source",
                      client: props.client,
                      source: otherSource(),
                    });
                  },
                },
              ]
            : []),
          {
            text: <Trans>Start import</Trans>,
            onClick: () => {
              start();
              return false;
            },
            isDisabled: !template().trim() || starting(),
          },
        ];
      case "importing":
        return [{ text: <Trans>Hide</Trans> }];
      case "done": {
        // A finished sticker run has no invite to copy — but if some
        // stickers didn't make it, offer to run again (creation is
        // idempotent by name, so a retry only fills the gaps).
        if (isStickerJob()) {
          const current = view()!;
          const canRetry =
            !!current.parentJobId &&
            (current.summary?.stickers_skipped ?? 0) > 0;
          return [
            ...(canRetry
              ? [
                  {
                    text: <Trans>Run again</Trans>,
                    onClick: () => {
                      if (!starting()) startStickers(current.parentJobId!);
                      return false;
                    },
                    isDisabled: starting(),
                  },
                ]
              : []),
            {
              text: <Trans>Done</Trans>,
              onClick: () => {
                finish();
                return false;
              },
            },
          ];
        }

        return [
          // Only once the user has had a chance to add the bot (the link is
          // in the body copy above these actions).
          ...(stickerOffer()
            ? [
                {
                  text: <Trans>Import stickers</Trans>,
                  onClick: () => {
                    startStickers(view()!.jobId);
                    return false;
                  },
                  isDisabled: starting(),
                },
              ]
            : []),
          {
            text: <Trans>Copy invite</Trans>,
            onClick: () => {
              navigator.clipboard.writeText(link());
              return false;
            },
          },
          {
            text: <Trans>Done</Trans>,
            onClick: () => {
              finish();
              return false;
            },
          },
        ];
      }
      case "failed":
        return [
          {
            text: <Trans>Close</Trans>,
            onClick: () => {
              finish();
              return false;
            },
          },
          {
            text: <Trans>Try again</Trans>,
            onClick: () => {
              // A second click while a retry POST is in flight must be a
              // no-op — falling through to the template-reset branch would
              // wipe the failed sticker context out of the store mid-flight.
              if (starting()) return false;

              // A failed sticker run retries the sticker POST against its
              // parent (both ride the wire, so this survives a reload); a
              // failed template import starts over from the explain screen.
              const current = view();
              if (current?.kind === "Stickers" && current.parentJobId) {
                startStickers(current.parentJobId);
              } else {
                clearDiscordImport();
                setStartError(undefined);
              }
              return false;
            },
          },
        ];
    }
  };

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Import from Discord</Trans>}
      actions={actions()}
    >
      <Switch>
        {/* ---------------------------------------------------- explain -- */}
        <Match when={screen() === "explain"}>
          <Column>
            <Text>
              <Trans>
                Paste a Discord server template link and we'll rebuild that
                server's layout here.
              </Trans>
            </Text>

            <Text class="label">
              <Trans>What comes across</Trans>
            </Text>
            <Text>
              <Trans>
                The server name, its categories and its channels in order, its
                roles with their colors and ranking, and who can see and do what
                in each channel — private channels included.
              </Trans>
            </Text>

            <Text class="label">
              <Trans>What doesn't</Trans>
            </Text>
            <Text>
              <Trans>
                Custom emojis and the server icon aren't in a Discord template,
                so they can't come across this way.
              </Trans>
            </Text>
            <Show when={importDiscordStickerClientId()}>
              <Text>
                <Trans>
                  Stickers can come across, though — once the import finishes,
                  we'll offer to fetch them for you.
                </Trans>
              </Text>
            </Show>
            <Text>
              <Trans>
                Bots aren't data — they're separate programs running against
                Discord, so there's nothing to copy. You'll set them up again
                here.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Members can't be copied either; we'll hand you an invite link
                at the end to bring them over.
              </Trans>
            </Text>
            <Text>
              <Trans>Message history stays on Discord.</Trans>
            </Text>

            <Text class="label">
              <Trans>Getting a link</Trans>
            </Text>
            {/* Sibling nodes, never nested inside <Trans>: an element inside a
                <Trans> is rendered once per branch, tripling its content. */}
            <Text>
              <Trans>In Discord, go to:</Trans>
            </Text>
            <Text>{BREADCRUMB}</Text>
            <Text>
              <Trans>then copy the link it gives you.</Trans>
            </Text>

            <TextField
              value={template()}
              variant="filled"
              label={t`Template link`}
              placeholder="https://discord.new/xxxxxxxxxxxx"
              // `onInput` catches a paste (the normal way a link arrives here);
              // `onChange` catches blur/enter on the mdui custom element.
              onInput={(e) => setTemplate(e.currentTarget.value)}
              onChange={(e) => setTemplate(e.currentTarget.value)}
            />

            <Show when={startError()}>
              <Text class="label">{startError()}</Text>
            </Show>
          </Column>
        </Match>

        {/* -------------------------------------------------- importing -- */}
        <Match when={screen() === "importing"}>
          {/* `kind` is pinned to Template, not read from the job: every job
              here is a Discord one, the only Discord job that reads
              `Fetching` is a template job (sticker jobs are born at
              `Stickers`), and a template job has no kind until its first
              job fetch. */}
          <ImportProgressScreen
            stage={view()!.stage}
            kind="Template"
            done={view()!.done}
            total={view()!.total}
          />
        </Match>

        {/* ------------------------------------------------- done: stickers */}
        <Match when={screen() === "done" && isStickerJob()}>
          <Column>
            <Text>
              {t`Imported ${view()!.summary?.stickers_created ?? 0} stickers.`}
            </Text>
            <Text class="label">
              <Trans>
                You can kick the importer bot from your Discord server now —
                it doesn't need to stay.
              </Trans>
            </Text>
            <Show when={view()!.summary?.notes.length}>
              <Text class="label">
                <Trans>Notes</Trans>
              </Text>
              {/* Server-generated English; intentionally rendered verbatim. */}
              <For each={view()!.summary!.notes}>
                {(note) => <Text class="label">{note}</Text>}
              </For>
            </Show>
          </Column>
        </Match>

        {/* ------------------------------------------------------- done -- */}
        <Match when={screen() === "done"}>
          <ImportDoneScreen
            intro={
              <Trans>
                Your server is ready. Paste this invite in Discord to bring your
                members over.
              </Trans>
            }
            inviteLink={link()}
            concealed={concealed()}
            summary={view()!.summary}
            actionError={startError()}
          >
            <Show when={stickerOffer()}>
              <Text class="label">
                <Trans>Stickers</Trans>
              </Text>
              <Text>
                <Trans>
                  Want your Discord server's stickers too? Add our importer
                  bot to it, then press Import stickers below.
                </Trans>
              </Text>
              {/* Sibling nodes, never nested inside <Trans> (triple-render
                  trap). External link: the desktop shell routes target=_blank
                  through the system browser. */}
              <Text>
                <a href={botInviteUrl()} target="_blank" rel="noreferrer">
                  <Trans>Add the importer bot on Discord</Trans>
                </a>
              </Text>
              <Text class="label">
                <Trans>
                  The bot only reads stickers, and you can kick it as soon as
                  they're in.
                </Trans>
              </Text>
            </Show>
          </ImportDoneScreen>
        </Match>

        {/* ----------------------------------------------------- failed -- */}
        <Match when={screen() === "failed"}>
          <ImportFailedScreen error={view()!.error} actionError={startError()}>
            {/* Live-smoke finding: the "bot not added yet" failure tells the
                user to add the bot but gave them nowhere to do it — the
                invite link lived only on the parent's done screen, which is
                gone by now. The view still knows the guild, so offer it. */}
            <Show when={isStickerJob() && botInviteUrl()}>
              <Text>
                <a href={botInviteUrl()} target="_blank" rel="noreferrer">
                  <Trans>Add the importer bot on Discord</Trans>
                </a>
              </Text>
            </Show>
          </ImportFailedScreen>
        </Match>
      </Switch>
    </Dialog>
  );
}

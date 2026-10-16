import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Client, DiscordImportStatus, ImportSource } from "stoat.js";
import { css } from "styled-system/css";

import {
  clearDiscordImport,
  discordImportErrorType,
  discordImportView,
  importDiscordEnabled,
  importSourceBotUrl,
  importSourceEnabled,
  sourceLabel as importSourceLabel,
  kindToSource,
  resumeDiscordImport,
  trackDiscordImport,
} from "@revolt/client/discordImport";
import { inviteUrl } from "@revolt/common";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { streamerModeHides } from "@revolt/state/streamer";
import {
  Button,
  CategoryButton,
  CircularProgress,
  Column,
  Dialog,
  DialogProps,
  Text,
  TextField,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

import {
  type ImportScreen,
  ImportDoneScreen,
  ImportFailedScreen,
  ImportProgressScreen,
  importScreen,
  useImportErrorMessage,
} from "./ImportShell";
import { type PickerEntry, pickerEntries } from "./importEntry";

/**
 * Every source, in the order the picker lists them. The picker shows only
 * those with an explain screen here that the instance has ready.
 */
const SOURCES: readonly ImportSource[] = ["stoat", "fluxer", "matrix"];

/**
 * Job kind wire value of each source's import. Passed when tracking a job
 * from its start request: the progress events carry no kind, and without it
 * the job reads as a Discord one until a job fetch lands.
 */
const SOURCE_KIND: Record<ImportSource, string> = {
  stoat: "StoatServer",
  fluxer: "FluxerServer",
  matrix: "MatrixSpace",
};

/** Screens of this modal: the shared import screens plus its own two. */
type SourceModalScreen = "picker" | "unavailable" | ImportScreen;

/**
 * Which screen to show. No source is the picker; a job of the source shows
 * its progress, outcome or failure; otherwise the source's explain screen,
 * or a notice when this build or the instance cannot import from it.
 *
 * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
 * @param source Source the modal is on, if one is picked
 * @param job Tracked job, ONLY if it is a job of `source`
 * @param explainable Whether `source` has an explain screen that can be offered
 */
function modalScreen(
  source: ImportSource | undefined,
  job: { status: DiscordImportStatus } | undefined,
  explainable: boolean,
): SourceModalScreen {
  if (!source) return "picker";
  if (job) return importScreen(job);
  return explainable ? "explain" : "unavailable";
}

/**
 * Whether a source has an explain screen in this modal that can be offered
 * now. Stoat and Fluxer have one; the store's own check also requires the
 * instance to have the source ready.
 *
 * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
 * @param source Import source
 */
function hasExplainScreen(source: ImportSource | undefined): boolean {
  return (
    (source === "stoat" || source === "fluxer") && importSourceEnabled(source)
  );
}

/**
 * Fetch today's verification code for `source`, tagged with the source it is
 * for: codes are per source, and the modal's resource keeps the previous
 * source's code while the next one loads.
 *
 * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
 * @param client Client to fetch with
 * @param source Source to fetch the code for
 */
async function fetchChallenge(
  client: Pick<Client, "fetchImportChallenge">,
  source: ImportSource,
) {
  const reply = await client.fetchImportChallenge(source);
  return { source, code: reply?.code };
}

/**
 * Write text to the clipboard. `navigator.clipboard` is missing outside
 * secure contexts and its promise rejects without focus, so both count as a
 * failure the caller reports.
 * @param text Text to copy
 * @returns whether the text was copied
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import a server from another platform (Stoat or Fluxer) through the
 * instance's importer bot. Without a `source` prop it opens on a picker of
 * the sources the instance has ready, led by Discord when the instance
 * offers it (picking Discord hands over to the Discord import modal).
 *
 * The import store holds one job of any source. This modal shows only a job
 * of the source it is on: a Discord job, or another platform's, never
 * renders here.
 */
export default function ImportSourceModal(
  props: DialogProps & Modals & { type: "import_source" },
) {
  const { t } = useLingui();
  const state = useState();
  const navigate = useNavigate();
  const { openModal } = useModals();
  const importErrorMessage = useImportErrorMessage();

  /** Source picked on the picker; only used when no `source` prop is given */
  const [picked, setPicked] = createSignal<ImportSource | undefined>();
  const [input, setInput] = createSignal("");
  const [starting, setStarting] = createSignal(false);
  const [startError, setStartError] = createSignal<string | undefined>();
  const [codeCopyFailed, setCodeCopyFailed] = createSignal(false);
  /**
   * The job the last start request collided with, when it is not one of
   * this modal's source: `"discord"` or the other platform. The store then
   * holds that job, which this modal does not show, so the explain screen
   * names it and offers to open it in its own modal.
   */
  const [collided, setCollided] = createSignal<
    ImportSource | "discord" | undefined
  >();

  /** The source this modal is on; `undefined` on the picker. */
  const source = () => props.source ?? picked();

  /**
   * The tracked job, if it is a job of this modal's source. Every read of
   * the store that drives a screen goes through here, so no other kind of
   * job (Discord, another platform, a job whose kind is not known yet) ever
   * renders in this modal. On the picker no job matches.
   *
   * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
   */
  const view = () => {
    const wanted = source();
    const current = discordImportView();
    return wanted && current && kindToSource(current.kind) === wanted
      ? current
      : undefined;
  };

  const screen = () =>
    modalScreen(source(), view(), hasExplainScreen(source()));

  const concealed = () => streamerModeHides(state.settings, "invites");

  const link = () => {
    const code = view()?.inviteCode;
    return code ? inviteUrl(code) : "";
  };

  /** Sources the picker lists. */
  const pickable = () => SOURCES.filter(hasExplainScreen);

  /** Rows of the picker: Discord first when offered, then the sources. */
  const entries = () => pickerEntries(importDiscordEnabled(), pickable());

  /** Display name of the current source ("Stoat"); not translated. */
  const label = () => {
    const wanted = source();
    return wanted ? importSourceLabel(wanted) : "";
  };

  const title = () => {
    if (!source()) return t`Import a server`;
    const sourceLabel = label();
    return t`Import from ${sourceLabel}`;
  };

  /**
   * Today's verification code, fetched while the explain screen is up (and
   * again each time it comes back, so a code that rolled over at midnight
   * is replaced).
   */
  const [challenge, { refetch: refetchChallenge }] = createResource(
    () => (screen() === "explain" ? source() : undefined),
    // The modal's client never changes, so reading it here is safe.
    (wanted) => fetchChallenge(props.client, wanted),
  );

  /**
   * The code, once fetched and well-formed, and only if it is the current
   * source's: after switching sources the resource still holds the previous
   * source's code until the new one lands. Never reads an errored resource.
   *
   * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
   */
  const challengeCode = () => {
    if (challenge.state !== "ready" && challenge.state !== "refreshing") {
      return undefined;
    }
    const latest = challenge.latest;
    if (!latest || latest.source !== source()) return undefined;
    const code = latest.code;
    return typeof code === "string" && code ? code : undefined;
  };

  /** Whether the code fetch finished without a usable code. */
  const challengeFailed = () =>
    challenge.state === "errored" ||
    (challenge.state === "ready" && !challengeCode());

  // Land the user in the server they just imported, as the Discord modal
  // does. Deferred a tick so the navigation does not race the modal's own
  // render; the modal is portaled and survives the route change. Keyed by
  // job id, so a second import from this same modal instance still
  // navigates.
  let navigatedJobId: string | undefined;
  createEffect(() => {
    const current = view();
    if (!current || current.status !== "Completed" || !current.serverId) return;
    if (navigatedJobId === current.jobId) return;
    navigatedJobId = current.jobId;
    const serverId = current.serverId;
    setTimeout(() => navigate(`/server/${serverId}`));
  });

  /**
   * Copy for a failed start request.
   *
   * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
   * @param type API error `type` tag
   * @param wanted Source the request was for
   */
  function startErrorMessage(
    type: string | undefined,
    wanted: ImportSource,
  ): string {
    if (wanted === "stoat") {
      if (type === "InvalidOperation" || type === "FailedValidation") {
        return t`That doesn't look like a Stoat invite link or server ID.`;
      }
      if (type === "ImportVerificationMissing") {
        return t`We couldn't find your verification code in the server description. Copy your code again, paste it there and try again.`;
      }
    }
    if (wanted === "fluxer") {
      if (type === "InvalidOperation" || type === "FailedValidation") {
        return t`That doesn't look like a Fluxer invite link or server ID.`;
      }
      if (type === "ImportVerificationMissing") {
        return t`We couldn't verify your role. Create a new role, name it exactly your code, and give it Manage Server yourself. Renaming a role that already had Manage Server (including the "Sloga Importer" role) doesn't count. The importer bot also needs Administrator to read the audit log.`;
      }
      // Also what a refused retry gets: Fluxer checks are rationed per user,
      // so a quick second try can be turned away while Fluxer is fine.
      if (type === "ImportUpstreamUnavailable") {
        return t`We couldn't reach Fluxer right now. Wait 30 seconds before trying again.`;
      }
    }
    return (
      importErrorMessage(type, importSourceLabel(wanted)) ??
      t`Could not start the import. Try again shortly.`
    );
  }

  /**
   * Adopt the job a start request collided with (`ImportAlreadyInProgress`).
   * A job of this modal's source then shows its progress here. Any other
   * job cannot show here: name it, and let the explain screen offer to open
   * it in its own modal.
   *
   * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
   */
  async function adoptCollidedJob() {
    await resumeDiscordImport(props.client);
    const current = discordImportView();
    if (!current) return;
    const other = kindToSource(current.kind);
    if (other === source()) {
      setStartError(undefined);
      return;
    }
    if (other) {
      const sourceLabel = importSourceLabel(other);
      setCollided(other);
      setStartError(t`You already have an import from ${sourceLabel} running.`);
    } else {
      setCollided("discord");
      setStartError(t`You already have a Discord import running.`);
    }
  }

  /**
   * Kick off the import.
   *
   * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
   */
  async function start() {
    const wanted = source();
    const value = input().trim();
    if (!wanted || !value || starting()) return;

    setStarting(true);
    setStartError(undefined);
    setCollided(undefined);

    try {
      const { job_id } = await props.client.importServer(wanted, value);
      trackDiscordImport(job_id, SOURCE_KIND[wanted]);
    } catch (error) {
      // The raw-fetch helper throws the PARSED BODY, not an Error, and drops
      // the status code; 409 is only identifiable by this tag.
      const type = discordImportErrorType(error);
      setStartError(startErrorMessage(type, wanted));
      if (type === "ImportAlreadyInProgress") adoptCollidedJob();
    } finally {
      setStarting(false);
    }
  }

  /** Forget anything typed or reported on the current source. */
  function resetForm() {
    setInput("");
    setStartError(undefined);
    setCollided(undefined);
    setCodeCopyFailed(false);
  }

  /**
   * Pick a source on the picker.
   * @param next Source picked
   */
  function pick(next: ImportSource) {
    resetForm();
    setPicked(next);
  }

  /**
   * Act on a picker row. Discord has its own modal: this one closes as that
   * one opens. Any other row is picked here.
   *
   * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
   * @param entry Row chosen
   */
  function choose(entry: PickerEntry) {
    if (entry === "discord") {
      props.onClose();
      openModal({ type: "import_discord", client: props.client });
      return;
    }
    pick(entry);
  }

  /** Copy the verification code. */
  async function copyCode() {
    const code = challengeCode();
    if (!code) return;
    setCodeCopyFailed(!(await copyToClipboard(code)));
  }

  /** Copy the finished import's invite link. */
  async function copyInvite() {
    const copied = await copyToClipboard(link());
    setStartError(
      copied
        ? undefined
        : t`Couldn't copy to the clipboard. Select the link and copy it yourself.`,
    );
  }

  /**
   * The instance's add-the-bot page for the current source, if it has one.
   *
   * The body is evaluated by `importSource.test.ts`: keep it plain JavaScript.
   */
  const botUrl = () => {
    const wanted = source();
    return wanted ? importSourceBotUrl(wanted) : undefined;
  };

  /** Open the instance's add-the-bot page for the current source. */
  function openBotPage() {
    const url = botUrl();
    // The desktop shells route a `_blank` window to the system browser.
    if (url) window.open(url, "_blank", "noopener");
  }

  /**
   * Acknowledge a finished import and close. Clears the store only when it
   * holds this modal's job: another kind of job is not this modal's to drop.
   */
  function finish() {
    if (view()) clearDiscordImport();
    resetForm();
    props.onClose();
  }

  /**
   * Actions per screen. Every handler that must keep the dialog open returns
   * `false`: a Dialog action that returns a promise (or undefined) closes
   * the dialog, which would unmount this the instant the import starts.
   */
  const actions = () => {
    const back = !props.source
      ? [
          {
            text: <Trans>Back</Trans>,
            onClick: () => {
              resetForm();
              setPicked(undefined);
              return false;
            },
          },
        ]
      : [];

    switch (screen()) {
      case "picker":
        return [{ text: <Trans>Cancel</Trans> }];
      case "unavailable":
        return [...back, { text: <Trans>Close</Trans> }];
      case "explain":
        return [
          { text: <Trans>Cancel</Trans> },
          ...back,
          ...(collided()
            ? [
                {
                  text: <Trans>View it</Trans>,
                  // Returns nothing on purpose: this dialog closes as the
                  // other import's opens, like the create-server fan-outs.
                  onClick: () => {
                    const other = collided();
                    if (other === "discord") {
                      openModal({
                        type: "import_discord",
                        client: props.client,
                      });
                    } else if (other) {
                      openModal({
                        type: "import_source",
                        client: props.client,
                        source: other,
                      });
                    }
                  },
                },
              ]
            : []),
          {
            text: <Trans>Import</Trans>,
            onClick: () => {
              start();
              return false;
            },
            isDisabled: !input().trim() || starting(),
          },
        ];
      case "importing":
        return [{ text: <Trans>Hide</Trans> }];
      case "done":
        return [
          // No invite was minted (no channel could carry one): there is
          // nothing to copy.
          ...(link()
            ? [
                {
                  text: <Trans>Copy invite</Trans>,
                  onClick: () => {
                    copyInvite();
                    return false;
                  },
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
              if (starting()) return false;
              // Back to the explain screen; the typed link stays.
              if (view()) clearDiscordImport();
              setStartError(undefined);
              setCollided(undefined);
              return false;
            },
          },
        ];
    }
  };

  // Parts every explain screen shares. Each is source-neutral: the copy
  // around them is the source's own. Local closures over this modal's state,
  // never module-scope styled components.

  /** Button that opens the current source's add-the-bot page. */
  const botButton = () => (
    <div>
      <Button variant="tonal" onPress={openBotPage} isDisabled={!botUrl()}>
        <Trans>Add the importer bot</Trans>
      </Button>
    </div>
  );

  /** The verification code to copy, or a retry when it could not load. */
  const codeBlock = () => (
    <>
      <Switch
        fallback={
          <div class={css({ height: "56px" })}>
            <CircularProgress />
          </div>
        }
      >
        <Match when={challengeCode()}>
          {(code) => (
            <CategoryButton
              icon={<Symbol size={22}>key</Symbol>}
              action="copy"
              onClick={copyCode}
            >
              <span class={css({ userSelect: "all" })}>{code()}</span>
            </CategoryButton>
          )}
        </Match>
        <Match when={challengeFailed()}>
          <Text class="label">
            <Trans>Couldn't load your verification code.</Trans>
          </Text>
          <div>
            <Button variant="text" onPress={() => refetchChallenge()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        </Match>
      </Switch>
      <Show when={codeCopyFailed()}>
        <Text class="label">
          <Trans>
            Couldn't copy to the clipboard. Select the code and copy it
            yourself.
          </Trans>
        </Text>
      </Show>
    </>
  );

  /**
   * The invite link or server ID field.
   * @param fieldLabel Field label, naming the source
   * @param placeholder Example of what to paste
   */
  const inviteField = (fieldLabel: string, placeholder: string) => (
    <TextField
      value={input()}
      variant="filled"
      label={fieldLabel}
      placeholder={placeholder}
      // `onInput` catches a paste (the normal way a link arrives here);
      // `onChange` catches blur/enter on the mdui custom element.
      onInput={(e) => setInput(e.currentTarget.value)}
      onChange={(e) => setInput(e.currentTarget.value)}
    />
  );

  /** Why the last start request failed, if it did. */
  const startErrorLine = () => (
    <Show when={startError()}>
      <Text class="label">{startError()}</Text>
    </Show>
  );

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={title()}
      actions={actions()}
    >
      <Switch>
        {/* ----------------------------------------------------- picker -- */}
        <Match when={screen() === "picker"}>
          <Column>
            <Show
              when={entries().length}
              fallback={
                <Text>
                  <Trans>No import sources are available right now.</Trans>
                </Text>
              }
            >
              <Text>
                <Trans>
                  Pick the app your server is on. We'll rebuild it here.
                </Trans>
              </Text>
              <For each={entries()}>
                {(entry) => (
                  <CategoryButton
                    icon={<Symbol size={22}>dns</Symbol>}
                    action="chevron"
                    onClick={() => choose(entry)}
                  >
                    {/* Proper nouns; not translated. */}
                    {entry === "discord" ? "Discord" : importSourceLabel(entry)}
                  </CategoryButton>
                )}
              </For>
            </Show>
          </Column>
        </Match>

        {/* ------------------------------------------------ unavailable -- */}
        <Match when={screen() === "unavailable"}>
          <Text>{importErrorMessage("ImportSourceUnavailable", label())}</Text>
        </Match>

        {/* ---------------------------------------------- explain: Stoat -- */}
        <Match when={screen() === "explain" && source() === "stoat"}>
          <Column>
            <Text>
              <Trans>
                Rebuild a server you manage on Stoat here, in four steps.
              </Trans>
            </Text>

            {/* Step numbers and every element stay OUTSIDE the Trans
                blocks: an element inside one is rendered once per branch. */}
            <Text class="label">
              {"1. "}
              <Trans>Add the importer bot to your Stoat server.</Trans>
            </Text>
            {botButton()}
            <Text>
              <Trans>Requires Manage Server on Stoat.</Trans>
            </Text>

            <Text class="label">
              {"2. "}
              <Trans>Let it see your private channels.</Trans>
            </Text>
            <Text>
              <Trans>
                Give the bot a role that can view every channel you want
                imported (your admin role is fine). Channels it can't see are
                skipped.
              </Trans>
            </Text>

            <Text class="label">
              {"3. "}
              <Trans>Prove you manage it.</Trans>
            </Text>
            {codeBlock()}
            <Text>
              <Trans>
                Paste this anywhere in your Stoat server's description (Server
                Settings → Overview). You can remove it after the import.
              </Trans>
            </Text>

            <Text class="label">
              {"4. "}
              <Trans>Paste your Stoat server's invite link or ID.</Trans>
            </Text>
            {inviteField(
              t`Stoat invite link or server ID`,
              "https://stoat.chat/invite/xxxxxxxx",
            )}

            {startErrorLine()}

            <Text class="label">
              <Trans>What comes across</Trans>
            </Text>
            <Text>
              <Trans>
                The server's name, description, icon and banner, its categories
                and channels, its roles and permissions, and its custom emoji.
              </Trans>
            </Text>
            <Text class="label">
              <Trans>What doesn't</Trans>
            </Text>
            <Text>
              <Trans>
                Members, messages, bans, invites and webhooks stay on Stoat.
              </Trans>
            </Text>
            <Text>
              <Trans>
                The bot leaves your Stoat server when the import finishes.
              </Trans>
            </Text>
          </Column>
        </Match>

        {/* --------------------------------------------- explain: Fluxer -- */}
        <Match when={screen() === "explain" && source() === "fluxer"}>
          <Column>
            <Text>
              <Trans>
                Rebuild a server you manage on Fluxer here, in three steps.
              </Trans>
            </Text>

            {/* Step numbers and every element stay OUTSIDE the Trans
                blocks: an element inside one is rendered once per branch. */}
            <Text class="label">
              {"1. "}
              <Trans>Add the importer bot to your Fluxer server.</Trans>
            </Text>
            {botButton()}
            <Text>
              <Trans>
                You need Administrator on Fluxer, or to own the server. The bot
                asks for Administrator so it can see private channels and the
                audit log.
              </Trans>
            </Text>

            <Text class="label">
              {"2. "}
              <Trans>
                Create a new role named exactly the code below and give it
                Manage Server.
              </Trans>
            </Text>
            {codeBlock()}
            <Text>
              <Trans>
                Keep it and the "Sloga Importer" role until the import finishes,
                then delete both. Finish within a day of adding the bot.
              </Trans>
            </Text>

            <Text class="label">
              {"3. "}
              <Trans>
                Paste your Fluxer server's invite link or server ID.
              </Trans>
            </Text>
            {inviteField(
              t`Fluxer invite link or server ID`,
              t`Invite link or server ID`,
            )}

            {startErrorLine()}

            <Text class="label">
              <Trans>What comes across</Trans>
            </Text>
            <Text>
              <Trans>
                The server's name, icon and banner, its categories and channels,
                its roles and permissions, and its custom emoji.
              </Trans>
            </Text>
            <Text class="label">
              <Trans>What doesn't</Trans>
            </Text>
            <Text>
              <Trans>
                Members, messages, bans, invites and webhooks stay on Fluxer.
                Fluxer servers have no description, so there is none to bring.
              </Trans>
            </Text>
            <Text>
              <Trans>
                The bot leaves your Fluxer server when the import ends.
              </Trans>
            </Text>
          </Column>
        </Match>

        {/* -------------------------------------------------- importing -- */}
        <Match when={screen() === "importing"}>
          <ImportProgressScreen
            stage={view()!.stage}
            kind={view()!.kind}
            status={view()!.status}
            done={view()!.done}
            total={view()!.total}
          />
        </Match>

        {/* ------------------------------------------------------- done -- */}
        <Match when={screen() === "done"}>
          <ImportDoneScreen
            intro={
              <Trans>
                Your server is ready. Share this invite to bring your members
                over.
              </Trans>
            }
            inviteLink={link()}
            concealed={concealed()}
            summary={view()!.summary}
            actionError={startError()}
          />
        </Match>

        {/* ----------------------------------------------------- failed -- */}
        <Match when={screen() === "failed"}>
          <ImportFailedScreen
            error={view()!.error}
            actionError={startError()}
          />
        </Match>
      </Switch>
    </Dialog>
  );
}

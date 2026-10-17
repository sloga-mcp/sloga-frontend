import { createEffect, onCleanup } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { Client } from "stoat.js";

import { useModals } from "@revolt/modal";
import { useSnackbar } from "@revolt/ui";

import { useClient, useClientLifecycle } from ".";
import {
  applyDiscordImportComplete,
  applyDiscordImportFailed,
  applyDiscordImportJob,
  applyDiscordImportProgress,
  discordImportInFlight,
  discordImportView,
  sourceLabel as importSourceLabel,
  kindToSource,
  noteDiscordImportAnnounced,
  primeImportDiscordFlag,
  resumeDiscordImport,
} from "./discordImport";

/**
 * How often to re-read the job while one is running, as a fallback for
 * dropped WS events. Deliberately slow — the events are the primary channel.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * Owns the import job (Discord or another platform) for the whole session.
 *
 * The import modal can be dismissed by clicking the scrim, and the job keeps
 * running server-side — so the WS handlers, the poll fallback and the resume
 * on boot all live here, at app level, not in the modal. The modal renders
 * whatever this leaves in the shared store.
 */
export function DiscordImportWorker() {
  const client = useClient();
  const { isLoggedIn } = useClientLifecycle();
  const { openModal, isOpen } = useModals();
  const snackbar = useSnackbar();
  const { t } = useLingui();

  /**
   * Tell the user an import reached its terminal state, unless the modal that
   * shows it is already open. A Discord job (no kind, `Template`, `Stickers`)
   * gets the Discord copy and modal; another platform's job gets its own
   * source's copy and the `import_source` modal opened on that source.
   *
   * The body is evaluated by `discordImportWorker.test.ts`: keep it plain
   * JavaScript (no type syntax inside the braces).
   * @param modalClient Client the modal opens with
   * @param kind Job kind wire value, if known
   * @param failed Whether the job failed
   */
  function announceImportOutcome(
    modalClient: Client,
    kind: string | undefined,
    failed: boolean,
  ) {
    const source = kindToSource(kind);

    if (!source) {
      if (isOpen("import_discord")) return;
      snackbar.show({
        message: failed
          ? t`Your Discord import failed.`
          : t`Your Discord import finished.`,
        action: failed ? t`Details` : t`View`,
        closeable: true,
        closeOnAction: true,
        onAction: () =>
          openModal({ type: "import_discord", client: modalClient }),
      });
      return;
    }

    if (isOpen("import_source")) return;
    const sourceLabel = importSourceLabel(source);
    snackbar.show({
      message: failed
        ? t`Your ${sourceLabel} import failed.`
        : t`Your ${sourceLabel} import finished.`,
      action: failed ? t`Details` : t`View`,
      closeable: true,
      closeOnAction: true,
      onAction: () =>
        openModal({ type: "import_source", client: modalClient, source }),
    });
  }

  // Subscribe to the three private-topic events and recover any job that
  // outlived the last page load.
  createEffect(() => {
    if (!isLoggedIn()) return;

    const currentClient = client();
    if (!currentClient) return;

    primeImportDiscordFlag();

    /**
     * Whether the store already tracks this job, i.e. this device started or
     * resumed it, so the store holds whatever kind there is to know.
     * @param jobId Job id
     */
    const tracking = (jobId: string) => discordImportView()?.jobId === jobId;

    /**
     * Fetch a job's row into the store, resolving to its kind (`undefined`
     * if the fetch fails).
     * @param jobId Job id
     */
    const fetchKind = (jobId: string) =>
      currentClient
        .fetchDiscordImportJob(jobId)
        .then((job) => {
          applyDiscordImportJob(job);
          return job.kind;
        })
        .catch(() => undefined);

    const onProgress = (progress: {
      jobId: string;
      stage: string;
      done: number;
      total: number;
    }) => {
      const known = tracking(progress.jobId);
      applyDiscordImportProgress(progress);

      // The events carry no kind, so a job started on another device lands
      // here kind-less, and a kind-less job reads as a Discord one. Read its
      // row once to learn what it is.
      if (!known && tracking(progress.jobId)) fetchKind(progress.jobId);
    };

    const onComplete = (result: {
      jobId: string;
      serverId: string;
      inviteCode: string;
    }) => {
      const known = tracking(result.jobId);
      applyDiscordImportComplete(result);
      noteDiscordImportAnnounced(result.jobId);

      // The complete event carries no summary; fetch the finished row so the
      // done screen can show the skipped-items notes. A failed fetch is
      // fine: the invite is already in hand, notes are a nicety.
      const kind = fetchKind(result.jobId);

      // A job this device was not tracking (started elsewhere) has no known
      // kind yet, so wait for the row before picking the copy and modal.
      if (known) {
        announceImportOutcome(currentClient, discordImportView()?.kind, false);
      } else {
        kind.then((k) => announceImportOutcome(currentClient, k, false));
      }
    };

    const onFailed = (failure: { jobId: string; error: string }) => {
      const known = tracking(failure.jobId);
      applyDiscordImportFailed(failure);
      noteDiscordImportAnnounced(failure.jobId);

      if (known) {
        announceImportOutcome(currentClient, discordImportView()?.kind, true);
      } else {
        fetchKind(failure.jobId).then((k) =>
          announceImportOutcome(currentClient, k, true),
        );
      }
    };

    currentClient.addListener("discordImportProgress", onProgress);
    currentClient.addListener("discordImportComplete", onComplete);
    currentClient.addListener("discordImportFailed", onFailed);

    onCleanup(() => {
      currentClient.removeListener("discordImportProgress", onProgress);
      currentClient.removeListener("discordImportComplete", onComplete);
      currentClient.removeListener("discordImportFailed", onFailed);
    });

    // A job that reached a terminal state while this device was disconnected
    // never produced a `DiscordImportComplete` event here, so the resume path
    // is the only chance to tell the user. The recovered row carries its
    // kind, so it gets the same copy as the events would have.
    resumeDiscordImport(currentClient).then((recovered) => {
      if (!recovered) return;
      announceImportOutcome(
        currentClient,
        recovered.kind,
        recovered.status === "Failed",
      );
    });
  });

  // Poll fallback. This effect reads the whole view, so every progress event
  // re-runs it and restarts the timer — making it a watchdog that only ever
  // fires after POLL_INTERVAL_MS of silence. It also tears the timer down the
  // moment the job reaches a terminal status (or the user logs out), so an
  // interval can never outlive the job it was polling for.
  createEffect(() => {
    if (!isLoggedIn()) return;
    if (!discordImportInFlight()) return;

    const currentClient = client();
    if (!currentClient) return;

    const jobId = discordImportView()!.jobId;

    const timer = setInterval(() => {
      currentClient
        .fetchDiscordImportJob(jobId)
        .then(applyDiscordImportJob)
        .catch(() => {
          /* transient — the next tick retries, the sweeper fails it eventually */
        });
    }, POLL_INTERVAL_MS);

    onCleanup(() => clearInterval(timer));
  });

  return null;
}

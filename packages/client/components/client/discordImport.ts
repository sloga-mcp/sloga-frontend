import { createSignal } from "solid-js";

import type {
  Client,
  DiscordImportJobData,
  DiscordImportStatus,
  DiscordImportSummary,
  ImportSource,
} from "stoat.js";

import { CONFIGURATION } from "@revolt/common";

/**
 * "Import from Discord" client state, shared with the other-platform imports
 * (Stoat, Fluxer, Matrix): the server allows one active import per user, of
 * any source, so one store tracks it and each modal filters by the job kind.
 *
 * The job outlives the modal: the dialog scrim closes on any outside click,
 * and the job keeps running server-side. So the authoritative view lives here
 * (module scope, one per tab) and is driven by the app-level
 * `DiscordImportWorker`; the modal is a pure view over it. Losing the modal
 * must never lose the invite code.
 */

/**
 * Id of the import job this device most recently started, so a full reload
 * can recover a job that has ALREADY finished — `/import/discord/active`
 * only ever returns `Queued`/`Running` jobs.
 */
const JOB_ID_KEY = "discord_import:job_id";

/**
 * Id of the job whose terminal outcome was last announced on this device.
 * Persisted alongside the job id — the job id survives reloads, so the
 * "already told the user" marker must too, or every boot re-announces.
 */
const ANNOUNCED_KEY = "discord_import:announced_job_id";

/* -------------------------------------------------------------------------- */
/* Feature flag                                                               */
/* -------------------------------------------------------------------------- */

/** What the root config route says about the importer. */
export type ImportDiscordFlags = {
  /** Whether the template importer is on at all */
  enabled: boolean;
  /**
   * Discord application id of the instance's importer bot, present only when
   * the optional sticker step is configured. The client builds the
   * bot-invite URL from it.
   */
  stickerClientId?: string;
  /** What the instance offers for importing from other platforms */
  importSources: ImportSourcesFeature;
};

/**
 * The root config route's `features.import_sources`: one key per source the
 * instance has ready, each carrying what the client needs to point the user
 * at that source's importer bot. An absent key means that source is dark.
 */
export type ImportSourcesFeature = {
  stoat?: { add_bot_url: string };
  fluxer?: { add_bot_url: string };
  matrix?: { bot_user_id: string };
};

/**
 * Sources this build has an import screen for. A source the instance offers
 * but this build cannot import from stays hidden: servers update ahead of
 * installed clients, so a newer instance may well advertise one.
 */
const IMPLEMENTED_IMPORT_SOURCES: readonly ImportSource[] = ["stoat"];

/**
 * Read `features.import_sources` defensively. Anything malformed reads as
 * `{}` (every source dark); unknown keys are ignored; a source whose entry
 * lacks its field, or whose bot URL is not an http(s) URL, is left out.
 * @param raw The `features.import_sources` value, whatever it is
 */
export function parseImportSources(raw: unknown): ImportSourcesFeature {
  const parsed: ImportSourcesFeature = {};
  if (!isRecord(raw)) return parsed;

  const stoat = httpUrl(isRecord(raw.stoat) ? raw.stoat.add_bot_url : null);
  if (stoat) parsed.stoat = { add_bot_url: stoat };

  const fluxer = httpUrl(isRecord(raw.fluxer) ? raw.fluxer.add_bot_url : null);
  if (fluxer) parsed.fluxer = { add_bot_url: fluxer };

  const matrix = isRecord(raw.matrix) ? raw.matrix.bot_user_id : null;
  if (typeof matrix === "string" && matrix) {
    parsed.matrix = { bot_user_id: matrix };
  }

  return parsed;
}

/**
 * Whether a value is a plain JSON object (not null, not an array).
 * @param value Anything
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The value, if it is an absolute http(s) URL. The bot URL is opened in a new
 * window, so anything else (`javascript:`, a relative path) is refused.
 * @param value Anything
 */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the server has the Discord importer enabled — and, since slice 2,
 * whether the sticker step is available — plus which other-platform sources
 * it offers (`features.import_sources`). One fetch primes all of them.
 *
 * Read with a raw `fetch` of the root config route, cloned from
 * `fetchStreamingFlags`. **Never read this from `client.configuration`:** the
 * client controller pre-assigns a locally-synthesized configuration stub from
 * env values, which makes `Client#fetchConfiguration()` short-circuit, so
 * `GET /` is never actually fetched and `features.import_discord` would be
 * `undefined` forever — failing closed and silently.
 */
export async function fetchImportDiscordFlags(): Promise<ImportDiscordFlags> {
  try {
    const response = await fetch(`${CONFIGURATION.DEFAULT_API_URL}/`);
    if (!response.ok) return { enabled: false, importSources: {} };
    const config = await response.json();
    const stickerClientId = config?.features?.import_discord_stickers;
    return {
      enabled: !!config?.features?.import_discord,
      stickerClientId:
        typeof stickerClientId === "string" && stickerClientId
          ? stickerClientId
          : undefined,
      importSources: parseImportSources(config?.features?.import_sources),
    };
  } catch {
    return { enabled: false, importSources: {} };
  }
}

const [flagEnabled, setFlagEnabled] = createSignal(false);
const [stickerClientId, setStickerClientId] = createSignal<string | undefined>(
  undefined,
);
const [importSourcesFlags, setImportSourcesFlags] =
  createSignal<ImportSourcesFeature>({});
let flagProbed = false;

/**
 * Kick off the one-time flag probe. Idempotent; safe to call from anywhere.
 */
export function primeImportDiscordFlag(): void {
  if (flagProbed) return;
  flagProbed = true;
  fetchImportDiscordFlags().then((flags) => {
    setFlagEnabled(flags.enabled);
    setStickerClientId(flags.stickerClientId);
    setImportSourcesFlags(flags.importSources);
  });
}

/**
 * Reactive accessor for the flag; primes the probe on first read so entry
 * points work even if they render before the worker mounts.
 */
export function importDiscordEnabled(): boolean {
  primeImportDiscordFlag();
  return flagEnabled();
}

/**
 * Reactive accessor for the sticker step's bot client id; `undefined` when
 * the instance has not configured the bot upgrade (the offer is hidden).
 */
export function importDiscordStickerClientId(): string | undefined {
  primeImportDiscordFlag();
  return stickerClientId();
}

/**
 * Reactive accessor for `features.import_sources`, as parsed; `{}` until the
 * probe lands, and for good if it fails.
 */
export function importSources(): ImportSourcesFeature {
  primeImportDiscordFlag();
  return importSourcesFlags();
}

/**
 * Whether importing from `source` can be offered: the instance has it ready
 * AND this build has a screen for it. Reactive.
 * @param source Import source
 */
export function importSourceEnabled(source: ImportSource): boolean {
  return (
    IMPLEMENTED_IMPORT_SOURCES.includes(source) && !!importSources()[source]
  );
}

/**
 * The instance's add-the-importer-bot URL for `source`, if it advertises
 * one (Matrix has a bot user id instead, so it never does). Reactive.
 * @param source Import source
 */
export function importSourceBotUrl(source: ImportSource): string | undefined {
  const entry = importSources()[source];
  return entry && "add_bot_url" in entry ? entry.add_bot_url : undefined;
}

/** Whether any other-platform import can be offered. Reactive. */
export function anyImportSourceEnabled(): boolean {
  return (["stoat", "fluxer", "matrix"] as const).some(importSourceEnabled);
}

/**
 * The import source a job kind belongs to; `undefined` for the Discord kinds
 * (`Template`, `Stickers`), no kind, and anything this build does not know.
 * @param kind Job kind wire value
 */
export function kindToSource(
  kind: string | undefined,
): ImportSource | undefined {
  switch (kind) {
    case "StoatServer":
      return "stoat";
    case "FluxerServer":
      return "fluxer";
    case "MatrixSpace":
      return "matrix";
    default:
      return undefined;
  }
}

/**
 * Display name of an import source. Proper nouns, so not translated.
 * @param source Import source
 */
export function sourceLabel(source: ImportSource): string {
  switch (source) {
    case "stoat":
      return "Stoat";
    case "fluxer":
      return "Fluxer";
    case "matrix":
      return "Matrix";
  }
}

/* -------------------------------------------------------------------------- */
/* Job view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything the UI needs about the in-flight (or just-finished) import.
 *
 * `stage` is an OPAQUE server string, deliberately not a union — a later
 * slice adds stages, and an exhaustive lookup on a deployed client would
 * render "undefined".
 */
export type DiscordImportView = {
  jobId: string;
  status: DiscordImportStatus;
  stage: string;
  /**
   * `Template` or `Stickers` — opaque-string rule like `stage`. Everything
   * the sticker screens branch on rides the WIRE (this field, `parentJobId`,
   * `sourceGuildId`), never client-side stashes: every event rebuilds this
   * view object wholesale, and a reload rebuilds it from a job fetch.
   */
  kind?: string;
  done: number;
  /** 0 means "indeterminate" — do NOT divide by this */
  total: number;
  /** Discord guild the template came from (bot-invite URL target) */
  sourceGuildId?: string;
  /** On a sticker job: the template job "Try again" re-POSTs against */
  parentJobId?: string;
  serverId?: string;
  inviteCode?: string;
  error?: string;
  summary?: DiscordImportSummary;
};

const [view, setView] = createSignal<DiscordImportView | undefined>(undefined);

/** The current import, if any. Reactive. */
export const discordImportView = view;

/**
 * The other-platform source of the tracked job, if it is one; `undefined`
 * for no job and for Discord jobs. Reactive.
 */
export function trackedImportSource(): ImportSource | undefined {
  return kindToSource(view()?.kind);
}

/** Whether an import is still running (or waiting to be claimed). */
export function discordImportInFlight(): boolean {
  const current = view();
  return !!current && !isTerminalStatus(current.status);
}

/**
 * Whether a status will never change again.
 * @param status Job status
 */
export function isTerminalStatus(status: DiscordImportStatus): boolean {
  return status === "Completed" || status === "Failed";
}

/**
 * Project a fetched job row onto the view.
 * @param job Job row
 */
function fromJob(job: DiscordImportJobData): DiscordImportView {
  return {
    jobId: job.job_id,
    status: job.status,
    stage: job.stage,
    kind: job.kind,
    done: job.done ?? 0,
    total: job.total ?? 0,
    sourceGuildId: job.source_guild_id,
    parentJobId: job.parent_job_id,
    serverId: job.server_id,
    inviteCode: job.invite_code,
    error: job.error,
    summary: job.summary,
  };
}

/**
 * Remember a job id across reloads.
 */
function persistJobId(jobId: string) {
  // Belt and braces against a wire-shape drift writing the literal string
  // "undefined", which then 404s on every boot until it self-deletes.
  if (!jobId) return;

  try {
    localStorage.setItem(JOB_ID_KEY, jobId);
  } catch {
    /* private mode / storage disabled — resume degrades, nothing breaks */
  }
}

/**
 * Forget the remembered job id.
 */
function forgetJobId() {
  try {
    localStorage.removeItem(JOB_ID_KEY);
    localStorage.removeItem(ANNOUNCED_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read the remembered job id.
 */
function rememberedJobId(): string | null {
  try {
    return localStorage.getItem(JOB_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * Begin tracking a job the moment the POST returns, before any event or poll
 * has landed.
 *
 * Pass `kind` whenever the caller knows it (every other-platform import
 * does): the progress events carry no kind, so without it the job reads
 * kind-less, which the Discord modal takes for a Discord job, until a job
 * fetch fills it in. The events keep whatever kind is set here.
 * @param jobId Job id
 * @param kind Job kind wire value, if known
 */
export function trackDiscordImport(jobId: string, kind?: string): void {
  persistJobId(jobId);
  setView(
    kind === undefined
      ? { jobId, status: "Queued", stage: "", done: 0, total: 0 }
      : { jobId, status: "Queued", stage: "", kind, done: 0, total: 0 },
  );
}

/**
 * Switch tracking to a freshly returned job ROW — the sticker-start POST
 * returns the whole new job, and `applyDiscordImportJob` would refuse it
 * (it deliberately ignores rows for jobs other than the one being tracked,
 * which at that moment is still the parent).
 * @param job Job row
 */
export function trackDiscordImportJob(job: DiscordImportJobData): void {
  persistJobId(job.job_id);
  setView(fromJob(job));
}

/**
 * Merge a fetched job row into the view.
 *
 * Ignores rows for a job other than the one being tracked, so a slow poll
 * response cannot resurrect a superseded import.
 * @param job Job row
 */
export function applyDiscordImportJob(job: DiscordImportJobData): void {
  const current = view();
  if (current && current.jobId !== job.job_id) return;
  persistJobId(job.job_id);
  setView(fromJob(job));
}

/**
 * Apply a `DiscordImportProgress` event.
 * @param progress Event payload
 */
export function applyDiscordImportProgress(progress: {
  jobId: string;
  stage: string;
  done: number;
  total: number;
}): void {
  const current = view();
  if (current && current.jobId !== progress.jobId) return;
  // A terminal view must not be dragged back into "running" by a late event.
  if (current && isTerminalStatus(current.status)) return;

  setView({
    ...(current ?? { jobId: progress.jobId, status: "Running" as const }),
    jobId: progress.jobId,
    status: "Running",
    stage: progress.stage,
    done: progress.done,
    total: progress.total,
  });
  persistJobId(progress.jobId);
}

/**
 * Apply a `DiscordImportComplete` event. The event carries no summary, so the
 * worker follows up with a job fetch to fill `summary`.
 * @param result Event payload
 */
export function applyDiscordImportComplete(result: {
  jobId: string;
  serverId: string;
  inviteCode: string;
}): void {
  const current = view();
  if (current && current.jobId !== result.jobId) return;

  persistJobId(result.jobId);
  setView({
    jobId: result.jobId,
    status: "Completed",
    stage: current?.stage ?? "Done",
    // Wire-derived identity fields carry over until the worker's follow-up
    // job fetch re-derives them from the row.
    kind: current?.kind,
    sourceGuildId: current?.sourceGuildId,
    parentJobId: current?.parentJobId,
    done: current?.done ?? 0,
    total: current?.total ?? 0,
    serverId: result.serverId,
    inviteCode: result.inviteCode,
    summary: current?.summary,
  });
}

/**
 * Apply a `DiscordImportFailed` event.
 * @param failure Event payload
 */
export function applyDiscordImportFailed(failure: {
  jobId: string;
  error: string;
}): void {
  const current = view();
  if (current && current.jobId !== failure.jobId) return;

  persistJobId(failure.jobId);
  setView({
    jobId: failure.jobId,
    status: "Failed",
    stage: current?.stage ?? "",
    // The failed screen's sticker retry branches on `kind` and re-POSTs
    // against `parentJobId` — they must survive the event rebuild.
    kind: current?.kind,
    sourceGuildId: current?.sourceGuildId,
    parentJobId: current?.parentJobId,
    done: current?.done ?? 0,
    total: current?.total ?? 0,
    error: failure.error,
  });
}

/**
 * Drop the tracked import once the user has acknowledged its outcome, so the
 * next open of the modal starts from the explain screen.
 */
export function clearDiscordImport(): void {
  forgetJobId();
  setView(undefined);
}

/**
 * Job ids whose terminal outcome has already been surfaced on this device.
 *
 * The resume path runs on every login and client swap, so without this a
 * recovered job would re-notify on every pass.
 */
const announcedTerminal = new Set<string>();

/**
 * Record that a job's outcome has already been shown to the user, so the
 * resume path does not announce it a second time.
 * @param jobId Job id
 */
export function noteDiscordImportAnnounced(jobId: string): void {
  announcedTerminal.add(jobId);
  try {
    localStorage.setItem(ANNOUNCED_KEY, jobId);
  } catch {
    /* private mode / storage disabled — de-dupe degrades to per-session */
  }
}

/**
 * Whether a job's outcome was already announced, on this page load or a
 * previous one.
 * @param jobId Job id
 */
function alreadyAnnounced(jobId: string): boolean {
  if (announcedTerminal.has(jobId)) return true;
  try {
    return localStorage.getItem(ANNOUNCED_KEY) === jobId;
  } catch {
    return false;
  }
}

/**
 * Recover any import this account has in flight — or one that finished while
 * the modal was dismissed / the tab was closed.
 *
 * `/import/discord/active` only knows about `Queued`/`Running` jobs, so a
 * completed job is recovered from the id remembered in local storage. Without
 * this, closing the modal loses the invite code permanently.
 * @param client Client
 * @returns the recovered job when it had ALREADY finished before this device
 * started listening — i.e. no `DiscordImportComplete`/`Failed` event reached
 * us, so nothing has told the user yet and the caller should surface it.
 * `undefined` when there is nothing to announce (still running, nothing to
 * recover, or already announced on this device).
 */
export async function resumeDiscordImport(
  client: Client,
): Promise<DiscordImportView | undefined> {
  try {
    const active = await client.fetchActiveDiscordImportJob();
    if (active) {
      setView(fromJob(active));
      persistJobId(active.job_id);
      return undefined;
    }
  } catch {
    /* offline or route missing — fall through to the remembered id */
  }

  const remembered = rememberedJobId();
  if (!remembered) return undefined;

  try {
    const job = await client.fetchDiscordImportJob(remembered);
    const recovered = fromJob(job);
    setView(recovered);

    // The job reached its terminal state while this device was not listening,
    // so no `DiscordImportComplete`/`Failed` event ever arrived and nothing has
    // told the user their invite is waiting. Hand it back so the caller can
    // surface it — exactly once per job, per device.
    if (
      isTerminalStatus(recovered.status) &&
      !alreadyAnnounced(recovered.jobId)
    ) {
      noteDiscordImportAnnounced(recovered.jobId);
      return recovered;
    }
  } catch {
    // 404 = not ours / pruned. Stop trying on every boot.
    forgetJobId();
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pull the API error `type` out of a rejection.
 *
 * The raw-fetch helpers throw the **parsed JSON body**, not an `Error`, and
 * drop the HTTP status — so 409 vs 400 is only distinguishable by this tag.
 * @param error Rejection value
 */
export function discordImportErrorType(error: unknown): string | undefined {
  if (error && typeof error === "object" && "type" in error) {
    const type = (error as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }

  return undefined;
}

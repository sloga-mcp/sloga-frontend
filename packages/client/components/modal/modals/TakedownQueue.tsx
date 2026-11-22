import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";

import { Plural, Trans, useLingui } from "@lingui-solid/solid/macro";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import {
  Button,
  CategoryButton,
  Column,
  Dialog,
  DialogProps,
  Text,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  type TakedownDetail,
  type TakedownErrorKind,
  type TakedownFileView,
  type TakedownRemoveResult,
  type TakedownSummary,
  type TakedownTargetView,
  AUDIT_REASON_MAX,
  DECLINE_NOTE_MAX,
  auditReasonHeader,
  classifyError,
  evidencePath,
  hiddenFileIds,
  isOpenStatus,
  isUrgent,
  msLeft,
  plannedCopyCount,
  previewKind,
  removableTargets,
  sortQueue,
  splitDuration,
} from "./takedownQueue";

/** A reviewer action; each posts to `/admin/takedown/requests/<id>/<path>` */
type Action =
  | "remove"
  | "decline"
  | "needs-info"
  | "child-safety"
  | "unhide"
  | "restore"
  | "close";

/** Public decline reasons (`TakedownPublicDecline`) */
type DeclineReason =
  | "NotIntimate"
  | "NotFound"
  | "NotOnSloga"
  | "Duplicate"
  | "Other";

/** An error answer from a staff route, kept whole for `classifyError` */
interface RouteError {
  routeStatus: number;
  body: unknown;
}

function isRouteError(error: unknown): error is RouteError {
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as RouteError).routeStatus === "number"
  );
}

/** A fetch that never throws to the reader: `ok` with data or the error kind */
type Loaded<T> = { ok: true; data: T } | { ok: false; kind: TakedownErrorKind };

const Section = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    userSelect: "text",
  },
});

const SectionTitle = styled("div", {
  base: {
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface)",
  },
});

/** Text the requester or a reviewer typed: kept as typed, never parsed */
const PlainText = styled("div", {
  base: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});

/** Ids and links: monospace, broken anywhere */
const Code = styled("div", {
  base: {
    fontFamily: "var(--fonts-monospace)",
    fontSize: "12px",
    overflowWrap: "anywhere",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Muted = styled("div", {
  base: {
    fontSize: "13px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Notice = styled("div", {
  base: {
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
  },
  variants: {
    tone: {
      error: {
        background: "var(--md-sys-color-error-container)",
        color: "var(--md-sys-color-on-error-container)",
      },
      info: {
        background: "var(--md-sys-color-secondary-container)",
        color: "var(--md-sys-color-on-secondary-container)",
      },
    },
  },
});

const ButtonRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const FileRow = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    paddingTop: "var(--gap-sm)",
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
  },
});

const Field = styled("label", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    fontSize: "13px",
    fontWeight: 600,
  },
});

const CheckRow = styled("label", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--gap-sm)",
    cursor: "pointer",
  },
});

const input = cva({
  base: {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "var(--borderRadius-sm)",
    border: "1px solid var(--md-sys-color-outline)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    font: "inherit",
    fontWeight: 400,
    fontSize: "14px",

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "1px",
    },
  },
});

const timeLeftText = cva({
  base: {
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  variants: {
    urgent: {
      true: {
        fontWeight: 600,
        color: "var(--md-sys-color-error)",
      },
    },
  },
});

/** Evidence preview: clipped so the blur never bleeds out of its box */
const PreviewFrame = styled("div", {
  base: {
    position: "relative",
    overflow: "hidden",
    maxWidth: "100%",
    width: "fit-content",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-highest)",
  },
});

const previewMedia = cva({
  base: {
    display: "block",
    maxWidth: "100%",
    maxHeight: "320px",
  },
  variants: {
    blurred: {
      true: {
        filter: "blur(32px) grayscale(1)",
        transform: "scale(1.1)",
        pointerEvents: "none",
        userSelect: "none",
      },
    },
  },
});

const revealButton = cva({
  base: {
    position: "absolute",
    inset: 0,
    margin: "auto",
    width: "fit-content",
    height: "fit-content",
    padding: "8px 16px",
    border: 0,
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-inverse-surface)",
    color: "var(--md-sys-color-inverse-on-surface)",
    font: "inherit",
    fontWeight: 600,
    cursor: "pointer",

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

/**
 * Take It Down review queue (reviewers only: privileged, on the server's
 * reviewer list, MFA on). Lists requests by deadline, shows one request's
 * requester details, targets, evidence and staff log, and runs the reviewer
 * actions, each with a reason and an MFA ticket.
 *
 * Requester details are personal data: rendered as plain text only, never
 * linked, never logged. Evidence is fetched only on request, blurred and
 * greyscale until revealed, never autoplayed, and its blob URL is revoked
 * when it leaves the screen.
 */
export function TakedownQueueModal(
  props: DialogProps & Modals & { type: "takedown_queue" },
) {
  const { t } = useLingui();
  const { mfaFlow, showError } = useModals();

  const [selected, setSelected] = createSignal<string | undefined>();
  const [action, setAction] = createSignal<Action | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const [done, setDone] = createSignal<string | undefined>();

  // Action form state, reset whenever an action is opened
  const [reason, setReason] = createSignal("");
  const [removeTargets, setRemoveTargets] = createSignal<number[]>([]);
  const [wholeMessage, setWholeMessage] = createSignal(false);
  const [includeCopies, setIncludeCopies] = createSignal(true);
  const [blockReuploads, setBlockReuploads] = createSignal(true);
  const [copiesConfirmed, setCopiesConfirmed] = createSignal(false);
  const [declineReason, setDeclineReason] = createSignal<
    DeclineReason | undefined
  >();
  const [badFaith, setBadFaith] = createSignal(false);
  const [declineNote, setDeclineNote] = createSignal("");
  const [unhideFiles, setUnhideFiles] = createSignal<string[]>([]);

  // Time left is recomputed every minute while the queue is open
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  /**
   * Call a staff route directly, as `ReportQueue` does: stoat-api's typed
   * client drops the body of routes missing from its generated tables. An
   * error answer is thrown as a `RouteError`.
   */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const api = props.client.api as unknown as {
      baseURL: string;
      auth: Record<string, string>;
    };

    const response = await fetch(api.baseURL + path, {
      method,
      cache: "no-store",
      headers: {
        ...api.auth,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let answer: unknown = await response.text().catch(() => "");
      try {
        answer = JSON.parse(answer as string);
      } catch {
        // Not JSON (a proxy page, a rate limit body): kept as text
      }
      throw { routeStatus: response.status, body: answer } as RouteError;
    }

    return response.status === 204 ? null : response.json();
  }

  /** GET a staff route; any failure comes back as an error kind */
  async function get<T>(path: string): Promise<Loaded<T>> {
    try {
      return { ok: true, data: (await call("GET", path)) as T };
    } catch (failure) {
      return {
        ok: false,
        kind: isRouteError(failure)
          ? classifyError(failure.routeStatus, failure.body)
          : "other",
      };
    }
  }

  const [queue, { refetch: refetchQueue }] = createResource(() =>
    get<TakedownSummary[]>("/admin/takedown/requests"),
  );

  // Opening a request marks it opened and logs the view on the server
  const [detail, { refetch: refetchDetail }] = createResource(
    selected,
    async (id) =>
      await get<TakedownDetail>(
        `/admin/takedown/requests/${encodeURIComponent(id)}`,
      ),
  );

  const rows = createMemo(() => {
    const loaded = queue();
    return loaded?.ok ? sortQueue(loaded.data) : [];
  });

  /** The open request's detail; never a previous request's while loading */
  const current = () => {
    const loaded = detail();
    return loaded?.ok && loaded.data.summary.id === selected()
      ? loaded.data
      : undefined;
  };

  /** Best-effort display name for a user id */
  function username(id?: string | null) {
    if (!id) return t`System`;
    const user = props.client.users.get(id);
    return user ? `${user.username}#${user.discriminator}` : id;
  }

  function formatDate(value?: string | null) {
    if (!value) return "";
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
  }

  function formatSize(bytes: number) {
    return new Intl.NumberFormat(undefined, {
      style: "unit",
      unit: "kilobyte",
      maximumFractionDigits: 0,
    }).format(Math.max(0, bytes) / 1024);
  }

  function statusLabel(status: string) {
    switch (status) {
      case "Received":
        return t`Received`;
      case "NeedsInfo":
        return t`Needs more information`;
      case "UnderReview":
        return t`Under review`;
      case "Removed":
        return t`Removed`;
      case "PartiallyRemoved":
        return t`Partly removed`;
      case "Declined":
        return t`Declined`;
      case "Closed":
        return t`Closed`;
      default:
        return status;
    }
  }

  function kindLabel(kind: string) {
    switch (kind) {
      case "Message":
        return t`Message`;
      case "File":
        return t`File`;
      case "User":
        return t`User`;
      case "Server":
        return t`Server`;
      case "Emoji":
        return t`Emoji`;
      default:
        return t`Could not be resolved`;
    }
  }

  /** Time left or overdue for an open request; the status for a closed one */
  function timeLeft(summary: TakedownSummary) {
    if (!isOpenStatus(summary.status)) return statusLabel(summary.status);
    const left = msLeft(summary.deadline_at, now());
    if (left === undefined) return statusLabel(summary.status);
    const { overdue, hours, minutes } = splitDuration(left);
    return overdue
      ? t`Overdue by ${hours} h ${minutes} min`
      : t`${hours} h ${minutes} min left`;
  }

  function flags(summary: TakedownSummary) {
    const list: string[] = [];
    if (summary.minor_claimed) list.push(t`Under 18 claimed`);
    if (summary.in_app) list.push(t`In-app report`);
    if (summary.child_safety) list.push(t`Child safety`);
    if (summary.throttled) list.push(t`Throttled`);
    if (summary.bad_faith_history) list.push(t`Bad-faith history`);
    if (summary.auto_hidden > 0) {
      const autoHidden = summary.auto_hidden;
      list.push(t`${autoHidden} auto-hidden`);
    }
    return list;
  }

  function errorText(kind: TakedownErrorKind, running?: Action) {
    switch (kind) {
      case "busy":
        return t`Another removal is running. Try again in a moment.`;
      case "reasonRequired":
        return t`Enter a reason for the staff log.`;
      case "reasonTooLong":
        return t`The reason is too long. Keep it under 512 characters.`;
      case "invalidBody":
        return t`The server did not accept this form. Check it and try again.`;
      case "notPrivileged":
        return t`Only reviewers with two-factor authentication turned on can handle these requests.`;
      case "mfa":
        return t`The two-factor check failed or expired. Try again.`;
      case "featureDisabled":
        return t`Restoring files is turned off.`;
      case "notFound":
        return t`This request could not be found.`;
      case "rateLimited":
        return t`Too many requests. Try again later.`;
      case "invalidOperation":
        if (running === "remove")
          return t`Nothing was removed. The copy count may have changed, or there was nothing left to remove. Reload the request and try again, or remove one target at a time.`;
        if (running === "unhide")
          return t`These files can't be shown again. Only files this request hid automatically, and that are still in place, can be.`;
        return t`This action doesn't apply to the request in its current state.`;
      default:
        return t`Something went wrong. Try again.`;
    }
  }

  /** Open a request (or go back to the list with `undefined`) */
  function openRequest(id: string | undefined) {
    setAction(undefined);
    setError(undefined);
    setDone(undefined);
    setSelected(id);
    if (!id) refetchQueue();
  }

  /** Open an action's form with its defaults */
  function startAction(next: Action) {
    setReason("");
    setRemoveTargets([]);
    setWholeMessage(false);
    setIncludeCopies(true);
    setBlockReuploads(true);
    setCopiesConfirmed(false);
    setDeclineReason(undefined);
    setBadFaith(false);
    setDeclineNote("");
    setUnhideFiles([]);
    setError(undefined);
    setDone(undefined);
    setAction(next);
  }

  function toggle<T>(list: T[], value: T, on: boolean) {
    return on
      ? list.includes(value)
        ? list
        : [...list, value]
      : list.filter((item) => item !== value);
  }

  const copyCount = () =>
    plannedCopyCount(
      current()?.targets ?? [],
      removeTargets(),
      includeCopies(),
    );

  /** Whether the open action's form is complete */
  function canSubmit() {
    if (busy() || !auditReasonHeader(reason())) return false;
    switch (action()) {
      case "remove":
        return (
          removeTargets().length > 0 && (copyCount() === 0 || copiesConfirmed())
        );
      case "decline":
        return !!declineReason();
      case "unhide":
        return unhideFiles().length > 0;
      case undefined:
        return false;
      default:
        return true;
    }
  }

  function actionBody(running: Action): unknown {
    switch (running) {
      case "remove": {
        const copies = copyCount();
        return {
          targets: removeTargets(),
          whole_message: wholeMessage(),
          include_copies: includeCopies(),
          block_reuploads: blockReuploads(),
          // The count the reviewer confirmed; the server refuses a removal
          // over its threshold unless this equals its own count
          confirm_copies:
            includeCopies() && copies > 0 && copiesConfirmed()
              ? copies
              : undefined,
        };
      }
      case "decline":
        return {
          reason: declineReason(),
          bad_faith: badFaith(),
          note: declineNote().trim() || undefined,
        };
      case "unhide":
        return { files: unhideFiles() };
      default:
        return undefined;
    }
  }

  /** Reason -> MFA ticket -> POST -> refetch */
  async function runAction() {
    const id = selected();
    const running = action();
    if (!id || !running || !canSubmit()) return;

    const reasonHeader = auditReasonHeader(reason());
    if (!reasonHeader) {
      setError(errorText("reasonRequired"));
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const ticket = await mfaFlow(await props.client.account.mfa());
      // Cancelled: nothing was sent
      if (!ticket) return;

      const result = await call(
        "POST",
        `/admin/takedown/requests/${encodeURIComponent(id)}/${running}`,
        actionBody(running),
        {
          "X-MFA-Ticket": ticket.token,
          "X-Audit-Log-Reason": reasonHeader,
        },
      );

      if (running === "remove" && result) {
        const removed = result as TakedownRemoveResult;
        const files = removed.removed_files;
        const messages = removed.deleted_messages;
        const copies = removed.copies;
        const blocked = removed.blocked;
        setDone(
          t`Removed. Files hidden: ${files} (copies: ${copies}). Messages deleted: ${messages}. Re-upload blocks: ${blocked}.`,
        );
      } else {
        setDone(t`Done.`);
      }

      setAction(undefined);
      refetchDetail();
      refetchQueue();
    } catch (failure) {
      if (isRouteError(failure)) {
        const kind = classifyError(failure.routeStatus, failure.body);
        if (kind === "other") showError(failure.body);
        else setError(errorText(kind, running));
      } else {
        showError(failure);
      }
    } finally {
      setBusy(false);
    }
  }

  function actionTitle(running: Action) {
    switch (running) {
      case "remove":
        return t`Remove`;
      case "decline":
        return t`Decline`;
      case "needs-info":
        return t`Ask for more information`;
      case "child-safety":
        return t`Move to child safety`;
      case "unhide":
        return t`Unhide files`;
      case "restore":
        return t`Restore files`;
      case "close":
        return t`Close request`;
    }
  }

  /** One evidence file: fetched on request, blurred and greyscale until revealed */
  function Evidence(evidenceProps: {
    file: TakedownFileView;
    requestId: string;
  }) {
    // eslint-disable-next-line solid/reactivity -- a file's type never changes
    const kind = previewKind(evidenceProps.file.content_type);
    const [url, setUrl] = createSignal<string | undefined>();
    const [state, setState] = createSignal<
      "idle" | "loading" | "ready" | "failed"
    >("idle");
    const [revealed, setRevealed] = createSignal(false);

    let controller: AbortController | undefined;
    let disposed = false;

    onCleanup(() => {
      disposed = true;
      controller?.abort();
      const objectUrl = url();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });

    /** Each fetch is logged on the server as an evidence view */
    async function fetchEvidence() {
      if (!kind || state() === "loading" || state() === "ready") return;
      setState("loading");
      controller = new AbortController();

      try {
        const base = props.client.configuration?.features.autumn.url;
        if (!base) throw new Error("NoUploadServer");

        const [header, value] = props.client.authenticationHeader;
        const response = await fetch(
          base + evidencePath(evidenceProps.file.id, evidenceProps.requestId),
          {
            headers: { [header]: value },
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("EvidenceUnavailable");

        const blob = await response.blob();
        if (disposed) return;

        setUrl(URL.createObjectURL(blob));
        setState("ready");
      } catch {
        // Never logged: the path names the request and the file
        if (!disposed) setState("failed");
      }
    }

    return (
      <Switch>
        <Match when={!kind}>
          <Muted>
            <Trans>No preview</Trans>
          </Muted>
        </Match>
        <Match when={state() === "ready" && url()}>
          {(objectUrl) => (
            <PreviewFrame>
              <Show
                when={kind === "video"}
                fallback={
                  <img
                    src={objectUrl()}
                    alt=""
                    draggable={false}
                    class={previewMedia({ blurred: !revealed() })}
                  />
                }
              >
                <video
                  src={objectUrl()}
                  controls={revealed()}
                  preload="metadata"
                  playsinline
                  class={previewMedia({ blurred: !revealed() })}
                />
              </Show>
              <Show when={!revealed()}>
                <button
                  type="button"
                  class={revealButton()}
                  onClick={() => setRevealed(true)}
                >
                  <Trans>Reveal</Trans>
                </button>
              </Show>
            </PreviewFrame>
          )}
        </Match>
        <Match when={state() === "loading"}>
          <Muted>
            <Trans>Loading…</Trans>
          </Muted>
        </Match>
        <Match when={state() === "idle" || state() === "failed"}>
          <Show when={state() === "failed"}>
            <Muted>
              <Trans>The preview could not be loaded.</Trans>
            </Muted>
          </Show>
          <ButtonRow>
            <Button
              size="small"
              variant="tonal"
              onPress={() => {
                setState("idle");
                void fetchEvidence();
              }}
            >
              <Trans>Load preview (blurred)</Trans>
            </Button>
          </ButtonRow>
          <Muted>
            <Trans>Each preview you load is recorded in the staff log.</Trans>
          </Muted>
        </Match>
      </Switch>
    );
  }

  function TargetBlock(targetProps: {
    target: TakedownTargetView;
    requestId: string;
  }) {
    const target = () => targetProps.target;
    const created = () => formatDate(target().created_at);
    const author = () => username(target().author_id);
    const unresolvable = () => target().unresolvable;

    return (
      <Section>
        <SectionTitle>
          {kindLabel(target().kind)} #{target().index + 1}
        </SectionTitle>
        <Show when={target().id}>
          <Code>{target().id}</Code>
        </Show>
        <Show when={target().server_id || target().channel_id}>
          <Code>
            {[target().server_id, target().channel_id]
              .filter(Boolean)
              .join(" / ")}
          </Code>
        </Show>
        <Show when={target().author_id}>
          <Muted>
            <Trans>Posted by {author()}</Trans>
          </Muted>
        </Show>
        <Show when={target().created_at}>
          <Muted>
            <Trans>Created {created()}</Trans>
          </Muted>
        </Show>
        <Show when={target().encrypted}>
          <Muted>
            <Trans>
              End-to-end encrypted: Sloga can't see this message's content.
            </Trans>
          </Muted>
        </Show>
        <Show when={unresolvable()}>
          <Muted>
            <Trans>Could not be resolved: {unresolvable()}</Trans>
          </Muted>
        </Show>
        <Show when={target().files.length === 0}>
          <Muted>
            <Trans>No files</Trans>
          </Muted>
        </Show>
        <For each={target().files}>
          {(file) => {
            const copies = () => file.copies;
            return (
              <FileRow>
                <Code>{file.id}</Code>
                <Muted>
                  {file.content_type} · {formatSize(file.size)} ·{" "}
                  <Plural
                    value={copies()}
                    one="# copy elsewhere"
                    other="# copies elsewhere"
                  />
                  <Show when={file.hidden}>
                    {" · "}
                    <Trans>Hidden</Trans>
                  </Show>
                </Muted>
                <Evidence file={file} requestId={targetProps.requestId} />
              </FileRow>
            );
          }}
        </For>
      </Section>
    );
  }

  /** The open action's form */
  function ActionForm(formProps: { detail: TakedownDetail }) {
    const detail = () => formProps.detail;
    const copies = () => copyCount();

    return (
      <Column>
        <Switch>
          <Match when={action() === "remove"}>
            <Text>
              <Trans>
                Hide the files of the targets you pick, take them out of their
                messages, profiles and servers, and email the requester and each
                uploader.
              </Trans>
            </Text>
            <For each={removableTargets(detail().targets)}>
              {(target) => (
                <CheckRow>
                  <input
                    type="checkbox"
                    checked={removeTargets().includes(target.index)}
                    onChange={(event) => {
                      setCopiesConfirmed(false);
                      setRemoveTargets((list) =>
                        toggle(list, target.index, event.currentTarget.checked),
                      );
                    }}
                  />
                  <span>
                    {kindLabel(target.kind)} #{target.index + 1}
                    <Code>{target.id}</Code>
                  </span>
                </CheckRow>
              )}
            </For>
            <CheckRow>
              <input
                type="checkbox"
                checked={wholeMessage()}
                onChange={(event) =>
                  setWholeMessage(event.currentTarget.checked)
                }
              />
              <span>
                <Trans>Delete the whole message, text included</Trans>
              </span>
            </CheckRow>
            <CheckRow>
              <input
                type="checkbox"
                checked={includeCopies()}
                onChange={(event) => {
                  setCopiesConfirmed(false);
                  setIncludeCopies(event.currentTarget.checked);
                }}
              />
              <span>
                <Trans>Also remove identical copies elsewhere on Sloga</Trans>
              </span>
            </CheckRow>
            <CheckRow>
              <input
                type="checkbox"
                checked={blockReuploads()}
                onChange={(event) =>
                  setBlockReuploads(event.currentTarget.checked)
                }
              />
              <span>
                <Trans>Block re-uploads of the same image</Trans>
              </span>
            </CheckRow>
            <Show when={includeCopies()}>
              <Text>
                <Trans>Identical copies elsewhere on Sloga: {copies()}</Trans>
              </Text>
            </Show>
            <Show when={includeCopies() && copies() > 0}>
              <CheckRow>
                <input
                  type="checkbox"
                  checked={copiesConfirmed()}
                  onChange={(event) =>
                    setCopiesConfirmed(event.currentTarget.checked)
                  }
                />
                <span>
                  <Plural
                    value={copies()}
                    one="Yes, also remove this # copy"
                    other="Yes, also remove all # copies"
                  />
                </span>
              </CheckRow>
            </Show>
          </Match>
          <Match when={action() === "decline"}>
            <Field>
              <Trans>Reason the requester is told</Trans>
              <select
                class={input()}
                value={declineReason() ?? ""}
                onChange={(event) =>
                  setDeclineReason(
                    (event.currentTarget.value || undefined) as
                      | DeclineReason
                      | undefined,
                  )
                }
              >
                <option value="" disabled>
                  {t`Pick a reason`}
                </option>
                <option value="NotIntimate">{t`Not an intimate image`}</option>
                <option value="NotFound">{t`Could not find it`}</option>
                <option value="NotOnSloga">{t`Not on Sloga`}</option>
                <option value="Duplicate">{t`Duplicate request`}</option>
                <option value="Other">{t`Other`}</option>
              </select>
            </Field>
            <CheckRow>
              <input
                type="checkbox"
                checked={badFaith()}
                onChange={(event) => setBadFaith(event.currentTarget.checked)}
              />
              <span>
                <Trans>
                  Made in bad faith (the requester is told "other", and later
                  requests from this address are flagged)
                </Trans>
              </span>
            </CheckRow>
            <Field>
              <Trans>
                Internal note (optional, never sent to the requester)
              </Trans>
              <textarea
                class={input()}
                rows={3}
                maxLength={DECLINE_NOTE_MAX}
                value={declineNote()}
                onInput={(event) => setDeclineNote(event.currentTarget.value)}
              />
            </Field>
          </Match>
          <Match when={action() === "needs-info"}>
            <Text>
              <Trans>
                The requester gets an email asking them to add details from
                their status link.
              </Trans>
            </Text>
          </Match>
          <Match when={action() === "child-safety"}>
            <Text>
              <Trans>
                Every file of every target is hidden now and kept on hold with
                no end date. The files are kept hidden, not deleted, so they
                stay available as evidence. Uploaders are not emailed, and
                unhide and restore stop working for this request.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Copies and the re-upload block still need a removal. File the
                CyberTipline report by hand.
              </Trans>
            </Text>
          </Match>
          <Match when={action() === "unhide"}>
            <Text>
              <Trans>
                Only files this request hid automatically can be shown again.
                Pick them below. If any file you pick was hidden another way,
                for example by a removal, nothing changes.
              </Trans>
            </Text>
            <For each={hiddenFileIds(detail().targets)}>
              {(id) => (
                <CheckRow>
                  <input
                    type="checkbox"
                    checked={unhideFiles().includes(id)}
                    onChange={(event) =>
                      setUnhideFiles((list) =>
                        toggle(list, id, event.currentTarget.checked),
                      )
                    }
                  />
                  <Code>{id}</Code>
                </CheckRow>
              )}
            </For>
          </Match>
          <Match when={action() === "restore"}>
            <Text>
              <Trans>
                After a successful appeal: show again the files this request hid
                that are still in place, and lift its re-upload blocks. Deleted
                messages stay deleted.
              </Trans>
            </Text>
          </Match>
          <Match when={action() === "close"}>
            <Text>
              <Trans>
                Removed files stay hidden for the hold period, then are deleted.
                Files hidden automatically that no removal took are shown again.
              </Trans>
            </Text>
          </Match>
        </Switch>

        <Field>
          <Trans>Reason for the staff log (required)</Trans>
          <input
            type="text"
            class={input()}
            maxLength={AUDIT_REASON_MAX}
            value={reason()}
            onInput={(event) => setReason(event.currentTarget.value)}
          />
        </Field>

        <Show when={error()}>
          <Notice tone="error" role="alert">
            {error()}
          </Notice>
        </Show>
      </Column>
    );
  }

  function DetailView(detailProps: { detail: TakedownDetail }) {
    const detail = () => detailProps.detail;
    const summary = () => detail().summary;
    const requester = () => detail().requester;
    const received = () => formatDate(summary().received_at);
    const status = () => statusLabel(summary().status);
    const open = () => isOpenStatus(summary().status);
    const closed = () => summary().status === "Closed";

    return (
      <Column>
        <Show when={done()}>
          <Notice tone="info" role="status">
            {done()}
          </Notice>
        </Show>
        <Show when={error()}>
          <Notice tone="error" role="alert">
            {error()}
          </Notice>
        </Show>

        <Section>
          <SectionTitle>{summary().reference}</SectionTitle>
          <Text>
            {status()}
            <Show when={open()}>
              {" · "}
              <span
                class={timeLeftText({ urgent: isUrgent(summary(), now()) })}
              >
                {timeLeft(summary())}
              </span>
            </Show>
          </Text>
          <Muted>
            <Trans>Received {received()}</Trans>
          </Muted>
          <Show when={flags(summary()).length}>
            <Muted>{flags(summary()).join(" · ")}</Muted>
          </Show>
        </Section>

        <Section>
          <SectionTitle>
            <Trans>Requester</Trans>
          </SectionTitle>
          <Show
            when={requester()}
            fallback={
              <Muted>
                <Trans>
                  The requester's details were deleted after the retention
                  period.
                </Trans>
              </Muted>
            }
          >
            {(person) => (
              <>
                <Text class="label">
                  <Trans>Role</Trans>
                </Text>
                <PlainText>
                  {person().role === "Authorized"
                    ? t`Authorized to act for the person shown`
                    : t`The person shown`}
                </PlainText>
                <Show when={person().authority_note}>
                  <Text class="label">
                    <Trans>How they are authorized</Trans>
                  </Text>
                  <PlainText>{person().authority_note}</PlainText>
                </Show>
                <Text class="label">
                  <Trans>Name</Trans>
                </Text>
                <PlainText>{person().name}</PlainText>
                <Text class="label">
                  <Trans>Signature</Trans>
                </Text>
                <PlainText>{person().signature}</PlainText>
                <Text class="label">
                  <Trans>Email</Trans>
                </Text>
                <PlainText>{person().email}</PlainText>
                <Text class="label">
                  <Trans>Description</Trans>
                </Text>
                <PlainText>{person().description}</PlainText>
                <Show when={person().extra}>
                  <Text class="label">
                    <Trans>More details</Trans>
                  </Text>
                  <PlainText>{person().extra}</PlainText>
                </Show>
                <Show when={person().added_info.length}>
                  <Text class="label">
                    <Trans>Added later</Trans>
                  </Text>
                  <For each={person().added_info}>
                    {(info) => <PlainText>{info}</PlainText>}
                  </For>
                </Show>
              </>
            )}
          </Show>
        </Section>

        <Section>
          <SectionTitle>
            <Trans>Where the image is (as given)</Trans>
          </SectionTitle>
          <Show
            when={detail().locations.length}
            fallback={
              <Muted>
                <Trans>No links given.</Trans>
              </Muted>
            }
          >
            {/* Plain text on purpose: never a link, never fetched */}
            <For each={detail().locations}>
              {(location) => <Code>{location}</Code>}
            </For>
          </Show>
        </Section>

        <SectionTitle>
          <Trans>Targets</Trans>
        </SectionTitle>
        <Show
          when={detail().targets.length}
          fallback={
            <Muted>
              <Trans>Nothing on Sloga was found for this request yet.</Trans>
            </Muted>
          }
        >
          <For each={detail().targets}>
            {(target) => (
              <TargetBlock target={target} requestId={summary().id} />
            )}
          </For>
        </Show>

        <Show when={detail().linked.length}>
          <Section>
            <SectionTitle>
              <Trans>Linked requests</Trans>
            </SectionTitle>
            <For each={detail().linked}>{(id) => <Code>{id}</Code>}</For>
          </Section>
        </Show>

        <Section>
          <SectionTitle>
            <Trans>Staff log</Trans>
          </SectionTitle>
          <For each={detail().audit}>
            {(entry) => (
              <div>
                <Muted>
                  {formatDate(entry.created_at)} · {username(entry.actor)} ·{" "}
                  {entry.action.replace(/^Takedown/, "")}
                  <Show
                    when={entry.count !== undefined && entry.count !== null}
                  >
                    {" · "}
                    {entry.count}
                  </Show>
                </Muted>
                <Show when={entry.note}>
                  <PlainText>{entry.note}</PlainText>
                </Show>
              </div>
            )}
          </For>
        </Section>

        <Section>
          <SectionTitle>
            <Trans>Actions</Trans>
          </SectionTitle>
          <ButtonRow>
            <Show when={!closed() && removableTargets(detail().targets).length}>
              <Button
                size="small"
                variant="tonal"
                onPress={() => startAction("remove")}
              >
                <Trans>Remove</Trans>
              </Button>
            </Show>
            <Show when={open()}>
              <Button
                size="small"
                variant="tonal"
                onPress={() => startAction("decline")}
              >
                <Trans>Decline</Trans>
              </Button>
              <Button
                size="small"
                variant="tonal"
                onPress={() => startAction("needs-info")}
              >
                <Trans>Ask for more information</Trans>
              </Button>
            </Show>
            <Show when={!summary().child_safety}>
              <Button
                size="small"
                variant="tonal"
                onPress={() => startAction("child-safety")}
              >
                <Trans>Move to child safety</Trans>
              </Button>
              <Show when={summary().auto_hidden > 0}>
                <Button
                  size="small"
                  variant="tonal"
                  onPress={() => startAction("unhide")}
                >
                  <Trans>Unhide files</Trans>
                </Button>
              </Show>
              <Button
                size="small"
                variant="tonal"
                onPress={() => startAction("restore")}
              >
                <Trans>Restore files</Trans>
              </Button>
            </Show>
            <Show when={!closed()}>
              <Button
                size="small"
                variant="tonal"
                onPress={() => startAction("close")}
              >
                <Trans>Close request</Trans>
              </Button>
            </Show>
            <Button
              size="small"
              variant="text"
              onPress={() => {
                setError(undefined);
                refetchDetail();
              }}
            >
              <Trans>Reload</Trans>
            </Button>
          </ButtonRow>
        </Section>
      </Column>
    );
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      minWidth={520}
      title={
        <Switch fallback={<Trans>Take It Down requests</Trans>}>
          <Match when={action()}>{(running) => actionTitle(running())}</Match>
          <Match when={selected()}>
            <Trans>Take It Down request</Trans>
          </Match>
        </Switch>
      }
      actions={
        action()
          ? [
              {
                text: <Trans>Cancel</Trans>,
                onClick: () => {
                  setAction(undefined);
                  setError(undefined);
                  return false;
                },
              },
              {
                text: <Trans>Confirm</Trans>,
                destructive:
                  action() === "remove" || action() === "child-safety",
                isDisabled: !canSubmit(),
                onClick: () => {
                  void runAction();
                  return false;
                },
              },
            ]
          : selected()
            ? [
                {
                  text: <Trans>Back</Trans>,
                  onClick: () => {
                    openRequest(undefined);
                    return false;
                  },
                },
                { text: <Trans>Close</Trans> },
              ]
            : [{ text: <Trans>Close</Trans> }]
      }
    >
      <Switch
        fallback={
          <Column>
            <Show when={queue.loading}>
              <Text>
                <Trans>Loading…</Trans>
              </Text>
            </Show>
            <Show when={queue()?.ok === false}>
              <Notice tone="error" role="alert">
                {errorText(
                  (queue() as { ok: false; kind: TakedownErrorKind }).kind,
                )}
              </Notice>
            </Show>
            <Show when={queue()?.ok && rows().length === 0}>
              <Text>
                <Trans>No Take It Down requests in the last 30 days.</Trans>
              </Text>
            </Show>
            <For each={rows()}>
              {(row) => {
                const received = () => formatDate(row.received_at);
                return (
                  <CategoryButton
                    onClick={() => openRequest(row.id)}
                    description={
                      <>
                        <Trans>Received {received()}</Trans>
                        <Show when={flags(row).length}>
                          {" · "}
                          {flags(row).join(" · ")}
                        </Show>
                      </>
                    }
                    action={
                      <span
                        class={timeLeftText({ urgent: isUrgent(row, now()) })}
                      >
                        {timeLeft(row)}
                      </span>
                    }
                  >
                    {row.reference}
                  </CategoryButton>
                );
              }}
            </For>
          </Column>
        }
      >
        <Match when={action() ? current() : undefined}>
          {(loaded) => <ActionForm detail={loaded()} />}
        </Match>
        <Match when={selected() && detail.loading && !current()}>
          <Text>
            <Trans>Loading…</Trans>
          </Text>
        </Match>
        <Match when={selected() && !detail.loading && detail()?.ok === false}>
          <Column>
            <Notice tone="error" role="alert">
              {errorText(
                (detail() as { ok: false; kind: TakedownErrorKind }).kind,
              )}
            </Notice>
          </Column>
        </Match>
        <Match when={current()}>
          {(loaded) => <DetailView detail={loaded()} />}
        </Match>
      </Switch>
    </Dialog>
  );
}

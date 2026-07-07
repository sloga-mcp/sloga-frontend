import { createFormControl, createFormGroup } from "solid-forms";
import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  CategoryButton,
  Column,
  Dialog,
  DialogProps,
  Form2,
  Text,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Message copy inside a snapshot
 */
interface SnapshotMessage {
  id: string;
  channel: string;
  author: string;
  content: string;
}

/**
 * Report as returned by GET /safety/reports
 */
interface Report {
  _id: string;
  author_id: string;
  content: {
    type: "Message" | "Server" | "User";
    id: string;
    report_reason: string;
  };
  additional_context: string;
  status: "Created" | "Rejected" | "Resolved";
  notes?: string;
}

/**
 * Snapshot as returned by GET /safety/reports/{id}
 */
interface Snapshot {
  _id: string;
  report_id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
}

/**
 * Review queue for content reports (privileged accounts only)
 */
export function ReportQueueModal(
  props: DialogProps & Modals & { type: "report_queue" },
) {
  const { t } = useLingui();
  const { openModal, showError } = useModals();

  const [selected, setSelected] = createSignal<Report | undefined>();

  /**
   * Call a safety route directly.
   *
   * stoat-api's typed client silently drops the body of requests to routes
   * missing from its generated route tables, so go through fetch instead.
   */
  async function apiCall(method: string, path: string, body?: unknown) {
    const api = props.client.api as unknown as {
      baseURL: string;
      auth: Record<string, string>;
    };

    const response = await fetch(api.baseURL + path, {
      method,
      headers: {
        ...api.auth,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) throw await response.text();
    return response.status === 204 ? null : response.json();
  }

  const [reports, { refetch }] = createResource(async () => {
    const all = (await apiCall("GET", "/safety/reports")) as Report[];
    return all.filter((report) => report.status === "Created");
  });

  const [details] = createResource(
    selected,
    async (report) =>
      (await apiCall("GET", `/safety/reports/${report._id}`)) as {
        report: Report;
        snapshots: Snapshot[];
      },
  );

  const group = createFormGroup({
    notes: createFormControl(""),
  });

  /**
   * Best-effort display name for a user id
   */
  function username(id?: string) {
    if (!id) return "unknown";
    const user = props.client.users.get(id);
    return user ? `${user.username}#${user.discriminator}` : id;
  }

  /**
   * Id of the user the report is about, for enforcement
   */
  function reportedUserId(): string | undefined {
    const report = selected();
    if (!report) return undefined;
    if (report.content.type === "User") return report.content.id;

    const snapshot = details()?.snapshots.find(
      (snapshot) =>
        snapshot.content._type === "ReporterMessage" ||
        snapshot.content._type === "Message",
    );
    return snapshot?.content.message?.author;
  }

  /**
   * Open the platform suspension modal for the reported user
   */
  async function suspendReportedUser() {
    const id = reportedUserId();
    if (!id) return;

    try {
      const user =
        props.client.users.get(id) ?? (await props.client.users.fetch(id));
      openModal({ type: "suspend_user", user, client: props.client });
    } catch (error) {
      showError(error);
    }
  }

  /**
   * Resolve or reject the selected report
   */
  async function review(status: "Resolved" | "Rejected") {
    const report = selected();
    if (!report) return;

    const notes = group.controls.notes.value.trim();

    try {
      if (status === "Rejected" && !notes) {
        throw new Error("NoReasonProvided");
      }

      await apiCall("POST", `/safety/reports/${report._id}/status`, {
        status,
        rejection_reason: status === "Rejected" ? notes : undefined,
        notes: notes || undefined,
      });

      group.controls.notes.setValue("");
      setSelected(undefined);
      refetch();
    } catch (error) {
      showError(error);
    }
  }

  /**
   * Render one snapshotted message line
   */
  function MessageLine(lineProps: {
    message: SnapshotMessage;
    highlight?: boolean;
  }) {
    return (
      <div
        style={{
          padding: "2px 6px",
          "border-radius": "4px",
          background: lineProps.highlight
            ? "var(--md-sys-color-error-container)"
            : "transparent",
        }}
      >
        <Text class="label">{username(lineProps.message.author)}</Text>{" "}
        <Text>{lineProps.message.content || <i>(no text content)</i>}</Text>
      </div>
    );
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        <Show when={selected()} fallback={<Trans>Report queue</Trans>}>
          <Trans>Review report</Trans>
        </Show>
      }
      actions={
        selected()
          ? [
              {
                text: <Trans>Back</Trans>,
                onClick: () => {
                  setSelected(undefined);
                  return false;
                },
              },
              {
                text: <Trans>Reject</Trans>,
                onClick: () => {
                  review("Rejected");
                  return false;
                },
              },
              {
                text: <Trans>Resolve</Trans>,
                onClick: () => {
                  review("Resolved");
                  return false;
                },
              },
            ]
          : [{ text: <Trans>Close</Trans> }]
      }
    >
      <Switch
        fallback={
          <Column>
            <Show when={reports.loading}>
              <Text>
                <Trans>Loading reports…</Trans>
              </Text>
            </Show>
            <Show when={reports()?.length === 0}>
              <Text>
                <Trans>No open reports. All clear!</Trans>
              </Text>
            </Show>
            <For each={reports()}>
              {(report) => (
                <CategoryButton
                  onClick={() => setSelected(report)}
                  description={
                    <>
                      {t`Reported by`} {username(report.author_id)}
                      {report.additional_context
                        ? ` — ${report.additional_context}`
                        : ""}
                    </>
                  }
                >
                  {report.content.type}: {report.content.report_reason}
                </CategoryButton>
              )}
            </For>
          </Column>
        }
      >
        <Match when={selected()}>
          <Column>
            <Text class="label">
              <Trans>Reason</Trans>
            </Text>
            <Text>
              {selected()!.content.report_reason}
              <Show when={selected()!.additional_context}>
                {" — "}
                {selected()!.additional_context}
              </Show>
            </Text>
            <Text class="label">
              <Trans>Reported by</Trans>
            </Text>
            <Text>{username(selected()!.author_id)}</Text>

            <Show when={details.loading}>
              <Text>
                <Trans>Loading snapshots…</Trans>
              </Text>
            </Show>

            <For each={details()?.snapshots}>
              {(snapshot) => (
                <Switch>
                  <Match when={snapshot.content._type === "ReporterMessage"}>
                    <Text class="label">
                      <Trans>Reported content (as seen by the reporter)</Trans>
                    </Text>
                    <div>
                      <For
                        each={(
                          snapshot.content.context as SnapshotMessage[]
                        ).filter(
                          (entry) => entry.id < snapshot.content.message.id,
                        )}
                      >
                        {(entry) => <MessageLine message={entry} />}
                      </For>
                      <MessageLine
                        message={snapshot.content.message}
                        highlight
                      />
                      <For
                        each={(
                          snapshot.content.context as SnapshotMessage[]
                        ).filter(
                          (entry) => entry.id > snapshot.content.message.id,
                        )}
                      >
                        {(entry) => <MessageLine message={entry} />}
                      </For>
                    </div>
                  </Match>
                  <Match when={snapshot.content._type === "Message"}>
                    <Text class="label">
                      <Trans>Reported content (server copy)</Trans>
                    </Text>
                    <MessageLine
                      message={{
                        id: snapshot.content.message._id,
                        channel: snapshot.content.message.channel,
                        author: snapshot.content.message.author,
                        content: snapshot.content.message.content ?? "",
                      }}
                      highlight
                    />
                  </Match>
                  <Match when={snapshot.content._type === "User"}>
                    <Text class="label">
                      <Trans>User profile snapshot</Trans>
                    </Text>
                    <Text>{snapshot.content.username}</Text>
                  </Match>
                  <Match when={snapshot.content._type === "Server"}>
                    <Text class="label">
                      <Trans>Server snapshot</Trans>
                    </Text>
                    <Text>{snapshot.content.name}</Text>
                  </Match>
                </Switch>
              )}
            </For>

            <Show when={reportedUserId()}>
              <CategoryButton
                onClick={suspendReportedUser}
                description={
                  <Trans>
                    Open platform suspension for the reported user.
                  </Trans>
                }
              >
                <Trans>Suspend {username(reportedUserId())}</Trans>
              </CategoryButton>
            </Show>

            <Form2.TextField
              name="notes"
              control={group.controls.notes}
              label={t`Moderator notes (used as reason when rejecting)`}
            />
          </Column>
        </Match>
      </Switch>
    </Dialog>
  );
}

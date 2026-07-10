import {
  Component,
  For,
  type JSX,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  splitProps,
} from "solid-js";

import { Plural, Trans, useLingui } from "@lingui-solid/solid/macro";
import {
  CalendarEvent,
  DataCreateEvent,
  DataEditEvent,
  EventRsvpData,
  FieldsEvent,
  Frequency,
  ImportResultData,
  InviteResultData,
  RecurrenceEnd,
  RsvpStatus,
  Server,
  ServerMember,
  ServerRole,
  Weekday,
} from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useNavigate, useParams } from "@revolt/routing";
import { Avatar, Button, Column, IconButton, Row, typography } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Typography text that also applies `style`. The shared `@revolt/ui` `Text`
 * drops any `style` prop (it forwards only to the typography cva), so we wrap a
 * span to keep colour/decoration styling working and type-clean.
 */
function Text(
  props: Parameters<typeof typography>[0] & {
    style?: JSX.CSSProperties;
    children?: JSX.Element;
  },
) {
  const [local, typo] = splitProps(props, ["style", "children"]);
  return (
    <span class={typography(typo)} style={local.style}>
      {local.children}
    </span>
  );
}

/** IANA timezone of this device — anchors recurrence + all-day semantics. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Weekdays in RRULE order, for the weekly recurrence picker. */
const WEEKDAYS: Weekday[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const FREQUENCIES: Frequency[] = ["Daily", "Weekly", "Monthly"];

/** A single expanded occurrence: the series plus one start instant (ms epoch). */
type Occurrence = { event: CalendarEvent; start: number };

export const ServerEvents: Component = () => {
  const params = useParams<{ server: string }>();
  const client = useClient();
  const navigate = useNavigate();
  const { showError } = useModals();

  const server = createMemo(() => client()!.servers.get(params.server));

  const today = new Date();
  const [viewYear, setViewYear] = createSignal(today.getFullYear());
  const [viewMonth, setViewMonth] = createSignal(today.getMonth());
  const [selectedDate, setSelectedDate] = createSignal<Date>(today);

  // The visible grid (including leading/trailing spill days).
  const calendarDays = createMemo(() => {
    const year = viewYear();
    const month = viewMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    // Leading blanks relative to the locale's start-of-week.
    const lead = (firstWeekday - weekStart() + 7) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));
    while (days.length % 7 !== 0) days.push(null);
    return days;
  });

  // Query window = first visible cell 00:00 → last visible cell 23:59:59.999 local.
  const windowRange = createMemo(() => {
    const days = calendarDays().filter((d): d is Date => !!d);
    const first = days[0] ?? new Date(viewYear(), viewMonth(), 1);
    const last = days[days.length - 1] ?? first;
    const from = new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate(),
      0,
      0,
      0,
      0,
    ).getTime();
    const to = new Date(
      last.getFullYear(),
      last.getMonth(),
      last.getDate(),
      23,
      59,
      59,
      999,
    ).getTime();
    // Pad ±1 day so an all-day occurrence anchored in another timezone (bucketed
    // by event-tz wall clock, not viewer-local) isn't clipped at the grid edges.
    const DAY = 24 * 60 * 60 * 1000;
    return { from: from - DAY, to: to + DAY };
  });

  const [events, { refetch }] = createResource(
    () => {
      const s = server();
      if (!s) return undefined;
      const { from, to } = windowRange();
      return [s.id, from, to] as const;
    },
    ([serverId, from, to]) =>
      client()!.calendarEvents.listForServer(serverId, from, to),
  );

  /** Whether the server has the events feature disabled. */
  const featureDisabled = createMemo(
    () => (events.error as { type?: string })?.type === "FeatureDisabled",
  );

  // Flatten series → per-occurrence instances.
  const occurrences = createMemo<Occurrence[]>(() => {
    // Reading an errored resource throws; the error surfaces via the empty state.
    if (events.error) return [];
    const rows = events();
    if (!rows) return [];
    const out: Occurrence[] = [];
    for (const row of rows) {
      for (const start of row.occurrences) {
        out.push({ event: row.event, start });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  });

  const occurrencesForDay = createMemo(() => {
    const key = dayKey(selectedDate());
    return occurrences().filter((o) => occurrenceDayKey(o) === key);
  });

  const daysWithOccurrences = createMemo(() => {
    const set = new Set<string>();
    for (const o of occurrences()) set.add(occurrenceDayKey(o));
    return set;
  });

  const upcoming = createMemo(() => {
    const now = Date.now();
    return occurrences()
      .filter((o) => o.start >= now)
      .slice(0, 5);
  });

  // --- Live reconciliation (stored handlers, removed by reference) -----------
  // Capture the client instance once so subscribe + unsubscribe target the same
  // object even if the accessor later resolves to a different one.
  const liveClient = client();
  const refetchGrid = debounced(() => refetch(), 150);
  const refreshDetailDebounced = debounced(() => refreshDetail(), 200);

  const onGridEvent = (event: CalendarEvent) => {
    if (event.serverId === server()?.id) refetchGrid();
  };
  const onRsvp = (event: CalendarEvent) => {
    // Refresh the open detail authoritatively (counts + attendee list); debounced
    // so a burst of RSVPs doesn't storm fetchContext/fetchAttendees or race them.
    if (openEvent()?.id === event.id) refreshDetailDebounced();
  };

  onMount(() => {
    liveClient.on("calendarEventCreate", onGridEvent);
    liveClient.on("calendarEventUpdate", onGridEvent);
    liveClient.on("calendarEventInvite", onGridEvent);
    liveClient.on("calendarEventRsvp", onRsvp);
  });
  onCleanup(() => {
    liveClient.removeListener("calendarEventCreate", onGridEvent);
    liveClient.removeListener("calendarEventUpdate", onGridEvent);
    liveClient.removeListener("calendarEventInvite", onGridEvent);
    liveClient.removeListener("calendarEventRsvp", onRsvp);
  });

  function prevMonth() {
    if (viewMonth() === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    if (viewMonth() === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else setViewMonth((m) => m + 1);
  }

  const canCreate = createMemo(() => !!server());

  // ------------------------------------------------------------------ detail
  const [openEvent, setOpenEvent] = createSignal<CalendarEvent | undefined>();
  const [attendees, setAttendees] = createSignal<EventRsvpData[]>([]);
  const [attendeesLoading, setAttendeesLoading] = createSignal(false);

  async function openDetail(event: CalendarEvent) {
    setShowCreate(false);
    setOpenEvent(event);
    setAttendees([]);
    // Batch member sync so attendee rows resolve names/avatars without per-row fetch.
    server()?.syncMembers().catch(() => {});
    await refreshDetail();
  }

  async function refreshDetail() {
    const event = openEvent();
    if (!event) return;
    try {
      await event.fetchContext();
    } catch {
      /* counts stay as-is */
    }
    await loadAttendees(true);
  }

  async function loadAttendees(reset: boolean) {
    const event = openEvent();
    if (!event) return;
    setAttendeesLoading(true);
    try {
      const current = reset ? [] : attendees();
      const before = reset
        ? undefined
        : current[current.length - 1]?.user;
      const page = await event.fetchAttendees({ limit: 100, before });
      setAttendees(reset ? page : [...current, ...page]);
    } catch (error) {
      showError(error);
    } finally {
      setAttendeesLoading(false);
    }
  }

  const attendeesByStatus = (status: RsvpStatus) =>
    attendees().filter((a) => a.status === status);

  const totalCount = createMemo(() => {
    const c = openEvent()?.counts;
    return c ? c.going + c.pending + c.not_going : 0;
  });
  const hasMoreAttendees = createMemo(
    () => attendees().length < totalCount(),
  );

  async function doRsvp(status: RsvpStatus) {
    const event = openEvent();
    if (!event) return;
    try {
      await event.rsvp(status); // optimistic + revert handled in the binding
    } catch (error) {
      showError(error);
    }
  }

  const canManage = createMemo(() => {
    const event = openEvent();
    if (!event) return false;
    return (
      event.creatorId === client().user?.id ||
      (server()?.havePermission("ManageChannel") ?? false)
    );
  });

  async function cancelOpenEvent() {
    const event = openEvent();
    if (!event) return;
    try {
      await event.cancel();
    } catch (error) {
      showError(error);
    }
  }

  // ------------------------------------------------------------------ create
  const [showCreate, setShowCreate] = createSignal(false);
  const [createDate, setCreateDate] = createSignal<Date>(new Date());
  const [saving, setSaving] = createSignal(false);

  function openCreate(date: Date) {
    setCreateDate(date);
    setShowCreate(true);
  }

  // -------------------------------------------------------------------- edit
  const [editEvent, setEditEvent] = createSignal<CalendarEvent | undefined>();

  // If the event is cancelled while the edit form is open (WS update — getters
  // are store-backed), drop back to the detail, which shows the cancelled state.
  createEffect(() => {
    if (editEvent()?.cancelled) setEditEvent(undefined);
  });

  async function saveEdit(diff: DataEditEvent) {
    const event = editEvent();
    if (!event) return;
    setSaving(true);
    try {
      await event.edit(diff);
      setEditEvent(undefined);
      refetch();
      await refreshDetail();
    } catch (error) {
      // An in-flight rejection (e.g. cancelled server-side) surfaces without
      // stranding the form; the user can adjust or back out.
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  // ------------------------------------------------------------------ import
  const [showImport, setShowImport] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [importResult, setImportResult] = createSignal<
    ImportResultData | undefined
  >();

  /** Server-level manage gate (import is manager-triggered; UX only — the
   *  server re-checks ManageChannel + source-channel ViewChannel). */
  const canManageServer = createMemo(
    () => server()?.havePermission("ManageChannel") ?? false,
  );

  async function runImport(channelId: string) {
    const s = server();
    if (!s) return;
    setImporting(true);
    try {
      const result = await client().calendarEvents.importLegacy(s.id, channelId);
      setImportResult(result);
      refetch();
    } catch (error) {
      showError(error);
    } finally {
      setImporting(false);
    }
  }

  // Reset transient view state when navigating between servers (the route param
  // can change without remounting), so an open detail / create form from server
  // A never bleeds into server B's roster.
  createEffect(
    on(
      () => params.server,
      () => {
        setOpenEvent(undefined);
        setShowCreate(false);
        setEditEvent(undefined);
        setShowImport(false);
        setImportResult(undefined);
        setAttendees([]);
      },
      { defer: true },
    ),
  );

  async function createEvent(
    data: DataCreateEvent,
    userIds: string[],
    roleIds: string[],
  ) {
    const s = server();
    if (!s) return;
    setSaving(true);
    try {
      const event = await client().calendarEvents.createForServer(s.id, data);
      // Role-only selections must invite too (slice-F audit fe-MED-3).
      if (userIds.length || roleIds.length) {
        try {
          const result = await event.invite(userIds, roleIds);
          if (result.invited === 0) {
            // Nobody was actually added (already invited / non-viewers /
            // pending deletion): land on the detail so the organizer sees the
            // real attendee state instead of assuming the invites went out.
            setShowCreate(false);
            refetch();
            openDetail(event);
            return;
          }
        } catch (error) {
          // Surface the partial failure and land the organizer on the event
          // detail so they can retry the invite (the event itself was created).
          showError(error);
          setShowCreate(false);
          refetch();
          openDetail(event);
          return;
        }
      }
      setShowCreate(false);
      refetch();
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageBase>
      <PageHeader>
        <IconButton onPress={() => navigate(`/server/${params.server}`)}>
          <Symbol>arrow_back</Symbol>
        </IconButton>
        <Text class="headline" size="medium" style={{ "margin-left": "8px" }}>
          <Trans>Server Events</Trans>
        </Text>
        <div style={{ flex: 1 }} />
        <Show when={canManageServer() && !featureDisabled()}>
          <Button
            variant="text"
            onPress={() => {
              setOpenEvent(undefined);
              setShowCreate(false);
              setEditEvent(undefined);
              setImportResult(undefined);
              setShowImport(true);
            }}
          >
            <Symbol size={18}>upload</Symbol>
            &nbsp;
            <Trans>Import legacy events</Trans>
          </Button>
        </Show>
      </PageHeader>

      <Switch>
        <Match when={featureDisabled()}>
          <EmptyState>
            <Symbol style={{ "font-size": "48px", color: "#FF8A00" }}>
              event_busy
            </Symbol>
            <Text class="headline" size="small">
              <Trans>Events Not Enabled</Trans>
            </Text>
            <Text
              class="body"
              size="medium"
              style={{ color: "var(--md-sys-color-on-surface-variant)" }}
            >
              <Trans>The calendar feature is not enabled on this server.</Trans>
            </Text>
          </EmptyState>
        </Match>
        <Match when={events.error}>
          <EmptyState>
            <Symbol style={{ "font-size": "48px", color: "#FF8A00" }}>
              error
            </Symbol>
            <Text class="headline" size="small">
              <Trans>Couldn't load events</Trans>
            </Text>
            <Button variant="filled" onPress={() => refetch()}>
              <Trans>Retry</Trans>
            </Button>
          </EmptyState>
        </Match>
        <Match when={!featureDisabled()}>
          <CalendarLayout>
            <CalendarPanel>
              <MonthNav>
                <IconButton onPress={prevMonth}>
                  <Symbol>chevron_left</Symbol>
                </IconButton>
                <MonthLabel>{monthLabel(viewYear(), viewMonth())}</MonthLabel>
                <IconButton onPress={nextMonth}>
                  <Symbol>chevron_right</Symbol>
                </IconButton>
              </MonthNav>

              <DayGrid>
                <For each={weekdayHeaders()}>
                  {(name) => <DayName>{name}</DayName>}
                </For>
                <For each={calendarDays()}>
                  {(day) => (
                    <Show when={day} fallback={<EmptyCell />}>
                      <DayCell
                        isToday={isSameDay(day!, today)}
                        isSelected={isSameDay(day!, selectedDate())}
                        onClick={() => {
                          setSelectedDate(day!);
                          setOpenEvent(undefined);
                        }}
                      >
                        <DayNumber>{day!.getDate()}</DayNumber>
                        <Show when={daysWithOccurrences().has(dayKey(day!))}>
                          <EventDot />
                        </Show>
                      </DayCell>
                    </Show>
                  )}
                </For>
              </DayGrid>

              <Show when={canCreate()}>
                <div style={{ padding: "0 12px 12px" }}>
                  <Button
                    variant="filled"
                    onPress={() => {
                      setOpenEvent(undefined);
                      openCreate(selectedDate());
                    }}
                  >
                    <Symbol size={18}>add</Symbol>
                    &nbsp;
                    <Trans>Create Event</Trans>
                  </Button>
                </div>
              </Show>
            </CalendarPanel>

            <EventsPanel>
              <EventsPanelHeader>
                <Text class="title" size="medium">
                  {displayDate(selectedDate())}
                </Text>
              </EventsPanelHeader>

              <Switch
                fallback={
                  <DayView
                    occurrences={occurrencesForDay()}
                    upcoming={upcoming()}
                    loading={events.loading}
                    onOpen={openDetail}
                    onJump={(start) => {
                      const d = new Date(start);
                      setViewYear(d.getFullYear());
                      setViewMonth(d.getMonth());
                      setSelectedDate(d);
                    }}
                  />
                }
              >
                <Match when={showImport() && server()}>
                  <ImportPanel
                    server={server()!}
                    importing={importing()}
                    result={importResult()}
                    onImport={runImport}
                    onClose={() => {
                      setShowImport(false);
                      setImportResult(undefined);
                    }}
                  />
                </Match>
                <Match when={showCreate() && server()}>
                  <CreateForm
                    defaultDate={createDate()}
                    saving={saving()}
                    onCancel={() => setShowCreate(false)}
                    onSubmit={createEvent}
                    server={server()!}
                  />
                </Match>
                <Match when={editEvent() && server()}>
                  {/* Keyed: the form's signal initializers (prefill) run once per
                      mount, so switching the edited event must remount it. */}
                  <Show when={editEvent()} keyed>
                    {(event) => (
                      <CreateForm
                        defaultDate={selectedDate()}
                        saving={saving()}
                        onCancel={() => setEditEvent(undefined)}
                        onSubmit={createEvent}
                        onEdit={saveEdit}
                        event={event}
                        server={server()!}
                      />
                    )}
                  </Show>
                </Match>
                <Match when={openEvent()}>
                  <EventDetail
                    event={openEvent()!}
                    attendees={attendees()}
                    attendeesLoading={attendeesLoading()}
                    hasMore={hasMoreAttendees()}
                    byStatus={attendeesByStatus}
                    onLoadMore={() => loadAttendees(false)}
                    onBack={() => setOpenEvent(undefined)}
                    onRsvp={doRsvp}
                    canManage={canManage()}
                    onCancel={cancelOpenEvent}
                    onEdit={() => setEditEvent(openEvent())}
                    onUninvite={async (userId) => {
                      try {
                        await openEvent()!.uninvite(userId);
                        // Refresh counts too (not just the attendee page).
                        await refreshDetail();
                      } catch (error) {
                        showError(error);
                      }
                    }}
                    onInvite={async (userIds, roleIds) => {
                      const result = await openEvent()!.invite(userIds, roleIds);
                      await refreshDetail();
                      return result;
                    }}
                    memberOf={(userId) =>
                      client().serverMembers.getByKey({
                        server: params.server,
                        user: userId,
                      })
                    }
                    server={server()!}
                  />
                </Match>
              </Switch>
            </EventsPanel>
          </CalendarLayout>
        </Match>
      </Switch>
    </PageBase>
  );
};

// ===========================================================================
// Sub-components
// ===========================================================================

function DayView(props: {
  occurrences: Occurrence[];
  upcoming: Occurrence[];
  loading: boolean;
  onOpen: (event: CalendarEvent) => void;
  onJump: (start: number) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <Switch>
        <Match when={props.loading}>
          <EmptyDayText>
            <Trans>Loading events…</Trans>
          </EmptyDayText>
        </Match>
        <Match when={props.occurrences.length === 0}>
          <EmptyDayText>
            <Trans>No events on this day.</Trans>
          </EmptyDayText>
        </Match>
        <Match when={props.occurrences.length > 0}>
          <Column gap="sm" style={{ padding: "8px 16px" }}>
            <For each={props.occurrences}>
              {(occ) => (
                <EventCard occurrence={occ} onOpen={() => props.onOpen(occ.event)} />
              )}
            </For>
          </Column>
        </Match>
      </Switch>

      <Show when={props.upcoming.length > 0}>
        <UpcomingSection>
          <Text
            class="label"
            size="small"
            style={{
              color: "var(--md-sys-color-on-surface-variant)",
              padding: "4px 16px",
            }}
          >
            <Trans>Upcoming</Trans>
          </Text>
          <For each={props.upcoming}>
            {(occ) => (
              <UpcomingItem onClick={() => props.onJump(occ.start)}>
                <UpcomingDate>
                  <span style={{ color: "#FF8A00", "font-weight": "bold" }}>
                    {new Date(occ.start).getDate()}
                  </span>
                  <span
                    style={{
                      "font-size": "10px",
                      color: "var(--md-sys-color-on-surface-variant)",
                    }}
                  >
                    {shortMonth(occ.start)}
                  </span>
                </UpcomingDate>
                <div style={{ flex: 1, "min-width": 0 }}>
                  <div
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                      "text-decoration": occ.event.cancelled
                        ? "line-through"
                        : undefined,
                    }}
                  >
                    {occ.event.title}
                  </div>
                  <div
                    style={{
                      "font-size": "11px",
                      color: "var(--md-sys-color-on-surface-variant)",
                    }}
                  >
                    {occurrenceTimeLabel(occ, t`All day`)}
                  </div>
                </div>
              </UpcomingItem>
            )}
          </For>
        </UpcomingSection>
      </Show>
    </>
  );
}

function EventCard(props: { occurrence: Occurrence; onOpen: () => void }) {
  const { t } = useLingui();
  const event = () => props.occurrence.event;
  return (
    <EventCardBase onClick={props.onOpen}>
      <EventCardAccent style={{ background: event().color ?? "#FF8A00" }} />
      <EventCardContent>
        <Row gap="sm" align>
          <Text
            class="title"
            size="medium"
            style={{
              "text-decoration": event().cancelled ? "line-through" : undefined,
            }}
          >
            {event().title}
          </Text>
          <Show when={event().cancelled}>
            <CancelledPill>
              <Trans>Cancelled</Trans>
            </CancelledPill>
          </Show>
          <Show when={event().recurrence}>
            <Symbol size={14}>repeat</Symbol>
          </Show>
        </Row>
        <Text
          class="body"
          size="small"
          style={{ color: "var(--md-sys-color-on-surface-variant)" }}
        >
          {occurrenceTimeLabel(props.occurrence, t`All day`)}
        </Text>
        <Show when={event().location}>
          <Text
            class="body"
            size="small"
            style={{ color: "var(--md-sys-color-on-surface-variant)" }}
          >
            <Symbol size={12}>location_on</Symbol> {event().location}
          </Text>
        </Show>
        <Show when={event().description}>
          <Text class="body" size="medium">
            {event().description}
          </Text>
        </Show>
      </EventCardContent>
    </EventCardBase>
  );
}

function EventDetail(props: {
  event: CalendarEvent;
  attendees: EventRsvpData[];
  attendeesLoading: boolean;
  hasMore: boolean;
  byStatus: (status: RsvpStatus) => EventRsvpData[];
  onLoadMore: () => void;
  onBack: () => void;
  onRsvp: (status: RsvpStatus) => void;
  canManage: boolean;
  onCancel: () => void;
  onEdit: () => void;
  onUninvite: (userId: string) => void;
  onInvite: (
    userIds: string[],
    roleIds: string[],
  ) => Promise<InviteResultData | undefined>;
  memberOf: (userId: string) => ServerMember | undefined;
  server: Server;
}) {
  const { t } = useLingui();
  const { showError } = useModals();
  const counts = () => props.event.counts;

  // Invite-more picker (manage only). Roles are matched client-side against the
  // already-cached role map; a role row invites its CURRENT holders immediately
  // (server-side expansion, slice F 0.1-A) — same interaction as member rows.
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<ServerMember[]>([]);
  const [roleResults, setRoleResults] = createSignal<ServerRole[]>([]);
  const [lastInvite, setLastInvite] = createSignal<
    InviteResultData | undefined
  >();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  function onSearch(value: string) {
    setQuery(value);
    clearTimeout(searchTimer);
    const needle = value.trim().toLowerCase();
    if (!needle) {
      setResults([]);
      setRoleResults([]);
      return;
    }
    setRoleResults(
      props.server.orderedRoles.filter((role) =>
        role.name.toLowerCase().includes(needle),
      ),
    );
    searchTimer = setTimeout(async () => {
      try {
        const { members } = await props.server.queryMembersExperimental(value);
        const attending = new Set(props.attendees.map((a) => a.user));
        setResults(members.filter((m) => !attending.has(m.id.user)));
      } catch {
        setResults([]);
      }
    }, 250);
  }
  async function invite(userIds: string[], roleIds: string[]) {
    setQuery("");
    setResults([]);
    setRoleResults([]);
    try {
      setLastInvite(await props.onInvite(userIds, roleIds));
    } catch (error) {
      showError(error);
    }
  }
  return (
    <DetailWrap>
      <Row gap="sm" align>
        <IconButton onPress={props.onBack}>
          <Symbol>arrow_back</Symbol>
        </IconButton>
        <Text
          class="title"
          size="large"
          style={{
            "text-decoration": props.event.cancelled ? "line-through" : undefined,
          }}
        >
          {props.event.title}
        </Text>
        <Show when={props.event.cancelled}>
          <CancelledPill>
            <Trans>Cancelled</Trans>
          </CancelledPill>
        </Show>
      </Row>

      <Text
        class="body"
        size="small"
        style={{ color: "var(--md-sys-color-on-surface-variant)" }}
      >
        {eventWhenLabel(props.event, t`All day`)}
      </Text>
      <Show when={props.event.location}>
        <Text class="body" size="small">
          <Symbol size={14}>location_on</Symbol> {props.event.location}
        </Text>
      </Show>
      <Show when={props.event.description}>
        <Text class="body" size="medium">
          {props.event.description}
        </Text>
      </Show>

      {/* Caller RSVP control */}
      <Show when={props.event.myRsvp !== undefined && !props.event.cancelled}>
        <RsvpBar>
          <Show
            when={props.event.myRsvp === "Going"}
            fallback={
              <>
                <Button variant="filled" onPress={() => props.onRsvp("Going")}>
                  <Trans>Accept</Trans>
                </Button>
                <Button variant="text" onPress={() => props.onRsvp("NotGoing")}>
                  <Trans>Decline</Trans>
                </Button>
              </>
            }
          >
            <GoingTag>
              <Symbol size={16}>check_circle</Symbol>
              <Trans>You're going</Trans>
            </GoingTag>
            <Button variant="text" onPress={() => props.onRsvp("NotGoing")}>
              <Trans>Cancel (can't attend)</Trans>
            </Button>
          </Show>
        </RsvpBar>
      </Show>

      {/* Attendees grouped by status */}
      <AttendeeSummary>
        <span>
          <Trans>Going</Trans> {counts()?.going ?? 0}
        </span>
        <span>
          <Trans>Invited</Trans> {counts()?.pending ?? 0}
        </span>
        <span>
          <Trans>Not going</Trans> {counts()?.not_going ?? 0}
        </span>
      </AttendeeSummary>

      <AttendeeGroup
        label={t`Going`}
        rows={props.byStatus("Going")}
        memberOf={props.memberOf}
        canManage={props.canManage}
        onUninvite={props.onUninvite}
      />
      <AttendeeGroup
        label={t`Invited`}
        rows={props.byStatus("Pending")}
        memberOf={props.memberOf}
        canManage={props.canManage}
        onUninvite={props.onUninvite}
      />
      <AttendeeGroup
        label={t`Not going`}
        rows={props.byStatus("NotGoing")}
        memberOf={props.memberOf}
        canManage={props.canManage}
        onUninvite={props.onUninvite}
      />

      <Show when={props.hasMore}>
        <Button variant="text" onPress={props.onLoadMore} isDisabled={props.attendeesLoading}>
          {props.attendeesLoading ? (
            <Trans>Loading…</Trans>
          ) : (
            <Trans>Load more attendees</Trans>
          )}
        </Button>
      </Show>

      <Show when={props.canManage && !props.event.cancelled}>
        <ManageBar>
          <Text class="label" size="small">
            <Trans>Invite members</Trans>
          </Text>
          <FormInput
            type="text"
            placeholder={t`Search members or roles…`}
            value={query()}
            onInput={(e) => onSearch(e.currentTarget.value)}
          />
          <Show when={roleResults().length > 0 || results().length > 0}>
            <SearchResults>
              <For each={roleResults()}>
                {(role) => (
                  <SearchResultRow onClick={() => invite([], [role.id])}>
                    <Symbol size={20}>group</Symbol>
                    <span style={{ flex: 1, "text-align": "start" }}>
                      {role.name}
                    </span>
                    <RoleBadge>
                      <Trans>role</Trans>
                    </RoleBadge>
                    <Symbol size={16}>group_add</Symbol>
                  </SearchResultRow>
                )}
              </For>
              <For each={results()}>
                {(member) => (
                  <SearchResultRow onClick={() => invite([member.id.user], [])}>
                    <Avatar
                      src={member.avatarURL}
                      size={20}
                      fallback={member.displayName ?? member.id.user}
                    />
                    <span style={{ flex: 1, "text-align": "start" }}>
                      {member.displayName ?? member.id.user}
                    </span>
                    <Symbol size={16}>person_add</Symbol>
                  </SearchResultRow>
                )}
              </For>
            </SearchResults>
          </Show>
          <Show when={lastInvite()}>
            <SmallMuted>
              <Show
                when={lastInvite()!.invited > 0}
                fallback={
                  <Trans>
                    Everyone in that selection was already invited or can't
                    view this event
                  </Trans>
                }
              >
                <Plural
                  value={lastInvite()!.invited}
                  one="Invited # member"
                  other="Invited # members"
                />
              </Show>
            </SmallMuted>
          </Show>
          <Row gap="sm">
            <Button variant="text" onPress={props.onEdit}>
              <Symbol size={16}>edit</Symbol>&nbsp;
              <Trans>Edit event</Trans>
            </Button>
            <Button variant="text" onPress={props.onCancel}>
              <Symbol size={16}>event_busy</Symbol>&nbsp;
              <Trans>Cancel event</Trans>
            </Button>
          </Row>
        </ManageBar>
      </Show>
    </DetailWrap>
  );
}

function AttendeeGroup(props: {
  label: string;
  rows: EventRsvpData[];
  memberOf: (userId: string) => ServerMember | undefined;
  canManage: boolean;
  onUninvite: (userId: string) => void;
}) {
  return (
    <Show when={props.rows.length > 0}>
      <div>
        <Text
          class="label"
          size="small"
          style={{ color: "var(--md-sys-color-on-surface-variant)" }}
        >
          {props.label} · {props.rows.length}
        </Text>
        <For each={props.rows}>
          {(row) => {
            const member = () => props.memberOf(row.user);
            return (
              <AttendeeRow>
                <Avatar
                  src={member()?.avatarURL}
                  size={24}
                  fallback={member()?.displayName ?? row.user}
                />
                <span style={{ flex: 1, "min-width": 0 }}>
                  {member()?.displayName ?? row.user}
                </span>
                <Show when={row.status === "NotGoing" && row.had_accepted}>
                  <SmallMuted>
                    <Trans>was going</Trans>
                  </SmallMuted>
                </Show>
                <Show when={props.canManage}>
                  <IconButton onPress={() => props.onUninvite(row.user)}>
                    <Symbol size={16}>close</Symbol>
                  </IconButton>
                </Show>
              </AttendeeRow>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/**
 * Create/edit form. With an `event` prop it becomes the EDIT form: fields are
 * prefilled once at mount (the caller keys/remounts it per event id), and
 * submitting sends only a DIFF against those prefilled values.
 *
 * Dirty detection compares the form's OWN string/primitive representations to
 * their prefilled initial values — NEVER a recomputed instant against the
 * stored ms (a lossy round-trip that would silently rewrite the schedule of a
 * cross-timezone all-day or seconds-precision imported event on a title-only
 * edit). The schedule fields (`start`/`end`/`all_day`/`timezone`) travel as one
 * atomic group: if any of them is dirty, the full tuple is recomputed from the
 * form and re-anchored in the editor's timezone (exactly like create);
 * `timezone` never travels without `start`.
 */
function CreateForm(props: {
  defaultDate: Date;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (data: DataCreateEvent, userIds: string[], roleIds: string[]) => void;
  onEdit?: (diff: DataEditEvent) => void;
  event?: CalendarEvent;
  server: Server;
}) {
  const { t } = useLingui();
  const { showError } = useModals();
  const client = useClient();

  // Snapshot the edited event ONCE (mount-time prefill; parent keys by id).
  const ev = props.event;
  const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const initial = {
    title: ev?.title ?? "",
    // All-day events bucket by wall-clock date in the EVENT's timezone (same
    // en-CA trick as the grid — slice-E HIGH-1); timed events prefill viewer-local.
    date: ev
      ? ev.allDay
        ? new Intl.DateTimeFormat("en-CA", { timeZone: ev.timezone }).format(
            ev.start,
          )
        : inputDate(ev.start)
      : inputDate(props.defaultDate),
    startTime: ev && !ev.allDay ? timeOf(ev.start) : "18:00",
    // An imported timed event may have NO end (legacy `end?` was optional): its
    // end input prefills EMPTY so a schedule edit never fabricates an end the
    // event never had. Create mode keeps the 19:00 default.
    endTime: ev
      ? ev.allDay || !ev.end
        ? ""
        : timeOf(ev.end)
      : "19:00",
    allDay: ev?.allDay ?? false,
    description: ev?.description ?? "",
    location: ev?.location ?? "",
    freq: (ev?.recurrence?.freq ?? "None") as Frequency | "None",
    interval: ev?.recurrence?.interval ?? 1,
    weekdays: [...(ev?.recurrence?.by_weekday ?? [])],
    endMode: (ev?.recurrence?.end.type === "Until" ? "until" : "count") as
      | "count"
      | "until",
    count: ev?.recurrence?.end.type === "Count" ? ev.recurrence.end.count : 10,
    untilDate:
      ev?.recurrence?.end.type === "Until"
        ? inputDate(new Date(ev.recurrence.end.timestamp))
        : inputDate(props.defaultDate),
  };

  const [title, setTitle] = createSignal(initial.title);
  const [date, setDate] = createSignal(initial.date);
  const [startTime, setStartTime] = createSignal(initial.startTime);
  const [endTime, setEndTime] = createSignal(initial.endTime);
  const [allDay, setAllDay] = createSignal(initial.allDay);
  const [description, setDescription] = createSignal(initial.description);
  const [location, setLocation] = createSignal(initial.location);

  const [freq, setFreq] = createSignal<Frequency | "None">(initial.freq);
  const [interval, setInterval] = createSignal(initial.interval);
  const [weekdays, setWeekdays] = createSignal<Weekday[]>(initial.weekdays);
  const [endMode, setEndMode] = createSignal<"count" | "until">(initial.endMode);
  const [count, setCount] = createSignal(initial.count);
  const [untilDate, setUntilDate] = createSignal(initial.untilDate);

  // Invite picker (create mode only; the detail owns invites when editing)
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<ServerMember[]>([]);
  const [roleResults, setRoleResults] = createSignal<ServerRole[]>([]);
  const [invited, setInvited] = createSignal<Map<string, ServerMember>>(new Map());
  const [invitedRoles, setInvitedRoles] = createSignal<Map<string, ServerRole>>(
    new Map(),
  );

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  function onSearch(value: string) {
    setQuery(value);
    clearTimeout(searchTimer);
    const needle = value.trim().toLowerCase();
    if (!needle) {
      setResults([]);
      setRoleResults([]);
      return;
    }
    // Roles match synchronously from the cached role map (no fetch).
    setRoleResults(
      props.server.orderedRoles.filter(
        (role) =>
          role.name.toLowerCase().includes(needle) &&
          !invitedRoles().has(role.id),
      ),
    );
    searchTimer = setTimeout(async () => {
      try {
        const { members } = await props.server.queryMembersExperimental(value);
        const self = client().user?.id;
        setResults(
          members.filter(
            (m: ServerMember) =>
              m.id.user !== self && !invited().has(m.id.user),
          ),
        );
      } catch (error) {
        showError(error);
      }
    }, 250);
  }
  function addInvite(member: ServerMember) {
    const next = new Map(invited());
    next.set(member.id.user, member);
    setInvited(next);
    setResults((r) => r.filter((m) => m.id.user !== member.id.user));
  }
  function removeInvite(userId: string) {
    const next = new Map(invited());
    next.delete(userId);
    setInvited(next);
  }
  function addRoleInvite(role: ServerRole) {
    const next = new Map(invitedRoles());
    next.set(role.id, role);
    setInvitedRoles(next);
    setRoleResults((r) => r.filter((x) => x.id !== role.id));
  }
  function removeRoleInvite(roleId: string) {
    const next = new Map(invitedRoles());
    next.delete(roleId);
    setInvitedRoles(next);
  }

  function toggleWeekday(day: Weekday) {
    setWeekdays((days) =>
      days.includes(day) ? days.filter((d) => d !== day) : [...days, day],
    );
  }

  function buildRecurrence() {
    const end: RecurrenceEnd =
      endMode() === "count"
        ? { type: "Count", count: count() }
        : { type: "Until", timestamp: localMs(untilDate(), "23:59") };
    return {
      freq: freq() as Frequency,
      interval: interval(),
      by_weekday: freq() === "Weekly" ? weekdays() : [],
      end,
      // Left empty: the server clears exceptions on any time-affecting edit
      // anyway (the documented recurrence-change semantics).
      exceptions: [],
    };
  }

  function submit() {
    if (!title().trim() || !date()) return;

    const startMs = allDay()
      ? localMs(date(), "00:00")
      : localMs(date(), startTime());
    const data: DataCreateEvent = {
      title: title().trim(),
      start: startMs,
      all_day: allDay(),
      timezone: LOCAL_TZ,
      description: description().trim() || undefined,
      location: location().trim() || undefined,
    };
    if (!allDay() && endTime()) {
      data.end = localMs(date(), endTime());
    }

    if (freq() !== "None") {
      data.recurrence = buildRecurrence();
    }

    props.onSubmit(data, [...invited().keys()], [...invitedRoles().keys()]);
  }

  // ----- edit-mode diff ------------------------------------------------------

  const sortedDays = (days: Weekday[]) => [...days].sort().join(",");
  /** Any of date / times / all-day toggled ⇒ the whole schedule group resubmits. */
  const scheduleDirty = () =>
    date() !== initial.date ||
    allDay() !== initial.allDay ||
    (!allDay() &&
      (startTime() !== initial.startTime || endTime() !== initial.endTime));
  /** Compare only the form-editable subfields; weekday click-order is not dirt. */
  const recurrenceDirty = () =>
    freq() !== initial.freq ||
    (freq() !== "None" &&
      (interval() !== initial.interval ||
        (freq() === "Weekly" &&
          sortedDays(weekdays()) !== sortedDays(initial.weekdays)) ||
        endMode() !== initial.endMode ||
        (endMode() === "count"
          ? count() !== initial.count
          : untilDate() !== initial.untilDate)));

  function submitEdit() {
    if (!props.event || !props.onEdit) return;
    if (!title().trim() || !date()) return;

    const diff: DataEditEvent = {};
    const remove: FieldsEvent[] = [];

    if (title().trim() !== initial.title) diff.title = title().trim();
    if (description().trim() !== initial.description) {
      if (description().trim()) diff.description = description().trim();
      else remove.push("Description");
    }
    if (location().trim() !== initial.location) {
      if (location().trim()) diff.location = location().trim();
      else remove.push("Location");
    }

    if (scheduleDirty()) {
      // Atomic schedule group: a schedule edit re-anchors the series in the
      // EDITOR's timezone (same semantics as create); `timezone` never travels
      // without `start`. An EMPTY end input (all-day, an end-less imported
      // event left untouched, or an explicitly cleared end) maps to
      // remove:["End"] — the group never fabricates an end.
      diff.start = allDay()
        ? localMs(date(), "00:00")
        : localMs(date(), startTime());
      diff.all_day = allDay();
      diff.timezone = LOCAL_TZ;
      if (!allDay() && endTime()) diff.end = localMs(date(), endTime());
      else remove.push("End");
    }

    if (recurrenceDirty()) {
      if (freq() === "None") remove.push("Recurrence");
      else diff.recurrence = buildRecurrence();
    }

    if (remove.length) diff.remove = remove;
    if (Object.keys(diff).length === 0) {
      // Nothing dirty — close without a PATCH.
      props.onCancel();
      return;
    }
    props.onEdit(diff);
  }

  return (
    <FormWrap>
      <Text class="label" size="large" style={{ color: "#FF8A00" }}>
        {props.event ? <Trans>Edit Event</Trans> : <Trans>New Event</Trans>}
      </Text>
      <Show when={props.event?.recurrence}>
        <SmallMuted>
          <Trans>
            Changing the schedule re-anchors this series in your timezone and
            resets any skipped occurrences.
          </Trans>
        </SmallMuted>
      </Show>
      <FormInput
        type="text"
        placeholder={t`Event title`}
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />

      <Row gap="sm" align>
        <label style={{ display: "flex", gap: "6px", "align-items": "center" }}>
          <input
            type="checkbox"
            checked={allDay()}
            onChange={(e) => setAllDay(e.currentTarget.checked)}
          />
          <Trans>All day</Trans>
        </label>
      </Row>

      <Row gap="sm">
        <FormInput
          type="date"
          value={date()}
          onInput={(e) => setDate(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Show when={!allDay()}>
          <FormInput
            type="time"
            value={startTime()}
            onInput={(e) => setStartTime(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <span
            style={{
              "align-self": "center",
              color: "var(--md-sys-color-on-surface-variant)",
            }}
          >
            →
          </span>
          <FormInput
            type="time"
            value={endTime()}
            onInput={(e) => setEndTime(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
        </Show>
      </Row>

      <FormInput
        type="text"
        placeholder={t`Location (optional)`}
        value={location()}
        onInput={(e) => setLocation(e.currentTarget.value)}
      />
      <FormInput
        type="text"
        placeholder={t`Description (optional)`}
        value={description()}
        onInput={(e) => setDescription(e.currentTarget.value)}
      />

      {/* Recurrence */}
      <Text class="label" size="small">
        <Trans>Repeat</Trans>
      </Text>
      <Row gap="sm" wrap>
        <FreqChip active={freq() === "None"} onClick={() => setFreq("None")}>
          <Trans>None</Trans>
        </FreqChip>
        <For each={FREQUENCIES}>
          {(f) => (
            <FreqChip active={freq() === f} onClick={() => setFreq(f)}>
              {/* macro-t must be used in component scope, not passed down */}
              {f === "Daily" ? t`Daily` : f === "Weekly" ? t`Weekly` : t`Monthly`}
            </FreqChip>
          )}
        </For>
      </Row>

      <Show when={freq() !== "None"}>
        <Row gap="sm" align>
          <span>
            <Trans>Every</Trans>
          </span>
          <FormInput
            type="number"
            min="1"
            max="52"
            value={interval()}
            onInput={(e) =>
              setInterval(Math.max(1, parseInt(e.currentTarget.value) || 1))
            }
            style={{ width: "64px" }}
          />
        </Row>

        <Show when={freq() === "Weekly"}>
          <Row gap="sm" wrap>
            <For each={WEEKDAYS}>
              {(day) => (
                <FreqChip
                  active={weekdays().includes(day)}
                  onClick={() => toggleWeekday(day)}
                >
                  {weekdayLabel(day)}
                </FreqChip>
              )}
            </For>
          </Row>
        </Show>

        <Row gap="sm" align wrap>
          <FreqChip
            active={endMode() === "count"}
            onClick={() => setEndMode("count")}
          >
            <Trans>Ends after</Trans>
          </FreqChip>
          <Show when={endMode() === "count"}>
            <FormInput
              type="number"
              min="1"
              value={count()}
              onInput={(e) =>
                setCount(Math.max(1, parseInt(e.currentTarget.value) || 1))
              }
              style={{ width: "64px" }}
            />
            <span>
              <Trans>occurrences</Trans>
            </span>
          </Show>
          <FreqChip
            active={endMode() === "until"}
            onClick={() => setEndMode("until")}
          >
            <Trans>Ends on</Trans>
          </FreqChip>
          <Show when={endMode() === "until"}>
            <FormInput
              type="date"
              value={untilDate()}
              onInput={(e) => setUntilDate(e.currentTarget.value)}
            />
          </Show>
        </Row>
      </Show>

      {/* Invite picker (create only — the detail owns invites when editing) */}
      <Show when={!props.event}>
        <Text class="label" size="small">
          <Trans>Invite members or roles</Trans>
        </Text>
        <Show when={invited().size > 0 || invitedRoles().size > 0}>
          <Row gap="sm" wrap>
            <For each={[...invitedRoles().values()]}>
              {(role) => (
                <InvitePill onClick={() => removeRoleInvite(role.id)}>
                  <Symbol size={14}>group</Symbol>
                  {role.name}
                  <Symbol size={14}>close</Symbol>
                </InvitePill>
              )}
            </For>
            <For each={[...invited().values()]}>
              {(member) => (
                <InvitePill onClick={() => removeInvite(member.id.user)}>
                  {member.displayName ?? member.id.user}
                  <Symbol size={14}>close</Symbol>
                </InvitePill>
              )}
            </For>
          </Row>
        </Show>
        <FormInput
          type="text"
          placeholder={t`Search members or roles…`}
          value={query()}
          onInput={(e) => onSearch(e.currentTarget.value)}
        />
        <Show when={roleResults().length > 0 || results().length > 0}>
          <SearchResults>
            <For each={roleResults()}>
              {(role) => (
                <SearchResultRow onClick={() => addRoleInvite(role)}>
                  <Symbol size={20}>group</Symbol>
                  <span style={{ flex: 1, "text-align": "start" }}>
                    {role.name}
                  </span>
                  <RoleBadge>
                    <Trans>role</Trans>
                  </RoleBadge>
                  <Symbol size={16}>group_add</Symbol>
                </SearchResultRow>
              )}
            </For>
            <For each={results()}>
              {(member) => (
                <SearchResultRow onClick={() => addInvite(member)}>
                  <Avatar
                    src={member.avatarURL}
                    size={20}
                    fallback={member.displayName ?? member.id.user}
                  />
                  <span style={{ flex: 1, "text-align": "start" }}>
                    {member.displayName ?? member.id.user}
                  </span>
                  <Symbol size={16}>person_add</Symbol>
                </SearchResultRow>
              )}
            </For>
          </SearchResults>
        </Show>
      </Show>

      <Row gap="sm">
        <Button variant="text" onPress={props.onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="filled"
          onPress={() => (props.event ? submitEdit() : submit())}
          isDisabled={props.saving || !title().trim() || !date()}
        >
          {props.saving ? (
            <Trans>Saving…</Trans>
          ) : props.event ? (
            <Trans>Save</Trans>
          ) : (
            <Trans>Create</Trans>
          )}
        </Button>
      </Row>
    </FormWrap>
  );
}

/**
 * Manager-triggered import of legacy `[ACUTEST_EVENT]:`-tagged messages
 * (slice F, design §11). The channel select defaults to the channel literally
 * named "events" (the legacy convention); when absent, an explicit choice is
 * required — never a silent fallback. Re-running is dedup-safe server-side.
 */
function ImportPanel(props: {
  server: Server;
  importing: boolean;
  result?: ImportResultData;
  onImport: (channelId: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const textChannels = createMemo(() =>
    props.server.channels.filter((c) => c.type === "TextChannel"),
  );
  const [channelId, setChannelId] = createSignal(
    textChannels().find((c) => c.name?.toLowerCase() === "events")?.id ?? "",
  );

  return (
    <FormWrap>
      <Text class="label" size="large" style={{ color: "#FF8A00" }}>
        <Trans>Import legacy events</Trans>
      </Text>
      <Text
        class="body"
        size="small"
        style={{ color: "var(--md-sys-color-on-surface-variant)" }}
      >
        <Trans>
          Scans a channel for old tagged event messages and turns them into
          real calendar events. Already-imported messages are skipped, so
          running this again is safe.
        </Trans>
      </Text>

      <ChannelSelect
        value={channelId()}
        onChange={(e) => setChannelId(e.currentTarget.value)}
      >
        <option value="" disabled>
          {t`Select a channel`}
        </option>
        <For each={textChannels()}>
          {(channel) => <option value={channel.id}>#{channel.name}</option>}
        </For>
      </ChannelSelect>

      <Show when={props.result}>
        <SmallMuted>
          <Trans>
            Imported: {props.result!.imported} · Duplicates skipped:{" "}
            {props.result!.skipped_duplicates} · Invalid:{" "}
            {props.result!.skipped_invalid}
          </Trans>
          <Show when={props.result!.truncated}>
            {" "}
            <Trans>
              The scan stopped at the message cap — run the import again to
              continue.
            </Trans>
          </Show>
        </SmallMuted>
      </Show>

      <Row gap="sm">
        <Button variant="text" onPress={props.onClose}>
          <Trans>Close</Trans>
        </Button>
        <Button
          variant="filled"
          onPress={() => props.onImport(channelId())}
          isDisabled={props.importing || !channelId()}
        >
          {props.importing ? <Trans>Importing…</Trans> : <Trans>Import</Trans>}
        </Button>
      </Row>
    </FormWrap>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Trailing-edge debounce whose timer is cleared on component cleanup. */
function debounced<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Local Y-M-D key for a Date (used for the grid cells + timed occurrences). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Which calendar cell an occurrence belongs to. All-day occurrences are floating
 * dates anchored to the event's timezone (so they never shift a day for a viewer
 * elsewhere); timed occurrences bucket to the viewer's local day.
 */
function occurrenceDayKey(occ: Occurrence): string {
  if (occ.event.allDay) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: occ.event.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(occ.start));
  }
  return dayKey(new Date(occ.start));
}

function occurrenceTimeLabel(occ: Occurrence, allDayText: string): string {
  if (occ.event.allDay) return allDayText;
  const start = new Date(occ.start);
  const duration =
    occ.event.endAt !== undefined ? occ.event.endAt - occ.event.startAt : 0;
  const startLabel = time(start);
  if (duration > 0) {
    return `${startLabel} – ${time(new Date(occ.start + duration))}`;
  }
  return startLabel;
}

function eventWhenLabel(event: CalendarEvent, allDayText: string): string {
  if (event.allDay) {
    // All-day dates are floating in the event's timezone — format them there so
    // the label matches the grid bucket for viewers in another timezone.
    const dateLabel = new Intl.DateTimeFormat(undefined, {
      timeZone: event.timezone,
      weekday: "short",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(event.start);
    return `${dateLabel} · ${allDayText}`;
  }
  const start = event.start;
  const end = event.end;
  return `${displayDate(start)} · ${time(start)}${end ? ` – ${time(end)}` : ""}`;
}

function localMs(date: string, time: string): number {
  return new Date(`${date}T${time}:00`).getTime();
}

function inputDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// --- locale-aware formatting (no hardcoded English month/day arrays) --------

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month, 1));
}

function displayDate(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function shortMonth(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short" }).format(
    new Date(ms),
  );
}

function time(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * Locale's first day of the week as a JS day index (0=Sun … 6=Sat).
 * Uses `Intl.Locale` week info where available; falls back to Sunday.
 */
function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    // firstDay is 1=Mon … 7=Sun; convert to JS 0=Sun … 6=Sat.
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    /* fall through to Sunday */
  }
  return 0;
}

/** Localized weekday headers, ordered from the locale's start-of-week. */
function weekdayHeaders(): string[] {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const start = weekStart();
  // 2023-01-01 is a Sunday (JS day 0).
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2023, 0, 1 + ((start + i) % 7))),
  );
}

/** Day-of-month in Jan 2023 that falls on each weekday (Jan 2 = Monday). */
const WEEKDAY_REF: Record<Weekday, number> = {
  Monday: 2,
  Tuesday: 3,
  Wednesday: 4,
  Thursday: 5,
  Friday: 6,
  Saturday: 7,
  Sunday: 8,
};

/** Locale-aware short weekday name (lingui macros don't survive being passed a `t`). */
function weekdayLabel(day: Weekday): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
    new Date(2023, 0, WEEKDAY_REF[day]),
  );
}

// ===========================================================================
// Styled components
// ===========================================================================

const PageBase = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--md-sys-color-surface)",
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
  },
});

const PageHeader = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    flexShrink: 0,
  },
});

const CalendarLayout = styled("div", {
  base: { display: "flex", flex: 1, overflow: "hidden" },
});

const CalendarPanel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    width: "320px",
    flexShrink: 0,
    borderRight: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container-low)",
  },
});

const MonthNav = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
  },
});

const MonthLabel = styled("span", {
  base: {
    ...typography.raw({ class: "title", size: "medium" }),
    fontWeight: "600",
  },
});

const DayGrid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: "2px",
    padding: "0 12px 12px",
  },
});

const DayName = styled("div", {
  base: {
    textAlign: "center",
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "4px 0",
  },
});

const EmptyCell = styled("div", {});

const DayCell = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "4px",
    borderRadius: "6px",
    cursor: "pointer",
    transition: "background 0.1s",
    "&:hover": { background: "var(--md-sys-color-surface-container)" },
  },
  variants: {
    isToday: {
      true: {
        background: "color-mix(in srgb, #FF8A00 15%, transparent)",
        "&:hover": {
          background: "color-mix(in srgb, #FF8A00 25%, transparent)",
        },
      },
    },
    isSelected: {
      true: { background: "var(--md-sys-color-primary-container) !important" },
    },
  },
});

const DayNumber = styled("span", { base: { fontSize: "13px", lineHeight: "1.6" } });

const EventDot = styled("div", {
  base: {
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    background: "#FF8A00",
    marginTop: "1px",
  },
});

const EventsPanel = styled("div", {
  base: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    minWidth: 0,
  },
});

const EventsPanelHeader = styled("div", {
  base: {
    padding: "16px",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    flexShrink: 0,
  },
});

const FormWrap = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 16px",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container)",
  },
});

const FormInput = styled("input", {
  base: {
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1.5px solid var(--md-sys-color-outline)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    outline: "none",
    boxSizing: "border-box",
    "&:focus": { borderColor: "var(--md-sys-color-primary)" },
  },
});

const FreqChip = styled("button", {
  base: {
    padding: "4px 10px",
    borderRadius: "999px",
    border: "1.5px solid var(--md-sys-color-outline)",
    background: "transparent",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  variants: {
    active: {
      true: {
        background: "var(--md-sys-color-primary-container)",
        borderColor: "var(--md-sys-color-primary)",
      },
    },
  },
});

const InvitePill = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 8px",
    borderRadius: "999px",
    border: "none",
    background: "var(--md-sys-color-secondary-container)",
    color: "var(--md-sys-color-on-secondary-container)",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
});

const SearchResults = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "8px",
    border: "1px solid var(--md-sys-color-outline-variant)",
    maxHeight: "160px",
    overflowY: "auto",
  },
});

const ChannelSelect = styled("select", {
  base: {
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const RoleBadge = styled("span", {
  base: {
    padding: "1px 6px",
    borderRadius: "999px",
    background: "var(--md-sys-color-tertiary-container)",
    color: "var(--md-sys-color-on-tertiary-container)",
    fontSize: "0.65rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
});

const SearchResultRow = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    border: "none",
    background: "transparent",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    textAlign: "start",
    "&:hover": { background: "var(--md-sys-color-surface-container-high)" },
  },
});

const EmptyDayText = styled("div", {
  base: {
    padding: "24px 16px",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.9rem",
  },
});

const EventCardBase = styled("div", {
  base: {
    display: "flex",
    borderRadius: "10px",
    overflow: "hidden",
    background: "var(--md-sys-color-surface-container)",
    marginBottom: "8px",
    cursor: "pointer",
    "&:hover": { background: "var(--md-sys-color-surface-container-high)" },
  },
});

const EventCardAccent = styled("div", {
  base: { width: "4px", flexShrink: 0, background: "#FF8A00" },
});

const EventCardContent = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "10px 14px",
    flex: 1,
    minWidth: 0,
  },
});

const CancelledPill = styled("span", {
  base: {
    fontSize: "10px",
    padding: "1px 6px",
    borderRadius: "999px",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});

const DetailWrap = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 16px",
  },
});

const RsvpBar = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    padding: "8px 0",
  },
});

const GoingTag = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    color: "var(--md-sys-color-primary)",
    fontWeight: "600",
  },
});

const AttendeeSummary = styled("div", {
  base: {
    display: "flex",
    gap: "16px",
    fontSize: "0.8rem",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "4px 0",
  },
});

const AttendeeRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 0",
    fontSize: "0.9rem",
  },
});

const SmallMuted = styled("span", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ManageBar = styled("div", {
  base: {
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
    marginTop: "8px",
    paddingTop: "8px",
  },
});

const UpcomingSection = styled("div", {
  base: {
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
    marginTop: "8px",
    paddingTop: "8px",
  },
});

const UpcomingItem = styled("div", {
  base: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    padding: "8px 16px",
    cursor: "pointer",
    fontSize: "13px",
    "&:hover": { background: "var(--md-sys-color-surface-container)" },
  },
});

const UpcomingDate = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "28px",
    flexShrink: 0,
    lineHeight: "1.3",
  },
});

const EmptyState = styled("div", {
  base: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "32px",
    textAlign: "center",
    color: "var(--md-sys-color-on-surface)",
  },
});

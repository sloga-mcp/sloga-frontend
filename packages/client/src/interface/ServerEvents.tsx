import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useNavigate, useParams } from "@revolt/routing";
import { Button, Column, IconButton, Row, Text, typography } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  ServerEvent,
  buildEventMessage,
  getEventsForDay,
  isSameDay,
  parseEventMessage,
} from "../lib/serverEvents";

const EVENTS_CHANNEL_NAME = "events";
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export const ServerEvents: Component = () => {
  const params = useParams<{ server: string }>();
  const client = useClient();
  const navigate = useNavigate();

  const server = createMemo(() => client()!.servers.get(params.server)!);

  const eventsChannel = createMemo<Channel | undefined>(() => {
    if (!server()) return undefined;
    return [...client()!.channels.values()].find(
      (ch) =>
        ch.serverId === server().id &&
        ch.type === "TextChannel" &&
        ch.name?.toLowerCase() === EVENTS_CHANNEL_NAME,
    );
  });

  const [events, { refetch }] = createResource(
    eventsChannel,
    async (channel) => {
      if (!channel) return [];
      const { messages } = await channel.fetchMessagesWithUsers({ limit: 100 });
      const parsed: ServerEvent[] = [];
      for (const msg of messages) {
        const evt = parseEventMessage(msg.id, msg.content ?? "", msg.authorId);
        if (evt) parsed.push(evt);
      }
      return parsed.sort((a, b) => a.start.localeCompare(b.start));
    },
  );

  const today = new Date();
  const [viewYear, setViewYear] = createSignal(today.getFullYear());
  const [viewMonth, setViewMonth] = createSignal(today.getMonth());
  const [selectedDate, setSelectedDate] = createSignal<Date>(today);

  const [showCreate, setShowCreate] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal("");
  const [newDate, setNewDate] = createSignal(formatDateInput(today));
  const [newTime, setNewTime] = createSignal("18:00");
  const [newEndTime, setNewEndTime] = createSignal("20:00");
  const [newDesc, setNewDesc] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  function prevMonth() {
    if (viewMonth() === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth() === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  const calendarDays = createMemo(() => {
    const year = viewYear();
    const month = viewMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days: (Date | null)[] = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));
    while (days.length % 7 !== 0) days.push(null);
    return days;
  });

  const selectedEvents = createMemo(() => {
    const evts = events();
    if (!evts) return [];
    return getEventsForDay(evts, selectedDate());
  });

  const canPost = createMemo(() =>
    eventsChannel()?.havePermission("SendMessage") ?? false,
  );

  async function createEvent() {
    const channel = eventsChannel();
    if (!channel || !newTitle().trim() || !newDate()) return;
    setSaving(true);
    try {
      const start = new Date(`${newDate()}T${newTime()}:00`).toISOString();
      const end = new Date(`${newDate()}T${newEndTime()}:00`).toISOString();
      const content = buildEventMessage({
        title: newTitle().trim(),
        start,
        end,
        desc: newDesc().trim() || undefined,
      });
      await channel.sendMessage({ content });
      setNewTitle("");
      setNewDesc("");
      setShowCreate(false);
      await refetch();
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
      </PageHeader>

      <Switch>
        <Match when={!eventsChannel()}>
          <EmptyState>
            <Symbol style={{ "font-size": "48px", color: "#FF8A00" }}>
              calendar_month
            </Symbol>
            <Text class="headline" size="small">
              <Trans>No Events Channel Found</Trans>
            </Text>
            <Text class="body" size="medium" style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
              <Trans>
                Create a text channel named <strong>events</strong> in this server to enable the calendar.
              </Trans>
            </Text>
          </EmptyState>
        </Match>
        <Match when={eventsChannel()}>
          <CalendarLayout>
            <CalendarPanel>
              <MonthNav>
                <IconButton onPress={prevMonth}>
                  <Symbol>chevron_left</Symbol>
                </IconButton>
                <MonthLabel>
                  {MONTH_NAMES[viewMonth()]} {viewYear()}
                </MonthLabel>
                <IconButton onPress={nextMonth}>
                  <Symbol>chevron_right</Symbol>
                </IconButton>
              </MonthNav>

              <DayGrid>
                <For each={DAY_NAMES}>
                  {(name) => <DayName>{name}</DayName>}
                </For>
                <For each={calendarDays()}>
                  {(day) => (
                    <Show when={day} fallback={<EmptyCell />}>
                      <DayCell
                        isToday={isSameDay(day!, today)}
                        isSelected={isSameDay(day!, selectedDate())}
                        onClick={() => setSelectedDate(day!)}
                      >
                        <DayNumber>{day!.getDate()}</DayNumber>
                        <Show when={(events() ?? []).some((e) => isSameDay(new Date(e.start), day!))}>
                          <EventDot />
                        </Show>
                      </DayCell>
                    </Show>
                  )}
                </For>
              </DayGrid>

              <Show when={canPost()}>
                <div style={{ padding: "0 12px 12px" }}>
                  <Button
                    variant="filled"
                    onPress={() => {
                      setNewDate(formatDateInput(selectedDate()));
                      setShowCreate(true);
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
                  {formatDisplayDate(selectedDate())}
                </Text>
              </EventsPanelHeader>

              <Show when={showCreate() && canPost()}>
                <CreateForm>
                  <Text class="label" size="large" style={{ color: "#FF8A00" }}>
                    <Trans>New Event</Trans>
                  </Text>
                  <FormInput
                    type="text"
                    placeholder="Event title"
                    value={newTitle()}
                    onInput={(e) => setNewTitle(e.currentTarget.value)}
                  />
                  <Row gap="sm">
                    <FormInput
                      type="date"
                      value={newDate()}
                      onInput={(e) => setNewDate(e.currentTarget.value)}
                      style={{ flex: 1 }}
                    />
                    <FormInput
                      type="time"
                      value={newTime()}
                      onInput={(e) => setNewTime(e.currentTarget.value)}
                      style={{ flex: 1 }}
                    />
                    <span style={{ "align-self": "center", color: "var(--md-sys-color-on-surface-variant)" }}>→</span>
                    <FormInput
                      type="time"
                      value={newEndTime()}
                      onInput={(e) => setNewEndTime(e.currentTarget.value)}
                      style={{ flex: 1 }}
                    />
                  </Row>
                  <FormInput
                    type="text"
                    placeholder="Description (optional)"
                    value={newDesc()}
                    onInput={(e) => setNewDesc(e.currentTarget.value)}
                  />
                  <Row gap="sm">
                    <Button variant="text" onPress={() => setShowCreate(false)}>
                      <Trans>Cancel</Trans>
                    </Button>
                    <Button
                      variant="filled"
                      onPress={createEvent}
                      isDisabled={saving() || !newTitle().trim()}
                    >
                      {saving() ? <Trans>Saving…</Trans> : <Trans>Create</Trans>}
                    </Button>
                  </Row>
                </CreateForm>
              </Show>

              <Switch>
                <Match when={events.loading}>
                  <EmptyDayText>
                    <Trans>Loading events…</Trans>
                  </EmptyDayText>
                </Match>
                <Match when={selectedEvents().length === 0}>
                  <EmptyDayText>
                    <Trans>No events on this day.</Trans>
                  </EmptyDayText>
                </Match>
                <Match when={selectedEvents().length > 0}>
                  <Column gap="sm" style={{ padding: "8px 16px" }}>
                    <For each={selectedEvents()}>
                      {(evt) => <EventCard event={evt} />}
                    </For>
                  </Column>
                </Match>
              </Switch>

              <Show when={(events() ?? []).length > 0 && !events.loading}>
                <UpcomingSection>
                  <Text class="label" size="small" style={{ color: "var(--md-sys-color-on-surface-variant)", padding: "4px 16px" }}>
                    <Trans>Upcoming</Trans>
                  </Text>
                  <For each={(events() ?? []).filter((e) => new Date(e.start) >= today).slice(0, 5)}>
                    {(evt) => (
                      <UpcomingItem onClick={() => {
                        const d = new Date(evt.start);
                        setViewYear(d.getFullYear());
                        setViewMonth(d.getMonth());
                        setSelectedDate(d);
                      }}>
                        <UpcomingDate>
                          <span style={{ color: "#FF8A00", "font-weight": "bold" }}>
                            {new Date(evt.start).getDate()}
                          </span>
                          <span style={{ "font-size": "10px", color: "var(--md-sys-color-on-surface-variant)" }}>
                            {MONTH_NAMES[new Date(evt.start).getMonth()].slice(0,3)}
                          </span>
                        </UpcomingDate>
                        <div style={{ flex: 1, "min-width": 0 }}>
                          <div style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                            {evt.title}
                          </div>
                          <div style={{ "font-size": "11px", color: "var(--md-sys-color-on-surface-variant)" }}>
                            {formatTime(new Date(evt.start))}
                            {evt.end ? ` – ${formatTime(new Date(evt.end))}` : ""}
                          </div>
                        </div>
                      </UpcomingItem>
                    )}
                  </For>
                </UpcomingSection>
              </Show>
            </EventsPanel>
          </CalendarLayout>
        </Match>
      </Switch>
    </PageBase>
  );
};

function EventCard(props: { event: ServerEvent }) {
  return (
    <EventCardBase>
      <EventCardAccent />
      <EventCardContent>
        <Text class="title" size="medium">
          {props.event.title}
        </Text>
        <Show when={props.event.start}>
          <Text class="body" size="small" style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
            {formatTime(new Date(props.event.start))}
            {props.event.end ? ` – ${formatTime(new Date(props.event.end))}` : ""}
          </Text>
        </Show>
        <Show when={props.event.desc}>
          <Text class="body" size="medium">
            {props.event.desc}
          </Text>
        </Show>
      </EventCardContent>
    </EventCardBase>
  );
}

function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDisplayDate(d: Date): string {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- Styled components ---

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
  base: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
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
    "&:hover": {
      background: "var(--md-sys-color-surface-container)",
    },
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
      true: {
        background: "var(--md-sys-color-primary-container) !important",
      },
    },
  },
});

const DayNumber = styled("span", {
  base: {
    fontSize: "13px",
    lineHeight: "1.6",
  },
});

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

const CreateForm = styled("div", {
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
    width: "100%",
    boxSizing: "border-box",
    "&:focus": {
      borderColor: "var(--md-sys-color-primary)",
    },
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
  },
});

const EventCardAccent = styled("div", {
  base: {
    width: "4px",
    flexShrink: 0,
    background: "#FF8A00",
  },
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
    "&:hover": {
      background: "var(--md-sys-color-surface-container)",
    },
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

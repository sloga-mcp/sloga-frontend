export const EVENT_PREFIX = "[ACUTEST_EVENT]:";

export interface ServerEvent {
  messageId: string;
  title: string;
  start: string; // ISO date string
  end?: string;  // ISO date string
  desc?: string;
  voiceId?: string;
  color?: string;
  authorId?: string;
}

export function parseEventMessage(
  messageId: string,
  content: string,
  authorId?: string,
): ServerEvent | null {
  if (!content.startsWith(EVENT_PREFIX)) return null;
  try {
    const json = JSON.parse(content.slice(EVENT_PREFIX.length));
    if (!json.title || !json.start) return null;
    return { messageId, authorId, ...json };
  } catch {
    return null;
  }
}

export function buildEventMessage(
  event: Omit<ServerEvent, "messageId" | "authorId">,
): string {
  return EVENT_PREFIX + JSON.stringify(event);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function getEventsForDay(events: ServerEvent[], date: Date): ServerEvent[] {
  return events.filter((e) => {
    const start = new Date(e.start);
    return isSameDay(start, date);
  });
}

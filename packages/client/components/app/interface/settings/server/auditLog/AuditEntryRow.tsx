import { Accessor, For, Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type {
  AuditLogChangeData,
  AuditLogEntryData,
  AuditValue,
  Server,
  ServerMember,
  User,
} from "stoat.js";
import { styled } from "styled-system/jsx";
import { decodeTime } from "ulid";

import { useClient } from "@revolt/client";
import { useTime } from "@revolt/i18n";
import { Avatar, Button, Text } from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  type AuditEntryDescriptor,
  auditValueText,
  describeAuditEntry,
} from "./auditEntryModel";

/**
 * A user as the audit log shows them
 */
export interface AuditUser {
  /** Nickname, display name or username; "Deleted User" if unknown */
  name: string;
  /** Server or profile avatar, if any */
  avatar?: string;
  /** The user, when the client knows them */
  user?: User;
  /** Their membership of this server, if they are still a member */
  member?: ServerMember;
}

// Change keys whose values are role ids (single or lists)
const ROLE_ID_KEYS = new Set(["roles_added", "roles_removed", "ranks"]);

// Change keys whose values are channel ids
const CHANNEL_ID_KEYS = new Set(["voice_channel", "afk_channel_id"]);

// Keys the server writes as a new-only marker rather than a before/after
// pair: Bool(true) = set or replaced, Bool(false) = removed
const SET_REMOVED_MARKER_KEYS = new Set(["icon", "banner"]);

// Keys the server writes as a new-only Bool(true) meaning "this changed"
const CHANGED_MARKER_KEYS = new Set([
  "categories",
  "system_messages",
  "voice",
  "tags",
  "default_permissions",
]);

/**
 * How one change is shown: a marker word, the new value alone, or a genuine
 * old -> new pair
 */
type ChangeDisplay =
  | { kind: "single"; text: string }
  | { kind: "pair"; old: string; new: string };

/**
 * One audit log entry as a card: who, what, when, and an expandable block
 * with the reason and the changed values.
 */
export function AuditEntryRow(props: {
  /** The entry to show */
  entry: AuditLogEntryData;
  /** Server the log belongs to; roles and members resolve against it */
  server: Server;
  /** Resolve a user id (page users first, then the client and members) */
  resolveUser: (id: string) => AuditUser;
  /** Shared clock, ticking once a minute, for the relative time */
  now: Accessor<number>;
}) {
  const { t } = useLingui();
  const client = useClient();
  const dayjs = useTime();

  const descriptor = createMemo<AuditEntryDescriptor>(() =>
    describeAuditEntry(props.entry),
  );

  // Actor; an entry without one was taken by the system
  const actorUser = createMemo<AuditUser>(() =>
    props.entry.actor
      ? props.resolveUser(props.entry.actor)
      : { name: t`System` },
  );

  /**
   * The name a deleted object had, from the entry's own `name` change
   */
  function snapshotName() {
    const change = descriptor().changes.find((c) => c.key === "name");
    const value = change?.old ?? change?.new;
    return value?.type === "String" ? value.value : undefined;
  }

  /**
   * Channel name with a leading #, or the raw id if it no longer exists
   */
  function channelName(id: string, fallback?: string) {
    const name = client().channels.get(id)?.name ?? fallback;
    return name ? `#${name}` : id;
  }

  /**
   * Role name, or the raw id if it no longer exists
   */
  function roleName(id: string, fallback?: string) {
    return props.server.roles?.get(id)?.name ?? fallback ?? id;
  }

  /**
   * Name of whatever the entry's `target` points at
   */
  const targetName = createMemo(() => {
    const id = props.entry.target;
    if (!id) return "";

    const kind = descriptor().targetKind;
    switch (kind) {
      case "user":
        return props.resolveUser(id).name;
      case "channel":
        return channelName(id, snapshotName());
      case "role":
        return roleName(id, snapshotName());
      case "permission_target":
        return id === "default" ? t`Default Permissions` : roleName(id);
      case "none":
        return id;
      default: {
        const _exhaustive: never = kind;
        return id;
      }
    }
  });

  /**
   * One sentence describing the entry, with every name passed as plain text
   */
  const sentence = createMemo(() => {
    const actor = actorUser().name;
    const target = targetName();
    const channel = props.entry.channel ? channelName(props.entry.channel) : "";
    const count = descriptor().count;
    const isDefault = props.entry.target === "default";
    const kind = descriptor().kind;

    switch (kind) {
      case "member_kick":
        return t`${actor} kicked ${target}`;
      case "member_ban_add":
        return t`${actor} banned ${target}`;
      case "member_ban_remove":
        return t`${actor} unbanned ${target}`;
      case "member_timeout":
        return t`${actor} timed out ${target}`;
      case "member_timeout_remove":
        return t`${actor} removed the timeout for ${target}`;
      case "member_role_update":
        return t`${actor} changed the roles of ${target}`;
      case "member_update":
        return t`${actor} changed the server profile of ${target}`;
      case "member_voice_update":
        return t`${actor} changed the voice permissions of ${target}`;
      case "member_move":
        return t`${actor} moved ${target} to ${channel}`;
      case "member_disconnect":
        return t`${actor} disconnected ${target} from ${channel}`;
      case "message_delete":
        return t`${actor} deleted a message by ${target} in ${channel}`;
      case "message_bulk_delete":
        return count === undefined
          ? t`${actor} deleted messages in ${channel}`
          : t`${actor} bulk-deleted messages in ${channel} (${count})`;
      case "channel_create":
        return t`${actor} created the channel ${target}`;
      case "channel_update":
        return t`${actor} changed the channel ${target}`;
      case "channel_delete":
        return t`${actor} deleted the channel ${target}`;
      case "channel_overwrite_update":
        return isDefault
          ? t`${actor} changed the default permissions in ${channel}`
          : t`${actor} changed the permissions of ${target} in ${channel}`;
      case "server_permissions_update":
        return isDefault
          ? t`${actor} changed the default server permissions`
          : t`${actor} changed the server permissions of ${target}`;
      case "role_create":
        return t`${actor} created the role ${target}`;
      case "role_update":
        return t`${actor} changed the role ${target}`;
      case "role_delete":
        return t`${actor} deleted the role ${target}`;
      case "role_ranks_update":
        return t`${actor} reordered the roles`;
      case "server_update": {
        const keys = descriptor().changes.map((change) => change.key);
        return keys.length === 1 && keys[0] === "name"
          ? t`${actor} changed the server name`
          : t`${actor} changed the server settings`;
      }
      case "server_owner_transfer":
        return t`${actor} transferred ownership of the server to ${target}`;
      case "unknown":
        return t`${actor} performed an action`;
      default: {
        const _exhaustive: never = kind;
        return t`${actor} performed an action`;
      }
    }
  });

  // Creation time from the ULID; undefined if the id is not a ULID
  const createdAt = createMemo(() => {
    try {
      return decodeTime(props.entry._id);
    } catch {
      return undefined;
    }
  });

  const [showAbsolute, setShowAbsolute] = createSignal(false);
  const absoluteTime = () => dayjs(createdAt()).format("LLLL");
  const relativeTime = () => dayjs(createdAt()).from(dayjs(props.now()));

  const [expanded, setExpanded] = createSignal(false);
  const hasDetails = () =>
    !!props.entry.reason || descriptor().changes.length > 0;

  /**
   * A change value as text; role and channel ids become names
   */
  function valueText(key: string, value: AuditValue | undefined) {
    if (!value) return t`(none)`;

    if (ROLE_ID_KEYS.has(key)) {
      if (value.type === "StringList") {
        return value.value.map((id) => roleName(id)).join(", ");
      }
      if (value.type === "String") return roleName(value.value);
    }

    if (CHANNEL_ID_KEYS.has(key) && value.type === "String") {
      return channelName(value.value);
    }

    if (key === "timeout" && value.type === "String") {
      const date = dayjs(value.value);
      if (date.isValid()) return date.format("lll");
    }

    return auditValueText(value);
  }

  /**
   * How a change is shown. Without an `old` value it is not a before/after
   * pair: a marker key becomes one word, anything else (such as the new-only
   * `roles_added` / `roles_removed` lists) shows only its new value.
   */
  function changeDisplay(change: AuditLogChangeData): ChangeDisplay {
    if (change.old) {
      return {
        kind: "pair",
        old: valueText(change.key, change.old),
        new: valueText(change.key, change.new),
      };
    }

    const value = change.new;
    if (SET_REMOVED_MARKER_KEYS.has(change.key) && value?.type === "Bool") {
      return { kind: "single", text: value.value ? t`set` : t`removed` };
    }

    if (CHANGED_MARKER_KEYS.has(change.key)) {
      return { kind: "single", text: t`changed` };
    }

    return { kind: "single", text: valueText(change.key, value) };
  }

  return (
    <Card>
      <Header>
        <Avatar
          src={actorUser().avatar}
          fallback={actorUser().name}
          size={32}
        />
        <Summary>
          <ActorName>
            <DisplayName
              user={actorUser().user}
              member={actorUser().member}
              name={actorUser().name}
            />
          </ActorName>
          <Text>{sentence()}</Text>
        </Summary>
        <Show when={createdAt() !== undefined}>
          <TimeButton
            type="button"
            title={absoluteTime()}
            onClick={() => setShowAbsolute((value) => !value)}
          >
            {showAbsolute() ? absoluteTime() : relativeTime()}
          </TimeButton>
        </Show>
      </Header>

      <Show when={hasDetails()}>
        <div>
          <Button
            size="sm"
            variant="text"
            onPress={() => setExpanded((value) => !value)}
          >
            <Show when={expanded()} fallback={<Trans>Show details</Trans>}>
              <Trans>Hide details</Trans>
            </Show>
          </Button>
        </div>

        <Show when={expanded()}>
          <Details>
            <Show when={props.entry.reason}>
              {(reason) => (
                <DetailBlock>
                  <Text class="label">
                    <Trans>Reason</Trans>
                  </Text>
                  <Value>{reason()}</Value>
                </DetailBlock>
              )}
            </Show>

            <For each={descriptor().changes}>
              {(change: AuditLogChangeData) => (
                <DetailBlock>
                  <ChangeKey>{change.key}</ChangeKey>
                  <ChangeValues>
                    <ChangeValueText display={changeDisplay(change)} />
                  </ChangeValues>
                </DetailBlock>
              )}
            </For>
          </Details>
        </Show>
      </Show>
    </Card>
  );
}

/**
 * A change's value(s): one value, or old -> new
 */
function ChangeValueText(props: { display: ChangeDisplay }) {
  return (
    <Show
      when={props.display.kind === "pair" ? props.display : undefined}
      fallback={
        <Value>
          {props.display.kind === "single" ? props.display.text : ""}
        </Value>
      }
    >
      {(pair) => (
        <>
          <Value>{pair().old}</Value>
          <Symbol size={16}>arrow_forward</Symbol>
          <Value>{pair().new}</Value>
        </>
      )}
    </Show>
  );
}

const Card = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "12px",
    borderRadius: "12px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    mdDown: {
      flexWrap: "wrap",
    },
  },
});

const Summary = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
});

const ActorName = styled("span", {
  base: {
    fontWeight: 600,
  },
});

const TimeButton = styled("button", {
  base: {
    flexShrink: 0,
    padding: 0,
    border: "none",
    background: "transparent",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.8rem",
    cursor: "pointer",
    textAlign: "end",
    mdDown: {
      width: "100%",
      textAlign: "start",
      paddingInlineStart: "44px",
    },
  },
});

const Details = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    paddingInlineStart: "44px",
    mdDown: {
      paddingInlineStart: 0,
    },
  },
});

const DetailBlock = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const ChangeKey = styled("span", {
  base: {
    fontFamily: "var(--fonts-monospace)",
    fontSize: "0.8rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ChangeValues = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
  },
});

const Value = styled("span", {
  base: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});

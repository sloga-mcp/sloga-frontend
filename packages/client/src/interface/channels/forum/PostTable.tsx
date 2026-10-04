import { For, JSX, Show, createMemo } from "solid-js";

import { Plural, Trans } from "@lingui-solid/solid/macro";
import { Channel, Message, User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { hasReplies } from "@revolt/common/lib/forumLayout";
import { TextWithEmoji } from "@revolt/markdown";
import { useNavigate } from "@revolt/routing";
import { Avatar, Text, isSlogaStaff } from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Time } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { DecorativeSlot, Tag, TagRow, UnreadDot } from "./forumStyles";

/**
 * Classic+ forum layout: a phpBB-style table of posts with Topic, Replies
 * and Last post columns. On a phone the header is hidden and each row folds
 * into a single column, with the reply count and last post inline under the
 * topic.
 *
 * A CSS grid rather than a `<table>`, so every row can be a link.
 */
export function PostTable(props: {
  posts: Channel[];
  forum: Channel;
  statsFor: (
    post: Channel,
  ) => { replies: number; lastMessageId?: string } | undefined;
  lastMessageFor: (post: Channel) => Message | undefined;
}): JSX.Element {
  // The header is visual only: rows are links, not table cells, so assistive
  // tech reads each row's own text (the reply count carries its own label).
  return (
    <Table>
      <Header aria-hidden="true">
        <span>
          <Trans>Topic</Trans>
        </span>
        <HeaderReplies>
          <Trans>Replies</Trans>
        </HeaderReplies>
        <span>
          <Trans>Last post</Trans>
        </span>
      </Header>

      <For each={props.posts}>
        {(post) => (
          <PostTableRow
            post={post}
            forum={props.forum}
            statsFor={props.statsFor}
            lastMessageFor={props.lastMessageFor}
          />
        )}
      </For>
    </Table>
  );
}

/**
 * A single row of the Classic+ table
 */
function PostTableRow(props: {
  post: Channel;
  forum: Channel;
  statsFor: (
    post: Channel,
  ) => { replies: number; lastMessageId?: string } | undefined;
  lastMessageFor: (post: Channel) => Message | undefined;
}) {
  const navigate = useNavigate();

  // Resolve applied tag ids against the forum's definitions; dangling ids
  // (tag deleted after the post was created) are simply not rendered.
  const tags = createMemo(() =>
    props.post.appliedTags
      .map((id) => props.forum.tags.find((tag) => tag.id === id))
      .filter((tag) => !!tag),
  );

  const stats = () => props.statsFor(props.post);

  // Last post column. With stats: no replies means the starter is the last
  // post (its creator, its created time); otherwise the computed last
  // message, or, when that message is gone (deleted between the count and
  // the fetch), the stored last activity time with no author rather than
  // the creator. Without stats: the stored last activity time when the post
  // has a reply (no author: the stored id may point at a message we never
  // fetched), else the post itself. A system message or webhook post shows
  // the time only.
  const lastPost = createMemo((): { at: Date; author?: User } => {
    const created = { at: props.post.createdAt, author: props.post.creator };
    const value = stats();

    if (value) {
      if (value.replies === 0) return created;

      const message = props.lastMessageFor(props.post);
      if (message) {
        return {
          at: message.createdAt,
          author: message.systemMessage ? undefined : message.author,
        };
      }

      return { at: props.post.updatedAt };
    }

    const lastAt = props.post.lastMessageAt;
    if (lastAt && hasReplies(props.post)) return { at: lastAt };

    return created;
  });

  const open = () => navigate(props.post.path);

  return (
    <Row
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <Topic>
        <TitleLine>
          <Show when={props.post.unread}>
            <UnreadDot />
          </Show>
          <Title unread={props.post.unread}>{props.post.name}</Title>
          <Show when={props.post.archived}>
            <Symbol size={16}>archive</Symbol>
          </Show>
        </TitleLine>

        <Show when={tags().length}>
          <TagRow>
            <For each={tags()}>
              {(tag) => (
                <Tag>
                  <Show when={tag!.emoji}>
                    <TextWithEmoji content={tag!.emoji} />{" "}
                  </Show>
                  <TextWithEmoji content={tag!.name} />
                </Tag>
              )}
            </For>
          </TagRow>
        </Show>

        <Show when={props.post.creator}>
          {(creator) => (
            <Muted>
              <Text class="label" size="small">
                <Trans>by</Trans>{" "}
                <DisplayName
                  user={creator()}
                  name={creator().displayName}
                  brand={isSlogaStaff(creator())}
                />
              </Text>
            </Muted>
          )}
        </Show>
      </Topic>

      <Replies empty={!stats()}>
        <PhoneOnly>
          <Symbol size={16}>chat_bubble</Symbol>
        </PhoneOnly>
        {/* The bare number is for sight; assistive tech gets "n replies".
            An absent count announces nothing rather than "dash". */}
        <Show when={stats()} fallback={<span aria-hidden="true">—</span>}>
          {(value) => (
            <>
              <span aria-hidden="true">{value().replies}</span>
              <ScreenReaderOnly>
                <Plural
                  value={value().replies}
                  one="# reply"
                  other="# replies"
                />
              </ScreenReaderOnly>
            </>
          )}
        </Show>
      </Replies>

      <LastPost>
        {/* Decorative: with an author the avatar is always an <img> with no
            alt (no custom avatar falls back to the default one), so it is
            hidden and the "by" line beside it carries the author's name. */}
        <Show when={lastPost().author}>
          {(author) => (
            <DecorativeSlot aria-hidden="true">
              <Avatar
                src={author().animatedAvatarURL}
                fallback={author().displayName}
                size={24}
              />
            </DecorativeSlot>
          )}
        </Show>
        <LastPostLines>
          <Text class="label" size="small">
            <Time format="relative" value={lastPost().at} />
          </Text>
          <Show when={lastPost().author}>
            {(author) => (
              <Text class="label" size="small">
                <Trans>by</Trans>{" "}
                <DisplayName
                  user={author()}
                  name={author().displayName}
                  brand={isSlogaStaff(author())}
                />
              </Text>
            )}
          </Show>
        </LastPostLines>
      </LastPost>
    </Row>
  );
}

const Table = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container)",
    overflow: "hidden",
  },
});

const Header = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 80px 200px",
    columnGap: "var(--gap-lg)",
    padding: "var(--gap-md) var(--gap-lg)",
    borderBlockEnd: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.75rem",
    fontWeight: 500,

    _phone: {
      display: "none",
    },
  },
});

const HeaderReplies = styled("span", {
  base: {
    textAlign: "right",
  },
});

const Row = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 80px 200px",
    columnGap: "var(--gap-lg)",
    alignItems: "center",
    padding: "var(--gap-md) var(--gap-lg)",
    borderBlockEnd: "1px solid var(--md-sys-color-outline-variant)",
    cursor: "pointer",
    transition: "var(--transitions-fast) background",

    "&:last-child": {
      borderBlockEnd: "none",
    },

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },

    // One column: the topic takes the full width and the reply count and
    // last post wrap underneath it as a single meta line.
    _phone: {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: "var(--gap-md)",
      rowGap: "var(--gap-sm)",
    },
  },
});

const Topic = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    minWidth: 0,

    _phone: {
      flexBasis: "100%",
    },
  },
});

const TitleLine = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const Title = styled("span", {
  base: {
    minWidth: 0,
    overflowWrap: "anywhere",
    lineHeight: "1.25rem",
    fontSize: "0.875rem",
    fontWeight: 400,
  },
  variants: {
    unread: {
      true: {
        fontWeight: 700,
      },
    },
  },
});

const Muted = styled("div", {
  base: {
    minWidth: 0,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Replies = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "var(--gap-xs)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.875rem",
    fontVariantNumeric: "tabular-nums",

    _phone: {
      justifyContent: "flex-start",
      fontSize: "0.75rem",
    },
  },
  variants: {
    // No stats (not requested, no Read Message History, old server): the
    // desktop column shows a dash, the phone meta line drops the count.
    empty: {
      true: {
        _phone: {
          display: "none",
        },
      },
    },
  },
});

const PhoneOnly = styled("span", {
  base: {
    display: "none",

    _phone: {
      display: "inline-flex",
    },
  },
});

// Read by assistive tech, not painted (Panda's built-in `srOnly` utility).
const ScreenReaderOnly = styled("span", {
  base: {
    srOnly: true,
  },
});

const LastPost = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const LastPostLines = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    color: "var(--md-sys-color-on-surface-variant)",

    "& > *": {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },

    _phone: {
      flexDirection: "row",
      gap: "var(--gap-sm)",
    },
  },
});

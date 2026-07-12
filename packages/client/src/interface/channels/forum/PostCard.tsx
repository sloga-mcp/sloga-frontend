import { For, Show, createMemo } from "solid-js";

import { Channel, Message } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useNavigate } from "@revolt/routing";
import { Avatar, Text } from "@revolt/ui";
import { Time } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * A single forum post card: title, tag chips, starter excerpt, author and
 * last-activity time
 */
export function PostCard(props: {
  post: Channel;
  forum: Channel;
  starter?: Message;
}) {
  const navigate = useNavigate();

  // Resolve applied tag ids against the forum's definitions; dangling ids
  // (tag deleted after the post was created) are simply not rendered.
  const tags = createMemo(() =>
    props.post.appliedTags
      .map((id) => props.forum.tags.find((tag) => tag.id === id))
      .filter((tag) => !!tag),
  );

  const author = () => props.starter?.author;

  const lastActive = () => props.post.updatedAt;

  return (
    <Card onClick={() => navigate(props.post.path)}>
      <Row>
        <Text class="title" size="small">
          {props.post.name}
        </Text>
        <Show when={props.post.archived}>
          <Symbol size={16}>archive</Symbol>
        </Show>
      </Row>

      <Show when={tags().length}>
        <TagRow>
          <For each={tags()}>
            {(tag) => (
              <Tag>
                <Show when={tag!.emoji}>{tag!.emoji} </Show>
                {tag!.name}
              </Tag>
            )}
          </For>
        </TagRow>
      </Show>

      <Show when={props.starter?.content}>
        <Excerpt>{props.starter!.content}</Excerpt>
      </Show>

      <Footer>
        <Show when={author()}>
          <Avatar src={author()!.animatedAvatarURL} size={20} />
          <Text class="label" size="small">
            {author()!.displayName}
          </Text>
        </Show>
        <FooterGrow />
        <Show when={props.post.unread}>
          <UnreadDot />
        </Show>
        <Text class="label" size="small">
          <Time format="relative" value={lastActive()} />
        </Text>
      </Footer>
    </Card>
  );
}

const Card = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container)",
    cursor: "pointer",
    transition: "var(--transitions-fast) background",
    minWidth: 0,

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const TagRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const Tag = styled("span", {
  base: {
    padding: "1px var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    fontSize: "0.75rem",
    whiteSpace: "nowrap",
  },
});

const Excerpt = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
    lineClamp: 3,
    overflowWrap: "anywhere",
  },
});

const Footer = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    marginTop: "var(--gap-sm)",
  },
});

const FooterGrow = styled("div", {
  base: {
    flexGrow: 1,
  },
});

const UnreadDot = styled("div", {
  base: {
    width: "8px",
    height: "8px",
    flexShrink: 0,
    borderRadius: "var(--borderRadius-circle)",
    background: "var(--md-sys-color-primary)",
  },
});

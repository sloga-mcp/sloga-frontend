import { For, Show, createMemo } from "solid-js";

import { Channel, Message } from "stoat.js";
import { styled } from "styled-system/jsx";

import { TextWithEmoji, renderSimpleMarkdown } from "@revolt/markdown";
import { useNavigate } from "@revolt/routing";
import { Avatar, Text, isSlogaStaff } from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Time } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { DecorativeSlot, Tag, TagRow, UnreadDot } from "./forumStyles";

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

  // Prefer the starter's author; fall back to the server-stamped thread
  // creator, which the API returns even without ReadMessageHistory.
  const author = () => props.starter?.author ?? props.post.creator;

  const lastActive = () => props.post.updatedAt;

  const open = () => navigate(props.post.path);

  return (
    <Card
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
                <Show when={tag!.emoji}>
                  <TextWithEmoji content={tag!.emoji} />{" "}
                </Show>
                <TextWithEmoji content={tag!.name} />
              </Tag>
            )}
          </For>
        </TagRow>
      </Show>

      <Show when={props.starter?.content}>
        <Excerpt>{renderSimpleMarkdown(props.starter!.content!)}</Excerpt>
      </Show>

      <Footer>
        <Show when={author()}>
          <DecorativeSlot aria-hidden="true">
            <Avatar src={author()!.animatedAvatarURL} size={20} />
          </DecorativeSlot>
          <Text class="label" size="small">
            <DisplayName
              user={author()}
              name={author()!.displayName}
              brand={isSlogaStaff(author())}
            />
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

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
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

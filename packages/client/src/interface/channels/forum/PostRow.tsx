import { For, JSX, Match, Show, Switch, createMemo } from "solid-js";

import { Plural, Trans } from "@lingui-solid/solid/macro";
import { Channel, Message } from "stoat.js";
import { styled } from "styled-system/jsx";

import { hasReplies } from "@revolt/common/lib/forumLayout";
import { TextWithEmoji } from "@revolt/markdown";
import { useNavigate } from "@revolt/routing";
import { Avatar, isSlogaStaff } from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Time } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { DecorativeSlot, Tag, TagRow, UnreadDot } from "./forumStyles";

/**
 * A single forum post in the Classic layout (Discourse-style row): creator
 * avatar, title, tag chips, a last-activity line and the reply count.
 *
 * `stats` is undefined whenever counts are unavailable (not requested, no
 * Read Message History, or an older server): the count is then hidden and
 * the activity line falls back to the post's stored last message time.
 */
export function PostRow(props: {
  post: Channel;
  forum: Channel;
  stats?: { replies: number; lastMessageId?: string };
  lastMessage?: Message;
}): JSX.Element {
  const navigate = useNavigate();

  // Resolve applied tag ids against the forum's definitions; dangling ids
  // (tag deleted after the post was created) are simply not rendered.
  const tags = createMemo(() =>
    props.post.appliedTags
      .map((id) => props.forum.tags.find((tag) => tag.id === id))
      .filter((tag) => !!tag),
  );

  const creator = () => props.post.creator;

  // System messages and webhook posts have no user to name.
  const replier = () =>
    props.lastMessage && !props.lastMessage.systemMessage
      ? props.lastMessage.author
      : undefined;

  // Replies exist per the stats when we have them, otherwise per the stored
  // last message id (lags behind and survives deletes, so copy only).
  const replied = () =>
    props.stats ? props.stats.replies > 0 : hasReplies(props.post);

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
      {/* The avatar is decorative and hidden from assistive tech: its image
          has no alt text, and with no creator the fallback icon's `person`
          ligature would be read aloud ahead of the title. The creator is
          named in the meta line only while the post has no replies. */}
      <DecorativeSlot aria-hidden="true">
        <Avatar
          size={32}
          src={creator()?.animatedAvatarURL}
          fallback={
            creator() ? (
              creator()!.displayName
            ) : (
              <Symbol size={18}>person</Symbol>
            )
          }
        />
      </DecorativeSlot>

      <Body>
        <TitleLine>
          <Title unread={props.post.unread}>{props.post.name}</Title>
          <Show when={props.post.unread}>
            <UnreadDot />
          </Show>
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

        <Meta>
          <Switch
            fallback={
              <>
                <Show when={creator()}>
                  <Name>
                    <DisplayName
                      user={creator()}
                      name={creator()!.displayName}
                      brand={isSlogaStaff(creator())}
                    />
                  </Name>
                </Show>
                <Trans>posted</Trans>
                <Time format="relative" value={props.post.createdAt} />
              </>
            }
          >
            <Match
              when={props.stats && props.stats.replies > 0 && props.lastMessage}
            >
              <Symbol size={14}>reply</Symbol>
              <Show when={replier()}>
                <Name>
                  <DisplayName
                    user={replier()}
                    name={replier()!.displayName}
                    brand={isSlogaStaff(replier())}
                  />
                </Name>
              </Show>
              <Trans>replied</Trans>
              <Time format="relative" value={props.lastMessage!.createdAt} />
            </Match>
            <Match when={replied()}>
              <Symbol size={14}>reply</Symbol>
              <Time format="relative" value={props.post.updatedAt} />
            </Match>
          </Switch>
        </Meta>
      </Body>

      <Show when={props.stats}>
        <Count>
          <Plural
            value={props.stats!.replies}
            one="# reply"
            other="# replies"
          />
        </Count>
      </Show>
    </Row>
  );
}

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm) var(--gap-md)",
    minWidth: 0,
    cursor: "pointer",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    transition: "var(--transitions-fast) background",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },
  },
});

const Body = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    flexGrow: 1,
    minWidth: 0,
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.9375rem",
    color: "var(--md-sys-color-on-surface)",
  },
  variants: {
    unread: {
      true: { fontWeight: 600 },
      false: { fontWeight: 400 },
    },
  },
  defaultVariants: {
    unread: false,
  },
});

const Meta = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Name = styled("span", {
  base: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: 600,
  },
});

const Count = styled("span", {
  base: {
    flexShrink: 0,
    whiteSpace: "nowrap",
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

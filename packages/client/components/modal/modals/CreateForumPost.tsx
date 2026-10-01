import { Match, Show, Switch, createSignal } from "solid-js";

import { createFormControl, createFormGroup } from "solid-forms";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { resolvePostDefault } from "@revolt/common";
import { useNavigate } from "@revolt/routing";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { AutoArchiveMenuItems } from "@revolt/ui/components/utils/AutoArchiveMenuItems";
import { useSearchSpace } from "@revolt/ui/components/utils/autoComplete";

import { useModals } from "..";
import { Modals } from "../types";

import { ForumTagChips, MAX_APPLIED_TAGS } from "./ForumTagChips";

/**
 * Modal to create a new post in a forum channel
 */
export function CreateForumPostModal(
  props: DialogProps & Modals & { type: "create_forum_post" },
) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { showError } = useModals();
  const client = useClient();

  // The forum's server members, channels and roles, so the body suggests
  // mentions, channel links and emoji the way the chat composer does.
  const searchSpace = useSearchSpace(() => props.channel, client);

  const [selectedTags, setSelectedTags] = createSignal<string[]>([]);

  const group = createFormGroup({
    title: createFormControl("", { required: true }),
    content: createFormControl("", { required: true }),
    // Pre-selected to the forum's own default; the resolver maps a missing
    // or out-of-range value to 7 days (the server's own fallback) and keeps
    // 0 (never) — so no `??`/`||` on the raw value.
    autoArchiveMinutes: createFormControl(
      // eslint-disable-next-line solid/reactivity -- snapshot of the forum default when the modal opens
      String(resolvePostDefault(props.channel.defaultAutoArchiveMinutes)),
    ),
  });

  // Moderated tags are only offered to members who can actually apply them.
  const availableTags = () =>
    props.channel.tags.filter(
      (tag) => !tag.moderated || props.channel.havePermission("ManageChannel"),
    );

  function toggleTag(id: string) {
    setSelectedTags((tags) =>
      tags.includes(id)
        ? tags.filter((tag) => tag !== id)
        : tags.length >= MAX_APPLIED_TAGS
          ? tags
          : [...tags, id],
    );
  }

  async function onSubmit() {
    // Enter in the title submits the form directly, past the disabled
    // Create button, so the required-tag rule has to be checked here too.
    if (missingRequiredTag()) return;

    try {
      const { post } = await props.channel.createPost({
        title: group.controls.title.value.trim(),
        tags: selectedTags(),
        message: { content: group.controls.content.value },
        auto_archive_minutes: Number(group.controls.autoArchiveMinutes.value),
      });

      navigate(post.path);
      props.onClose();
    } catch (error) {
      showError(error);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  const missingRequiredTag = () =>
    props.channel.requireTag && selectedTags().length === 0;

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>New post</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Create</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group) || missingRequiredTag(),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Form2.TextField
            minlength={1}
            maxlength={100}
            counter
            name="title"
            control={group.controls.title}
            label={t`Title`}
          />

          {/* The composer's editor, for its suggestions. No `onComplete`,
              so Enter starts a new line instead of submitting: as a
              single-line field, Enter (and Shift+Enter) submitted the whole
              post from the first line, on every platform; reported from
              Android 2026-09-11. Enter with suggestions open accepts one. */}
          <PostBody>
            <Form2.TextEditor
              control={group.controls.content}
              placeholder={t`Message`}
              autoCompleteSearchSpace={searchSpace}
            />
          </PostBody>

          <Show when={availableTags().length}>
            <Column gap="sm">
              <Show
                when={props.channel.requireTag}
                fallback={<Trans>Tags</Trans>}
              >
                <Trans>Tags (at least one required)</Trans>
              </Show>
              <ForumTagChips
                tags={availableTags()}
                selected={selectedTags()}
                onToggle={toggleTag}
              />
            </Column>
          </Show>

          {/* A forum can require a tag and still offer this member none to
              apply. The block above then renders NOTHING and `Create` stays
              disabled for good with nothing on screen saying why, which reads
              exactly as "there is nowhere to add tags" — which is what was
              reported on 2026-09-10, by the person who had turned Require
              tags ON and never added any (they are separate controls on the
              same settings screen).

              The two ways to get here need different answers, and the
              no-tags-at-all one is the common one: telling the channel's own
              manager to go ask a manager is what made the first version of
              this message useless to the reporter. */}
          <Show when={props.channel.requireTag && !availableTags().length}>
            <small>
              <Switch>
                <Match when={!props.channel.tags.length}>
                  <Show
                    when={props.channel.havePermission("ManageChannel")}
                    fallback={
                      <Trans>
                        Every post here needs a tag, but this forum has no tags
                        yet. Ask someone who manages this channel to add some.
                      </Trans>
                    }
                  >
                    <Trans>
                      Every post here needs a tag, but this forum has no tags
                      yet. Add them in this channel's settings, under Forum.
                    </Trans>
                  </Show>
                </Match>
                <Match when={availableTags().length === 0}>
                  <Trans>
                    Every post here needs a tag, but none of this forum's tags
                    are ones you can apply. Ask someone who manages this
                    channel.
                  </Trans>
                </Match>
              </Switch>
            </small>
          </Show>

          <Form2.Select
            label={t`Auto-archive after inactivity`}
            control={group.controls.autoArchiveMinutes}
          >
            <AutoArchiveMenuItems />
          </Form2.Select>
        </Column>
      </form>
    </Dialog>
  );
}

/**
 * Caps the post body's height; the editor's own scroller takes the overflow.
 * No `overflow` here: it would clip the suggestion popup, which CodeMirror
 * positions absolutely when the dialog's animation leaves a transform.
 */
const PostBody = styled("div", {
  base: {
    "& .cm-scroller": {
      maxHeight: "40vh",
    },
  },
});

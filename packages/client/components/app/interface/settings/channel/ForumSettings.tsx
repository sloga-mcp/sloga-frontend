import { For, Show, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { resolvePostDefault } from "@revolt/common";
import { TextWithEmoji } from "@revolt/markdown";
import { startsWithPackPUA } from "@revolt/markdown/emoji/UnicodeEmoji";
import { useModals } from "@revolt/modal";
// CompositionMediaPicker comes through the `@revolt/ui` index on purpose:
// deep-importing its module pulled GifPicker (which calls `typography.raw()`
// at module scope) ahead of `typography` itself, and the app died at boot
// with a TDZ ReferenceError.
import {
  Button,
  Checkbox,
  Column,
  CompositionMediaPicker,
  FloatingSelect,
  Row,
  Text,
} from "@revolt/ui";
import { MenuItem } from "@revolt/ui/components/design/Menu";
import { AutoArchiveField } from "@revolt/ui/components/utils/AutoArchiveField";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { ChannelSettingsProps } from "../ChannelSettings";

interface EditableTag {
  /** Existing tag id; undefined for tags added in this session. */
  id?: string;
  name: string;
  emoji: string;
  moderated: boolean;
}

const MAX_TAGS = 20;

/**
 * What the emoji picker hands back, as a tag stores it. Server emoji come
 * as `:id:` and are kept that way (that is what renders them as images).
 * Unicode emoji come prefixed with the PICKER USER's pack marker, which is
 * a per-reader appearance setting and must not be baked into a tag every
 * member sees, so it is dropped.
 */
const tagEmojiFromPicker = (emoji: string) =>
  startsWithPackPUA(emoji) ? emoji.slice(1) : emoji;

/**
 * Forum settings: tag definitions, require-tag switch and default sort
 */
export default function ForumSettings(props: ChannelSettingsProps) {
  const { t } = useLingui();
  const { showError } = useModals();

  /* eslint-disable solid/reactivity */
  // initial values only; the working copy is saved wholesale
  const [tags, setTags] = createStore<EditableTag[]>(
    props.channel.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      emoji: tag.emoji ?? "",
      moderated: tag.moderated ?? false,
    })),
  );
  const [requireTag, setRequireTag] = createSignal(props.channel.requireTag);
  const [defaultSort, setDefaultSort] = createSignal<string>(
    props.channel.defaultSort,
  );
  const [defaultLayout, setDefaultLayout] = createSignal<string>(
    props.channel.defaultLayout,
  );
  const [forceSort, setForceSort] = createSignal(props.channel.forceSort);
  // minutes; a missing or invalid forum default shows as the fallback new
  // posts would get anyway. A custom duration set elsewhere survives, so
  // opening this screen and saving cannot quietly round it to a preset.
  const [defaultAutoArchive, setDefaultAutoArchive] = createSignal<number>(
    resolvePostDefault(props.channel.defaultAutoArchiveMinutes),
  );
  /* eslint-enable solid/reactivity */

  const [saving, setSaving] = createSignal(false);

  function addTag() {
    setTags(tags.length, { name: "", emoji: "", moderated: false });
  }

  function removeTag(index: number) {
    setTags(produce((tags) => tags.splice(index, 1)));
  }

  async function save() {
    setSaving(true);
    try {
      await props.channel.edit({
        // `tags`/`require_tag`/`default_sort`/`default_layout`/`force_sort`/
        // `default_auto_archive_minutes` are additive fields the typed client
        // predates; the PATCH route passes them through verbatim.
        tags: tags.map((tag) => ({
          id: tag.id,
          name: tag.name.trim(),
          emoji: tag.emoji.trim() || undefined,
          moderated: tag.moderated,
        })),
        require_tag: requireTag(),
        default_sort: defaultSort(),
        default_layout: defaultLayout(),
        force_sort: forceSort(),
        default_auto_archive_minutes: defaultAutoArchive(),
      } as Parameters<typeof props.channel.edit>[0]);
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  /**
   * "Require tags" and the tag list are separate controls on this one screen,
   * and nothing used to stop them being saved in the one combination that
   * cannot work: require a tag, define none. Every post in the forum is then
   * refused, with no tag block in the composer to explain it — that is the
   * state a 2026-09-10 report arrived in, from the person who had set it.
   */
  const namedTags = () => tags.filter((tag) => tag.name.trim().length >= 1);
  const requiresTagsItHasNot = () => requireTag() && namedTags().length === 0;

  const canSave = () =>
    !saving() &&
    !requiresTagsItHasNot() &&
    tags.every((tag) => {
      const name = tag.name.trim();
      return name.length >= 1 && name.length <= 32;
    });

  return (
    <Column gap="xl">
      <Column>
        <Text class="label">
          <Trans>Tags</Trans>
        </Text>
        <Text>
          <Trans>
            Tags let members categorize posts. Each tag can have an optional
            emoji, including this server's own. Moderated tags can only be
            applied by members who can manage this channel.
          </Trans>
        </Text>

        <For each={tags}>
          {(tag, index) => (
            <TagEditor>
              {/* A picker, not a text box. The old free-text box took
                  anything, so `:custom_emoji:` was stored and shown as
                  literal text, and its only label was a 🏷️ placeholder, so
                  it read as a second name field (reported 2026-09-11). */}
              <EmojiSlot>
                <CompositionMediaPicker
                  emojiOnly
                  onMessage={() => {}}
                  onTextReplacement={(emoji) =>
                    setTags(index(), "emoji", tagEmojiFromPicker(emoji))
                  }
                >
                  {(picker) => (
                    <EmojiButton
                      type="button"
                      ref={picker.ref}
                      onClick={(e) => picker.onClickEmoji(e)}
                      aria-label={
                        tag.emoji ? t`Change tag emoji` : t`Add a tag emoji`
                      }
                      use:floating={{
                        tooltip: {
                          placement: "top",
                          content: tag.emoji
                            ? t`Change tag emoji`
                            : t`Add a tag emoji`,
                        },
                      }}
                    >
                      <Show
                        when={tag.emoji}
                        fallback={<Symbol size={20}>add_reaction</Symbol>}
                      >
                        <TextWithEmoji content={tag.emoji} />
                      </Show>
                    </EmojiButton>
                  )}
                </CompositionMediaPicker>
                <Show when={tag.emoji}>
                  <EmojiClear
                    type="button"
                    aria-label={t`Remove tag emoji`}
                    onClick={() => setTags(index(), "emoji", "")}
                  >
                    <Symbol size={14}>close</Symbol>
                  </EmojiClear>
                </Show>
              </EmojiSlot>
              <TagInput
                placeholder={t`Tag name`}
                maxlength={32}
                value={tag.name}
                onInput={(e) => setTags(index(), "name", e.currentTarget.value)}
              />
              <Checkbox
                checked={tag.moderated}
                onChange={(e) =>
                  setTags(index(), "moderated", e.currentTarget.checked)
                }
              >
                <Trans>Moderated</Trans>
              </Checkbox>
              <Button
                size="sm"
                variant="text"
                onPress={() => removeTag(index())}
              >
                <Symbol size={18}>delete</Symbol>
              </Button>
            </TagEditor>
          )}
        </For>

        <div>
          <Button
            size="sm"
            variant="text"
            isDisabled={tags.length >= MAX_TAGS}
            onPress={addTag}
          >
            <Symbol size={18}>add</Symbol> <Trans>Add tag</Trans>
          </Button>
        </div>
      </Column>

      <Column>
        <Text class="label">
          <Trans>Require tags</Trans>
        </Text>
        <Checkbox
          checked={requireTag()}
          onChange={(e) => setRequireTag(e.currentTarget.checked)}
        >
          <Trans>Every post must have at least one tag</Trans>
        </Checkbox>
        <Show when={requiresTagsItHasNot()}>
          <Text>
            <Trans>
              Add at least one tag, or turn this off — a forum that requires a
              tag it does not have cannot accept any posts.
            </Trans>
          </Text>
        </Show>
      </Column>

      <Column>
        <Text class="label">
          <Trans>Default sort order</Trans>
        </Text>
        {/* A select rather than a connected button row: `Button`'s group
            variants are start/end only, so a third mode has no segment to
            sit in without reworking that component's corner styling. */}
        <FloatingSelect
          value={defaultSort()}
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (value) setDefaultSort(value);
          }}
        >
          <MenuItem value="LatestActivity">
            <Trans>Latest activity</Trans>
          </MenuItem>
          <MenuItem value="CreationDate">
            <Trans>Creation date</Trans>
          </MenuItem>
          <MenuItem value="Alphabetical">
            <Trans>A-Z</Trans>
          </MenuItem>
        </FloatingSelect>

        <Checkbox
          checked={forceSort()}
          onChange={(e) => setForceSort(e.currentTarget.checked)}
        >
          <Trans>Use this order for everyone</Trans>
        </Checkbox>
        <Text>
          <Trans>
            Members browse this forum in the order above and cannot change it.
            Use this for a forum that serves as an info board.
          </Trans>
        </Text>
      </Column>

      <Column>
        <Text class="label">
          <Trans>Default layout</Trans>
        </Text>
        <FloatingSelect
          value={defaultLayout()}
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (value) setDefaultLayout(value);
          }}
        >
          <MenuItem value="Modern">
            <Trans>Modern</Trans>
          </MenuItem>
          <MenuItem value="Classic">
            <Trans>Classic</Trans>
          </MenuItem>
          <MenuItem value="ClassicPlus">
            <Trans>Classic+</Trans>
          </MenuItem>
        </FloatingSelect>
        <Text>
          <Trans>Readers can still switch the layout for themselves.</Trans>
        </Text>
      </Column>

      <Column>
        <Text class="label">
          <Trans>Default auto-archive for new posts</Trans>
        </Text>
        <Text>
          <Trans>
            New posts archive after this long without activity. You can change
            it on each post.
          </Trans>
        </Text>
        <AutoArchiveField
          value={defaultAutoArchive()}
          onChange={setDefaultAutoArchive}
        />
      </Column>

      <Row>
        <Button onPress={save} isDisabled={!canSave()}>
          <Trans>Save</Trans>
        </Button>
      </Row>
    </Column>
  );
}

const TagEditor = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    flexWrap: "wrap",
  },
});

const TagInput = styled("input", {
  base: {
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1.5px solid var(--md-sys-color-outline)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    outline: "none",
    flexGrow: 1,
    minWidth: "120px",
  },
});

/**
 * Emoji button plus its remove control, drawn as one box the height of the
 * name input beside it
 */
const EmojiSlot = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    height: "38px",
    borderRadius: "8px",
    border: "1.5px solid var(--md-sys-color-outline)",
    background: "var(--md-sys-color-surface-container)",
    overflow: "hidden",
  },
});

const EmojiButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "40px",
    height: "100%",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    fill: "currentColor",
    "--emoji-size": "22px",

    "& img": {
      margin: 0,
      verticalAlign: "middle",
    },

    _hover: {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

const EmojiClear = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "100%",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    fill: "currentColor",

    _hover: {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

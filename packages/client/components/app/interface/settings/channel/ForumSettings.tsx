import { For, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useModals } from "@revolt/modal";
import { Button, Checkbox, Column, Row, Text } from "@revolt/ui";
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
        // `tags`/`require_tag`/`default_sort` are additive fields the typed
        // client predates; the PATCH route passes them through verbatim.
        tags: tags.map((tag) => ({
          id: tag.id,
          name: tag.name.trim(),
          emoji: tag.emoji.trim() || undefined,
          moderated: tag.moderated,
        })),
        require_tag: requireTag(),
        default_sort: defaultSort(),
      } as Parameters<typeof props.channel.edit>[0]);
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  const canSave = () =>
    !saving() &&
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
            Tags let members categorise posts. Moderated tags can only be
            applied by members who can manage this channel.
          </Trans>
        </Text>

        <For each={tags}>
          {(tag, index) => (
            <TagEditor>
              <TagInput
                style={{ width: "56px", "flex-grow": "0" }}
                placeholder="🏷️"
                maxlength={32}
                value={tag.emoji}
                onInput={(e) => setTags(index(), "emoji", e.currentTarget.value)}
              />
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
      </Column>

      <Column>
        <Text class="label">
          <Trans>Default sort order</Trans>
        </Text>
        <Row>
          <Button
            group="connected-start"
            groupActive={defaultSort() === "LatestActivity"}
            size="sm"
            onPress={() => setDefaultSort("LatestActivity")}
          >
            <Trans>Latest activity</Trans>
          </Button>
          <Button
            group="connected-end"
            groupActive={defaultSort() === "CreationDate"}
            size="sm"
            onPress={() => setDefaultSort("CreationDate")}
          >
            <Trans>Creation date</Trans>
          </Button>
        </Row>
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

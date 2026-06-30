import { createFormControl, createFormGroup } from "solid-forms";
import { For, Match, Show, Switch, createResource } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { css } from "styled-system/css";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useError } from "@revolt/i18n";
import {
  Avatar,
  CategoryButton,
  CircularProgress,
  Column,
  Form2,
  Row,
  Text,
} from "@revolt/ui";

interface Sticker {
  id: string;
  server_id: string;
  creator_id: string;
  name: string;
  description?: string;
  file_id: string;
  format: string;
  nsfw?: boolean;
}

/**
 * Sticker list for server settings
 */
export function StickerList(props: { server: Server }) {
  const err = useError();
  const { t } = useLingui();
  const client = useClient();

  const [stickers, { refetch }] = createResource<Sticker[]>(async () => {
    const [key, value] = client().authenticationHeader;
    const res = await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${props.server.id}/stickers`,
      { headers: { [key]: value } },
    );
    if (!res.ok) return [];
    return res.json();
  });

  const editGroup = createFormGroup({
    name: createFormControl("", { required: true }),
    description: createFormControl(""),
    file: createFormControl<string | File[] | null>(null, { required: true }),
  });

  async function onSubmit() {
    const body = new FormData();
    body.append("file", editGroup.controls.file.value![0]);

    const [key, value] = client().authenticationHeader;

    // Upload the sticker file to autumn
    const uploadRes = await fetch(`${CONFIGURATION.DEFAULT_MEDIA_URL}/stickers`, {
      method: "POST",
      body,
      headers: { [key]: value },
    });
    if (!uploadRes.ok) throw new Error("Upload failed");

    const { id: fileId } = await uploadRes.json();

    // Create the sticker
    await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${props.server.id}/stickers/${fileId}`,
      {
        method: "PUT",
        headers: {
          [key]: value,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: editGroup.controls.name.value,
          description: editGroup.controls.description.value || undefined,
          nsfw: false,
        }),
      },
    );

    refetch();
  }

  function onReset() {
    editGroup.controls.name.setValue("");
    editGroup.controls.description.setValue("");
    editGroup.controls.file.setValue(null);
  }

  const submit = Form2.useSubmitHandler(editGroup, onSubmit, onReset);

  async function deleteSticker(stickerId: string) {
    const [key, value] = client().authenticationHeader;
    await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${props.server.id}/stickers/${stickerId}`,
      { method: "DELETE", headers: { [key]: value } },
    );
    refetch();
  }

  function getStickerUrl(fileId: string) {
    return `${CONFIGURATION.DEFAULT_MEDIA_URL}/stickers/${fileId}`;
  }

  return (
    <Column gap="lg">
      <Show when={props.server.havePermission("ManageCustomisation")}>
        <form onSubmit={submit}>
          <Column>
            <Row align>
              <Column>
                <Form2.FileInput
                  control={editGroup.controls.file}
                  accept="image/*,application/json"
                  imageJustify={false}
                  allowRemoval={false}
                />
              </Column>
              <Column grow>
                <Form2.TextField
                  minlength={1}
                  maxlength={32}
                  counter
                  name="name"
                  control={editGroup.controls.name}
                  label={t`Sticker Name`}
                />
                <Form2.TextField
                  maxlength={200}
                  counter
                  name="description"
                  control={editGroup.controls.description}
                  label={t`Description (optional)`}
                />
                <Row align>
                  <Form2.Submit group={editGroup}>
                    <Trans>Upload Sticker</Trans>
                  </Form2.Submit>
                  <Switch fallback={<span>{t`Ready to upload`}</span>}>
                    <Match when={editGroup.errors?.error}>
                      {err(editGroup.errors!.error)}
                    </Match>
                    <Match when={editGroup.isPending}>
                      <CircularProgress />
                    </Match>
                  </Switch>
                </Row>
              </Column>
            </Row>
          </Column>
        </form>
      </Show>

      <Column gap="sm">
        <Switch>
          <Match when={stickers.loading}>
            <CircularProgress />
          </Match>
          <Match when={stickers()?.length === 0}>
            <span>{t`No stickers yet. Upload one above!`}</span>
          </Match>
          <Match when={stickers()}>
            <For each={stickers()}>
              {(sticker) => (
                <CategoryButton
                  roundedIcon={false}
                  icon={
                    <img
                      src={getStickerUrl(sticker.file_id)}
                      style={{ width: "48px", height: "48px", "object-fit": "contain" }}
                    />
                  }
                  description={sticker.description}
                  onClick={
                    props.server.havePermission("ManageCustomisation")
                      ? () => deleteSticker(sticker.id)
                      : undefined
                  }
                >
                  <Column gap="none">
                    <span class={css({ flex: 1 })}>{sticker.name}</span>
                    <span
                      class={css({
                        flex: 1,
                        color: "var(--md-sys-color-on-surface-variant)",
                        fontSize: "0.8em",
                      })}
                    >
                      {sticker.format}
                    </span>
                  </Column>
                </CategoryButton>
              )}
            </For>
          </Match>
        </Switch>
      </Column>
    </Column>
  );
}

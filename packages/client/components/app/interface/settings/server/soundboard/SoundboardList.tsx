import { createFormControl, createFormGroup } from "solid-forms";
import { For, Match, Show, Switch, createResource } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { css } from "styled-system/css";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useError } from "@revolt/i18n";
import {
  CategoryButton,
  CircularProgress,
  Column,
  Form2,
  Row,
} from "@revolt/ui";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

interface Sound {
  id: string;
  server_id: string;
  creator_id: string;
  name: string;
  file_id: string;
  emoji?: string;
}

/**
 * Soundboard sound list for server settings — a per-server audio asset
 * managed exactly like stickers (create/list/delete, ManageCustomisation).
 * Row click previews the clip; the trailing action deletes it.
 */
export function SoundboardList(props: { server: Server }) {
  const err = useError();
  const { t } = useLingui();
  const client = useClient();

  const [sounds, { refetch }] = createResource<Sound[]>(async () => {
    const [key, value] = client().authenticationHeader;
    const res = await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${props.server.id}/sounds`,
      { headers: { [key]: value } },
    );
    if (!res.ok) return [];
    return res.json();
  });

  const editGroup = createFormGroup({
    name: createFormControl("", { required: true }),
    emoji: createFormControl(""),
    file: createFormControl<string | File[] | null>(null, { required: true }),
  });

  async function onSubmit() {
    const body = new FormData();
    body.append("file", (editGroup.controls.file.value as File[])![0]);

    const [key, value] = client().authenticationHeader;

    // Upload the audio clip to autumn's soundboard bucket (audio-only)
    const uploadRes = await fetch(
      `${CONFIGURATION.DEFAULT_MEDIA_URL}/soundboard`,
      { method: "POST", body, headers: { [key]: value } },
    );
    if (!uploadRes.ok) throw new Error("Upload failed");

    const { id: fileId } = await uploadRes.json();

    // Create the sound
    const createRes = await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${props.server.id}/sounds/${fileId}`,
      {
        method: "PUT",
        headers: { [key]: value, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editGroup.controls.name.value,
          emoji: editGroup.controls.emoji.value || undefined,
        }),
      },
    );
    if (!createRes.ok) throw new Error("Create failed");

    refetch();
  }

  function onReset() {
    editGroup.controls.name.setValue("");
    editGroup.controls.emoji.setValue("");
    editGroup.controls.file.setValue(null);
  }

  const submit = Form2.useSubmitHandler(editGroup, onSubmit, onReset);

  async function deleteSound(soundId: string) {
    const [key, value] = client().authenticationHeader;
    await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${props.server.id}/sounds/${soundId}`,
      { method: "DELETE", headers: { [key]: value } },
    );
    refetch();
  }

  function preview(fileId: string) {
    // Throwaway element — the settings preview plays on the default device
    // and is unrelated to the in-call playback path.
    const audio = new Audio(
      `${CONFIGURATION.DEFAULT_MEDIA_URL}/soundboard/${fileId}`,
    );
    void audio.play();
  }

  return (
    <Column gap="lg">
      <Show when={props.server.havePermission("ManageCustomisation")}>
        <form onSubmit={submit}>
          <Column>
            <Form2.FileInput
              control={editGroup.controls.file}
              accept="audio/*"
              imageJustify={false}
              allowRemoval={false}
            />
            <Form2.TextField
              minlength={1}
              maxlength={32}
              counter
              name="name"
              control={editGroup.controls.name}
              label={t`Sound Name`}
            />
            <Form2.TextField
              maxlength={32}
              name="emoji"
              control={editGroup.controls.emoji}
              label={t`Emoji (optional)`}
            />
            <Row align>
              <Form2.Submit group={editGroup}>
                <Trans>Upload Sound</Trans>
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
        </form>
      </Show>

      <Column gap="sm">
        <Switch>
          <Match when={sounds.loading}>
            <CircularProgress />
          </Match>
          <Match when={sounds()?.length === 0}>
            <span>{t`No sounds yet. Upload one above!`}</span>
          </Match>
          <Match when={sounds()}>
            <For each={sounds()}>
              {(sound) => (
                <CategoryButton
                  roundedIcon={false}
                  icon={<Symbol>graphic_eq</Symbol>}
                  onClick={() => preview(sound.file_id)}
                  action={
                    props.server.havePermission("ManageCustomisation") ? (
                      <IconButton onPress={() => deleteSound(sound.id)}>
                        <Symbol>delete</Symbol>
                      </IconButton>
                    ) : undefined
                  }
                >
                  <span class={css({ flex: 1 })}>
                    {sound.emoji ? `${sound.emoji} ` : ""}
                    {sound.name}
                  </span>
                </CategoryButton>
              )}
            </For>
          </Match>
        </Switch>
      </Column>
    </Column>
  );
}

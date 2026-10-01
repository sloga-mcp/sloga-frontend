import { Trans, useLingui } from "@lingui-solid/solid/macro";
import MdContentCopy from "@material-design-icons/svg/outlined/content_copy.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdLibraryAdd from "@material-design-icons/svg/outlined/library_add.svg?component-solid";
import MDPalette from "@material-design-icons/svg/outlined/palette.svg?component-solid";
import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useError } from "@revolt/i18n";
import { useModals } from "@revolt/modal";
import {
  Button,
  CategoryButton,
  CircularProgress,
  Column,
  Form2,
  IconButton,
  Row,
  Text,
  useSnackbar,
} from "@revolt/ui";
import { useMutation } from "@tanstack/solid-query";
import { createFormControl, createFormGroup } from "solid-forms";
import {
  For,
  Match,
  Switch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
} from "solid-js";
import { API, Server, ServerRole } from "stoat.js";
import { styled } from "styled-system/jsx";
import { useSettingsNavigation } from "../../Settings";
import { ChannelPermissionsEditor } from "../../channel/permissions/ChannelPermissionsEditor";
import {
  type RoleCopyPlan,
  missingAllowBits,
  planRoleCopy,
} from "./roleDuplicate";

/**
 * How long a new copy may take to reach this client before the editor stops
 * waiting to open it
 */
const COPY_SYNC_TIMEOUT_MS = 10_000;

/**
 * Server role cap when the configuration does not say (`Revolt.toml`)
 */
const DEFAULT_SERVER_ROLES_MAX = 200;

/**
 * Role editor
 */
export function ServerRoleEditor(props: { context: Server; roleId: string }) {
  const { t } = useLingui();
  const err = useError();
  const client = useClient();
  const { openModal, showError } = useModals();
  const snackbar = useSnackbar();
  const { navigate } = useSettingsNavigation();

  const role = createMemo(
    () =>
      props.context.orderedRoles.find(
        (r) => r.id == props.roleId,
      ) as ServerRole,
  );

  /* eslint-disable solid/reactivity */
  const editGroup = createFormGroup({
    name: createFormControl(role()?.name || ""),
    icon: createFormControl<string | File[] | null>(role()?.icon?.originalUrl),
    colour: createFormControl(role()?.colour || null),
    hoist: createFormControl(role()?.hoist == true),
  });
  /* eslint-enable solid/reactivity */

  const [pickerRef, setPickerRef] = createSignal<HTMLDivElement>();
  const [gridUnsaved, setGridUnsaved] = createSignal(false);

  async function onSubmit() {
    const changes: API.DataEditRole = {
      remove: [],
    };

    if (editGroup.controls.name.isDirty) {
      changes.name = editGroup.controls.name.value.trim();
    }

    if (editGroup.controls.icon.isDirty) {
      if (!editGroup.controls.icon.value) {
        changes.remove!.push("Icon");
      } else if (Array.isArray(editGroup.controls.icon.value)) {
        changes.icon = await client().uploadFile(
          "icons",
          editGroup.controls.icon.value[0],
          CONFIGURATION.DEFAULT_MEDIA_URL,
        );
      }
    }

    if (editGroup.controls.hoist.isDirty) {
      changes.hoist = editGroup.controls.hoist.value;
    }

    if (editGroup.controls.colour.isDirty) {
      changes.colour = editGroup.controls.colour.value ?? null;
    }

    await props.context.editRole(props.roleId, changes);
  }

  function onReset() {
    editGroup.controls.name.setValue(role()?.name || "");
    editGroup.controls.icon.setValue(role()?.icon?.originalUrl || null);
    editGroup.controls.hoist.setValue(role()?.hoist || false);
    editGroup.controls.colour.setValue(role()?.colour || null);
  }

  const submit = Form2.useSubmitHandler(editGroup, onSubmit, onReset);

  /**
   * The copy "Duplicate role" makes of this role
   */
  const copyPlan = createMemo(() => {
    const source = role();
    if (!source) return undefined;

    return planRoleCopy(
      {
        name: source.name,
        colour: source.colour,
        hoist: source.hoist,
        permissions: source.permissions,
      },
      t`(copy)`,
    );
  });

  /**
   * Why this member cannot duplicate this role, or undefined if they can.
   * The server checks the permission and limit rules again; these only keep
   * the button from starting a copy the server would refuse part-way through.
   */
  const duplicateBlocked = createMemo(() => {
    const server = props.context;
    const source = role();
    const plan = copyPlan();
    if (!source || !plan) return undefined;

    // Client-only: the copy is made from the saved role, and opening it would
    // throw the unsaved edits away. Covers both the form above (same condition
    // that lights its Reset and Save) and the permission grid below.
    if (editGroup.isDirty || gridUnsaved()) {
      return t`Save or discard your changes before duplicating this role.`;
    }

    if (!server.havePermission("ManageRole")) {
      return t`You need the Manage Roles permission to duplicate a role.`;
    }

    const max =
      client().configuration?.features?.limits?.global?.server_roles ??
      DEFAULT_SERVER_ROLES_MAX;
    if ((server.roles?.size ?? 0) >= max) {
      return t`This server already has the maximum of ${max} roles.`;
    }

    if (plan.permissions && !server.havePermission("ManagePermissions")) {
      return t`You need the Manage Permissions permission to copy this role's permissions.`;
    }

    // Bits reach 2^43, so the subset check stays in bigint
    if (missingAllowBits(source.permissions.a, server.permission) !== 0n) {
      return t`This role allows permissions you don't have, so you can't copy it.`;
    }

    return undefined;
  });

  /**
   * Ends a pending wait for a copy to sync; set while one is running
   */
  let stopWaiting: (() => void) | undefined;

  /**
   * Whether this editor has unmounted (the member left this role's page)
   */
  let closed = false;
  onCleanup(() => {
    closed = true;
    stopWaiting?.();
  });

  /**
   * Wait until this client's version of role `id` matches the whole copy.
   *
   * The create event lands the role with no permissions and no hoist, setting
   * permissions never writes the local map (only the `ServerRoleUpdate` that
   * follows does), and a late create event can briefly undo the edit. Both
   * this editor's form and the permission grid read their values once, at
   * mount, so opening the copy any earlier shows an empty grid whose Save
   * would wipe the copied permissions.
   * @param id Id of the new role
   * @param plan The copy it should match
   * @returns `synced` on a full match, `timeout` after COPY_SYNC_TIMEOUT_MS,
   * `closed` if this editor unmounts first
   */
  function waitForCopy(
    id: string,
    plan: RoleCopyPlan,
  ): Promise<"synced" | "timeout" | "closed"> {
    // Left while the copy was being made: never pull the member back to it
    if (closed) return Promise.resolve("closed");

    const allow = BigInt(plan.permissions?.allow ?? 0);
    const deny = BigInt(plan.permissions?.deny ?? 0);
    const colour = plan.edit?.colour ?? null;
    const hoist = plan.edit?.hoist === true;

    return new Promise<"synced" | "timeout" | "closed">((resolve) =>
      createRoot((dispose) => {
        let settled = false;

        function settle(outcome: "synced" | "timeout" | "closed") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (stopWaiting === stop) stopWaiting = undefined;
          dispose();
          resolve(outcome);
        }

        const stop = () => settle("closed");
        stopWaiting?.();
        stopWaiting = stop;

        const timer = setTimeout(() => settle("timeout"), COPY_SYNC_TIMEOUT_MS);

        createEffect(() => {
          const copy = props.context.roles?.get(id);
          if (
            copy &&
            copy.name === plan.name &&
            (copy.colour ?? null) === colour &&
            copy.hoist === hoist &&
            copy.permissions.a === allow &&
            copy.permissions.d === deny
          ) {
            settle("synced");
          }
        });
      }),
    );
  }

  const duplicate = useMutation(() => ({
    mutationFn: async (plan: RoleCopyPlan) => {
      const server = props.context;
      const { id } = await server.createRole(plan.name);

      try {
        if (plan.permissions) {
          await server.setPermissions(id, plan.permissions);
        }

        if (plan.edit) {
          await server.editRole(id, plan.edit);
        }
      } catch (error) {
        // Best effort: a half-made copy would otherwise sit in the role list
        // looking finished. The likely refusal is NotElevated (the new role's
        // rank can tie the member's own), and the server refuses the delete
        // for the same reason, so the member is told to remove it by hand.
        try {
          await server.deleteRole(id);
        } catch {
          // The error modal only renders the message, so the original reason
          // goes in front of the leftover-role sentence.
          const name = plan.name;
          throw new Error(
            `${err(error)} ${t`Couldn't remove the incomplete copy "${name}". Delete it from the role list.`}`,
            { cause: error },
          );
        }

        throw error;
      }

      const outcome = await waitForCopy(id, plan);
      if (outcome === "synced") {
        navigate(`roles/${id}`);
      } else if (outcome === "timeout") {
        // The copy is complete on the server; only this client is behind.
        // Opening it now would show the empty grid, so stay here.
        snackbar.show({
          message: t`The copy was created but has not synced yet. Reopen Roles to see it.`,
          closeable: true,
        });
      }
    },
    onError: showError,
  }));

  return (
    <Column>
      <form onSubmit={submit}>
        <Column gap="lg">
          <Form2.TextField
            minlength={1}
            maxlength={32}
            counter
            name="name"
            control={editGroup.controls.name}
            label={t`Role Name`}
          />
          <Column>
            <Row>
              <IconButton
                ref={setPickerRef}
                variant="filled"
                shape="square"
                size="lg"
                style={{ height: "auto", width: "95px" }}
                onPress={() => pickerRef()?.click()}
              >
                <MDPalette />
              </IconButton>
              <input
                ref={setPickerRef}
                type="color"
                value={editGroup.controls.colour.value ?? "#ffffff"}
                onInput={(e) => {
                  const colour = (e.currentTarget as HTMLInputElement).value;
                  editGroup.controls.colour.setValue(colour);
                  editGroup.controls.colour.markDirty(true);
                }}
                style={{
                  position: "absolute",
                  opacity: 0,
                  width: "0px",
                  height: "0px",
                  padding: 0,
                  border: "none",
                }}
              />
              <Column gap="lg">
                <Row justify wrap>
                  <For
                    each={[
                      "#7B68EE",
                      "#3498DB",
                      "#1ABC9C",
                      "#F1C40F",
                      "#FF7F50",
                      "#FD6671",
                      "#E91E63",
                      "#D468EE",
                    ]}
                  >
                    {(colour) => (
                      <Button
                        size="sm"
                        bg={colour}
                        group="standard"
                        groupActive={editGroup.controls.colour.value === colour}
                        onPress={() => {
                          editGroup.controls.colour.setValue(colour);
                          editGroup.controls.colour.markDirty(true);
                        }}
                      />
                    )}
                  </For>
                </Row>

                <Row justify wrap>
                  <For
                    each={[
                      "#594CAD",
                      "#206694",
                      "#11806A",
                      "#C27C0E",
                      "#CD5B45",
                      "#FF424F",
                      "#AD1457",
                      "#954AA8",
                    ]}
                  >
                    {(colour) => (
                      <Button
                        size="sm"
                        bg={colour}
                        group="standard"
                        groupActive={editGroup.controls.colour.value === colour}
                        onPress={() => {
                          editGroup.controls.colour.setValue(colour);
                          editGroup.controls.colour.markDirty(true);
                        }}
                      />
                    )}
                  </For>
                </Row>
              </Column>
            </Row>
          </Column>

          <Form2.FileInput
            control={editGroup.controls.icon}
            accept="image/*"
            label={t`Role Icon`}
            imageJustify={false}
          />

          <Column>
            <Text class="label">Hoist Role</Text>
            <Form2.Checkbox control={editGroup.controls.hoist}>
              Display this role above others
            </Form2.Checkbox>
          </Column>

          <Column>
            <Row>
              <Form2.Reset group={editGroup} onReset={onReset} />
              <Form2.Submit group={editGroup} requireDirty>
                <Trans>Save</Trans>
              </Form2.Submit>
              {/* A refused save (e.g. a role icon autumn rejects) lands in
                  the group's errors; without rendering them the Save button
                  just appears to do nothing. */}
              <Switch>
                <Match when={editGroup.errors?.error}>
                  {err(editGroup.errors!.error)}
                </Match>
                <Match when={editGroup.isPending}>
                  <CircularProgress />
                </Match>
              </Switch>
            </Row>
          </Column>
        </Column>
      </form>
      <Divider />
      <ChannelPermissionsEditor
        type="server_role"
        context={props.context}
        roleId={props.roleId}
        onUnsavedChange={setGridUnsaved}
      />
      <Column>
        <CategoryButton
          action="chevron"
          icon={<MdContentCopy />}
          onClick={() => navigator.clipboard.writeText(`${props.roleId}`)}
        >
          <Trans>Copy role ID</Trans>
        </CategoryButton>
        <CategoryButton
          action={
            duplicate.isPending ? <CircularProgress size={24} /> : "chevron"
          }
          icon={<MdLibraryAdd />}
          disabled={!copyPlan() || !!duplicateBlocked() || duplicate.isPending}
          description={
            duplicateBlocked() ?? (
              <Trans>
                Copies the name, color, hoist setting and server permissions.
                The icon and channel permissions are not copied.
              </Trans>
            )
          }
          onClick={() => {
            const plan = copyPlan();
            if (plan && !duplicateBlocked() && !duplicate.isPending) {
              duplicate.mutate(plan);
            }
          }}
        >
          <Trans>Duplicate role</Trans>
        </CategoryButton>
        <CategoryButton
          action="chevron"
          icon={<MdDelete />}
          onClick={() =>
            openModal({
              type: "delete_role",
              role: role(),
              cb: () => navigate("roles"),
            })
          }
        >
          <Trans>Delete Role</Trans>
        </CategoryButton>
      </Column>
    </Column>
  );
}

export const Divider = styled("div", {
  base: {
    height: "1px",
    margin: "var(--gap-sm) 0",
    background: "var(--md-sys-color-outline-variant)",
  },
});

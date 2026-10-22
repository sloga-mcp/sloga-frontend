import { useWindowCtx } from "@revolt/client/windowCtx";
import { Show, createSignal, onMount } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Dialog, DialogProps } from "@revolt/ui";

import { Modals } from "../types";
import type { ImageEditorCore } from "./ImageEditorCore";

/**
 * Edit a pending image attachment before it is sent.
 *
 * This shell stays in the boot chunk; the editor itself (canvas tooling,
 * and later the OCR auto-redact stack) loads behind a dynamic import the
 * first time the modal opens.
 *
 * The scrim deliberately has no click-to-dismiss: losing edits must go
 * through the editor's own Cancel. ESC still closes via the modal
 * controller, which discards edits — the fail-safe direction (nothing is
 * saved or sent).
 */
export function ImageEditorModal(
  props: DialogProps & Modals & { type: "image_editor" },
) {
  const [core, setCore] = createSignal<typeof ImageEditorCore>();

  onMount(async () => {
    const mod = await import("./ImageEditorCore");
    setCore(() => mod.ImageEditorCore);
  });

  return (
    <Portal mount={useWindowCtx().floatingMount()}>
      <Dialog.Scrim dark padding={false} overflow={false} show={props.show}>
        <Show
          when={core()}
          fallback={
            <Loading>
              <Trans>Loading editor…</Trans>
            </Loading>
          }
        >
          <Dynamic
            component={core()!}
            file={props.file}
            onCancel={() => props.onClose()}
            onApply={(file: globalThis.File) => {
              // A rejected save (over the size cap) leaves the editor open —
              // closing would throw away everything the user just drew.
              if (props.onSave(file) !== false) props.onClose();
            }}
          />
        </Show>
      </Dialog.Scrim>
    </Portal>
  );
}

const Loading = styled("div", {
  base: {
    display: "grid",
    placeItems: "center",
    width: "100%",
    height: "100%",
    color: "white",
  },
});

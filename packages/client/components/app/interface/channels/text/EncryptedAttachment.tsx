import { Match, Show, Switch } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { Message } from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import type { E2EEAttachmentMeta, E2EEBridge } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { canCopyImageToClipboard, copyImageToClipboard } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

// Relative, NOT the `@revolt/app` barrel: that barrel re-exports Message.tsx,
// which imports this file — going through it would close a module cycle on
// `useMessage` at evaluation time. Message.tsx reaches the menu the same way.
import { MessageContextMenu } from "../../../menus/MessageContextMenu";
import { useMessage } from "./Message";

/**
 * One end-to-end encrypted attachment (slice 3.5).
 *
 * Renders EXCLUSIVELY from the bridge's reactive attachment metadata and
 * the desktop shell's `e2ee-att` protocol — decryption happens natively
 * per request, so neither key material nor plaintext bytes transit the
 * IPC. Every non-renderable state is a VISIBLE error (fail closed, honesty
 * about loss): a pending fetch shows progress, an expired blob says so,
 * and bytes that failed digest verification are never displayed.
 */
export function EncryptedAttachment(props: {
  meta: E2EEAttachmentMeta;
  messageId: string;
  message?: Message;
  e2ee: E2EEBridge;
}) {
  const { t } = useLingui();
  const { openModal, showError } = useModals();
  const { reactPicker } = useMessage();

  const url = () =>
    props.e2ee.attachmentUrl(props.messageId, props.meta.idx ?? 0);

  const save = () =>
    void props.e2ee
      .attachmentSave(props.messageId, props.meta.idx ?? 0)
      .catch((error) =>
        console.error("[e2ee] attachment save failed", error),
      );

  const kind = () => props.meta.mime.split("/")[0];

  /**
   * Whether this attachment can be put on the clipboard. On the desktop
   * shells that is the shell's own command; on Android the render URL is
   * same-origin so the ordinary webview helper works, and there it also
   * needs a `ClipboardItem`.
   */
  const canCopy = () =>
    props.meta.state === "ready" &&
    kind() === "image" &&
    (props.e2ee.attachmentCopyImageIsNative() || canCopyImageToClipboard());

  /**
   * Copy the decrypted image. The native branch never lets plaintext reach
   * this webview at all; the Android branch fetches a same-origin URL the
   * shell decrypts per request. Returns the promise so the fullscreen
   * viewer can report the outcome on its own button.
   */
  const runCopy = () => {
    const idx = props.meta.idx ?? 0;
    return props.e2ee.attachmentCopyImageIsNative()
      ? props.e2ee.attachmentCopyImage(props.messageId, idx)
      : copyImageToClipboard(url());
  };

  /** Menu path: nothing else is watching, so failure goes to a dialog. */
  const copyImage = () =>
    void runCopy().catch((error) => {
      console.error("[e2ee] attachment copy failed", error);
      showError(new Error(t`Could not copy this image to the clipboard.`));
    });

  /** Right-click menu for a rendered E2EE attachment (parity with plain ones) */
  const contextMenu = () => (
    <MessageContextMenu
      message={props.message}
      reactPicker={reactPicker}
      encryptedFile={{
        isImage: canCopy(),
        copyImage,
        save,
      }}
    />
  );

  const humanSize = () => {
    const size = props.meta.size;
    if (size > 1e6) return `${(size / 1e6).toFixed(2)} MB`;
    if (size > 1e3) return `${(size / 1e3).toFixed(2)} KB`;
    return `${size} B`;
  };

  return (
    <Switch
      fallback={
        <StateContainer>
          <Symbol>lock</Symbol>
          <Details>
            <span>{props.meta.name}</span>
            <Hint>{humanSize()}</Hint>
          </Details>
          <Show when={props.meta.state === "ready"}>
            <SaveAction
              type="button"
              aria-label={t`Save`}
              title={t`Save`}
              onClick={save}
            >
              <Symbol>download</Symbol>
            </SaveAction>
          </Show>
        </StateContainer>
      }
    >
      <Match when={props.meta.state === "pending"}>
        <StateContainer>
          <Symbol>progress_activity</Symbol>
          <Details>
            <span>{props.meta.name}</span>
            <Hint>{t`Fetching encrypted attachment…`}</Hint>
          </Details>
        </StateContainer>
      </Match>
      <Match when={props.meta.state === "expired"}>
        <StateContainer data-error>
          <Symbol>scan_delete</Symbol>
          <Details>
            <span>{props.meta.name}</span>
            <Hint>{t`This attachment expired before it reached this device. Ask the sender to send it again.`}</Hint>
          </Details>
        </StateContainer>
      </Match>
      <Match when={props.meta.state === "failed"}>
        <Show
          when={props.meta.fail_reason === "too_large"}
          fallback={
            <StateContainer data-error>
              <Symbol>gpp_bad</Symbol>
              <Details>
                <span>{props.meta.name}</span>
                <Hint>{t`This attachment failed verification and was discarded (it may have been tampered with in transit).`}</Hint>
              </Details>
            </StateContainer>
          }
        >
          <StateContainer data-error>
            <Symbol>block</Symbol>
            <Details>
              <span>{props.meta.name}</span>
              <Hint>{t`This attachment is larger than this version of the app can open.`}</Hint>
            </Details>
          </StateContainer>
        </Show>
      </Match>
      <Match when={props.meta.state === "ready" && kind() === "image"}>
        <img
          class={css({
            maxWidth: "min(420px, 100%)",
            maxHeight: "420px",
            borderRadius: "var(--borderRadius-md)",
            cursor: "pointer",
          })}
          loading="lazy"
          alt={props.meta.name}
          src={url()}
          onClick={() =>
            openModal({
              type: "image_viewer",
              encrypted: {
                url: url(),
                filename: props.meta.name,
                humanReadableSize: humanSize(),
                onSave: save,
                onCopyImage: canCopy() ? runCopy : undefined,
              },
            })
          }
          use:floating={{ contextMenu }}
        />
      </Match>
      <Match when={props.meta.state === "ready" && kind() === "video"}>
        <video
          class={css({
            maxWidth: "min(420px, 100%)",
            maxHeight: "420px",
            borderRadius: "var(--borderRadius-md)",
          })}
          controls
          playsinline
          preload="metadata"
          src={url()}
          use:floating={{ contextMenu }}
        />
      </Match>
      <Match when={props.meta.state === "ready" && kind() === "audio"}>
        <StateContainer>
          <Details>
            <span>{props.meta.name}</span>
            <audio controls src={url()} use:floating={{ contextMenu }} />
          </Details>
        </StateContainer>
      </Match>
    </Switch>
  );
}

const StateContainer = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "center",
    width: "fit-content",
    maxWidth: "420px",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",

    // same deep purple as the plaintext attachment card (AttachmentContainer)
    color: "white",
    background: "#2E1A5E",

    "&[data-error]": {
      color: "var(--md-sys-color-on-error-container)",
      background: "var(--md-sys-color-error-container)",
    },
  },
});

const SaveAction = styled("button", {
  base: {
    appearance: "none",
    border: 0,
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    padding: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-full)",

    // brand orange, matching the plaintext card's download button
    background: "#FF8A00",
    color: "#2E1A5E",

    "&:hover": {
      background: "#FFA333",
    },
  },
});

const Details = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    minWidth: 0,
  },
});

const Hint = styled("span", {
  base: {
    fontSize: "12px",
    opacity: 0.8,
  },
});

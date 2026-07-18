import { Match, Show, Switch } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import type { E2EEAttachmentMeta, E2EEBridge } from "@revolt/client";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

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
  e2ee: E2EEBridge;
}) {
  const { t } = useLingui();

  const url = () =>
    props.e2ee.attachmentUrl(props.messageId, props.meta.idx ?? 0);

  const kind = () => props.meta.mime.split("/")[0];

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
              onClick={() =>
                void props.e2ee
                  .attachmentSave(props.messageId, props.meta.idx ?? 0)
                  .catch((error) =>
                    console.error("[e2ee] attachment save failed", error),
                  )
              }
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
        <StateContainer data-error>
          <Symbol>gpp_bad</Symbol>
          <Details>
            <span>{props.meta.name}</span>
            <Hint>{t`This attachment failed verification and was discarded (it may have been tampered with in transit).`}</Hint>
          </Details>
        </StateContainer>
      </Match>
      <Match when={props.meta.state === "ready" && kind() === "image"}>
        <img
          class={css({
            maxWidth: "min(420px, 100%)",
            maxHeight: "420px",
            borderRadius: "var(--borderRadius-md)",
          })}
          loading="lazy"
          alt={props.meta.name}
          src={url()}
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
        />
      </Match>
      <Match when={props.meta.state === "ready" && kind() === "audio"}>
        <StateContainer>
          <Details>
            <span>{props.meta.name}</span>
            <audio controls src={url()} />
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
    borderRadius: "var(--borderRadius-md)",
    color: "var(--md-sys-color-inverse-on-surface)",
    background: "var(--md-sys-color-inverse-surface)",

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
    background: "transparent",
    color: "inherit",
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    padding: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    opacity: 0.85,
    "&:hover": {
      opacity: 1,
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

import { Show, createResource } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { translateLanguageName, translateText } from "@revolt/common";
import { useState } from "@revolt/state";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

interface Props {
  /**
   * Original message content (never E2EE-decrypted text)
   */
  content: string;
}

/**
 * Automatic translation of a message, rendered beneath the original content.
 * Renders nothing while loading, on failure, or when the message is already
 * in the target language.
 */
export function MessageTranslation(props: Props) {
  const state = useState();

  const target = () =>
    (state.settings.getValue("translation:target") as string) ?? "en";

  const [translation] = createResource(
    () => [props.content, target()] as const,
    ([content, targetLanguage]) => translateText(content, targetLanguage),
  );

  return (
    <Show when={translation.state === "ready" && translation()}>
      {(result) => (
        <Translated>
          <span>{result().text}</span>
          <Caption>
            <Symbol size={12}>translate</Symbol>
            <Trans>
              Translated from {translateLanguageName(result().detectedSource)}
            </Trans>
          </Caption>
        </Translated>
      )}
    </Show>
  );
}

const Translated = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    marginTop: "2px",
    paddingInlineStart: "var(--gap-sm)",
    borderInlineStart:
      "2px solid var(--md-sys-color-outline-variant, var(--md-sys-color-outline))",
    color: "var(--md-sys-color-on-surface-variant)",
    wordBreak: "break-word",
  },
});

const Caption = styled("span", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "0.75em",
    opacity: 0.7,
    userSelect: "none",
  },
});

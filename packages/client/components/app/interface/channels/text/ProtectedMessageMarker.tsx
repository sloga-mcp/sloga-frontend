import { createMemo } from "solid-js";

import { styled } from "styled-system/jsx";

import {
  markerCopy,
  messageCopy,
  shieldLabel,
} from "@revolt/client/protectedCopy";
import type { ProtectedMarkerKind } from "@revolt/client/protectedTextTypes";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Protected channel message marker (W4 plan D22 / 4.4, design 9.2 / 9.3,
 * lane C10).
 *
 * Renders IN PLACE of a message body for a `ProtectedMessageView` that is
 * not `ok`, so a marker is never mistaken for a normal message: it always
 * carries a glyph and italic copy, and red markers sit in an outlined,
 * alert-tinted box. Red markers are loud; gray markers (the message predates
 * this device, or used a key it never had) are expected and muted.
 *
 * Besides the marker kinds it takes:
 * - `pending`: the view is `{status: "pending"}` (in place of the body).
 * - `not_available`: a protected channel row on a device without the
 *   protected bridge (web, Electron, Android, iOS, unprovisioned Tauri), in
 *   place of the body; otherwise the row would sit on `pending` forever.
 * - `ts_skew` / `sender_not_verified`: informational notes for an `ok`
 *   view's `tsSkew` / `!senderVerified`, rendered UNDER the decrypted body.
 *
 * Only C0 copy is rendered: never plaintext, ids or server content. Imports
 * are file paths (never a barrel) and the only `styled` call uses a string
 * tag; styling over an imported component at module scope blanks the app
 * at boot.
 */

/** Informational notes for an `ok` view (design 9.2 `ts_skew`). */
export type ProtectedMessageNoteKind = "ts_skew" | "sender_not_verified";

/** Everything this component renders. */
export type ProtectedMessageMarkerKind =
  | ProtectedMarkerKind
  | "pending"
  | "not_available"
  | ProtectedMessageNoteKind;

/** red = loud alarm; gray / info = not an alarm; pending = decrypting. */
export type ProtectedMarkerTone = "red" | "gray" | "info" | "pending";

/**
 * Tone for each kind (design 9.2 marker column). An unknown kind at runtime
 * falls through to red: fail closed, loud.
 */
export function markerTone(
  kind: ProtectedMessageMarkerKind,
): ProtectedMarkerTone {
  switch (kind) {
    case "decrypt_failed":
    case "unverified_sender":
    case "removed_sender":
    case "replay":
    case "malformed":
    case "unencrypted_row":
    case "error":
      return "red";
    case "sent_before_join":
    case "unknown_key":
      return "gray";
    case "not_available":
      return "gray";
    case "ts_skew":
    case "sender_not_verified":
      return "info";
    case "pending":
      return "pending";
    default: {
      const _exhaustive: never = kind;
      return "red";
    }
  }
}

/** C0 copy for each kind; marker kinds go through `markerCopy`. */
function markerText(kind: ProtectedMessageMarkerKind): string {
  switch (kind) {
    case "pending":
      return messageCopy.pending();
    case "not_available":
      // C0's short state label; the full notice sentence would repeat on
      // every row of the history.
      return shieldLabel("not_available");
    case "ts_skew":
      return messageCopy.tsSkew();
    case "sender_not_verified":
      return messageCopy.senderNotVerified();
    default:
      // `markerCopy` is exhaustive and falls back to the catch-all copy.
      return markerCopy(kind);
  }
}

/** One Material symbol per tone (a missing tone fails tsc). */
const TONE_GLYPH: Record<ProtectedMarkerTone, string> = {
  red: "gpp_bad",
  gray: "key_off",
  info: "info",
  pending: "hourglass_top",
};

/** The tone's glyph; `not_available` shows the slashed shield instead. */
function markerGlyph(
  kind: ProtectedMessageMarkerKind,
  tone: ProtectedMarkerTone,
): string {
  return kind === "not_available" ? "remove_moderator" : TONE_GLYPH[tone];
}

interface Props {
  kind: ProtectedMessageMarkerKind;
}

export function ProtectedMessageMarker(props: Props) {
  const tone = createMemo(() => markerTone(props.kind));
  const text = createMemo(() => markerText(props.kind));

  return (
    <Marker
      tone={tone()}
      role="note"
      aria-label={text()}
      data-protected-marker={props.kind}
    >
      <Symbol size={tone() === "info" ? 14 : 16} data-marker-glyph>
        {markerGlyph(props.kind, tone())}
      </Symbol>
      <span>{text()}</span>
    </Marker>
  );
}

const Marker = styled("div", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    width: "fit-content",
    maxWidth: "100%",
    fontStyle: "italic",
    overflowWrap: "anywhere",
  },
  variants: {
    tone: {
      red: {
        marginBlock: "var(--gap-xs)",
        padding: "var(--gap-sm) var(--gap-md)",
        borderRadius: "var(--borderRadius-md)",
        border:
          "1px solid var(--sloga-protected-alert, var(--md-sys-color-error))",
        background:
          "color-mix(in srgb, var(--sloga-protected-alert, var(--md-sys-color-error)) 14%, transparent)",
        color: "var(--md-sys-color-on-surface)",
        fontWeight: 500,

        "& [data-marker-glyph]": {
          color: "var(--sloga-protected-alert, var(--md-sys-color-error))",
        },
      },
      gray: {
        color: "var(--md-sys-color-outline)",
      },
      info: {
        marginTop: "var(--gap-xs)",
        color: "var(--md-sys-color-outline)",
        fontSize: "0.75rem",
      },
      pending: {
        color: "var(--md-sys-color-outline)",
      },
    },
  },
});

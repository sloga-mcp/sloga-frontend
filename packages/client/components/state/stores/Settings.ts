import {
  type ForumLayout,
  cleanLayoutOverrides,
} from "@revolt/common/lib/forumLayout";
import {
  UNICODE_EMOJI_PACKS,
  UnicodeEmojiPacks,
} from "@revolt/markdown/emoji/UnicodeEmoji";
import { TRANSLATE_LANGUAGE_CODES } from "@revolt/common";
import { batch } from "solid-js";

import { State } from "..";

import { AbstractStore } from ".";

/**
 * Possible notification permission states
 */
export type NotificationPermissionState =
  | "default"
  | "denied"
  | "allowed"
  | "unsupported";

/**
 * Possible notification permission states
 */
const NotificationPermissionStates: NotificationPermissionState[] = [
  "default",
  "denied",
  "allowed",
  "unsupported",
];

/**
 * How wide the message column is allowed to grow
 */
export type ContentWidth = "full" | "wide" | "comfortable" | "narrow";

/**
 * Widths in pixels, keyed by preset. "full" has no cap.
 */
export const CONTENT_WIDTHS: Record<ContentWidth, number | null> = {
  full: null,
  wide: 1600,
  comfortable: 1200,
  narrow: 900,
};

/**
 * Possible message column widths
 */
const ContentWidths = Object.keys(CONTENT_WIDTHS) as ContentWidth[];

/**
 * Which side the message column sits on once it is narrower than the space
 * available to it
 */
export type ContentAlign = "start" | "center";

/**
 * Possible message column alignments
 */
const ContentAligns: ContentAlign[] = ["start", "center"];

/**
 * A physical side of the window. Physical on purpose — nothing in the app is
 * RTL-mirrored today, and a user's explicit "put it on the right" should
 * never be flipped under them by a locale change.
 */
export type LayoutSide = "left" | "right";

/**
 * Possible sides for the navigation block
 */
const LayoutSides: LayoutSide[] = ["left", "right"];

/**
 * Where the member list sits. "auto" is the pre-designer behaviour: shares
 * the channel column, unless the ultrawide layout moves it out.
 */
export type MembersSide = "auto" | LayoutSide;

/**
 * Possible member list placements
 */
const MembersSides: MembersSide[] = ["auto", "left", "right"];

interface SettingsDefinition {
  /**
   * Whether to enable desktop notifications
   */
  "notifications:desktop": NotificationPermissionState;

  /**
   * Whether to enable push notifications
   */
  "notifications:push": NotificationPermissionState;

  /**
   * Selected unicode emoji
   */
  "appearance:unicode_emoji": UnicodeEmojiPacks;

  // TODO: this should be part of theme
  // "appearance:ligatures": boolean;

  /**
   * Enable season effects
   * TODO: implement
   */
  // "appearance:seasonal": boolean;

  // TODO: this should be part of theme
  // "appearance:transparency": boolean;

  /**
   * Show message send button
   */
  "appearance:show_send_button": boolean;

  /**
   * Whether typing an emoticon like ":D" turns it into an emoji
   */
  "appearance:expand_emoticons": boolean;

  /**
   * Whether to render messages in compact mode
   */
  "appearance:compact_mode": boolean;

  /**
   * Whether to show the time a message was sent next to it
   */
  "appearance:show_timestamps": boolean;

  /**
   * Whether to show the sender name above a message group. Off leaves the
   * avatar (and its hover card) as the only identification.
   */
  "appearance:show_usernames": boolean;

  /**
   * How wide the message column may grow before it stops following the window
   *
   * Deliberately NOT gated on display aspect: a 2560x1440 16:9 window already
   * gives a ~2250px column, which is past a comfortable return sweep. Only the
   * rearrangement below is ultrawide-specific.
   */
  "appearance:content_width": ContentWidth;

  /**
   * Which side the message column sits on once it is capped
   */
  "appearance:content_align": ContentAlign;

  /**
   * Whether to rearrange the layout for very wide displays — currently, moving
   * the member list out of the channel column and into the space to the right
   * of the message column.
   *
   * Unlike the two above, this one only makes sense on an ultrawide, so the
   * control that sets it is disabled elsewhere.
   */
  "appearance:ultrawide_layout": boolean;

  /**
   * Which side of the window the navigation block (server rail + channel
   * list) sits on. The two move together: the floating user bar overlays the
   * pair and has no home if they split.
   *
   * Per-device on purpose (this store does not sync): a phone, a 16:9 laptop
   * and a 32:9 desktop want different arrangements. Ignored at phone widths,
   * where the slide drawer owns the layout.
   */
  "appearance:layout_nav_side": LayoutSide;

  /**
   * Which side of the window the member list sits on. Same side as the
   * navigation block = shares the channel column behind the divider (today's
   * behaviour); opposite side = its own full-height column. "auto" defers to
   * the ultrawide layout, exactly as before this key existed.
   */
  "appearance:layout_members_side": MembersSide;

  /**
   * Play animated name effects; off shows the still version
   */
  "appearance:name_effects": boolean;

  /**
   * Indicate new users to Stoat
   * TODO: implement
   */
  // "appearance:show_account_age": boolean;

  /**
   * Whether to include 'copy ID' in context menus
   */
  "advanced:copy_id": boolean;

  /**
   * Which message received sound variant to use (1–5)
   */
  "sounds:message_variant": number;

  /**
   * Which ringtone variant to use (1–10)
   */
  "sounds:ringtone_variant": number;

  /**
   * Which disconnect sound variant to use (1–5)
   */
  "sounds:disconnect_variant": number;

  /**
   * Whether to share detected game activity with others (desktop app)
   */
  "activity:share": boolean;

  /**
   * Whether to automatically translate other people's messages
   */
  "translation:enabled": boolean;

  /**
   * Target language for automatic message translation
   */
  "translation:target": string;

  /**
   * Whether to show translated live captions during voice/video calls
   */
  "captions:enabled": boolean;

  /**
   * Target language for call captions (Google Translate code)
   */
  "captions:target": string;

  /**
   * My spoken language for outgoing captions (BCP-47); empty = browser default
   */
  "captions:spoken": string;

  /**
   * Whether to also read translated call captions aloud (on-device TTS)
   */
  "captions:speak": boolean;

  /**
   * Spoken language for on-device call transcription (ISO-639-1); empty lets
   * the model detect it
   */
  "transcription:language": string;

  /**
   * Streamer Mode: master toggle
   */
  "streamer:enabled": boolean;

  /**
   * Streamer Mode: automatically activate while a streaming app
   * (OBS, Streamlabs, XSplit, ...) is running (desktop app only)
   */
  "streamer:auto_detect": boolean;

  /**
   * Streamer Mode: hide personal information (e.g. email address)
   */
  "streamer:hide_personal": boolean;

  /**
   * Streamer Mode: hide invite links and codes
   */
  "streamer:hide_invites": boolean;

  /**
   * Streamer Mode: suppress desktop notification popups
   */
  "streamer:disable_notifications": boolean;

  /**
   * Streamer Mode: mute notification and call sounds
   */
  "streamer:disable_sounds": boolean;

  /**
   * Streamer Mode: show the reminder banner above the app while active
   */
  "streamer:show_banner": boolean;

  /**
   * Entrance sound for every server: soundboard sound id triggered when you
   * join a server voice channel. "" = none.
   */
  "soundboard:entrance": string;

  /**
   * Per-server entrance-sound overrides (server id → sound id). A server
   * present with "" plays nothing there even when a global sound is set.
   */
  "soundboard:entrance_servers": Record<string, string>;

  /**
   * Per-forum layout overrides (forum channel id → the layout this reader
   * chose). A forum absent from the map follows the forum's moderator-set
   * default, then "Modern". Per-device on purpose (this store does not sync).
   */
  "forum:layout": Record<string, ForumLayout>;
}

/**
 * Map actual type to JavaScript type OR function to clean the value.
 */
type ValueType<T extends keyof SettingsDefinition> =
  SettingsDefinition[T] extends boolean
    ? "boolean"
    : SettingsDefinition[T] extends number
      ? "number"
      : SettingsDefinition[T] extends string
        ? "string"
        : (
            v: Partial<SettingsDefinition[T]>,
          ) => SettingsDefinition[T] | undefined;

/**
 * Expected types of settings keys, enforce some sort of validation is present for all keys.
 * If we cannot validate the value as a primitive, clean it up using a function.
 */
const EXPECTED_TYPES: { [K in keyof SettingsDefinition]: ValueType<K> } = {
  "notifications:desktop": "string",
  "notifications:push": "string",
  "appearance:unicode_emoji": "string",
  "appearance:show_send_button": "boolean",
  "appearance:expand_emoticons": "boolean",
  "appearance:compact_mode": "boolean",
  "appearance:show_timestamps": "boolean",
  "appearance:show_usernames": "boolean",
  "appearance:content_width": "string",
  "appearance:content_align": "string",
  "appearance:ultrawide_layout": "boolean",
  "appearance:layout_nav_side": "string",
  "appearance:layout_members_side": "string",
  "appearance:name_effects": "boolean",
  "advanced:copy_id": "boolean",
  "sounds:message_variant": "number",
  "sounds:ringtone_variant": "number",
  "sounds:disconnect_variant": "number",
  "activity:share": "boolean",
  "translation:enabled": "boolean",
  "translation:target": "string",
  "captions:enabled": "boolean",
  "captions:target": "string",
  "captions:spoken": "string",
  "captions:speak": "boolean",
  "transcription:language": "string",
  "streamer:enabled": "boolean",
  "streamer:auto_detect": "boolean",
  "streamer:hide_personal": "boolean",
  "streamer:hide_invites": "boolean",
  "streamer:disable_notifications": "boolean",
  "streamer:disable_sounds": "boolean",
  "streamer:show_banner": "boolean",
  "soundboard:entrance": "string",
  "soundboard:entrance_servers": (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [server, sound] of Object.entries(value)) {
      if (typeof sound === "string") out[server] = sound;
    }
    return out;
  },
  // Drops any entry whose value is not a known layout, so a corrupt or
  // future-version value falls back to the forum default instead of
  // rendering nothing.
  "forum:layout": (value) => cleanLayoutOverrides(value),
};

/**
 * In reality, this is a partial so we map it accordingly here.
 */
export type TypeSettings = Partial<SettingsDefinition>;

/**
 * Default values for settings, if applicable.
 */
const DEFAULT_VALUES: TypeSettings = {
  // Also in default() below: that one is the baseline clean() builds on, while
  // this one is what getValue() falls back to for a key a stored settings blob
  // has never heard of — which is every existing user, for a new key.
  "appearance:expand_emoticons": true,
  "appearance:show_timestamps": true,
  "appearance:show_usernames": true,
  // "full" so that shipping this reflows precisely nobody. The wider default a
  // 21:9 owner actually wants is written into this key by the ultrawide toggle
  // when they switch it on, not baked in here.
  "appearance:content_width": "full",
  "appearance:content_align": "start",
  "appearance:ultrawide_layout": false,
  // Today's arrangement, so shipping the designer reflows nobody.
  "appearance:layout_nav_side": "left",
  "appearance:layout_members_side": "auto",
  "appearance:name_effects": true,
  "sounds:message_variant": 4,
  "sounds:ringtone_variant": 8,
  "sounds:disconnect_variant": 3,
  "activity:share": true,
  "translation:enabled": false,
  "translation:target": "en",
  "captions:enabled": false,
  "captions:target": "en",
  "captions:spoken": "",
  "captions:speak": false,
  "transcription:language": "",
  "streamer:enabled": false,
  "streamer:auto_detect": true,
  "streamer:hide_personal": true,
  "streamer:hide_invites": true,
  "streamer:disable_notifications": true,
  "streamer:disable_sounds": true,
  "streamer:show_banner": true,
  "soundboard:entrance": "",
  "soundboard:entrance_servers": {},
  "forum:layout": {},
};

/**
 * Settings store
 */
export class Settings extends AbstractStore<"settings", TypeSettings> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "settings");
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    /** nothing needs to be done */
  }

  /**
   * Generate default values
   */
  default(): TypeSettings {
    return {
      "notifications:desktop": "default",
      "notifications:push": "default",
      "appearance:unicode_emoji": "fluent-3d",
      "appearance:show_send_button": true,
      // On: the expansion shipped before the toggle did, so off would be a
      // behaviour change. Mirrored in DEFAULT_VALUES — see the note there.
      "appearance:expand_emoticons": true,
      "appearance:compact_mode": false,
      // On: messages have always carried a timestamp in their header, so off
      // would be a behaviour change. Mirrored in DEFAULT_VALUES — see the note
      // there; a key in only one of the two reads undefined for every existing
      // user, whose stored blob predates it.
      "appearance:show_timestamps": true,
      "appearance:show_usernames": true,
      // Mirrored in DEFAULT_VALUES — see the note there.
      "appearance:content_width": "full",
      "appearance:content_align": "start",
      "appearance:ultrawide_layout": false,
      // Mirrored in DEFAULT_VALUES — see the note there.
      "appearance:layout_nav_side": "left",
      "appearance:layout_members_side": "auto",
      // Mirrored in DEFAULT_VALUES — see the note there.
      "appearance:name_effects": true,
      "advanced:copy_id": false,
      "sounds:message_variant": 4,
      "sounds:ringtone_variant": 8,
      "sounds:disconnect_variant": 3,
      "translation:enabled": false,
      "translation:target": "en",
      "captions:enabled": false,
      "captions:target": "en",
      "captions:spoken": "",
      "captions:speak": false,
      "transcription:language": "",
      "streamer:enabled": false,
      "streamer:auto_detect": true,
      "streamer:hide_personal": true,
      "streamer:hide_invites": true,
      "streamer:disable_notifications": true,
      "streamer:disable_sounds": true,
      "streamer:show_banner": true,
      "soundboard:entrance": "",
      "soundboard:entrance_servers": {},
      // Mirrored in DEFAULT_VALUES — see the note there.
      "forum:layout": {},
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeSettings>): TypeSettings {
    const settings: TypeSettings = this.default();

    for (const key of Object.keys(input) as (keyof TypeSettings)[]) {
      const expectedType = EXPECTED_TYPES[key];

      if (typeof expectedType === "function") {
        const cleanedValue = (expectedType as (value: unknown) => unknown)(
          input[key],
        );
        if (cleanedValue) {
          settings[key] = cleanedValue as never;
        }
      } else if (key === "appearance:unicode_emoji") {
        if (UNICODE_EMOJI_PACKS.includes(input[key] as never)) {
          settings[key] = input[key];
        }
      } else if (key === "notifications:desktop") {
        if (NotificationPermissionStates.includes(input[key] as never)) {
          settings[key] = input[key];
        }
      } else if (key === "notifications:push") {
        if (NotificationPermissionStates.includes(input[key] as never)) {
          settings[key] = input[key];
        }
      } else if (key === "appearance:content_width") {
        // "string" in EXPECTED_TYPES would let any string through and land an
        // unknown preset in the width lookup, so validate against the presets.
        if (ContentWidths.includes(input[key] as never)) {
          settings[key] = input[key];
        }
      } else if (key === "appearance:content_align") {
        if (ContentAligns.includes(input[key] as never)) {
          settings[key] = input[key];
        }
      } else if (key === "appearance:layout_nav_side") {
        // A corrupt side must fall back to the default, not render nothing.
        if (LayoutSides.includes(input[key] as never)) {
          settings[key] = input[key];
        }
      } else if (key === "appearance:layout_members_side") {
        if (MembersSides.includes(input[key] as never)) {
          settings[key] = input[key];
        }
      } else if (key === "translation:target" || key === "captions:target") {
        if (TRANSLATE_LANGUAGE_CODES.includes(input[key] as string)) {
          settings[key] = input[key];
        }
      } else if (typeof input[key] === expectedType) {
        settings[key] = input[key] as never;
      }
    }

    return settings;
  }

  /**
   * Set a settings key
   * @param key Colon-divided key
   * @param value Value
   */
  setValue<T extends keyof TypeSettings>(key: T, value: TypeSettings[T]) {
    this.set(key, value);
  }

  /**
   * Get a settings key
   * @param key Colon-divided key
   * @returns Value at key or default value
   */
  getValue<T extends keyof TypeSettings>(key: T) {
    return this.get()[key] ?? DEFAULT_VALUES[key];
  }

  /**
   * Get the permission state for desktop notifications
   */
  get desktopNotificationsState(): NotificationPermissionState {
    return this.getValue("notifications:desktop") ?? "default";
  }

  /**
   * Get the permission state for push notifications
   */
  get pushNotificationsState(): NotificationPermissionState {
    return this.getValue("notifications:push") ?? "default";
  }

  /**
   * Set the permission state for desktop notifications. If deskop notifications are ever set to `unsupported` this function will noop.
   */
  set desktopNotificationsState(newState: NotificationPermissionState) {
    if (this.desktopNotificationsState !== "unsupported") {
      this.setValue("notifications:desktop", newState);
    }
  }

  /**
   * Set the permission state for push notifications. If newState is `unsupported` this function will noop.
   */
  set pushNotificationsState(newState: NotificationPermissionState) {
    if (newState !== "unsupported") {
      this.setValue("notifications:push", newState);
    }
  }

  /**
   * Reset the notifications state for both desktop and push notifications.
   * @param newState The state to set both notification states to. Defaults to "default"
   */
  resetNotificationsState(newState?: "default" | "denied") {
    batch(() => {
      // Use setValue here instead of the setter as we want to bypass the unsupported block.
      this.setValue("notifications:desktop", newState ?? "default");
      this.pushNotificationsState = newState ?? "default";
    });
  }
}

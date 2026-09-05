import { Accessor, createSignal } from "solid-js";

import {
  FONT_KEYS,
  Fonts,
  MONOSPACE_FONT_KEYS,
  MonospaceFonts,
} from "@revolt/ui/themes/fonts";
import { BRAND_ACCENT, BRAND_VARIANT } from "@revolt/ui/themes/materialTheme";
import {
  RAIL_ACCENT_DEFAULT,
  RAIL_ACCENT_PATTERN,
} from "@revolt/ui/themes/railAccent";

import { State } from "..";

import { AbstractStore } from ".";

export type TypeTheme = {
  /**
   * Base theme preset
   *
   * "stoat" is Sloga's hand-tuned palette; "you" generates the whole scheme
   * from the accent/contrast/variant controls. The appearance menu only shows
   * those controls under "you", because under "stoat" they have nothing to do.
   */
  preset: "stoat" | "you";

  /**
   * Whether `preset` has been through the one-time migration below
   *
   * Not a user-facing setting; see `clean()`.
   */
  presetMigrated: boolean;

  /**
   * Light/dark mode
   */
  mode: "light" | "dark" | "system";

  /**
   * Accent
   * (Material You)
   */
  m3Accent: string;

  /**
   * Constrast
   * (Material You)
   */
  m3Contrast: number;

  /**
   * Variant
   * (Material You)
   */
  m3Variant:
    | "monochrome"
    | "neutral"
    | "tonal_spot"
    | "vibrant"
    | "expressive"
    | "fidelity"
    | "content"
    | "rainbow"
    | "fruit_salad";

  /**
   * Whether to permit blurry surfaces
   */
  blur: boolean;

  /**
   * Colour of called-out sidebar rows: unread channels, online members, the
   * joined voice channel. Independent of the preset, so it survives a switch
   * between Sloga and Material You.
   */
  railAccent: string;

  /**
   * Interface font
   */
  interfaceFont: Fonts;

  /**
   * Monospace font
   */
  monospaceFont: MonospaceFonts;

  /**
   * Message size
   */
  messageSize: number;

  /**
   * Spacing between message groups
   */
  messageGroupSpacing: number;

  /**
   * Avatar size in the message list (px)
   */
  messageAvatarSize: number;
};

export type SelectedTheme = Pick<
  TypeTheme,
  | "blur"
  | "interfaceFont"
  | "monospaceFont"
  | "messageSize"
  | "messageGroupSpacing"
  | "messageAvatarSize"
> & {
  preset: "stoat" | "you";
  darkMode: boolean;

  accent: string;
  contrast: number;
  variant: TypeTheme["m3Variant"];
};

/**
 * Manages theme information
 */
export class Theme extends AbstractStore<"theme", TypeTheme> {
  prefersDark: Accessor<boolean>;

  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "theme");

    // handle prefers-color-scheme value and changes
    const [prefersDark, setPrefersDark] = createSignal(
      window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches,
    );

    this.prefersDark = prefersDark;

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (event) => setPrefersDark(event.matches));

    this.toggleBlur = this.toggleBlur.bind(this);
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
  default(): TypeTheme {
    return {
      preset: "stoat",
      // Fresh profiles start where the migration would put them.
      presetMigrated: true,
      mode: "dark",

      m3Accent: BRAND_ACCENT,
      m3Contrast: 0.0,
      m3Variant: BRAND_VARIANT,

      interfaceFont: "Inter",
      monospaceFont: "Fira Code",

      blur: true,
      railAccent: RAIL_ACCENT_DEFAULT,
      messageSize: 14,
      messageGroupSpacing: 12,
      messageAvatarSize: 36,
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeTheme>): TypeTheme {
    const data: TypeTheme = this.default();

    if (["light", "dark", "system"].includes(input.mode!)) {
      data.mode = input.mode!;
    }

    // "you" was the old default and the toggle that selects it was commented
    // out of the appearance menu, so nobody could have picked it on purpose —
    // every stored "you" is an inherited default. Left alone it would flip the
    // whole installed base off the brand palette onto a generated one, so it
    // is migrated across once. The flag is what makes it once: after this runs
    // a genuine "Material You" choice survives the next load.
    //
    // "neutral" used to be accepted here too, but `activeTheme` only ever had
    // a `case "you"`, so a stored "neutral" fell out of the switch as
    // undefined and every theme variable was read off it — a white screen on
    // boot that nothing short of clearing storage could recover. Only presets
    // `activeTheme` can actually build are allowed through.
    if (input.presetMigrated) {
      if (["stoat", "you"].includes(input.preset!)) {
        data.preset = input.preset!;
      }
    } else {
      data.preset = "stoat";
    }
    data.presetMigrated = true;

    if (typeof input.m3Contrast === "number") {
      data.m3Contrast = input.m3Contrast;
    }

    if (
      input.m3Accent &&
      input.m3Accent.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})/)
    ) {
      data.m3Accent = input.m3Accent;
    }

    if (
      [
        "monochrome",
        "neutral",
        "tonal_spot",
        "vibrant",
        "expressive",
        "fidelity",
        "content",
        "rainbow",
        "fruit_salad",
      ].includes(input.m3Variant!)
    ) {
      data.m3Variant = input.m3Variant!;
    }

    if (typeof input.blur === "boolean") {
      data.blur = input.blur;
    }

    if (
      typeof input.railAccent === "string" &&
      RAIL_ACCENT_PATTERN.test(input.railAccent)
    ) {
      data.railAccent = input.railAccent;
    }

    if (typeof input.messageSize === "number") {
      data.messageSize = input.messageSize;
    }

    if (typeof input.messageGroupSpacing === "number") {
      data.messageGroupSpacing = input.messageGroupSpacing;
    }

    if (typeof input.messageAvatarSize === "number") {
      data.messageAvatarSize = input.messageAvatarSize;
    }

    if (
      typeof input.monospaceFont === "string" &&
      MONOSPACE_FONT_KEYS.includes(input.monospaceFont)
    ) {
      data.monospaceFont = input.monospaceFont;
    }

    if (
      typeof input.interfaceFont === "string" &&
      FONT_KEYS.includes(input.interfaceFont)
    ) {
      data.interfaceFont = input.interfaceFont;
    }

    return data;
  }

  /**
   * Get the currently selected theme (considering system settings)
   */
  get activeTheme(): SelectedTheme {
    const opts = this.get();

    const common = {
      blur: opts.blur,
      interfaceFont: opts.interfaceFont,
      monospaceFont: opts.monospaceFont,
      messageSize: opts.messageSize,
      messageGroupSpacing: opts.messageGroupSpacing,
      messageAvatarSize: opts.messageAvatarSize,
      darkMode:
        opts.mode === "dark" || (opts.mode === "system" && this.prefersDark()),
    };

    // Deliberately a branch and not a switch: this getter feeds every colour
    // variable in the app, and the switch it replaces had no default, so a
    // preset it did not recognise returned undefined and took the whole UI
    // down rather than falling back.
    //
    // Sloga seeds its base scheme from fixed brand values rather than the
    // user's — the accent/contrast/variant controls are hidden under this
    // preset precisely because they do not apply. The roles the brand palette
    // leaves alone (error, outline, inverse) are still derived from these.
    return opts.preset === "stoat"
      ? {
          ...common,
          preset: "stoat",
          accent: BRAND_ACCENT,
          contrast: 0,
          variant: BRAND_VARIANT,
        }
      : {
          ...common,
          preset: "you",
          accent: opts.m3Accent,
          contrast: opts.m3Contrast,
          variant: opts.m3Variant,
        };
  }

  /**
   * Get light/dark/system mode
   */
  get mode() {
    return this.get().mode;
  }

  /**
   * Set light/dark/system mode
   * @param mode Mode
   */
  setMode(mode: TypeTheme["mode"]) {
    this.set("mode", mode);
  }

  /**
   * Get current preset
   */
  get preset() {
    return this.get().preset;
  }

  /**
   * Set the active preset
   * @param preset Preset
   */
  setPreset(preset: TypeTheme["preset"]) {
    this.set("preset", preset);
  }

  /**
   * Get current accent
   */
  get m3Accent() {
    return this.get().m3Accent;
  }

  /**
   * Set the accent of the Material You theme
   * @param accent Accent
   */
  setM3Accent(accent: string) {
    this.set("m3Accent", accent);
  }

  /**
   * Get current contrast
   */
  get m3Contrast() {
    return this.get().m3Contrast;
  }

  /**
   * Set the contrast of the Material You theme
   * @param contrast Contrast
   */
  setM3Contrast(contrast: number) {
    this.set("m3Contrast", contrast);
  }

  /**
   * Get current variant
   */
  get m3Variant() {
    return this.get().m3Variant;
  }

  /**
   * Set the variant of the Material You theme
   * @param variant Variant
   */
  setM3Variant(variant: TypeTheme["m3Variant"]) {
    this.set("m3Variant", variant);
  }

  /**
   * Get current blur state
   */
  get blur() {
    return this.get().blur;
  }

  /**
   * Toggle blur state
   */
  toggleBlur() {
    this.set("blur", !this.blur);
  }

  /**
   * Get the sidebar highlight colour
   */
  get railAccent() {
    return this.get().railAccent;
  }

  /**
   * Set the sidebar highlight colour
   * @param colour Hex colour
   */
  setRailAccent(colour: string) {
    this.set("railAccent", colour);
  }

  /**
   * Get current interface font
   */
  get interfaceFont() {
    return this.get().interfaceFont;
  }

  /**
   * Set interface font
   */
  setInterfaceFont(font: Fonts) {
    return this.set("interfaceFont", font);
  }

  /**
   * Get current monospace font
   */
  get monospaceFont() {
    return this.get().monospaceFont;
  }

  /**
   * Set monospace font
   */
  setMonospaceFont(font: MonospaceFonts) {
    return this.set("monospaceFont", font);
  }

  /**
   * Get current message size
   */
  get messageSize() {
    return this.get().messageSize;
  }

  /**
   * Set message size
   */
  set messageSize(size: number) {
    this.set("messageSize", size);
  }

  /**
   * Get current message group spacing
   */
  get messageGroupSpacing() {
    return this.get().messageGroupSpacing;
  }

  /**
   * Set message group spacing
   */
  set messageGroupSpacing(space: number) {
    this.set("messageGroupSpacing", space);
  }

  /**
   * Get current message-list avatar size
   */
  get messageAvatarSize() {
    return this.get().messageAvatarSize;
  }

  /**
   * Set message-list avatar size
   */
  set messageAvatarSize(size: number) {
    this.set("messageAvatarSize", size);
  }
}

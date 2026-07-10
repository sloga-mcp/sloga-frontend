import { paramsFromPathname } from "@revolt/routing";

import { State } from "..";

import { AbstractStore } from ".";

/**
 * Static section IDs
 */
export enum LAYOUT_SECTIONS {
  PRIMARY_SIDEBAR = "PRIMARY_SIDEBAR",
  MEMBER_SIDEBAR = "MEMBER_SIDEBAR",
  MENTION_REPLY = "MENTION_REPLY",
  MATURE = "nsfw",
  SERVER_RAIL_EXPANDED = "SERVER_RAIL_EXPANDED",
}

export interface TypeLayout {
  /**
   * URL to redirect to after login
   */
  nextPath?: string;

  /**
   * The current section of the program we are in
   *
   * This can currently either be:
   * - home
   * - discover
   * - a server ID
   */
  activeInterface: "home" | "discover" | string;

  /**
   * Current path within an interface
   */
  activePath: Record<TypeLayout["activeInterface"], string>;

  /**
   * Open (or closed) sections of the UI
   *
   * Only the contrary is ever stored
   */
  openSections: Record<string, boolean>;

  /**
   * Height (in vh) of the docked voice/video call card.
   *
   * Adjustable by dragging the divider between the call card and the
   * messages/composition below it. Clamped to [CALL_CARD_MIN, CALL_CARD_MAX].
   */
  callCardHeight?: number;
}

/**
 * Bounds (in vh) for the resizable docked call card
 */
export const CALL_CARD_MIN = 20;
export const CALL_CARD_MAX = 80;
export const CALL_CARD_DEFAULT = 40;

/**
 * Handles layout and navigation of the app.
 */
export class Layout extends AbstractStore<"layout", TypeLayout> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "layout");
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
  default(): TypeLayout {
    return {
      activeInterface: "home",
      activePath: {
        home: "/",
        discover: "/discover/servers",
      },
      openSections: {},
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeLayout>): TypeLayout {
    const layout: TypeLayout = this.default();

    if (typeof input.nextPath === "string") {
      layout.nextPath = input.nextPath;
    }

    if (typeof input.activeInterface === "string") {
      layout.activeInterface = input.activeInterface;
    }

    if (typeof input.activePath === "object") {
      for (const interfaceId of Object.keys(input.activePath)) {
        if (typeof input.activePath[interfaceId] === "string") {
          layout.activePath[interfaceId] = input.activePath[interfaceId];
        }
      }
    }

    if (typeof input.openSections === "object") {
      for (const section of Object.keys(input.openSections)) {
        if (typeof input.openSections[section] === "boolean") {
          layout.openSections[section] = input.openSections[section];
        }
      }
    }

    if (typeof input.callCardHeight === "number") {
      layout.callCardHeight = Math.min(
        CALL_CARD_MAX,
        Math.max(CALL_CARD_MIN, input.callCardHeight),
      );
    }

    return layout;
  }

  /**
   * Get the height (in vh) of the docked call card
   */
  getCallCardHeight() {
    return this.get().callCardHeight ?? CALL_CARD_DEFAULT;
  }

  /**
   * Set the height (in vh) of the docked call card, clamped to the allowed range
   * @param vh New height in viewport-height units
   */
  setCallCardHeight(vh: number) {
    this.set(
      "callCardHeight",
      Math.min(CALL_CARD_MAX, Math.max(CALL_CARD_MIN, vh)),
    );
  }

  /**
   * Pop the next redirect path
   */
  popNextPath() {
    const nextUrl = this.get().nextPath;
    this.set("nextPath", undefined);
    return nextUrl;
  }

  /**
   * Get the last active path in the app
   */
  getLastActivePath() {
    const section = this.get().activeInterface;
    return this.get().activePath[section] ?? "/";
  }

  /**
   * Get the last active discover path in the app
   */
  getLastActiveDiscoverPath() {
    return this.get().activePath["discover"];
  }

  /**
   * Get the last active server path
   */
  getLastActiveServerPath(serverId: string) {
    return this.get().activePath[serverId] ?? `/server/${serverId}`;
  }

  /**
   * Set the next redirect path
   */
  setNextPath(pathname: string) {
    this.set("nextPath", pathname);
  }

  /**
   * Set the last active path in the app
   */
  setLastActivePath(pathname: string) {
    if (pathname.startsWith("/settings") || pathname.startsWith("/invite"))
      return;

    const params = paramsFromPathname(pathname);
    const section = pathname.startsWith("/discover")
      ? "discover"
      : (params.serverId ?? "home");
    this.set("activeInterface", section);
    this.set("activePath", section, pathname);
  }

  /**
   * Get state of a section
   * @param id Section ID
   * @param defaultValue Default state value
   * @returns Whether the section is open
   */
  getSectionState(id: string, defaultValue = false) {
    return this.get().openSections[id] ?? defaultValue;
  }

  /**
   * Set the state of a section
   * @param id Section ID
   * @param value New state value
   * @param defaultValue Default state value
   */
  setSectionState(id: string, value: boolean, defaultValue = false) {
    this.set("openSections", id, value === defaultValue ? undefined! : value);
  }

  /**
   * Toggle state of a section
   * @param id Section ID
   * @param defaultValue Default state value
   */
  toggleSectionState(id: string, defaultValue?: boolean) {
    this.setSectionState(
      id,
      !this.getSectionState(id, defaultValue),
      defaultValue,
    );
  }
}

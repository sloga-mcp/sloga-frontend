import type { SolidOptions } from "solid-dnd-directive";
import { Setter } from "solid-js";

import type { Placement } from "@floating-ui/dom";
import type { Channel, Client, ServerMember, ServerRole, User } from "stoat.js";

declare global {
  interface Window {
    __TAURI__: object;
    /** Electron desktop shell marker (EL0); `e2ee` present only when the
     * native bridge is live (EL1.2 preload gate). */
    slogaShell?: {
      name: string;
      platform: string;
      e2ee?: {
        invoke(command: string, args?: unknown): Promise<unknown>;
        on(name: string, callback: (payload: unknown) => void): () => void;
      };
      /** Linux screen-share audio (main window only; absent on popout/
       * overlay windows and on shells without the native module). */
      screenAudio?: {
        probe(refresh?: boolean): Promise<{
          available: boolean;
          pipewireVersion?: string;
          reason?: string;
        }>;
        start(): Promise<{ deviceDescription: string; sessionId: number }>;
        stop(sessionId?: number): Promise<boolean>;
        /** Main's notice that a native session died under a live share;
         * absent on older preloads. Returns the unsubscribe. */
        onEnded?(
          callback: (event: { sessionId: number; reason?: string }) => void,
        ): () => void;
        listApps(): Promise<
          {
            id: number;
            appName?: string;
            nodeName?: string;
            pid?: number;
            binary?: string;
            /** Grouping key: streams sharing it are one application. */
            identity: string;
          }[]
        >;
        /** What the CURRENT share's audio should cover (slice 2). Never
         * rejects and never answers "system" for a window it could not
         * attribute — an unattributable window is always `ask`. `include`
         * holds stable application identities, not node ids. */
        resolveTarget?(): Promise<{
          mode: "system" | "targets" | "ask";
          include?: string[];
          appLabel?: string;
          reason?: string;
        }>;
        /** Restrict a live session to a chosen set of applications, by the
         * `identity` keys `listApps` returns. Rejects on a stale session
         * id, an unrecognized mode, or a session that did not apply the
         * set; otherwise resolves the number of applications actually
         * linked — ZERO is a valid resolution meaning the capture would be
         * silent, and callers must treat it as a failure rather than
         * publish an untargeted source. */
        setTargets?(options: {
          sessionId: number;
          mode: "system" | "targets";
          include: string[];
        }): Promise<number>;
      };
      /** Friends popout window only (absent on the main and overlay
       * windows). `getState`/`setAlwaysOnTop` back the always-on-top pin
       * (Friends.tsx `electronPopout()`); `openInMain` hands a DM/call
       * action to the main window and is missing on preloads that predate
       * the popout bridge. */
      popout?: {
        getState(): { alwaysOnTop: boolean } | null;
        setAlwaysOnTop(value: boolean): Promise<unknown>;
        openInMain(
          action: "dm" | "call" | "video" | "screenshare",
          userId: string,
        ): Promise<void>;
      };
      /** Main window only: shell-to-main messages (popout actions,
       * notification clicks). Payloads are untrusted until validated.
       * Returns the unsubscribe. */
      onShellToMain?(callback: (message: unknown) => void): () => void;
    };
  }
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      dndzone: SolidOptions;

      scrollable:
        | true
        | {
            /**
             * Colour customisation
             */
            palette?: "default" | "settings";

            /**
             * Scroll direction
             */
            direction?: "x" | "y";

            /**
             * Offset to apply to top of scroll container
             */
            offsetTop?: number;

            /**
             * Whether to only show scrollbar on hover
             */
            showOnHover?: boolean;

            /**
             * Pass-through class names
             */
            class?: string;
          };
      invisibleScrollable:
        | true
        | {
            /**
             * Scroll direction
             */
            direction?: "x" | "y";

            /**
             * Pass-through class names
             */
            class?: string;
          };
      floating: {
        tooltip?: {
          /**
           * Where the tooltip should be placed
           */
          placement: Placement;
        } & (
          | {
              /**
               * Tooltip content
               */
              content: Component;

              /**
               * Aria label fallback
               */
              aria: string;
            }
          | {
              /**
               * Tooltip content
               */
              content: string | undefined;

              /**
               * Content is used as aria fallback
               */
              aria?: undefined;
            }
        );
        userCard?: {
          /**
           * User to display
           */
          user: User;

          /**
           * Member to display
           */
          member?: ServerMember;
        };
        contextMenu?: Component;
        contextMenuHandler?: "click" | "contextmenu";
        autoComplete?: {
          state: Accessor<AutoCompleteState>;
          selection: Accessor<number>;
          setSelection: Setter<number>;
          select: (index: number) => void;
        };
      };
      autoComplete:
        | true
        | {
            client?: Client;
            onKeyDown?: (
              event: KeyboardEvent & { currentTarget: HTMLTextAreaElement },
            ) => void;
            searchSpace?: {
              users?: User[];
              members?: ServerMember[];
              channels?: Channel[];
              roles?: ServerRole[];
            };
          };
    }
  }
}

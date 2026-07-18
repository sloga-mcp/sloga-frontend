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

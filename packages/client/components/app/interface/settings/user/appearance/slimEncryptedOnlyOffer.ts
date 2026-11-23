/**
 * When the Slim view choice offers Encrypted-only chats. Pure, so
 * `node --test` loads it (`slimEncryptedOnlyOffer.test.ts`).
 */
import {
  type OnlyAdvert,
  onlyCardState,
} from "../../../../../modal/modals/encryptedOnlySetup.ts";

/** The facts the offer needs. */
export type SlimOfferInput = {
  /** In an app: this window has an encryption adapter */
  app: boolean;
  /** The server's advert; `null` or `undefined` (not known yet) hides it */
  advert: OnlyAdvert | null | undefined;
  /** This account's user object is loaded */
  userKnown: boolean;
  /** This device's latch for the account */
  latched: boolean;
  /** The server's flag for the account */
  serverOn: boolean;
  /** The setup is open */
  settingUp: boolean;
};

/**
 * Whether to show the offer: in an app, while the server advertises the
 * setting as available and the settings card would offer to turn it on.
 * @param input The facts
 * @returns Whether to show it
 */
export function slimOffersEncryptedOnly(input: SlimOfferInput): boolean {
  return (
    input.app &&
    input.advert?.available === true &&
    onlyCardState(input) === "off"
  );
}

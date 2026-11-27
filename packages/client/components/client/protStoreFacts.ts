import { createSignal } from "solid-js";

/**
 * The server facts the in-app purchase gate reads (S6). This is the one
 * place they live: ProtStoreWorker sets them after login in store builds
 * (the root advert, the `/@me` preview flag and the ProtStore plugin's
 * `isAvailable()`), and `allowsProtSpending()` in distribution.ts reads them.
 * Kept out of distribution.ts so the pure gate functions there take the facts
 * as parameters and stay testable without a bridge.
 */

/** `features.prot.store` from the root advert, the two open flags only */
export type ProtStoreAdvert = { apple_open: boolean; play_open: boolean };

export type ProtStoreFacts = {
  /** null until the advert is read, or when the server sends none (fail closed) */
  store: ProtStoreAdvert | null;
  /** `/@me` `store_preview`: this account may buy before the store opens */
  storePreview: boolean;
  /** The native ProtStore plugin exists and can take payments */
  pluginAvailable: boolean;
};

/** Before anything is known: a store build cannot buy, so it cannot spend */
export const NO_PROT_STORE_FACTS: ProtStoreFacts = Object.freeze({
  store: null,
  storePreview: false,
  pluginAvailable: false,
});

export const [protStoreFacts, setProtStoreFacts] =
  createSignal<ProtStoreFacts>(NO_PROT_STORE_FACTS);

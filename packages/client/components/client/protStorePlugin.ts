/**
 * The native `ProtStore` plugin (S6): Prot packs bought through the App Store
 * (StoreKit 2) or Google Play Billing.
 *
 * The plugin is registered natively only in store builds: the Play flavor
 * (`android/app/src/play/java/com/acutest/app/ProtStorePlugin.java`) and the
 * iOS app (`ios/App/SlogaStore`). Everywhere else (web, desktop shells, the
 * sideload and foss APKs, and store shells older than S6) `ProtStoreNative`
 * is undefined, and `protStoreAvailable()` resolves false without throwing.
 *
 * The plugin never decides whether a purchase counts. It hands the store's
 * proof (`signed_transaction` / `purchase_token`) to the caller, the server
 * verifies it, and the client finishes a transaction only after the server
 * answered (`shouldFinish` in `protStoreFlow.ts`). Play purchases are never
 * finished by the client: the server consumes them.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import { Capacitor, registerPlugin } from "@capacitor/core";

export type ProtStoreProduct = { id: string; displayPrice: string };

export type ProtStorePurchased =
  | {
      store: "apple";
      transaction_id: string;
      product_id: string;
      signed_transaction: string;
    }
  | {
      store: "play";
      product_id: string;
      purchase_token: string;
      order_id?: string;
    };

export type ProtStoreFailCode =
  | "not_available"
  | "product_not_found"
  | "already_owned"
  | "invalid_token"
  | "store_error";

export type ProtStorePurchaseResult =
  | { result: "purchased"; purchase: ProtStorePurchased }
  | { result: "pending" }
  | { result: "cancelled" }
  | { result: "failed"; code: ProtStoreFailCode; message?: string };

export interface ProtStorePlugin {
  isAvailable(): Promise<{ available: boolean }>;
  products(options: {
    ids: string[];
  }): Promise<{ products: ProtStoreProduct[] }>;
  purchase(options: {
    product_id: string;
    account_token: string;
  }): Promise<ProtStorePurchaseResult>;
  /** iOS: Transaction.unfinished; Play: queryPurchasesAsync(INAPP) PURCHASED, not yet consumed */
  pendingTransactions(): Promise<{ purchases: ProtStorePurchased[] }>;
  /** iOS: transaction.finish(); Play: resolves { finished: false } (the server consumes) */
  finish(options: { transaction_id: string }): Promise<{ finished: boolean }>;
  /** Raw storefront: iOS alpha-3, Android alpha-2 */
  storefront(): Promise<{ storefront?: string }>;
  addListener(
    event: "transactionUpdated",
    cb: (purchase: ProtStorePurchased) => void,
  ): Promise<PluginListenerHandle>;
}

/** Undefined on web/desktop/sideload/foss and when the plugin is absent (older shells) */
export const ProtStoreNative: ProtStorePlugin | undefined =
  Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("ProtStore")
    ? registerPlugin<ProtStorePlugin>("ProtStore")
    : undefined;

/**
 * Whether this build can take an in-app payment right now: the plugin exists
 * and the store says it can (`AppStore.canMakePayments` / a ready billing
 * client). False, never a throw, when the plugin is absent or the call fails.
 */
export async function protStoreAvailable(): Promise<boolean> {
  if (!ProtStoreNative) return false;
  try {
    const answer = await ProtStoreNative.isAvailable();
    return answer?.available === true;
  } catch {
    return false;
  }
}

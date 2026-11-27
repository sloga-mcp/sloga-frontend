import { createEffect, createSignal, onCleanup } from "solid-js";

import type { PluginListenerHandle } from "@capacitor/core";
import type { Client } from "stoat.js";

import { parseProtFeature } from "@revolt/app/interface/settings/user/protWallet";
import CONFIGURATION from "@revolt/common/lib/env";
import { type ModalController, useModals } from "@revolt/modal";

import { useClient, useClientLifecycle } from ".";
import { distributionChannel, isStoreBuild } from "./distribution";
import {
  type ProtStoreAdvert,
  NO_PROT_STORE_FACTS,
  setProtStoreFacts,
} from "./protStoreFacts";
import {
  type ProtStoreFlowEvent,
  type ProtStoreFlowState,
  parseNoticed,
  protStoreStep,
  readPurchase,
  readVerifyAnswer,
  recoveryShouldVerify,
  rememberNoticed,
  shouldFinish,
  transactionKey,
  underReviewNotice,
  verifyBackoffMs,
  verifyRequestBody,
} from "./protStoreFlow";
import {
  type ProtStorePlugin,
  type ProtStorePurchased,
  ProtStoreNative,
  protStoreAvailable,
} from "./protStorePlugin";

/** One sign-in's run of the worker; `disposed` once it is cleaned up */
type Run = {
  client: Client;
  plugin: ProtStorePlugin;
  disposed: boolean;
  /** Keys this run claimed (R29: released when the session ends) */
  claims: Set<string>;
  /** Opens the under-review notice (R66) */
  modals: Pick<ModalController, "openModal" | "isOpen">;
  /** Set once this run opened the under-review notice (R66) */
  noticeOpened: boolean;
};

/**
 * `transactionKey` of every store transaction claimed for a verify in this
 * app launch under the current session (R29). A claim is released when the
 * session that took it ends, so signing in to the buying account in the
 * same launch verifies the transaction again.
 */
const verifiedThisLaunch = new Set<string>();

/** Which worker run holds a claim; absent for the purchase sheet's claims */
const claimOwners = new Map<string, Run>();

/** The worker's flow state per transaction key (R30) */
const [outcomes, setOutcomes] = createSignal<
  ReadonlyMap<string, ProtStoreFlowState>
>(new Map());

/**
 * Claim a store transaction for its one verify under this session. True
 * only the first time; the key is taken BEFORE the verify starts, so a
 * `transactionUpdated` replay or the purchase sheet racing the recovery
 * drain never sends a second one.
 */
export function claimProtStoreVerify(purchase: ProtStorePurchased): boolean {
  const key = transactionKey(purchase);
  if (!recoveryShouldVerify(key, verifiedThisLaunch)) return false;
  verifiedThisLaunch.add(key);
  return true;
}

/**
 * Release a claim (R29): the session it was taken under ended, so the
 * next session may verify the transaction again. Its outcome is dropped
 * with it; it belonged to the old session.
 */
export function releaseProtStoreVerify(purchase: ProtStorePurchased): void {
  releaseKey(transactionKey(purchase));
}

/**
 * Where the worker is with a transaction it holds the claim for (R30):
 * `verifying` while it asks the server, then `done` or `kept`. Reactive.
 * Undefined when the worker never took it (or the claim was released).
 */
export function protStoreOutcome(key: string): ProtStoreFlowState | undefined {
  return outcomes().get(key);
}

function releaseKey(key: string) {
  verifiedThisLaunch.delete(key);
  claimOwners.delete(key);
  if (!outcomes().has(key)) return;
  setOutcomes((prev) => {
    const next = new Map(prev);
    next.delete(key);
    return next;
  });
}

/** Release every claim `run` still holds: its session ended (R29) */
function releaseRunClaims(run: Run) {
  for (const key of run.claims) {
    if (claimOwners.get(key) === run) releaseKey(key);
  }
  run.claims.clear();
}

/** Record the worker's state for a transaction, while its run is live */
function noteOutcome(run: Run, key: string, state: ProtStoreFlowState) {
  if (run.disposed || claimOwners.get(key) !== run) return;
  setOutcomes((prev) => new Map(prev).set(key, state));
}

/** Transactions the under-review notice was shown for, as JSON (R66) */
const REVIEW_NOTICED_KEY = "sloga.prot_store.review_noticed";

/** The noticed keys when storage is missing or throws: once per launch */
let noticedInMemory: string[] = [];

/** Noticed keys, oldest first: the stored list and this launch's own */
function readNoticed(): string[] {
  let stored: string[] = [];
  try {
    stored = parseNoticed(localStorage.getItem(REVIEW_NOTICED_KEY));
  } catch {
    // No storage: this launch's own list only
  }
  return [...new Set([...stored, ...noticedInMemory])];
}

/** Store the noticed keys, in memory too in case storage refuses them */
function writeNoticed(keys: string[]) {
  noticedInMemory = keys;
  try {
    localStorage.setItem(REVIEW_NOTICED_KEY, JSON.stringify(keys));
  } catch {
    // Kept in memory: shown once per launch instead of once per device
  }
}

/**
 * Open the under-review notice for a purchase this run's recovery kept
 * under review (R66): only while the run is live and holds the claim, and
 * once per transaction per device. Several held purchases in one drain
 * share the notice already on screen; one that settles after this run's
 * notice was closed waits for the next launch. Nothing here finishes or
 * consumes the purchase.
 */
function noticeUnderReview(run: Run, key: string, state: ProtStoreFlowState) {
  if (run.disposed || claimOwners.get(key) !== run) return;
  const shown = readNoticed();
  if (!underReviewNotice(state, shown)) return;
  const open = run.modals.isOpen("prot_store_under_review");
  if (!open && run.noticeOpened) return;
  writeNoticed(rememberNoticed(shown, key));
  if (open) return;
  run.noticeOpened = true;
  run.modals.openModal({ type: "prot_store_under_review" });
}

/** The two outcomes of one verify request */
type VerifyEvent = Extract<
  ProtStoreFlowEvent,
  { type: "verified" | "verifyFailed" }
>;

/**
 * Session and JSON headers (as on the Prot settings page): the store routes
 * are newer than the generated stoat-api schema, and the typed client drops
 * request bodies for routes it doesn't know.
 */
function jsonHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token, "Content-Type": "application/json" };
}

/** The part of the root config read here; any of it may be absent */
type ConfigShape = { features?: { prot?: unknown } | null } | null | undefined;

/**
 * The two open flags of `features.prot.store`, read strictly (R32): the
 * advert only when it is well formed (both flags boolean, a product list),
 * otherwise none, so the store gate stays closed (R26).
 */
function readStoreAdvert(configuration: unknown): ProtStoreAdvert | null {
  const prot = (configuration as ConfigShape)?.features?.prot;
  const store = parseProtFeature(prot).store ?? null;
  if (!store) return null;
  return { apple_open: store.apple_open, play_open: store.play_open };
}

/** `GET /payments/prot/@me` `store_preview`; false on any failure */
async function fetchStorePreview(client: Client): Promise<boolean> {
  try {
    const response = await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/payments/prot/@me`,
      { headers: jsonHeaders(client) },
    );
    if (!response.ok) return false;
    const me = (await response.json().catch(() => undefined)) as
      | { store_preview?: unknown }
      | undefined;
    return me?.store_preview === true;
  } catch {
    return false;
  }
}

/**
 * `POST /payments/prot/store/verify` by raw fetch (no table for it in the
 * typed client). Never throws: a network error is `status: null`, and a 200
 * whose body is not an answer is a failure that is not retried.
 */
async function verifyOnce(
  client: Client,
  purchase: ProtStorePurchased,
): Promise<VerifyEvent> {
  let response: Response;
  try {
    response = await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/payments/prot/store/verify`,
      {
        method: "POST",
        headers: jsonHeaders(client),
        body: JSON.stringify(verifyRequestBody(purchase)),
      },
    );
  } catch {
    return { type: "verifyFailed", status: null };
  }
  if (!response.ok) return { type: "verifyFailed", status: response.status };

  const answer = readVerifyAnswer(await response.json().catch(() => undefined));
  return answer
    ? { type: "verified", answer }
    : { type: "verifyFailed", status: response.status };
}

/**
 * Verify one unfinished transaction and finish it only when `shouldFinish`
 * says so (iOS; Play is consumed by the server). Kept transactions stay
 * unfinished in the store, which delivers them again at the next launch.
 * Each state is recorded for `protStoreOutcome` while the run is live.
 */
async function recover(run: Run, purchase: ProtStorePurchased): Promise<void> {
  const key = transactionKey(purchase);
  let state: ProtStoreFlowState = { step: "verifying", purchase, attempt: 1 };
  noteOutcome(run, key, state);

  for (;;) {
    if (state.step === "verifying") {
      // Signed out (or switched account) before an answer: the session's
      // cleanup released the claim; stop without touching it
      if (run.disposed) return;
      const event = await verifyOnce(run.client, state.purchase);
      const next = protStoreStep(state, event);
      if (run.disposed && next.step !== "finishing") {
        // The answer came in after the session ended. Only a finish is
        // still worth doing (the device's store queue is not per account);
        // the claim stays released for the next session
        return;
      }
      if (next.step === "verifying" && event.type === "verifyFailed") {
        const wait = verifyBackoffMs(state.attempt, event.status);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      state = next;
      noteOutcome(run, key, state);
      continue;
    }

    if (state.step === "finishing") {
      if (state.purchase.store === "apple" && shouldFinish(state.answer)) {
        try {
          await run.plugin.finish({
            transaction_id: state.purchase.transaction_id,
          });
        } catch (err) {
          // Unfinished: the next launch replays it, answers
          // already_credited and finishes it then
          console.error(
            "Prot store finish failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      state = protStoreStep(state, { type: "finished" });
      noteOutcome(run, key, state);
      continue;
    }

    if (state.step === "kept") {
      console.warn(
        `Prot store purchase of ${state.purchase.product_id} kept unfinished: ${state.why}`,
      );
      // Held over the wallet cap: tell the user once (R66)
      noticeUnderReview(run, key, state);
    }
    return;
  }
}

/**
 * Recovers in-app Prot purchases (S6) in store builds: after sign-in it sets
 * the store facts the spending gate reads (`protStoreFacts.ts`), then
 * verifies every unfinished store transaction (`pendingTransactions()` at
 * start, `transactionUpdated` after) with the server, one at a time, and
 * finishes each only per `shouldFinish`. The server credits; nothing here
 * decides that a purchase counts. When the session ends, the claims it took
 * are released (R29). A purchase it keeps under review (held over the
 * wallet cap) opens the `prot_store_under_review` notice, once per
 * transaction per device (R66).
 *
 * Store builds only (`isStoreBuild`): web, desktop, sideload and foss buy
 * Prot on the web and never reach the plugin.
 */
export function ProtStoreWorker() {
  const client = useClient();
  const { isLoggedIn } = useClientLifecycle();
  const { openModal, isOpen } = useModals();

  createEffect(() => {
    if (!isStoreBuild(distributionChannel())) return;
    if (!isLoggedIn()) return;

    const current = client();
    if (!current) return;

    const store = readStoreAdvert(current.configuration);
    const plugin = ProtStoreNative;
    if (!plugin) {
      // A store shell older than S6 (or a sideload/foss build while its
      // flavor is still unknown): it can never buy in app
      setProtStoreFacts({ store, storePreview: false, pluginAvailable: false });
      onCleanup(() => setProtStoreFacts(NO_PROT_STORE_FACTS));
      return;
    }

    const run: Run = {
      client: current,
      plugin,
      disposed: false,
      claims: new Set(),
      modals: { openModal, isOpen },
      noticeOpened: false,
    };
    let listener: PluginListenerHandle | undefined;
    let queue: Promise<void> = Promise.resolve();

    onCleanup(() => {
      run.disposed = true;
      releaseRunClaims(run);
      void listener?.remove();
      listener = undefined;
      setProtStoreFacts(NO_PROT_STORE_FACTS);
    });

    /** Queue a transaction for its one verify under this session */
    const take = (value: unknown) => {
      const purchase = readPurchase(value);
      if (!purchase || run.disposed || !claimProtStoreVerify(purchase)) return;
      const key = transactionKey(purchase);
      claimOwners.set(key, run);
      run.claims.add(key);
      queue = queue
        .then(() => recover(run, purchase))
        .catch((err) =>
          console.error(
            "Prot store recovery failed:",
            err instanceof Error ? err.message : err,
          ),
        );
    };

    void Promise.all([protStoreAvailable(), fetchStorePreview(current)]).then(
      ([pluginAvailable, storePreview]) => {
        if (run.disposed) return;
        setProtStoreFacts({ store, storePreview, pluginAvailable });
      },
    );

    void (async () => {
      // Listen first, then drain: a transaction delivered in between is
      // claimed once either way
      try {
        const handle = await plugin.addListener("transactionUpdated", take);
        if (run.disposed) {
          void handle.remove();
          return;
        }
        listener = handle;
      } catch (err) {
        console.error(
          "Prot store listener failed:",
          err instanceof Error ? err.message : err,
        );
      }

      try {
        const { purchases } = await plugin.pendingTransactions();
        if (run.disposed) return;
        for (const purchase of Array.isArray(purchases) ? purchases : []) {
          take(purchase);
        }
      } catch (err) {
        console.error(
          "Prot store pending transactions failed:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  });

  return null;
}

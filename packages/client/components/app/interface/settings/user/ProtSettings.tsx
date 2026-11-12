import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { i18n } from "@lingui/core";
import type { Client } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import {
  claimProtStoreVerify,
  protStoreOutcome,
  releaseProtStoreVerify,
} from "@revolt/client/ProtStoreWorker";
import {
  allowsDonationLinks,
  distributionChannel,
  protPurchaseChannel,
} from "@revolt/client/distribution";
import { protStoreFacts } from "@revolt/client/protStoreFacts";
import {
  type ProtStoreFlowEvent,
  type ProtStoreFlowState,
  type ProtStoreVerifyAnswer,
  protStoreStep,
  readVerifyAnswer,
  shouldFinish,
  transactionKey,
  verifyBackoffMs,
  verifyRequestBody,
} from "@revolt/client/protStoreFlow";
import {
  type ProtStoreFailCode,
  type ProtStoreProduct,
  type ProtStorePurchaseResult,
  type ProtStorePurchased,
  ProtStoreNative,
} from "@revolt/client/protStorePlugin";
import { isNativeShell } from "@revolt/common/lib/appOrigin";
import CONFIGURATION from "@revolt/common/lib/env";
import { useError } from "@revolt/i18n/errors";
import { Button } from "@revolt/ui/components/design/Button";
import { CategoryButton } from "@revolt/ui/components/design/CategoryButton";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { useSnackbar } from "@revolt/ui/components/design/Snackbar";
import { Text } from "@revolt/ui/components/design/Text";
import { TextField } from "@revolt/ui/components/design/TextField";
import { Column } from "@revolt/ui/components/layout/Column";
import { Row } from "@revolt/ui/components/layout/Row";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  type CipherApi,
  CipherClientError,
  formatShortTime,
  formatUsd,
  openCheckout,
  responseError,
} from "./cipherCheckout";
import {
  type ProtBalanceUpdate,
  type ProtCheckoutChoice,
  type ProtEntryKind,
  type ProtFeature,
  type ProtMe,
  type ProtOfferAction,
  type ProtPackView,
  type ProtStore,
  PROT_INTENT_KEY,
  PROT_RETURN_WINDOW_MS,
  balanceUpdateAction,
  createProtStanding,
  encodeProtIntent,
  exactAvailable,
  exactCentsProblem,
  formatLedgerTime,
  formatProt,
  formatProtDelta,
  ledgerKindGroup,
  livePendingOrder,
  packBonus,
  parseExactInput,
  parseProtContext,
  parseProtFeature,
  postProtCheckout,
  protOfferAction,
  purchasedSince,
  readProtIntent,
  salesOffered,
  skuProt,
  storePacks,
  withBalanceUpdate,
} from "./protWallet";

/**
 * Headers for a JSON request as the session user (as on the Cipher page):
 * the payment routes are newer than the generated stoat-api schema, and the
 * typed client drops request bodies for routes it doesn't know.
 */
function jsonHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token, "Content-Type": "application/json" };
}

/**
 * Checkout returns already handled, by settings context. The context lives as
 * long as the settings dialog, so coming back to this page from another one
 * must not start the poll or show the cancel note again.
 */
const handledReturns = new WeakSet<object>();

function takeReturn(
  context: unknown,
  value: "success" | "cancel" | undefined,
): "success" | "cancel" | undefined {
  if (!value || typeof context !== "object" || context === null) return;
  if (handledReturns.has(context)) return;
  handledReturns.add(context);
  return value;
}

/** Whether a buy button can be pressed for this action */
function actionable(action: ProtOfferAction): boolean {
  return action === "buy" || action === "resume";
}

/** The two outcomes of one in-app purchase verify request */
type StoreVerifyEvent = Extract<
  ProtStoreFlowEvent,
  { type: "verified" | "verifyFailed" }
>;

/**
 * How long the store gets to list its products (the native `products()`
 * call); after that the packs read as unavailable
 */
const STORE_PRODUCTS_TIMEOUT_MS = 15_000;

/** The native `products()` answer, or an empty list after the timeout */
function storeProductsWithin(
  request: Promise<{ products: ProtStoreProduct[] }>,
  ms: number,
): Promise<{ products: ProtStoreProduct[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ products: ProtStoreProduct[] }>((resolve) => {
    timer = setTimeout(() => {
      console.warn("Prot store products timed out");
      resolve({ products: [] });
    }, ms);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `POST /payments/prot/store/intent` (S6): the intent id and the one-time
 * token the store binds to the purchase. The body names the store and the
 * product only; the server decides the Prot.
 */
async function postStoreIntent(
  api: CipherApi,
  store: ProtStore,
  productId: string,
): Promise<{ intentId: string; token: string }> {
  const response = await api.fetch(
    `${api.apiBase}/payments/prot/store/intent`,
    {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ store, product_id: productId }),
    },
  );
  if (!response.ok) throw await responseError(response);

  const answer = (await response.json().catch(() => undefined)) as
    | { intent_id?: unknown; token?: unknown; product_id?: unknown }
    | undefined;
  if (
    typeof answer?.intent_id !== "string" ||
    answer.intent_id === "" ||
    typeof answer.token !== "string" ||
    answer.token === "" ||
    answer.product_id !== productId
  ) {
    throw new CipherClientError("badResponse");
  }
  return { intentId: answer.intent_id, token: answer.token };
}

/**
 * `POST /payments/prot/store/intent/<id>/cancel` after a cancelled or failed
 * sheet. Best effort: a failure is ignored, since the intent expires in 24
 * hours anyway (and an expired intent still binds a purchase that arrives
 * late).
 */
async function cancelStoreIntent(
  api: CipherApi,
  intentId: string,
): Promise<void> {
  try {
    await api.fetch(
      `${api.apiBase}/payments/prot/store/intent/${encodeURIComponent(intentId)}/cancel`,
      { method: "POST", headers: api.headers() },
    );
  } catch {
    // See above
  }
}

/**
 * `POST /payments/prot/store/verify` for a purchase the sheet just returned;
 * the body and the answer's reading are the flow module's
 * (`verifyRequestBody`, `readVerifyAnswer`), shared with ProtStoreWorker.
 * Never throws: a network error is `status: null`, and a 200 whose body is
 * not an answer is a failure that is not retried. The server decides what
 * the purchase is worth and whether it counts.
 */
async function verifyStorePurchase(
  api: CipherApi,
  purchase: ProtStorePurchased,
): Promise<StoreVerifyEvent> {
  let response: Response;
  try {
    response = await api.fetch(`${api.apiBase}/payments/prot/store/verify`, {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify(verifyRequestBody(purchase)),
    });
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
 * Prot settings: the wallet balance, the part of it under the 72-hour
 * purchase hold, and recent activity, in every build. Packs and pay-exact
 * show only where the build may link out to payments
 * (`allowsDonationLinks()`) and the server advertises Prot sales as open.
 * App Store and Play builds show the in-app packs instead (StoreShop), only
 * where `protPurchaseChannel` names this build's store.
 *
 * Opened with `context: { page: "prot", checkout? }`: `checkout: "success"`
 * polls the wallet until the purchase shows up.
 */
export function ProtSettings(props: { context?: unknown }) {
  const client = useClient();
  const err = useError();
  const snackbar = useSnackbar();
  const { t } = useLingui();

  const native = isNativeShell();

  // Read once: the context is fixed for the lifetime of the settings dialog
  // eslint-disable-next-line solid/reactivity
  const context = parseProtContext(props.context);
  // eslint-disable-next-line solid/reactivity
  const returned = takeReturn(props.context, context.checkout);

  // The upstream stoat-api config type has no `prot`
  const feature = createMemo(() =>
    parseProtFeature(
      (client().configuration?.features as { prot?: unknown } | undefined)
        ?.prot,
    ),
  );
  const offered = () => salesOffered(feature(), allowsDonationLinks());

  const api: CipherApi = {
    fetch: (url, init) => fetch(url, init),
    apiBase: CONFIGURATION.DEFAULT_API_URL,
    headers: () => jsonHeaders(client()),
  };

  const standing = createProtStanding({ api, nowMs: () => Date.now() });
  onCleanup(() => standing.dispose());

  // Newest ProtBalanceUpdate seen; laid over the last read only while it is
  // newer than that read (see withBalanceUpdate)
  const [update, setUpdate] = createSignal<ProtBalanceUpdate>();
  const wallet = createMemo(() => withBalanceUpdate(standing.me(), update()));

  // How this build buys Prot (S6). The facts come from ProtStoreWorker. This
  // page also has its own parse of the same advert and its own `/@me` read
  // (taken when the page opened, so it can be newer than the worker's read
  // at sign-in). Either source saying yes counts, so the packs show
  // wherever the spending gate (`allowsProtSpending()`, the worker's facts
  // alone) lets Prot be spent.
  const purchaseChannel = createMemo(() => {
    const facts = protStoreFacts();
    return protPurchaseChannel(
      distributionChannel(),
      feature().store ?? facts.store,
      wallet()?.store_preview === true || facts.storePreview,
      facts.pluginAvailable,
    );
  });

  // Set once a return from checkout (or "Check again") announced its poll;
  // a poll started from a stored intent alone shows only its result
  const [announced, setAnnounced] = createSignal(false);
  // A success return whose intent was lost, with the purchase already in
  // the history when the page first read it
  const [alreadyCredited, setAlreadyCredited] = createSignal(false);

  const [buying, setBuying] = createSignal(false);
  const [openedUrl, setOpenedUrl] = createSignal<string>();
  const [exactText, setExactText] = createSignal("");

  // Ticks when an open checkout expires, so the other choices free up
  const [clock, setClock] = createSignal(Date.now());
  createEffect(() => {
    const pending = livePendingOrder(wallet(), clock());
    if (!pending) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(pending.expires_at - Date.now() + 1000, 2 ** 31 - 1),
    );
    onCleanup(() => clearTimeout(timer));
  });

  const userId = () => client().user?.id;

  // Without a stored intent the checkout's start is unknown: a purchase
  // from before this window is never taken for it
  const lostIntentSince = Date.now() - PROT_RETURN_WINDOW_MS;

  function storedIntent() {
    try {
      return readProtIntent(
        sessionStorage.getItem(PROT_INTENT_KEY),
        userId(),
        Date.now(),
      );
    } catch {
      // Storage can be unavailable; a return then reads the history instead
      return undefined;
    }
  }

  function rememberIntent(balance: number) {
    const user = userId();
    if (!user) return;
    try {
      sessionStorage.setItem(
        PROT_INTENT_KEY,
        encodeProtIntent({ user, balance, at: Date.now() }),
      );
    } catch {
      // See storedIntent
    }
  }

  function forgetIntent() {
    try {
      sessionStorage.removeItem(PROT_INTENT_KEY);
    } catch {
      // See storedIntent
    }
  }

  // Set once the page is gone: a checkout answer that arrives after that
  // opens nothing, remembers nothing and arms nothing
  let unmounted = false;
  // Re-enables the buttons if a navigation to Stripe never happens
  let leavingTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    unmounted = true;
    clearTimeout(leavingTimer);
  });

  onMount(() => {
    if (returned === "cancel") forgetIntent();
    if (returned === "success") setAnnounced(true);

    const intent = returned === "cancel" ? undefined : storedIntent();
    if (intent) {
      standing.pollAfterCheckout(intent.balance, intent.at);
    } else if (returned === "success") {
      // The intent was lost (another tab, or no storage): the first read
      // decides whether the purchase is already in. Only a purchase from
      // the last few minutes counts as this one, never an older one.
      void standing.refresh().then(() => {
        const me = standing.me();
        if (!me || unmounted) return;
        if (purchasedSince(me, lostIntentSince)) {
          setAlreadyCredited(true);
        } else {
          standing.pollAfterCheckout(me.balance, lostIntentSince);
        }
      });
    } else {
      void standing.refresh();
    }
  });

  createEffect(
    on(
      standing.phase,
      (phase) => {
        if (phase !== "confirmed") return;
        forgetIntent();
        setOpenedUrl(undefined);
      },
      { defer: true },
    ),
  );

  // The balance is pushed on the user's private topic after every posting.
  // Two postings can publish out of order, so only a newer version is kept,
  // and the history and the held part come with the read it triggers.
  createEffect(
    on(client, (current) => {
      const onUpdate = (balance: number, version: number) => {
        const action = balanceUpdateAction(update(), standing.me(), version);
        if (!action.keep) return;
        setUpdate({ balance, version });
        if (action.refresh) void standing.refresh();
      };
      current.on("protBalanceUpdate", onUpdate);
      onCleanup(() => current.off("protBalanceUpdate", onUpdate));
    }),
  );

  // Shells pay in the system browser and never come back through a URL, so
  // read the wallet again whenever the window comes back
  if (native) {
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      const intent = storedIntent();
      if (intent && standing.phase() !== "polling") {
        standing.pollAfterCheckout(intent.balance, intent.at);
      } else {
        void standing.refresh();
      }
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    onCleanup(() => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    });
  }

  function checkAgain() {
    setAnnounced(true);
    const intent = storedIntent();
    standing.pollAfterCheckout(
      intent?.balance ?? wallet()?.balance ?? 0,
      intent?.at ?? lostIntentSince,
    );
  }

  const note = () => {
    if (!announced()) return undefined;
    const phase = standing.phase();
    if (phase === "polling") return "confirming";
    if (phase === "timedOut") return "notSeen";
    return undefined;
  };

  const thanked = () => standing.phase() === "confirmed" || alreadyCredited();

  function describeCheckout(error: unknown): string {
    if (error instanceof CipherClientError) {
      return error.kind === "rateLimited"
        ? t`Slow down — try again in a moment`
        : t`Checkout couldn't be started. Try again in a moment.`;
    }
    return err(error);
  }

  function describeRead(error: unknown): string {
    if (error instanceof CipherClientError) {
      return error.kind === "rateLimited"
        ? t`Slow down — try again in a moment`
        : t`Your Prot wallet couldn't be loaded. Try again in a moment.`;
    }
    return err(error);
  }

  async function buy(choice: ProtCheckoutChoice) {
    const me = wallet();
    if (buying() || !me) return;
    setBuying(true);
    let leaving = false;

    try {
      const url = await postProtCheckout(api, choice, native);
      // The buyer left the page while the request ran: no navigation, and
      // no system browser opening on its own
      if (unmounted) return;
      rememberIntent(me.balance);
      leaving = !native;
      if (native) setOpenedUrl(url);
      openCheckout(url, native, {
        open: (href, target, features) => window.open(href, target, features),
        assign: (href) => window.location.assign(href),
      });
      // The shell stays on this page: show the open checkout
      if (native) void standing.refresh();
    } catch (error) {
      snackbar.show({ message: describeCheckout(error) });
      // Another checkout is open (another device or tab): show it
      if (
        (error as { type?: unknown } | undefined)?.type === "PaymentPending"
      ) {
        void standing.refresh();
      }
    } finally {
      if (leaving && !unmounted) {
        // On its way to Stripe; if the navigation never happens, let the
        // buyer try again
        clearTimeout(leavingTimer);
        leavingTimer = setTimeout(() => setBuying(false), 10_000);
      } else {
        setBuying(false);
      }
    }
  }

  // In the app locale, as formatCount
  function protAmount(value: number) {
    const amount = formatProt(value, i18n.locale);
    return t`${amount} Prot`;
  }

  function protDelta(value: number) {
    const amount = formatProtDelta(value, i18n.locale);
    return t`${amount} Prot`;
  }

  function heldLine(value: number) {
    const held = formatProt(value, i18n.locale);
    return t`${held} Prot on hold`;
  }

  function entryLabel(kind: ProtEntryKind): string {
    const group = ledgerKindGroup(kind);
    switch (group) {
      case "purchase":
        return t`Prot purchase`;
      case "cipher":
        return t`Cipher Prot`;
      case "clawback":
        return t`Removed after a refund or chargeback`;
      case "adjustment":
        return t`Adjustment by Sloga`;
      case "contribution":
        return t`Contribution`;
      case "pledge":
        return t`Pledge`;
      case "returned":
        return t`Returned to your wallet`;
      case "forfeit":
        return t`Forfeited`;
      case "other":
        return t`Other activity`;
      default: {
        const exhaustive: never = group;
        return exhaustive;
      }
    }
  }

  /**
   * Packs, pay-exact and the open checkout. Everything that names a price
   * or starts a purchase lives here, and this renders only behind
   * `offered()`.
   */
  function Shop(shopProps: { me: ProtMe; feature: ProtFeature }) {
    const usd = (cents: number) => formatUsd(cents, i18n.locale);
    const time = (ms: number) => formatShortTime(ms, i18n.locale);

    const pending = () => livePendingOrder(shopProps.me, clock());

    const packAction = (pack: ProtPackView) =>
      protOfferAction(
        { pack: pack.id },
        pack.prot,
        shopProps.me,
        shopProps.feature,
        clock(),
      );

    const exactCents = () => parseExactInput(exactText());
    const exactEntered = () => exactText().trim() !== "";
    const exactProblem = () =>
      exactEntered()
        ? exactCentsProblem(exactCents(), shopProps.feature)
        : undefined;
    const exactReady = () => exactEntered() && !exactProblem();
    const exactAction = () =>
      protOfferAction(
        { exactCents: exactCents() },
        exactCents(),
        shopProps.me,
        shopProps.feature,
        clock(),
      );

    const actions = () => [
      ...shopProps.feature.packs.map(packAction),
      ...(exactReady() ? [exactAction()] : []),
    ];

    function buyLabel(cents: number, action: ProtOfferAction) {
      if (action === "resume") return t`Continue checkout`;
      const price = usd(cents);
      return t`Buy for ${price}`;
    }

    function bonusLine(pack: ProtPackView) {
      const bonus = formatProt(packBonus(pack), i18n.locale);
      return t`Includes ${bonus} bonus Prot`;
    }

    function exactRange() {
      const min = formatProt(shopProps.feature.exact_min_cents, i18n.locale);
      const max = formatProt(shopProps.feature.exact_max_cents, i18n.locale);
      return t`Choose any amount from ${min} to ${max} Prot.`;
    }

    function problemText(problem: "notInteger" | "belowMin" | "aboveMax") {
      if (problem === "notInteger") return t`Enter a whole number of Prot.`;
      if (problem === "belowMin") {
        const min = formatProt(shopProps.feature.exact_min_cents, i18n.locale);
        return t`The minimum is ${min} Prot.`;
      }
      const max = formatProt(shopProps.feature.exact_max_cents, i18n.locale);
      return t`The maximum is ${max} Prot.`;
    }

    function capNote() {
      const max = formatProt(shopProps.feature.wallet_cap, i18n.locale);
      return t`A wallet can hold up to ${max} Prot.`;
    }

    function checkoutOpen(prot: number) {
      const name = protAmount(prot);
      return t`Checkout open: ${name}`;
    }

    function expiresAt(ms: number) {
      const expires = time(ms);
      return t`Expires ${expires}`;
    }

    function waitNote(ms: number) {
      const expires = time(ms);
      return t`You can choose a different amount after ${expires}, when your open checkout expires.`;
    }

    function submitExact(event: SubmitEvent) {
      event.preventDefault();
      if (!exactReady() || !actionable(exactAction())) return;
      void buy({ exactCents: exactCents() });
    }

    return (
      <Column gap="lg">
        <Column>
          <Text class="title">
            <Trans>Get Prot</Trans>
          </Text>
          <Text class="label">
            <Trans>
              Every US cent buys 1 Prot, and bigger packs include bonus Prot.
            </Trans>
          </Text>
        </Column>

        <Show when={pending()}>
          {(open) => (
            <CategoryButton
              icon={<Symbol size={22}>shopping_cart_checkout</Symbol>}
              description={
                <Show
                  when={openedUrl()}
                  fallback={expiresAt(open().expires_at)}
                >
                  <Trans>
                    Finish paying in your browser. This page updates when you
                    come back.
                  </Trans>
                </Show>
              }
              action={openedUrl() ? "external" : undefined}
              onClick={
                openedUrl()
                  ? () => window.open(openedUrl(), "_blank", "noopener")
                  : undefined
              }
            >
              {checkoutOpen(skuProt(open().sku))}
            </CategoryButton>
          )}
        </Show>

        <Show when={shopProps.feature.packs.length}>
          <PackGrid>
            {/* By position: every read builds new objects, and a keyed list
                would rebuild the cards (and drop keyboard focus) on each
                poll */}
            <Index each={shopProps.feature.packs}>
              {(pack) => (
                <PackCard>
                  <Text class="title" size="large">
                    {protAmount(pack().prot)}
                  </Text>
                  <Text class="label">{usd(pack().cents)}</Text>
                  <Show when={packBonus(pack()) > 0}>
                    <Text class="label">{bonusLine(pack())}</Text>
                  </Show>
                  <CardAction>
                    <Button
                      variant="tonal"
                      isDisabled={buying() || !actionable(packAction(pack()))}
                      onPress={() => void buy({ pack: pack().id })}
                    >
                      {buyLabel(pack().cents, packAction(pack()))}
                    </Button>
                  </CardAction>
                </PackCard>
              )}
            </Index>
          </PackGrid>
        </Show>

        <Show when={exactAvailable(shopProps.feature)}>
          <form onSubmit={submitExact}>
            <Column>
              <Text class="title">
                <Trans>Pay an exact amount</Trans>
              </Text>
              <Text class="label">{exactRange()}</Text>
              <Row align>
                <TextField
                  value={exactText()}
                  label={t`Amount of Prot`}
                  inputmode="numeric"
                  autocomplete="off"
                  maxlength={15}
                  onInput={(event) => setExactText(event.currentTarget.value)}
                />
                <Button
                  size="sm"
                  type="submit"
                  isDisabled={
                    buying() || !exactReady() || !actionable(exactAction())
                  }
                >
                  {exactReady()
                    ? buyLabel(exactCents(), exactAction())
                    : t`Enter an amount`}
                </Button>
              </Row>
              <Show when={exactProblem()}>
                {(problem) => (
                  <Text class="label">{problemText(problem())}</Text>
                )}
              </Show>
            </Column>
          </form>
        </Show>

        <Show when={actions().includes("waitForPending") && pending()}>
          {(open) => <Text class="label">{waitNote(open().expires_at)}</Text>}
        </Show>
        <Show when={actions().includes("overCap")}>
          <Text class="label">{capNote()}</Text>
        </Show>
        <Text class="label">
          <Trans>You'll pay on Stripe's secure checkout page.</Trans>{" "}
          <Show when={native}>
            <Trans>It opens in your browser.</Trans>
          </Show>
        </Text>
      </Column>
    );
  }

  /**
   * The in-app packs (S6): each with the Prot the server credits for it and
   * the price the store itself shows, bought through the store's own sheet.
   * Nothing here names a web price or leaves the app (E8). The purchase runs
   * through the `protStoreStep` machine: an intent, the sheet, then a verify
   * the server answers (and, on iOS, a finish only when `shouldFinish` says
   * so). The server decides what a purchase counts for; this only shows its
   * answer.
   */
  function StoreShop(storeProps: {
    me: ProtMe;
    feature: ProtFeature;
    channel: "appstore" | "play";
  }) {
    const store = (): ProtStore =>
      storeProps.channel === "appstore" ? "apple" : "play";

    // The product ids the server lists for this store, as one key, so a
    // fresh read of the same advert does not ask the store again
    const productKey = createMemo(() =>
      (storeProps.feature.store?.products ?? [])
        .filter((product) => product.store === store())
        .map((product) => product.product_id)
        .join("\n"),
    );

    // The store's own answer (id and localized price); undefined while it
    // loads, empty when the store answered nothing usable or nothing within
    // STORE_PRODUCTS_TIMEOUT_MS
    const [products, setProducts] = createSignal<ProtStoreProduct[]>();
    createEffect(
      on(productKey, (key) => {
        const plugin = ProtStoreNative;
        const ids = key === "" ? [] : key.split("\n");
        if (!plugin || ids.length === 0) {
          setProducts([]);
          return;
        }
        let live = true;
        onCleanup(() => {
          live = false;
        });
        setProducts(undefined);
        storeProductsWithin(
          plugin.products({ ids }),
          STORE_PRODUCTS_TIMEOUT_MS,
        ).then(
          (answer) => {
            if (!live) return;
            setProducts(Array.isArray(answer?.products) ? answer.products : []);
          },
          (error) => {
            if (!live) return;
            console.error(
              "Prot store products failed:",
              error instanceof Error ? error.message : error,
            );
            setProducts([]);
          },
        );
      }),
    );

    const packs = () =>
      storePacks(storeProps.feature, store(), products() ?? []);

    const [flow, setFlow] = createSignal<ProtStoreFlowState>({ step: "idle" });
    // A failed sheet's note (from its code only), kept past the intent's
    // cancel until the next purchase starts
    const [sheetNote, setSheetNote] = createSignal<string>();
    // The `transactionKey` of a purchase the recovery worker claimed first:
    // the worker verifies it, and this shows the worker's outcome (R30)
    const [handedKey, setHandedKey] = createSignal<string>();
    const handedOutcome = () => {
      const key = handedKey();
      return key === undefined ? undefined : protStoreOutcome(key);
    };

    // Set once StoreShop is gone: an intent that arrives after that opens
    // no sheet
    let storeGone = false;

    // Claims this page took whose verify ended kept, with the session they
    // were taken under: released once that session ends, so the next
    // sign-in verifies the purchase again (R29)
    let keptClaims: { purchase: ProtStorePurchased; session: Client }[] = [];
    function releaseEndedClaims(current: Client | undefined) {
      keptClaims = keptClaims.filter((claim) => {
        if (claim.session === current) return true;
        releaseProtStoreVerify(claim.purchase);
        return false;
      });
    }
    createEffect(
      on(
        client,
        (current) => {
          releaseEndedClaims(current);
          // A worker outcome belongs to the session it was taken under
          setHandedKey(undefined);
        },
        { defer: true },
      ),
    );
    onCleanup(() => {
      storeGone = true;
      // Nothing here would see the session end once the page is gone, so
      // kept claims go back now: the worker may verify them again (the
      // server answers a repeat the same way, and nothing is finished)
      releaseEndedClaims(undefined);
    });

    const busy = () => {
      const step = flow().step;
      return (
        step === "intent" ||
        step === "sheet" ||
        step === "verifying" ||
        step === "finishing" ||
        step === "cancelling"
      );
    };

    function unavailable() {
      return err({ type: "ProtStoreUnavailable" });
    }

    function describeIntentError(error: unknown): string {
      if (error instanceof CipherClientError && error.kind === "rateLimited") {
        return t`Slow down — try again in a moment`;
      }
      // An API error names its type; no answer, or an unreadable one, reads
      // as the store being unavailable
      if (typeof (error as { type?: unknown } | undefined)?.type === "string") {
        return err(error);
      }
      return unavailable();
    }

    /**
     * A failed sheet's note, from its code only (R31): the native layer's
     * own text is never shown (it goes to the console in `purchase`). An
     * unknown code reads as the store being unavailable.
     */
    function sheetFailureNote(code: string): string {
      const known: readonly ProtStoreFailCode[] = [
        "not_available",
        "product_not_found",
        "already_owned",
        "invalid_token",
        "store_error",
      ];
      switch (known.find((c) => c === code)) {
        case "product_not_found":
          return err({ type: "ProtStoreProductUnknown" });
        case "already_owned":
          // An earlier purchase of this pack is not settled yet; the
          // recovery worker verifies it
          return keptNote("retry");
        default:
          // not_available, invalid_token, store_error, or a code this
          // client does not know
          return unavailable();
      }
    }

    async function purchase(productId: string) {
      const plugin = ProtStoreNative;
      if (!plugin) return;

      // Only from a settled state: one purchase at a time
      let state = protStoreStep(flow(), { type: "start", productId });
      if (state.step !== "intent") return;
      setFlow(state);
      setSheetNote(undefined);
      setHandedKey(undefined);
      // The signed-in session this purchase runs under (R29): every request
      // carries the CURRENT session, so the flow stops once it changes
      const session = client();
      const sessionEnded = () => client() !== session;

      let intent: { intentId: string; token: string };
      try {
        intent = await postStoreIntent(api, store(), productId);
      } catch (error) {
        state = protStoreStep(state, {
          type: "intentFailed",
          message: describeIntentError(error),
        });
        setFlow(state);
        return;
      }
      if (storeGone || sessionEnded()) {
        // No sheet; the cancel is best effort (under another session it is
        // refused, and the intent expires anyway)
        void cancelStoreIntent(api, intent.intentId);
        setFlow({ step: "idle" });
        return;
      }

      state = protStoreStep(state, { type: "intentOk", ...intent });
      setFlow(state);
      if (state.step !== "sheet") return;

      let result: ProtStorePurchaseResult;
      try {
        result = await plugin.purchase({
          product_id: productId,
          account_token: intent.token,
        });
      } catch (error) {
        // The bridge call failed: nothing was bought that the app can see
        console.warn(
          "Prot store purchase call failed:",
          error instanceof Error ? error.message : error,
        );
        result = { result: "failed", code: "store_error" };
      }
      if (result?.result === "failed" && result.message) {
        // The native text is for the logs only, never shown (R31)
        console.warn(
          `Prot store sheet failed (${result.code}): ${result.message}`,
        );
      }
      state = protStoreStep(state, { type: "sheet", result });
      setFlow(state);

      if (state.step === "cancelling") {
        if (state.message) setSheetNote(sheetFailureNote(state.message));
        await cancelStoreIntent(api, state.intentId);
        state = protStoreStep(state, { type: "finished" });
        setFlow(state);
        return;
      }
      // A pending sheet never verifies: the purchase arrives later, through
      // the recovery worker. A malformed purchase (idle) is not cancelled:
      // the worker's drain recovers it (R34)
      if (state.step !== "verifying") return;

      if (sessionEnded()) {
        // Signed out (or switched) while the sheet was open: the next
        // session's worker drain verifies it
        setFlow({ step: "idle" });
        return;
      }
      if (!claimProtStoreVerify(state.purchase)) {
        // The recovery worker took this transaction first: it verifies
        // (and finishes) it, and its outcome is shown here (R30)
        setHandedKey(transactionKey(state.purchase));
        setFlow({ step: "idle" });
        return;
      }

      // Claimed under this session: verified even if the page closes
      // meanwhile, until the session ends (then the claim is released, so
      // the next session verifies it, R29)
      while (state.step === "verifying") {
        if (sessionEnded()) {
          releaseProtStoreVerify(state.purchase);
          setFlow({ step: "idle" });
          return;
        }
        const event = await verifyStorePurchase(api, state.purchase);
        const next = protStoreStep(state, event);
        if (next.step === "verifying" && event.type === "verifyFailed") {
          const wait = verifyBackoffMs(state.attempt, event.status);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        state = next;
        setFlow(state);
      }

      if (state.step === "finishing") {
        if (state.purchase.store === "apple" && shouldFinish(state.answer)) {
          try {
            await plugin.finish({
              transaction_id: state.purchase.transaction_id,
            });
          } catch (error) {
            // Unfinished: the next launch replays it, answers
            // already_credited and finishes it then
            console.error(
              "Prot store finish failed:",
              error instanceof Error ? error.message : error,
            );
          }
        }
        state = protStoreStep(state, { type: "finished" });
        setFlow(state);
      }

      if (state.step === "kept") {
        // Unfinished: held for this session only (R29)
        keptClaims.push({ purchase: state.purchase, session });
        if (storeGone) releaseEndedClaims(undefined);
        else if (sessionEnded()) releaseEndedClaims(client());
      }

      if (
        state.step === "done" &&
        (state.answer.status === "credited" ||
          state.answer.status === "already_credited")
      ) {
        void standing.refresh();
      }
    }

    function waitingNote() {
      return t`Waiting for approval. Your Prot arrives when the purchase completes.`;
    }

    function addedNote() {
      return t`Prot added to your wallet.`;
    }

    function answerNote(answer: ProtStoreVerifyAnswer): string | undefined {
      if (
        answer.status === "credited" ||
        answer.status === "already_credited"
      ) {
        return addedNote();
      }
      if (answer.status === "rejected" && answer.reason === "refunded") {
        return t`This purchase was refunded, so no Prot was added.`;
      }
      if (answer.status === "rejected" && answer.reason === "test") {
        return t`Test purchases aren't credited on this server.`;
      }
      return undefined;
    }

    function keptNote(
      why: Extract<ProtStoreFlowState, { step: "kept" }>["why"],
    ): string {
      switch (why) {
        case "pending":
          return waitingNote();
        case "wrong_account":
          return t`Sign in to the account that bought this to receive the Prot.`;
        case "unbound":
        case "unknown_product":
        case "no_buyer":
          return t`This purchase needs our help. Contact support and we'll add the Prot to your account.`;
        case "under_review":
          // Held for staff review (R63): unfinished until it is credited
          // or refunded
          return t`This purchase is under review because it would take your Prot wallet over its limit. We'll add the Prot or help you get a refund.`;
        case "retry":
          return t`We couldn't reach Sloga to confirm your purchase. It's safe, and we'll try again.`;
        default: {
          const exhaustive: never = why;
          return exhaustive;
        }
      }
    }

    // The note for a settled flow state; nothing while one is in flight
    function stateNote(state: ProtStoreFlowState): string | undefined {
      switch (state.step) {
        case "pending":
          return waitingNote();
        case "done":
          return answerNote(state.answer);
        case "kept":
          return keptNote(state.why);
        case "failed":
          return state.message;
        default:
          return undefined;
      }
    }

    // A purchase the worker holds is in flight until its outcome settles
    // (no outcome yet: still queued behind another transaction)
    const handedBusy = () => {
      if (handedKey() === undefined) return false;
      const step = handedOutcome()?.step;
      return step === undefined || step === "verifying" || step === "finishing";
    };

    // What the last purchase came to: this page's own flow, a failed sheet,
    // or the worker's outcome for a purchase it claimed (R30)
    const storeNote = (): string | undefined => {
      const state = flow();
      if (state.step !== "idle" && state.step !== "cancelling") {
        return stateNote(state);
      }
      const sheet = sheetNote();
      if (sheet) return sheet;
      const outcome = handedOutcome();
      return outcome ? stateNote(outcome) : undefined;
    };

    return (
      <Column gap="lg">
        <Column>
          <Text class="title">
            <Trans>Prot packs</Trans>
          </Text>
          <Show when={storeProps.channel === "appstore"}>
            <Text class="label">
              <Trans>
                Protected channels open in Sloga for desktop and Android. On
                iPhone you can buy Prot and fund channels.
              </Trans>
            </Text>
          </Show>
        </Column>

        <Switch>
          <Match when={products() === undefined}>
            <CircularProgress />
          </Match>
          <Match when={packs().length === 0}>
            <Text class="label">{unavailable()}</Text>
          </Match>
          <Match when={packs().length > 0}>
            <PackGrid>
              <Index each={packs()}>
                {(pack) => (
                  <PackCard>
                    <Text class="title" size="large">
                      {protAmount(pack().prot)}
                    </Text>
                    <Text class="label">{pack().displayPrice}</Text>
                    <CardAction>
                      <Button
                        variant="tonal"
                        isDisabled={busy()}
                        onPress={() => void purchase(pack().id)}
                      >
                        <Trans>Purchase</Trans>
                      </Button>
                    </CardAction>
                  </PackCard>
                )}
              </Index>
            </PackGrid>
          </Match>
        </Switch>

        {/* A failed sheet's note shows while its intent is cancelled */}
        <StoreNote role="status" aria-live="polite">
          <Switch>
            <Match when={storeNote()}>
              {(text) => <Text class="label">{text()}</Text>}
            </Match>
            <Match when={busy() || handedBusy()}>
              <CircularProgress />
            </Match>
          </Switch>
        </StoreNote>
      </Column>
    );
  }

  return (
    <Column gap="lg">
      <Text class="label">
        <Trans>
          Prot is the credit you'll use for Protected servers and channels. Your
          balance and recent activity are below.
        </Trans>
      </Text>

      {/* Checkout notes only where checkout is linked to at all */}
      <Show when={allowsDonationLinks()}>
        <Status role="status" aria-live="polite">
          <Show when={returned === "cancel"}>
            <CategoryButton icon={<Symbol size={22}>info</Symbol>}>
              <Trans>Checkout canceled. You weren't charged.</Trans>
            </CategoryButton>
          </Show>
          <Switch>
            <Match when={note() === "confirming"}>
              <CategoryButton
                icon={<Symbol size={22}>hourglass_top</Symbol>}
                description={<Trans>This usually takes a few seconds.</Trans>}
              >
                <Trans>Confirming your payment…</Trans>
              </CategoryButton>
            </Match>
            <Match when={thanked()}>
              <CategoryButton icon={<Symbol size={22}>celebration</Symbol>}>
                <Trans>Thank you! Your Prot is in your wallet.</Trans>
              </CategoryButton>
            </Match>
            <Match when={note() === "notSeen"}>
              <CategoryButton
                icon={<Symbol size={22}>schedule</Symbol>}
                description={
                  <Trans>
                    If you finished checking out, it can take a few minutes to
                    show up here.
                  </Trans>
                }
                action={
                  <Button size="sm" onPress={checkAgain}>
                    <Trans>Check again</Trans>
                  </Button>
                }
              >
                <Trans>We haven't seen your payment yet</Trans>
              </CategoryButton>
            </Match>
          </Switch>
        </Status>
      </Show>

      <Switch fallback={<CircularProgress />}>
        {/* Data first: a failed refresh keeps the last wallet */}
        <Match when={wallet()}>
          {(me) => (
            <Column gap="lg">
              <CategoryButton.Group>
                <CategoryButton
                  icon={<Symbol size={22}>toll</Symbol>}
                  description={<Trans>Your balance</Trans>}
                >
                  {protAmount(me().balance)}
                </CategoryButton>
                <CategoryButton
                  icon={<Symbol size={22}>lock_clock</Symbol>}
                  description={
                    me().held > 0 ? (
                      <Trans>
                        Prot bought in the last 72 hours stays in your wallet,
                        but it can't be spent on Protected servers and channels
                        until the hold ends. This guards against card fraud.
                      </Trans>
                    ) : undefined
                  }
                >
                  {heldLine(me().held)}
                </CategoryButton>
              </CategoryButton.Group>

              <Show when={offered()}>
                <Shop me={me()} feature={feature()} />
              </Show>

              {/* In-app packs only where this build's store sells them */}
              <Show
                when={
                  purchaseChannel() === "appstore" ||
                  purchaseChannel() === "play"
                }
              >
                <StoreShop
                  me={me()}
                  feature={feature()}
                  channel={
                    purchaseChannel() === "appstore" ? "appstore" : "play"
                  }
                />
              </Show>

              <Column>
                <Text class="title">
                  <Trans>Recent activity</Trans>
                </Text>
                <Show
                  when={me().recent.length}
                  fallback={
                    <Text class="label">
                      <Trans>No Prot activity yet.</Trans>
                    </Text>
                  }
                >
                  <History>
                    <For each={me().recent}>
                      {(entry) => (
                        <HistoryRow>
                          <HistoryText>
                            <Text class="body">{entryLabel(entry.kind)}</Text>
                            <Text class="label">
                              {formatLedgerTime(entry.created_at, i18n.locale)}
                            </Text>
                          </HistoryText>
                          <Text class="body">{protDelta(entry.amount)}</Text>
                        </HistoryRow>
                      )}
                    </For>
                  </History>
                </Show>
              </Column>
            </Column>
          )}
        </Match>
        <Match when={standing.error()}>
          <Column>
            <Text class="label">{describeRead(standing.error())}</Text>
            <Row>
              <Button size="sm" onPress={() => void standing.refresh()}>
                <Trans>Try again</Trans>
              </Button>
            </Row>
          </Column>
        </Match>
      </Switch>
    </Column>
  );
}

/** Live region for the checkout return notes */
const Status = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    "&:empty": {
      display: "none",
    },
  },
});

/** Live region for the in-app purchase notes (StoreShop) */
const StoreNote = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    "&:empty": {
      display: "none",
    },
  },
});

const PackGrid = styled("div", {
  base: {
    display: "grid",
    gap: "var(--gap-md)",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  },
});

const PackCard = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const CardAction = styled("div", {
  base: {
    display: "grid",
    marginTop: "auto",
    paddingTop: "var(--gap-sm)",
  },
});

const History = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
  },
});

const HistoryRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
    "&:not(:last-child)": {
      borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    },
  },
});

const HistoryText = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    minWidth: 0,
  },
});

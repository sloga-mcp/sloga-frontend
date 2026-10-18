import {
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

import { cipherPromoUrl, formatCount } from "@revolt/auth/src/cipherPromo";
import { allowsDonationLinks, useClient } from "@revolt/client";
import { CONFIGURATION, isNativeShell } from "@revolt/common";
import { useError } from "@revolt/i18n";
import {
  Button,
  CategoryButton,
  CircularProgress,
  Column,
  Row,
  Text,
  useSnackbar,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  type CheckoutReturn,
  type CipherApi,
  type CipherMe,
  type CipherOffer,
  type CipherStats,
  type CipherTier,
  type OfferAction,
  type StandingState,
  CipherClientError,
  INTENT_KEY,
  createCipherStanding,
  encodeIntent,
  fetchCipherMe,
  fetchCipherStats,
  formatCipherNumber,
  livePending,
  offerAction,
  openCheckout,
  pageOffers,
  parseCipherContext,
  parseUserCipher,
  pollBaselineOf,
  postCheckout,
  readIntent,
  saleStatus,
  skuTier,
  thankedMembership,
  tierCents,
} from "./cipherCheckout";

/**
 * Headers for a JSON request as the session user (as on the Supporter page):
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
  value: CheckoutReturn | undefined,
): CheckoutReturn | undefined {
  if (!value || typeof context !== "object" || context === null) return;
  if (handledReturns.has(context)) return;
  handledReturns.add(context);
  return value;
}

/**
 * Cipher settings: the buyer's membership, or the tiers to buy and upgrade
 * to. Nothing renders in store builds, which may not link out to other
 * payment methods.
 *
 * Opened with `context: { page: "cipher", tier?, checkout? }`: `tier` is
 * highlighted (the sloga.gg deep link), and `checkout: "success"` polls the
 * standing until the purchase shows up.
 */
export function CipherSettings(props: { context?: unknown }) {
  return (
    <Show when={allowsDonationLinks()}>
      <CipherPage context={props.context} />
    </Show>
  );
}

function CipherPage(props: { context?: unknown }) {
  const client = useClient();
  const err = useError();
  const snackbar = useSnackbar();
  const { t } = useLingui();

  const native = isNativeShell();

  // Read once: the context is fixed for the lifetime of the settings dialog
  // eslint-disable-next-line solid/reactivity
  const context = parseCipherContext(props.context);
  // eslint-disable-next-line solid/reactivity
  const returned = takeReturn(props.context, context.checkout);

  const api: CipherApi = {
    fetch: (url, init) => fetch(url, init),
    apiBase: CONFIGURATION.DEFAULT_API_URL,
    headers: () => jsonHeaders(client()),
  };

  const [standing, setStanding] = createSignal<StandingState>({
    loading: true,
    poll: "idle",
  });

  const controller = createCipherStanding({
    fetchMe: () => fetchCipherMe(api),
    onChange: (state) => setStanding(state),
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  onCleanup(() => controller.dispose());

  const [stats, setStats] = createSignal<CipherStats>();
  const [buying, setBuying] = createSignal<CipherTier>();
  const [openedUrl, setOpenedUrl] = createSignal<string>();

  // Whether a running poll says so on screen. A shell polls quietly when its
  // window regains focus (the buyer may only be switching windows), and
  // only its result is shown.
  const [announcePoll, setAnnouncePoll] = createSignal(false);

  // The tier held when the poll started (see thankedMembership)
  const [pollBaseline, setPollBaseline] = createSignal<CipherTier | null>();

  function startPoll(tier: CipherTier | undefined, announce: boolean) {
    setAnnouncePoll(announce);
    setPollBaseline(pollBaselineOf(standing().me));
    controller.startPoll(tier);
  }

  const newMembership = () => thankedMembership(standing(), pollBaseline());

  // Ticks when an open checkout expires, so its tier frees up on screen
  const [clock, setClock] = createSignal(Date.now());
  createEffect(() => {
    const pending = livePending(standing().me, clock());
    if (!pending) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(pending.expires_at - Date.now() + 1000, 2 ** 31 - 1),
    );
    onCleanup(() => clearTimeout(timer));
  });

  const userId = () => client().user?.id;

  function storedIntent() {
    try {
      return readIntent(
        sessionStorage.getItem(INTENT_KEY),
        userId(),
        Date.now(),
      );
    } catch {
      // Storage can be unavailable; the poll then waits for any membership
      // instead of a tier
      return undefined;
    }
  }

  function rememberIntent(tier: CipherTier) {
    const user = userId();
    if (!user) return;
    try {
      sessionStorage.setItem(
        INTENT_KEY,
        encodeIntent({ user, tier, at: Date.now() }),
      );
    } catch {
      // See storedIntent
    }
  }

  function forgetIntent() {
    try {
      sessionStorage.removeItem(INTENT_KEY);
    } catch {
      // See storedIntent
    }
  }

  onMount(() => {
    if (returned === "cancel") forgetIntent();

    // A checkout this tab started recently also polls: it covers a return
    // that reached settings without the `checkout` context
    const intent = storedIntent();
    if (returned === "success" || intent) {
      startPoll(intent?.tier, true);
    } else {
      controller.refresh();
    }

    // Display only: without the counter the page offers everything and the
    // server decides
    fetchCipherStats(api).then(
      (value) => setStats(value),
      () => undefined,
    );
  });

  createEffect(
    on(
      () => standing().poll,
      (poll) => {
        if (poll !== "confirmed") return;
        forgetIntent();
        setOpenedUrl(undefined);
      },
      { defer: true },
    ),
  );

  // The badge on the user object changes when a purchase is fulfilled (or
  // revoked); read the full standing again when it does
  const storeCipher = createMemo(() => {
    const cipher = parseUserCipher(client().user?.cipher);
    return cipher ? `${cipher.number}:${cipher.tier}` : "";
  });
  createEffect(on(storeCipher, () => controller.refresh(), { defer: true }));

  // Shells pay in the system browser and never come back through a URL, so
  // read the standing again whenever the window comes back
  if (native) {
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      const intent = storedIntent();
      const state = standing();
      if (
        state.poll !== "polling" &&
        (intent || livePending(state.me, Date.now()))
      ) {
        startPoll(intent?.tier, false);
      } else {
        controller.refresh();
      }
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    onCleanup(() => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    });
  }

  function describe(error: unknown): string {
    if (error instanceof CipherClientError) {
      return error.kind === "rateLimited"
        ? t`Slow down — try again in a moment`
        : t`Checkout couldn't be started. Try again in a moment.`;
    }
    return err(error);
  }

  async function buy(tier: CipherTier) {
    if (buying()) return;
    setBuying(tier);
    let leaving = false;

    try {
      const url = await postCheckout(api, tier, native);
      rememberIntent(tier);
      leaving = !native;
      if (native) setOpenedUrl(url);
      openCheckout(url, native, {
        open: (href, target, features) => window.open(href, target, features),
        assign: (href) => window.location.assign(href),
      });
      // The shell stays on this page: show the open checkout
      if (native) controller.refresh();
    } catch (error) {
      snackbar.show({ message: describe(error) });
      // Another checkout is open (another device or tab): show it
      if (
        (error as { type?: unknown } | undefined)?.type === "PaymentPending"
      ) {
        controller.refresh();
      }
    } finally {
      if (leaving) {
        // On its way to Stripe; if the navigation never happens, let the
        // buyer try again
        setTimeout(() => setBuying(undefined), 10_000);
      } else {
        setBuying(undefined);
      }
    }
  }

  const usd = (cents: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);

  const time = (ms: number) =>
    new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(ms);

  function cipherName(number: number) {
    const label = formatCipherNumber(number);
    return t`Cipher ${label}`;
  }

  function tierName(tier: CipherTier) {
    const price = usd(tierCents(tier));
    return t`${price} tier`;
  }

  function protLine(prot: number) {
    const amount = formatCount(prot, i18n.locale);
    return t`${amount} Prot at launch`;
  }

  function thanks(number: number) {
    const label = formatCipherNumber(number);
    return t`Thank you! You're Cipher ${label}.`;
  }

  function checkoutOpen(tier: CipherTier) {
    const name = tierName(tier);
    return t`Checkout open: ${name}`;
  }

  function expiresAt(ms: number) {
    const expires = time(ms);
    return t`Expires ${expires}`;
  }

  function waitNote(ms: number) {
    const expires = time(ms);
    return t`You can pick a different tier after ${expires}, when your open checkout expires.`;
  }

  function claimedLine(value: CipherStats) {
    const claimed = formatCount(value.claimed, i18n.locale);
    const cap = formatCount(value.cap, i18n.locale);
    return t`${claimed} of ${cap} claimed`;
  }

  function soldOutNote(value: CipherStats) {
    const cap = formatCount(value.cap, i18n.locale);
    return t`All ${cap} Cipher numbers have been claimed.`;
  }

  function buttonLabel(offer: CipherOffer, action: OfferAction) {
    if (action === "resume") return t`Continue checkout`;
    const price = usd(offer.cents);
    return offer.kind === "upgrade"
      ? t`Upgrade for ${price}`
      : t`Buy for ${price}`;
  }

  // Scroll the preselected tier into view once, when it first renders
  let scrolledToPick = false;
  function pickRef(element: HTMLElement) {
    if (scrolledToPick) return;
    scrolledToPick = true;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    requestAnimationFrame(() =>
      element.scrollIntoView({
        block: "nearest",
        behavior: reduced ? "auto" : "smooth",
      }),
    );
  }

  function Offers(offersProps: { me: CipherMe }) {
    const offers = () => pageOffers(offersProps.me);
    const sale = () => saleStatus(stats());
    const action = (offer: CipherOffer) =>
      offerAction(offer, offersProps.me, sale(), clock());
    const blockedUntil = () =>
      offers().some((offer) => action(offer) === "waitForPending")
        ? livePending(offersProps.me, clock())?.expires_at
        : undefined;

    return (
      <Show
        when={offers().length}
        fallback={
          <Show
            when={
              offersProps.me.membership && !offersProps.me.membership.disputed
            }
          >
            <Text class="label">
              <Trans>
                You're on the top tier. Thank you for backing Sloga!
              </Trans>
            </Text>
          </Show>
        }
      >
        <Column>
          <Text class="title">
            {offersProps.me.membership
              ? t`Upgrade your tier`
              : t`Become a Cipher`}
          </Text>

          <Switch>
            <Match when={sale() === "closed"}>
              <Text class="label">
                <Trans>Cipher sales are closed.</Trans>
              </Text>
            </Match>
            <Match
              when={
                sale() === "soldOut" && !offersProps.me.membership && stats()
              }
            >
              {(value) => <Text class="label">{soldOutNote(value())}</Text>}
            </Match>
          </Switch>

          <OfferGrid>
            {/* By position: every read builds new offer objects, and a keyed
                list would rebuild the cards (and drop keyboard focus) on
                each poll */}
            <Index each={offers()}>
              {(offer) => {
                const picked = () => context.tier === offer().tier;
                return (
                  <OfferCard
                    ref={(element: HTMLDivElement) =>
                      picked() && pickRef(element)
                    }
                    data-selected={picked() ? "" : undefined}
                  >
                    <Text class="title" size="large">
                      {usd(tierCents(offer().tier))}
                    </Text>
                    <Show when={picked()}>
                      <Text class="label">
                        <Trans>Selected</Trans>
                      </Text>
                    </Show>
                    <Text class="label">{protLine(offer().prot)}</Text>
                    <Show when={offer().kind === "new"}>
                      <Text class="label">
                        <Trans>Numbered Cipher badge</Trans>
                      </Text>
                    </Show>
                    <Show when={offer().tier === "T299"}>
                      <Text class="label">
                        <Trans>Animated Cipher badge</Trans>
                      </Text>
                    </Show>
                    <CardAction>
                      <Button
                        variant={picked() ? "filled" : "tonal"}
                        isDisabled={
                          !!buying() ||
                          (action(offer()) !== "buy" &&
                            action(offer()) !== "resume")
                        }
                        onPress={() => void buy(offer().tier)}
                      >
                        {buttonLabel(offer(), action(offer()))}
                      </Button>
                    </CardAction>
                  </OfferCard>
                );
              }}
            </Index>
          </OfferGrid>

          <Show when={blockedUntil()}>
            {(until) => <Text class="label">{waitNote(until())}</Text>}
          </Show>
          <Text class="label">
            <Trans>You'll pay on Stripe's secure checkout page.</Trans>{" "}
            <Show when={native}>
              <Trans>It opens in your browser.</Trans>
            </Show>
          </Text>
          <Show when={stats()}>
            {(value) => <Text class="label">{claimedLine(value())}</Text>}
          </Show>
        </Column>
      </Show>
    );
  }

  return (
    <Column gap="lg">
      <Text class="label">
        <Trans>
          Ciphers are the founding backers of Protected servers and channels.
          Each Cipher gets a numbered badge and Prot to spend when Protected
          launches.
        </Trans>
      </Text>

      <Status role="status" aria-live="polite">
        <Show when={returned === "cancel"}>
          <CategoryButton icon={<Symbol size={22}>info</Symbol>}>
            <Trans>Checkout canceled. You weren't charged.</Trans>
          </CategoryButton>
        </Show>
        <Switch>
          <Match when={announcePoll() && standing().poll === "polling"}>
            <CategoryButton
              icon={<Symbol size={22}>hourglass_top</Symbol>}
              description={<Trans>This usually takes a few seconds.</Trans>}
            >
              <Trans>Confirming your payment…</Trans>
            </CategoryButton>
          </Match>
          <Match when={newMembership()}>
            {(membership) => (
              <CategoryButton icon={<Symbol size={22}>celebration</Symbol>}>
                {thanks(membership().number)}
              </CategoryButton>
            )}
          </Match>
          <Match when={announcePoll() && standing().poll === "timedOut"}>
            <CategoryButton
              icon={<Symbol size={22}>schedule</Symbol>}
              description={
                <Trans>
                  If you finished checking out, it can take a few minutes to
                  show up here.
                </Trans>
              }
              action={
                <Button
                  size="sm"
                  onPress={() => startPoll(storedIntent()?.tier, true)}
                >
                  <Trans>Check again</Trans>
                </Button>
              }
            >
              <Trans>We haven't seen your payment yet</Trans>
            </CategoryButton>
          </Match>
        </Switch>
      </Status>

      <Switch fallback={<CircularProgress />}>
        {/* Data first: a failed refresh keeps the last standing */}
        <Match when={standing().me}>
          {(me) => (
            <Column gap="lg">
              <Show when={me().membership}>
                {(membership) => (
                  <CategoryButton.Group>
                    <CategoryButton
                      icon={<Symbol size={22}>workspace_premium</Symbol>}
                      description={
                        <>
                          {tierName(membership().tier)}
                          {" · "}
                          {protLine(membership().prot_grant)}
                        </>
                      }
                    >
                      {cipherName(membership().number)}
                    </CategoryButton>
                    <Show when={membership().disputed}>
                      <CategoryButton
                        icon={<Symbol size={22}>gpp_maybe</Symbol>}
                        description={
                          <Trans>
                            Your badge is hidden and upgrades are paused until
                            the review is over.
                          </Trans>
                        }
                      >
                        <Trans>Your payment is under review</Trans>
                      </CategoryButton>
                    </Show>
                  </CategoryButton.Group>
                )}
              </Show>

              <Show when={livePending(me(), clock())}>
                {(pending) => (
                  <CategoryButton
                    icon={<Symbol size={22}>shopping_cart_checkout</Symbol>}
                    description={
                      <Show
                        when={openedUrl()}
                        fallback={expiresAt(pending().expires_at)}
                      >
                        <Trans>
                          Finish paying in your browser. This page updates when
                          you come back.
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
                    {checkoutOpen(skuTier(pending().sku))}
                  </CategoryButton>
                )}
              </Show>

              <Offers me={me()} />
            </Column>
          )}
        </Match>
        <Match when={standing().error}>
          <Column>
            <Text class="label">{describe(standing().error)}</Text>
            <Row>
              <Button
                size="sm"
                isDisabled={standing().loading}
                onPress={() => controller.refresh()}
              >
                <Trans>Try again</Trans>
              </Button>
            </Row>
          </Column>
        </Match>
      </Switch>

      <Row>
        <Button
          variant="text"
          onPress={() =>
            window.open(cipherPromoUrl(i18n.locale), "_blank", "noopener")
          }
        >
          <Trans>About Ciphers</Trans>
        </Button>
      </Row>
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

const OfferGrid = styled("div", {
  base: {
    display: "grid",
    gap: "var(--gap-md)",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  },
});

const OfferCard = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    outline: "2px solid transparent",
    outlineOffset: "-2px",
    transition: "outline-color 0.2s ease",
    "&[data-selected]": {
      outlineColor: "var(--md-sys-color-primary)",
    },
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
    },
  },
});

const CardAction = styled("div", {
  base: {
    display: "grid",
    marginTop: "auto",
    paddingTop: "var(--gap-sm)",
  },
});

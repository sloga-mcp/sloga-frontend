import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { i18n } from "@lingui/core";
import type { Channel, Client } from "stoat.js";
import { styled } from "styled-system/jsx";

import type { CipherApi } from "@revolt/app/interface/settings/user/cipherCheckout";
import {
  formatLedgerTime,
  parseProtFeature,
} from "@revolt/app/interface/settings/user/protWallet";
import { useClient } from "@revolt/client";
import { allowsProtSpending } from "@revolt/client/distribution";
import {
  type ProtTankBannerKind,
  type ProtTankStage,
  type ProtTankSummary,
  fetchProtTank,
  parseProtTankFeature,
  tankBannerKind,
  tankDaysLeft,
} from "@revolt/client/protTank";
import CONFIGURATION from "@revolt/common/lib/env";
import { useModals } from "@revolt/modal";
import { Button } from "@revolt/ui/components/design/Button";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/** How often a mounted banner reads the tank again (contracts 16.3) */
const PROT_BANNER_POLL_MS = 5 * 60 * 1000;

/**
 * Stages that take a top-up (the server's `takes_top_ups`). Settling is
 * left out on purpose: the server refuses a top-up while a tank is closing,
 * so the banner neither offers nor mentions one then.
 */
const TOP_UP_STAGES: ReadonlySet<ProtTankStage> = new Set<ProtTankStage>([
  "Active",
  "Grace",
  "Frozen",
]);

/**
 * Headers for a request as the session user (as on the Prot settings page):
 * the `/prot` routes are newer than the generated stoat-api schema.
 */
function jsonHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token, "Content-Type": "application/json" };
}

/** What this banner's last successful read said about a channel's tank */
type BannerRead = {
  channelId: string;
  tankId: string;
  canContribute: boolean;
};

type BannerTone = "warn" | "stop";

function bannerTone(kind: ProtTankBannerKind): BannerTone {
  switch (kind) {
    case "grace":
    case "low":
      return "warn";
    case "frozen":
    case "deleted":
      return "stop";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function bannerIcon(kind: ProtTankBannerKind, stage: ProtTankStage): string {
  switch (kind) {
    case "grace":
      return "hourglass_bottom";
    case "low":
      return "hourglass_top";
    case "frozen":
      return stage === "Settling" ? "pending" : "ac_unit";
    case "deleted":
      return stage === "Terminated" ? "block" : "delete_forever";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * The fuel tank banner of a Protected text channel (S5b, contracts 16.3):
 * Grace, Frozen (and Settling, a channel that is closing), Deleted (and
 * Terminated), and Low (Active with a week or less left). It shows in every
 * build; only its "Top up" button is behind `allowsProtSpending()` (D5).
 *
 * The banner draws from `client.protTanks`, the store that `ProtTankUpdate`
 * events and every REST read write through `client.setProtTank`. It reads
 * `GET /prot/channels/<id>/tank` when it mounts or the channel changes, on
 * every `ProtTankUpdate` for the channel, whenever the websocket is ready
 * again, and every 5 minutes while mounted. `NotFound` means the channel has
 * no tank: the stored tank is dropped, nothing is shown, and the 5-minute
 * poll stops until a `ProtTankUpdate` for the channel (or a later read that
 * finds a tank) says otherwise. Any other failure keeps whatever the store
 * holds; it never reads as "no tank".
 *
 * Every figure and date is the server's. The future "may be deleted after"
 * line (Frozen) appears only when the server sent `deletes_at` and the root
 * advert's `deletion_enabled` is on. Deleted and Terminated say "was deleted"
 * whatever the advert says: both stages mean the content was purged.
 */
export function ProtBanner(props: { channel: Channel }) {
  const { t } = useLingui();
  const client = useClient();
  const { openModal } = useModals();

  const api: CipherApi = {
    fetch: (url, init) => fetch(url, init),
    apiBase: CONFIGURATION.DEFAULT_API_URL,
    headers: () => jsonHeaders(client()),
  };

  // The upstream stoat-api config type has no `prot`
  const protAdvert = () =>
    (client().configuration?.features as { prot?: unknown } | undefined)?.prot;
  const protEnabled = createMemo(() => parseProtFeature(protAdvert()).enabled);
  const tankRules = createMemo(() => {
    const advert = protAdvert();
    return parseProtTankFeature(
      typeof advert === "object" && advert !== null
        ? (advert as { tank?: unknown }).tank
        : undefined,
    );
  });
  const deletionEnabled = () => tankRules().deletion_enabled === true;

  const [now, setNow] = createSignal(Date.now());
  const [lastRead, setLastRead] = createSignal<BannerRead>();
  // The channel whose last answer was NotFound; its 5-minute poll is off
  const [noTankFor, setNoTankFor] = createSignal<string>();

  // One read at a time; a trigger during a read asks for one more after it
  // (that one reads whichever channel is shown by then)
  let unmounted = false;
  let inFlight = false;
  let again = false;
  onCleanup(() => {
    unmounted = true;
  });

  async function refresh() {
    if (unmounted) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const id = props.channel.id;
    setNow(Date.now());
    try {
      const view = await fetchProtTank(api, id);
      if (unmounted) return;
      if (view) {
        client().setProtTank(id, view.tank);
        setLastRead({
          channelId: id,
          tankId: view.tank.tank_id,
          canContribute: view.can_contribute === true,
        });
        if (noTankFor() === id) setNoTankFor(undefined);
      } else {
        // NotFound: the channel has no tank (BR3)
        client().setProtTank(id, undefined);
        setLastRead(undefined);
        setNoTankFor(id);
      }
    } catch {
      // A failed read is not "no tank": the store keeps the tank it holds
      // (and the shield with it); the next trigger or poll reads again. The
      // tank panel ("View") is where a read failure is shown.
    } finally {
      inFlight = false;
      if (again && !unmounted) {
        again = false;
        void refresh();
      }
    }
  }

  // On mount, and again whenever the page switches to another channel
  createEffect(
    on(
      () => props.channel.id,
      () => void refresh(),
    ),
  );

  // Tank updates for this channel, and a websocket that is ready again
  // (events may have been missed while it was down)
  createEffect(
    on(client, (current) => {
      const onUpdate = (channelId: string) => {
        if (channelId !== props.channel.id) return;
        // An update for the channel turns the poll back on
        if (noTankFor() === channelId) setNoTankFor(undefined);
        void refresh();
      };
      const onReady = () => void refresh();
      current.on("protTankUpdate", onUpdate);
      current.on("ready", onReady);
      onCleanup(() => {
        current.off("protTankUpdate", onUpdate);
        current.off("ready", onReady);
      });
    }),
  );

  // Every 5 minutes while mounted, except after a NotFound for this channel
  createEffect(() => {
    if (noTankFor() === props.channel.id) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, PROT_BANNER_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const summary = (): ProtTankSummary | undefined =>
    client().protTanks.get(props.channel.id);

  /** The banner to show, with the tank it is about; none without a tank */
  const banner = createMemo(() => {
    const tank = summary();
    const kind = tankBannerKind(tank, now());
    return tank && kind ? { kind, tank } : undefined;
  });

  /**
   * "Top up" is offered only in builds that allow spending Prot (D5), while
   * Prot is on and the advert has a minimum contribution, for a stage that
   * takes top-ups (never Settling), and when this banner's last read of the
   * same tank said the caller may contribute now. The server decides anyway.
   */
  const topUpOffered = () => {
    const tank = summary();
    const read = lastRead();
    return (
      allowsProtSpending() &&
      protEnabled() &&
      tankRules().min_contribution > 0 &&
      tank !== undefined &&
      TOP_UP_STAGES.has(tank.stage) &&
      read !== undefined &&
      read.channelId === props.channel.id &&
      read.tankId === tank.tank_id &&
      read.canContribute
    );
  };

  /**
   * The banner's only `prot_contribute` open site. Store builds never reach
   * it (D5, S6 pin): the button is behind `topUpOffered()`, and this checks
   * `allowsProtSpending()` again.
   */
  function openTopUp() {
    if (!allowsProtSpending()) return;
    openModal({
      type: "prot_contribute",
      target: { kind: "tank", channel: props.channel },
      onDone: () => void refresh(),
    });
  }

  function openTank() {
    openModal({ type: "prot_tank", channel: props.channel });
  }

  // In the app locale, as on the tank panel
  function when(ms: number) {
    return formatLedgerTime(ms, i18n.locale);
  }

  function graceCopy(tank: ProtTankSummary): string {
    if (tank.grace_ends_at === undefined) {
      // The server always sends the date in Grace; without it, promise none
      return t`Grace period: new members can't be added until it's topped up.`;
    }
    const date = when(tank.grace_ends_at);
    return t`This Protected channel has run out of Prot. It keeps working until ${date}, but new members can't be added. Top it up to keep it active.`;
  }

  function frozenCopy(tank: ProtTankSummary): string {
    // Settling: closing, and the server refuses top-ups (no top-up wording)
    if (tank.stage === "Settling") {
      return t`This Protected channel is closing.`;
    }
    const frozen = t`This Protected channel is frozen. You can read its history, but nothing can be sent until it's topped up.`;
    // A deletion date only when the server sent one (NIT 32: it does so only
    // while deletion is on) and the advert says deletion is on
    if (tank.deletes_at === undefined || !deletionEnabled()) return frozen;
    const date = when(tank.deletes_at);
    const deletion = t`It may be deleted from Sloga's servers after ${date}.`;
    return `${frozen} ${deletion}`;
  }

  /**
   * Deleted and Terminated always mean the content was purged (termination
   * always purges; an expiry deletion only runs while deletion is on), so
   * this past-tense copy does not depend on the advert's `deletion_enabled`.
   */
  function deletedCopy(tank: ProtTankSummary): string {
    // Terminated: ended by Sloga, not by running out of Prot
    if (tank.stage === "Terminated") {
      return t`This Protected channel was deleted from Sloga's servers.`;
    }
    return t`This Protected channel was deleted from Sloga's servers because it ran out of Prot.`;
  }

  function lowCopy(tank: ProtTankSummary): string {
    const days = tankDaysLeft(tank, now()) ?? 0;
    return t`This Protected channel has about ${days} days of Prot left.`;
  }

  return (
    <Show when={banner()}>
      {(shown) => (
        <BannerBase
          tone={bannerTone(shown().kind)}
          role="status"
          aria-live="polite"
        >
          <BannerIcon>
            <Symbol size={20}>
              {bannerIcon(shown().kind, shown().tank.stage)}
            </Symbol>
          </BannerIcon>
          <BannerText>
            <Switch>
              <Match when={shown().kind === "grace"}>
                {graceCopy(shown().tank)}
              </Match>
              <Match when={shown().kind === "frozen"}>
                {frozenCopy(shown().tank)}
              </Match>
              <Match when={shown().kind === "deleted"}>
                {deletedCopy(shown().tank)}
              </Match>
              <Match when={shown().kind === "low"}>
                {lowCopy(shown().tank)}
              </Match>
            </Switch>
          </BannerText>
          <BannerActions>
            <Show when={topUpOffered()}>
              <Button size="sm" onPress={openTopUp}>
                <Trans>Top up</Trans>
              </Button>
            </Show>
            <Button size="sm" variant="text" onPress={openTank}>
              <Trans>View</Trans>
            </Button>
          </BannerActions>
        </BannerBase>
      )}
    </Show>
  );
}

/**
 * Banner row above the message list
 */
const BannerBase = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    flexShrink: 0,
    gap: "var(--gap-md)",
    rowGap: "var(--gap-sm)",
    marginBlockStart: "var(--gap-md)",
    paddingInline: "var(--gap-lg)",
    paddingBlock: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-lg)",
  },
  variants: {
    tone: {
      warn: {
        color: "var(--md-sys-color-on-tertiary-container)",
        background: "var(--md-sys-color-tertiary-container)",
      },
      stop: {
        color: "var(--md-sys-color-on-error-container)",
        background: "var(--md-sys-color-error-container)",
      },
    },
  },
  defaultVariants: {
    tone: "warn",
  },
});

/**
 * Stage glyph
 */
const BannerIcon = styled("span", {
  base: {
    display: "flex",
    flexShrink: 0,
  },
});

/**
 * Banner copy, taking the room the buttons leave
 */
const BannerText = styled("span", {
  base: {
    flex: "1 1 240px",
    minWidth: 0,
  },
});

/**
 * "Top up" and "View"
 */
const BannerActions = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    gap: "var(--gap-sm)",
  },
});

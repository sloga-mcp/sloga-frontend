import { Match, Show, Suspense, Switch, createMemo } from "solid-js";

import { Plural, Trans, useLingui } from "@lingui-solid/solid/macro";
import { i18n } from "@lingui/core";
import { useNavigate } from "@solidjs/router";
import { useMutation, useQuery } from "@tanstack/solid-query";
import { BiRegularCheckCircle, BiSolidCheckCircle } from "solid-icons/bi";
import { PublicChannelInvite, ServerPublicInvite } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { Avatar, CircularProgress } from "@revolt/ui/components/design";
// The FILE, not the `floating` barrel: the barrel pulls UserCard and so the
// `legacy` barrel into this import cycle, and the built app boots blank
// (`Switch.Override` read before initialization).
import { Tooltip } from "@revolt/ui/components/floating/Tooltip";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  type InviteBadge,
  type InviteSource,
  formatEstablished,
  inviteCardView,
  retryInviteFetch,
} from "./inviteCardModel.ts";

interface Props {
  code: string;
}

/**
 * Server invite card, shown in place of a message that is only an invite link
 */
export function Invite(props: Props) {
  const client = useClient();
  const navigate = useNavigate();
  const { showError } = useModals();

  const query = useQuery(() => ({
    queryKey: ["invite", props.code],
    queryFn: () =>
      client()
        .api.get(`/invites/${props.code as ""}`)
        .then((invite) => PublicChannelInvite.from(client(), invite)),

    retry: retryInviteFetch,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  }));

  // `join()` returns the cached server when the user is already in it, so the
  // same press joins a new server or opens a joined one
  const join = useMutation(() => ({
    mutationFn: () => (query.data as ServerPublicInvite).join(),
    onSuccess(server) {
      navigate(server.path);
    },
    onError: showError,
  }));

  const view = createMemo(() =>
    inviteCardView(
      query.status,
      query.data as InviteSource | undefined,
      (serverId) => !!client().servers?.has(serverId),
    ),
  );

  const server = () => {
    const current = view();
    return current.kind === "server" ? current : undefined;
  };

  return (
    <Base>
      <Suspense fallback={<Loading />}>
        <Switch fallback={<Loading />}>
          <Match when={server()}>
            {(info) => (
              <>
                <Banner>
                  <Show when={info().bannerUrl}>
                    <img src={info().bannerUrl} alt="" draggable={false} />
                  </Show>
                </Banner>
                <Body>
                  <IconRing>
                    <Avatar
                      size={56}
                      shape="rounded-square"
                      src={info().iconUrl}
                      fallback={info().name}
                    />
                  </IconRing>
                  <NameRow>
                    <Name title={info().name}>{info().name}</Name>
                    <Show when={info().badge}>
                      {(badge) => <Badge badge={badge()} />}
                    </Show>
                  </NameRow>
                  <Stats>
                    <Dot />
                    <Plural
                      value={info().memberCount}
                      one="# member"
                      other="# members"
                    />
                  </Stats>
                  <Show when={info().establishedAt}>
                    {(at) => <Established at={at()} />}
                  </Show>
                  <JoinButton
                    type="button"
                    data-joined={info().joined ? "" : undefined}
                    disabled={join.isPending}
                    onClick={() => join.mutate()}
                  >
                    <Show when={info().joined} fallback={<Trans>Join</Trans>}>
                      <Trans>Joined</Trans>
                    </Show>
                  </JoinButton>
                </Body>
              </>
            )}
          </Match>
          <Match when={view().kind === "invalid"}>
            <Banner />
            <Body>
              <IconRing>
                <InvalidIcon>
                  <Symbol size={28}>link_off</Symbol>
                </InvalidIcon>
              </IconRing>
              <NameRow>
                <Name data-invalid="">
                  <Trans>Invalid invite</Trans>
                </Name>
              </NameRow>
              <Stats>
                <Trans>This invite has expired or doesn't exist.</Trans>
              </Stats>
            </Body>
          </Match>
        </Switch>
      </Suspense>
    </Base>
  );
}

/**
 * Official / verified server badge, as the server sidebar draws it
 */
function Badge(props: { badge: InviteBadge }) {
  const { t } = useLingui();

  return (
    <Tooltip
      content={props.badge === "official" ? t`Official Server` : t`Verified`}
      placement="top"
    >
      <BadgeIcon>
        {props.badge === "official" ? (
          <BiSolidCheckCircle size={16} />
        ) : (
          <BiRegularCheckCircle size={16} />
        )}
      </BadgeIcon>
    </Tooltip>
  );
}

/**
 * "Est. Oct 2024", from the server ID's timestamp
 */
function Established(props: { at: number }) {
  const established = () => formatEstablished(props.at, i18n.locale);

  return (
    <EstablishedLine>
      <Trans>Est. {established()}</Trans>
    </EstablishedLine>
  );
}

function Loading() {
  return (
    <LoadingBase>
      <CircularProgress />
    </LoadingBase>
  );
}

// String tags only: `styled(Component, ...)` reads the component at module
// scope, which lands in the import cycle's dead zone and blanks the app.

const Base = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",

    width: "100%",
    maxWidth: "400px",
    overflow: "hidden",
    borderRadius: "var(--borderRadius-lg)",

    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const Banner = styled("div", {
  base: {
    height: "72px",
    flexShrink: 0,
    background:
      "linear-gradient(135deg, var(--md-sys-color-primary-container), var(--md-sys-color-tertiary-container))",

    "& img": {
      display: "block",
      width: "100%",
      height: "100%",
      objectFit: "cover",
    },
  },
});

const Body = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    padding: "0 16px 16px",
  },
});

const IconRing = styled("div", {
  base: {
    marginTop: "-32px",
    padding: "4px",
    borderRadius: "20px",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const InvalidIcon = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",

    width: "56px",
    height: "56px",
    borderRadius: "16px",

    color: "var(--md-sys-color-on-surface-variant)",
    background: "var(--md-sys-color-surface-container-highest)",
  },
});

const NameRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "6px",

    maxWidth: "100%",
    marginTop: "8px",
  },
});

const Name = styled("span", {
  base: {
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",

    fontSize: "16px",
    fontWeight: 600,
    lineHeight: "22px",

    "&[data-invalid]": {
      color: "var(--md-sys-color-error)",
    },
  },
});

const BadgeIcon = styled("span", {
  base: {
    display: "flex",
    flexShrink: 0,
    color: "var(--md-sys-color-primary)",
  },
});

const Stats = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "6px",

    marginTop: "2px",
    fontSize: "13px",
    lineHeight: "18px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Dot = styled("span", {
  base: {
    width: "8px",
    height: "8px",
    flexShrink: 0,
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-on-surface-variant)",
  },
});

const EstablishedLine = styled("div", {
  base: {
    marginTop: "2px",
    fontSize: "12px",
    lineHeight: "16px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const JoinButton = styled("button", {
  base: {
    width: "100%",
    height: "40px",
    marginTop: "12px",
    border: "none",
    borderRadius: "var(--borderRadius-md)",

    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",

    color: "var(--brand-on-success)",
    background: "var(--brand-success)",

    _hover: {
      filter: "brightness(1.08)",
    },

    _disabled: {
      opacity: 0.6,
      cursor: "default",
      filter: "none",
    },

    "&[data-joined]": {
      color: "var(--md-sys-color-on-surface)",
      background: "var(--md-sys-color-surface-container-highest)",
    },
  },
});

const LoadingBase = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "192px",
  },
});

import { Show, createSignal } from "solid-js";

import { ServerMember, User } from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useLingui } from "@lingui-solid/solid/macro";
import { Tooltip } from "@revolt/ui";
import {
  Avatar,
  Ripple,
  UserStatus,
  typography,
  usePresenceText,
} from "../../design";
import { Row } from "../../layout";
import { DisplayName } from "../DisplayName";
import { isSlogaStaff } from "../legacy/Username";

export function ProfileBanner(props: {
  user: User;
  member?: ServerMember;
  bannerUrl?: string;
  onClick?: (e: MouseEvent) => void;
  onClickAvatar?: (e: MouseEvent) => void;
  width: 2 | 3;
}) {
  const { t } = useLingui();
  const presence = usePresenceText();

  const [isCopied, setIsCopied] = createSignal(false);

  function copyUsername() {
    navigator.clipboard.writeText(
      `${props.user.username}#${props.user.discriminator}`,
    );
  }

  function onUsernameClick(e: MouseEvent) {
    e.stopPropagation();
    copyUsername();
    setIsCopied(true);

    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

  return (
    <Banner
      style={{
        "background-image": `linear-gradient(rgba(0, 0, 0, 0.2),rgba(0, 0, 0, 0.7)), url('${props.bannerUrl}')`,
      }}
      isLink={typeof props.onClick !== "undefined"}
      onClick={props.onClick}
      width={props.width}
    >
      <Show when={typeof props.onClick !== "undefined"}>
        <Ripple />
      </Show>

      <Row align gap="lg">
        <Avatar
          src={props.user.animatedAvatarURL}
          size={48}
          holepunch="bottom-right"
          onClick={props.onClickAvatar}
          interactive={props.user.avatar && !!props.onClickAvatar}
          overlay={<UserStatus.Graphic status={props.user.presence} />}
        />
        <UserShort>
          <Show
            when={
              (props.member?.displayName ?? props.user.displayName) !==
              props.user.username
            }
          >
            <span class={css({ fontWeight: 600 })}>
              <DisplayName
                user={props.user}
                member={props.member}
                name={props.member?.displayName ?? props.user.displayName}
                brand={isSlogaStaff(props.user)}
                animate
              />
            </span>
          </Show>
          <Tooltip
            content={isCopied() ? t`Copied!` : t`Click to copy username`}
            placement="top"
          >
            <Username onClick={onUsernameClick}>
              {/* the username carries the style when it is the only name shown */}
              <Show
                when={
                  (props.member?.displayName ?? props.user.displayName) ===
                  props.user.username
                }
                fallback={props.user.username}
              >
                <DisplayName
                  user={props.user}
                  member={props.member}
                  name={props.user.username}
                  brand={isSlogaStaff(props.user)}
                  animate
                />
              </Show>
              <span class={css({ fontWeight: 200 })}>
                #{props.user.discriminator}
              </span>
            </Username>
          </Tooltip>
          <Show when={props.user.pronouns}>
            <Pronouns>{props.user.pronouns}</Pronouns>
          </Show>
          {/* Spelled out here because a dot's hover tooltip never fires on a
              phone, and this card is what a tap on someone opens */}
          <PresenceLine>
            <PresenceName>{presence.label(props.user.presence)}</PresenceName>{" "}
            {presence.description(props.user.presence)}
          </PresenceLine>
        </UserShort>
      </Row>
    </Banner>
  );
}

const Banner = styled("div", {
  base: {
    // for <Ripple />:
    position: "relative",

    userSelect: "none",

    height: "120px",
    padding: "var(--gap-lg)",

    display: "flex",
    flexDirection: "column",
    justifyContent: "end",

    backgroundSize: "cover",
    backgroundPosition: "center",

    borderRadius: "var(--borderRadius-xl)",

    color: "white",
  },
  variants: {
    width: {
      3: {
        gridColumn: "1 / 4",
      },
      2: {
        gridColumn: "1 / 3",
      },
    },
    isLink: {
      true: {
        cursor: "pointer",
      },
    },
  },
});

const UserShort = styled("div", {
  base: {
    ...typography.raw(),

    display: "flex",
    lineHeight: "1em",
    gap: "var(--gap-xs)",
    flexDirection: "column",
  },
});

const Username = styled("span", {
  base: {
    _hover: {
      textDecoration: "underline",
    },
  },
});

const Pronouns = styled("span", {
  base: {
    fontSize: "0.75rem",
    fontWeight: 400,
    opacity: 0.8,
  },
});

const PresenceLine = styled("span", {
  base: {
    fontSize: "0.75rem",
    fontWeight: 400,
    lineHeight: "1.2em",
    opacity: 0.8,
    // The banner is a fixed 120px; a long meaning must not push the name
    // out of its top
    lineClamp: 2,
  },
});

const PresenceName = styled("span", {
  base: {
    fontWeight: 600,
  },
});

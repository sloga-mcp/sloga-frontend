import {
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { User, UserBadges } from "stoat.js";
import { cva, cx } from "styled-system/css";
import { styled } from "styled-system/jsx";

import badgeActiveSupporter from "../../../../../scripts/assets_fallback/badges/active_supporter.svg";
import badgeJoke1 from "../../../../../scripts/assets_fallback/badges/amog.svg";
import badgeJoke2 from "../../../../../scripts/assets_fallback/badges/amorbus.svg";
import badgeDeveloper from "../../../../../scripts/assets_fallback/badges/developer.svg";
import badgeDisclosure from "../../../../../scripts/assets_fallback/badges/disclosure.svg";
import badgeEarlyAdopter from "../../../../../scripts/assets_fallback/badges/early_adopter.svg";
import badgeFounder from "../../../../../scripts/assets_fallback/badges/founder.svg";
import badgeFoundingStreamer from "../../../../../scripts/assets_fallback/badges/founding_streamer.svg";
import badgeModeration from "../../../../../scripts/assets_fallback/badges/moderation.svg";
import badgePatron from "../../../../../scripts/assets_fallback/badges/patron.svg";
import badgePaw from "../../../../../scripts/assets_fallback/badges/paw.svg";
import badgeRecruiter from "../../../../../scripts/assets_fallback/badges/recruiter.svg";
import badgeRecruiterElite from "../../../../../scripts/assets_fallback/badges/recruiter_elite.svg";
import badgeSupporter from "../../../../../scripts/assets_fallback/badges/supporter.svg";
import badgeTranslator from "../../../../../scripts/assets_fallback/badges/translator.svg";
import badgeWelcomed from "../../../../../scripts/assets_fallback/badges/welcomed.svg";
import { Text, typography } from "../../design";

import { ProfileCard } from "./ProfileCard";
import {
  CIPHER_BADGE_OPEN_CLASS,
  CIPHER_BADGE_SHACKLE_CLASS,
  CIPHER_BADGE_SHINE_CLASS,
  CIPHER_DECRYPT_EVERY_MS,
  CIPHER_DECRYPT_MS,
  cipherBadgeLabel,
  cipherScrambleFrame,
  ensureCipherBadgeSheet,
  formatCipherNumber,
  isAnimatedCipherTier,
  readUserCipher,
} from "./cipherBadge";

export function ProfileBadges(props: { user: User }) {
  const { t } = useLingui();

  // Display only: the server assigns the membership and strips it from user
  // edits, so this never decides anything.
  const cipher = () => readUserCipher(props.user);
  const cipherAnimated = () => {
    const current = cipher();
    return !!current && isAnimatedCipherTier(current.tier);
  };

  createEffect(() => {
    if (cipherAnimated()) ensureCipherBadgeSheet();
  });

  function cipherTooltip(cipherNumber: number) {
    const number = formatCipherNumber(cipherNumber);
    return t`Cipher founding supporter #${number}`;
  }

  return (
    <Show when={props.user.badges || props.user.customBadge || cipher()}>
      <ProfileCard>
        <Text class="title" size="large">
          <Trans>Badges</Trans>
        </Text>

        <BadgeRow>
          <Show when={props.user.customBadge}>
            {(badge) => (
              <img
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: badge().label,
                  },
                }}
                src={badge().image.createFileURL()}
                alt=""
              />
            )}
          </Show>
          <Show when={props.user.badges & UserBadges.Founder}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Founder`,
                },
              }}
              src={badgeFounder}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Developer}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Developer`,
                },
              }}
              src={badgeDeveloper}
            />
          </Show>
          <Show when={cipher()}>
            {(current) => (
              <span
                role="img"
                aria-label={cipherTooltip(current().number)}
                class={cx(
                  cipherBadge({ featured: cipherAnimated() }),
                  cipherAnimated() && CIPHER_BADGE_SHINE_CLASS,
                )}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: cipherTooltip(current().number),
                  },
                }}
              >
                <Show
                  when={cipherAnimated()}
                  fallback={cipherBadgeLabel(current().number)}
                >
                  <CipherDecryptLabel number={current().number} />
                </Show>
              </span>
            )}
          </Show>
          <Show when={props.user.badges & UserBadges.Supporter}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Donated to Sloga`,
                },
              }}
              src={badgeSupporter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.ActiveSupporter}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Active Sloga supporter`,
                },
              }}
              src={badgeActiveSupporter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Patron}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Patron`,
                },
              }}
              src={badgePatron}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Translator}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Helped translate Sloga`,
                },
              }}
              src={badgeTranslator}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.EarlyAdopter}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`One of the first 1000 users!`,
                },
              }}
              src={badgeEarlyAdopter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.FoundingStreamer}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Founding Streamer`,
                },
              }}
              src={badgeFoundingStreamer}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Welcomed}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Joined Sloga through a friend`,
                },
              }}
              src={badgeWelcomed}
            />
          </Show>
          {/* Both bits are set at the elite tier; show only the higher one. */}
          <Show
            when={
              props.user.badges & UserBadges.Recruiter &&
              !(props.user.badges & UserBadges.RecruiterElite)
            }
          >
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Invited a friend to Sloga`,
                },
              }}
              src={badgeRecruiter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.RecruiterElite}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Invited 5 friends to Sloga`,
                },
              }}
              src={badgeRecruiterElite}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.PlatformModeration}>
            <span
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Moderator`,
                },
              }}
            >
              <img src={badgeModeration} />
            </span>
          </Show>
          <Show when={props.user.badges & UserBadges.ResponsibleDisclosure}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Responsibly disclosed security issues`,
                },
              }}
              src={badgeDisclosure}
            />
          </Show>
          <Show
            when={props.user.badges & UserBadges.ReservedRelevantJokeBadge1}
          >
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`irrelevant joke badge 1`,
                },
              }}
              src={badgeJoke1}
            />
          </Show>
          <Show
            when={props.user.badges & UserBadges.ReservedRelevantJokeBadge2}
          >
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`irrelevant joke badge 2`,
                },
              }}
              src={badgeJoke2}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Paw}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: "🦊",
                },
              }}
              src={badgePaw}
            />
          </Show>
        </BadgeRow>
      </ProfileCard>
    </Show>
  );
}

const BadgeRow = styled("div", {
  base: {
    gap: "var(--gap-md)",
    display: "flex",
    flexWrap: "wrap",

    "& img, & svg": {
      width: "24px",
      height: "24px",
      aspectRatio: "1/1",
      objectFit: "contain",
    },
  },
});

/**
 * The top tier's lock and label. The label starts as scrambled symbols and
 * decrypts left to right; the lock opens once it reads in full. It runs when
 * the badge appears, again every CIPHER_DECRYPT_EVERY_MS while the page is
 * visible, and on hover. Under reduced motion it shows the plain label with
 * the lock open. The real label sits underneath, hidden, to hold the width so
 * the badge never jumps; the parent's aria-label is what screen readers read.
 */
function CipherDecryptLabel(props: { number: number }) {
  const target = () => cipherBadgeLabel(props.number);
  const [text, setText] = createSignal(target());
  const [locked, setLocked] = createSignal(false);

  const reducedMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function decrypt() {
    if (reducedMotion || frame) return;
    const goal = target();
    const start = performance.now();
    setLocked(true);

    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / CIPHER_DECRYPT_MS);
      const revealed = Math.floor(progress * (goal.length + 1));
      if (progress < 1) {
        setText(cipherScrambleFrame(goal, revealed, Math.random));
        frame = requestAnimationFrame(step);
      } else {
        frame = 0;
        setText(target());
        setLocked(false);
      }
    };
    frame = requestAnimationFrame(step);
  }

  onMount(() => {
    decrypt();
    timer = setInterval(() => {
      if (!document.hidden) decrypt();
    }, CIPHER_DECRYPT_EVERY_MS);
  });

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
    if (timer) clearInterval(timer);
  });

  // A new number while idle shows at once; mid-decrypt the last frame does it
  createEffect(
    on(
      target,
      (goal) => {
        if (!frame) setText(goal);
      },
      { defer: true },
    ),
  );

  return (
    <span
      onPointerEnter={decrypt}
      style={{ display: "inline-flex", "align-items": "center", gap: "5px" }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        aria-hidden="true"
        class={locked() ? undefined : CIPHER_BADGE_OPEN_CLASS}
        style={{ "flex-shrink": 0, overflow: "visible" }}
      >
        <path
          class={CIPHER_BADGE_SHACKLE_CLASS}
          d="M5 7V5.2a3 3 0 0 1 6 0V7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
        <rect
          x="3.2"
          y="6.8"
          width="9.6"
          height="7.4"
          rx="1.8"
          fill="currentColor"
        />
        <circle cx="8" cy="10.3" r="1.1" fill="#ffd08a" />
      </svg>
      <span
        style={{
          position: "relative",
          display: "inline-block",
          overflow: "hidden",
        }}
      >
        <span style={{ visibility: "hidden" }}>{target()}</span>
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            "white-space": "nowrap",
          }}
        >
          {text()}
        </span>
      </span>
    </span>
  );
}

/**
 * Text pill sized to sit in line with the 24px icon badges. The animated
 * tier's shine comes from CIPHER_BADGE_SHINE_CLASS (see cipherBadge.ts).
 */
const cipherBadge = cva({
  base: {
    ...typography.raw({ class: "label", size: "small" }),
    display: "inline-flex",
    alignItems: "center",
    height: "24px",
    paddingInline: "8px",
    borderRadius: "var(--borderRadius-full)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    backgroundColor: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  variants: {
    featured: {
      true: {
        borderColor: "var(--md-sys-color-primary)",
        backgroundColor: "var(--md-sys-color-primary-container)",
        color: "var(--md-sys-color-on-primary-container)",
      },
      false: {},
    },
  },
});

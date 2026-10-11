import HCaptcha, { HCaptchaFunctions } from "solid-hcaptcha";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  JSX,
  onCleanup,
  Show,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { appOrigin, CONFIGURATION, isNativeShell } from "@revolt/common";
import { useError } from "@revolt/i18n";
import {
  Button,
  Checkbox,
  Column,
  iconSize,
  Text,
  TextField,
} from "@revolt/ui";
import { styled } from "styled-system/jsx";

import MdError from "@material-design-icons/svg/filled/error.svg?component-solid";

import { type ServerCaptcha, getServerCaptcha } from "./captchaConfig";
import { decideCaptcha } from "./captchaDecision";

/**
 * How long a captcha-capable form waits for the server's captcha setting
 * before treating captcha as off (the server still refuses a request it
 * wanted a captcha for)
 */
const CAPTCHA_CONFIG_TIMEOUT_MS = 5000;

/**
 * How long a submit waits for the hCaptcha widget's script (loaded from
 * hcaptcha.com) when it is pressed before the widget has finished loading
 */
const CAPTCHA_WIDGET_TIMEOUT_MS = 8000;

const ErrorContainer = styled("span", {
  base: {
    color: "var(--md-sys-color-error)",
    display: "flex",
    alignItems: "center",
    gap: "0.25em",
  },
});

/**
 * Live countdown until a timed suspension lifts
 */
function SuspensionCountdown(props: { until: string }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  const remainingMs = () => new Date(props.until).getTime() - now();

  const formatted = () => {
    const total = Math.floor(remainingMs() / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  };

  return (
    <Show
      when={remainingMs() > 0}
      fallback={
        <Trans>Your suspension has expired — try logging in again.</Trans>
      }
    >
      <Trans>This account is suspended. Time remaining: {formatted()}</Trans>
    </Show>
  );
}

/**
 * If this error is a timed suspension, return its expiry timestamp
 */
function suspendedUntil(error: unknown): string | undefined {
  const err = error as { type?: string; suspended_until?: string } | undefined;
  return err?.type === "AccountDisabled" ? err.suspended_until : undefined;
}

/**
 * Available field types
 */
type Field =
  | "email"
  | "password"
  | "new-password"
  | "log-out"
  | "username"
  | "invite"
  | "referral_code";

/**
 * Properties to apply to fields
 */
const useFieldConfiguration = () => {
  const { t } = useLingui();

  return {
    email: {
      type: "email" as const,
      name: () => t`Email`,
      placeholder: () => t`Please enter your email.`,
      autocomplete: "email",
    },
    password: {
      minLength: 8,
      type: "password" as const,
      "toggle-password": true,
      showPasswordIcon: "visibility",
      hidePasswordIcon: "visibility_off",
      name: () => t`Password`,
      placeholder: () => t`Enter your current password.`,
    },
    "new-password": {
      minLength: 8,
      type: "password" as const,
      autocomplete: "new-password",
      "toggle-password": true,
      showPasswordIcon: "visibility",
      hidePasswordIcon: "visibility_off",
      name: () => t`New Password`,
      placeholder: () => t`Enter a new password.`,
    },
    "log-out": {
      name: () => t`Log out of all other sessions`,
    },
    username: {
      minLength: 2,
      type: "text" as const,
      autocomplete: "none",
      name: () => t`Username`,
      placeholder: () => t`Enter your preferred username.`,
    },
    invite: {
      minLength: 1,
      type: "text" as const,
      autocomplete: "none",
      name: () => t`Invite Code`,
      placeholder: () => t`Enter your invite code.`,
    },
    // Optional, so it must never block signup: `Fields` spreads this config
    // after its default `required`, and `required: false` reaches the input
    referral_code: {
      maxLength: 32,
      type: "text" as const,
      autocomplete: "off",
      required: false,
      name: () => t`Referral code (optional)`,
      placeholder: () => t`e.g. SLOGA-KX7P`,
    },
  };
};

interface FieldProps {
  /**
   * Fields to gather
   */
  fields: (Field | FieldPreset)[];
}

interface FieldPreset {
  field: Field;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any;
  disabled?: boolean;
}

/**
 * Render a bunch of fields with preset values
 */
export function Fields(props: FieldProps) {
  const fieldConfiguration = useFieldConfiguration();

  return (
    <For each={props.fields}>
      {(field) => {
        // If field is just a Field value, convert it to a FieldPreset
        if (typeof field === "string") {
          field = { field: field };
        }
        return (
          <label>
            {field.field === "log-out" ? (
              <Checkbox name={field.field}>
                {fieldConfiguration[field.field].name()}
              </Checkbox>
            ) : (
              <TextField
                required
                {...fieldConfiguration[field.field]}
                name={field.field}
                label={fieldConfiguration[field.field].name()}
                placeholder={fieldConfiguration[field.field].placeholder()}
                disabled={field.disabled}
                value={field.value}
              />
            )}
          </label>
        );
      }}
    </For>
  );
}

interface Props {
  /**
   * Form children
   */
  children: JSX.Element;

  /**
   * Build-time hCaptcha sitekey, used only when the server does not ask for
   * a captcha. Passing it at all (even empty) makes the form captcha-capable.
   */
  captcha?: string;

  /**
   * App path (e.g. `/login/create`) that a native shell opens in the system
   * browser, instead of showing the form, when the server wants a captcha.
   * Also makes the form captcha-capable.
   */
  handoffPath?: string;

  /**
   * Submission handler
   */
  onSubmit: (data: FormData) => Promise<void> | void;
}

/**
 * Replaces a captcha-capable form in a native shell when the server wants a
 * captcha: the shell never loads hCaptcha, so the step continues in the
 * system browser
 */
function BrowserHandoff(props: { href: string }) {
  return (
    <Column gap="lg">
      <Text class="body" size="medium">
        <Trans>To keep spam out, this step opens in your web browser.</Trans>
      </Text>
      <a href={props.href} target="_blank" rel="noreferrer">
        <Button>
          <Trans>Continue in your browser</Trans>
        </Button>
      </a>
    </Column>
  );
}

/**
 * Small wrapper for HTML form
 */
export function Form(props: Props) {
  const { t } = useLingui();
  const [error, setError] = createSignal();
  const err = useError();
  let hcaptcha: HCaptchaFunctions | undefined;

  // Read once: the shell cannot change under a mounted form
  const native = isNativeShell();

  /**
   * Whether this form may need a captcha at all. Other forms (e.g. login)
   * never ask the server and behave exactly as before.
   */
  const captchaCapable = () =>
    props.captcha !== undefined || props.handoffPath !== undefined;

  // The server's captcha setting; `undefined` until it answers or times out
  const [serverCaptcha, setServerCaptcha] = createSignal<ServerCaptcha>();
  let serverCaptchaReady: Promise<void> | undefined;
  let serverCaptchaTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    if (!captchaCapable() || serverCaptchaReady) return;

    const timedOut = new Promise<ServerCaptcha>((resolve) => {
      serverCaptchaTimer = setTimeout(
        () => resolve({ enabled: false }),
        CAPTCHA_CONFIG_TIMEOUT_MS,
      );
    });

    // `getServerCaptcha` never rejects, and neither does the timeout
    serverCaptchaReady = Promise.race([
      getServerCaptcha(CONFIGURATION.DEFAULT_API_URL),
      timedOut,
    ]).then((server) => {
      clearTimeout(serverCaptchaTimer);
      setServerCaptcha(server);
    });
  });

  onCleanup(() => clearTimeout(serverCaptchaTimer));

  const captcha = createMemo(() =>
    decideCaptcha({
      native,
      server: captchaCapable() ? serverCaptcha() : { enabled: false },
      buildTimeKey: props.captcha,
      handoffPath: props.handoffPath,
    }),
  );

  /**
   * Browser handoff link, when the form is replaced by one
   */
  const handoffHref = () => {
    const decision = captcha();
    return decision.kind === "handoff"
      ? appOrigin() + decision.path
      : undefined;
  };

  /**
   * Sitekey for the invisible widget, when one is mounted
   */
  const widgetSitekey = () => {
    const decision = captcha();
    return decision.kind === "widget" ? decision.sitekey : undefined;
  };

  /**
   * Error shown whenever a required captcha cannot be completed
   */
  const captchaError = () =>
    new Error(
      t`Couldn't load the captcha. Check your connection and try again.`,
    );

  let awaitingCaptchaConfig = false;

  // Resolves once the mounted widget has loaded and rendered; replaced
  // whenever the widget unmounts, so a remount is waited for afresh
  let widgetLoaded!: Promise<void>;
  let markWidgetLoaded!: () => void;
  const resetWidgetLoaded = () => {
    widgetLoaded = new Promise<void>((resolve) => (markWidgetLoaded = resolve));
  };
  resetWidgetLoaded();

  let awaitingWidget = false;
  let widgetWaitTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(widgetWaitTimer));

  /**
   * Wait for the widget to load, giving up after CAPTCHA_WIDGET_TIMEOUT_MS
   */
  async function waitForWidget() {
    try {
      await Promise.race([
        widgetLoaded,
        new Promise<void>((resolve) => {
          widgetWaitTimer = setTimeout(resolve, CAPTCHA_WIDGET_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(widgetWaitTimer);
    }
  }

  /**
   * Handle submission
   * @param event Form Event
   */
  async function onSubmit(event: Event) {
    event.preventDefault();

    // Read the fields first: `currentTarget` is gone after the first await
    const formData = new FormData(event.currentTarget as HTMLFormElement);

    // Never submit before the server says whether it wants a captcha; the
    // lookup gives up after CAPTCHA_CONFIG_TIMEOUT_MS. Repeat presses while
    // waiting are dropped.
    if (captcha().kind === "loading") {
      if (awaitingCaptchaConfig) return;
      awaitingCaptchaConfig = true;
      try {
        await serverCaptchaReady;
      } finally {
        awaitingCaptchaConfig = false;
      }
    }

    const decision = captcha();

    // The form has been replaced by the handoff link
    if (decision.kind === "handoff") return;

    // Required but impossible here: never submit without a token
    if (decision.kind === "loading" || decision.kind === "unavailable") {
      setError(captchaError());
      return;
    }

    if (decision.kind === "widget") {
      // The widget only mounts once the server answers, so a quick first
      // press can beat its script; give it a moment to load. Repeat presses
      // while waiting are dropped.
      if (!hcaptcha) {
        if (awaitingWidget) return;
        awaitingWidget = true;
        try {
          await waitForWidget();
        } finally {
          awaitingWidget = false;
        }
      }

      try {
        if (!hcaptcha) throw new Error("hCaptcha not loaded");
        // Rejects when the challenge is closed, expires or fails
        const response = await hcaptcha.execute();
        if (!response?.response) throw new Error("hCaptcha gave no token");
        formData.set("captcha", response.response);
      } catch (err) {
        console.error(err);
        setError(captchaError());
        return;
      }
    }

    try {
      await props.onSubmit(formData);
    } catch (err) {
      console.error(err);
      setError(err);
      // The token is spent; a retry needs a fresh challenge
      if (formData.has("captcha")) hcaptcha?.resetCaptcha();
    }
  }

  return (
    <Show
      when={!handoffHref()}
      fallback={<BrowserHandoff href={handoffHref()!} />}
    >
      <form onSubmit={onSubmit}>
        <Column gap="lg">
          {props.children}
          <Show when={error()}>
            <ErrorContainer>
              <MdError
                {...iconSize("1rem")}
                fill="currentColor"
                style={{ "flex-shrink": 0 }}
              />
              <Text class="label" size="small">
                <Show when={suspendedUntil(error())} fallback={err(error())}>
                  {(until) => <SuspensionCountdown until={until()} />}
                </Show>
              </Text>
            </ErrorContainer>
          </Show>
        </Column>
        <Show when={widgetSitekey()}>
          {(sitekey) => {
            // A script that loads after an unmount must not revive the
            // removed widget
            let mounted = true;
            onCleanup(() => {
              mounted = false;
              hcaptcha = undefined;
              resetWidgetLoaded();
            });

            return (
              <HCaptcha
                sitekey={sitekey()}
                onLoad={(instance) => {
                  if (!mounted) return;
                  hcaptcha = instance;
                  markWidgetLoaded();
                }}
                size="invisible"
              />
            );
          }}
        </Show>
      </form>
    </Show>
  );
}

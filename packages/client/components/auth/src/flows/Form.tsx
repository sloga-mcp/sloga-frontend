import HCaptcha, { HCaptchaFunctions } from "solid-hcaptcha";
import { createSignal, For, JSX, onCleanup, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useError } from "@revolt/i18n";
import { Checkbox, Column, iconSize, Text, TextField } from "@revolt/ui";
import { styled } from "styled-system/jsx";

import MdError from "@material-design-icons/svg/filled/error.svg?component-solid";

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
      <Trans>
        This account is suspended. Time remaining: {formatted()}
      </Trans>
    </Show>
  );
}

/**
 * If this error is a timed suspension, return its expiry timestamp
 */
function suspendedUntil(error: unknown): string | undefined {
  const err = error as
    | { type?: string; suspended_until?: string }
    | undefined;
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
  | "invite";

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
   * Whether to include captcha token
   */
  captcha?: string;

  /**
   * Submission handler
   */
  onSubmit: (data: FormData) => Promise<void> | void;
}

/**
 * Small wrapper for HTML form
 */
export function Form(props: Props) {
  const [error, setError] = createSignal();
  const err = useError();
  let hcaptcha: HCaptchaFunctions | undefined;

  /**
   * Handle submission
   * @param event Form Event
   */
  async function onSubmit(event: Event) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget as HTMLFormElement);

    if (props.captcha) {
      if (!hcaptcha) return alert("hCaptcha not loaded!");
      const response = await hcaptcha.execute();
      formData.set("captcha", response!.response);
    }

    try {
      await props.onSubmit(formData);
    } catch (err) {
      console.error(err);
      setError(err);
    }
  }

  return (
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
              <Show
                when={suspendedUntil(error())}
                fallback={err(error())}
              >
                {(until) => <SuspensionCountdown until={until()} />}
              </Show>
            </Text>
          </ErrorContainer>
        </Show>
      </Column>
      <Show when={props.captcha}>
        <HCaptcha
          sitekey={props.captcha!}
          onLoad={(instance) => (hcaptcha = instance)}
          size="invisible"
        />
      </Show>
    </form>
  );
}

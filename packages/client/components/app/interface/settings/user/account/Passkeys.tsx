import {
  type JSX,
  For,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import type { MFATicket, PasskeyInfo } from "stoat.js";

import { useClient } from "@revolt/client";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { CONFIGURATION } from "@revolt/common";
import {
  PasskeyError,
  createPasskey,
  defaultPasskeyName,
  getPasskeysAdvert,
  passkeysSupported,
} from "@revolt/common/lib/passkey";
import { useTime } from "@revolt/i18n";
import { useModals } from "@revolt/modal";
import { CategoryButton, iconSize } from "@revolt/ui";

import MdError from "@material-design-icons/svg/outlined/error.svg?component-solid";
import MdFingerprint from "@material-design-icons/svg/outlined/fingerprint.svg?component-solid";
import MdKey from "@material-design-icons/svg/outlined/key.svg?component-solid";

import {
  type PasskeyAction,
  type PasskeyProblem,
  addPasskeyStep,
  mayCreatePasskeyNow,
  passkeyProblem,
} from "./passkeyRules";

/** Something the list tells the user in its own row */
type Notice = PasskeyProblem | "create_failed" | "unavailable" | "start_over";

/** A passkey that is named and confirmed, and only needs its prompt */
interface PendingPasskey {
  name: string;
  /** Absent when the server asked for none */
  ticket?: MFATicket;
}

/**
 * How long the "Create passkey" step is offered. The ticket lasts 5 minutes
 * on the server; the step goes away before a tap could only fail.
 */
const PENDING_PASSKEY_MS = 4 * 60 * 1000;

/**
 * Passkeys of the account. Renders nothing unless the server offers them.
 */
export function Passkeys() {
  // Signals, not resources: a pending resource would suspend the whole page
  const [available, setAvailable] = createSignal(false);

  onMount(() => {
    // Never rejects; a failed lookup reads as not offered
    void getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL).then((advert) =>
      setAvailable(advert.available),
    );
  });

  return (
    <Show when={available()}>
      <PasskeyList />
    </Show>
  );
}

/**
 * List, add, rename and remove passkeys
 */
function PasskeyList() {
  const client = useClient();
  const queryClient = useQueryClient();
  const dayjs = useTime();
  const { t } = useLingui();
  const { openModal, mfaFlow, showError } = useModals();

  // False in the desktop apps: they list, rename and remove, but cannot add.
  // Undefined until the device has answered.
  const [supported, setSupported] = createSignal<boolean>();

  onMount(() => {
    // Never rejects
    void passkeysSupported().then(setSupported);
  });

  // Keyed by user, so the next account never sees this one's passkeys
  const listKey = () => ["passkeys", client().user!.id];

  const list = useQuery(() => ({
    queryKey: listKey(),
    queryFn: () => client().passkeys.list(),
  }));

  // One add, rename or remove at a time
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<Notice>();

  // Set between "Add a passkey" and the tap that opens the prompt
  const [pending, setPending] = createSignal<PendingPasskey>();

  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(pendingTimer));

  /**
   * Offer the "Create passkey" step for a passkey, or stop offering it
   */
  function offerCreate(next?: PendingPasskey) {
    clearTimeout(pendingTimer);
    setPending(next);

    if (next) {
      pendingTimer = setTimeout(
        () => setPending(undefined),
        PENDING_PASSKEY_MS,
      );
    }
  }

  /**
   * Fetch the passkeys and the MFA status again: adding or removing a
   * passkey changes how the account can confirm actions
   */
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: listKey() }),
      queryClient.invalidateQueries({
        queryKey: ["mfa", client().user!.id],
      }),
    ]);
  }

  /**
   * Explain a failed request in a row of the list, or hand anything
   * unexpected to the general error dialog
   */
  function explain(error: unknown, action: PasskeyAction) {
    if (error instanceof PasskeyError) {
      // Closing the prompt needs no explanation
      if (error.code === "cancelled") return;
      setNotice(error.code === "unavailable" ? "unavailable" : "create_failed");
      return;
    }

    const problem = passkeyProblem(apiErrorType(error), action);
    if (problem) {
      setNotice(problem);
    } else {
      showError(error);
    }
  }

  /**
   * Ask for a passkey name
   * @param name Name to start from
   * @param rename Whether an existing passkey is being renamed
   * @returns The trimmed name, or nothing when dismissed
   */
  function askName(name: string, rename?: boolean) {
    return new Promise((callback: (name?: string) => void) =>
      openModal({ type: "passkey_name", name, rename, callback }),
    );
  }

  /**
   * Start adding a passkey. Order matters: the server is asked first
   * whether it wants a ticket (and refuses here, before anything is typed,
   * a session it would not take a passkey from), then the name is settled,
   * then the ticket, because a refused request spends the ticket. The
   * prompt comes last and from a tap of its own (`create`): browsers only
   * open it shortly after one, and the tap on "Add a passkey" is too old
   * by then.
   *
   * The challenge of this first start is not used; `create` asks again.
   */
  async function add() {
    if (busy()) return;

    setBusy(true);
    setNotice(undefined);

    let action: PasskeyAction = "start";

    try {
      const start = await client().passkeys.registerStart();
      action = "add";

      const name = await askName(defaultPasskeyName());
      if (!name) return;

      // No ticket wanted: a first passkey on an account made with Google
      // or Apple, signed in a moment ago. Nothing is asked for.
      let ticket: MFATicket | undefined;
      if (start.ticket_required) {
        const mfa = await client().account.mfa();

        switch (addPasskeyStep(true, mfa.availableMethods.length)) {
          case "confirm":
            ticket = await mfaFlow(mfa);
            if (!ticket) return;
            break;
          case "sign_in_again":
            setNotice("sign_in_again");
            return;
          case "create":
            break;
        }
      }

      offerCreate({ name, ticket });
    } catch (error) {
      explain(error, action);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Create the passkey that `add` prepared. Runs from the tap on "Create
   * passkey", with one request between the tap and the prompt.
   */
  async function create() {
    const passkey = pending();
    if (busy() || !passkey) return;

    setBusy(true);
    setNotice(undefined);

    let action: PasskeyAction = "start";

    try {
      const challenge = await client().passkeys.registerStart();
      action = "add";

      // The server wants a ticket now and none is in hand (the session
      // got too old while this step waited): stop before the device makes
      // a passkey that would not be stored
      if (!mayCreatePasskeyNow(challenge.ticket_required, !!passkey.ticket)) {
        offerCreate(undefined);
        setNotice("start_over");
        return;
      }

      const credential = await createPasskey(challenge.options);

      // The ticket is spent from here on, whatever the answer
      offerCreate(undefined);

      await client().passkeys.registerFinish(
        challenge.challenge_id,
        credential as Record<string, unknown>,
        passkey.name,
        passkey.ticket?.token,
      );

      await refresh();
    } catch (error) {
      explain(error, action);

      // A prompt that was closed, or never appeared, can be tried again
      // with the same ticket; after anything else the step starts over
      if (!(error instanceof PasskeyError && error.code === "cancelled")) {
        offerCreate(undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Rename a passkey
   */
  async function rename(passkey: PasskeyInfo) {
    if (busy()) return;

    setBusy(true);
    setNotice(undefined);

    try {
      const name = await askName(passkey.name, true);
      if (!name || name === passkey.name) return;

      await client().passkeys.rename(passkey.id, name);
      await queryClient.invalidateQueries({ queryKey: listKey() });
    } catch (error) {
      explain(error, "rename");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Remove a passkey: ask first, then confirm it is the account owner.
   * Whether it is the last way to sign in is the server's call (it knows
   * about linked sign-ins this app cannot see); its refusal is explained in
   * the list.
   */
  async function remove(passkey: PasskeyInfo) {
    if (busy()) return;

    setBusy(true);
    setNotice(undefined);

    try {
      const confirmed = await new Promise(
        (callback: (confirmed?: boolean) => void) =>
          openModal({ type: "passkey_remove", name: passkey.name, callback }),
      );
      if (!confirmed) return;

      const ticket = await mfaFlow(await client().account.mfa());
      if (!ticket) return;

      await client().passkeys.remove(passkey.id, ticket.token);
      await refresh();
    } catch (error) {
      explain(error, "remove");
    } finally {
      setBusy(false);
    }
  }

  /**
   * When a passkey was added and last used
   */
  function describe(passkey: PasskeyInfo) {
    const added = dayjs(passkey.created_at).format("LL");
    if (!passkey.last_used_at) return t`Added ${added}, not used yet`;

    const used = dayjs(passkey.last_used_at).fromNow();
    return t`Added ${added}, last used ${used}`;
  }

  /**
   * Words for a notice. No default branch, so a new notice without words
   * fails to compile.
   */
  function noticeText(notice: Notice): JSX.Element {
    switch (notice) {
      case "off":
        return <Trans>Passkeys are turned off right now.</Trans>;
      case "sign_in_again":
        return (
          <Trans>
            To add a passkey, sign out and sign in again, then add it within 10
            minutes.
          </Trans>
        );
      case "after_reset":
        return (
          <Trans>
            Your password was reset. Sign out and sign in again, then add the
            passkey.
          </Trans>
        );
      case "not_accepted":
        // The server gives this answer too when a password reset came in
        // while the passkey was being added
        return (
          <Trans>
            The passkey was not accepted. Try again. If your password was just
            reset, sign out and sign in again first.
          </Trans>
        );
      case "start_over":
        return (
          <Trans>
            That took too long. Select Add a passkey to start again.
          </Trans>
        );
      case "already_added":
        return <Trans>This passkey is already on your account.</Trans>;
      case "limit":
        return (
          <Trans>
            You have 10 passkeys, which is the limit. Remove one to add another.
          </Trans>
        );
      case "last_way_in":
        return (
          <Trans>
            This passkey is the only way to sign in to your account. Set a
            password or add another passkey before removing it.
          </Trans>
        );
      case "no_passkey":
        return <Trans>This account has no passkey.</Trans>;
      case "bad_name":
        return <Trans>That name cannot be used. Use 1 to 64 characters.</Trans>;
      case "unavailable":
        return <Trans>Passkeys are not available on this device.</Trans>;
      case "create_failed":
        return (
          <Trans>
            The passkey could not be created. It may already be on this device.
          </Trans>
        );
    }
  }

  return (
    <CategoryButton.Group>
      {/* `data` is read only once loaded: reading it earlier suspends */}
      <For each={list.isSuccess ? list.data : undefined}>
        {(passkey) => (
          <CategoryButton.Collapse
            icon={<MdKey {...iconSize(22)} />}
            title={passkey.name}
            description={describe(passkey)}
          >
            <CategoryButton
              icon="blank"
              action="chevron"
              disabled={busy()}
              onClick={() => void rename(passkey)}
            >
              <Trans>Rename</Trans>
            </CategoryButton>
            <CategoryButton
              icon="blank"
              action="chevron"
              disabled={busy()}
              onClick={() => void remove(passkey)}
            >
              <Trans>Remove</Trans>
            </CategoryButton>
          </CategoryButton.Collapse>
        )}
      </For>
      <Show when={list.isError}>
        <CategoryButton
          action="chevron"
          icon={<MdError {...iconSize(22)} />}
          onClick={() => void list.refetch()}
          description={<Trans>Select to try again.</Trans>}
        >
          <Trans>Your passkeys could not be loaded</Trans>
        </CategoryButton>
      </Show>
      <Switch
        fallback={
          <CategoryButton
            action="chevron"
            disabled={busy() || supported() === undefined}
            onClick={() => void add()}
            icon={<MdFingerprint {...iconSize(22)} />}
            description={
              <Trans>
                Sign in with your fingerprint, face or screen lock instead of a
                password
              </Trans>
            }
          >
            <Trans>Add a passkey</Trans>
          </CategoryButton>
        }
      >
        <Match when={pending()}>
          <CategoryButton
            action="chevron"
            disabled={busy()}
            onClick={() => void create()}
            icon={<MdFingerprint {...iconSize(22)} />}
            description={
              <Trans>
                Select this to save the passkey. Your device will then ask for
                your fingerprint, face or screen lock.
              </Trans>
            }
          >
            <Trans>Create passkey</Trans>
          </CategoryButton>
        </Match>
        <Match when={supported() === false}>
          <CategoryButton
            icon={<MdFingerprint {...iconSize(22)} />}
            description={
              <Trans>
                Passkeys cannot be added here. Add one in Sloga on your phone or
                on the website.
              </Trans>
            }
          >
            <Trans>Passkeys</Trans>
          </CategoryButton>
        </Match>
      </Switch>
      <Show when={notice()}>
        <CategoryButton
          icon={<MdError {...iconSize(22)} />}
          description={noticeText(notice()!)}
        >
          <Trans>That did not work</Trans>
        </CategoryButton>
      </Show>
    </CategoryButton.Group>
  );
}

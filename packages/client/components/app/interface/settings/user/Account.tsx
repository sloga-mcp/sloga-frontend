import {
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onMount,
} from "solid-js";

import { Plural, Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQuery } from "@tanstack/solid-query";
import { styled } from "styled-system/jsx";

import { useClient, useClientLifecycle } from "@revolt/client";
import {
  createMfaResource,
  createOwnProfileResource,
} from "@revolt/client/resources";
import { CONFIGURATION } from "@revolt/common";
import { getPasskeysAdvert } from "@revolt/common/lib/passkey";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { streamerModeHides } from "@revolt/state/streamer";
import { CategoryButton, Column, Row, Text, iconSize } from "@revolt/ui";

import MdAddCircle from "@material-design-icons/svg/outlined/add_circle_outline.svg?component-solid";
import MdAlternateEmail from "@material-design-icons/svg/outlined/alternate_email.svg?component-solid";
import MdBlock from "@material-design-icons/svg/outlined/block.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdLock from "@material-design-icons/svg/outlined/lock.svg?component-solid";
import MdMail from "@material-design-icons/svg/outlined/mail.svg?component-solid";
import MdPassword from "@material-design-icons/svg/outlined/password.svg?component-solid";
import MdVerifiedUser from "@material-design-icons/svg/outlined/verified_user.svg?component-solid";

import { useSettingsNavigation } from "../Settings";

import { Passkeys } from "./account/Passkeys";
import {
  DELETION_ASK_TIMEOUT_MS,
  accountInfoKey,
  answerWithin,
  mayAddEmail,
} from "./account/accountRules";
import { UserSummary } from "./account/index";
import {
  deleteRequestStatus,
  isOwnedServersRefusal,
  postDeleteAccountTicketless,
  requestAccountDeletion,
} from "./deleteAccountRequest";

/**
 * Account Page
 */
export function MyAccount() {
  const client = useClient();
  const profile = createOwnProfileResource();
  const { navigate } = useSettingsNavigation();

  return (
    <Column gap="lg">
      <UserSummary
        user={client().user!}
        bannerUrl={profile.data?.animatedBannerURL}
        onEdit={() => navigate("profile")}
        showBadges
      />
      <EditAccount />
      <Passkeys />
      <MultiFactorAuth />
      <ManageAccount />
      <ProtectedOwnedWarning />
    </Column>
  );
}

/**
 * Whether the account has no email address (one created with a passkey may
 * have none). False until the server has answered, and when it cannot be
 * asked: the page then reads as it always did.
 */
function createEmailAbsent() {
  const client = useClient();

  const info = useQuery(() => ({
    queryKey: accountInfoKey(client().user!.id),
    queryFn: () => client().account.fetchInfo(),
  }));

  // `data` is read only once loaded: reading it earlier suspends
  return () => info.isSuccess && info.data.email_absent;
}

/**
 * Edit account details
 */
function EditAccount() {
  const client = useClient();
  const state = useState();
  const mfa = createMfaResource();
  const { t } = useLingui();
  const { openModal } = useModals();
  const [email, setEmail] = createSignal("•••••••••••@•••••••••••");
  const emailAbsent = createEmailAbsent();

  // Whether the server takes "Add an email"; false until it has answered
  const [addEmailOffered, setAddEmailOffered] = createSignal(false);

  onMount(() => {
    // Never rejects; a failed lookup reads as not offered
    void getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL).then((advert) =>
      setAddEmailOffered(mayAddEmail(advert)),
    );
  });

  /** Keep the email masked (even if already revealed) during Streamer Mode */
  const hidePersonal = () => streamerModeHides(state.settings, "personal");
  const displayEmail = () =>
    hidePersonal() ? "•••••••••••@•••••••••••" : email();

  return (
    <CategoryButton.Group>
      <CategoryButton
        action="chevron"
        onClick={() =>
          openModal({
            type: "edit_username",
            client: client(),
          })
        }
        icon={<MdAlternateEmail {...iconSize(22)} />}
        description={client().user?.username}
      >
        <Trans>Username</Trans>
      </CategoryButton>
      <Switch
        fallback={
          <CategoryButton
            action="chevron"
            onClick={() =>
              openModal({
                type: "edit_email",
                client: client(),
              })
            }
            icon={<MdMail {...iconSize(22)} />}
            description={
              <Row>
                {displayEmail()}{" "}
                <Show when={hidePersonal()}>
                  <Text class="label">
                    <Trans>Hidden by Streamer Mode</Trans>
                  </Text>
                </Show>
                <Show when={email().startsWith("•") && !hidePersonal()}>
                  <a
                    onClick={(event) => {
                      event.stopPropagation();
                      client().account.fetchEmail().then(setEmail);
                    }}
                  >
                    Reveal
                  </a>
                </Show>
              </Row>
            }
          >
            <Trans>Email</Trans>
          </CategoryButton>
        }
      >
        {/* No address to mask, reveal or change */}
        <Match when={emailAbsent()}>
          <CategoryButton
            icon={<MdMail {...iconSize(22)} />}
            description={<Trans>No email</Trans>}
          >
            <Trans>Email</Trans>
          </CategoryButton>
          <Show when={addEmailOffered()}>
            <CategoryButton
              action="chevron"
              onClick={() =>
                openModal({
                  type: "add_email",
                  client: client(),
                })
              }
              icon={<MdAddCircle {...iconSize(22)} />}
              description={
                <Trans>
                  With an email you can get back in if you lose your passkey.
                </Trans>
              }
            >
              <Trans>Add an email</Trans>
            </CategoryButton>
          </Show>
        </Match>
      </Switch>
      <CategoryButton
        action="chevron"
        onClick={() =>
          openModal({
            type: "edit_password",
            client: client(),
          })
        }
        icon={<MdPassword {...iconSize(22)} />}
        description={
          // An account made without a password has none to mask
          !mfa.isLoading && mfa.data?.passwordAbsent ? t`Not set` : "•••••••••"
        }
      >
        <Trans>Password</Trans>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * Multi-factor authentication
 */
function MultiFactorAuth() {
  const client = useClient();
  const mfa = createMfaResource();
  const { openModal, mfaFlow, mfaEnableTOTP, showError } = useModals();

  /**
   * Show recovery codes
   */
  async function showRecoveryCodes() {
    const ticket = await mfaFlow(mfa.data!);
    if (!ticket) return;

    ticket.fetchRecoveryCodes().then((codes) =>
      openModal({
        type: "mfa_recovery",
        mfa: mfa.data!,
        codes,
      }),
    );
  }

  /**
   * Generate recovery codes
   */
  async function generateRecoveryCodes() {
    const ticket = await mfaFlow(mfa.data!);
    if (!ticket) return;

    ticket.generateRecoveryCodes().then((codes) =>
      openModal({
        type: "mfa_recovery",
        mfa: mfa.data!,
        codes,
      }),
    );
  }

  /**
   * Configure authenticator app
   */
  async function setupAuthenticatorApp() {
    const ticket = await mfaFlow(mfa.data!);
    if (!ticket) return;

    const secret = await ticket.generateAuthenticatorSecret();

    let success = false;
    while (!success) {
      const code = await mfaEnableTOTP(secret, client().user!.username);

      // Dismissing the QR dialog resolves without a code — abandon setup
      // rather than re-prompting, which would trap the user in the modal.
      if (!code) return;

      try {
        await mfa.data!.enableAuthenticator(code);
        success = true;
      } catch (err) {
        // Wrong or expired code: report it and prompt again.
        showError(err);
      }
    }
  }

  /**
   * Disable authenticator app
   */
  function disableAuthenticatorApp() {
    mfaFlow(mfa.data!).then((ticket) => ticket?.disableAuthenticator());
  }

  return (
    <CategoryButton.Group>
      <CategoryButton.Collapse
        icon={<MdVerifiedUser {...iconSize(22)} />}
        // "Two-Factor" is deliberate: the Encryption page has its own,
        // unrelated "recovery code" for encrypted message history, and the
        // two were one word apart on adjacent pages.
        title={<Trans>Two-Factor Recovery Codes</Trans>}
        description={
          <Trans>
            Configure a way to get back into your account in case your 2FA is
            lost
          </Trans>
        }
      >
        <Switch
          fallback={
            <CategoryButton
              icon="blank"
              disabled={mfa.isLoading}
              onClick={generateRecoveryCodes}
              description={<Trans>Setup recovery codes</Trans>}
            >
              <Trans>Generate Recovery Codes</Trans>
            </CategoryButton>
          }
        >
          <Match when={!mfa.isLoading && mfa.data?.recoveryEnabled}>
            <CategoryButton
              icon="blank"
              description={<Trans>Get active recovery codes</Trans>}
              onClick={showRecoveryCodes}
            >
              <Trans>View Recovery Codes</Trans>
            </CategoryButton>
            <CategoryButton
              icon="blank"
              description={<Trans>Get a new set of recovery codes</Trans>}
              onClick={generateRecoveryCodes}
            >
              <Trans>Reset Recovery Codes</Trans>
            </CategoryButton>
          </Match>
        </Switch>
      </CategoryButton.Collapse>
      <CategoryButton.Collapse
        icon={<MdLock {...iconSize(22)} />}
        title={<Trans>Authenticator App</Trans>}
        description={<Trans>Configure one-time password authentication</Trans>}
      >
        <Switch
          fallback={
            <CategoryButton
              icon="blank"
              disabled={mfa.isLoading}
              onClick={setupAuthenticatorApp}
              description={<Trans>Setup one-time password authenticator</Trans>}
            >
              <Trans>Enable Authenticator</Trans>
            </CategoryButton>
          }
        >
          <Match when={!mfa.isLoading && mfa.data?.authenticatorEnabled}>
            <CategoryButton
              icon="blank"
              description={
                <Trans>Disable one-time password authenticator</Trans>
              }
              onClick={disableAuthenticatorApp}
            >
              <Trans>Remove Authenticator</Trans>
            </CategoryButton>
          </Match>
        </Switch>
      </CategoryButton.Collapse>
    </CategoryButton.Group>
  );
}

/**
 * Manage account
 */
function ManageAccount() {
  const client = useClient();
  const mfa = createMfaResource();
  const { t } = useLingui();
  const { mfaFlow, openModal, showError } = useModals();
  const { logout } = useClientLifecycle();
  const emailAbsent = createEmailAbsent();

  // `deleteAccount` is asking the server which deletion applies; the button
  // is off meanwhile
  const [askingDeletion, setAskingDeletion] = createSignal(false);

  const stillOwnServers = createMemo(
    () =>
      client().servers.filter((server) => server.owner?.self || false).length >
      0,
  );

  /**
   * Disable account
   */
  function disableAccount() {
    mfaFlow(mfa.data!).then((ticket) =>
      ticket?.disableAccount().then(() => logout()),
    );
  }

  /**
   * Send the deletion request: ticketless first, the password / MFA prompt
   * only if the server asks for it (see `./deleteAccountRequest.ts`).
   *
   * No `logout()` here: the "check your email" notice signs this device out
   * when it closes. A cancelled prompt sends nothing and shows nothing.
   */
  async function requestDeletion() {
    try {
      const outcome = await requestAccountDeletion({
        ticketless: () => {
          // Plain fetch with the client's own session headers, so the
          // status survives (the API client throws only the body).
          const { baseURL, headers } = client().api.config;
          return postDeleteAccountTicketless(
            fetch,
            baseURL!,
            (headers ?? {}) as Record<string, string>,
          );
        },
        withTicket: async () => {
          const ticket = await mfaFlow(
            mfa.data ?? (await client().account.mfa()),
          );
          if (!ticket) return false;
          await ticket.deleteAccount();
          return true;
        },
        statusOf: deleteRequestStatus,
      });

      if (outcome === "requested") {
        openModal({ type: "delete_account_requested" });
      }
    } catch (error) {
      showError(
        isOwnedServersRefusal(error)
          ? // Same text as the lock below: the server list here was stale.
            new Error(
              t`Transfer or delete the servers you own first, then come back here.`,
            )
          : error,
      );
    }
  }

  /**
   * Delete account: confirm first, then request the emailed link.
   *
   * An account with no email has nowhere to get a link: it confirms with
   * its username and a ticket, and the server deletes it at once. Which of
   * the two applies is asked fresh. If the answer fails or takes longer
   * than 8 s, the emailed-link flow goes ahead: it is what the server
   * applies to every account with an email, and a no-email account that
   * takes it is refused by the server, so nothing is deleted on a guess.
   */
  async function deleteAccount() {
    // A second press while the question is out must not open two dialogs
    if (askingDeletion()) return;
    setAskingDeletion(true);

    // Never rejects
    const absent = await answerWithin(
      client()
        .account.fetchInfo()
        .then((info) => info.email_absent === true),
      DELETION_ASK_TIMEOUT_MS,
      false,
    );

    setAskingDeletion(false);

    if (absent) {
      openModal({ type: "delete_account_no_email", client: client() });
    } else {
      openModal({ type: "delete_account_confirm", onConfirm: requestDeletion });
    }
  }

  return (
    <CategoryButton.Group>
      <CategoryButton
        action="chevron"
        disabled={mfa.isLoading}
        onClick={disableAccount}
        icon={<MdBlock {...iconSize(22)} fill="var(--md-sys-color-error)" />}
        description={
          <Trans>
            You won't be able to access your account unless you contact support
            - however, your data will not be deleted.
          </Trans>
        }
      >
        <Trans>Disable Account</Trans>
      </CategoryButton>
      <CategoryButton
        action={stillOwnServers() ? undefined : "chevron"}
        disabled={mfa.isLoading || stillOwnServers() || askingDeletion()}
        onClick={() => void deleteAccount()}
        icon={<MdDelete {...iconSize(22)} fill="var(--md-sys-color-error)" />}
        description={
          <Switch
            fallback={
              <Trans>
                We'll email you a link. Once you confirm from that email, your
                account and data are deleted right away. This can't be undone.
                Changed your mind? Just sign in again before using the link.
              </Trans>
            }
          >
            <Match when={stillOwnServers()}>
              <Trans>
                Transfer or delete the servers you own first, then come back
                here.
              </Trans>
            </Match>
            <Match when={emailAbsent()}>
              <Trans>
                Your account has no email, so there is no link to confirm. Once
                you type your username and confirm, your account and data are
                deleted right away. This can't be undone.
              </Trans>
            </Match>
          </Switch>
        }
      >
        <Trans>Delete Account</Trans>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * S2-D43: tell an owner how many of their servers have a protected channel,
 * worded to match the `stillOwnServers` gate above (delete or transfer
 * first). A count only (no names, no ids); hidden at 0.
 */
function ProtectedOwnedWarning() {
  const client = useClient();

  // Client cache only (no request); this device's pins count too.
  const protectedOwned = createMemo(() =>
    ownedProtectedServerCount(
      client().servers.toList(),
      client().user?.id,
      (channelId) => client().isProtectedChannel(channelId),
    ),
  );

  return (
    <Show when={protectedOwned() > 0}>
      <ProtectedOwnedNote role="note">
        <Plural
          value={protectedOwned()}
          one="You own # server with protected channels. Delete it or transfer it before deleting your account. Deleting a server deletes its protected channels for everyone."
          other="You own # servers with protected channels. Delete or transfer them before deleting your account. Deleting a server deletes its protected channels for everyone."
        />
      </ProtectedOwnedNote>
    </Show>
  );
}

const ProtectedOwnedNote = styled("div", {
  base: {
    color: "var(--md-sys-color-error)",
    fontSize: "14px",
    lineHeight: "20px",
  },
});

// protected-pure:begin (no imports: account.scan.test.ts runs this region
// under Node)

/** The fields of a cached server the count reads. */
type OwnedServerView = {
  readonly ownerId: unknown;
  readonly channelIds?: Iterable<string> | null;
};

/**
 * How many servers `selfId` owns that have at least one protected channel.
 * Each server counts once, however many of its channels are protected. An
 * unknown self counts nothing (an absent owner id never matches).
 */
function ownedProtectedServerCount(
  servers: Iterable<OwnedServerView>,
  selfId: unknown,
  isProtected: (channelId: string) => boolean,
): number {
  if (typeof selfId !== "string" || selfId === "") return 0;
  let count = 0;
  for (const server of servers) {
    if (server.ownerId !== selfId) continue;
    for (const channelId of server.channelIds ?? []) {
      if (isProtected(channelId) === true) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

// protected-pure:end

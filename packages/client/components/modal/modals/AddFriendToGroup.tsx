import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import * as chatShell from "@revolt/client/chatShell";
import type { GroupIncludePreflight, KeyBundle } from "@revolt/client/e2ee";
import { fetchWithRatelimitPolicy } from "@revolt/client/e2eeRatelimitPolicy";
import { useWindowCtx } from "@revolt/client/windowCtx";
import { useError } from "@revolt/i18n";
import { Button, Column, Dialog, DialogProps } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

import {
  type GroupVerdict,
  type MemberListing,
  type RowState,
  INCLUDE_MEMBER_WAIT_MS,
  collectListings,
  decideAdd,
  otherMemberIds,
  rowStateFor,
  tooManyToVerify,
  waitForMember,
} from "./addFriendToGroupPolicy";
import {
  type IncludeFailureDetail,
  type IncludeFailureKind,
  includeFailureForError,
  includeFailureForOutcome,
  includeFlightKey,
  includeFlights,
} from "./includeFlight";

/** Groups at or above this size can't take another member */
const MAX_GROUP_SIZE = 100;

/** How long one device listing may take before the add is refused */
const LISTING_DEADLINE_MS = 10_000;

type IncludeRefusal = Extract<
  GroupIncludePreflight,
  { kind: "refuse" }
>["reason"];

/**
 * Preflight refusals a Retry (friend already added) can't get past: no
 * keys, a full group, or a group or identity that no longer encrypts.
 * Retrying would only refuse again.
 */
const TERMINAL_RETRY_REFUSALS: ReadonlySet<IncludeRefusal> = new Set([
  "no_keys",
  "too_many",
  "not_encrypted",
]);

/** A failure after the server add: the friend is in, but not encrypted to */
type ShownFailure = {
  channelId: string;
  kind: IncludeFailureKind;
  detail?: IncludeFailureDetail;
};

/**
 * Add one friend to an existing group chat, or start a new one with them
 */
export function AddFriendToGroupModal(
  props: DialogProps & Modals & { type: "add_friend_to_group" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const errorText = useError();
  const modals = useModals();
  const windowCtx = useWindowCtx();

  // A check this instance runs before any side effect (the plaintext add's
  // checks, an include's preflight), by group id.
  const [checking, setChecking] = createSignal<string | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  // Groups a click found a member with E2EE devices in: shown locked from
  // then on, whatever the cached verdict says.
  const [maybeEncrypted, setMaybeEncrypted] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  // The encrypted group whose include is being confirmed, in-modal.
  const [confirming, setConfirming] = createSignal<Channel | undefined>();

  // From the server add on, an include is a flight in `includeFlights`, not
  // state of this instance: this modal can be torn down mid-commit (its chat
  // window closed) and drawn again by main as a fresh instance, which must
  // still show how the include went. `attached` is the flight shown here; a
  // new instance starts on the friend's flight, if one is committing or
  // waiting on a failure, so it resumes it from the first render.
  const [attached, setAttached] = createSignal<string | undefined>(
    // eslint-disable-next-line solid/reactivity
    includeFlights.pickFor(props.userId),
  );
  const [flightVersion, setFlightVersion] = createSignal(0);
  onCleanup(
    // An event handler: it reads props and signals once per flight event.
    // eslint-disable-next-line solid/reactivity
    includeFlights.subscribe((event) => {
      setFlightVersion((version) => version + 1);
      if (event.key !== attached()) return;
      switch (event.type) {
        case "done":
          setAttached(undefined);
          setConfirming(undefined);
          if (props.show) props.onClose();
          break;
        case "abandoned":
          setAttached(undefined);
          setConfirming(undefined);
          if (event.message) setError(event.message);
          break;
        case "failed":
          setConfirming(undefined);
          break;
        case "dismissed":
          setAttached(undefined);
          break;
      }
    }),
  );

  /** A flight, read reactively */
  const flightFor = (key: string | undefined) => {
    flightVersion();
    return key ? includeFlights.get(key) : undefined;
  };
  const flight = () => flightFor(attached());

  // True from the server add until the include settles: the friend may
  // already be in the group, so the dialog stays up to say how it went.
  const committing = () => flight()?.phase === "committing";

  // A Retry keeps the failure it retries on screen (its kind, without the
  // detail of the attempt that failed) until it settles, with "Checking…"
  // beside a disabled Retry.
  const includeFailure = (): ShownFailure | undefined => {
    const current = flight();
    if (current?.phase === "failed") {
      return {
        channelId: current.channelId,
        kind: current.kind,
        detail: current.detail,
      };
    }
    return current?.retrying
      ? { channelId: current.channelId, kind: current.retried ?? "half_done" }
      : undefined;
  };

  /** The group being checked or committed, if any */
  const pending = () =>
    checking() ?? (committing() ? flight()?.channelId : undefined);

  // The confirm panel stays up with "Checking…" while the flight commits,
  // including in an instance that only adopted it.
  const confirmPanel = () => {
    const current = flight();
    return (
      confirming() ??
      (current?.phase === "committing" && !current.retrying
        ? client().channels.get(current.channelId)
        : undefined)
    );
  };

  // A modal drawn again mid-commit (or opened again over a failure nobody
  // dismissed) resumes that flight. In main, raise the window: it may be
  // hidden, and the outcome has to be seen.
  onMount(() => {
    if (attached() && windowCtx.id === "main") void chatShell.focusMain();
  });

  /** Show the flight already running or failed for this group, if any */
  function joinFlight(channel: Channel): boolean {
    const key = includeFlightKey(channel.id, props.userId);
    if (!includeFlights.get(key)) return false;
    setError(undefined);
    setAttached(key);
    return true;
  }

  // Closing the modal cuts any listing still in flight, and the add with it.
  // `show` turns false the moment it closes; the unmount comes ~500 ms later
  // (after the exit animation), too late to stop a check finishing meanwhile.
  // An include drops its controller before the server add, so nothing from
  // that point on is ever cut.
  let inFlight: AbortController | undefined;
  createEffect(() => {
    if (!props.show) inFlight?.abort();
  });
  onCleanup(() => inFlight?.abort());

  // Closing the modal over a failure dismisses it; a committing flight is
  // never cut (`dismiss` refuses it). An unmount alone is not a close: a
  // chat window closing hands this modal to main, still open.
  createEffect(() => {
    const key = attached();
    if (!props.show && key) includeFlights.dismiss(key);
  });

  // ESC goes through the controller's CLOSE_MODAL keybind, not `onClose`, so
  // it is locked there while an include commits (as in E2EEReenroll). Only
  // the lock taken here is ever released.
  let lockToken: string | undefined;
  createEffect(() => {
    if (committing()) {
      lockToken = modals.lockDismiss();
    } else if (lockToken) {
      modals.unlockDismiss(lockToken);
      lockToken = undefined;
    }
  });
  onCleanup(() => {
    // Unmounted while still open and committing: main is taking this modal
    // over (its chat window closed), and the lock is on the same modal id,
    // so releasing it here could undo the lock main's instance just took.
    // Main's instance releases it when the flight settles.
    if (lockToken && !(committing() && props.show)) {
      modals.unlockDismiss(lockToken);
    }
  });

  /** Backdrop close, refused while an include commits */
  function guardedClose() {
    if (committing()) return;
    props.onClose();
  }

  /** The friend's name as the group will see it */
  const friendName = () => {
    const user = client().users.get(props.userId);
    return user?.displayName ?? user?.username ?? "";
  };

  /**
   * Whether E2EE is enabled + published on THIS device (the composer's
   * check), with a device id, on a store that belongs to this account. Native
   * `send_mode_group` answers "plaintext" when the engine was never set up
   * here or has no local record of the group, so a plaintext verdict only
   * means something on a device that passes this.
   */
  const selfReady = () => {
    if (!e2ee) return false;
    const s = e2ee.status.get("state");
    return (
      !!s?.enabled &&
      !!s?.published &&
      !!s?.device_id &&
      !e2ee.storeOwnedByAnotherAccount.has("state") &&
      !e2ee.deviceOwnedElsewhere.has("state")
    );
  };

  /**
   * "include" for a native "encrypt" verdict on a ready device: confirmed,
   * then preflighted, on click. "encrypted" for the same verdict on a device
   * that can't include anyone. "addable" only for a plaintext verdict on a
   * ready device. Everything else (web, not primed yet, blocked or downgraded
   * modes, a device without E2EE) can't be verified here, so it stays
   * disabled. "addable" is not a promise: a plaintext verdict can be wrong
   * (see `addFriendToGroupPolicy`), so the members' device listings are
   * checked on click. "maybe" is a plaintext group a click found member
   * devices in: neither path can add to it from here.
   */
  const rowState = (channel: Channel): RowState | "maybe" =>
    maybeEncrypted().has(channel.id)
      ? "maybe"
      : rowStateFor(e2ee?.sendModes.get(channel.id), selfReady());

  /**
   * One member's device listing, the way the E2EE bridge fetches it (raw
   * fetch: /e2ee is missing from the typed client's tables). No 429 retries:
   * a rate limit refuses this add rather than spending more of the
   * `e2ee_devices` budget that DM and call reconciles share. Never throws.
   */
  async function fetchListing(
    userId: string,
    signal: AbortSignal,
  ): Promise<MemberListing> {
    const api = client();
    const [authHeader, authValue] = api.authenticationHeader;
    const path = `/e2ee/devices/${encodeURIComponent(userId)}`;
    try {
      const response = await fetchWithRatelimitPolicy(
        (attemptSignal) =>
          fetch(`${api.options.baseURL}${path}`, {
            method: "GET",
            headers: { [authHeader]: authValue },
            signal: attemptSignal,
          }),
        "GET",
        path,
        { maxRetries: 0, signal, deadlineMs: LISTING_DEADLINE_MS },
      );
      if (!response.ok) return { kind: "error", error: response.status };
      return { kind: "fetched", body: await response.json() };
    } catch (error) {
      return { kind: "error", error };
    }
  }

  const groups = createMemo(() =>
    [...client().channels.values()]
      .filter(
        (channel) =>
          channel.type === "Group" &&
          !channel.recipientIds.has(props.userId) &&
          channel.recipientIds.size < MAX_GROUP_SIZE,
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
  );

  // Same priming the composer does on group open, so rows can resolve from
  // "unknown" to a real verdict while the modal is open.
  onMount(() => {
    if (!e2ee) return;
    for (const channel of groups()) void e2ee.primeGroupMode(channel.id);
  });

  async function add(channel: Channel) {
    if (!props.show || pending() || joinFlight(channel)) return;
    if (rowState(channel) !== "addable") return;
    setChecking(channel.id);
    setError(undefined);
    const controller = new AbortController();
    inFlight = controller;

    try {
      // A group too big to verify makes no request at all: the null
      // verdict below refuses it as unverified.
      const selfId = client().user?.id;
      const before = otherMemberIds(channel.recipientIds, selfId);
      const tooMany = !!before && tooManyToVerify(before);

      // Re-read native status and re-ask the native layer: the cached
      // verdict can be stale if another member turned encryption on since
      // it was primed. Any failure refuses.
      let verdict: GroupVerdict = null;
      if (!tooMany) {
        try {
          await e2ee!.refreshStatus();
          if (selfReady()) verdict = await e2ee!.sendModeNowFor(channel);
        } catch {
          verdict = null;
        }
      }
      if (controller.signal.aborted) return;

      // A plaintext verdict can't see an encryption this device never
      // heard about, so every other member's device listing is fetched
      // now, right before the add, and must be empty.
      const listings =
        !tooMany && selfReady() && verdict === "plaintext" && before
          ? await collectListings(before, (id) =>
              fetchListing(id, controller.signal),
            )
          : new Map<string, MemberListing>();
      if (controller.signal.aborted) return;

      // Members read again after the fetch: anyone who joined meanwhile
      // has no listing, which refuses.
      const decision = decideAdd({
        selfReady: selfReady(),
        verdict,
        memberIds: otherMemberIds(channel.recipientIds, selfId),
        listings,
      });
      if (decision.kind === "refuse") {
        if (decision.reason === "encrypted" && verdict === "encrypt") {
          // The fresh verdict found the group encrypted after all (and
          // refreshed the cached one): offer the include instead.
          setConfirming(channel);
        } else if (decision.reason === "encrypted") {
          setMaybeEncrypted((prev) => new Set(prev).add(channel.id));
          setError(
            t`This group chat may be encrypted, but this device can't confirm it, so nobody was added.`,
          );
        } else {
          setError(
            t`Couldn't confirm that this group chat is unencrypted, so nobody was added.`,
          );
        }
        return;
      }

      // Closed while the checks ran: the user walked away, so no add.
      if (controller.signal.aborted || !props.show) return;
      await channel.addMember(props.userId);
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      if (inFlight === controller) inFlight = undefined;
      setChecking(undefined);
    }
  }

  /** Why nobody was added, for a preflight that refused */
  function refusalText(reason: IncludeRefusal): string {
    const name = friendName();
    switch (reason) {
      case "no_keys":
        return t`${name} hasn't turned on encryption on any device, so they can't be added to an encrypted group chat.`;
      case "too_many":
        return t`This encrypted group chat is full.`;
      case "not_ready":
      case "not_encrypted":
      case "unavailable":
        return t`Couldn't prepare encryption for ${name}, so nobody was added. Try again.`;
      default: {
        const exhaustive: never = reason;
        return exhaustive;
      }
    }
  }

  /**
   * Add a friend to an encrypted group in the pinned order: preflight (no
   * side effects, and a refusal adds nobody), server add, wait until the
   * member is listed locally, native include. A close can still cut the
   * preflight; from the server add on, nothing is cut. The preflight, not
   * the row state, decides: the row may have changed while confirming.
   */
  async function include(channel: Channel) {
    if (!e2ee || !props.show || pending()) return;
    // A flight already running or failed for this pair is shown, never
    // doubled: no second preflight (its bundle fetch spends one-time keys)
    // and no second add.
    if (joinFlight(channel)) return;
    const userId = props.userId;
    setChecking(channel.id);
    setError(undefined);
    const controller = new AbortController();
    inFlight = controller;

    let preflight: GroupIncludePreflight;
    try {
      preflight = await e2ee.groupIncludePreflight(channel, userId);
    } catch {
      // Documented never to throw; if it does anyway, it refuses.
      preflight = { kind: "refuse", reason: "unavailable" };
    }
    if (inFlight === controller) inFlight = undefined;
    if (controller.signal.aborted || !props.show) {
      setChecking(undefined);
      return;
    }
    if (preflight.kind === "refuse") {
      setError(refusalText(preflight.reason));
      setConfirming(undefined);
      setChecking(undefined);
      return;
    }

    // Another modal may have started this pair's flight meanwhile: then
    // this one joins it rather than adding again.
    const key = includeFlightKey(channel.id, userId);
    const owner = includeFlights.begin(channel.id, userId);
    setAttached(key);
    setChecking(undefined);
    if (owner) await commitInclude(channel, userId, key, preflight.bundle);
  }

  /**
   * The server add, then {@link finishInclude}. Reports to the flight only,
   * never to this instance: the instance may be gone by the time it
   * settles, and whichever one shows the flight then reports the outcome.
   */
  async function commitInclude(
    channel: Channel,
    userId: string,
    key: string,
    bundle: KeyBundle,
  ) {
    try {
      await channel.addMember(userId);
    } catch (err) {
      // A failed request can still have landed, with its join event still
      // on the way: wait for it (still locked, still checking). A listed
      // member means a half-done add, which must say so and offer a Retry.
      const landed = await waitForMember(
        () => channel.recipientIds.has(userId),
        { timeoutMs: INCLUDE_MEMBER_WAIT_MS },
      );
      if (landed) {
        includeFlights.fail(key, "half_done");
      } else {
        includeFlights.abandon(key, errorText(err));
      }
      return;
    }

    await finishInclude(channel, userId, key, bundle);
  }

  /**
   * Everything after the server add: wait until the local channel lists the
   * member (a reconcile without them would mark them removed), then the
   * native include, which shows the native confirm dialog. A Retry passes no
   * bundle and fetches a fresh one, since its one-time keys are single-use.
   * Never cut by a close, and settles the flight whatever happens: only an
   * "ok" outcome succeeds, and a Cancel on the dialog ("declined") leaves the
   * friend added but not included, with a Retry that prompts again.
   */
  async function finishInclude(
    channel: Channel,
    userId: string,
    key: string,
    bundle?: KeyBundle,
  ) {
    try {
      // Polled, not tracked: the member arrives by a websocket event.
      const listed = await waitForMember(
        () => channel.recipientIds.has(userId),
        { timeoutMs: INCLUDE_MEMBER_WAIT_MS },
      );
      if (!listed) {
        includeFlights.fail(key, "half_done");
        return;
      }

      if (!bundle) {
        const preflight = await e2ee!.groupIncludePreflight(channel, userId);
        if (preflight.kind === "refuse") {
          includeFlights.fail(
            key,
            TERMINAL_RETRY_REFUSALS.has(preflight.reason)
              ? "terminal"
              : "half_done",
          );
          return;
        }
        bundle = preflight.bundle;
      }

      const outcome = await e2ee!.addGroupMemberEncrypted(
        channel,
        userId,
        bundle,
      );
      if (outcome === "ok") {
        includeFlights.succeed(key);
        return;
      }
      const failure = includeFailureForOutcome(outcome);
      includeFlights.fail(key, failure.kind, failure.detail);
    } catch (err) {
      const failure = includeFailureForError(err);
      includeFlights.fail(key, failure.kind, failure.detail);
    }
  }

  /** The group a failure is about, while this client still has it */
  const failureChannel = (failure: ShownFailure) =>
    client().channels.get(failure.channelId);

  function retryInclude() {
    const key = attached();
    const failure = includeFailure();
    if (!key || !failure || failure.kind === "terminal" || pending()) return;
    const channel = failureChannel(failure);
    if (!channel || !includeFlights.retry(key)) return;
    void finishInclude(channel, props.userId, key);
  }

  function openInclude(channel: Channel) {
    if (!props.show || pending() || joinFlight(channel)) return;
    setError(undefined);
    setConfirming(channel);
  }

  function newGroup() {
    props.onClose();
    modals.openModal({
      type: "create_group",
      client: client(),
      initialUsers: [props.userId],
    });
  }

  /**
   * Copy for a failure after the server add: what happened to the friend,
   * then why, when the failure says. A store owned by another account is
   * terminal, but nothing about the friend needs reviewing, so it reads as
   * "not included" rather than the remove-or-review copy.
   */
  function includeFailureText(failure: ShownFailure): string {
    const name = friendName();
    const declined = t`${name} was added to the group but not included in its encryption. They can't read encrypted messages.`;
    let headline: string;
    switch (failure.kind) {
      case "declined":
        headline = declined;
        break;
      case "half_done":
        headline = t`${name} was added to the group chat, but couldn't be included in its encryption yet.`;
        break;
      case "terminal":
        headline =
          failure.detail === "other_account"
            ? declined
            : t`${name} couldn't be included in this group chat's encryption. Remove them from the group chat, or review their security identity.`;
        break;
      default: {
        const exhaustive: never = failure.kind;
        return exhaustive;
      }
    }
    return failure.detail
      ? `${headline} ${includeDetailText(failure.detail)}`
      : headline;
  }

  /** Why an include failed, for the failures that say */
  function includeDetailText(detail: IncludeFailureDetail): string {
    switch (detail) {
      case "busy":
        return t`Try again in a moment.`;
      case "roster_changed":
        return t`The member list changed. Check it and try again.`;
      case "roster_mismatch":
        return t`This group is already encrypted with a different member list. Check the member list and try again.`;
      case "self_user_id":
        return t`This device isn't part of this group's encryption yet. Wait for another member to re-send the member list.`;
      case "other_account":
        return t`This device's encryption is set up for a different account.`;
      default: {
        const exhaustive: never = detail;
        return exhaustive;
      }
    }
  }

  function confirmTitle(): string {
    const name = friendName();
    return t`Add ${name} to an encrypted group chat?`;
  }

  function confirmBody(channel: Channel): string {
    const name = friendName();
    const group = channel.displayName ?? channel.name;
    return t`“${group}” is end-to-end encrypted. ${name} will be included in its encryption and can read messages sent from now on, but not earlier ones. Everyone in the group will see that they were added.`;
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={guardedClose}
      title={<Trans>Add to group chat</Trans>}
      actions={[{ text: <Trans>Close</Trans> }]}
      isDisabled={!!pending()}
    >
      <Column>
        <Switch
          fallback={
            <Rows>
              <button
                type="button"
                class={row()}
                onClick={newGroup}
                disabled={!!pending()}
              >
                <Symbol size={18}>group_add</Symbol>
                <RowName>
                  <Trans>New group chat</Trans>
                </RowName>
              </button>

              <For each={groups()}>
                {(channel) => {
                  const state = () => rowState(channel);
                  // A flight for this pair (from another modal) is shown on
                  // click, never started again.
                  const rowFlight = () =>
                    flightFor(includeFlightKey(channel.id, props.userId));
                  // A native element (not a styled component) so the
                  // directive binds; aria-disabled rather than `disabled` so
                  // the tooltip still gets hover events.
                  return (
                    <button
                      type="button"
                      class={row()}
                      aria-disabled={
                        (state() !== "addable" && state() !== "include") ||
                        !!rowFlight() ||
                        !!pending() ||
                        undefined
                      }
                      aria-busy={pending() === channel.id || undefined}
                      onClick={() =>
                        state() === "include"
                          ? openInclude(channel)
                          : void add(channel)
                      }
                      use:floating={{
                        tooltip:
                          state() === "encrypted"
                            ? {
                                placement: "top",
                                content: t`Turn on encryption on this device to add people to encrypted group chats.`,
                              }
                            : state() === "unverified" || state() === "maybe"
                              ? {
                                  placement: "top",
                                  content: t`Can't add people to this group chat from here yet.`,
                                }
                              : undefined,
                      }}
                    >
                      <Symbol size={18}>
                        {state() === "addable" || state() === "unverified"
                          ? "group"
                          : "lock"}
                      </Symbol>
                      <RowName>{channel.displayName ?? channel.name}</RowName>
                      <Show
                        when={
                          pending() === channel.id ||
                          rowFlight()?.phase === "committing"
                        }
                      >
                        <RowStatus>
                          <Trans>Checking…</Trans>
                        </RowStatus>
                      </Show>
                    </button>
                  );
                }}
              </For>

              <Show when={groups().length === 0}>
                <Empty>
                  <Trans>No other group chats to add them to.</Trans>
                </Empty>
              </Show>
            </Rows>
          }
        >
          <Match when={includeFailure()}>
            {(failure) => (
              <Panel>
                <ErrorText role="alert">
                  {includeFailureText(failure())}
                </ErrorText>
                <Show when={failure().kind !== "terminal"}>
                  <PanelActions>
                    <Show when={pending()}>
                      <RowStatus>
                        <Trans>Checking…</Trans>
                      </RowStatus>
                    </Show>
                    <Button
                      variant="tonal"
                      size="sm"
                      isDisabled={!!pending() || !failureChannel(failure())}
                      onPress={retryInclude}
                    >
                      <Trans>Retry</Trans>
                    </Button>
                  </PanelActions>
                </Show>
              </Panel>
            )}
          </Match>
          <Match when={confirmPanel()}>
            {(channel) => (
              <Panel>
                <PanelTitle>{confirmTitle()}</PanelTitle>
                <PanelBody>{confirmBody(channel())}</PanelBody>
                <PanelActions>
                  <Show when={pending()}>
                    <RowStatus>
                      <Trans>Checking…</Trans>
                    </RowStatus>
                  </Show>
                  <Button
                    variant="text"
                    size="sm"
                    isDisabled={!!pending()}
                    onPress={() => setConfirming(undefined)}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button
                    variant="tonal"
                    size="sm"
                    isDisabled={!!pending()}
                    onPress={() => void include(channel())}
                  >
                    <Trans>Continue</Trans>
                  </Button>
                </PanelActions>
                {/* The bridge exists only in the native shells, and so does
                    their OS confirm dialog. */}
                <Show when={e2ee}>
                  <PanelHint>
                    <Trans>You'll confirm this in a system dialog.</Trans>
                  </PanelHint>
                </Show>
              </Panel>
            )}
          </Match>
        </Switch>

        <Show when={error()}>
          <ErrorText role="alert">{error()}</ErrorText>
        </Show>
      </Column>
    </Dialog>
  );
}

const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "320px",
    overflowY: "auto",
  },
});

const row = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "8px 10px",
    borderRadius: "8px",
    textAlign: "left",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
    "&[aria-disabled=true], &:disabled": {
      opacity: 0.5,
      cursor: "not-allowed",
      background: "transparent",
    },
  },
});

const RowName = styled("span", {
  base: {
    flexGrow: 1,
    fontSize: "0.9rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const RowStatus = styled("span", {
  base: {
    flexShrink: 0,
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Empty = styled("div", {
  base: {
    padding: "16px",
    textAlign: "center",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Panel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
  },
});

const PanelTitle = styled("div", {
  base: {
    fontSize: "0.95rem",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface)",
  },
});

const PanelBody = styled("div", {
  base: {
    fontSize: "0.875rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const PanelActions = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "var(--gap-sm)",
  },
});

const PanelHint = styled("div", {
  base: {
    fontSize: "0.8125rem",
    textAlign: "right",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ErrorText = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-error)",
  },
});

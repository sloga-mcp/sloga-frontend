import { Capacitor } from "@capacitor/core";
import { Show, createEffect, createSignal, onMount } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { API } from "stoat.js";

import { useClient } from "@revolt/client";
import {
  appLockAvailable,
  appLockState,
  disableAppLock,
  enableAppLock,
  refreshAppLock,
  setAppLockHideText,
  setAppLockTimeout,
} from "@revolt/client/appLock";
import { type AppLockTimeout, readCode } from "@revolt/client/appLockPolicy";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  Checkbox,
  Column,
  FloatingSelect,
  MenuItem,
  Text,
  useSnackbar,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Privacy settings page — who can see what about you.
 *
 * Collects the "visible to others" switches that used to be scattered:
 * profile visibility lived inside the profile edit form (saved with the
 * avatar and bio) and game-activity sharing sat between the per-server
 * identity list and the avatar picker. Both are about audience, not about
 * what your profile says, so they read better next to each other and next
 * to Streamer Mode / Encryption in the sidebar.
 */
export function PrivacySettings() {
  return (
    <Column gap="lg">
      <ProfileVisibility />
      <ActivitySharing />
      <Show when={appLockAvailable()}>
        <AppLockSettings />
      </Show>
    </Column>
  );
}

/**
 * Who can see the profile bio, banner and connections. Saves on change —
 * unlike the profile form there is nothing else to batch it with.
 */
function ProfileVisibility() {
  const client = useClient();
  const { t } = useLingui();
  const snackbar = useSnackbar();
  const [saving, setSaving] = createSignal(false);

  async function save(value: string) {
    const user = client().user;
    if (!user || saving()) return;
    if (value !== "Everyone" && value !== "Friends") return;
    if (value === user.profileVisibility) return;

    setSaving(true);
    try {
      // `profile_visibility` is additive; stoat-api 0.13.5 predates it
      await user.edit({
        remove: [],
        profile_visibility: value,
      } as API.DataEditUser & { profile_visibility: string });
    } catch {
      snackbar.show({
        message: t`Could not update profile visibility, try again.`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Column>
      <Text class="label">
        <Trans>Profile visibility</Trans>
      </Text>
      <Text class="_status" size="small">
        <Trans>
          Choose who can see your bio, banner, and connections. People you share
          a server or group with can always see your name and avatar.
        </Trans>
      </Text>
      <FloatingSelect
        label={t`Profile visibility`}
        // Bound to the live user object: `edit()` hydrates the response
        // back into it, so a failed save simply leaves the old value showing.
        value={client().user?.profileVisibility}
        onChange={(event) => void save(event.currentTarget.value ?? "")}
      >
        <MenuItem value="Everyone">
          <Trans>Everyone</Trans>
        </MenuItem>
        <MenuItem value="Friends">
          <Trans>Friends only</Trans>
        </MenuItem>
      </FloatingSelect>
    </Column>
  );
}

/**
 * Game-activity sharing (desktop shells only publish it, so the copy says so
 * rather than the row hiding on other platforms — the setting itself syncs).
 */
function ActivitySharing() {
  const state = useState();

  return (
    <CategoryButton.Group>
      <CategoryButton
        action={
          <Checkbox checked={state.settings.getValue("activity:share")} />
        }
        onClick={() =>
          state.settings.setValue(
            "activity:share",
            !state.settings.getValue("activity:share"),
          )
        }
        icon={<Symbol>sports_esports</Symbol>}
        description={
          <Trans>
            Show friends what game you are playing (desktop app only).
          </Trans>
        }
      >
        <Trans>Share Game Activity</Trans>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * App lock, phones only. The lock itself lives in native code and is kept
 * per device, so every row here reads the native state back after a change
 * instead of trusting what was asked for.
 */
function AppLockSettings() {
  const { t } = useLingui();
  const snackbar = useSnackbar();
  const platform = Capacitor.getPlatform();
  const [busy, setBusy] = createSignal(false);
  // Native reports `autoDisabled` once and then clears it, so keep it here.
  const [autoDisabled, setAutoDisabled] = createSignal(false);

  const enabled = () => appLockState().enabled;

  createEffect(() => {
    if (appLockState().autoDisabled) setAutoDisabled(true);
  });

  onMount(() => void refreshAppLock().catch(() => undefined));

  /**
   * Run one native change, then read the state back whatever happened.
   * @param action The change
   * @returns Whether it went through
   */
  async function run(action: () => Promise<void>) {
    if (busy()) return false;

    setBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      const code = readCode(error);
      if (code === "NO_DEVICE_LOCK") {
        snackbar.show({ message: t`Set a screen lock on your phone first.` });
      } else if (code !== "CANCELLED") {
        snackbar.show({ message: t`Could not change app lock, try again.` });
      }
      return false;
    } finally {
      await refreshAppLock().catch(() => undefined);
      setBusy(false);
    }
  }

  async function toggle() {
    const turningOn = !enabled();
    const done = await run(turningOn ? enableAppLock : disableAppLock);
    // The old notice is stale once the lock is back on.
    if (done && turningOn) setAutoDisabled(false);
  }

  function saveTimeout(value: string) {
    const sec = TIMEOUTS.find((timeout) => String(timeout) === value);
    if (sec === undefined || sec === appLockState().timeoutSec) return;
    void run(() => setAppLockTimeout(sec));
  }

  return (
    <Column>
      <Show when={autoDisabled() && !enabled()}>
        <Text class="_status" size="small">
          <Trans>
            App lock was turned off because this phone no longer has a screen
            lock.
          </Trans>
        </Text>
      </Show>
      <CategoryButton.Group>
        <CategoryButton
          action={<Checkbox checked={enabled()} disabled={busy()} />}
          disabled={busy()}
          onClick={() => void toggle()}
          icon={<Symbol>lock</Symbol>}
          description={<Trans>This device only</Trans>}
        >
          <Trans>App lock</Trans>
        </CategoryButton>
        <Show when={enabled() && platform === "android"}>
          <CategoryButton
            action={
              <Checkbox
                checked={appLockState().hideNotificationText}
                disabled={busy()}
              />
            }
            disabled={busy()}
            onClick={() => {
              const hide = !appLockState().hideNotificationText;
              void run(() => setAppLockHideText(hide));
            }}
            icon={<Symbol>notifications_off</Symbol>}
          >
            <Trans>Hide message text in notifications</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
      <Show when={enabled()}>
        <FloatingSelect
          label={t`Lock the app`}
          value={String(appLockState().timeoutSec)}
          disabled={busy()}
          onChange={(event) => saveTimeout(event.currentTarget.value ?? "")}
        >
          <MenuItem value="0">
            <Trans>Immediately</Trans>
          </MenuItem>
          <MenuItem value="60">
            <Trans>After 1 minute</Trans>
          </MenuItem>
          <MenuItem value="900">
            <Trans>After 15 minutes</Trans>
          </MenuItem>
        </FloatingSelect>
      </Show>
      <Show when={platform === "ios"}>
        <Text class="_status" size="small">
          <Trans>
            To hide message text on the lock screen, open iPhone Settings, then
            Notifications, Sloga, Show Previews.
          </Trans>
        </Text>
      </Show>
      <Column gap="sm">
        <Text class="_status" size="small">
          <Trans>
            It stops someone holding your unlocked phone from opening Sloga and
            reading your chats.
          </Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>It hides Sloga in the recent apps switcher.</Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>
            It is not extra encryption. Messages are stored on the phone exactly
            as before.
          </Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>It does not stop someone who knows your phone passcode.</Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>It does not hide notifications by itself.</Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>A call can be answered without unlocking.</Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>
            Anyone holding the phone can press Sign out on the lock screen. That
            signs you out. It does not let them in.
          </Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>
            It does not protect against a hacked or rooted phone or forensic
            tools.
          </Trans>
        </Text>
        <Text class="_status" size="small">
          <Trans>It changes nothing on your other devices.</Trans>
        </Text>
      </Column>
    </Column>
  );
}

const TIMEOUTS: readonly AppLockTimeout[] = [0, 60, 900];

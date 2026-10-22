import { Show, createSignal, onMount } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import * as mainShell from "@revolt/client/mainShell";
import { tauriInvoke } from "@revolt/common";
import { CategoryButton, Checkbox, Column } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

declare type DesktopConfig = {
  firstLaunch: boolean;
  customFrame: boolean;
  minimiseToTray: boolean;
  startMinimisedToTray: boolean;
  spellchecker: boolean;
  hardwareAcceleration: boolean;
  discordRpc: boolean;
  windowState: {
    isMaximised: boolean;
  };
};

declare global {
  interface Window {
    native: {
      versions: {
        node(): string;
        chrome(): string;
        electron(): string;
        desktop(): string;
      };
      minimise(): void;
      maximise(): void;
      close(): void;
      onceScreenPicker(
        onScreenPick: (
          sources: {
            idx: number;
            name: string;
            isFullScreen: boolean;
            image?: string;
          }[],
        ) => void,
      ): void;
      screenPickerCallback(idx: number, audio: boolean): void;
    };

    desktopConfig: {
      get(): DesktopConfig;
      set(config: Partial<DesktopConfig>): void;
      getAutostart(): Promise<boolean>;
      setAutostart(value: boolean): Promise<boolean>;
    };
  }
}

/**
 * Desktop Configuration Page — routes to the shell that is actually
 * hosting us. The Windows (Tauri) shell has no `window.desktopConfig`;
 * its only setting is autostart, over the command bridge.
 */
export default function Native() {
  return tauriInvoke() ? <TauriNative /> : <ElectronNative />;
}

/**
 * Reply from `multi_instance_get`/`_set`. `slot` is this window's own —
 * 1 for the first Sloga launched, 2 for the next — and does not change
 * until relaunch, because the shell fixes it before the window exists.
 */
declare type MultiInstanceState = {
  supported: boolean;
  enabled: boolean;
  slot: number;
};

/**
 * Windows (Tauri) shell settings. The OS launch entry is the source of
 * truth for autostart (default off) — the same state the tray's "Start
 * with Windows" item toggles, so the shell keeps the two in sync.
 */
function TauriNative() {
  const invoke = tauriInvoke()!;
  const [autostart, setAutostart] = createSignal(false);
  const [multi, setMulti] = createSignal<MultiInstanceState>({
    // Until the shell answers, assume unsupported: the row stays hidden
    // rather than flashing a checkbox an older shell cannot honor.
    supported: false,
    enabled: false,
    slot: 0,
  });

  // null until the shell answers, and for good on a shell without the
  // setting: the row stays hidden rather than offering a choice it ignores.
  const [systemFrameOn, setSystemFrameOn] = createSignal<boolean | null>(null);
  const [systemFrameFailed, setSystemFrameFailed] = createSignal(false);

  onMount(async () => {
    try {
      setAutostart(await invoke<boolean>("autostart_get"));
    } catch (err) {
      console.error("[native-settings] autostart_get failed:", err);
    }

    try {
      setMulti(await invoke<MultiInstanceState>("multi_instance_get"));
    } catch (err) {
      console.error("[native-settings] multi_instance_get failed:", err);
    }

    setSystemFrameOn(await mainShell.systemFrame());
  });

  /** A write in flight: a second click waits for it rather than racing. */
  let savingSystemFrame = false;

  async function toggleSystemFrame() {
    const current = systemFrameOn();
    if (current === null || savingSystemFrame) return;
    savingSystemFrame = true;
    setSystemFrameFailed(false);
    try {
      if (await mainShell.setSystemFrame(!current)) {
        setSystemFrameOn(!current);
      } else {
        // Show what the shell actually has stored, and say it did not save.
        // A re-read that fails too keeps the previous value: null would
        // hide the row, and the error with it.
        setSystemFrameOn((await mainShell.systemFrame()) ?? current);
        setSystemFrameFailed(true);
      }
    } finally {
      savingSystemFrame = false;
    }
  }

  async function toggleAutostart() {
    try {
      // The command returns the RESULTING state — unchanged on failure.
      setAutostart(
        await invoke<boolean>("autostart_set", { enabled: !autostart() }),
      );
    } catch (err) {
      console.error("[native-settings] autostart_set failed:", err);
    }
  }

  async function toggleMultiInstance() {
    try {
      // As above: the RESULTING state, so a write that failed leaves the
      // checkbox showing what is actually on disk.
      setMulti(
        await invoke<MultiInstanceState>("multi_instance_set", {
          enabled: !multi().enabled,
        }),
      );
    } catch (err) {
      console.error("[native-settings] multi_instance_set failed:", err);
    }
  }

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <CategoryButton
          action={<Checkbox checked={autostart()} />}
          onClick={toggleAutostart}
          icon={<Symbol>exit_to_app</Symbol>}
          description={
            <Trans>Launch Sloga when you log into your computer.</Trans>
          }
        >
          <Trans>Start with Computer</Trans>
        </CategoryButton>
        <Show when={multi().supported}>
          <CategoryButton
            action={<Checkbox checked={multi().enabled} />}
            onClick={toggleMultiInstance}
            icon={<Symbol>filter_none</Symbol>}
            description={
              <Trans>
                Open Sloga more than once to use a second account. Takes
                effect next time you launch; the first window you open is
                always your main account.
              </Trans>
            }
          >
            <Trans>Allow Multiple Instances</Trans>
          </CategoryButton>
        </Show>
        <Show when={systemFrameOn() !== null}>
          <CategoryButton
            action={<Checkbox checked={systemFrameOn() === true} />}
            onClick={() => void toggleSystemFrame()}
            icon={<Symbol>web_asset</Symbol>}
            description={
              <Show
                when={systemFrameFailed()}
                fallback={
                  <Trans>
                    Applies after you quit Sloga from the tray and open it
                    again.
                  </Trans>
                }
              >
                <Trans>Could not save this setting. Try again.</Trans>
              </Show>
            }
          >
            <Trans>Use the Windows title bar</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
    </Column>
  );
}

/**
 * Electron shell settings (legacy Revolt surface).
 */
function ElectronNative() {
  const { t } = useLingui();
  const [autostart, setAutostart] = createSignal(false);
  const [config, setConfig] = createSignal(window.desktopConfig.get());

  function set(config: Partial<DesktopConfig>) {
    window.desktopConfig.set(config);
    setConfig((conf) => ({ ...conf, ...config }));
  }

  onMount(async () => {
    const value = await window.desktopConfig.getAutostart();
    setAutostart(value);
  });

  async function toggleAutostart() {
    const newValue = !autostart();
    const savedValue = await window.desktopConfig.setAutostart(newValue);
    setAutostart(savedValue);
  }

  const toggles: Partial<Record<keyof DesktopConfig, () => void>> = {
    minimiseToTray: () => set({ minimiseToTray: !config().minimiseToTray }),
    startMinimisedToTray: () =>
      set({ startMinimisedToTray: !config().startMinimisedToTray }),
    customFrame: () => set({ customFrame: !config().customFrame }),
    discordRpc: () => set({ discordRpc: !config().discordRpc }),
    spellchecker: () => set({ spellchecker: !config().spellchecker }),
    hardwareAcceleration: () =>
      set({ hardwareAcceleration: !config().hardwareAcceleration }),
  };

  function CheckboxButton<K extends keyof Omit<DesktopConfig, "windowState">>(
    key: K,
    icon: string,
    label: string,
    description: string,
  ) {
    return (
      <CategoryButton
        action={<Checkbox checked={config()[key]} />}
        onClick={toggles[key]}
        icon={<Symbol>{icon}</Symbol>}
        description={description}
      >
        {label}
      </CategoryButton>
    );
  }

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <CategoryButton
          action={<Checkbox checked={autostart()} />}
          onClick={toggleAutostart}
          icon={<Symbol>exit_to_app</Symbol>}
          description={
            <Trans>Launch Sloga when you log into your computer.</Trans>
          }
        >
          <Trans>Start with Computer</Trans>
        </CategoryButton>
        {autostart() &&
          CheckboxButton(
            "startMinimisedToTray",
            "minimize",
            t`Start Minimized to Tray`,
            t`Sloga will start in the system tray.`,
          )}
        {CheckboxButton(
          "minimiseToTray",
          "cancel_presentation",
          t`Minimize to Tray`,
          t`Instead of closing, Sloga will hide in your tray.`,
        )}
        {CheckboxButton(
          "customFrame",
          "web_asset",
          t`Custom window frame`,
          t`Let Sloga use its own custom titlebar.`,
        )}
      </CategoryButton.Group>

      <CategoryButton.Group>
        {CheckboxButton(
          "discordRpc",
          "groups_2",
          t`Discord RPC`,
          t`Rep Sloga using Discord rich presence.`,
        )}
        {CheckboxButton(
          "spellchecker",
          "spellcheck",
          t`Spellchecker`,
          t`Show corrections and suggestions as you type.`,
        )}
        {CheckboxButton(
          "hardwareAcceleration",
          "speed",
          t`Hardware Acceleration`,
          t`Use the graphics card to improve performance.`,
        )}
      </CategoryButton.Group>

      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>desktop_windows</Symbol>}
          description={
            <>
              <Trans>Version:</Trans> {window.native.versions.desktop()}
            </>
          }
        >
          <Trans>Sloga for Desktop</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}

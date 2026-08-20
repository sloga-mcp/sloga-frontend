import { For, Show, createSignal, onCleanup } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { JellyfinApi, JfError } from "./providers/jellyfin/api";
import {
  TLS_ERROR_STATUS,
  normalizeServerUrl,
  statusText,
} from "./providers/jellyfin/jellyfinWire";
import { type SavedServer, listServers, saveServer } from "./providers/jellyfin/servers";
import {
  PROBE_SERVER_ID,
  clearProbeServer,
  registerProbeServer,
  registerServers,
  shellKind,
  transportProblem,
} from "./providers/jellyfin/transport";

/**
 * Add a Jellyfin server + sign in (plan §5.1). Quick Connect first (it is ON
 * by default on current Jellyfin — §7.1), password as the fallback. Every
 * request goes straight to the user's OWN server; Sloga never brokers the
 * credential and never sees the password (Quick Connect) or stores it
 * (password path — only the returned token is kept, per-device, §5.2).
 *
 * `onDone(server)` fires with the saved server once authenticated.
 */
export function JellyfinConnect(props: {
  onDone: (server: SavedServer) => void;
  onCancel: () => void;
  /** Pre-fill for the "sign in to {server}" path from a running session. */
  prefillUrl?: string;
}) {
  const { t } = useLingui();

  const [step, setStep] = createSignal<"url" | "method" | "quick" | "password">("url");
  const [rawUrl, setRawUrl] = createSignal(props.prefillUrl ?? "");
  const [server, setServer] = createSignal<{ name: string; id: string; baseUrl: string } | undefined>();
  const [quickEnabled, setQuickEnabled] = createSignal(false);
  const [quickCode, setQuickCode] = createSignal<string | undefined>();
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  // Per-server cert trust (plan §7.3 4e, the item-10 decision). `trusted`
  // is the user's explicit choice for THIS typed address; `tlsOffer` shows
  // the affordance and only ever turns on for the shell-reported TLS
  // status — a typo'd port or sleeping NAS is a plain error, never an
  // invitation to trust-click. Web can't skip cert validation, so the
  // offer never appears there.
  const [trusted, setTrusted] = createSignal(false);
  const [tlsOffer, setTlsOffer] = createSignal(false);

  let quickPoll: ReturnType<typeof setInterval> | undefined;
  const stopQuickPoll = () => {
    if (quickPoll) clearInterval(quickPoll);
    quickPoll = undefined;
  };
  // Leaving the Quick Connect screen must always kill its poll — "Back"
  // then a second "Use Quick Connect" would otherwise leave the first
  // interval polling a stale secret forever.
  const goToStep = (s: "url" | "method" | "quick" | "password") => {
    stopQuickPoll();
    setStep(s);
  };
  onCleanup(() => {
    stopQuickPoll();
    // Drop the provisional probe entry from the shell's forwarding table
    // whether the flow finished or was abandoned mid-way.
    clearProbeServer();
    void registerServers(listServers());
  });

  // Pre-save calls (probe, Quick Connect, password auth) ride the
  // provisional PROBE_SERVER_ID that probe() registered with the shell.
  const bareApi = (baseUrl: string) =>
    new JellyfinApi({ id: PROBE_SERVER_ID, name: "", baseUrl, token: "", userId: "" });

  const errText = (e: unknown): string => {
    if (e instanceof JfError) return statusText(e.status);
    return e instanceof Error ? e.message : t`Something went wrong`;
  };

  async function probe() {
    const base = normalizeServerUrl(rawUrl());
    if (!base) {
      setError(t`That doesn't look like a server address.`);
      return;
    }
    const problem = transportProblem(base);
    if (problem === "mixed-content") {
      setError(
        t`This is an http:// server on a page served over https. Use the Sloga desktop app for a LAN or http server, or put your Jellyfin behind https.`,
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    setTlsOffer(false);
    try {
      // The server isn't saved yet, so a native shell's forwarder doesn't
      // know it — register the typed URL provisionally first (viewer-
      // initiated contact: they typed it and clicked Connect, §5.1). The
      // trust choice rides the probe entry so the whole pre-save flow
      // (probe, Quick Connect, password auth) honors it.
      await registerProbeServer(base, listServers(), trusted());
      const info = await JellyfinApi.probe(base);
      setServer({ name: info.ServerName, id: info.Id, baseUrl: base });
      let qc = false;
      try {
        qc = await bareApi(base).quickConnectEnabled();
      } catch {
        qc = false;
      }
      setQuickEnabled(qc);
      goToStep("method");
    } catch (e) {
      if (
        e instanceof JfError &&
        e.status === TLS_ERROR_STATUS &&
        !trusted() &&
        shellKind() !== "web" &&
        base.startsWith("https://")
      ) {
        setTlsOffer(true);
        setError(undefined);
      } else {
        setError(errText(e));
      }
    } finally {
      setBusy(false);
    }
  }

  function trustAndRetry() {
    setTrusted(true);
    setTlsOffer(false);
    void probe();
  }

  async function startQuickConnect() {
    const s = server();
    if (!s) return;
    setBusy(true);
    setError(undefined);
    goToStep("quick");
    try {
      const api = bareApi(s.baseUrl);
      const init = await api.quickConnectInitiate();
      setQuickCode(init.Code);
      quickPoll = setInterval(async () => {
        let approved = false;
        try {
          const state = await api.quickConnectState(init.Secret);
          approved = state.Authenticated;
        } catch {
          /* keep polling; the user may not have approved yet */
          return;
        }
        if (!approved) return;
        stopQuickPoll();
        try {
          const auth = await api.authenticateWithQuickConnect(init.Secret);
          await finish(s, auth.AccessToken, auth.User.Id);
        } catch (e) {
          // Post-approval failure is terminal for this code — dead-ending
          // silently on the "waiting" screen would look like a hang.
          setError(errText(e));
          goToStep("method");
        }
      }, 2000);
    } catch (e) {
      setError(errText(e));
      goToStep("method");
    } finally {
      setBusy(false);
    }
  }

  async function signInPassword() {
    const s = server();
    if (!s) return;
    setBusy(true);
    setError(undefined);
    try {
      const auth = await bareApi(s.baseUrl).authenticateByName(username(), password());
      await finish(s, auth.AccessToken, auth.User.Id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish(
    s: { name: string; id: string; baseUrl: string },
    token: string,
    userId: string,
  ) {
    const saved: SavedServer = {
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      token,
      userId,
      // Only an explicit user choice ever writes trust; changing it later
      // is remove + re-add (said in the offer copy).
      ...(trusted() ? { trustSelfSigned: true } : {}),
      lastUsed: Date.now(),
    };
    saveServer(saved);
    clearProbeServer();
    await registerServers(listServers());
    props.onDone(saved);
  }

  return (
    <Box>
      <Row>
        <Symbol size={18}>dns</Symbol>
        <Title>{t`Add a Jellyfin server`}</Title>
        <Spacer />
        <IconButton size="xs" variant="tonal" onPress={props.onCancel}>
          <Symbol>close</Symbol>
        </IconButton>
      </Row>

      <Show when={step() === "url"}>
        <Field>
          <Label>{t`Server address`}</Label>
          <Input
            type="url"
            placeholder="http://192.168.1.10:8096"
            value={rawUrl()}
            onInput={(e) => {
              setRawUrl(e.currentTarget.value);
              // Trust is per typed address — editing it revokes the choice.
              setTrusted(false);
              setTlsOffer(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && void probe()}
            autofocus
          />
          <Hint>{t`Sloga connects your device straight to your server. It never sees or stores your Jellyfin password.`}</Hint>
        </Field>
        <Button variant="filled" isDisabled={busy()} onPress={() => void probe()}>
          {t`Connect`}
        </Button>
      </Show>

      <Show when={step() === "method" && server()}>
        {(s) => (
          <>
            <Found>{t`Connected to ${s().name}`}</Found>
            <Show when={quickEnabled()}>
              <Button variant="filled" isDisabled={busy()} onPress={() => void startQuickConnect()}>
                <Symbol>key</Symbol>
                {t`Use Quick Connect`}
              </Button>
            </Show>
            <Button variant="secondary" onPress={() => goToStep("password")}>
              {t`Sign in with a password`}
            </Button>
          </>
        )}
      </Show>

      <Show when={step() === "quick"}>
        <Found>{t`Open Jellyfin on your phone or another device and enter this code:`}</Found>
        <Code>{quickCode() ?? "…"}</Code>
        <Hint>{t`Waiting for you to approve it in your Jellyfin app…`}</Hint>
        <Button variant="secondary" onPress={() => goToStep("method")}>
          {t`Back`}
        </Button>
      </Show>

      <Show when={step() === "password" && server()}>
        {(s) => (
          <>
            <Field>
              <Label>{t`Username`}</Label>
              <Input value={username()} onInput={(e) => setUsername(e.currentTarget.value)} autofocus />
            </Field>
            <Field>
              <Label>{t`Password`}</Label>
              <Input
                type="password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && void signInPassword()}
              />
              <Hint>{t`Sent only to ${s().name}, never to Sloga.`}</Hint>
            </Field>
            <Button variant="filled" isDisabled={busy()} onPress={() => void signInPassword()}>
              {t`Sign in`}
            </Button>
          </>
        )}
      </Show>

      <Show when={tlsOffer()}>
        <ErrorNote>
          {t`This server's certificate can't be verified. Only trust it if this is your own server — a changed certificate can also mean someone is intercepting the connection. Trust applies to this device only; to undo it later, remove the server and add it again.`}
        </ErrorNote>
        <Button variant="secondary" isDisabled={busy()} onPress={trustAndRetry}>
          <Symbol>gpp_maybe</Symbol>
          {t`Trust this server's certificate`}
        </Button>
      </Show>

      <Show when={error()}>
        <ErrorNote>{error()}</ErrorNote>
      </Show>
    </Box>
  );
}

const Box = styled("div", {
  base: { display: "flex", flexDirection: "column", gap: "var(--gap-md)", maxWidth: "44ch", margin: "auto", width: "100%" },
});
const Row = styled("div", { base: { display: "flex", alignItems: "center", gap: "var(--gap-sm)" } });
const Title = styled("span", { base: { fontWeight: 600 } });
const Spacer = styled("span", { base: { flex: "1 1 auto" } });
const Field = styled("label", { base: { display: "flex", flexDirection: "column", gap: "4px" } });
const Label = styled("span", { base: { fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" } });
const Found = styled("p", { base: { fontSize: "14px", fontWeight: 500 } });
const Hint = styled("span", { base: { fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" } });
const Code = styled("div", {
  base: {
    fontSize: "28px",
    fontWeight: 700,
    letterSpacing: "0.15em",
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
    padding: "var(--gap-sm)",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
  },
});
const Input = styled("input", {
  base: {
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "14px",
  },
});
const ErrorNote = styled("div", {
  base: {
    fontSize: "12px",
    padding: "6px 8px",
    borderRadius: "6px",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});

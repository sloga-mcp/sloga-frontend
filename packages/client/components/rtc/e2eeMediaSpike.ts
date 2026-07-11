/* eslint-disable no-console */
/**
 * ============================================================================
 * E2EE MEDIA PLATFORM SPIKE — slice 6, sub-slice 6.0 — THROWAWAY CODE
 * ============================================================================
 *
 * Runtime probes for the media-E2EE GO/NO-GO gate
 * (stoatchat/docs/e2ee-media-mls-plan.md §8, sub-slice 6.0):
 *
 *   P1  isE2EESupported() / RTCRtpScriptTransform / createEncodedStreams
 *       availability in the actual desktop WebView2 shell (plan §7.1 Q1)
 *   P2  module-worker load of the Vite `?worker`-bundled LiveKit E2EE worker
 *   P3  the REAL BaseKeyProvider→worker setKey path with the exact HKDF
 *       key-MATERIAL import parameters (plan §4.2 — AES-GCM CryptoKey import
 *       is the documented failure mode this probe exists to rule out)
 *   P4  mid-call Room.setE2EEEnabled(true/false) toggling on an
 *       E2EE-constructed Room (plan §3.4 mode transitions)
 *   P5  static-key two-desktop E2EE call: media decrypts both ways
 *       (framesDecoded advancing + participantEncryptionStatusChanged), and
 *       a WRONG-key negative control proves frames are really ciphertext.
 *
 * Arming: localStorage.SPIKE_MEDIA_E2EE = "A" (shared test key) or
 * "B" (deliberately wrong key, negative control). Overlay UI (dev builds
 * only) arms/disarms and drives the toggles; probe evidence is POSTed to the
 * Vite dev server at /__e2ee_spike_report (see vite.config.ts sink).
 *
 * This file is DELETED at the end of sub-slice 6.0 — none of it is the real
 * implementation (that is 6.2/6.3: MlsKeyProvider + native-derived keys).
 * Keys here are static dev constants and provide NO security.
 * ============================================================================
 */
import {
  BaseKeyProvider,
  Participant,
  Room,
  RoomEvent,
  isE2EESupported,
} from "livekit-client";
// Static `?worker` import on purpose: proving this exact bundling path works
// (self-hosted worker asset, no CDN) is probe P2.
import E2EEWorker from "livekit-client/e2ee-worker?worker";

type SpikeEvent = { t: number; type: string; detail?: unknown };

interface SpikeReport {
  bootId: string;
  startedAt: string;
  origin: string;
  userAgent: string;
  isTauri: boolean;
  keyVariant: string | null;
  localIdentity?: string;
  probes: Record<string, unknown>;
  encryptionStatus: Record<string, boolean>;
  keyOrder: string[];
  toggles: SpikeEvent[];
  events: SpikeEvent[];
  errors: SpikeEvent[];
  stats?: unknown;
}

const ARM_KEY = "SPIKE_MEDIA_E2EE";
const MAX_EVENTS = 200;

function now() {
  return Math.round(performance.now());
}

/** 32 bytes of deterministic dev-only key material per variant. */
async function keyBytes(variant: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`sloga-media-e2ee-spike-6.0:${variant}`),
  );
}

/**
 * Exercises the exact provider shape planned for MlsKeyProvider (§4.2):
 * per-participant keys (sharedKey:false), no ratchet, fail fast, and
 * onSetEncryptionKey() fed HKDF key MATERIAL — never an AES-GCM CryptoKey.
 */
class SpikeKeyProvider extends BaseKeyProvider {
  #variant: string;

  constructor(variant: string) {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });
    this.#variant = variant;
  }

  async applyFor(identity: string, keyIndex = 0) {
    const material = await crypto.subtle.importKey(
      "raw",
      await keyBytes(this.#variant),
      "HKDF",
      false,
      ["deriveBits", "deriveKey"],
    );
    this.onSetEncryptionKey(material, identity, keyIndex);
  }
}

class MediaE2EESpike {
  report: SpikeReport;
  #provider?: SpikeKeyProvider;
  #worker?: Worker;
  #room?: Room;
  #statsTimer?: ReturnType<typeof setInterval>;
  #postTimer?: ReturnType<typeof setInterval>;
  #panel?: HTMLDivElement;
  #panelBody?: HTMLDivElement;

  constructor() {
    this.report = {
      bootId: Math.random().toString(36).slice(2, 8),
      startedAt: new Date().toISOString(),
      origin: location.origin,
      userAgent: navigator.userAgent,
      isTauri: !!(window as { __TAURI__?: unknown }).__TAURI__,
      keyVariant: this.variant(),
      probes: {},
      encryptionStatus: {},
      keyOrder: [],
      toggles: [],
      events: [],
      errors: [],
    };
  }

  variant(): string | null {
    try {
      return localStorage.getItem(ARM_KEY);
    } catch {
      return null;
    }
  }

  #record(type: string, detail?: unknown, bucket: SpikeEvent[] = this.report.events) {
    bucket.push({ t: now(), type, detail });
    if (bucket.length > MAX_EVENTS) bucket.splice(0, bucket.length - MAX_EVENTS);
    console.info(`[e2ee-spike] ${type}`, detail ?? "");
  }

  /** P1 + P2 + P3(import half): environment probes, safe to run any time. */
  async runProbes() {
    const p = this.report.probes;
    p.origin = location.origin;
    p.isE2EESupported = isE2EESupported();
    p.rtcRtpScriptTransform = "RTCRtpScriptTransform" in window;
    p.createEncodedStreams =
      typeof RTCRtpSender !== "undefined" &&
      "createEncodedStreams" in RTCRtpSender.prototype;
    p.mediaStreamTrackProcessor = "MediaStreamTrackProcessor" in window;
    p.crossOriginIsolated = self.crossOriginIsolated;

    // P2: does the bundled module worker load in this origin? A script/parse
    // failure fires `error` on the Worker object; give it a moment.
    p.moduleWorkerLoad = await new Promise<string>((resolvePromise) => {
      try {
        const w = new E2EEWorker();
        const timer = setTimeout(() => {
          resolvePromise("loaded (no error event within 2000ms)");
          w.terminate();
        }, 2000);
        w.addEventListener("error", (event) => {
          clearTimeout(timer);
          resolvePromise(`ERROR: ${(event as ErrorEvent).message ?? "worker error"}`);
          w.terminate();
        });
      } catch (error) {
        resolvePromise(`THREW: ${error}`);
      }
    });

    // P3 (webview half): the exact import + derive the LiveKit worker performs
    // internally (setKeyFromMaterial → deriveKeys: HKDF → AES-GCM-128).
    try {
      const material = await crypto.subtle.importKey(
        "raw",
        await keyBytes("probe"),
        "HKDF",
        false,
        ["deriveBits", "deriveKey"],
      );
      await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          salt: new TextEncoder().encode("LKFrameEncryptionKey"),
          hash: "SHA-256",
          info: new ArrayBuffer(128),
        },
        material,
        { name: "AES-GCM", length: 128 },
        false,
        ["encrypt", "decrypt"],
      );
      p.hkdfImportDerive = "ok";
    } catch (error) {
      p.hkdfImportDerive = `FAILED: ${error}`;
    }

    // Negative control (§4.2 audit-HIGH): passing an AES-GCM CryptoKey where
    // the worker expects HKDF material must throw InvalidAccessError. Archived
    // here so the headline negative result is captured through the sink.
    try {
      const badKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(16),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
      await crypto.subtle.deriveKey(
        { name: "HKDF", salt: new Uint8Array(16), hash: "SHA-256", info: new ArrayBuffer(128) },
        badKey as unknown as CryptoKey,
        { name: "AES-GCM", length: 128 },
        false,
        ["encrypt", "decrypt"],
      );
      p.aesGcmAsMaterial = "UNEXPECTEDLY OK";
    } catch (error) {
      p.aesGcmAsMaterial = `throws (expected): ${(error as Error).name}`;
    }

    this.#record("probes-complete", p);
    this.post("probes");
    this.#refreshPanel();
  }

  /**
   * Called at the Room construction site. Returns the `e2ee` Room option when
   * armed, else undefined (spike fully inert).
   */
  roomE2EEOptions(): { keyProvider: BaseKeyProvider; worker: Worker } | undefined {
    const variant = this.variant();
    if (!variant) return undefined;
    this.report.keyVariant = variant;
    this.#provider = new SpikeKeyProvider(variant);
    this.#worker = new E2EEWorker();
    this.#record("room-constructed-with-e2ee", { variant });
    return { keyProvider: this.#provider, worker: this.#worker };
  }

  /** Wire probes + evidence collection onto the Room. No-op unless armed. */
  attach(room: Room) {
    void this.runProbes();
    if (!this.#provider) return;
    this.#room = room;

    room.on(
      RoomEvent.ParticipantEncryptionStatusChanged,
      (encrypted: boolean, participant?: Participant) => {
        const id = participant?.identity ?? "(local)";
        this.report.encryptionStatus[id] = encrypted;
        this.#record("encryption-status", { id, encrypted });
      },
    );
    room.on(RoomEvent.EncryptionError, (error: Error) => {
      this.#record("encryption-error", String(error), this.report.errors);
    });
    room.on(RoomEvent.ParticipantConnected, (p) => {
      void this.#applyKey(p.identity);
    });
    room.on(RoomEvent.Connected, () => {
      void this.#onConnected();
    });
    room.on(RoomEvent.Disconnected, () => this.post("disconnected"));

    // Pre-connect enable: the option was passed at construction, so this must
    // resolve. (The mid-call §3.4 toggle is exercised separately via the
    // overlay buttons — that is probe P4.)
    room
      .setE2EEEnabled(true)
      .then(() => this.#record("setE2EEEnabled(true) pre-connect ok"))
      .catch((error) =>
        this.#record("setE2EEEnabled(true) pre-connect THREW", String(error), this.report.errors),
      );

    this.#statsTimer = setInterval(() => void this.#sampleStats(), 3000);
    this.#postTimer = setInterval(() => this.post("periodic"), 10000);
    this.#renderPanel();
  }

  async #onConnected() {
    const room = this.#room;
    if (!room || !this.#provider) return;
    this.report.localIdentity = room.localParticipant.identity;
    // Plan §4.2 ordering: remote senders first, local participant LAST.
    for (const p of room.remoteParticipants.values()) {
      await this.#applyKey(p.identity);
    }
    await this.#applyKey(room.localParticipant.identity);
    this.#record("keys-applied", this.report.keyOrder);
    this.post("connected");
  }

  async #applyKey(identity: string) {
    try {
      await this.#provider!.applyFor(identity);
      this.report.keyOrder.push(identity);
      this.#record("setKey", { identity });
    } catch (error) {
      this.#record("setKey THREW", { identity, error: String(error) }, this.report.errors);
    }
  }

  /**
   * P3-real-path + P4, deterministic and server-free: construct an actual
   * E2EE-capable Room in this WebView2 shell, run the real
   * BaseKeyProvider→worker setKey path (HKDF material), and toggle
   * setE2EEEnabled off/on. Proves the platform executes the media-E2EE
   * control path without needing an SFU or a second account. Returns a
   * structured evidence object.
   */
  async probeRoomLifecycle() {
    const result: Record<string, unknown> = { t: now() };
    let room: Room | undefined;
    try {
      const provider = new SpikeKeyProvider("A");
      const worker = new E2EEWorker();
      room = new Room({ e2ee: { keyProvider: provider, worker } });
      result.roomConstructedWithE2EE = "ok";

      const encEvents: Array<{ id: string; encrypted: boolean }> = [];
      room.on(
        RoomEvent.ParticipantEncryptionStatusChanged,
        (encrypted: boolean, p?: Participant) =>
          encEvents.push({ id: p?.identity ?? "(local)", encrypted }),
      );
      const errEvents: string[] = [];
      room.on(RoomEvent.EncryptionError, (e: Error) => errEvents.push(String(e)));

      // The real §4.2 setKey path: HKDF key MATERIAL → onSetEncryptionKey.
      // (localParticipant.identity is empty pre-connect, so use a literal —
      // this exercises the exact importKey/onSetEncryptionKey call.)
      const testIdentity =
        room.localParticipant.identity || "spike-local-device";
      await provider.applyFor(testIdentity);
      result.keyProviderSetKey = "ok (no InvalidAccessError)";

      // P4: enable → the worker receives the key set and arms the transform.
      await room.setE2EEEnabled(true);
      result.setE2EEEnabledTrue = "ok";
      result.isE2EEEnabledAfterTrue = room.isE2EEEnabled;

      // Mid-lifecycle toggle off then back on (§3.4 mode transitions).
      await room.setE2EEEnabled(false);
      result.setE2EEEnabledFalse = "ok";
      result.isE2EEEnabledAfterFalse = room.isE2EEEnabled;
      await room.setE2EEEnabled(true);
      result.setE2EEEnabledReenable = "ok";
      result.isE2EEEnabledAfterReenable = room.isE2EEEnabled;

      result.encryptionStatusEvents = encEvents;
      result.encryptionErrors = errEvents;
      result.providerKeyCount = provider.getKeys().length;
    } catch (error) {
      result.error = String(error);
    } finally {
      try {
        room?.disconnect();
      } catch {
        /* not connected */
      }
    }
    this.report.probes.roomLifecycle = result;
    this.#record("room-lifecycle-probe", result);
    this.post("room-lifecycle");
    this.#refreshPanel();
    return result;
  }

  /** P4: mid-call setE2EEEnabled toggle, driven from the overlay. */
  async toggle(enabled: boolean) {
    const room = this.#room;
    if (!room) return;
    const entry: SpikeEvent = { t: now(), type: `setE2EEEnabled(${enabled})` };
    try {
      await room.setE2EEEnabled(enabled);
      entry.detail = "ok";
    } catch (error) {
      entry.detail = `THREW: ${error}`;
    }
    this.report.toggles.push(entry);
    this.#record("toggle", entry);
    this.post("toggle");
  }

  async #sampleStats() {
    const room = this.#room;
    if (!room) return;
    const pickNumeric = (s: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const k of [
        "framesEncoded",
        "framesDecoded",
        "framesDropped",
        "framesReceived",
        "packetsSent",
        "packetsReceived",
        "packetsLost",
        "totalSamplesReceived",
        "totalAudioEnergy",
        "bytesSent",
        "bytesReceived",
      ]) {
        if (k in s) out[k] = s[k];
      }
      return out;
    };
    const summarize = async (
      track: { getRTCStatsReport?: () => Promise<RTCStatsReport | undefined> } | undefined,
      wanted: string,
    ) => {
      try {
        const stats = await track?.getRTCStatsReport?.();
        if (!stats) return undefined;
        for (const value of stats.values()) {
          if (value.type === wanted) return pickNumeric(value);
        }
      } catch {
        return undefined;
      }
    };

    const sample: Record<string, unknown> = { t: now() };
    const local: Record<string, unknown> = {};
    for (const pub of room.localParticipant.trackPublications.values()) {
      if (pub.track)
        local[`${pub.source}`] = await summarize(pub.track, "outbound-rtp");
    }
    sample.local = local;
    const remotes: Record<string, unknown> = {};
    for (const p of room.remoteParticipants.values()) {
      const perTrack: Record<string, unknown> = {};
      for (const pub of p.trackPublications.values()) {
        if (pub.track)
          perTrack[`${pub.source}`] = await summarize(pub.track, "inbound-rtp");
      }
      remotes[p.identity] = perTrack;
    }
    sample.remotes = remotes;
    this.report.stats = sample;
    this.#refreshPanel();
  }

  detach() {
    if (!this.#provider && !this.#panel) return;
    clearInterval(this.#statsTimer);
    clearInterval(this.#postTimer);
    this.post("detach");
    // Plan §4.2: the worker is terminated/replaced on call end.
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#provider = undefined;
    this.#room = undefined;
    this.#record("detached (worker terminated)");
  }

  post(reason: string) {
    try {
      void fetch("/__e2ee_spike_report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, report: this.report }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* dev sink absent (production build) — overlay still shows evidence */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Overlay (plain DOM on purpose — zero footprint in the Solid tree)  */
  /* ------------------------------------------------------------------ */

  mountTrigger() {
    if (document.getElementById("e2ee-spike-chip")) return;
    const chip = document.createElement("button");
    chip.id = "e2ee-spike-chip";
    chip.textContent = "E2EE-SPIKE";
    chip.style.cssText =
      "position:fixed;bottom:6px;left:6px;z-index:99999;font:10px monospace;" +
      "opacity:.6;background:#222;color:#8f8;border:1px solid #444;" +
      "border-radius:4px;padding:2px 6px;cursor:pointer;";
    chip.onclick = () => this.#togglePanel();
    document.body.appendChild(chip);
  }

  #togglePanel() {
    if (this.#panel) {
      this.#panel.remove();
      this.#panel = undefined;
      return;
    }
    this.#renderPanel();
    void this.runProbes();
  }

  #renderPanel() {
    if (this.#panel) return;
    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;bottom:28px;left:6px;z-index:99999;width:380px;" +
      "max-height:55vh;overflow:auto;background:rgba(10,14,20,.95);" +
      "color:#cde;font:11px/1.5 monospace;border:1px solid #345;" +
      "border-radius:6px;padding:8px;white-space:pre-wrap;";
    const bar = document.createElement("div");
    const button = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "margin:0 4px 6px 0;font:10px monospace;background:#234;color:#cde;" +
        "border:1px solid #456;border-radius:3px;padding:2px 6px;cursor:pointer;";
      b.onclick = fn;
      bar.appendChild(b);
    };
    button("ARM A", () => {
      localStorage.setItem(ARM_KEY, "A");
      this.#refreshPanel();
    });
    button("ARM B (wrong key)", () => {
      localStorage.setItem(ARM_KEY, "B");
      this.#refreshPanel();
    });
    button("DISARM", () => {
      localStorage.removeItem(ARM_KEY);
      this.#refreshPanel();
    });
    button("E2EE OFF", () => void this.toggle(false));
    button("E2EE ON", () => void this.toggle(true));
    button("POST", () => this.post("manual"));
    panel.appendChild(bar);
    const body = document.createElement("div");
    panel.appendChild(body);
    this.#panelBody = body;
    document.body.appendChild(panel);
    this.#panel = panel;
    this.#refreshPanel();
  }

  #refreshPanel() {
    if (!this.#panelBody) return;
    const r = this.report;
    const lines = [
      `armed=${this.variant() ?? "no"} attached=${!!this.#room} boot=${r.bootId}`,
      `identity=${r.localIdentity ?? "-"}`,
      `origin=${r.origin}`,
      `tauri=${r.isTauri}`,
      `probes=${JSON.stringify(r.probes, null, 1)}`,
      `encStatus=${JSON.stringify(r.encryptionStatus)}`,
      `keyOrder=${r.keyOrder.join(" → ")}`,
      `toggles=${JSON.stringify(r.toggles)}`,
      `errors(${r.errors.length})=${JSON.stringify(r.errors.slice(-3))}`,
      `stats=${JSON.stringify(r.stats, null, 1)}`,
    ];
    this.#panelBody.textContent = lines.join("\n");
  }
}

export const mediaE2EESpike = new MediaE2EESpike();

// Global handle + arming UI for the 6.0 spike, driven over CDP from the
// two-desktop harness (window.__E2EE_SPIKE__.runProbes(), .toggle(), .report).
// Gated on VITE_E2EE_SPIKE=1 ONLY — NOT import.meta.env.DEV: production
// app.sloga.gg is served by the Vite DEV server, so `import.meta.env.DEV` is
// true for live web users and would expose this to everyone (6.2b crypto gate
// finding #2). Set VITE_E2EE_SPIKE=1 to run the harness locally; prod's
// `mise dev` never sets it. Never set for a shipped build.
if (import.meta.env.VITE_E2EE_SPIKE === "1") {
  (window as unknown as { __E2EE_SPIKE__: unknown }).__E2EE_SPIKE__ =
    mediaE2EESpike;
}

// Trigger chip (same VITE_E2EE_SPIKE gate — off in prod and normal dev).
if (import.meta.env.VITE_E2EE_SPIKE === "1") {
  const mount = () => {
    try {
      mediaE2EESpike.mountTrigger();
    } catch {
      /* non-fatal */
    }
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount);
  else mount();
}

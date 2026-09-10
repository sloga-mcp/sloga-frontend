/*
 * observer-sampler.js — the 100 ms OBSERVER sampler for the consent-rejoin
 * media leak leg (rejoin-leak-plan.md §2.2 / §2.4, wave 0, lane W0-C).
 *
 * PASTE THIS INTO THE OBSERVER SEAT'S DEVTOOLS CONSOLE **BEFORE THE OBSERVER
 * JOINS THE CALL**. It hooks the RTCPeerConnection constructor; a seat that is
 * already in a call has no peer connection left to hook, and start() will
 * REFUSE to run rather than sample nothing and look green.
 *
 * ---------------------------------------------------------------------------
 * The four rules this file exists to enforce. Each one has already produced a
 * wrong answer in this slice; none of them is a style preference.
 *
 * 1. BYTES ONLY FOR "IS IT PAUSED". A held publish gate pauses through
 *    LocalTrack.pauseUpstream(), and the remote track then reads
 *    muted:false, enabled:false with ZERO RTP. Pausedness is therefore a
 *    property of the byte series and of nothing else. muted / enabled ARE
 *    recorded, but only under `annotationOnly`, and gate-trace-reduce.mjs
 *    refuses to let them reach a verdict.
 *
 * 2. CARRIER LIVENESS AND SUBJECT SILENCE COME FROM THE SAME SAMPLE. Every
 *    tick issues ONE getStats() per peer connection and emits ONE record
 *    holding every inbound-rtp row from that report, so the carrier's bytes
 *    and the subject's silence are the same observation. `sameReport` is
 *    recorded per tick. A run whose carrier byte series is not continuous
 *    across the measurement window is DISCARDED, NOT INTERPRETED — a silent
 *    mic cannot leak, and an absence with an unexplained cause is not a
 *    result. `carrierContinuity` is computed into the dump so the run is
 *    marked discarded at capture time, not argued about afterwards.
 *
 * 3. bytesReceived CAN NEVER ESTABLISH PLAINTEXT. An observer counts bytes
 *    for GCM frames too. The discriminator is audio energy: a keyless peer fed
 *    encrypted frames counts bytes while totalAudioEnergy stays FLAT and
 *    concealedSamples CLIMBS. All three are recorded in the same sample and
 *    summary() prints them as one contrast. A MISSING energy field is
 *    recorded as null and is NOT flatness — the reducer reports `unknown`.
 *
 * 4. RECORD THE SSRC. The banked leg saw a FRESH SSRC on rejoin. The SSRC
 *    change is the fiducial that aligns this series to the subject seat's
 *    [gate-trace] log, and it is the only thing separating pre-leave from
 *    post-rejoin media inside one monotonic byte counter.
 *
 * ---------------------------------------------------------------------------
 * Operator sequence (see also `launch-seats.sh steps`):
 *
 *   1. paste this file                    -> SLOGA_LEG.arm() runs on paste
 *   2. join the call as the observer
 *   3. have the CARRIER talk and the SUBJECT stay silent, then:
 *        SLOGA_LEG.roles()                -> prints the live table
 *        SLOGA_LEG.carrier("<sid|trackSid>")  pin the one with rising energy
 *   4. SLOGA_LEG.start({ label: "shapeB-consent-run1", shape: "b" })
 *   5. run the leg
 *   6. SLOGA_LEG.stop(); SLOGA_LEG.summary(); SLOGA_LEG.save()
 *
 * Role policy: the CARRIER is pinned and EVERY OTHER remote audio publication
 * is the subject. That is deliberate — the subject's participant sid AND its
 * track sid both change across a leave/rejoin (that is the defect under test),
 * so a subject pinned by sid would stop matching at the exact instant that
 * matters, while the carrier never leaves. subject() exists for the case
 * where a fourth participant is present and must be excluded.
 *
 * This file is a console script on purpose. It is never imported by the app,
 * never bundled, and is outside tsconfig.json's `include`, rtc-gate.sh's
 * prettier list and rtc-gate.sh's eslint list.
 */
(function () {
  "use strict";

  var SCHEMA = "sloga-leg-sampler/1";
  var PREV = typeof window !== "undefined" ? window.SLOGA_LEG : undefined;
  if (PREV && PREV.__running) {
    console.warn(
      "[leg-sampler] a sampler is already RUNNING — call SLOGA_LEG.stop() and dump it before re-pasting; refusing to replace it",
    );
    return;
  }

  // --- state ---------------------------------------------------------------

  var state = {
    armedAtWall: Date.now(),
    armedAtPerf: performance.now(),
    hookInstalled: false,
    pcs: [],
    pubs: new Map(),
    receivers: new Map(),
    room: null,
    roomError: null,
    carrierSel: null,
    subjectSel: null,
    ticks: [],
    notes: [],
    running: false,
    timer: null,
    intervalMs: 100,
    maxTicks: 36000,
    truncated: false,
    label: null,
    shape: null,
    seat: null,
    startedAtWall: null,
    startedAtPerf: null,
    stoppedAtWall: null,
    stoppedAtPerf: null,
    lateTicks: 0,
    statsErrors: 0,
  };

  function note(msg) {
    state.notes.push({ t: Date.now(), msg: String(msg) });
    console.warn("[leg-sampler] " + msg);
  }

  // --- RTCPeerConnection hook ----------------------------------------------

  function registerPc(pc, how) {
    if (!pc) return;
    for (var i = 0; i < state.pcs.length; i++) {
      if (state.pcs[i].pc === pc) return;
    }
    var id = "pc" + state.pcs.length;
    state.pcs.push({ pc: pc, id: id, how: how });
    try {
      pc.addEventListener("track", function (ev) {
        try {
          onTrack(id, ev);
        } catch (e) {
          note("ontrack handler threw: " + e);
        }
      });
    } catch (e2) {
      note("could not add a track listener to " + id + ": " + e2);
    }
  }

  function onTrack(pcId, ev) {
    var track = ev.track;
    if (!track || track.kind !== "audio") return;
    var streamId = ev.streams && ev.streams[0] ? ev.streams[0].id : "";
    // livekit packs the remote stream id as <participantSid>|<trackSid>
    // (unpackStreamId, livekit-client 2.15.13). Firefox packs the track id in
    // the second field instead; both halves are recorded raw either way.
    var participantSid = streamId;
    var trackSid = "";
    var sep = streamId.indexOf("|");
    if (sep >= 0) {
      participantSid = streamId.slice(0, sep);
      trackSid = streamId.slice(sep + 1);
    }
    if (ev.receiver) state.receivers.set(track.id, ev.receiver);
    var rec = {
      firstSeenWall: Date.now(),
      firstSeenPerf: performance.now(),
      pcId: pcId,
      trackId: track.id,
      streamId: streamId,
      participantSid: participantSid,
      trackSid: trackSid,
      mid: ev.transceiver ? ev.transceiver.mid : null,
      participantIdentity: null,
      trackIdentity: participantSid || track.id,
      // trackInfo.encryption: 0 NONE, 1 GCM, null unanswered/unreachable. The
      // SFU's DECLARATION — recorded, never trusted on its own, and known to
      // be able to disagree with the frames in BOTH directions.
      encryptionObservations: [],
      encryptionSource: "unreachable",
      // "lk_e2ee" in receiver — livekit sets this once it has TRANSFERRED the
      // encoded streams to its own worker, i.e. when a decode transform is
      // installed on this receiver. On a manager-free (shape b) seat this must
      // read false; if it reads true the seat is NOT manager-free and its
      // audio energy is evidence in neither direction.
      lkE2eeFlagFirstSeen: probeLkFlag(track.id),
    };
    state.pubs.set(track.id, rec);
    console.info(
      "[leg-sampler] remote audio track: participantSid=" +
        participantSid +
        " trackSid=" +
        trackSid +
        " trackId=" +
        track.id +
        " lk_e2ee=" +
        rec.lkE2eeFlagFirstSeen,
    );
  }

  function probeLkFlag(trackId) {
    var r = state.receivers.get(trackId);
    if (!r) return null;
    try {
      return "lk_e2ee" in r;
    } catch (e) {
      return null;
    }
  }

  function installHook() {
    if (state.hookInstalled) return;
    var Real = window.RTCPeerConnection;
    if (typeof Real !== "function") {
      note("no window.RTCPeerConnection — cannot arm");
      return;
    }
    if (Real.__slogaLegWrapped) {
      state.hookInstalled = true;
      Real.__slogaLegRegister = registerPc;
      note("RTCPeerConnection was already wrapped by an earlier paste; the new sampler took over the wrapper");
      return;
    }
    var Wrapped = function () {
      var pc = new (Function.prototype.bind.apply(Real, [null].concat(Array.prototype.slice.call(arguments))))();
      try {
        (Wrapped.__slogaLegRegister || registerPc)(pc, "constructor-hook");
      } catch (e) {
        /* instrumentation must never break the app under test */
      }
      return pc;
    };
    Wrapped.prototype = Real.prototype;
    Object.setPrototypeOf(Wrapped, Real);
    Wrapped.__slogaLegWrapped = true;
    Wrapped.__slogaLegRegister = registerPc;
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection === Real) {
      window.webkitRTCPeerConnection = Wrapped;
    }
    state.hookInstalled = true;
  }

  // --- roles ---------------------------------------------------------------

  function matches(rec, sel) {
    if (!sel) return false;
    var s = String(sel);
    return (
      rec.trackId === s ||
      rec.participantSid === s ||
      rec.trackSid === s ||
      (rec.participantIdentity && rec.participantIdentity === s) ||
      (rec.participantSid && rec.participantSid.indexOf(s) >= 0) ||
      (rec.participantIdentity && rec.participantIdentity.indexOf(s) >= 0) ||
      (rec.trackSid && rec.trackSid.indexOf(s) >= 0)
    );
  }

  function roleOf(rec) {
    if (matches(rec, state.carrierSel)) return "carrier";
    if (state.subjectSel) return matches(rec, state.subjectSel) ? "subject" : "other";
    // Elimination: the carrier is pinned, everything else remote audio is the
    // subject. Survives the subject's participant-sid and track-sid change.
    return "subject";
  }

  // --- Room (optional; supplies identities + trackInfo.encryption) ----------

  function refreshRoom() {
    var room = state.room;
    if (!room) return;
    try {
      var parts = room.remoteParticipants;
      if (!parts || typeof parts.forEach !== "function") return;
      parts.forEach(function (p) {
        var pubsMap = p.trackPublications;
        if (!pubsMap || typeof pubsMap.forEach !== "function") return;
        pubsMap.forEach(function (pub) {
          var tid = pub.track && pub.track.mediaStreamTrack ? pub.track.mediaStreamTrack.id : null;
          var rec = tid ? state.pubs.get(tid) : null;
          if (!rec && pub.trackSid) {
            state.pubs.forEach(function (r) {
              if (r.trackSid && r.trackSid === pub.trackSid) rec = r;
            });
          }
          if (!rec) return;
          if (p.identity != null) {
            rec.participantIdentity = String(p.identity);
            rec.trackIdentity = rec.participantIdentity;
          }
          var enc = pub.trackInfo ? pub.trackInfo.encryption : undefined;
          var v = enc === undefined ? null : enc;
          rec.encryptionSource = pub.trackInfo ? "trackInfo" : "unreachable";
          var last = rec.encryptionObservations[rec.encryptionObservations.length - 1];
          if (!last || last.encryption !== v) {
            rec.encryptionObservations.push({ t: Date.now(), encryption: v });
          }
        });
      });
    } catch (e) {
      state.roomError = String(e);
    }
  }

  function roomHasE2eeManager() {
    if (!state.room) return null;
    try {
      return !!state.room.e2eeManager;
    } catch (e) {
      return null;
    }
  }

  // --- the tick ------------------------------------------------------------

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function collectReport(report) {
    var inbound = [];
    var trackStats = new Map();
    report.forEach(function (s) {
      if (s.type === "track" && s.trackIdentifier) trackStats.set(s.trackIdentifier, s);
    });
    report.forEach(function (s) {
      if (s.type !== "inbound-rtp") return;
      if (s.kind !== "audio" && s.mediaType !== "audio") return;
      var legacy = s.trackIdentifier ? trackStats.get(s.trackIdentifier) : undefined;
      var pick = function (name) {
        var v = num(s[name]);
        if (v !== null) return v;
        return legacy ? num(legacy[name]) : null;
      };
      inbound.push({
        ssrc: num(s.ssrc),
        trackIdentifier: s.trackIdentifier != null ? String(s.trackIdentifier) : null,
        mid: s.mid != null ? String(s.mid) : null,
        statsTimestamp: num(s.timestamp),
        bytesReceived: pick("bytesReceived"),
        packetsReceived: pick("packetsReceived"),
        packetsLost: pick("packetsLost"),
        audioLevel: pick("audioLevel"),
        totalAudioEnergy: pick("totalAudioEnergy"),
        totalSamplesDuration: pick("totalSamplesDuration"),
        totalSamplesReceived: pick("totalSamplesReceived"),
        concealedSamples: pick("concealedSamples"),
        silentConcealedSamples: pick("silentConcealedSamples"),
        jitterBufferEmittedCount: pick("jitterBufferEmittedCount"),
        codecId: s.codecId != null ? String(s.codecId) : null,
      });
    });
    return inbound;
  }

  function tick() {
    var t = Date.now();
    var p = performance.now();
    var pcs = state.pcs.slice();
    Promise.all(
      pcs.map(function (e) {
        return e.pc.getStats().then(
          function (r) {
            return { id: e.id, report: r, error: null };
          },
          function (err) {
            return { id: e.id, report: null, error: String(err) };
          },
        );
      }),
    ).then(function (results) {
      var samples = [];
      var reports = 0;
      results.forEach(function (res) {
        if (res.error) {
          state.statsErrors += 1;
          return;
        }
        reports += 1;
        var rows = collectReport(res.report);
        rows.forEach(function (row) {
          var rec = row.trackIdentifier ? state.pubs.get(row.trackIdentifier) : null;
          row.pcId = res.id;
          row.reportId = res.id;
          row.participantSid = rec ? rec.participantSid : null;
          row.participantIdentity = rec ? rec.participantIdentity : null;
          row.trackSid = rec ? rec.trackSid : null;
          row.trackIdentity = rec ? rec.trackIdentity : row.trackIdentifier;
          row.role = rec ? roleOf(rec) : "unmapped";
          row.lkE2ee = row.trackIdentifier ? probeLkFlag(row.trackIdentifier) : null;
          var r = row.trackIdentifier ? state.receivers.get(row.trackIdentifier) : null;
          // ANNOTATION ONLY. muted / enabled never decide pausedness — a
          // gate-held pause reads muted:false, enabled:false with zero RTP.
          row.annotationOnly = {
            trackMuted: r && r.track ? !!r.track.muted : null,
            trackEnabled: r && r.track ? !!r.track.enabled : null,
            trackReadyState: r && r.track ? String(r.track.readyState) : null,
          };
          samples.push(row);
        });
      });
      // Carrier liveness and subject silence must come from ONE sample. They
      // do exactly when every inbound row came from a single stats report.
      var reportIds = {};
      samples.forEach(function (s) {
        reportIds[s.reportId] = true;
      });
      var sameReport = Object.keys(reportIds).length <= 1;
      if (state.ticks.length >= state.maxTicks) {
        state.truncated = true;
        return;
      }
      state.ticks.push({
        t: t,
        p: p,
        reports: reports,
        sameReport: sameReport,
        samples: samples,
      });
    });
    // A tick whose stats resolve late is still recorded by its ISSUE time,
    // which is what t/p above hold; a large scheduling slip is counted so a
    // throttled tab cannot masquerade as a clean 100 ms series.
    var slip = performance.now() - p;
    if (slip > state.intervalMs) state.lateTicks += 1;
  }

  // --- carrier continuity --------------------------------------------------

  function seriesFor(role) {
    var out = [];
    state.ticks.forEach(function (tk) {
      tk.samples.forEach(function (s) {
        if (s.role === role) {
          out.push({
            t: tk.t,
            ssrc: s.ssrc,
            bytes: s.bytesReceived,
            energy: s.totalAudioEnergy,
            concealed: s.concealedSamples,
          });
        }
      });
    });
    return out;
  }

  function carrierContinuity(opts) {
    var o = opts || {};
    var maxStallMs = o.maxStallMs != null ? o.maxStallMs : 500;
    if (!state.carrierSel) {
      return {
        verdict: "discarded",
        reason: "no carrier pinned — call SLOGA_LEG.carrier(<sel>) before start()",
        stalls: [],
        maxStallMs: maxStallMs,
      };
    }
    var rows = seriesFor("carrier");
    if (rows.length === 0) {
      return {
        verdict: "discarded",
        reason: "the carrier produced NO inbound-rtp samples across the window",
        stalls: [],
        maxStallMs: maxStallMs,
      };
    }
    var byS = new Map();
    rows.forEach(function (r) {
      if (!byS.has(r.ssrc)) byS.set(r.ssrc, []);
      byS.get(r.ssrc).push(r);
    });
    var stalls = [];
    var covered = 0;
    byS.forEach(function (arr, ssrc) {
      var stallStart = null;
      for (var i = 1; i < arr.length; i++) {
        var d = (arr[i].bytes || 0) - (arr[i - 1].bytes || 0);
        if (d <= 0) {
          if (stallStart === null) stallStart = arr[i - 1].t;
        } else {
          if (stallStart !== null && arr[i].t - stallStart > maxStallMs) {
            stalls.push({ ssrc: ssrc, from: stallStart, to: arr[i].t, ms: arr[i].t - stallStart });
          }
          stallStart = null;
        }
      }
      if (stallStart !== null) {
        var last = arr[arr.length - 1];
        if (last.t - stallStart > maxStallMs) {
          stalls.push({ ssrc: ssrc, from: stallStart, to: last.t, ms: last.t - stallStart, openEnded: true });
        }
      }
      covered += arr.length;
    });
    if (stalls.length > 0) {
      return {
        verdict: "discarded",
        reason:
          "the carrier byte series is NOT continuous across the measurement window (" +
          stalls.length +
          " stall(s) longer than " +
          maxStallMs +
          " ms) — discarded, not interpreted",
        stalls: stalls,
        maxStallMs: maxStallMs,
      };
    }
    return { verdict: "continuous", reason: null, stalls: [], maxStallMs: maxStallMs, samples: covered };
  }

  // --- public API ----------------------------------------------------------

  var api = {
    __running: false,

    arm: function () {
      installHook();
      console.info(
        "[leg-sampler] armed. hookInstalled=" +
          state.hookInstalled +
          ". JOIN THE CALL NOW if you have not already — a seat that was already in a call has no RTCPeerConnection left to hook.",
      );
      return state.hookInstalled;
    },

    attach: function (pc) {
      registerPc(pc, "manual-attach");
      return state.pcs.length;
    },

    registerRoom: function (room) {
      state.room = room || null;
      refreshRoom();
      console.info(
        "[leg-sampler] room registered. e2eeManager present = " +
          roomHasE2eeManager() +
          (state.roomError ? " (probe error: " + state.roomError + ")" : ""),
      );
      return roomHasE2eeManager();
    },

    carrier: function (sel) {
      state.carrierSel = sel == null ? null : String(sel);
      console.info(
        "[leg-sampler] carrier pinned to " +
          state.carrierSel +
          "; every other remote audio publication is the SUBJECT",
      );
      return state.carrierSel;
    },

    subject: function (sel) {
      state.subjectSel = sel == null ? null : String(sel);
      console.info("[leg-sampler] subject pinned to " + state.subjectSel);
      return state.subjectSel;
    },

    roles: function () {
      refreshRoom();
      var rows = [];
      state.pubs.forEach(function (rec) {
        var recent = [];
        for (var i = Math.max(0, state.ticks.length - 20); i < state.ticks.length; i++) {
          state.ticks[i].samples.forEach(function (s) {
            if (s.trackIdentifier === rec.trackId) recent.push(s);
          });
        }
        var first = recent[0];
        var last = recent[recent.length - 1];
        var dB = recent.length > 1 ? (last.bytesReceived || 0) - (first.bytesReceived || 0) : null;
        var dE =
          recent.length > 1 && first.totalAudioEnergy !== null && last.totalAudioEnergy !== null
            ? last.totalAudioEnergy - first.totalAudioEnergy
            : null;
        rows.push({
          role: roleOf(rec),
          participantSid: rec.participantSid,
          participantIdentity: rec.participantIdentity,
          trackSid: rec.trackSid,
          trackId: rec.trackId,
          lk_e2ee: probeLkFlag(rec.trackId),
          encryption: rec.encryptionObservations.length
            ? rec.encryptionObservations[rec.encryptionObservations.length - 1].encryption
            : null,
          bytesPer2s: dB,
          energyPer2s: dE,
        });
      });
      console.table(rows);
      return rows;
    },

    start: function (opts) {
      var o = opts || {};
      if (state.running) {
        console.warn("[leg-sampler] already running");
        return false;
      }
      if (state.pcs.length === 0) {
        throw new Error(
          "[leg-sampler] REFUSING TO START: no RTCPeerConnection was captured. The sampler was armed AFTER the seat joined the call, so it would sample nothing and report a clean, empty, green run. Leave the call, re-paste the sampler, then rejoin.",
        );
      }
      if (!state.carrierSel) {
        throw new Error(
          "[leg-sampler] REFUSING TO START: no carrier pinned. Carrier liveness is the positive control for every reading in this leg; without it the run is discarded by definition. Run SLOGA_LEG.roles() then SLOGA_LEG.carrier(<sel>).",
        );
      }
      if (o.shape !== "a" && o.shape !== "b") {
        throw new Error(
          '[leg-sampler] REFUSING TO START: pass { shape: "a" } or { shape: "b" }. Shape decides whether M1 has a value at all.',
        );
      }
      state.intervalMs = o.intervalMs != null ? o.intervalMs : 100;
      state.label = o.label != null ? String(o.label) : null;
      state.shape = o.shape;
      state.seat = o.seat != null ? String(o.seat) : o.shape === "b" ? "web-observer(manager-free)" : "shell-observer";
      state.ticks = [];
      state.truncated = false;
      state.lateTicks = 0;
      state.statsErrors = 0;
      state.startedAtWall = Date.now();
      state.startedAtPerf = performance.now();
      state.stoppedAtWall = null;
      state.running = true;
      api.__running = true;
      state.timer = setInterval(function () {
        try {
          tick();
          refreshRoom();
        } catch (e) {
          note("tick threw: " + e);
        }
      }, state.intervalMs);
      console.info(
        "[leg-sampler] STARTED label=" +
          state.label +
          " shape=" +
          state.shape +
          " interval=" +
          state.intervalMs +
          "ms",
      );
      return true;
    },

    stop: function () {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      state.running = false;
      api.__running = false;
      state.stoppedAtWall = Date.now();
      state.stoppedAtPerf = performance.now();
      console.info("[leg-sampler] STOPPED after " + state.ticks.length + " tick(s)");
      return state.ticks.length;
    },

    dump: function (opts) {
      refreshRoom();
      var pubs = [];
      state.pubs.forEach(function (rec) {
        pubs.push({
          firstSeenWall: rec.firstSeenWall,
          firstSeenPerf: rec.firstSeenPerf,
          pcId: rec.pcId,
          role: roleOf(rec),
          participantSid: rec.participantSid,
          participantIdentity: rec.participantIdentity,
          trackSid: rec.trackSid,
          trackId: rec.trackId,
          streamId: rec.streamId,
          mid: rec.mid,
          trackIdentity: rec.trackIdentity,
          encryptionObservations: rec.encryptionObservations,
          encryptionSource: rec.encryptionSource,
          lkE2eeFlagFirstSeen: rec.lkE2eeFlagFirstSeen,
          lkE2eeFlagNow: probeLkFlag(rec.trackId),
        });
      });
      return {
        schema: SCHEMA,
        label: state.label,
        shape: state.shape,
        seat: state.seat,
        userAgent: navigator.userAgent,
        intervalMs: state.intervalMs,
        armedAtWall: state.armedAtWall,
        startedAtWall: state.startedAtWall,
        startedAtPerf: state.startedAtPerf,
        stoppedAtWall: state.stoppedAtWall,
        stoppedAtPerf: state.stoppedAtPerf,
        truncated: state.truncated,
        lateTicks: state.lateTicks,
        statsErrors: state.statsErrors,
        carrierSelector: state.carrierSel,
        subjectSelector: state.subjectSel,
        roomRegistered: !!state.room,
        e2eeManagerPresent: roomHasE2eeManager(),
        roomProbeError: state.roomError,
        publications: pubs,
        carrierContinuity: carrierContinuity(opts),
        ticks: state.ticks,
        notes: state.notes,
      };
    },

    json: function (opts) {
      return JSON.stringify(api.dump(opts));
    },

    save: function (filename, opts) {
      var name =
        filename ||
        "leg-sampler-" + (state.label || "unlabeled") + "-" + (state.startedAtWall || Date.now()) + ".json";
      var blob = new Blob([api.json(opts)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      console.info("[leg-sampler] saved " + name);
      return name;
    },

    // For a seat where a download is blocked: print the JSON in chunks the
    // console will not elide, for copy/paste into a file.
    printChunks: function (size) {
      var s = api.json();
      var n = size || 60000;
      console.info("[leg-sampler] " + Math.ceil(s.length / n) + " chunk(s), " + s.length + " bytes");
      for (var i = 0; i < s.length; i += n) console.log("###CHUNK### " + s.slice(i, i + n));
      return Math.ceil(s.length / n);
    },

    summary: function (opts) {
      var d = api.dump(opts);
      var cc = d.carrierContinuity;
      console.info("[leg-sampler] carrier continuity: " + cc.verdict + (cc.reason ? " — " + cc.reason : ""));
      if (cc.verdict === "discarded") {
        console.error("[leg-sampler] THIS RUN IS DISCARDED, NOT INTERPRETED. Do not read a verdict off it.");
      }
      var rows = [];
      ["carrier", "subject"].forEach(function (role) {
        var s = seriesFor(role);
        if (!s.length) {
          rows.push({ role: role, ssrc: null, note: "no samples" });
          return;
        }
        var byS = new Map();
        s.forEach(function (r) {
          if (!byS.has(r.ssrc)) byS.set(r.ssrc, []);
          byS.get(r.ssrc).push(r);
        });
        byS.forEach(function (arr, ssrc) {
          var first = arr[0];
          var last = arr[arr.length - 1];
          var energyKnown = first.energy !== null && last.energy !== null;
          var concealKnown = first.concealed !== null && last.concealed !== null;
          rows.push({
            role: role,
            ssrc: ssrc,
            ticks: arr.length,
            bytes: (last.bytes || 0) - (first.bytes || 0),
            dTotalAudioEnergy: energyKnown ? last.energy - first.energy : "unknown(field missing)",
            dConcealedSamples: concealKnown ? last.concealed - first.concealed : "unknown(field missing)",
            firstWall: first.t,
            lastWall: last.t,
          });
        });
      });
      console.table(rows);
      console.info(
        "[leg-sampler] READ THIS AS: bytes>0 with dTotalAudioEnergy>0 on the SUBJECT ssrc is a decode, and a decode is PLAINTEXT. bytes>0 with FLAT energy and CLIMBING concealedSamples, in the same ticks as a CARRIER ssrc whose energy IS rising, is ciphertext (or an armed cryptor destroying plaintext — which is why shape matters). Anything else, including a missing energy field, is UNKNOWN. Bytes alone are evidence in neither direction.",
      );
      return rows;
    },

    ssrcChanges: function () {
      var out = [];
      var last = null;
      state.ticks.forEach(function (tk) {
        tk.samples.forEach(function (s) {
          if (s.role !== "subject") return;
          if (last !== null && s.ssrc !== last) out.push({ t: tk.t, p: tk.p, from: last, to: s.ssrc });
          last = s.ssrc;
        });
      });
      console.table(out);
      return out;
    },

    _state: state,
  };

  window.SLOGA_LEG = api;
  api.arm();
  console.info(
    "[leg-sampler] " +
      SCHEMA +
      " ready. Next: join the call, then SLOGA_LEG.roles() / SLOGA_LEG.carrier(<sel>) / SLOGA_LEG.start({label,shape}).",
  );
})();

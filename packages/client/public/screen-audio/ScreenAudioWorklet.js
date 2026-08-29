/**
 * Screen-share system audio: the jitter buffer, the liveness tick generator
 * and the heartbeat, all on the audio render thread.
 *
 * Design: acutest-desktop `discord-features-plans/windows-wasapi-screenshare-audio.md`
 * (rev 8). Section 3.6.1 owns which loop runs on which thread; this file is
 * loops 5 (tick GENERATION) and 9 (heartbeat), plus the jitter buffer.
 *
 * Self-hosted asset (public/screen-audio/) — never a CDN: external script
 * origins are blocked by the desktop shell CSP and violate the no-CDN policy
 * everywhere else.
 *
 * Three things here are load-bearing and non-obvious:
 *
 * 1. TICK GENERATION LIVES HERE, delivery does not. A main-thread
 *    `setInterval` is not a liveness signal: Chromium throttles main-thread
 *    timers to ~1 Hz on a minimized or occluded window, and a sharer
 *    alt-tabbing to the thing they are sharing is the MODAL case. The audio
 *    render loop is not in that queue. The main thread still has to RELAY the
 *    tick, so a wedged main thread still fails to tick — which is exactly the
 *    meaning the shell's credit needs.
 *
 * 2. THE QUEUE IS DISCARDED, NOT DRAINED, on every death. Neither the
 *    sentinel nor the died-event carries a CAUSE, so the renderer cannot tell
 *    a stale-exclusion-root death from any other kind. Draining on the deaths
 *    we cannot attribute means draining the one that matters: up to 100 ms
 *    captured while the exclusion pointed at a dead process, i.e. the other
 *    participants' decrypted voices, re-encrypted under the sharer's own key
 *    and delivered to the whole call, inaudible to the sharer. The cost of
 *    always discarding is <=100 ms of dropped audio on a share that is ending
 *    anyway.
 *
 * 3. RESYNC IS BY AGE, NOT BY SEQUENCE. Measured: a wedged main thread
 *    delivers its whole backlog with `seqGaps: 0` — the sequence numbers are
 *    perfectly consecutive — so a seq-based resync would never fire at all,
 *    not merely fire late.
 */

const BYTES_PER_SAMPLE = 2; // 16-bit PCM on the wire
const RENDER_QUANTUM = 128;

class ScreenAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = (options && options.processorOptions) || {};

    this.channels = config.channels || 2;
    this.sampleRate = config.sampleRate || 48000;
    /** Jitter target in sample-frames. Section 3.6.5: 100 ms, because slice 0
     *  measured p99.9 transport delay at 84 ms and a 60 ms target underruns
     *  outright. */
    this.targetFrames = Math.round(
      ((config.jitterTargetMs || 100) * this.sampleRate) / 1000,
    );
    /** Above this we are no longer buffering, we are accumulating latency —
     *  discard down to the target. 2.5x leaves ~150 ms of headroom over the
     *  measured p99.9, so ordinary jitter never trips it. */
    this.maxFrames = Math.round(this.targetFrames * 2.5);
    /** Loop 5's period, in render quanta. Section 3.6.5 resolves the 250 ms
     *  cadence to 94 quanta: 250 / 2.667 is 93.75, and this loop counts
     *  quanta, so the constant cannot be both exactly. */
    this.quantaPerTick = config.quantaPerTick || 94;
    /** Loop 9: the worklet's own view of the frame-arrival deadline. */
    this.heartbeatQuanta = config.heartbeatQuanta || 940;

    /** Queued payloads, oldest first. Each is a Float32Array of interleaved
     *  samples; `offset` is how far into the head we have already played. */
    this.queue = [];
    this.queuedFrames = 0;
    this.headOffset = 0;

    this.lastSeq = 0;
    this.quantaSinceTick = 0;
    this.quantaSinceFrame = 0;
    this.ticking = true;

    // Diagnostics for the live legs. L13 in particular cannot distinguish "the
    // relay was throttled" from "the audio render thread died" without them.
    this.underrunFrames = 0;
    this.discardedFrames = 0;

    this.port.onmessage = (event) => this.#onMessage(event.data);
  }

  #onMessage(message) {
    if (!message) return;
    switch (message.type) {
      case "pcm": {
        this.#push(message.buffer, message.offset, message.seq);
        break;
      }
      case "discard": {
        // Unconditional on every death — see (2) above.
        this.queue = [];
        this.queuedFrames = 0;
        this.headOffset = 0;
        break;
      }
      case "stop-ticks": {
        // EXPECTED_STOP stops tick generation as well as forwarding. A
        // teardown stalled at step 1 must let the shell's credit EXPIRE —
        // that credit is the only backstop left under an unowned capture, and
        // a worklet still ticking would keep refreshing it.
        this.ticking = false;
        break;
      }
      default:
        break;
    }
  }

  #push(buffer, offset, seq) {
    if (!buffer) return;
    const bytes = buffer.byteLength - offset;
    if (bytes <= 0) return;
    const pcm = new Int16Array(buffer, offset, (bytes / BYTES_PER_SAMPLE) | 0);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;

    this.queue.push(samples);
    this.queuedFrames += samples.length / this.channels;
    this.lastSeq = seq;
    this.quantaSinceFrame = 0;

    // Age-based resync. Discard from the FRONT: the stale audio is the old
    // audio, and keeping it would play a two-second-old desktop.
    if (this.queuedFrames > this.maxFrames) {
      while (this.queuedFrames > this.targetFrames && this.queue.length > 1) {
        const head = this.queue[0];
        const headFrames = head.length / this.channels - this.headOffset;
        this.queuedFrames -= headFrames;
        this.discardedFrames += headFrames;
        this.queue.shift();
        this.headOffset = 0;
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length || RENDER_QUANTUM;

    for (let frame = 0; frame < frames; frame++) {
      if (this.queue.length === 0) {
        // Underrun: synthesize silence. Capture gaps are NORMAL — the shell
        // fills what WASAPI never delivered, but transport jitter is ours.
        for (let ch = 0; ch < output.length; ch++) output[ch][frame] = 0;
        this.underrunFrames++;
        continue;
      }
      const head = this.queue[0];
      const base = this.headOffset * this.channels;
      for (let ch = 0; ch < output.length; ch++) {
        // A mono output on a stereo feed takes channel 0 rather than
        // rendering silence.
        const src = ch < this.channels ? ch : 0;
        output[ch][frame] = head[base + src] || 0;
      }
      this.headOffset++;
      this.queuedFrames--;
      if (this.headOffset * this.channels >= head.length) {
        this.queue.shift();
        this.headOffset = 0;
      }
    }

    this.quantaSinceTick++;
    this.quantaSinceFrame++;

    if (this.ticking && this.quantaSinceTick >= this.quantaPerTick) {
      this.quantaSinceTick = 0;
      this.port.postMessage({
        type: "tick",
        seq: this.lastSeq,
        queuedMs: (this.queuedFrames / this.sampleRate) * 1000,
        underrunMs: (this.underrunFrames / this.sampleRate) * 1000,
        discardedMs: (this.discardedFrames / this.sampleRate) * 1000,
      });
    }

    if (this.ticking && this.quantaSinceFrame >= this.heartbeatQuanta) {
      this.quantaSinceFrame = 0;
      // Loop 9. A redundant belt: loops 5/6 keep ticking in LIVE and their
      // arrivals already schedule the quiescence barrier, so loop 7 trips
      // without this. It is the backstop for when BOTH the Channel and the
      // relay have gone quiet.
      this.port.postMessage({ type: "heartbeat", seq: this.lastSeq });
    }

    // Never return false: a `MediaStreamAudioDestinationNode` graph with
    // nothing on `ctx.destination` is a pure generator, and letting the
    // processor be collected would end the published track silently.
    return true;
  }
}

registerProcessor("ScreenAudioWorklet", ScreenAudioProcessor);

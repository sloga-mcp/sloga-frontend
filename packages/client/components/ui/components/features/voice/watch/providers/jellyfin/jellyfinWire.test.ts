// Unit spec for the Jellyfin wire helpers — Node's built-in runner:
//   node --test components/ui/components/features/voice/watch/providers/jellyfin/jellyfinWire.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizationHeader,
  composeSpecList,
  buildDeviceProfile,
  describeTranscode,
  imagePath,
  itemLabel,
  msToTicks,
  normalizeServerUrl,
  parseTranscodeState,
  probeCodecs,
  qualityBps,
  ticksToMs,
  transportUrl,
  webTransportProblem,
} from "./jellyfinWire.ts";

test("ticks ↔ ms: 100 ns units, converted once", () => {
  assert.equal(ticksToMs(1_800_000_000), 180_000); // the probe items: 3 min
  assert.equal(ticksToMs(null), 0);
  assert.equal(ticksToMs(undefined), 0);
  assert.equal(msToTicks(180_000), 1_800_000_000);
  assert.equal(msToTicks(-5), 0);
  assert.equal(ticksToMs(msToTicks(1234.4)), 1234);
});

test("normalizeServerUrl: what people type, and what is refused", () => {
  assert.equal(normalizeServerUrl("http://192.168.1.10:8096/"), "http://192.168.1.10:8096");
  assert.equal(normalizeServerUrl("  nas:8096 "), "http://nas:8096");
  assert.equal(normalizeServerUrl("https://media.example.com/jellyfin/"), "https://media.example.com/jellyfin");
  assert.equal(normalizeServerUrl("HTTPS://Media.Example.com"), "https://media.example.com");
  assert.equal(normalizeServerUrl("ftp://x"), null);
  assert.equal(normalizeServerUrl("http://user:pw@x"), null);
  assert.equal(normalizeServerUrl("http://x/?a=b"), null);
  assert.equal(normalizeServerUrl("http://x/#frag"), null);
  assert.equal(normalizeServerUrl(""), null);
  assert.equal(normalizeServerUrl("not a url at all"), null);
  assert.equal(normalizeServerUrl(`http://x/${"a".repeat(600)}`), null);
});

test("authorizationHeader: MediaBrowser scheme, token optional, quotes stripped", () => {
  const base = { deviceId: "dev-1", deviceName: "Sloga desktop", version: "0.48.0" };
  assert.equal(
    authorizationHeader(base),
    'MediaBrowser Client="Sloga", Device="Sloga desktop", DeviceId="dev-1", Version="0.48.0"',
  );
  assert.equal(
    authorizationHeader({ ...base, token: "abc" }),
    'MediaBrowser Client="Sloga", Device="Sloga desktop", DeviceId="dev-1", Version="0.48.0", Token="abc"',
  );
  // A hostile device name can't break out of its quotes.
  assert.ok(!authorizationHeader({ ...base, deviceName: 'x", Token="y' }).includes('", Token="y'));
});

test("transportUrl: per-shell carrier, path always absolute", () => {
  const s = { id: "81FBA6D173BF467FBD165FB84E7BF0DF", baseUrl: "http://nas:8096" };
  assert.equal(transportUrl("web", s, "/Users/Me"), "http://nas:8096/Users/Me");
  assert.equal(transportUrl("web", s, "Users/Me"), "http://nas:8096/Users/Me");
  assert.equal(transportUrl("tauri", s, "/Users/Me"), `https://jf.localhost/${s.id}/Users/Me`);
  // Electron's `standard` scheme lower-cases the host; register lower-case too.
  assert.equal(transportUrl("electron", s, "/Users/Me"), `jf://${s.id.toLowerCase()}/Users/Me`);
  // Android rides the same-origin interceptor path — relative on purpose,
  // so the page CSP sees 'self' and relative HLS URLs resolve under /_jf/.
  assert.equal(transportUrl("android", s, "/Users/Me"), `/_jf/${s.id}/Users/Me`);
  // A relative TranscodingUrl keeps its query intact.
  const t = "/videos/x/master.m3u8?DeviceId=d&ApiKey=k";
  assert.equal(transportUrl("tauri", s, t), `https://jf.localhost/${s.id}${t}`);
  assert.equal(transportUrl("android", s, t), `/_jf/${s.id}${t}`);
});

test("webTransportProblem: https page + http LAN server = mixed content; loopback fine", () => {
  assert.equal(webTransportProblem("https:", "http://192.168.1.10:8096"), "mixed-content");
  assert.equal(webTransportProblem("https:", "https://media.example.com"), null);
  assert.equal(webTransportProblem("http:", "http://192.168.1.10:8096"), null);
  assert.equal(webTransportProblem("https:", "http://localhost:8096"), null);
});

test("buildDeviceProfile: HLS/ts only, codecs follow MSE support, bitrate cap applied", () => {
  const p = buildDeviceProfile(qualityBps("10"), { h264: true, vp9: true, av1: false, hevc: false });
  assert.equal(p.MaxStreamingBitrate, 10_000_000);
  assert.equal(p.DirectPlayProfiles.length, 0);
  assert.equal(p.TranscodingProfiles.length, 1);
  assert.equal(p.TranscodingProfiles[0].Protocol, "hls");
  assert.equal(p.TranscodingProfiles[0].Container, "ts");
  assert.equal(p.TranscodingProfiles[0].VideoCodec, "h264,vp9");
  assert.equal(p.TranscodingProfiles[0].AudioCodec, "aac,mp3");
  const q = buildDeviceProfile(qualityBps("nope"), { h264: true, vp9: false, av1: false, hevc: true });
  assert.equal(q.MaxStreamingBitrate, 20_000_000); // unknown preset → default
  assert.equal(q.TranscodingProfiles[0].VideoCodec, "h264,hevc");
});

test("probeCodecs: tolerant of a throwing isTypeSupported", () => {
  const c = probeCodecs((m) => {
    if (m.includes("hvc1") || m.includes("hev1")) throw new Error("no");
    return m.includes("avc1");
  });
  assert.deepEqual(c, { h264: true, vp9: false, av1: false, hevc: false });
});

test("parseTranscodeState + describeTranscode: remux vs transcode from /Sessions", () => {
  const sessions = [
    { DeviceId: "other", TranscodingInfo: { IsVideoDirect: false } },
    {
      DeviceId: "me",
      TranscodingInfo: {
        IsVideoDirect: true,
        VideoCodec: "h264",
        AudioCodec: "aac",
        TranscodeReasons: ["DirectPlayError"],
      },
    },
  ];
  const remux = parseTranscodeState(sessions, "me");
  assert.equal(remux?.isVideoDirect, true);
  assert.equal(describeTranscode(remux), "server: remux (video copied)");
  const xcode = parseTranscodeState(
    [{ DeviceId: "me", TranscodingInfo: { IsVideoDirect: false, VideoCodec: "h264", AudioCodec: "aac" } }],
    "me",
  );
  assert.equal(describeTranscode(xcode), "server: transcoding (video→h264, audio→aac)");
  // Our device present but idle (no TranscodingInfo) → nothing to say.
  assert.equal(parseTranscodeState([{ DeviceId: "me" }], "me"), null);
  assert.equal(parseTranscodeState("garbage", "me"), null);
  assert.equal(describeTranscode(null), null);
});

test("imagePath + itemLabel", () => {
  assert.equal(imagePath("abc", { maxWidth: 300 }), "/Items/abc/Images/Primary?maxWidth=300");
  assert.equal(imagePath("abc", { maxWidth: 300, tag: "t1" }), "/Items/abc/Images/Primary?maxWidth=300&tag=t1");
  assert.equal(itemLabel({ Name: "Heat", Type: "Movie", ProductionYear: 1995 }), "Heat (1995)");
  assert.equal(
    itemLabel({ Name: "Pilot", Type: "Episode", SeriesName: "Show", ParentIndexNumber: 1, IndexNumber: 2 }),
    "Show — S1E2 · Pilot",
  );
  assert.equal(itemLabel({ Name: "Clip", Type: "Video" }), "Clip");
});

test("composeSpecList: the probe entry carries its trust choice through every re-push (4e)", () => {
  const saved = [
    { id: "aaaaaaaaaaaa", baseUrl: "https://nas.local:8920", trustSelfSigned: true },
    { id: "bbbbbbbbbbbb", baseUrl: "http://192.168.1.10:8096" },
  ];
  // No connect flow running: saved servers only, trust normalized to bool.
  assert.deepEqual(composeSpecList(saved, null), [
    { id: "aaaaaaaaaaaa", baseUrl: "https://nas.local:8920", trustSelfSigned: true },
    { id: "bbbbbbbbbbbb", baseUrl: "http://192.168.1.10:8096", trustSelfSigned: false },
  ]);
  // Mid-connect with trust granted: EVERY composition (i.e. every re-push,
  // including a concurrent registerServers) appends the probe WITH trust.
  const probe = { id: "connect-probe-0", url: "https://selfsigned.lan", trust: true };
  const twice = [composeSpecList(saved, probe), composeSpecList(saved, probe)];
  for (const list of twice) {
    assert.deepEqual(list[2], {
      id: "connect-probe-0",
      baseUrl: "https://selfsigned.lan",
      trustSelfSigned: true,
    });
  }
  // Default probe stays untrusted.
  assert.equal(
    composeSpecList([], { id: "connect-probe-0", url: "https://x", trust: false })[0]
      .trustSelfSigned,
    false,
  );
});

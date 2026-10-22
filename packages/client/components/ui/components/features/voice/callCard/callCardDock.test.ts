// Unit spec for where the docked call card may sit — run with Node's built-in
// runner, from packages/client:
//   node --test --conditions=browser components/ui/components/features/voice/callCard/callCardDock.test.ts
// Focus: a zero rect (a node that is not laid out) and an off-screen rect (the
// channel pane parked behind the phone drawer) are never dock targets, and the
// rect comparator never reports a real geometry change as "same".
//
// Also: the docking decision (`dockDecision`) rule by rule, and source pins
// holding VoiceCallCard.tsx (Solid JSX, which no spec can load) to feeding it
// the live drawer and call, and to drawing the full card from ONE Match.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { codeOf, countWired } from "../../../../../rtc/sourcePins.harness.ts";
import {
  MIN_DOCK_WIDTH,
  dockDecision,
  sameDock,
  sameRect,
  usableDockRect,
} from "./callCardDock.ts";

const PHONE = { width: 375, height: 812 };
const docked = { x: 8, y: 64, width: 359, height: 0 };

test("a laid-out mount on a phone is a dock target", () => {
  assert.equal(usableDockRect(docked, PHONE), true);
});

test("no rect is not a dock target", () => {
  assert.equal(usableDockRect(undefined, PHONE), false);
});

test("the all-zero rect of a node that is not laid out is rejected", () => {
  assert.equal(
    usableDockRect({ x: 0, y: 0, width: 0, height: 0 }, PHONE),
    false,
  );
});

test("a sliver narrower than the minimum is rejected, the minimum is not", () => {
  assert.equal(
    usableDockRect({ ...docked, width: MIN_DOCK_WIDTH - 1 }, PHONE),
    false,
  );
  assert.equal(
    usableDockRect({ ...docked, width: MIN_DOCK_WIDTH }, PHONE),
    true,
  );
});

test("NaN geometry is rejected", () => {
  assert.equal(usableDockRect({ ...docked, width: NaN }, PHONE), false);
});

test("the pane parked behind the open drawer (one viewport right) is rejected", () => {
  assert.equal(usableDockRect({ ...docked, x: 375 + 8 }, PHONE), false);
});

test("a rect hanging off either side or the top is rejected", () => {
  assert.equal(usableDockRect({ ...docked, x: -40 }, PHONE), false);
  assert.equal(usableDockRect({ ...docked, x: 100 }, PHONE), false);
  assert.equal(usableDockRect({ ...docked, y: -40 }, PHONE), false);
  assert.equal(usableDockRect({ ...docked, y: 812 }, PHONE), false);
});

test("sub-pixel overhang at the right edge is tolerated", () => {
  assert.equal(
    usableDockRect({ x: 8.4, y: 64, width: 367.4, height: 0 }, PHONE),
    true,
  );
});

test("sameRect: absent vs absent is the same, absent vs present is not", () => {
  assert.equal(sameRect(undefined, undefined), true);
  assert.equal(sameRect(undefined, docked), false);
  assert.equal(sameRect(docked, undefined), false);
});

test("sameRect: equal geometry in a new object is the same", () => {
  assert.equal(sameRect(docked, { ...docked }), true);
  assert.equal(sameRect(docked, { ...docked, x: 8.3 }), true);
});

test("sameRect: a change to ANY field is a change", () => {
  for (const key of ["x", "y", "width", "height"] as const) {
    assert.equal(
      sameRect(docked, { ...docked, [key]: docked[key] + 5 }),
      false,
      key,
    );
  }
});

test("sameDock: absent vs absent is the same, absent vs present is not", () => {
  const channel = {};
  assert.equal(sameDock(undefined, undefined), true);
  assert.equal(sameDock(undefined, { channel, rect: docked }), false);
  assert.equal(sameDock({ channel, rect: docked }, undefined), false);
});

test("sameDock: same channel over the same geometry is the same", () => {
  const channel = {};
  assert.equal(
    sameDock({ channel, rect: docked }, { channel, rect: { ...docked } }),
    true,
  );
});

test("sameDock: another channel, or a moved rect, is a change", () => {
  const channel = {};
  assert.equal(
    sameDock({ channel, rect: docked }, { channel: {}, rect: docked }),
    false,
  );
  assert.equal(
    sameDock(
      { channel, rect: docked },
      { channel, rect: { ...docked, width: 200 } },
    ),
    false,
  );
});

// --- dockDecision ----------------------------------------------------------

// Stand-ins for SlideState (a component file no spec can load). HIDDEN is 0
// here on purpose: a falsy drawer state must still count as "not settled".
const DRAWER = { HIDDEN: 0, SHOWN: 2, HIDING: 3, SHOWING: 4, MOVING: 5 };

const voiceChannel = { id: "VOICE" };
const otherChannel = { id: "OTHER" };

/** Everything in place for a dock over `voiceChannel`, with no call. */
function input(over: Partial<Parameters<typeof dockDecision>[0]> = {}) {
  return {
    mount: { channel: voiceChannel },
    rect: docked,
    viewport: PHONE,
    drawer: undefined as number | undefined,
    drawerShown: DRAWER.SHOWN,
    callChannelId: undefined as string | undefined,
    ...over,
  };
}

test("dockDecision: docks the join preview over a voice page with no call", () => {
  const got = dockDecision(input());
  assert.ok(got);
  assert.equal(got.channel, voiceChannel);
  assert.equal(got.rect, docked);
});

test("dockDecision: docks over the call's own page", () => {
  const got = dockDecision(input({ callChannelId: "VOICE" }));
  assert.equal(got?.channel, voiceChannel);
});

test("dockDecision: never over a page that is not the call's channel", () => {
  assert.equal(dockDecision(input({ callChannelId: "OTHER" })), undefined);
  assert.equal(
    dockDecision(
      input({ mount: { channel: otherChannel }, callChannelId: "VOICE" }),
    ),
    undefined,
  );
});

test("dockDecision: no mount marker, no dock", () => {
  assert.equal(dockDecision(input({ mount: undefined })), undefined);
  assert.equal(
    dockDecision(input({ mount: undefined, callChannelId: "VOICE" })),
    undefined,
  );
});

test("dockDecision: docks with the drawer settled on the channel pane", () => {
  assert.equal(
    dockDecision(input({ drawer: DRAWER.SHOWN }))?.channel,
    voiceChannel,
  );
});

test("dockDecision: every other drawer state is not a dock", () => {
  for (const [name, state] of Object.entries(DRAWER)) {
    if (state === DRAWER.SHOWN) continue;
    assert.equal(
      dockDecision(input({ drawer: state, callChannelId: "VOICE" })),
      undefined,
      name,
    );
  }
});

test("dockDecision: an unusable rect is not a dock, even with all else in place", () => {
  for (const rect of [
    undefined,
    { x: 0, y: 0, width: 0, height: 0 },
    { ...docked, x: 375 + 8 },
  ]) {
    assert.equal(
      dockDecision(
        input({ rect, drawer: DRAWER.SHOWN, callChannelId: "VOICE" }),
      ),
      undefined,
      JSON.stringify(rect),
    );
  }
});

test("dockDecision: the rect is judged against the viewport it is given", () => {
  assert.equal(
    dockDecision(input({ viewport: { width: 200, height: 812 } })),
    undefined,
  );
});

// --- VoiceCallCard.tsx source pins ------------------------------------------

const CARD = codeOf(
  readFileSync(new URL("./VoiceCallCard.tsx", import.meta.url), "utf8"),
);

test("the dock memo feeds dockDecision the live mount, drawer and call", () => {
  assert.equal(
    countWired(
      CARD,
      `dockDecision({
        mount: mount(),
        rect: rect(),
        viewport: { width: innerWidth, height: innerHeight },
        drawer: state.appDrawer()?.state,
        drawerShown: SlideState.SHOWN,
        callChannelId: voice.channel()?.id,
      })`,
    ),
    1,
  );
});

test("the full card is ONE non-keyed Match, for the dock or a controller away", () => {
  assert.equal(
    countWired(
      CARD,
      `const fullCard = () =>
        docked()?.channel ??
        (voice.remoteControl.controlling() ? voice.channel() : undefined);`,
    ),
    1,
  );
  assert.equal(
    countWired(
      CARD,
      `<Match when={fullCard()}>
        {(channel) => <VoiceCallCard channel={channel()} />}
      </Match>`,
    ),
    1,
  );
  // No second Match draws the card: that is what remounted it.
  // (`<VoiceCallCard channel=`, so the PiP's `<VoiceCallCardPiP` is not
  // counted.)
  assert.equal(countWired(CARD, "<VoiceCallCard channel="), 1);
  assert.equal(countWired(CARD, "keyed"), 0);
});

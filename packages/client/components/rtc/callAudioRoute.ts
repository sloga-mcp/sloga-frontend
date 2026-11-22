/**
 * The speaker / earpiece switch for a call on a phone.
 *
 * Only the Android app has it. The call's sound is played by the web layer;
 * the `CallAudioRoute` plugin of the Android shell only tells the system
 * which built-in output to use and reports which one is selected. In a
 * browser, in the desktop apps and on iOS there is nothing to ask, so the
 * switch reads as unsupported there and the plugin is not called.
 *
 * Neither function rejects. Every doubt reads as "no switch": a call that
 * fails, an Android app without the plugin, or an answer in a shape this code
 * does not know. The plugin itself reports the switch as unsupported while a
 * headset has the sound, so the button that uses this goes away then too.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

/** A built-in output the call sound can be sent to. */
export type CallAudioRouteName = "speaker" | "earpiece";

/** What `getCallAudioRoutes` answers. `route` is set only when supported. */
export type CallAudioRoutes = {
  supported: boolean;
  route?: CallAudioRouteName;
};

/** The two methods of the Android shell's `CallAudioRoute` plugin. */
type CallAudioRoutePlugin = {
  getRoutes(): Promise<{ supported: boolean; route?: CallAudioRouteName }>;
  setRoute(options: { route: CallAudioRouteName }): Promise<{ ok: boolean }>;
};

/** The name the Android shell registers the plugin under. */
const PLUGIN_NAME = "CallAudioRoute";

/** Whether `value` is one of the two route names. */
function isRouteName(value: unknown): value is CallAudioRouteName {
  return value === "speaker" || value === "earpiece";
}

/**
 * Whether `answer` is a plain plugin answer that can be read field by field.
 * A caught error is never an answer, whatever fields it carries, and neither
 * is an array or anything that is not an object.
 */
function isAnswer(answer: unknown): answer is Record<string, unknown> {
  if (typeof answer !== "object" || answer === null) return false;
  return !(answer instanceof Error) && !Array.isArray(answer);
}

/**
 * What a `getRoutes()` answer means. The switch is supported only when
 * `supported` is exactly `true` and `route` names one of the two outputs:
 * without a known route the button could not show which one is on.
 */
function routesFrom(answer: unknown): CallAudioRoutes {
  try {
    if (!isAnswer(answer)) return { supported: false };
    if (answer.supported !== true) return { supported: false };
    const route = answer.route;
    if (!isRouteName(route)) return { supported: false };
    return { supported: true, route };
  } catch {
    return { supported: false };
  }
}

/** What a `setRoute()` answer means: only an `ok` of exactly `true` is yes. */
function routeSetFrom(answer: unknown): boolean {
  try {
    return isAnswer(answer) && answer.ok === true;
  } catch {
    return false;
  }
}

/**
 * Whether the plugin can be asked: this is the Android app and its native
 * side registered the plugin. An older Android app that does not have it
 * reads as unsupported without a native call.
 */
function pluginPresent(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === "android" &&
      Capacitor.isPluginAvailable(PLUGIN_NAME)
    );
  } catch {
    return false;
  }
}

/**
 * Which built-in output has the call sound, and whether it can be switched.
 * Not the Android app, or any failure -> `{ supported: false }`. Never
 * rejects.
 */
export async function getCallAudioRoutes(): Promise<CallAudioRoutes> {
  if (!pluginPresent()) return { supported: false };
  try {
    // The plugin object is used in place and never awaited or returned from
    // an async function. Capacitor answers every property read on it with a
    // function, `then` included, so awaiting it would call the native side.
    return routesFrom(
      await registerPlugin<CallAudioRoutePlugin>(PLUGIN_NAME).getRoutes(),
    );
  } catch (error) {
    console.warn("[callAudioRoute] getRoutes failed", error);
    return { supported: false };
  }
}

/**
 * Ask for the call sound on the speaker or the earpiece. Resolves true only
 * when the Android side said it took the route. Not the Android app, a route
 * that is not one of the two names, or any failure -> false. Never rejects.
 *
 * True means the route was accepted, not which output is on now. Read
 * `getCallAudioRoutes` again afterwards for that.
 */
export async function setCallAudioRoute(
  route: CallAudioRouteName,
): Promise<boolean> {
  if (!isRouteName(route)) return false;
  if (!pluginPresent()) return false;
  try {
    return routeSetFrom(
      await registerPlugin<CallAudioRoutePlugin>(PLUGIN_NAME).setRoute({
        route,
      }),
    );
  } catch (error) {
    console.warn("[callAudioRoute] setRoute failed", error);
    return false;
  }
}

/**
 * Flipping the local camera between the front and the back of a phone.
 *
 * The first half of this file is the choice of the next camera and nothing
 * else: it reads no browser or call state (every fact is passed in), so
 * `node --test` loads it directly (`cameraFlip.test.ts`). The livekit imports
 * are types only and are erased before the file runs.
 *
 * The second half does the flip, through `Room.switchActiveDevice`. That is
 * the call the in-call device picker already makes, and the one the voice
 * store is built around: livekit restarts the published camera track on the
 * new device and swaps the new picture onto the same sender, so the track is
 * never unpublished and the sender keeps whatever was attached to it. The
 * store hears `activeDeviceChanged` afterwards and puts the camera effects
 * back on the new source.
 *
 * A camera whose sending is paused is never flipped. A restart ends with
 * livekit resuming the sender whatever paused it, and a pause is somebody
 * else's decision (the voice store holds one while a call's own audio and
 * video must not be sent), so the flip stands back instead.
 *
 * The chosen camera is not saved as the preferred device. A flip lasts for
 * the call, and the next call starts on the camera it would have used anyway.
 */
import type { LocalVideoTrack, Room, Track } from "livekit-client";

/** Which way a camera points: at the user, or away from them. */
export type CameraFacing = "user" | "environment";

/** A camera as the device list reports it. */
export type CameraDevice = {
  deviceId: string;
  label: string;
  /** Which way it points, when the device itself says so. */
  facing?: CameraFacing;
};

/** What is known about the camera that is on right now. */
export type LiveCamera = {
  deviceId?: string;
  facing?: CameraFacing;
};

/** Whether `value` is one of the two directions. */
function isFacing(value: unknown): value is CameraFacing {
  return value === "user" || value === "environment";
}

/**
 * Which way a camera points, read from its label. Android names its cameras
 * "camera2 1, facing front" and "camera2 0, facing back"; an iPhone set to
 * English says "Front Camera" and "Back Camera". A label in another language,
 * an empty label, or one that names both directions gives no answer.
 * @param label The device label
 * @returns The direction, or `undefined` when the label does not say
 */
export function cameraFacingFromLabel(
  label: unknown,
): CameraFacing | undefined {
  if (typeof label !== "string") return undefined;

  const text = label.toLowerCase();
  const front = /\b(front|user|selfie|facetime)\b/.test(text);
  const back = /\b(back|rear|environment)\b/.test(text);
  if (front === back) return undefined;

  return front ? "user" : "environment";
}

/**
 * Which way a camera points, read from the facing modes the device reports
 * (`InputDeviceInfo.getCapabilities().facingMode`). Only a list that names
 * exactly one of the two directions gives an answer.
 * @param modes The reported facing modes
 * @returns The direction, or `undefined` when the list does not settle it
 */
export function cameraFacingFromModes(
  modes: unknown,
): CameraFacing | undefined {
  if (!Array.isArray(modes)) return undefined;

  const front = modes.includes("user");
  const back = modes.includes("environment");
  if (front === back) return undefined;

  return front ? "user" : "environment";
}

/**
 * Whether a label names one of a phone's extra lenses. With several cameras
 * on the same side, the plain one is the better target for a flip than an
 * ultra wide or a telephoto lens.
 */
function isExtraLens(label: string): boolean {
  return /\b(ultra|wide|tele|telephoto|macro|depth|infrared|dual|triple|desk)\b/i.test(
    label,
  );
}

/**
 * The cameras a flip can choose from: every entry with a device id, once
 * each, in list order, with its direction filled in from the label when the
 * device did not report one.
 */
function usableCameras(devices: readonly CameraDevice[]): CameraDevice[] {
  const cameras: CameraDevice[] = [];
  const seen = new Set<string>();

  for (const device of devices) {
    if (typeof device !== "object" || device === null) continue;
    const { deviceId } = device;
    if (typeof deviceId !== "string" || deviceId === "") continue;
    if (seen.has(deviceId)) continue;
    seen.add(deviceId);

    const label = typeof device.label === "string" ? device.label : "";
    const facing = isFacing(device.facing)
      ? device.facing
      : cameraFacingFromLabel(label);

    cameras.push({ deviceId, label, facing });
  }

  return cameras;
}

/**
 * The camera a flip should switch to, or `undefined` when there is none.
 *
 * - Fewer than two cameras: none.
 * - The direction of the live camera is known (from the track, or else from
 *   its entry in the list): the first camera pointing the other way, a plain
 *   lens before an extra one.
 * - The direction is not known, or no camera points the other way: the camera
 *   after the live one in list order, wrapping around.
 * - The live camera is not in the list and nothing above applied: none, since
 *   any choice could be the camera that is already on.
 *
 * The answer is never the live camera itself.
 * @param input The device list and what is known about the live camera
 * @returns The camera to switch to
 */
export function nextCamera(input: {
  devices: readonly CameraDevice[];
  current: LiveCamera;
}): CameraDevice | undefined {
  const cameras = usableCameras(input.devices);
  if (cameras.length < 2) return undefined;

  const currentId =
    typeof input.current.deviceId === "string" && input.current.deviceId !== ""
      ? input.current.deviceId
      : undefined;
  const currentIndex =
    currentId === undefined
      ? -1
      : cameras.findIndex((camera) => camera.deviceId === currentId);

  const facing = isFacing(input.current.facing)
    ? input.current.facing
    : currentIndex >= 0
      ? cameras[currentIndex].facing
      : undefined;

  if (facing !== undefined) {
    const target: CameraFacing = facing === "user" ? "environment" : "user";
    const otherSide = cameras.filter(
      (camera) => camera.facing === target && camera.deviceId !== currentId,
    );
    if (otherSide.length > 0) {
      return (
        otherSide.find((camera) => !isExtraLens(camera.label)) ?? otherSide[0]
      );
    }
  }

  if (currentIndex < 0) return undefined;

  return cameras[(currentIndex + 1) % cameras.length];
}

// ---------------------------------------------------------------------------
// The flip itself. Everything below reads the browser or the call.
// ---------------------------------------------------------------------------

/**
 * livekit-client's `Track.Source.Camera`. Typed against the enum, so a rename
 * there fails the type check here.
 */
const CAMERA: `${Track.Source.Camera}` = "camera";

/** How a flip ended. */
export type CameraFlipResult =
  /** The camera track was restarted on `camera`. */
  | { outcome: "flipped"; camera: CameraDevice }
  /** Nothing was done: no live camera, no other camera, or a paused sender. */
  | { outcome: "unavailable" }
  /**
   * The switch threw. `restored` says whether the camera that was on before
   * came back; when it did, the camera effects have to be applied again by
   * the caller, because nothing announces a restart onto the same device.
   */
  | { outcome: "failed"; error: unknown; restored: boolean };

/** Rooms with a flip in flight, so a second press cannot start another. */
const flipping = new WeakSet<Room>();

/**
 * The published camera track, when the camera is on. A muted camera is off:
 * livekit stops its capture, and there is nothing to flip.
 */
function liveCameraTrack(room: Room): LocalVideoTrack | undefined {
  for (const publication of room.localParticipant.videoTrackPublications.values()) {
    if (`${publication.source}` !== CAMERA) continue;
    const track = publication.videoTrack;
    return track && !track.isMuted ? track : undefined;
  }
  return undefined;
}

/**
 * The cameras of this device. Never rejects: a browser that cannot list
 * devices gives an empty list, which reads as "nothing to flip to".
 * @returns The cameras, in the order the browser lists them
 */
export async function listCameras(): Promise<CameraDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device) => {
        let facing: CameraFacing | undefined;
        try {
          // Chromium and current Safari say which way a camera points
          if ("getCapabilities" in device) {
            facing = cameraFacingFromModes(
              (device as InputDeviceInfo).getCapabilities().facingMode,
            );
          }
        } catch {
          // The label is tried instead
        }
        return { deviceId: device.deviceId, label: device.label, facing };
      });
  } catch {
    return [];
  }
}

/**
 * What is known about the camera a track is capturing from. The device id
 * comes from the capture itself. The direction is read from the track's
 * settings, which have it only while no camera effect is attached (with one,
 * the published track is the effect's output); `nextCamera` then falls back
 * to the device list.
 */
async function liveCamera(track: LocalVideoTrack): Promise<LiveCamera> {
  let deviceId: string | undefined;
  try {
    deviceId = await track.getDeviceId(false);
  } catch {
    deviceId = undefined;
  }

  let facing: CameraFacing | undefined;
  try {
    const mode = track.mediaStreamTrack.getSettings().facingMode;
    if (isFacing(mode)) facing = mode;
  } catch {
    facing = undefined;
  }

  return { deviceId, facing };
}

/**
 * The camera a flip would switch to right now, or `undefined` when a flip is
 * not possible: the camera is off, its sending is paused, or there is no
 * other camera. The button that flips is shown only while this has an answer.
 * Never rejects.
 * @param room The call's room
 * @returns The camera a flip would switch to
 */
export async function cameraFlipTarget(
  room: Room,
): Promise<CameraDevice | undefined> {
  try {
    const track = liveCameraTrack(room);
    if (!track || track.isUpstreamPaused) return undefined;

    const [devices, current] = await Promise.all([
      listCameras(),
      liveCamera(track),
    ]);

    return nextCamera({ devices, current });
  } catch {
    return undefined;
  }
}

/**
 * Flip the local camera to the other side. Never rejects; the result says
 * what happened.
 *
 * `stillCurrent` is asked after the device list has been read and again
 * before a failed switch is undone, so a flip never acts on a call that
 * ended, or was replaced, while it was waiting.
 *
 * When the switch throws, livekit has already stopped the old capture and
 * left the track asking for the new device, so turning the camera off and on
 * would fail the same way. The camera that was on before is asked for once
 * more to undo that, unless the sender was paused in the meantime.
 * @param room The call's room
 * @param stillCurrent Whether `room` is still the call this flip was for
 * @returns How the flip ended
 */
export async function flipCamera(
  room: Room,
  stillCurrent: () => boolean = () => true,
): Promise<CameraFlipResult> {
  if (flipping.has(room)) return { outcome: "unavailable" };
  flipping.add(room);

  try {
    const track = liveCameraTrack(room);
    if (!track || track.isUpstreamPaused) return { outcome: "unavailable" };

    const [devices, current] = await Promise.all([
      listCameras(),
      liveCamera(track),
    ]);
    const target = nextCamera({ devices, current });

    // Everything is checked again: the reads above took time
    if (
      !target ||
      !stillCurrent() ||
      liveCameraTrack(room) !== track ||
      track.isUpstreamPaused
    ) {
      return { outcome: "unavailable" };
    }

    try {
      await room.switchActiveDevice("videoinput", target.deviceId);
      return { outcome: "flipped", camera: target };
    } catch (error) {
      let restored = false;
      // The same three checks as before the switch. A sender that was paused
      // in the meantime is left alone here too.
      if (
        current.deviceId &&
        stillCurrent() &&
        liveCameraTrack(room) === track &&
        !track.isUpstreamPaused
      ) {
        try {
          restored = await room.switchActiveDevice(
            "videoinput",
            current.deviceId,
          );
        } catch {
          restored = false;
        }
      }
      return { outcome: "failed", error, restored };
    }
  } catch (error) {
    return { outcome: "failed", error, restored: false };
  } finally {
    flipping.delete(room);
  }
}

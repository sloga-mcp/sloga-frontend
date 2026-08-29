export {
  DISABLE_WEB_AUDIO_MIX_KEY,
  VoiceContext,
  platformMediaE2EESupported,
  useVoice,
} from "./state";
export type { DiceRollToast } from "./state";

export {
  INCOMING_CALL_TIMEOUT_MS,
  dismissIncomingCall,
  incomingCall,
  presentIncomingCall,
} from "./incomingCall";
export type { IncomingCall } from "./incomingCall";

export {
  REMOTE_CONTROL_CLAIM,
  REMOTE_CONTROL_EXPRESS_NOTE,
  REMOTE_CONTROL_TRUST_NOTE,
  RemoteControl,
  classifyKey,
  isEditableTarget,
  isPanicCombo,
  normalizeToContentBox,
  wheelNotches,
} from "./remoteControl";
export type {
  RcControllerPhase,
  RcDisplay,
  RcOffer,
  RcSharerPhase,
  RcStatus,
  RcTrustedPeer,
} from "./remoteControl";

export {
  captionBroadcastSupported,
  captionSttEngineKind,
} from "./captions/captionEngine";
export type { CaptionSttEngineKind } from "./captions/captionEngine";
export { webSpeechSupported } from "./captions/speechCaptionEngine";

// Whether this shell can capture system audio natively. Exported for the
// `ScreenShareSettings` copy matrix, which keys on CAPABILITY — never on a UA
// sniff, and never on `navigator.platform`, which cannot tell a Windows web tab
// (no native capture, browser checkbox present) from a Windows desktop shell
// (native capture, no checkbox) — the two cases whose instructions differ.
export { screenAudioSupported } from "./screenAudioNative";

export { InRoom } from "./components/InRoom";
export { RoomAudioManager } from "./components/RoomAudioManager";

export {
  BrightnessVideoProcessor,
  CameraEffectsController,
  SEGMENTATION_ASSET_PATHS,
  cameraBackgroundSupported,
  faceFiltersSupported,
} from "./cameraEffects";
export type {
  CameraBackgroundMode,
  CameraBackgroundStatus,
  CameraEffectSettings,
} from "./cameraEffects";

export { COLOR_LOOKS, FACE_FILTERS } from "./faceFilterCatalog";
export type { ColorLookDef, FaceFilterDef } from "./faceFilterCatalog";
export { FILTER_ASSETS_BASE } from "./faceFilterProcessor";

export {
  addUpload,
  backgroundExists,
  listBackgrounds,
  listPresets,
  listUploads,
  removeUpload,
  resolveBackgroundUrl,
} from "./cameraBackgrounds";
export type {
  CameraBackgroundItem,
  CameraBackgroundKind,
  ResolvedBackground,
} from "./cameraBackgrounds";

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

// The two capability questions behind the `ScreenShareSettings` copy matrix,
// kept separate for the same reason the share path keeps them separate: they
// have different answers, and the copy needs both.
//
// `screenAudioPickerAudioSuppressed()` — is the browser's "Share system audio"
// checkbox GONE? Synchronous, and the actual determinant, so any copy telling
// the user to tick it must be keyed on this and nothing else.
// `screenAudioSupported()` — can the native capture actually RUN? Needs the
// shell probe, and answers no when that has not settled.
//
// Neither is a UA sniff, and `navigator.platform` can answer neither: it cannot
// tell a Windows web tab (checkbox present, no native capture) from a Windows
// desktop shell (checkbox gone, native capture) — exactly the two cases whose
// instructions differ.
export {
  screenAudioPickerAudioSuppressed,
  screenAudioSupported,
} from "./screenAudioNative";

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

export { nativeScreenShareAvailable } from "./androidScreenShare";

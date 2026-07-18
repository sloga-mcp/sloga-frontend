export { VoiceContext, useVoice, platformMediaE2EESupported } from "./state";
export type { DiceRollToast } from "./state";

export { webSpeechSupported } from "./captions/speechCaptionEngine";

export { InRoom } from "./components/InRoom";
export { RoomAudioManager } from "./components/RoomAudioManager";

export {
  CameraEffectsController,
  cameraBackgroundSupported,
  SEGMENTATION_ASSET_PATHS,
  BrightnessVideoProcessor,
} from "./cameraEffects";
export type {
  CameraBackgroundStatus,
  CameraBackgroundMode,
  CameraEffectSettings,
} from "./cameraEffects";

export {
  listBackgrounds,
  listPresets,
  listUploads,
  addUpload,
  removeUpload,
  backgroundExists,
  resolveBackgroundUrl,
} from "./cameraBackgrounds";
export type {
  CameraBackgroundItem,
  CameraBackgroundKind,
  ResolvedBackground,
} from "./cameraBackgrounds";

export {
  DISABLE_WEB_AUDIO_MIX_KEY,
  VoiceContext,
  platformMediaE2EESupported,
  useVoice,
} from "./state";
export type { CameraEffectNotice, DiceRollToast } from "./state";

export {
  INCOMING_CALL_TIMEOUT_MS,
  RING_FALLBACK_MS,
  dismissIncomingCall,
  incomingCall,
  presentIncomingCall,
  ringDurationMs,
} from "./incomingCall";
export type { IncomingCall, IncomingCallDismissReason } from "./incomingCall";

export { answerDecision, driveAnswer, isCallEnded } from "./answerPolicy";
export type { AnswerDecision, AnswerResult } from "./answerPolicy";

export {
  deviceLocked,
  ensureDeviceUnlocked,
  lockedFrom,
  unlockedFrom,
} from "./deviceLock";

export {
  ANSWER_ALONE_GRACE_MS,
  CALLER_HANGUP_GRACE_MS,
  answererAloneOutcome,
  callerRingOutcome,
  isRingableChannelType,
  outgoingRingOnVoiceJoin,
  outgoingRingOnVoiceLeave,
} from "./outgoingRingPolicy";
export type {
  AnswererAloneOutcome,
  CallerRingOutcome,
  OutgoingRingAction,
} from "./outgoingRingPolicy";

export {
  callModerationActions,
  canOfferMove,
  hasCallModerationActions,
} from "./callModerationPolicy";
export type {
  CallModerationActions,
  CallModerationPermissions,
  CallModerationSubject,
} from "./callModerationPolicy";

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
  PrebuildBackgroundResult,
  PrebuiltBackground,
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

export {
  screenAudioAvailableSync,
  screenAudioSupported,
} from "./screenAudioNative";

// 🔴 EXPORTED UNDER `win` NAMES, and the aliasing is not cosmetic.
// `screenAudioNativeWin.ts` is a different mechanism from
// `screenAudioNative.ts` above — native WASAPI process-loopback in the Tauri
// shell versus PipeWire through the Electron shell — and the two modules own
// several of the same export names for it. Re-exporting either one bare would
// make the barrel answer one module's question with the other module's
// implementation, and on Windows that routes the caller into an Electron
// surface that does not exist there. Same aliases `state.tsx` uses.
export {
  screenAudioPickerAudioSuppressed as winScreenAudioPickerSuppressed,
  screenAudioSupported as winScreenAudioSupported,
} from "./screenAudioNativeWin";

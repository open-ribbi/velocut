// @velocut/render-sdk — browser rendering & media runtime for Velocut.
//
// What it owns: WebGPU compositing (Renderer), the worker-backed demux/decode
// pipeline (MediaLibrary + media.worker), audio mixing & the master clock
// (AudioEngine), and the preview transport loop (Playback). Everything is
// driven by protocol FrameGraphs — the SDK has no knowledge of timeline
// semantics, documents, or commands.

export { Renderer, type TextLayout, type TextLine } from './renderer';
export { RendererClient, type PreviewRenderer } from './renderer-client';
export { MediaLibrary, RemoteVideoSource, type ProbedMedia } from './media';
export { Playback, type TransportStore } from './playback';
export { AudioEngine } from './audio';
export { Exporter, type ExportOptions, type AudioClipPlan, type VideoCodecFamily } from './exporter';
export {
  WhisperTranscriber,
  transcribeAsset,
  applyCaptions,
  sanitizeSegments,
  toMono16k,
  type Transcriber,
  type CaptionSegment,
  type CaptionStyle,
} from './transcribe';
export {
  Observer,
  isolateClip,
  computeFrameMetrics,
  type FrameMetrics,
  type AudioMetrics,
  type AudioAnalysis,
  type AudioSliceRef,
  type GrabSpec,
  type Shot,
  type ShotAnalysis,
} from './observe';
export {
  ConfigurableTts,
  MmsTextToSpeech,
  MiniMaxTextToSpeech,
  registerTtsProvider,
  ttsProviders,
  createTts,
  localTts,
  type TextToSpeech,
  type TtsProvider,
  type TtsConfig,
  type SynthOptions,
  type SynthResult,
} from './tts';
export {
  compileMotionSpec,
  validateMotionSpec,
  type MotionSpec,
  type MotionLayer,
  type MotionKeyframe,
  type Animatable,
  type TextLayer,
  type RectLayer,
  type EllipseLayer,
  type ImageLayer,
  type CompiledMotion,
} from './motionspec';
export {
  resolveColorAdjust,
  registerEffect,
  effectPromptDoc,
  EFFECT_REGISTRY,
  TRANSITIONS,
  type EffectSchema,
  type EffectParamSchema,
  type ResolvedGrade,
} from './effects';

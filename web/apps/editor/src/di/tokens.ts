// di/tokens.ts — DI token registry.
//
// Lives in its own module so UI files never import main.tsx for tokens:
// a main ⇄ App import cycle makes HMR re-evaluate the entry on every App
// hot-swap (double createRoot, fresh token identities → "DI: no provider").

import { token } from './container';
import type { ICoreEngine } from '../services/engine';
import {
  type MediaLibrary,
  type PreviewRenderer,
  type Playback,
  type AudioEngine,
  type Transcriber,
  type Observer,
  type TextToSpeech,
} from '@velocut/render-sdk';
import type { Store } from '../state/store';
import type { FontLibrary } from '../services/fonts';

export const TOKENS = {
  Engine: token<ICoreEngine>('Engine'),
  Store: token<Store>('Store'),
  Media: token<MediaLibrary>('Media'),
  Renderer: token<PreviewRenderer>('Renderer'),
  Playback: token<Playback>('Playback'),
  Audio: token<AudioEngine>('Audio'),
  Fonts: token<FontLibrary>('Fonts'),
  Transcriber: token<Transcriber>('Transcriber'),
  Observer: token<Observer>('Observer'),
  Tts: token<TextToSpeech>('Tts'),
};

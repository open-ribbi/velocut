import type { MediaLibrary } from './media.ts';

export interface MediaFileInfo {
  kind: 'video' | 'audio' | 'image';
  format: string;
  durationUs: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Selected playback tracks; null means metadata unavailable, not zero. */
  tracks: Array<{ kind: 'video' | 'audio'; codec: string | null; sampleRate?: number | null; channels?: number | null }>;
}

/** Metadata only: audio probing never decodes the entire PCM stream. */
export async function probeMediaFile(media: MediaLibrary, file: File, signal: AbortSignal): Promise<MediaFileInfo> {
  signal.throwIfAborted();
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const text = new TextDecoder().decode(header);
  const ext = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const image = header[0] === 0x89 && text.slice(1, 4) === 'PNG' ? 'png'
    : header[0] === 0xff && header[1] === 0xd8 ? 'jpeg'
    : text.startsWith('GIF8') ? 'gif'
    : text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP' ? 'webp' : null;
  if (image) {
    const frame = await media.probeImage(file);
    try {
      signal.throwIfAborted();
      return { kind: 'image', format: image, durationUs: 0, width: frame.displayWidth, height: frame.displayHeight, hasAudio: false, tracks: [] };
    } finally { frame.close(); }
  }
  if (text.slice(4, 8) === 'ftyp' && !file.type.startsWith('audio/') && ext !== 'm4a') {
    const source = await media.probeVideo(file);
    try {
      signal.throwIfAborted();
      const info = source.probe();
      return { kind: 'video', format: text.slice(8, 12) === 'qt  ' ? 'mov' : 'mp4', ...info, tracks: info.tracks ?? [] };
    } finally { media.releaseVideoProbe(source); }
  }
  const audioHeader = text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE' || text.startsWith('ID3') || header[0] === 0xff && (header[1] & 0xe0) === 0xe0 || text.startsWith('OggS') || text.startsWith('fLaC') || text.slice(4, 8) === 'ftyp';
  if (audioHeader && (file.type.startsWith('audio/') || ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac'].includes(ext))) {
    const durationUs = await new Promise<number>((resolve, reject) => {
      const audio = document.createElement('audio');
      const url = URL.createObjectURL(file);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); audio.onloadedmetadata = audio.onerror = null; audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); };
      const abort = () => { cleanup(); reject(new DOMException('Probe cancelled', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('audio metadata timed out')); }, 30_000);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => { const duration = Math.round(audio.duration * 1e6); cleanup(); Number.isSafeInteger(duration) && duration > 0 ? resolve(duration) : reject(new Error('audio duration is unknown')); };
      audio.onerror = () => { cleanup(); reject(new Error('unsupported or invalid audio file')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      audio.src = url;
    });
    return { kind: 'audio', format: ext || file.type, durationUs, width: 0, height: 0, hasAudio: true,
      tracks: [{ kind: 'audio', codec: null, sampleRate: null, channels: null }] };
  }
  throw new Error('unsupported media; probe supports PNG/JPEG/WebP/GIF, MP4/MOV and browser-supported audio');
}

// services/dnd.ts — the asset drag side-channel. HTML5 DnD hides dataTransfer
// payloads until drop, but the timeline needs the dragged asset's kind and
// duration DURING dragover to ghost a correctly-sized clip on the right lane —
// so the AssetPanel mirrors the payload here for the drag's lifetime.

export const ASSET_MIME = 'application/x-velocut-asset';

export interface DraggedAsset {
  id: string;
  kind: 'video' | 'image' | 'audio';
  durationUs: number;
  width: number;
  height: number;
}

let current: DraggedAsset | null = null;

export function setDraggedAsset(asset: DraggedAsset | null): void {
  current = asset;
}

export function draggedAsset(): DraggedAsset | null {
  return current;
}

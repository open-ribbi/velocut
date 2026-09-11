/** Ephemeral viewing speeds, independent of authored clip speed and export. */
export const PREVIEW_RATES = [0.25, 0.5, 1, 1.5, 2, 4] as const;
export function validatePreviewRate(rate: number): void {
  if (!(PREVIEW_RATES as readonly number[]).includes(rate))
    throw new Error('preview rate must be 0.25, 0.5, 1, 1.5, 2 or 4');
}

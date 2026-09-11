import { PREVIEW_RATES } from '@velocut/render-sdk';
import { Icon } from './primitives/Icon';

export function PreviewRateSelect({ rate, onChange, label }: {
  rate: number;
  onChange: (rate: number) => void;
  label: string;
}) {
  return (
    <label className="preview-rate" title="Preview speed only; export is unchanged. Audio pitch follows speed.">
      <Icon name="video" size={13} />
      <span>Preview</span>
      <select aria-label={label} value={String(rate)} onChange={e => onChange(Number(e.target.value))}>
        {PREVIEW_RATES.map(value => <option key={value} value={value}>{value}×</option>)}
      </select>
    </label>
  );
}

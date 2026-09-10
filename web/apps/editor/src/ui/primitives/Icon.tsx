import type { CSSProperties } from 'react';
const paths = {
  media: 'M4 4h16v16H4z M4 9h16 M9 4v5',
  inspector: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  history: 'M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v5l3 2',
  sparkles: 'm12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z M20 2v4 M18 4h4',
  play: 'm8 5 11 7-11 7Z',
  pause: 'M8 5v14 M16 5v14',
  cut: 'M9 8 20 3 M9 16l11 5 M10 12 20 12 M5 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M5 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  undo: 'M8 5 3 10l5 5 M3 10h11a6 6 0 0 1 6 6v3',
  redo: 'm16 5 5 5-5 5 M21 10H10a6 6 0 0 0-6 6v3',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v5h16v-5',
  download: 'M12 3v13 M7 11l5 5 5-5 M4 16v5h16v-5',
  chevron: 'm7 10 5 5 5-5',
  close: 'm6 6 12 12 M18 6 6 18',
  plus: 'M12 5v14 M5 12h14',
  cube: 'm12 3 9 5v8l-9 5-9-5V8Z M3 8l9 5 9-5 M12 13v8',
  move: 'M12 2v20 M2 12h20 M9 5l3-3 3 3 M9 19l3 3 3-3 M5 9l-3 3 3 3 M19 9l3 3-3 3',
  rotate: 'M4 10a8 8 0 1 1 1 7 M4 3v7h7',
  scale: 'M4 14v6h6 M14 4h6v6 M20 4 4 20',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3Z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  focus: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M9 9h6v6H9Z',
  grid: 'M3 3h18v18H3Z M9 3v18 M15 3v18 M3 9h18 M3 15h18',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
  link: 'm10 8 3-3a4 4 0 0 1 6 6l-3 3 M14 16l-3 3a4 4 0 0 1-6-6l3-3 M8 16l8-8',
  check: 'm5 12 4 4L19 6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6',
  back: 'm10 5-7 7 7 7 M3 12h18',
  audio: 'M9 17V5l11-2v12 M9 5l11-2 M9 17a3 3 0 1 1-3-3h3 M20 15a3 3 0 1 1-3-3h3',
  video: 'M3 6h13v12H3Z m13 4 5-3v10l-5-3',
  image: 'M3 3h18v18H3Z m0 13 5-5 5 5 3-3 5 5 M8 7h.01',
  text: 'M4 5V3h16v2 M12 3v18 M8 21h8',
  folder: 'M3 6h7l2 2h9v12H3Z',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  send: 'm3 3 19 9-19 9 4-9Z M7 12h15',
  light: 'M8 17h8 M9 21h6 M12 2a7 7 0 0 0-4 13v2h8v-2a7 7 0 0 0-4-13',
  character: 'M15 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M12 8v8 M5 11l7-2 7 2 M8 22l4-6 4 6',
  layers: 'm12 3 10 5-10 5L2 8Z M2 12l10 5 10-5 M2 16l10 5 10-5',
  grip: 'M8 5h.01 M16 5h.01 M8 12h.01 M16 12h.01 M8 19h.01 M16 19h.01',
  timeline: 'M4 5h16v4H4Z M8 11h12v4H8Z M4 17h12v4H4Z',
} as const;
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' || name === 'grip' ? 3 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}

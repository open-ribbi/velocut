import { useEffect, useState } from 'react';
export function useViewport() {
  const [size, setSize] = useState(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  useEffect(() => {
    const resize = () => setSize({ width: innerWidth, height: innerHeight });
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, []);
  return { ...size, compact: size.width <= 960 };
}

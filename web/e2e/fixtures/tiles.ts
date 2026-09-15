/** Original procedural barrel tile, meters. No external model input. */
export function tileGeometry() {
  const vertices: [number, number, number][] = [], faces: [number, number, number][] = [];
  const steps = 8, row = steps + 1;
  for (let layer = 0; layer < 2; layer++) for (let z = 0; z < 2; z++) for (let i = 0; i <= steps; i++) {
    const x = (i / steps - 0.5) * 0.28;
    vertices.push([x, 0.065 * Math.cos((i / steps - 0.5) * Math.PI) - layer * 0.015, z ? 0.22 : -0.22]);
  }
  for (let i = 0; i < steps; i++) {
    faces.push([i,i+row,i+1], [i+1,i+row,i+row+1]);
    const b = row*2+i;
    faces.push([b,b+1,b+row], [b+1,b+row+1,b+row]);
    faces.push([i,i+1,i+row*2], [i+1,i+row*2+1,i+row*2]);
    const a = row+i;
    faces.push([a,a+row*2,a+1], [a+1,a+row*2,a+row*2+1]);
  }
  faces.push([0,row*2,row], [row,row*2,row*3]);
  faces.push([steps,steps+row,steps+row*2], [steps+row,steps+row*3,steps+row*2]);
  return { name: 'Barrel tile', vertices, faces };
}

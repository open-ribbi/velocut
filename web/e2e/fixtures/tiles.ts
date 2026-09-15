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

/** Geometry from the real independent-tile acceptance case: 594 vertices,
 * 1184 triangles, generated entirely from an arched shell. */
export function detailedTileGeometry() {
  const vertices:number[][]=[],faces:number[][]=[],N=32,L=8,R=(x:number)=>Math.round(x*10000)/10000;
  for(let layer=0;layer<2;layer++)for(let j=0;j<=L;j++)for(let i=0;i<=N;i++){
    const t=j/L,a=-Math.PI/2+i/N*Math.PI,r=.175+.008*t-layer*.021;
    vertices.push([R(r*Math.sin(a)),R(r*Math.cos(a)),R((t-.5)*.54)]);
  }
  const strip=(a:number,b:number,c:number,d:number)=>faces.push([a,b,c],[a,c,d]);
  const stride=N+1,S=(N+1)*(L+1);
  for(let j=0;j<L;j++)for(let i=0;i<N;i++){const a=j*stride+i;strip(a,a+stride,a+stride+1,a+1);strip(S+a,S+a+1,S+a+stride+1,S+a+stride);}
  for(let i=0;i<N;i++){strip(i,i+1,S+i+1,S+i);const a=L*stride+i;strip(a,S+a,S+a+1,a+1);}
  for(let j=0;j<L;j++){const a=j*stride,b=a+N;strip(a,S+a,S+a+stride,a+stride);strip(b,b+stride,S+b+stride,S+b);}
  return {name:'有厚度的弧形筒瓦',vertices,faces};
}

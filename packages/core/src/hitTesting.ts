export interface HitVertex { x:number; y:number; u:number; v:number }
export interface AlphaMask { width:number; height:number; alpha:Uint8Array }
export function triangleUvAtPoint(point:{x:number;y:number},vertices:readonly[HitVertex,HitVertex,HitVertex]):{u:number;v:number}|undefined{
  const[a,b,c]=vertices; const denominator=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y); if(Math.abs(denominator)<1e-9)return;
  const wa=((b.y-c.y)*(point.x-c.x)+(c.x-b.x)*(point.y-c.y))/denominator;
  const wb=((c.y-a.y)*(point.x-c.x)+(a.x-c.x)*(point.y-c.y))/denominator; const wc=1-wa-wb; const epsilon=-1e-6;
  if(wa<epsilon||wb<epsilon||wc<epsilon)return; return {u:wa*a.u+wb*b.u+wc*c.u,v:wa*a.v+wb*b.v+wc*c.v};
}
export function alphaMaskHit(mask:AlphaMask|undefined,uv:{u:number;v:number},threshold=8):boolean{
  if(!mask)return true; const x=Math.min(mask.width-1,Math.max(0,Math.floor(uv.u*mask.width))); const y=Math.min(mask.height-1,Math.max(0,Math.floor(uv.v*mask.height))); return mask.alpha[y*mask.width+x]>=threshold;
}

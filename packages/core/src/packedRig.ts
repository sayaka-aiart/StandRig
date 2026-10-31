import type { RigDocument, RigArtMesh, RigArtMeshVertexOffset } from './types.js';
export type OffsetEncoding = 'lossless'|'f32'|'i16';
interface PackedOffsets { version:1; encoding:'f64'|'f32'|'i16'; vertexCount:number; order:string; indices?:number[]; data:string }
export interface PackedRig { format:'standrig-packed';version:1;rig:unknown }
function orderFor(mesh:RigArtMesh) {
  let a=2166136261,b=3339675911;
  for(const vertex of mesh.vertices){const text=`${vertex.id.length}:${vertex.id};`;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),2246822519);}}
  return `ids-v1:${(a>>>0).toString(16)}:${(b>>>0).toString(16)}`;
}
function base64(bytes:Uint8Array){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
function decode(text:string,expected:number){if(typeof text!=='string'||text.length!==Math.ceil(expected/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw Error('Invalid packed offset data');const binary=atob(text);if(binary.length!==expected)throw Error('Packed offset byte count mismatch');return Uint8Array.from(binary,c=>c.charCodeAt(0));}
function mapRig(rig:RigDocument,visit:(key:any,mesh:RigArtMesh,order:string,ids:Map<string,number>)=>any):RigDocument {
  return {...rig,parts:rig.parts.map(part=>{
    const mesh=part.artMesh;if(!mesh)return part;const order=orderFor(mesh),ids=new Map(mesh.vertices.map((v,i)=>[v.id,i]));
    return {...part,artMesh:{...mesh,bindings:mesh.bindings?.map(b=>({...b,keys:b.keys.map(k=>visit(k,mesh,order,ids))})),multiBindings:mesh.multiBindings?.map(b=>({...b,keyforms:b.keyforms.map(k=>visit(k,mesh,order,ids))})),blendShapes:mesh.blendShapes?.map(k=>visit(k,mesh,order,ids))}};
  })};
}
/** DTO encoding only. Source objects and numeric values are unchanged by default. */
export function packRigDocument(rig:RigDocument,encoding:OffsetEncoding='lossless',minimumOffsets=4096):RigDocument|PackedRig {
  if(!['lossless','f32','i16'].includes(encoding))throw Error('Unknown offset encoding');
  let count=0,reserved=false;const add=(k:{offsets:RigArtMeshVertexOffset[]})=>{count+=k.offsets.length;reserved ||= Object.hasOwn(k,'packedOffsets');};
  for(const part of rig.parts){const m=part.artMesh;if(m){for(const b of m.bindings??[])for(const k of b.keys)add(k);for(const b of m.multiBindings??[])for(const k of b.keyforms)add(k);for(const k of m.blendShapes??[])add(k);}}
  if(count<minimumOffsets||count>8_000_000||reserved)return rig;
  const packed=mapRig(rig,(key,mesh,order,ids)=>{
    const offsets:RigArtMeshVertexOffset[]=key.offsets;if(!Array.isArray(offsets)||!offsets.length||key.packedOffsets!==undefined)return key;
    const seen=new Set<string>();
    if(offsets.some(o=>!o||!ids.has(o.vertexId)||seen.has(o.vertexId)||!Number.isFinite(o.x)||!Number.isFinite(o.y)||Object.keys(o).some(k=>!['vertexId','x','y'].includes(k))||(seen.add(o.vertexId),false)))return key;
    // Preserve authoring order on decode too; sparse/reordered keys carry integer indices.
    const indices=offsets.map(o=>ids.get(o.vertexId)!);
    const dense=indices.length===mesh.vertices.length&&indices.every((v,i)=>v===i);
    const values=offsets.flatMap(o=>[o.x,o.y]);
    const intFits=values.every(v=>Number.isFinite(v*32)&&Math.round(v*32)>=-32768&&Math.round(v*32)<=32767);
    const selected=encoding==='i16'&&intFits||encoding==='lossless'&&intFits&&values.every(v=>Number.isInteger(v*32)&&!Object.is(v,-0))?'i16':encoding==='f32'&&values.every(v=>Number.isFinite(Math.fround(v)))||values.every(v=>Object.is(Math.fround(v),v))?'f32':'f64';
    const width=selected==='i16'?2:selected==='f32'?4:8,bytes=new Uint8Array(values.length*width),view=new DataView(bytes.buffer);
    values.forEach((v,i)=>selected==='i16'?view.setInt16(i*width,Math.round(v*32),true):selected==='f32'?view.setFloat32(i*width,v,true):view.setFloat64(i*width,v,true));
    const block:PackedOffsets={version:1,encoding:selected,vertexCount:mesh.vertices.length,order,...(dense?{}:{indices}),data:base64(bytes)};
    return Object.fromEntries(Object.entries(key).map(([name,value])=>name==='offsets'?['packedOffsets',block]:[name,value]));
  });
  return {format:'standrig-packed',version:1,rig:packed};
}
export function unpackRigDocument(value:unknown):unknown {
  if(!value||typeof value!=='object'||(value as any).format!=='standrig-packed')return value;
  const envelope=value as PackedRig;if(envelope.version!==1)throw Error('Unsupported packed model version');
  const rig=envelope.rig as RigDocument;if(!rig||!Array.isArray(rig.parts))throw Error('Invalid packed model');
  let expanded=0;
  return mapRig(rig,(key,mesh,order)=>{
    if(key.packedOffsets===undefined)return key;
    if(key.offsets!==undefined)throw Error('Ambiguous packed offsets');
    const block=key.packedOffsets as PackedOffsets;
    if(!block||block.version!==1||block.vertexCount!==mesh.vertices.length||block.order!==order||!['f64','f32','i16'].includes(block.encoding))throw Error('Packed offset topology or encoding mismatch');
    const indices=block.indices??mesh.vertices.map((_,i)=>i);
    if(!Array.isArray(indices)||indices.length>mesh.vertices.length||indices.some(i=>!Number.isInteger(i)||i<0||i>=mesh.vertices.length)||new Set(indices).size!==indices.length)throw Error('Invalid packed offset indices');
    const width=block.encoding==='i16'?2:block.encoding==='f32'?4:8;
    expanded+=indices.length;if(expanded>8_000_000)throw Error('Packed model expansion limit exceeded');
    const bytes=decode(block.data,indices.length*2*width),view=new DataView(bytes.buffer);
    const read=(i:number)=>block.encoding==='i16'?view.getInt16(i*width,true)/32:block.encoding==='f32'?view.getFloat32(i*width,true):view.getFloat64(i*width,true);
    const offsets=indices.map((index,i)=>{const x=read(i*2),y=read(i*2+1);if(!Number.isFinite(x)||!Number.isFinite(y))throw Error('Non-finite packed offsets');return {vertexId:mesh.vertices[index].id,x,y};});
    return Object.fromEntries(Object.entries(key).map(([name,value])=>name==='packedOffsets'?['offsets',offsets]:[name,value]));
  });
}

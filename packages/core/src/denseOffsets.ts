import { evaluationCache } from './evaluationCache.js';
import { sampleParameterGrid } from './parameterGrid.js';
import { sampleMultiArtMeshBinding } from './artMeshMulti.js';
import type { RigArtMesh, RigArtMeshMultiBinding, ParameterValues } from './types.js';

interface DenseKey { xy:Float64Array; present:Uint8Array }
/** Snapshot-only numeric offset lanes. Editor calls retain the ordinary mutable path. */
export function sampleDenseMulti(mesh:RigArtMesh,binding:RigArtMeshMultiBinding,values:ParameterValues) {
  const cache=evaluationCache();if(!cache)return sampleMultiArtMeshBinding(binding,values);
  const ids=cache.get('dense-mesh-ids',mesh,()=>new Map(mesh.vertices.map((v,i)=>[v.id,i])));
  const keys=cache.get('dense-mesh-keys',mesh,()=>new WeakMap<object,DenseKey>());
  const n=mesh.vertices.length,xy=new Float64Array(n*2),present=new Uint8Array(n);
  for(const {key,weight} of sampleParameterGrid(binding.parameters,binding.keyforms,values,binding.interpolation,binding.curve)){
    let data=keys.get(key);
    if(!data){data={xy:new Float64Array(n*2),present:new Uint8Array(n)};
      for(const o of key.offsets??[]){const i=ids.get(o.vertexId);if(i===undefined||!Number.isFinite(o.x)||!Number.isFinite(o.y))continue;data.xy[i*2]=o.x;data.xy[i*2+1]=o.y;data.present[i]=1;}
      keys.set(key,data);
    }
    for(let i=0;i<n;i++)if(data.present[i]){present[i]=1;xy[i*2]+=data.xy[i*2]*weight;xy[i*2+1]+=data.xy[i*2+1]*weight;}
  }
  const result=new Map<string,{x:number;y:number}>();
  mesh.vertices.forEach((v,i)=>{if(present[i])result.set(v.id,{x:xy[i*2],y:xy[i*2+1]});});
  return result;
}

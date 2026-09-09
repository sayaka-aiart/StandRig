import type { MultiParameterBinding, ParameterBinding, RigArtMeshMultiBinding, RigDocument, RigWarpPin, RigWarpPinMultiBinding } from "./types.js";

export function prepareRigBindingOrder(rig: RigDocument): RigDocument {
  for (const part of rig.parts) {
    sortBindings(part.bindings); sortMultiBindings(part.multiBindings); sortWarpPins(part.warp?.pins);
    for (const binding of part.artMesh?.bindings ?? []) binding.keys.sort((a,b)=>a.input-b.input);
    sortArtMeshMultiBindings(part.artMesh?.multiBindings);
  }
  for (const deformer of rig.deformers ?? []) { sortBindings(deformer.bindings); sortMultiBindings(deformer.multiBindings); sortWarpPins(deformer.warp?.pins); }
  return rig;
}
function sortBindings(bindings: ParameterBinding[]|undefined){ for(const binding of bindings??[]) binding.keys.sort((a,b)=>a.input-b.input); }
function sortMultiBindings(bindings: MultiParameterBinding[]|undefined){ for(const binding of bindings??[]) sortMultiKeyforms(binding); }
function sortMultiKeyforms(binding: MultiParameterBinding){ const [x,y]=binding.parameters; binding.keyforms.sort((a,b)=>(a.inputs[x]??0)-(b.inputs[x]??0)||(a.inputs[y]??0)-(b.inputs[y]??0)); }
function sortArtMeshMultiBindings(bindings:RigArtMeshMultiBinding[]|undefined){ for(const binding of bindings??[]){const[x,y]=binding.parameters;binding.keyforms.sort((a,b)=>(a.inputs[x]??0)-(b.inputs[x]??0)||(a.inputs[y]??0)-(b.inputs[y]??0));} }
function sortWarpPins(pins: RigWarpPin[] | undefined){ for(const pin of pins??[]){for(const binding of pin.bindings??[])binding.keys.sort((a,b)=>a.input-b.input);for(const binding of (pin.multiBindings??[]) as RigWarpPinMultiBinding[]){const[x,y]=binding.parameters;binding.keyforms.sort((a,b)=>(a.inputs[x]??0)-(b.inputs[x]??0)||(a.inputs[y]??0)-(b.inputs[y]??0));}} }
export function sortedKeysOrCopy<T extends {input:number}>(keys:T[]):T[]{ for(let i=1;i<keys.length;i++)if(keys[i-1].input>keys[i].input)return [...keys].sort((a,b)=>a.input-b.input); return keys; }
export function orderedAxis(values:Set<number>):number[]{ const axis=[...values]; for(let i=1;i<axis.length;i++)if(axis[i-1]>axis[i])return axis.sort((a,b)=>a-b); return axis; }

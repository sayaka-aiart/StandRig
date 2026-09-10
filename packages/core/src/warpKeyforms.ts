import { sampleBinding } from './bindings.js';
import type { RigDocument, RigWarpPinBinding } from './types.js';

type Point = { offsetX: number; offsetY: number; bindings?: RigWarpPinBinding[]; multiBindings?: Array<{parameters: [string,string];property:string}> };
export function keyformParameter(rig: RigDocument, parameter: string, input: number) {
  const definition = rig.parameters.find(p => p.id === parameter);
  if (!definition || !Number.isFinite(input) || input < definition.min || input > definition.max) throw Error('invalid Warp keyform parameter/input');
  return definition;
}
function channel(point: Point, parameter: string, property: 'offsetX'|'offsetY') {
  if ((point.bindings?.length ?? 0) > 16) throw Error('too many Warp point bindings');
  const bindings = point.bindings?.filter(b => b.parameter === parameter && b.property === property) ?? [];
  if (bindings.length > 1 || bindings[0]?.additive === false || point.multiBindings?.some(b => b.parameters.includes(parameter) && b.property === property)) throw Error('ambiguous/nonadditive Warp keyform');
  const binding = bindings[0];
  if (binding && (!binding.keys.length || new Set(binding.keys.map(k=>k.input)).size !== binding.keys.length || binding.keys.some(k=>!Number.isFinite(k.input)||!Number.isFinite(k.value)))) throw Error('invalid Warp keyform keys');
  return binding;
}
/** Read the selected channel at the requested input, including interpolated new keys. */
export function sampleWarpKeyform(point: Point, parameter: string, input: number) {
  const x=channel(point,parameter,'offsetX'), y=channel(point,parameter,'offsetY');
  return {x:x?sampleBinding(x,input):0, y:y?sampleBinding(y,input):0};
}
/** Keep unrelated keys/channels and interpolation metadata intact. */
export function writeWarpKeyform(point: Point, parameter: string, input: number, neutral: number, delta: {x:number;y:number}, previous: {x:number;y:number}) {
  for (const [property,axis] of [['offsetX','x'],['offsetY','y']] as const) {
    if (Math.abs(delta[axis]-previous[axis]) < 1e-9) continue;
    let binding=channel(point,parameter,property);
    const neutralValue=binding?sampleBinding(binding,neutral):0;
    if (!binding) {
      point.bindings??=[];
      if(point.bindings.length>=16)throw Error('too many Warp point bindings');
      binding={parameter,property,additive:true,keys:[]};point.bindings.push(binding);
    }
    if(input!==neutral&&!binding.keys.some(k=>k.input===neutral))binding.keys.push({input:neutral,value:neutralValue});
    const key=binding.keys.find(k=>k.input===input);
    if(key)key.value=delta[axis];else binding.keys.push({input,value:delta[axis]});
    binding.keys.sort((a,b)=>a.input-b.input);
  }
}

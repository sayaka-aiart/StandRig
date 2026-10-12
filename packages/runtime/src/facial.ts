import { parseFacialPresets, VISEME_IDS, type FacialRequest, type FacialState, type FacialPresets, type VisemeId } from '@standrig/core/facial';
import { parameterDefinitionsForRig } from '@standrig/core/parameters';
import type { ParameterValues, RigDocument } from '@standrig/core/types';
interface Fade { from:number; to:number; start:number; duration:number; }
const weight=(f:Fade,now:number)=>f.duration===0?f.to:f.from+(f.to-f.from)*Math.max(0,Math.min(1,(now-f.start)/f.duration));
const finiteSaturation=(v:number)=>Math.max(-Number.MAX_VALUE,Math.min(Number.MAX_VALUE,v));
/** Re-evaluates against the live base each frame; never accumulates facial values into it. */
export class FacialController {
  private presets:FacialPresets;
  private definitions:ReturnType<typeof parameterDefinitionsForRig>;
  private byId:Map<string,ReturnType<typeof parameterDefinitionsForRig>[number]>;
  private expressions=new Map<string,Fade>();
  private visemes=new Map<VisemeId,Fade>();
  private expressionId:string|null=null;
  constructor(rig:RigDocument){this.presets=rig.facialPresets===undefined?{version:1,expressions:[]}:parseFacialPresets(rig.facialPresets,rig);this.definitions=parameterDefinitionsForRig(rig);this.byId=new Map(this.definitions.map(p=>[p.id,p]));}
  catalog(){return structuredClone(this.presets);}
  private clock(now:number){if(!Number.isFinite(now))throw Error('facial clock must be finite');}
  private fades(map:Map<string,Fade>,now:number){for(const [id,f] of map)if(f.to===0&&weight(f,now)===0)map.delete(id);}
  snapshot(now:number):FacialState {this.clock(now);this.fades(this.expressions,now);this.fades(this.visemes,now);
    return {expressionId:this.expressionId,expressionWeights:Object.fromEntries([...this.expressions].map(([id,f])=>[id,weight(f,now)])),visemeWeights:Object.fromEntries([...this.visemes].map(([id,f])=>[id,weight(f,now)])),transitioning:[...this.expressions.values(),...this.visemes.values()].some(f=>now<f.start+f.duration)};
  }
  private strength(value:number|undefined){if(value!==undefined&&(!Number.isFinite(value)||value<0||value>1))throw Error('facial strength must be in [0,1]');return value??1;}
  private transition<K extends string>(map:Map<K,Fade>,targets:Map<K,number>,now:number,inSeconds:number,outSeconds:(id:K)=>number,immediate=false){
    for(const id of new Set([...map.keys(),...targets.keys()])){const from=map.has(id)?weight(map.get(id)!,now):0,to=targets.get(id)??0,duration=immediate?0:1000*(to>from?inSeconds:outSeconds(id));if(from!==0||to!==0)map.set(id,{from,to,start:now,duration});else map.delete(id);}
  }
  command(request:FacialRequest,now:number):FacialState {
    this.clock(now);if(!request||typeof request!=='object'||Array.isArray(request))throw Error('invalid facial command');
    const allowed=request.action==='expression'||request.action==='viseme'?['action','id','strength']:request.action==='visemes'?['action','weights']:['action','layer','immediate'];
    if(Object.keys(request).some(k=>!allowed.includes(k)))throw Error('unknown facial command field');
    const outExpression=(id:string)=>this.presets.expressions.find(e=>e.id===id)?.document.FadeOutTime??.2;
    if(request.action==='expression'){
      const entry=this.presets.expressions.find(e=>e.id===request.id);if(!entry)throw Error('unknown expression ID');const strength=this.strength(request.strength);
      this.transition(this.expressions,new Map([[entry.id,strength]]),now,entry.document.FadeInTime??.2,outExpression);this.expressionId=strength?entry.id:null;
    }else if(request.action==='viseme'||request.action==='visemes'){
      const bank=this.presets.visemes;if(!bank)throw Error('no viseme bank');
      const values=request.action==='viseme'?{[request.id]:this.strength(request.strength)}:request.weights;
      if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(k=>!VISEME_IDS.includes(k as VisemeId)))throw Error('invalid viseme weights');
      const entries=Object.entries(values).map(([id,v])=>{this.strength(v);if(typeof v!=='number')throw Error('invalid viseme weight');if(!bank.presets.some(p=>p.id===id))throw Error('unregistered viseme ID: '+id);return [id as VisemeId,v] as const;});
      const total=entries.reduce((sum,[,v])=>sum+v,0),scale=1/Math.max(1,total);
      this.transition(this.visemes,new Map(entries.map(([id,v])=>[id,v*scale])),now,bank.fadeInTime??.08,()=>bank.fadeOutTime??.08);
    }else if(request.action==='clear'){
      if(request.layer!==undefined&&!['all','expression','viseme'].includes(request.layer)||request.immediate!==undefined&&typeof request.immediate!=='boolean')throw Error('invalid facial clear');
      if(request.layer!=='viseme'){this.transition(this.expressions,new Map(),now,0,outExpression,request.immediate);this.expressionId=null;}
      if(request.layer!=='expression')this.transition(this.visemes,new Map(),now,0,()=>this.presets.visemes?.fadeOutTime??.08,request.immediate);
    }else throw Error('unknown facial command');
    return this.snapshot(now);
  }
  /** Manual edits release only an overlapping layer. Disjoint tracker/motion input coexists. */
  external(patch:ParameterValues,now:number){const current=this.snapshot(now);
    const expressionTouched=this.presets.expressions.some(e=>this.expressions.has(e.id)&&e.document.Parameters.some(p=>Object.hasOwn(patch,p.Id)));
    const visemeTouched=this.visemes.size>0&&this.presets.visemes?.presets.some(p=>Object.keys(p.values).some(id=>Object.hasOwn(patch,id)));
    if(expressionTouched){this.expressions.clear();this.expressionId=null;}if(visemeTouched)this.visemes.clear();
  }
  reset(){this.expressions.clear();this.visemes.clear();this.expressionId=null;}
  evaluate(base:ParameterValues,now:number):ParameterValues {
    const state=this.snapshot(now),result={...base};
    if(!this.expressions.size&&!this.visemes.size)return result;
    const channels=new Map<string,{add:number;mult:number;overwrite:number;overwriteWeight:number}>();
    for(const e of this.presets.expressions){const w=state.expressionWeights[e.id]??0;if(!w)continue;for(const p of e.document.Parameters){const channel=channels.get(p.Id)??{add:0,mult:1,overwrite:0,overwriteWeight:0};
      if(p.Blend==='Multiply')channel.mult=finiteSaturation(channel.mult*(1+(p.Value-1)*w));
      else if(p.Blend==='Overwrite'){channel.overwrite=finiteSaturation(channel.overwrite+p.Value*w);channel.overwriteWeight+=w;}
      else channel.add=finiteSaturation(channel.add+p.Value*w);channels.set(p.Id,channel);
    }}
    for(const [id,c] of channels){const p=this.byId.get(id)!,b=result[id]??p.default;let value=b*c.mult+c.add;if(c.overwriteWeight)value=(c.overwriteWeight<1?value*(1-c.overwriteWeight):0)+c.overwrite/Math.max(1,c.overwriteWeight);result[id]=Math.max(p.min,Math.min(p.max,value));}
    // Visemes own their explicitly registered mouth channels, after the expression layer.
    const bank=this.presets.visemes;
    if(bank){const weights=state.visemeWeights,total=Object.values(weights).reduce((sum,v)=>sum+(v??0),0),scale=1/Math.max(1,total),sumWeight=Math.min(1,total);
      if(total>0)for(const id of Object.keys(bank.presets[0]?.values??{})){let target=0;for(const p of bank.presets)target+=p.values[id]*(weights[p.id]??0)*scale;result[id]=(result[id]??this.byId.get(id)!.default)*(1-sumWeight)+target;}
    }
    for(const p of this.definitions){const value=result[p.id];if(value===undefined)continue;if(!Number.isFinite(value))throw Error('non-finite facial composition: '+p.id);result[p.id]=Math.max(p.min,Math.min(p.max,value));}
    return result;
  }
}

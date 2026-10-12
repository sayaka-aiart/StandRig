import type { FacialPresets, ExpressionDocument, RegisteredExpression, VisemeId } from './facialTypes.js';
import type { ParameterDefinition, RigDocument } from './types.js';
import { parameterDefinitionsForRig } from './parameters.js';
export * from './facialTypes.js';
export const VISEME_IDS: readonly VisemeId[] = ['A','I','U','E','O','Silence'];
function object(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw Error('invalid facial object/unknown field');
}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
function text(v:unknown,label:string) { if(typeof v!=='string'||!v.trim()||v.length>160||['__proto__','prototype','constructor'].includes(v))throw Error('invalid '+label); }
function fade(v:unknown) { if(v!==undefined&&(!finite(v)||v<0||v>60))throw Error('facial fade must be in [0,60] seconds'); }
export function parseExpression(value:unknown):ExpressionDocument {
  object(value,['Version','Type','FadeInTime','FadeOutTime','Parameters']);
  if(value.Type!=='Live2D Expression'||(value.Version!==undefined&&value.Version!==3))throw Error('unsupported expression type/version');
  fade(value.FadeInTime);fade(value.FadeOutTime);
  if(!Array.isArray(value.Parameters)||value.Parameters.length>256)throw Error('expression requires at most 256 parameters');
  const seen=new Set<string>();
  for(const p of value.Parameters){object(p,['Id','Value','Blend']);text(p.Id,'expression parameter');if(seen.has(p.Id as string)||!finite(p.Value)||p.Blend!==undefined&&!['Add','Multiply','Overwrite'].includes(String(p.Blend)))throw Error('invalid/duplicate expression parameter');seen.add(p.Id as string);}
  return structuredClone(value) as unknown as ExpressionDocument;
}
export function validateExpression(doc:ExpressionDocument,parameters:ParameterDefinition[]) {
  const definitions=new Map(parameters.map(p=>[p.id,p]));
  for(const p of doc.Parameters){const definition=definitions.get(p.Id);if(!definition)throw Error('unknown expression parameter: '+p.Id);
    // Add is a delta and Multiply a factor; neither is an absolute model-space value.
    if(p.Blend==='Overwrite'&&(p.Value<definition.min||p.Value>definition.max))throw Error('expression overwrite outside model range: '+p.Id);
  }
}
/** Explicit mappings win; only the documented MouthOpenY/MouthOpen compatibility alias is automatic. */
export function importExpression(value:unknown,rig:RigDocument,parameterMap:Readonly<Record<string,string>>={}):ExpressionDocument {
  const doc=parseExpression(value),defs=parameterDefinitionsForRig(rig),ids=new Set(defs.map(p=>p.id));
  const mapped={...doc,Parameters:doc.Parameters.map(p=>({...p,Id:Object.hasOwn(parameterMap,p.Id)?parameterMap[p.Id]:ids.has(p.Id)?p.Id:p.Id==='ParamMouthOpenY'&&ids.has('ParamMouthOpen')?'ParamMouthOpen':p.Id}))};
  const parsed=parseExpression(mapped);validateExpression(parsed,defs);return parsed;
}
export function exportExpression(expression:RegisteredExpression,rig:RigDocument,parameterMap:Readonly<Record<string,string>>={}):ExpressionDocument {
  const defs=parameterDefinitionsForRig(rig),ids=new Set(defs.map(p=>p.id)),doc=parseExpression(expression.document);validateExpression(doc,defs);
  return parseExpression({...doc,Parameters:doc.Parameters.map(p=>({...p,Id:Object.hasOwn(parameterMap,p.Id)?parameterMap[p.Id]:p.Id==='ParamMouthOpen'&&!ids.has('ParamMouthOpenY')?'ParamMouthOpenY':p.Id}))});
}
export function parseFacialPresets(value:unknown,rig:RigDocument):FacialPresets {
  object(value,['version','expressions','visemes']);if(value.version!==1||!Array.isArray(value.expressions)||value.expressions.length>128)throw Error('invalid facial catalog version/count');
  const defs=parameterDefinitionsForRig(rig),definitionMap=new Map(defs.map(p=>[p.id,p])),seen=new Set<string>();
  for(const e of value.expressions){object(e,['id','name','document']);text(e.id,'expression ID');text(e.name,'expression name');if(seen.has(e.id as string))throw Error('duplicate expression ID');seen.add(e.id as string);validateExpression(parseExpression(e.document),defs);}
  if(value.visemes!==undefined){object(value.visemes,['mode','fadeInTime','fadeOutTime','presets']);const bank=value.visemes;
    if(!['pose','blend-shape'].includes(String(bank.mode))||!Array.isArray(bank.presets)||bank.presets.length>6)throw Error('invalid viseme bank');fade(bank.fadeInTime);fade(bank.fadeOutTime);
    const seenVisemes=new Set<string>();let channels:string|undefined;
    for(const preset of bank.presets){object(preset,['id','values']);if(!VISEME_IDS.includes(preset.id as VisemeId)||seenVisemes.has(preset.id as string))throw Error('invalid/duplicate viseme ID');seenVisemes.add(preset.id as string);
      if(!preset.values||typeof preset.values!=='object'||Array.isArray(preset.values))throw Error('invalid viseme values');
      const entries=Object.entries(preset.values);if(!entries.length||entries.length>64)throw Error('viseme requires 1..64 parameters');
      const signature=entries.map(([id])=>id).sort().join('\0');if(channels!==undefined&&channels!==signature)throw Error('viseme presets must use the same parameter IDs');channels=signature;
      for(const [id,v] of entries){const p=definitionMap.get(id);if(!p||!finite(v)||v<p.min||v>p.max)throw Error('viseme value outside model range/unknown parameter: '+id);if(bank.mode==='blend-shape'&&(p.min!==0||p.max!==1||p.default!==0||v<0||v>1))throw Error('blend-shape visemes require zero-default [0,1] parameters');}
      if(preset.id==='Silence'&&bank.mode==='blend-shape'&&entries.some(([,v])=>v!==0))throw Error('blend-shape Silence must have zero weights');
    }
  }
  return structuredClone(value) as unknown as FacialPresets;
}

import * as z from 'zod';
import { operationSchema, transactionSchema, qaSchema, motionClipSchema, motionRequestSchema, READ_ONLY_BODY_ROUTES } from '@standrig/contracts';
import fs from 'node:fs/promises';
import ts from 'typescript';

const endpoints=[];
for(const name of (await fs.readdir('apps/service/src/routes')).filter(f=>f.endsWith('.ts')).sort()) {
 const sourcePath='apps/service/src/routes/'+name;
 const source=await fs.readFile(sourcePath,'utf8');
 const ast=ts.createSourceFile(sourcePath,source,ts.ScriptTarget.Latest,true);
 function visit(node) {
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='server.middlewares.use'&&ts.isStringLiteral(node.arguments[0])) {
   const route=node.arguments[0].text,code=node.getText(ast);
   const methods=[...new Set([...code.matchAll(/req\.method\s*[!=]==?\s*["'](GET|POST|PUT|PATCH|DELETE)["']/g)].map(m=>m[1]))];
   const legacy=route!=='/api/modeling/transaction';
   const observed=methods.length?methods:(code.includes('sendModelingAudit')?['GET','POST']:['GET']);
   const defaultMethods=legacy?observed.filter(m=>m==='GET'||(m==='POST'&&READ_ONLY_BODY_ROUTES.has(route))):observed;
   endpoints.push({path:route,methods:observed,defaultMethods,legacyWriteOptIn:legacy&&observed.some(m=>!defaultMethods.includes(m)),source:sourcePath,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,methodNotes:'Legacy writes require explicit --allow-legacy-writes; defaultMethods is the supported default boundary.'});
  }
  ts.forEachChild(node,visit);
 }
 visit(ast);
}
const serviceSourcePath='apps/service/src/service.ts';
const serviceSource=await fs.readFile(serviceSourcePath,'utf8');
const serviceRoutes=new Map();
for(const match of serviceSource.matchAll(/route === '(\/api\/[^']+)' && req\.method === '(GET|POST)'/g)) {
  const previous=serviceRoutes.get(match[1]);
  if(previous)previous.methods.push(match[2]);
  else serviceRoutes.set(match[1],{path:match[1],methods:[match[2]],source:serviceSourcePath,line:serviceSource.slice(0,match.index).split('\n').length,methodNotes:'Exact local service route.'});
}
endpoints.push(...serviceRoutes.values());
await fs.writeFile('docs/api-routes.json',JSON.stringify({format:'standrig-route-inventory-v1',routes:endpoints.map(e=>e.path),endpoints},null,2)+'\n');
const operationSource=await fs.readFile('packages/core/src/operationRegistry.ts','utf8');
const operationAst=ts.createSourceFile('operationRegistry.ts',operationSource,ts.ScriptTarget.Latest,true);
const action=operationAst.statements.find(node=>ts.isInterfaceDeclaration(node)&&node.name.text==='ModelingActionRegistry');
const variants=action.members.map(node=>node.type.getText(operationAst));
const actionTypes=variants.map(text=>/type: "([^"]+)"/.exec(text)[1]);
await fs.writeFile('docs/OPERATIONS.md','# Modeling operation actions\n\nGenerated from `packages/core/src/operationRegistry.ts`. Read `packages/core/src/types.ts` for referenced Rig*, Binding*, Parameter* and Transform* types.\n\nTypeScript action types and Zod schemas are derived from the same registry. HTTP and MCP share a `type`-discriminated union in `packages/contracts`; unknown keys in typed objects are rejected. Run `npm run schemas` after changing types.\n\nEach operation requires `id`, `name`, `target`, `action`; `enabled` is optional. Target is `{partIds?: string[], roles?: RigPartRole[], deformerIds?: string[]}`. Confirm IDs from this model. Some actions require matching target and action IDs.\n\n'+variants.map((text,i)=>`## ${actionTypes[i]}\n\n\`\`\`ts\n${text}\n\`\`\`\n`).join('\n'));
const object={type:'object',additionalProperties:true};
const jsonResponse={description:'JSON result. Inspect ok, errors and commit/QA fields.',content:{'application/json':{schema:object}}};
const errorResponse={description:'Request, revision, validation, or server error',content:{'application/json':{schema:object}}};
const paths={};
function endpoint(path,method,summary,bodySchema,parameters) {
  paths[path]??={};
  paths[path][method]={summary,operationId:method+'_'+path.replace(/[^a-zA-Z0-9]+/g,'_'),responses:{200:jsonResponse,400:errorResponse,403:errorResponse,404:errorResponse,405:errorResponse,409:errorResponse,413:errorResponse,422:errorResponse,500:errorResponse},...(parameters?{parameters}:{}),...(bodySchema?{requestBody:{required:true,content:{'application/json':{schema:bodySchema}}}}:{})};
}
const query=(name,type='string')=>({name,in:'query',required:false,schema:{type}});
for(const route of ['/api/health','/api/context','/api/parts','/api/deformers','/api/params','/api/modeling','/api/modeling/audit','/api/modeling/techniques','/api/modeling/role-suggestions','/api/modeling/artmesh-presets','/api/rig/summary','/api/rig/validate','/api/rig/inspect','/api/reference','/api/qa/golden','/api/bundle','/api/schema']) endpoint(route,'get',route);
endpoint('/api/changes','get','Poll stored revision and transaction journal',undefined,[query('since')]);
for(const route of ['/api/parts/{id}','/api/deformers/{id}']) endpoint(route,'get','Read one detailed record',undefined,[{name:'id',in:'path',required:true,schema:{type:'string'}}]);
endpoint('/api/rig','get','Read full rig; asset payloads require includeAssets=1',undefined,[query('includeAssets')]);
endpoint('/api/rig','put','Import/restore full RigDocument; replaces active model',{...object,description:'RigDocument from /api/schema. Import/restore only; no transaction QA.'},[query('includeAssets')]);
const qa=z.toJSONSchema(qaSchema);
endpoint('/api/qa/check','post','Run numeric QA on stored rig',{$ref:'#/components/schemas/QaCheckRequest'});
endpoint('/api/modeling/transaction','post','Dry-run or QA-gated modeling commit',{$ref:'#/components/schemas/TransactionRequest'});
endpoint('/api/assets/externalize','post','Externalize embedded images; dryRun:false writes rig and files',{type:'object',required:['rig'],properties:{rig:object,dryRun:{type:'boolean',default:true}}});
for(const [route,method] of [['/api/screenshot','get'],['/api/reference/sheet','get'],['/api/qa/failure-image','post']]) {
  endpoint(route,method,'Render stored model PNG',method==='post'?{type:'object',required:['poseId','region'],properties:{poseId:{type:'string'},region:{type:'string'},beforePoseId:{type:'string'},width:{type:'number',default:240},height:{type:'number',default:240},physics:{type:'boolean',default:false}}}:undefined,method==='get'?['set','detail','partIds','physics','ParamAngleX','ParamAngleY','ParamAngleZ','width','height'].map(name=>query(name)):undefined);
  paths[route][method].responses[200]={description:'PNG image',content:{'image/png':{schema:{type:'string',format:'binary'}}}};
}
for(const route of serviceRoutes.values()) for(const method of route.methods) {
  endpoint(route.path,method.toLowerCase(),'Local service '+route.path,method==='POST'?object:undefined);
}
paths['/api/playback/events'].get.responses[200]={description:'SSE latest playback state',content:{'text/event-stream':{schema:{type:'string'}}}};
const numericValues={type:'object',additionalProperties:{type:'number'},description:'Finite model parameter values. Playback also requires known IDs and values within their declared ranges.'};
const bodySchema=(route,schema)=>{ paths[route].post.requestBody.content['application/json'].schema=schema; };
bodySchema('/api/playback/motion',z.toJSONSchema(motionRequestSchema));
bodySchema('/api/playback/parameters',{type:'object',required:['source','sequence','values'],properties:{expectedSessionId:{type:'string',description:'Reject when the service session differs.'},expectedModelVersion:{type:'integer',description:'Reject when the loaded model version differs.'},source:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,64}$'},sequence:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,description:'Strictly increasing per source. Use a new source ID for a new input session.'},values:numericValues}});
bodySchema('/api/playback/control',{type:'object',required:['command'],properties:{command:{type:'string',enum:['play','pause','reset','demo-start','demo-stop','demo-pointer']},mode:{type:'string',enum:['showcase-active','mouse-expression']},x:{type:'number',minimum:-1,maximum:1},y:{type:'number',minimum:-1,maximum:1}},description:'demo-start defaults to showcase-active; demo-pointer requires x/y and active mouse-expression mode. Stop/play/pause/reset and valid numeric input restore the pre-demo pose before applying the command.'});
for(const route of ['/api/playback/reload','/api/checkpoints','/api/exports/bundle']) bodySchema(route,{type:'object',additionalProperties:false});
bodySchema('/api/checkpoints/restore',{type:'object',required:['id','expectedRevision'],properties:{id:{type:'string',format:'uuid'},expectedRevision:{type:'string',minLength:1}}});
for(const route of ['/api/checkpoints','/api/exports/bundle']) {
  paths[route].post.responses[201]=paths[route].post.responses[200];
  delete paths[route].post.responses[200];
}
const failureSchema=paths['/api/qa/failure-image'].post.requestBody.content['application/json'].schema;
Object.assign(failureSchema.properties,{values:numericValues,beforeValues:numericValues,physicsTime:{type:'number'},physicsSteps:{type:'integer',minimum:0,maximum:240},supersample:{type:'integer',minimum:1,maximum:2}});
failureSchema.description='Pass a failureRegions[].imageRequest returned by QA, preserving sampled values and physics settings. Panels compare two poses of the same stored model.';
const playbackSnapshot={type:'object',required:['version','sessionId','revision','modelVersion','playing','values','connectedOutputs','outputAcknowledged'],properties:{inputContractVersion:{const:2},version:{const:1},sessionId:{type:'string',format:'uuid',description:'Changes on service restart; compare together with modelVersion.'},revision:{type:'integer'},modelVersion:{type:'integer'},playing:{type:'boolean'},physicsEpoch:{type:'integer',minimum:0},motion:{type:'object',properties:{loaded:{type:'boolean'},name:{type:['string','null']},duration:{type:'number'},time:{type:'number'},running:{type:'boolean'},active:{type:'boolean'},ended:{type:'boolean'},speed:{type:'number',minimum:0.1,maximum:4},loop:{type:'boolean'},parameterIds:{type:'array',items:{type:'string'}}}},demo:{type:'object',properties:{active:{type:'boolean'},mode:{type:'string',enum:['showcase-active','mouse-expression']},parameterIds:{type:'array',items:{type:'string'}}}},values:numericValues,lastSource:{type:['string','null']},connectedOutputs:{type:'integer',minimum:0},outputAcknowledged:{const:false},parameters:{type:'array',items:object}}};
for(const route of ['/api/playback','/api/playback/parameters','/api/playback/control','/api/playback/reload']) for(const method of Object.keys(paths[route])) paths[route][method].responses[200]={description:'Transient playback state; not a render acknowledgment.',content:{'application/json':{schema:{type:'object',required:['ok','playback'],properties:{ok:{const:true},playback:playbackSnapshot}}}}};
for(const method of ['get','post']) paths['/api/playback/motion'][method].responses[200]={description:'Motion state; GET also returns the loaded native clip or null.',content:{'application/json':{schema:{type:'object',properties:{ok:{const:true},playback:playbackSnapshot,...(method==='get'?{clip:{anyOf:[{$ref:'#/components/schemas/MotionClip'},{type:'null'}]}}:{})}}}}};
const operation=z.toJSONSchema(operationSchema);
const spec={openapi:'3.1.0',info:{title:'StandRig Modeling Tools - core API',version:'0.2.0',description:'Core endpoints only. Full route/method inventory: docs/api-routes.json. Full action types: docs/OPERATIONS.md. This is a local single-writer tool. Numeric success is not visual acceptance.'},servers:[{url:'http://127.0.0.1:5180'}],paths,components:{schemas:{QaCheckRequest:qa,ModelingOperation:operation,TransactionRequest:{},MotionClip:z.toJSONSchema(motionClipSchema),MotionRequest:z.toJSONSchema(motionRequestSchema)}}};
const strictTransaction=z.toJSONSchema(transactionSchema);
spec.components.schemas.ModelingOperation=operation;
spec.components.schemas.TransactionRequest={oneOf:[strictTransaction,{type:'object',additionalProperties:false,required:['kind','expectedRevision','rig','qa'],properties:{kind:{const:'import'},expectedRevision:{type:'string',minLength:1},commit:{type:'boolean',default:false},rig:object,qa:{$ref:'#/components/schemas/QaCheckRequest'}}},{type:'object',additionalProperties:false,required:['kind','expectedRevision','checkpointId'],properties:{kind:{const:'restore'},expectedRevision:{type:'string',minLength:1},commit:{type:'boolean',default:false},checkpointId:{type:'string',format:'uuid'}}}]};
for(const endpoint of endpoints)if(endpoint.legacyWriteOptIn)for(const method of endpoint.methods)if(!endpoint.defaultMethods.includes(method)&&paths[endpoint.path]?.[method.toLowerCase()])Object.assign(paths[endpoint.path][method.toLowerCase()],{deprecated:true,description:'Disabled by default (403 legacy_write_api_disabled). Prefer /api/modeling/transaction. Explicit --allow-legacy-writes enables the legacy bypass.'});
await fs.writeFile('docs/openapi.json',JSON.stringify(spec,null,2)+'\n');
console.log(JSON.stringify({routes:endpoints.length,actions:actionTypes.length,coreOpenApiPaths:Object.keys(paths).length}));

// Run after loading Sample Bot. Changes only transient playback parameters.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../packages/mcp/src/cli.mjs',import.meta.url))],env:{...process.env},stderr:'pipe'});
const client=new Client({name:'standrig-demo',version:'0.2.0'});
try {
  await client.connect(transport);
  for (const [name,args] of [
    ['standrig_context',{}],
    ['standrig_qa_check',{poseSamples:[{poseId:'demo',values:{ParamAngleZ:25,ParamMouthOpen:0.8}}],regions:['full']}],
    ['standrig_playback_parameters',{values:{ParamAngleZ:25,ParamMouthOpen:0.8}}],
    ['standrig_playback_control',{command:'play'}]
  ]) {
    const result=await client.callTool({name,arguments:args});
    if(result.isError)throw new Error(JSON.stringify(result));
    console.log(name, 'ok');
  }
} finally { await client.close(); await transport.close(); }

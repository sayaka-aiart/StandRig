import {reserveQaMemory} from '../../apps/service/dist/qaMemory.js';
const settings=JSON.parse(process.env.STANDRIG_QA_TEST);
const controller=new AbortController();let lease;
process.on('message',async message=>{
 try {
  if(message==='abort')controller.abort();
  if(message==='release'){await lease?.release();process.send({kind:'released'});process.disconnect();}
 }catch(error){process.send({kind:'error',error:String(error)});process.disconnect();}
});
try {
 lease=await reserveQaMemory(settings.perWorker,settings.maximum,controller.signal,()=>process.send({kind:'waiting'}),{directory:settings.directory,port:settings.port,available:()=>settings.available});
 process.send({kind:'acquired',workers:lease.workers});
}catch(error){process.send({kind:'error',error:String(error)});process.disconnect();}

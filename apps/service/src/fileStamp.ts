import { stat } from 'node:fs/promises';
export async function fileStamp(file:string) { const s=await stat(file,{bigint:true});return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }

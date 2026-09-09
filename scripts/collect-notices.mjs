import fs from 'node:fs/promises';
import path from 'node:path';
const lock=JSON.parse(await fs.readFile('package-lock.json','utf8'));
const lines=['# Third-party notices','','The following dependencies are locked in package-lock.json, including optional platform packages. Versions and license identifiers below come from the installed/locked package metadata. Installed package license/notice texts are copied into licenses/. npm ci obtains the actual dependencies with their own notices.','','StandRig original code is licensed under Apache-2.0. Third-party components retain their own licenses.','','| Package | Version | Declared license |','| --- | --- | --- |'];
for(const [location,meta] of Object.entries(lock.packages)) {
  if(!location.startsWith("node_modules/") || meta.link)continue;
  const name=location.replace(/^node_modules\//,'');
  lines.push(`| ${name} | ${meta.version} | ${meta.license||'See package'} |`);
  const entries=await fs.readdir(location).catch(()=>[]);
  for(const file of entries.filter(name=>/^(license|licence|notice|third.party)/i.test(name))) {
    const entry=path.join(location,file);
    if(!(await fs.stat(entry)).isFile())continue;
    const target=path.join('licenses',name.replaceAll('/','__'),file);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(entry,target);
  }
}
lines.push('', 'Lightning CSS (MPL-2.0) is an unmodified optional build dependency. Its source for version 1.32.0 is available at https://github.com/parcel-bundler/lightningcss/tree/v1.32.0 ; preserve its license and source availability information when redistributing the binary dependency. This source ZIP does not bundle node_modules or compiled dependencies.');
await fs.writeFile('THIRD_PARTY_NOTICES.md' ,lines.join('\n')+'\n');

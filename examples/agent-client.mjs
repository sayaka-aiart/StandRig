import { readFile } from 'node:fs/promises';
const base = process.env.STANDRIG_URL || 'http://127.0.0.1:5180';
const input = process.argv[2];
let endpoint = '/api/context';
let options;
if (input) {
  const raw = await readFile(input,'utf8');
  const body = JSON.parse(raw);
  if (body.commit !== false) throw new Error('This example is dry-run only: commit must be false.');
  if (/REPLACE_WITH_/.test(raw)) throw new Error('Replace the example revision and target IDs from current context/parts first.');
  if (!body.expectedRevision || !body.qa || !body.operations?.length) throw new Error('expectedRevision, qa and nonempty operations are required.');
  endpoint = '/api/modeling/transaction';
  options = {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};
}
const response = await fetch(base+endpoint, options);
const result = await response.json();
console.log(JSON.stringify({httpStatus:response.status,...result},null,2));
if (!response.ok || result.ok === false) process.exitCode=1;

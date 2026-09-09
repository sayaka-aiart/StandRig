// Synthetic numeric input; no camera or AI calls. Run after loading Sample Bot.
const base=process.env.STANDRIG_URL || 'http://127.0.0.1:5180';
const source='demo_'+Date.now();
async function post(route,body) {
  const response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok||result.ok===false)throw new Error(JSON.stringify(result));
}
await post('/api/playback/control',{command:'play'});
try {
  for(let sequence=0;sequence<150;sequence++) {
    await post('/api/playback/parameters',{source,sequence,values:{ParamAngleZ:20*Math.sin(sequence/20),ParamMouthOpen:(Math.sin(sequence/9)+1)/2}});
    await new Promise(resolve=>setTimeout(resolve,33));
  }
} finally { await post('/api/playback/control',{command:'reset'}); await post('/api/playback/control',{command:'pause'}); }

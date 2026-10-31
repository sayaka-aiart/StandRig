import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startFrameTimer} from '../apps/service/dist/frameTimer.js';

function coarseClock() {
 let now=0,queue=[],unrefs=0;
 return {
  now:()=>now,
  schedule(callback,delay){const event={at:Math.ceil((now+delay)/15.625)*15.625,callback,cancelled:false};queue.push(event);return {cancel:()=>event.cancelled=true,unref:()=>unrefs++};},
  advance(end){while(true){queue.sort((a,b)=>a.at-b.at);const next=queue.find(e=>!e.cancelled);if(!next||next.at>end)break;queue.splice(queue.indexOf(next),1);now=next.at;next.callback();}now=Math.max(now,end);},
  work(ms){now+=ms;},unrefs:()=>unrefs
 };
}
test('deadline correction sustains 30Hz with a 15.625ms coarse clock without cumulative drift',()=>{
 const clock=coarseClock(),times=[],timer=startFrameTimer(()=>times.push(clock.now()),30,clock);timer.unref();clock.advance(3000);
 assert.ok(times.length>=89&&times.length<=90,String(times.length));
 assert.ok(times.every((time,i)=>time-(i+1)*1000/30<15.626));
 assert.ok(clock.unrefs()>80);timer.stop();const n=times.length;clock.advance(6000);assert.equal(times.length,n);
});
test('late frames are skipped without catch-up bursts and stopping inside a callback stays stopped',()=>{
 const clock=coarseClock(),times=[];let timer;timer=startFrameTimer(()=>{times.push(clock.now());clock.work(180);if(times.length===3)timer.stop();},30,clock);
 clock.advance(3000);assert.equal(times.length,3);assert.ok(times[1]-times[0]>=180);
 assert.throws(()=>startFrameTimer(()=>{},0,clock),/frame rate/);
});

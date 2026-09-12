import { StandRigPlayer, type PlaybackSnapshot } from '@standrig/runtime';
import { fetchRigDocument } from '@standrig/core/io';

const canvas = document.querySelector('canvas')!;
const error = document.querySelector('#error')!;
let player: StandRigPlayer | undefined;
let modelVersion = -1;
let physicsEpoch: number | undefined;
let sessionId: string | undefined;
let pending: PlaybackSnapshot | undefined;
let applying = false;
async function drain() {
  if (applying) return;
  applying = true;
  try {
    while (pending) {
      const state = pending;
      pending = undefined;
      if (!player || modelVersion !== state.modelVersion || sessionId !== state.sessionId) {
        const rig = await fetchRigDocument();
        player?.dispose();
        player = new StandRigPlayer(canvas, rig);
        player.setRenderer(new URLSearchParams(location.search).get('renderer') === 'webgl' ? 'webgl' : 'canvas');
        await player.load();
        modelVersion = state.modelVersion;
        sessionId = state.sessionId; physicsEpoch = undefined;
      }
      if (physicsEpoch !== state.physicsEpoch) { player.resetPhysics(); physicsEpoch = state.physicsEpoch; }
      if (!state.playing) player.pause();
      player.setParameters(state.values);
      if (state.playing) player.play();
      error.textContent = '';
      canvas.dataset.playbackRevision = String(state.revision);
      canvas.dataset.modelVersion = String(state.modelVersion);
    }
  } catch (cause) { error.textContent = String(cause); modelVersion = -1; }
  finally { applying = false; }
}
const events = new EventSource('/api/playback/events');
events.addEventListener('playback', event => { pending = JSON.parse((event as MessageEvent).data); void drain(); });
events.onerror = () => { player?.pause(); error.textContent = '再生サービスへ再接続しています…'; };
window.addEventListener('pagehide', () => { events.close(); player?.dispose(); });

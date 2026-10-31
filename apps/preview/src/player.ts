import { StandRigPlayer, type PlaybackSnapshot } from '@standrig/runtime';
import { fetchRigDocument } from '@standrig/core/io';
import { ModelReload } from './modelReload.js';
import { playbackEvents } from './playbackEvents.js';

const canvas = document.querySelector('canvas')!;
const error = document.querySelector('#error')!;
let player: StandRigPlayer | undefined;
let physicsEpoch: number | undefined;
const reload = new ModelReload<PlaybackSnapshot, StandRigPlayer>({
  key: state => `${state.sessionId}:${state.modelVersion}`,
  async load() {
    const candidate = new StandRigPlayer(canvas, await fetchRigDocument());
    candidate.setRenderer(new URLSearchParams(location.search).get('renderer') === 'webgl' ? 'webgl' : 'canvas');
    try { await candidate.load(); return candidate; } catch (error) { candidate.dispose(); throw error; }
  },
  install(candidate) { player?.dispose(); player = candidate; physicsEpoch = undefined; },
  discard(candidate) { candidate.dispose(); },
  error(cause) { error.textContent = `読み込みを再試行します: ${String(cause)}`; },
  apply(state) {
      if (!player) return;
      if (physicsEpoch !== state.physicsEpoch) { player.resetPhysics(); physicsEpoch = state.physicsEpoch; }
      if (!state.playing) player.pause();
      player.setParameters(state.values);
      if (state.playing) player.play();
      error.textContent = '';
      canvas.dataset.playbackRevision = String(state.revision);
      canvas.dataset.modelVersion = String(state.modelVersion);
  }
});
const events = playbackEvents(state => reload.update(state), () => { player?.pause(); error.textContent = '再生サービスへ再接続しています…'; });
window.addEventListener('pagehide', () => { events.close(); reload.dispose(); player?.dispose(); });

import { PlaybackDecoder } from '@standrig/runtime/playbackWire';
import type { PlaybackSnapshot } from '@standrig/runtime';
export function playbackEvents(consume: (state: PlaybackSnapshot) => void, error: () => void) {
  let source: EventSource, timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const connect = () => {
    if (stopped) return;
    const decoder = new PlaybackDecoder();
    const connection = new EventSource('/api/playback/events?delta=1');source=connection;
    let recovering=false;
    connection.addEventListener('playback', event => {
      if(stopped||connection!==source||recovering)return;
      try { consume(decoder.accept(JSON.parse((event as MessageEvent).data))); }
      catch { recovering=true;connection.close(); error(); timer = setTimeout(connect, 500); }
    });
    connection.onerror = () => {if(!stopped&&connection===source)error();};
  };
  connect();
  return { close() { stopped = true; clearTimeout(timer); source.close(); } };
}

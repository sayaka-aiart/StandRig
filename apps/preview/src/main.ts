import './styles.css';
import { createRigFromPsdFile } from '@standrig/core/importers';
import { fetchRigDocument, downloadRigDocument } from '@standrig/core/io';
import { StandRigPlayer, type PlaybackSnapshot } from '@standrig/runtime';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { ParameterValues, RigDocument } from '@standrig/core/types';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><div><span class="eyebrow">AI MODELING WORKSPACE</span><h1>StandRig <span>Modeling & Playback</span></h1></div><a href="/player" target="_blank" class="badge">再生画面を開く ↗</a></header>
<main><section class="stage-panel"><div class="stage-heading"><h2 id="model-name">読み込み中…</h2><button id="reload">再読み込み</button></div><div class="motion-controls"><label>動作デモ <select id="demo-mode" aria-label="動作デモの種類"><option value="showcase-active">Showcase — Fast &amp; Wide</option><option value="mouse-expression">Mouse + Expressions</option></select></label><button id="demo" aria-pressed="false" disabled>デモを開始</button><p id="demo-status" role="status">モデルを読み込んでください。</p></div><div class="canvas-wrap"><canvas width="800" height="900" aria-label="モデルプレビュー"></canvas><div id="empty"><b>素材から、動くモデルへ。</b><p>パーツ分け済みPSDを読み込んで始めます。</p></div></div><p class="caption">動作デモはこの画面と「再生画面」に反映されます。パラメータ操作はモデルの保存内容を変更しません。</p></section>
<aside><section><h2>素材を読み込む</h2><p>対応素材：パーツ分け済みPSD。読み込み前のモデルは自動でチェックポイントに保存します。</p><label class="file-label">PSDを選択<input id="files" type="file" accept=".psd"></label><p id="selection">ファイル未選択</p><button id="import" class="primary" disabled>PSDを読み込む</button><button id="export">モデルJSONを書き出す</button><button id="sample">サンプルを試す</button></section>
<section><h2>AIへ渡す入口</h2><code id="api-url"></code><p>MCP接続の設定は <b>docs/MCP.md</b>、操作手順は <b>AI_OPERATING_GUIDE.md</b> を参照してください。</p><button id="qa">数値QAを実行</button><pre id="status" role="status" aria-live="polite">起動中…</pre></section>
<section><div class="stage-heading"><h2>姿勢・再生</h2><button id="reset">初期値</button></div><button id="play">再生</button> <button id="pause">一時停止</button><div id="params"></div></section></aside></main>`;
const canvas = document.querySelector('canvas')!;
const status = document.querySelector<HTMLPreElement>('#status')!;
const filesInput = document.querySelector<HTMLInputElement>('#files')!;
const importButton = document.querySelector<HTMLButtonElement>('#import')!;
const sampleButton = document.querySelector<HTMLButtonElement>('#sample')!;
const qaButton = document.querySelector<HTMLButtonElement>('#qa')!;
let rig: RigDocument;
let runtime: StandRigPlayer;
let values: ParameterValues;
let importing = false;
let modelVersion = -1;
let sessionId: string | undefined;
let latest: PlaybackSnapshot | undefined;
let reloadQueue = Promise.resolve();
let inputSequence = 0;
const inputSource = 'preview_' + crypto.randomUUID().replaceAll('-', '');
let inputQueue = Promise.resolve();
const demoButton = document.querySelector<HTMLButtonElement>('#demo')!;
const demoMode = document.querySelector<HTMLSelectElement>('#demo-mode')!;
demoButton.onclick = () => { void post('/api/playback/control', { command: latest?.demo?.active ? 'demo-stop' : 'demo-start', mode: demoMode.value }).catch(report); };
demoMode.onchange = () => { if (latest?.demo?.active) void post('/api/playback/control', { command: 'demo-start', mode: demoMode.value }).catch(report); };
let pointerPending: { x: number; y: number } | undefined;
let pointerSending = false;
canvas.onpointermove = event => {
  if (!latest?.demo?.active || latest.demo.mode !== 'mouse-expression') return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  pointerPending = { x: Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1)), y: Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1)) };
};
canvas.onpointerleave = () => { pointerPending = { x: 0, y: 0 }; };
const pointerTimer = setInterval(() => {
  if (pointerSending || !pointerPending) return;
  const pointer = pointerPending; pointerPending = undefined;
  if (!latest?.demo?.active || latest.demo.mode !== 'mouse-expression') return;
  pointerSending = true;
  void post('/api/playback/control', { command: 'demo-pointer', ...pointer }).catch(report).finally(() => { pointerSending = false; });
}, 50);
document.querySelector('#api-url')!.textContent = `${location.origin}/api/context`;
function report(error: unknown) { status.textContent = error instanceof Error ? error.message : String(error); }
function render() { if (runtime && values) runtime.setParameters(values); }
new ResizeObserver(render).observe(canvas.parentElement!);
async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(JSON.stringify(result));
  return result;
}
function sendPose(patch: ParameterValues) {
  const sequence = ++inputSequence;
  inputQueue = inputQueue.catch(() => {}).then(() => post('/api/playback/parameters', { source: inputSource, sequence, values: patch })).then(() => {});
  return inputQueue;
}
function parameters() {
  const container = document.querySelector('#params')!;
  container.replaceChildren();
  for (const param of parameterDefinitionsForRig(rig)) {
    const label = document.createElement('label'); label.className = 'parameter';
    const caption = document.createElement('span'); caption.textContent = param.label;
    const output = document.createElement('output'); output.textContent = String(values[param.id]);
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(param.min); input.max = String(param.max); input.step = String(param.step ?? 0.1); input.value = String(values[param.id]); input.setAttribute('aria-label', param.id);
    input.oninput = () => { values[param.id] = Number(input.value); output.textContent = input.value; render(); void sendPose({ [param.id]: Number(input.value) }).catch(report); };
    label.append(caption, output, input); container.append(label);
  }
}
function applyState() {
  if (!latest || !rig || modelVersion !== latest.modelVersion || sessionId !== latest.sessionId) return;
  values = { ...latest.values };
  for (const input of document.querySelectorAll<HTMLInputElement>('#params input')) {
    const id = input.getAttribute('aria-label')!;
    if (document.activeElement !== input) { input.value = String(values[id]); input.parentElement!.querySelector('output')!.textContent = input.value; }
  }
  if (latest.playing) runtime.play(); else runtime.pause();
  const demo = latest.demo;
  const active = !!demo?.active;
  demoButton.disabled = !demo?.parameterIds.length;
  demoButton.textContent = active ? 'デモを停止' : 'デモを開始';
  demoButton.setAttribute('aria-pressed', String(active));
  if (active) demoMode.value = demo!.mode;
  canvas.style.cursor = active && demo?.mode === 'mouse-expression' ? 'crosshair' : '';
  document.querySelector('#demo-status')!.textContent = !demo?.parameterIds.length
    ? '動きの設定がありません。サンプルを試すか、AIでモデリングしてください。'
    : active ? (demo.mode === 'mouse-expression' ? 'プレビュー上でマウスを動かすと追従します。瞬き・ウィンク・口の動きは自動です。' : 'Showcase再生中：顔・体・視線・表情を自動で動かします。')
    : '開始前の姿勢は停止時に復元します。動きが設定された部位で確認できます。';
  render();
}
function reload() {
  reloadQueue = reloadQueue.catch(() => {}).then(async () => {
    const version = latest?.modelVersion ?? -1;
    const session = latest?.sessionId;
    rig = await fetchRigDocument(); values = previewParameterValuesForRig(rig);
    runtime?.dispose();
    runtime = new StandRigPlayer(canvas, rig); await runtime.load(); modelVersion = version;
    sessionId = session;
    document.querySelector('#model-name')!.textContent = rig.name;
    document.querySelector<HTMLElement>('#empty')!.hidden = rig.assets.length > 0;
    qaButton.disabled = rig.assets.length === 0;
    parameters(); applyState(); render();
    status.textContent = rig.assets.length ? `${rig.parts.length} parts / ${rig.assets.length} assets\n読み込み完了` : 'パーツ分け済みPSDを読み込むか、サンプルを試してください。';
  });
  return reloadQueue;
}
function busy(value: boolean) { importing = value; importButton.disabled = value || !filesInput.files?.length; sampleButton.disabled = value; }
filesInput.onchange = () => { document.querySelector('#selection')!.textContent = filesInput.files?.[0]?.name ?? 'ファイル未選択'; busy(importing); };
importButton.onclick = async () => {
  const files = Array.from(filesInput.files ?? []);
  if (importing || !files.length) return;
  busy(true); status.textContent = 'PSDを読み込んでいます…';
  try {
    if (files.length !== 1 || !/\.psd$/i.test(files[0].name)) throw new Error('パーツ分け済みPSDを1ファイル選択してください。');
    const imported = await createRigFromPsdFile(files[0]);
    await post('/api/checkpoints', {}); await post('/api/rig', imported); await reload();
  } catch (error) { report(error); } finally { busy(false); }
};
sampleButton.onclick = async () => {
  if (importing) return;
  busy(true);
  try { const sample = await fetch('/api/sample').then(r => r.json()); await post('/api/checkpoints', {}); await post('/api/rig', sample); await reload(); }
  catch (error) { report(error); } finally { busy(false); }
};
for (const command of ['play','pause','reset']) document.querySelector<HTMLButtonElement>('#' + command)!.onclick = () => { void post('/api/playback/control', { command }).catch(report); };
document.querySelector<HTMLButtonElement>('#reload')!.onclick = () => { void reload().catch(report); };
document.querySelector<HTMLButtonElement>('#export')!.onclick = () => { if (rig) downloadRigDocument(rig); };
qaButton.onclick = async () => {
  qaButton.disabled = true; status.textContent = '数値QAを実行しています…';
  try {
    const response = await fetch('/api/qa/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ poseSamples: [{ poseId: 'preview', values }], regions: ['full'], width: 240, height: 240, physics: false }) });
    status.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (error) { report(error); } finally { qaButton.disabled = false; }
};
const events = new EventSource('/api/playback/events');
events.addEventListener('playback', event => {
  const previousVersion = latest?.modelVersion;
  const previousSession = latest?.sessionId;
  latest = JSON.parse((event as MessageEvent).data);
  if (previousVersion !== latest?.modelVersion || previousSession !== latest?.sessionId) void reload().catch(report);
  else applyState();
});
events.onerror = () => { status.textContent = '再生サービスへ再接続しています…'; };
window.addEventListener('pagehide', () => { events.close(); runtime?.dispose(); clearInterval(pointerTimer); });

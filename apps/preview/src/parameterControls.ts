import type { ParameterDefinition, ParameterValues } from '@standrig/core/types';
import type { VisemeBank, VisemeId } from '@standrig/core/facialTypes';
import { CUBISM_VERTICAL_PARAMETERS } from '@standrig/core/parameters';

export interface ParameterPad {
  name: string;
  parameters: string[];
  axes: [string, string];
}

export const visemeLabels: Record<VisemeId, string> = {
  A: 'あ', I: 'い', U: 'う', E: 'え', O: 'お', Silence: '無音'
};

// Cubism Motion-sync's Basic layout, in the standard Form/OpenY ranges.
// The diagram does not assign a coordinate for E.
const cubismBasic: Partial<Record<VisemeId, ParameterValues>> = {
  A: { ParamMouthForm: 1, ParamMouthOpenY: 1 },
  I: { ParamMouthForm: 1, ParamMouthOpenY: 0.5 },
  U: { ParamMouthForm: -1, ParamMouthOpenY: 0.5 },
  O: { ParamMouthForm: -1, ParamMouthOpenY: 1 }
};

function isMouthPad(axes: readonly string[]): boolean {
  return axes.includes('ParamMouthForm') &&
    (axes.includes('ParamMouthOpenY') || axes.includes('ParamMouthOpen'));
}

export function mouthPadPoints(axes: [ParameterDefinition, ParameterDefinition], bank: VisemeBank | undefined, cubism: boolean) {
  const ids = axes.map(axis => axis.id);
  if (!isMouthPad(ids) || bank?.mode === 'blend-shape') return [];
  const points: Array<{ id: VisemeId; values: ParameterValues; registered: boolean }> = [];
  for (const id of Object.keys(visemeLabels) as VisemeId[]) {
    const saved = bank?.presets.find(preset => preset.id === id);
    const values = saved?.values ?? (cubism ? cubismBasic[id] : undefined);
    if (!values || !axes.every(axis => {
      const value = values[axis.id];
      return typeof value === 'number' && value >= axis.min && value <= axis.max;
    })) continue;
    points.push({ id, values, registered: saved !== undefined });
  }
  return points;
}

export function padValue(parameter: ParameterDefinition, fraction: number): number {
  const position = Math.max(0, Math.min(1, fraction));
  if (position === 0) return parameter.min;
  if (position === 1) return parameter.max;
  const step = parameter.step && parameter.step > 0 ? parameter.step : 0.1;
  const value = parameter.min + Math.round(position * (parameter.max - parameter.min) / step) * step;
  return Math.max(parameter.min, Math.min(parameter.max, Number(value.toPrecision(14))));
}

function verticalPadDirection(parameter: ParameterDefinition, pitchUp: 1 | -1): 1 | -1 {
  return pitchUp === -1 && CUBISM_VERTICAL_PARAMETERS.some(id => id === parameter.id) ? 1 : -1;
}

function verticalPadFraction(parameter: ParameterDefinition, fraction: number, pitchUp: 1 | -1): number {
  return verticalPadDirection(parameter, pitchUp) === 1 ? fraction : 1 - fraction;
}

export function padPatch(axes: [ParameterDefinition, ParameterDefinition], x: number, y: number, pitchUp: 1 | -1 = -1): ParameterValues {
  const [horizontal, vertical] = axes;
  return {
    [horizontal.id]: padValue(horizontal, x),
    [vertical.id]: padValue(vertical, verticalPadFraction(vertical, y, pitchUp))
  };
}

export function restorePads(raw: unknown, definitions: ParameterDefinition[]): ParameterPad[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(definitions.filter(p => p.max > p.min).map(p => p.id));
  const used = new Set<string>();
  const pads: ParameterPad[] = [];
  for (const item of raw) {
    if (!item || typeof item.name !== 'string' || !Array.isArray(item.parameters)) continue;
    const parameters = [...new Set<string>(item.parameters.filter((id: unknown) => typeof id === 'string' && allowed.has(id) && !used.has(id)))];
    if (parameters.length < 2) continue;
    const axes = Array.isArray(item.axes) ? item.axes.filter((id: unknown) => parameters.includes(id as string)) : [];
    const pair = [...new Set<string>([...axes, ...parameters])].slice(0, 2) as [string, string];
    pads.push({ name: item.name.slice(0, 120), parameters, axes: pair });
    parameters.forEach(id => used.add(id));
  }
  return pads;
}

export function createParameterControls(container: HTMLElement, host: {
  values(): ParameterValues;
  change(patch: ParameterValues): void;
  previewViseme(id: VisemeId): Promise<void>;
  previewInitialViseme(values: ParameterValues): Promise<void>;
  editViseme(id?: VisemeId): void;
}) {
  let definitions: ParameterDefinition[] = [];
  let pads: ParameterPad[] = [];
  let pitchUp: 1 | -1 = -1;
  let mouth: { axes: [string, string]; visemes?: VisemeBank } | undefined;
  let storageKey = '';
  const sliders: Array<{ parameter: ParameterDefinition; input: HTMLInputElement; output: HTMLOutputElement }> = [];
  const padViews: Array<{ pad: ParameterPad; marker: HTMLElement; surface: HTMLElement }> = [];
  const message = document.createElement('p');
  message.className = 'pad-message';
  message.setAttribute('role', 'status');
  const add = document.createElement('button');
  add.type = 'button'; add.textContent = 'XYパッドを追加';
  const addMouth = document.createElement('button');
  addMouth.type = 'button'; addMouth.textContent = '口のXYパッドを追加'; addMouth.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'pad-actions';
  actions.append(add, addMouth);
  const list = document.createElement('div');
  const dialog = document.createElement('dialog');
  dialog.className = 'parameter-pad-dialog';
  dialog.setAttribute('aria-label', 'パラメータをまとめる');
  container.append(actions, message, list, dialog);

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(pads)); message.textContent = ''; }
    catch { message.textContent = 'パッドの配置を保存できませんでした。この画面では操作できます。'; }
  }
  function definition(id: string) { return definitions.find(p => p.id === id)!; }
  function ratio(p: ParameterDefinition, value: number) {
    return Math.max(0, Math.min(1, (value - p.min) / (p.max - p.min)));
  }
  function change(patch: ParameterValues) { host.change(patch); update(); }
  function slider(parameter: ParameterDefinition) {
    const label = document.createElement('label'); label.className = 'parameter';
    const caption = document.createElement('span'); caption.textContent = parameter.label;
    const output = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(parameter.min); input.max = String(parameter.max);
    input.step = String(parameter.step ?? 0.1); input.setAttribute('aria-label', parameter.id);
    input.disabled = parameter.min === parameter.max;
    input.oninput = () => change({ [parameter.id]: Number(input.value) });
    label.append(caption, output, input);
    sliders.push({ parameter, input, output });
    return label;
  }
  function axisSelect(pad: ParameterPad, axis: 0 | 1) {
    const label = document.createElement('label');
    label.textContent = axis === 0 ? 'X軸 ' : 'Y軸 ';
    const select = document.createElement('select');
    select.setAttribute('aria-label', pad.name + (axis === 0 ? ' X軸' : ' Y軸'));
    for (const id of pad.parameters) {
      const option = document.createElement('option'); option.value = id; option.textContent = definition(id).label;
      select.append(option);
    }
    select.value = pad.axes[axis];
    select.onchange = () => {
      const previous = pad.axes[axis];
      if (select.value === pad.axes[1 - axis]) pad.axes[1 - axis] = previous;
      pad.axes[axis] = select.value;
      save(); rebuild();
    };
    label.append(select); return label;
  }
  function addMouthLabels(surface: HTMLElement, axes: [ParameterDefinition, ParameterDefinition]) {
    const [x, y] = axes;
    const points = mouthPadPoints(axes, mouth?.visemes, pitchUp === 1);
    let selected: VisemeId | undefined;
    let selecting = false;
    const groups = new Map<string, HTMLElement>();
    for (const point of points) {
      const left = ratio(x, point.values[x.id]) * 100;
      const top = verticalPadFraction(y, ratio(y, point.values[y.id]), pitchUp) * 100;
      const key = left + ':' + top;
      let group = groups.get(key);
      if (!group) {
        const dot = document.createElement('span');
        dot.className = 'pad-viseme-dot';
        dot.style.left = left + '%';
        dot.style.top = top + '%';
        dot.setAttribute('aria-hidden', 'true');
        surface.append(dot);
        group = document.createElement('span');
        group.className = 'pad-viseme-point';
        group.style.left = left + '%';
        group.style.top = top + '%';
        group.dataset.side = left < 15 ? 'left' : left > 85 ? 'right' : 'middle';
        if (top < 15) group.dataset.edge = 'top';
        group.onpointerdown = event => event.stopPropagation();
        groups.set(key, group);
        surface.append(group);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = visemeLabels[point.id];
      button.dataset.registered = String(point.registered);
      button.setAttribute('aria-label', visemeLabels[point.id] + (point.registered ? '（登録済み）' : '（Cubism基本の目安）'));
      button.onclick = async () => {
        if (selecting) return;
        selecting = true;
        selected = point.id;
        try {
          if (point.registered) await host.previewViseme(point.id);
          else await host.previewInitialViseme(point.values);
        } finally {
          selecting = false;
        }
      };
      group.append(button);
    }
    const footer = document.createElement('div');
    footer.className = 'pad-viseme-actions';
    if (points.some(point => !point.registered)) {
      const legend = document.createElement('p');
      legend.textContent = '点線はCubism基本の目安です。';
      footer.append(legend);
    }
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '母音を登録／編集';
    edit.onclick = () => { if (!selecting) host.editViseme(selected); };
    footer.append(edit);
    return footer;
  }
  function padCard(pad: ParameterPad) {
    const card = document.createElement('div'); card.className = 'parameter-pad-card';
    const heading = document.createElement('div'); heading.className = 'pad-heading';
    const title = document.createElement('h3'); title.textContent = pad.name;
    const edit = document.createElement('button'); edit.textContent = '編集'; edit.onclick = () => configure(pad);
    edit.setAttribute('aria-label', pad.name + 'のパラメータを編集');
    const remove = document.createElement('button'); remove.textContent = '解除';
    remove.setAttribute('aria-label', pad.name + 'のパッドを解除');
    remove.onclick = () => { pads = pads.filter(p => p !== pad); save(); rebuild(); };
    heading.append(title, edit, remove);
    const axes = document.createElement('div'); axes.className = 'pad-axes';
    axes.append(axisSelect(pad, 0), axisSelect(pad, 1));
    const surface = document.createElement('div'); surface.className = 'parameter-pad';
    surface.tabIndex = 0; surface.setAttribute('role', 'group');
    surface.setAttribute('aria-label', pad.name + ' XYパッド');
    surface.setAttribute('aria-describedby', 'pad-keyboard-help');
    const marker = document.createElement('span'); marker.className = 'pad-marker'; marker.setAttribute('aria-hidden', 'true');
    const horizontal = document.createElement('span'); horizontal.className = 'pad-default-x';
    const vertical = document.createElement('span'); vertical.className = 'pad-default-y';
    const x = definition(pad.axes[0]);
    horizontal.style.left = ratio(x, x.default) * 100 + '%';
    const y = definition(pad.axes[1]);
    vertical.style.top = verticalPadFraction(y, ratio(y, y.default), pitchUp) * 100 + '%';
    surface.append(horizontal, vertical, marker);
    const mouthActions = mouth && isMouthPad(pad.axes) ? addMouthLabels(surface, [x, y]) : undefined;
    let pointer: number | undefined;
    function move(event: PointerEvent) {
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      change(padPatch([definition(pad.axes[0]), definition(pad.axes[1])],
        (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height, pitchUp));
    }
    surface.onpointerdown = event => {
      if (event.button !== 0 || pointer !== undefined) return;
      event.preventDefault(); surface.focus(); pointer = event.pointerId;
      surface.setPointerCapture(pointer); move(event);
    };
    surface.onpointermove = event => { if (event.pointerId === pointer) move(event); };
    surface.onpointerup = event => {
      if (event.pointerId !== pointer) return;
      move(event); surface.releasePointerCapture(event.pointerId); pointer = undefined;
    };
    surface.onpointercancel = event => {
      if (event.pointerId === pointer) { surface.releasePointerCapture(event.pointerId); pointer = undefined; }
    };
    surface.onlostpointercapture = () => { pointer = undefined; };
    surface.onkeydown = event => {
      if (event.target !== surface) return;
      const x = definition(pad.axes[0]), y = definition(pad.axes[1]);
      const current = host.values();
      if (event.key === 'Home') {
        event.preventDefault(); change({ [x.id]: x.default, [y.id]: y.default }); return;
      }
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      if (!horizontal && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const p = horizontal ? x : y;
      const screenDirection = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      const direction = horizontal ? screenDirection : screenDirection * verticalPadDirection(p, pitchUp);
      const delta = (p.step ?? 0.1) * direction * (event.shiftKey ? 10 : 1);
      change({ [p.id]: padValue(p, ((current[p.id] ?? p.default) + delta - p.min) / (p.max - p.min)) });
    };
    padViews.push({ pad, marker, surface });
    const reset = document.createElement('button'); reset.textContent = 'この組を初期値';
    reset.onclick = () => change(Object.fromEntries(pad.parameters.map(id => [id, definition(id).default])));
    card.append(heading, axes, surface);
    if (mouthActions) card.append(mouthActions);
    for (const id of pad.parameters) card.append(slider(definition(id)));
    card.append(reset);
    return card;
  }
  function rebuild() {
    sliders.length = 0; padViews.length = 0; list.replaceChildren();
    const grouped = new Set(pads.flatMap(p => p.parameters));
    for (const pad of pads) list.append(padCard(pad));
    for (const p of definitions) if (!grouped.has(p.id)) list.append(slider(p));
    const help = document.createElement('p'); help.id = 'pad-keyboard-help'; help.className = 'pad-help';
    help.textContent = 'パッドはドラッグ・矢印キーで操作。Shiftで10刻み、Homeで表示中の2軸を初期値に戻します。';
    if (pads.length) list.append(help);
    add.disabled = definitions.filter(p => !grouped.has(p.id) && p.max > p.min).length < 2;
    addMouth.hidden = !mouth || !mouth.axes.every(id => !grouped.has(id) && definitions.some(p => p.id === id && p.max > p.min));
    update();
  }
  function configure(editing?: ParameterPad) {
    dialog.replaceChildren();
    const form = document.createElement('form');
    const title = document.createElement('h2'); title.textContent = 'パラメータをまとめる';
    const nameLabel = document.createElement('label'); nameLabel.textContent = 'パッド名';
    const name = document.createElement('input'); name.maxLength = 120; name.value = editing?.name ?? '';
    nameLabel.append(name);
    const instruction = document.createElement('p');
    instruction.textContent = '2つ以上選択してください。3つ以上では表示するX・Y軸を切り替え、残りの軸もスライダーで調整できます。';
    const choices = document.createElement('div'); choices.className = 'pad-choices';
    const used = new Set(pads.filter(p => p !== editing).flatMap(p => p.parameters));
    const checks: HTMLInputElement[] = [];
    for (const p of definitions.filter(p => !used.has(p.id) && p.max > p.min)) {
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.value = p.id;
      check.checked = editing?.parameters.includes(p.id) ?? false;
      label.append(check, document.createTextNode(p.label)); choices.append(label); checks.push(check);
    }
    const buttons = document.createElement('div'); buttons.className = 'pad-dialog-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'キャンセル'; cancel.onclick = () => dialog.close();
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'まとめる';
    const validate = () => { submit.disabled = checks.filter(check => check.checked).length < 2; };
    checks.forEach(check => { check.onchange = validate; }); validate();
    form.onsubmit = event => {
      event.preventDefault();
      const parameters = checks.filter(check => check.checked).map(check => check.value);
      if (parameters.length < 2) return;
      const group = restorePads([{ name: name.value.trim() || parameters.map(id => definition(id).label).join(' / '),
        parameters, axes: editing?.axes ?? parameters.slice(0, 2) }], definitions)[0];
      if (editing) pads[pads.indexOf(editing)] = group; else pads.push(group);
      save(); dialog.close(); rebuild();
    };
    buttons.append(cancel, submit); form.append(title, nameLabel, instruction, choices, buttons);
    dialog.append(form); dialog.showModal(); name.focus();
  }
  function update() {
    const values = host.values();
    for (const { parameter, input, output } of sliders) {
      const value = values[parameter.id] ?? parameter.default;
      const formatted = String(Number(value.toFixed(3)));
      if (document.activeElement !== input && Number(input.value) !== value) input.value = String(value);
      if (output.textContent !== formatted) output.textContent = formatted;
    }
    for (const { pad, marker, surface } of padViews) {
      const x = definition(pad.axes[0]), y = definition(pad.axes[1]);
      marker.style.left = ratio(x, values[x.id] ?? x.default) * 100 + '%';
      marker.style.top = verticalPadFraction(y, ratio(y, values[y.id] ?? y.default), pitchUp) * 100 + '%';
      surface.setAttribute('aria-label', pad.name + ' XYパッド、' + x.label + ' ' + (values[x.id] ?? x.default) + '、' + y.label + ' ' + (values[y.id] ?? y.default));
    }
  }
  add.onclick = () => configure();
  addMouth.onclick = () => {
    if (!mouth || addMouth.hidden) return;
    pads.push({ name: '口', parameters: [...mouth.axes], axes: [...mouth.axes] });
    save(); rebuild();
  };
  return {
    load(next: ParameterDefinition[], modelKey: string, modelPitchUp: 1 | -1, modelMouth?: typeof mouth) {
      if (dialog.open) dialog.close();
      definitions = next;
      pitchUp = modelPitchUp;
      mouth = modelMouth;
      storageKey = 'standrig.parameter-pads.v1:' + modelKey;
      const defaults = [{ name: '顔の角度', parameters: ['ParamAngleX','ParamAngleY','ParamAngleZ'], axes: ['ParamAngleX','ParamAngleY'] }];
      if (mouth) defaults.push({ name: '口', parameters: mouth.axes, axes: mouth.axes });
      try { pads = restorePads(JSON.parse(localStorage.getItem(storageKey) ?? JSON.stringify(defaults)), next); }
      catch { pads = restorePads(defaults, next); }
      rebuild();
    },
    update
  };
}

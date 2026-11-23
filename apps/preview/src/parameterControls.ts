import type { ParameterDefinition, ParameterValues } from '@standrig/core/types';
import { CUBISM_VERTICAL_PARAMETERS } from '@standrig/core/parameters';

export interface ParameterPad {
  name: string;
  parameters: string[];
  axes: [string, string];
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
}) {
  let definitions: ParameterDefinition[] = [];
  let pads: ParameterPad[] = [];
  let pitchUp: 1 | -1 = -1;
  let storageKey = '';
  const sliders: Array<{ parameter: ParameterDefinition; input: HTMLInputElement; output: HTMLOutputElement }> = [];
  const padViews: Array<{ pad: ParameterPad; marker: HTMLElement; surface: HTMLElement }> = [];
  const message = document.createElement('p');
  message.className = 'pad-message';
  message.setAttribute('role', 'status');
  const add = document.createElement('button');
  add.type = 'button'; add.textContent = 'XYパッドを追加';
  const list = document.createElement('div');
  const dialog = document.createElement('dialog');
  dialog.className = 'parameter-pad-dialog';
  dialog.setAttribute('aria-label', 'パラメータをまとめる');
  container.append(add, message, list, dialog);

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
    horizontal.style.left = ratio(definition(pad.axes[0]), definition(pad.axes[0]).default) * 100 + '%';
    const y = definition(pad.axes[1]);
    vertical.style.top = verticalPadFraction(y, ratio(y, y.default), pitchUp) * 100 + '%';
    surface.append(horizontal, vertical, marker);
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
  return {
    load(next: ParameterDefinition[], modelKey: string, modelPitchUp: 1 | -1) {
      if (dialog.open) dialog.close();
      definitions = next;
      pitchUp = modelPitchUp;
      storageKey = 'standrig.parameter-pads.v1:' + modelKey;
      const defaults = [{ name: '顔の角度', parameters: ['ParamAngleX','ParamAngleY','ParamAngleZ'], axes: ['ParamAngleX','ParamAngleY'] }];
      try { pads = restorePads(JSON.parse(localStorage.getItem(storageKey) ?? JSON.stringify(defaults)), next); }
      catch { pads = restorePads(defaults, next); }
      rebuild();
    },
    update
  };
}

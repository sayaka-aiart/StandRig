import { VISEME_IDS, type FacialPresets, type MotionSyncProfiles, type MotionSyncSetting,
  type MotionSyncProfile, type VisemeBank, type VisemeId } from './facialTypes.js';
import { parameterDefinitionsForRig } from './parameters.js';
import type { RigDocument } from './types.js';

const MAX_PROFILES = 32;
const MAX_CHANNELS = 64;

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw Error(`Invalid MotionSync ${label}`);
  return value as Record<string, unknown>;
}

function rows(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max)
    throw Error(`MotionSync ${label} requires 1–${max} entries`);
  return value;
}

function labelText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160)
    throw Error(`Invalid MotionSync ${label}`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(`Invalid MotionSync ${label}`);
  return value;
}

function unique<K, V>(map: Map<K, V>, key: K, value: V, label: string) {
  if (map.has(key)) throw Error(`Duplicate MotionSync ${label}: ${key}`);
  map.set(key, value);
}

function visemeId(value: unknown): VisemeId {
  if (!VISEME_IDS.includes(value as VisemeId)) throw Error(`Unsupported MotionSync audio ID: ${value}`);
  return value as VisemeId;
}

function parseSetting(value: unknown): MotionSyncSetting {
  const setting = record(value, ['Id', 'AnalysisType', 'UseCase', 'CubismParameters',
    'AudioParameters', 'Mappings', 'PostProcessing'], 'setting');
  labelText(setting.Id, 'setting ID');
  if (setting.AnalysisType !== 'CRI' || setting.UseCase !== 'Mouth')
    throw Error('MotionSync currently supports CRI mouth settings');

  const channels = new Map<string, { min: number; max: number }>();
  for (const row of rows(setting.CubismParameters, MAX_CHANNELS, 'Cubism parameters')) {
    const p = record(row, ['Id', 'Name', 'Min', 'Max', 'Damper', 'Smooth'], 'Cubism parameter');
    const id = labelText(p.Id, 'parameter ID');
    labelText(p.Name, 'parameter name');
    const min = finite(p.Min, 'Min'), max = finite(p.Max, 'Max');
    if (min > max) throw Error(`Invalid MotionSync range: ${id}`);
    finite(p.Damper, 'Damper');
    finite(p.Smooth, 'Smooth');
    unique(channels, id, { min, max }, 'parameter');
  }
  const audio = new Map<VisemeId, boolean>();
  for (const row of rows(setting.AudioParameters, VISEME_IDS.length, 'audio parameters')) {
    const p = record(row, ['Id', 'Name', 'Min', 'Max', 'Scale', 'Enabled'], 'audio parameter');
    const id = visemeId(p.Id);
    labelText(p.Name, 'audio name');
    if (finite(p.Min, 'Min') > finite(p.Max, 'Max') || typeof p.Enabled !== 'boolean')
      throw Error(`Invalid MotionSync audio settings: ${id}`);
    finite(p.Scale, 'Scale');
    unique(audio, id, p.Enabled, 'audio ID');
  }
  const shapes = new Map<VisemeId, Set<string>>();
  for (const row of rows(setting.Mappings, VISEME_IDS.length, 'mappings')) {
    const mapping = record(row, ['Id', 'Type', 'Targets'], 'mapping');
    const id = visemeId(mapping.Id);
    if (mapping.Type !== 'Shape' || !audio.has(id) || !Array.isArray(mapping.Targets) ||
        mapping.Targets.length > MAX_CHANNELS) throw Error(`Invalid MotionSync Shape: ${id}`);
    const ids = new Set<string>();
    for (const row of mapping.Targets) {
      const target = record(row, ['Id', 'Value'], 'target');
      const id = labelText(target.Id, 'target ID'), range = channels.get(id);
      const v = finite(target.Value, 'target value');
      if (!range || v < range.min || v > range.max || ids.has(id))
        throw Error(`Invalid MotionSync target or value outside file range: ${id}`);
      ids.add(id);
    }
    unique(shapes, id, ids, 'Shape');
  }
  let common: Set<string> | undefined;
  for (const [id, enabled] of audio) {
    if (!enabled) continue;
    const ids = shapes.get(id);
    if (!ids?.size) throw Error(`Missing MotionSync Shape targets: ${id}`);
    if (common && (common.size !== ids.size || [...ids].some(id => !common!.has(id))))
      throw Error('Enabled MotionSync shapes must use the same parameter IDs');
    common = ids;
  }
  if (!common) throw Error('MotionSync requires at least one enabled shape');
  const post = record(setting.PostProcessing, ['BlendRatio', 'Smoothing', 'SampleRate'], 'PostProcessing');
  finite(post.BlendRatio, 'BlendRatio');
  finite(post.Smoothing, 'Smoothing');
  finite(post.SampleRate, 'SampleRate');
  return setting as unknown as MotionSyncSetting;
}

function modelParameters(setting: MotionSyncSetting, rig: RigDocument) {
  const definitions = new Map(parameterDefinitionsForRig(rig).map(p => [p.id, p]));
  const parameters = new Map<string, { id: string; min: number; max: number }>();
  const usedIds = new Set<string>();
  for (const { Id } of setting.CubismParameters) {
    const alias = Id === 'ParamMouthOpenY' ? 'ParamMouthOpen' :
      Id === 'ParamMouthOpen' ? 'ParamMouthOpenY' : Id;
    const parameter = definitions.get(Id) ?? definitions.get(alias);
    if (!parameter) throw Error(`Unknown MotionSync model parameter: ${Id}`);
    if (usedIds.has(parameter.id)) throw Error(`Duplicate MotionSync model parameter: ${parameter.id}`);
    usedIds.add(parameter.id);
    parameters.set(Id, parameter);
  }
  return parameters;
}

function visemeBank(setting: MotionSyncSetting, rig: RigDocument): VisemeBank {
  const parameters = modelParameters(setting, rig);
  const enabled = new Set(setting.AudioParameters.filter(p => p.Enabled).map(p => p.Id));
  return {
    mode: 'pose',
    presets: setting.Mappings.filter(m => enabled.has(m.Id)).map(mapping => ({
      id: mapping.Id,
      values: Object.fromEntries(mapping.Targets.map(target => {
        const p = parameters.get(target.Id)!;
        if (target.Value < p.min || target.Value > p.max)
          throw Error(`MotionSync target outside model range: ${p.id} (${target.Value})`);
        return [p.id, target.Value];
      }))
    }))
  };
}

export function validateMotionSyncProfiles(value: unknown, rig: RigDocument): void {
  const data = record(value, ['profiles', 'selectedId'], 'profiles');
  const ids = new Set<string>();
  for (const row of rows(data.profiles, MAX_PROFILES, 'profiles')) {
    const profile = record(row, ['id', 'name', 'setting'], 'profile');
    const id = labelText(profile.id, 'profile ID');
    if (ids.has(id)) throw Error(`Duplicate MotionSync profile: ${id}`);
    ids.add(id);
    labelText(profile.name, 'profile name');
    visemeBank(parseSetting(profile.setting), rig);
  }
  if (data.selectedId !== undefined && !ids.has(labelText(data.selectedId, 'selected profile ID')))
    throw Error('Unknown selected MotionSync profile');
}

export function selectedMotionSyncProfile(data?: MotionSyncProfiles): MotionSyncProfile | undefined {
  return data?.profiles.find(profile => profile.id === data.selectedId);
}

/** The saved manual bank remains available even when a MotionSync profile is selected. */
export function activeVisemeBank(presets: FacialPresets | undefined, rig: RigDocument): VisemeBank | undefined {
  const profile = selectedMotionSyncProfile(presets?.motionSync);
  return profile ? visemeBank(profile.setting, rig) : presets?.visemes;
}

/** Append the settings atomically and select the first added profile. */
export function importMotionSync(value: unknown, rig: RigDocument, newId: () => string): MotionSyncProfiles {
  const document = record(value, ['Version', 'Meta', 'Settings'], 'document');
  if (document.Version !== 1) throw Error('MotionSync requires Version 1');
  const meta = record(document.Meta, ['SettingCount', 'Dictionary'], 'Meta');
  const settings = rows(document.Settings, MAX_PROFILES, 'settings');
  const dictionary = rows(meta.Dictionary, MAX_PROFILES, 'dictionary');
  if (meta.SettingCount !== settings.length || dictionary.length !== settings.length)
    throw Error('MotionSync SettingCount does not match Settings and Dictionary');
  const names = new Map<string, string>();
  for (const row of dictionary) {
    const item = record(row, ['Id', 'Name'], 'dictionary entry');
    unique(names, labelText(item.Id, 'setting ID'), labelText(item.Name, 'setting name'), 'setting name entry');
  }
  const added = settings.map(value => {
    const setting = parseSetting(value);
    const name = names.get(setting.Id);
    if (name === undefined) throw Error(`Missing or duplicate MotionSync setting: ${setting.Id}`);
    names.delete(setting.Id);
    return { id: newId(), name, setting };
  });
  const next = { profiles: [...(rig.facialPresets?.motionSync?.profiles ?? []), ...added], selectedId: added[0].id };
  validateMotionSyncProfiles(next, rig);
  return next;
}

export function exportMotionSync(rig: RigDocument) {
  const presets = rig.facialPresets;
  const profile = selectedMotionSyncProfile(presets?.motionSync);
  let setting: MotionSyncSetting;
  if (profile) {
    setting = profile.setting;
  } else {
    const bank = presets?.visemes;
    if (!bank?.presets.length) throw Error('No mouth shapes to export');
    const definitions = new Map(parameterDefinitionsForRig(rig).map(p => [p.id, p]));
    const ids = Object.keys(bank.presets[0].values);
    // Use Cubism's standard ID unless the bank already addresses both channels explicitly.
    const exportId = (id: string) => id === 'ParamMouthOpen' && !definitions.has('ParamMouthOpenY') ? 'ParamMouthOpenY' : id;
    setting = {
      Id: 'MotionSyncSetting',
      AnalysisType: 'CRI',
      UseCase: 'Mouth',
      CubismParameters: ids.map(id => {
        const p = definitions.get(id)!;
        return { Id: exportId(id), Name: p.label || id, Min: p.min, Max: p.max, Damper: 0, Smooth: 25 };
      }),
      AudioParameters: (['Silence', 'A', 'I', 'U', 'E', 'O'] as const).map(id => ({
        Id: id, Name: id, Min: 0, Max: 1, Scale: 1, Enabled: bank.presets.some(p => p.id === id)
      })),
      Mappings: bank.presets.map(p => ({
        Id: p.id, Type: 'Shape',
        Targets: Object.entries(p.values).map(([id, value]) => ({ Id: exportId(id), Value: value }))
      })),
      PostProcessing: { BlendRatio: 0.5, Smoothing: 60, SampleRate: 60 }
    };
  }
  parseSetting(setting);
  return {
    Version: 1,
    Meta: { SettingCount: 1, Dictionary: [{ Id: setting.Id, Name: profile?.name ?? 'StandRig' }] },
    Settings: [setting]
  };
}

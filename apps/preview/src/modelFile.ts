import type { RigDocument } from '@standrig/core/types';

/** Decode the file envelope only; the import transaction validates the model and assets. */
export function parseModelFile(text: string): RigDocument {
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('JSONを解析できません。モデルJSONを選択してください。'); }
  if (value?.format !== undefined) {
    if (value.format !== 'standrig-bundle' || value.version !== 1) throw new Error('未対応のモデルbundle形式です。');
    value = value.rig;
  }
  if (!value || typeof value.schemaVersion !== 'string' || !Array.isArray(value.parts) || !Array.isArray(value.assets)) {
    throw new Error('StandRigモデルJSONではありません。rig.json または画像込みモデルJSONを選択してください。');
  }
  return value as RigDocument;
}

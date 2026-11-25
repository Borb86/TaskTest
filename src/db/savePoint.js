/**
 * Save Point Export / Import covering all 7 IndexedDB object stores.
 * Filename format: rpg-task-save-YYYY-MM-DD.json
 */

import { STORE_NAMES } from './database.js';
import { STAT_CODES } from '../core/rpgMath.js';
import { formatLocalDate } from '../core/turnLogic.js';

export const SAVE_POINT_SCHEMA_VERSION = 1;
export const SAVE_POINT_APP_ID = 'borb-rpg-tracker';

export function buildSavePointFilename(date = new Date()) {
  return `rpg-task-save-${formatLocalDate(date)}.json`;
}

/**
 * Dump all 7 IndexedDB object stores into a clean JSON Save Point object.
 */
export async function exportSavePointData(db, now = new Date()) {
  const stores = {};
  for (const name of STORE_NAMES) {
    stores[name] = await db.getAll(name);
  }

  // Record backup timestamp on character_profile
  const mainProfile = stores.character_profile.find((p) => p.id === 'main');
  if (mainProfile) {
    const updatedProfile = { ...mainProfile, last_backup_at: now.toISOString() };
    await db.put('character_profile', updatedProfile);
    stores.character_profile = stores.character_profile.map((p) =>
      p.id === 'main' ? updatedProfile : p
    );
  }

  return {
    app: SAVE_POINT_APP_ID,
    schema_version: SAVE_POINT_SCHEMA_VERSION,
    exported_at: now.toISOString(),
    stores
  };
}

/**
 * Validate a parsed Save Point payload before restoring.
 */
export function validateSavePointData(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Save Point file is not a valid JSON object.' };
  }
  if (!payload.stores || typeof payload.stores !== 'object') {
    return { valid: false, error: 'Missing "stores" map in Save Point file.' };
  }

  for (const storeName of STORE_NAMES) {
    if (!Array.isArray(payload.stores[storeName])) {
      return { valid: false, error: `Missing or invalid "${storeName}" array in Save Point.` };
    }
  }

  const profiles = payload.stores.character_profile;
  if (profiles.length === 0 || !profiles.some((p) => p && typeof p.id === 'string')) {
    return { valid: false, error: 'Save Point must contain a valid character_profile record.' };
  }

  const statCodes = new Set(payload.stores.stat_progress.map((s) => s?.stat_code));
  for (const code of STAT_CODES) {
    if (!statCodes.has(code)) {
      return { valid: false, error: `Save Point stat_progress is missing required stat "${code}".` };
    }
  }

  return { valid: true, error: null };
}

/**
 * Atomically restore all 7 IndexedDB stores in a single readwrite transaction.
 */
export async function importSavePointData(db, payload) {
  const validation = validateSavePointData(payload);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  await db._tx(STORE_NAMES, 'readwrite', (tx) => {
    for (const storeName of STORE_NAMES) {
      const store = tx.objectStore(storeName);
      store.clear();
      for (const record of payload.stores[storeName]) {
        store.put(record);
      }
    }
  });

  return db.loadSnapshot();
}

/**
 * Trigger browser file download for rpg-task-save-YYYY-MM-DD.json.
 */
export async function downloadSavePointFile(db, now = new Date()) {
  const data = await exportSavePointData(db, now);
  const json = JSON.stringify(data, null, 2);
  const filename = buildSavePointFilename(now);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { filename, data };
}

/**
 * Local-First IndexedDB Storage Layer
 * Implements all 7 required object stores:
 *  1. character_profile
 *  2. stat_progress
 *  3. tasks
 *  4. routines
 *  5. interactions_journal
 *  6. daily_turns
 *  7. weekly_reports
 */

import { STAT_CODES, MONDAY_RESET_HP, TIER_XP } from '../core/rpgMath.js';
import { formatLocalDate } from '../core/turnLogic.js';

export const DEFAULT_DB_NAME = 'borb_rpg_tracker_db';
export const DB_VERSION = 1;

export const STORE_NAMES = Object.freeze([
  'character_profile',
  'stat_progress',
  'tasks',
  'routines',
  'interactions_journal',
  'daily_turns',
  'weekly_reports'
]);

export function createId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export class RpgDatabase {
  constructor(dbName = DEFAULT_DB_NAME) {
    this.dbName = dbName;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('character_profile')) {
          db.createObjectStore('character_profile', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('stat_progress')) {
          db.createObjectStore('stat_progress', { keyPath: 'stat_code' });
        }
        if (!db.objectStoreNames.contains('tasks')) {
          const taskStore = db.createObjectStore('tasks', { keyPath: 'id' });
          taskStore.createIndex('status', 'status', { unique: false });
          taskStore.createIndex('assigned_turn_date', 'assigned_turn_date', { unique: false });
        }
        if (!db.objectStoreNames.contains('routines')) {
          db.createObjectStore('routines', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('interactions_journal')) {
          const ijStore = db.createObjectStore('interactions_journal', { keyPath: 'id' });
          ijStore.createIndex('assigned_turn_date', 'assigned_turn_date', { unique: false });
        }
        if (!db.objectStoreNames.contains('daily_turns')) {
          db.createObjectStore('daily_turns', { keyPath: 'turn_date' });
        }
        if (!db.objectStoreNames.contains('weekly_reports')) {
          db.createObjectStore('weekly_reports', { keyPath: 'week_start_date' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    await this.ensureInitialized();
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async deleteDatabase() {
    this.close();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  async _tx(storeNames, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

      Promise.resolve(fn(tx))
        .then((val) => {
          result = val;
        })
        .catch((err) => {
          try {
            tx.abort();
          } catch (_) {}
          reject(err);
        });
    });
  }

  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(storeName) {
    return this._tx([storeName], 'readonly', (tx) => this._req(tx.objectStore(storeName).getAll()));
  }

  async get(storeName, key) {
    return this._tx([storeName], 'readonly', (tx) => this._req(tx.objectStore(storeName).get(key)));
  }

  async put(storeName, record) {
    return this._tx([storeName], 'readwrite', (tx) => this._req(tx.objectStore(storeName).put(record)));
  }

  async putMany(storeName, records) {
    return this._tx([storeName], 'readwrite', (tx) => {
      const store = tx.objectStore(storeName);
      for (const rec of records) {
        store.put(rec);
      }
    });
  }

  async delete(storeName, key) {
    return this._tx([storeName], 'readwrite', (tx) => this._req(tx.objectStore(storeName).delete(key)));
  }

  /**
   * Ensure default character_profile, all 6 stat_progress rows, and a starter routine exist.
   */
  async ensureInitialized(now = new Date()) {
    const todayStr = formatLocalDate(now);
    const existingProfile = await this.get('character_profile', 'main');
    if (!existingProfile) {
      await this.put('character_profile', {
        id: 'main',
        character_name: 'Adventurer',
        overall_xp: 0,
        overall_level: 1,
        current_social_hp: MONDAY_RESET_HP,
        current_turn_date: todayStr,
        turn_started: false,
        active_status_effects: [],
        vacation_mode: false,
        gemini_api_key: '',
        gemini_model: 'gemini-2.5-flash',
        last_backup_at: null,
        week_starting_hp: MONDAY_RESET_HP,
        pending_weekly_report_week: null,
        created_at: now.toISOString()
      });
    }

    const existingStats = await this.getAll('stat_progress');
    const existingCodes = new Set(existingStats.map((s) => s.stat_code));
    const missingStats = STAT_CODES.filter((c) => !existingCodes.has(c)).map((code) => ({
      stat_code: code,
      total_xp: 0,
      current_level: 1
    }));
    if (missingStats.length > 0) {
      await this.putMany('stat_progress', missingStats);
    }

    const existingRoutines = await this.getAll('routines');
    if (existingRoutines.length === 0 && !existingProfile) {
      await this.put('routines', {
        id: createId('rtn'),
        title: 'Take daily pills',
        target_stat: 'DSC',
        base_xp: TIER_XP.Routine,
        streak_count: 0,
        best_streak: 0,
        last_completed_turn_date: null,
        paused: false,
        created_at: now.toISOString()
      });
    }
  }

  /**
   * Load full application state snapshot in a single readonly transaction.
   */
  async loadSnapshot() {
    return this._tx(STORE_NAMES, 'readonly', async (tx) => {
      const [
        profiles,
        stats,
        tasks,
        routines,
        interactions,
        dailyTurns,
        weeklyReports
      ] = await Promise.all(STORE_NAMES.map((name) => this._req(tx.objectStore(name).getAll())));

      return {
        profile: profiles.find((p) => p.id === 'main') || profiles[0],
        stats,
        tasks,
        routines,
        interactions,
        dailyTurns,
        weeklyReports
      };
    });
  }
}

/**
 * Comprehensive Unit Test Suite for Borb — Tactical RPG Tracker PWA
 * Covers:
 *  1. Leveling curves (Individual Stat & Overall Character + Strictly Additive guarantee)
 *  2. 70/30 stat splits & fixed difficulty tiers + routine streak milestones
 *  3. Social / Weekly HP clamping, modifiers, warning state & Monday reset
 *  4. Turn rollover logic, Missed End Day Recovery, Weekly Report triggers & rolling benchmarks
 *  5. Save Point JSON Export / Import round-trip across ALL 7 real IndexedDB object stores
 */

import {
  STAT_CODES,
  TIER_XP,
  MONDAY_RESET_HP,
  roundToNearest10,
  statXpForNextLevel,
  overallXpForNextLevel,
  computeStatLevelProgress,
  computeOverallLevelProgress,
  getXpForTier,
  splitStatXp,
  applyAdditiveStatXp,
  clampSocialHp,
  applySocialHpDelta,
  isLowHpWarning,
  getSleepHpDelta,
  getInteractionHpDelta,
  normalizeJournalHpDelta,
  calculateRoutineCompletion
} from '../src/core/rpgMath.js';

import {
  getWeekBounds,
  computeTurnRolloverDate,
  shouldTriggerMondayHpReset,
  isSundayTurn,
  evaluateTurnLifecycle,
  computeWeeklyReportData,
  needsBackupReminder,
  formatClockTime
} from '../src/core/turnLogic.js';

import { RpgDatabase, STORE_NAMES } from '../src/db/database.js';
import {
  buildSavePointFilename,
  exportSavePointData,
  validateSavePointData,
  importSavePointData
} from '../src/db/savePoint.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message} — expected ${b}, got ${a}`);
  }
}

const tests = [];
function test(suite, name, fn) {
  tests.push({ suite, name, fn });
}

/* ==================== 1. LEVELING CURVES ==================== */

test('Leveling Curves', 'Individual Stat XP curve matches Living Design Document benchmarks', () => {
  assertEqual(statXpForNextLevel(1), 100, 'Level 1 -> 2');
  assertEqual(statXpForNextLevel(2), 250, 'Level 2 -> 3');
  assertEqual(statXpForNextLevel(3), 440, 'Level 3 -> 4');
  assertEqual(statXpForNextLevel(4), 650, 'Level 4 -> 5');
  assertEqual(statXpForNextLevel(5), 880, 'Level 5 -> 6');
});

test('Leveling Curves', 'Overall Character XP curve matches 300 * (level ^ 1.35) rounded to nearest 10', () => {
  assertEqual(overallXpForNextLevel(1), 300, 'Overall L1 -> 2');
  assertEqual(overallXpForNextLevel(2), roundToNearest10(300 * Math.pow(2, 1.35)), 'Overall L2 -> 3');
  assertEqual(overallXpForNextLevel(2), 760, 'Overall L2 -> 3 exact 760');
  assertEqual(overallXpForNextLevel(3), 1320, 'Overall L3 -> 4 exact 1320');
});

test('Leveling Curves', 'Multi-level cumulative XP progression computes exact level & remainder', () => {
  const p0 = computeStatLevelProgress(0);
  assertEqual(p0.level, 1, '0 XP is Level 1');
  assertEqual(p0.xpNeededForNext, 100, 'Needs 100 XP');

  const p1 = computeStatLevelProgress(100);
  assertEqual(p1.level, 2, '100 XP reaches Level 2');
  assertEqual(p1.currentLevelXp, 0, '0 remainder at exact threshold');
  assertEqual(p1.xpNeededForNext, 250, 'L2->3 needs 250');

  const p2 = computeStatLevelProgress(350); // 100 + 250
  assertEqual(p2.level, 3, '350 XP reaches Level 3');
  assertEqual(p2.currentLevelXp, 0, '0 remainder');
  assertEqual(p2.xpNeededForNext, 440, 'L3->4 needs 440');

  const ov = computeOverallLevelProgress(1060); // 300 + 760
  assertEqual(ov.level, 3, '1060 combined XP reaches Overall Level 3');
  assertEqual(ov.currentLevelXp, 0, '0 remainder');
});

test('Leveling Curves', 'Strictly additive stat XP never decreases even on negative delta input', () => {
  const initialStats = STAT_CODES.map((code) => ({ stat_code: code, total_xp: 50, current_level: 1 }));
  const res = applyAdditiveStatXp(initialStats, { INT: 75, CHA: -50, VIT: 100 });
  const intRow = res.updatedStats.find((s) => s.stat_code === 'INT');
  const chaRow = res.updatedStats.find((s) => s.stat_code === 'CHA');
  const vitRow = res.updatedStats.find((s) => s.stat_code === 'VIT');

  assertEqual(intRow.total_xp, 125, 'INT increased to 125');
  assertEqual(intRow.current_level, 2, 'INT leveled up to 2');
  assertEqual(chaRow.total_xp, 50, 'CHA did NOT decrease');
  assertEqual(vitRow.total_xp, 150, 'VIT increased to 150');
  assertEqual(res.overall_xp, 475, 'Combined total XP across 6 stats = 475');
  assertEqual(res.overall_level, 2, 'Overall leveled up at >= 300 XP');
});

/* ==================== 2. 70/30 STAT SPLITS & TIERS ==================== */

test('Stat Splits & Tiers', 'Fixed difficulty tiers match rubric exactly', () => {
  assertEqual(getXpForTier('Routine'), 10, 'Routine = 10 XP');
  assertEqual(getXpForTier('Cantrip'), 15, 'Cantrip = 15 XP');
  assertEqual(getXpForTier('Standard'), 35, 'Standard Quest = 35 XP');
  assertEqual(getXpForTier('Heavy'), 75, 'Heavy Quest = 75 XP');
  assertEqual(getXpForTier('Boss'), 150, 'Boss Fight = 150 XP');
});

test('Stat Splits & Tiers', '70/30 split conserves exact total XP across all tiers', () => {
  for (const tier of ['Routine', 'Cantrip', 'Standard', 'Heavy', 'Boss']) {
    const total = TIER_XP[tier];
    const split = splitStatXp(total, 'INT', 'DSC');
    assertEqual(split.INT + split.DSC, total, `${tier} (${total} XP) sum conserved`);
    assertEqual(split.INT, Math.round(total * 0.7), `${tier} primary is 70%`);
    assertEqual(split.DSC, total - split.INT, `${tier} secondary is 30% remainder`);
  }
  assertDeepEqual(splitStatXp(35, 'INT', 'STW'), { INT: 25, STW: 10 }, '35 XP -> 25/10');
  assertDeepEqual(splitStatXp(150, 'CRF', 'DSC'), { CRF: 105, DSC: 45 }, '150 XP -> 105/45');
});

test('Stat Splits & Tiers', '100% XP goes to Primary when secondary is null or matches primary', () => {
  assertDeepEqual(splitStatXp(75, 'VIT', null), { VIT: 75 }, 'Null secondary -> 100% Primary');
  assertDeepEqual(splitStatXp(75, 'VIT', 'VIT'), { VIT: 75 }, 'Duplicate secondary -> 100% Primary');
});

test('Stat Splits & Tiers', 'Routine 7-day streak awards +25 XP milestone & vacation days preserve streaks', () => {
  const routine = {
    id: 'r1',
    title: 'Take daily pills',
    target_stat: 'DSC',
    base_xp: 10,
    streak_count: 6,
    best_streak: 6,
    last_completed_turn_date: '2026-11-22'
  };
  // Nov 23 and Nov 24 were Vacation days
  const dailyTurns = [
    { turn_date: '2026-11-23', is_vacation: true },
    { turn_date: '2026-11-24', is_vacation: true }
  ];
  const calc = calculateRoutineCompletion(routine, '2026-11-25', dailyTurns, false);
  assertEqual(calc.newStreak, 7, 'Vacation days did not break streak');
  assertEqual(calc.milestoneBonus, 25, '7-day streak milestone awards +25 XP');
  assertEqual(calc.xpAwarded, 35, 'Total routine XP = 10 base + 25 bonus');
});

/* ==================== 3. SOCIAL HP CLAMPING & MONDAY RESET ==================== */

test('Social HP', 'Clamps strictly between 0 and 100 and triggers warning at <= 40 HP', () => {
  assertEqual(clampSocialHp(-15), 0, 'Floor at 0');
  assertEqual(clampSocialHp(142), 100, 'Cap at 100');
  assertEqual(applySocialHpDelta(95, 10), 100, '95 + 10 clamps to 100');
  assertEqual(applySocialHpDelta(3, -8), 0, '3 - 8 clamps to 0');
  assertEqual(isLowHpWarning(40), true, '40 HP triggers warning');
  assertEqual(isLowHpWarning(39), true, '39 HP triggers warning');
  assertEqual(isLowHpWarning(41), false, '41 HP does not trigger warning');
});

test('Social HP', 'Sleep, Interaction, Restorative, and Heavy Drain deltas match rules', () => {
  assertEqual(getSleepHpDelta('Good'), 5, 'Good sleep +5');
  assertEqual(getSleepHpDelta('Okay'), 0, 'Okay sleep 0');
  assertEqual(getSleepHpDelta('Poor'), -5, 'Poor sleep -5');
  assertEqual(getInteractionHpDelta('Good'), 10, 'Positive interaction +10');
  assertEqual(getInteractionHpDelta('Neutral'), 0, 'Neutral interaction 0');
  assertEqual(getInteractionHpDelta('Bad'), -5, 'Negative interaction -5');
  assertEqual(getInteractionHpDelta('Bad', true), -8, 'Heavy drain -8');
  assertEqual(normalizeJournalHpDelta(-8), -8, 'Journal heavy drain -8');
  assertEqual(normalizeJournalHpDelta(-4), -5, 'Journal drain normalizes to -5');
  assertEqual(normalizeJournalHpDelta(12), 10, 'Journal uplift normalizes to +10');
});

test('Social HP', 'Monday Start Day detects week boundary reset to 75/100', () => {
  // 2026-11-29 is Sunday, 2026-11-30 is Monday
  assertEqual(shouldTriggerMondayHpReset('2026-11-29', '2026-11-30'), true, 'Sun -> Mon triggers reset');
  assertEqual(shouldTriggerMondayHpReset('2026-11-25', '2026-11-26'), false, 'Wed -> Thu same week no reset');
  assertEqual(shouldTriggerMondayHpReset('2026-11-27', '2026-12-01'), true, 'Fri -> Tue next week triggers reset');
  assertEqual(MONDAY_RESET_HP, 75, 'Monday reset HP is 75');
});

/* ==================== 4. TURN ROLLOVER & WEEKLY BENCHMARKS ==================== */

test('Turn Rollover', 'Confirming End Day rolls logical turn date to next day regardless of clock time', () => {
  assertEqual(computeTurnRolloverDate('2026-11-25'), '2026-11-26', 'Rolls to next calendar date');
  assertEqual(computeTurnRolloverDate('2026-11-30'), '2026-12-01', 'Handles month rollover cleanly');
  assertEqual(isSundayTurn('2026-11-29'), true, 'Sunday detected for Weekly Report');
  assertEqual(isSundayTurn('2026-11-25'), false, 'Wednesday is not Sunday');

  const sampleClock = formatClockTime(new Date(2026, 10, 25, 21, 15));
  assert(sampleClock.includes('9:15') || sampleClock.includes('21:15'), `Formats clock time (${sampleClock})`);

  // When today (Nov 25) is closed early at 9:15 PM, current_turn_date becomes Nov 26 & turn_started=false
  const lifecycle = evaluateTurnLifecycle({
    profile: { current_turn_date: '2026-11-26', turn_started: false, pending_weekly_report_week: null },
    dailyTurns: [{ turn_date: '2026-11-25', ended_at: '2026-11-26T02:15:00.000Z' }],
    interactions: [],
    weeklyReports: [],
    now: new Date(2026, 10, 25, 21, 20)
  });
  assertEqual(lifecycle.phase, 'active_rollover', 'Remains active in rollover mode for tomorrow');
  assertEqual(lifecycle.turnDate, '2026-11-26', 'New entries stamp tomorrow logical turn date');
});

test('Turn Rollover', 'Missed End Day Recovery triggers on new calendar day when previous turn was unclosed', () => {
  const lifecycle = evaluateTurnLifecycle({
    profile: { current_turn_date: '2026-11-24', turn_started: true, pending_weekly_report_week: null },
    dailyTurns: [{ turn_date: '2026-11-24', ended_at: null }],
    interactions: [],
    weeklyReports: [],
    now: new Date(2026, 10, 25, 8, 30)
  });
  assertEqual(lifecycle.phase, 'missed_end_day', 'Detects missed End Day');
  assertEqual(lifecycle.missedTurnDate, '2026-11-24', 'Points to unclosed turn date');
});

test('Turn Rollover', 'Missed Sunday triggers Weekly Report on Monday BEFORE Monday 75 HP reset', () => {
  // Monday Nov 30, 2026; previous week Mon Nov 23..Sun Nov 29 had activity and no weekly report saved yet
  const lifecycle = evaluateTurnLifecycle({
    profile: { current_turn_date: '2026-11-30', turn_started: false, pending_weekly_report_week: null },
    dailyTurns: [{ turn_date: '2026-11-28', ended_at: '2026-11-29T03:00:00Z', is_vacation: false }],
    interactions: [],
    weeklyReports: [],
    now: new Date(2026, 10, 30, 8, 0)
  });
  assertEqual(lifecycle.phase, 'weekly_report_pending', 'Triggers Weekly Report before Start Day reset');
  assertEqual(lifecycle.weekStart, '2026-11-23', 'Previous week start Monday');
  assertEqual(lifecycle.weekEnd, '2026-11-29', 'Previous week end Sunday');
  assertEqual(lifecycle.beforeMondayReset, true, 'Flagged before Monday reset');
});

test('Turn Rollover', 'Weekly Report excludes vacation days & computes 4-week rolling and all-time averages', () => {
  const { weekStart, weekEnd } = getWeekBounds('2026-11-25'); // 2026-11-23 .. 2026-11-29
  const dailyTurns = [
    { turn_date: '2026-11-23', starting_hp: 75, ending_hp: 80, sleep_quality: 'Good', total_xp_earned: 100, is_vacation: false },
    { turn_date: '2026-11-24', starting_hp: 80, ending_hp: 80, sleep_quality: 'Poor', total_xp_earned: 0, is_vacation: true }, // Excluded!
    { turn_date: '2026-11-25', starting_hp: 80, ending_hp: 85, sleep_quality: 'Okay', total_xp_earned: 120, is_vacation: false }
  ];
  const interactions = [
    { assigned_turn_date: '2026-11-23', entry_type: 'Interaction', user_sentiment: 'Good', hp_delta: 10 },
    { assigned_turn_date: '2026-11-25', entry_type: 'Interaction', user_sentiment: 'Good', hp_delta: 10 },
    { assigned_turn_date: '2026-11-25', entry_type: 'Interaction', user_sentiment: 'Bad', hp_delta: -5 }
  ];
  const historicalReports = [
    { week_start_date: '2026-11-16', ending_hp: 80, net_tone_score: 2, interaction_volume: 4, active_days: 6 },
    { week_start_date: '2026-11-09', ending_hp: 70, net_tone_score: 0, interaction_volume: 6, active_days: 5 },
    { week_start_date: '2026-11-02', ending_hp: 60, net_tone_score: -2, interaction_volume: 2, active_days: 7 },
    { week_start_date: '2026-10-26', ending_hp: 90, net_tone_score: 4, interaction_volume: 8, active_days: 6 },
    { week_start_date: '2026-10-19', ending_hp: 50, net_tone_score: -4, interaction_volume: 10, active_days: 5 },
    { week_start_date: '2026-10-12', ending_hp: 75, net_tone_score: 0, interaction_volume: 0, active_days: 0 } // Full vacation week excluded
  ];

  const report = computeWeeklyReportData({
    weekStart,
    weekEnd,
    dailyTurns,
    interactions,
    tasks: [],
    historicalReports
  });

  assertEqual(report.starting_hp, 75, 'Starting HP');
  assertEqual(report.ending_hp, 85, 'Ending HP');
  assertEqual(report.net_hp_delta, 10, 'Net HP delta');
  assertEqual(report.net_tone_score, 1, 'Net tone score (+2 - 1 = +1)');
  assertEqual(report.interaction_volume, 3, 'Interaction volume = 3');
  assertEqual(report.active_days, 2, 'Vacation day excluded from active_days');
  assertEqual(report.vacation_days, 1, 'Vacation days tracked');
  assertDeepEqual(report.sleep_summary, { Good: 1, Okay: 1, Poor: 0 }, 'Vacation Poor sleep excluded');
  assertEqual(report.benchmarks.hasFourWeekBaseline, true, '4+ eligible prior weeks');
  assertEqual(report.benchmarks.rolling4Week.ending_hp, 75, '4w rolling ending HP = (80+70+60+90)/4 = 75');
  assertEqual(report.benchmarks.allTime.ending_hp, 70, 'All-time ending HP = (80+70+60+90+50)/5 = 70');
});

test('Turn Rollover', '7-day Save Point backup reminder triggers correctly', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  assertEqual(needsBackupReminder({ last_backup_at: '2026-11-20T12:00:00Z' }, now), false, '5 days ago -> no reminder');
  assertEqual(needsBackupReminder({ last_backup_at: '2026-11-18T11:00:00Z' }, now), true, '7+ days ago -> reminder');
  assertEqual(needsBackupReminder({ last_backup_at: null, created_at: '2026-11-17T00:00:00Z' }, now), true, 'Never backed up after 8 days -> reminder');
});

/* ==================== 5. SAVE POINT ROUND-TRIP (ALL 7 INDEXEDDB STORES) ==================== */

test('Save Point Round-Trip', 'Exports and imports all 7 IndexedDB object stores losslessly', async () => {
  const testDb = new RpgDatabase(`borb_unit_test_db_${Date.now()}`);
  try {
    await testDb.open();

    // Seed all 7 object stores with rich representative records
    await testDb.put('character_profile', {
      id: 'main',
      character_name: 'Commander Borb',
      overall_xp: 625,
      overall_level: 2,
      current_social_hp: 68,
      current_turn_date: '2026-11-25',
      turn_started: true,
      active_status_effects: ['Drained'],
      vacation_mode: false,
      gemini_api_key: 'test-key-local-only',
      gemini_model: 'gemini-2.5-flash',
      last_backup_at: null,
      week_starting_hp: 75,
      pending_weekly_report_week: null,
      created_at: '2026-11-01T08:00:00.000Z'
    });

    await testDb.putMany('stat_progress', [
      { stat_code: 'INT', total_xp: 200, current_level: 2 },
      { stat_code: 'VIT', total_xp: 125, current_level: 2 },
      { stat_code: 'CRF', total_xp: 75, current_level: 1 },
      { stat_code: 'STW', total_xp: 80, current_level: 1 },
      { stat_code: 'CHA', total_xp: 65, current_level: 1 },
      { stat_code: 'DSC', total_xp: 80, current_level: 1 }
    ]);

    await testDb.put('tasks', {
      id: 'tsk_roundtrip_1',
      raw_text: 'Refactor local IndexedDB save point exporter',
      quest_title: 'Forge Save Point Exporter',
      category: 'Work',
      primary_stat: 'INT',
      secondary_stat: 'DSC',
      difficulty_tier: 'Heavy',
      is_restorative: false,
      status: 'active',
      created_at: '2026-11-25T10:00:00.000Z',
      completed_at: null,
      assigned_turn_date: '2026-11-25',
      completed_turn_date: null,
      xp_awarded: 0
    });

    await testDb.put('routines', {
      id: 'rtn_roundtrip_1',
      title: 'Take daily pills',
      target_stat: 'DSC',
      base_xp: 10,
      streak_count: 14,
      best_streak: 14,
      last_completed_turn_date: '2026-11-25',
      paused: false,
      created_at: '2026-11-01T08:00:00.000Z'
    });

    await testDb.put('interactions_journal', {
      id: 'int_roundtrip_1',
      entry_type: 'Journal',
      raw_text: 'Tough architecture review, stayed calm and aligned the team.',
      user_sentiment: 'Bad',
      primary_stat: 'CHA',
      secondary_stat: 'INT',
      xp_tier: 'Standard',
      xp_awarded: 35,
      hp_delta: -5,
      status_effect: 'Drained',
      dm_note: 'Held steady under pressure; schedule recovery tonight.',
      created_at: '2026-11-25T15:00:00.000Z',
      assigned_turn_date: '2026-11-25'
    });

    await testDb.put('daily_turns', {
      turn_date: '2026-11-24',
      sleep_quality: 'Good',
      sleep_note: '8 hours solid',
      sleep_hp_delta: 5,
      starting_hp: 75,
      ending_hp: 80,
      total_xp_earned: 110,
      ended_at: '2026-11-25T03:00:00.000Z',
      gemini_daily_summary: 'Strong recovery and steady execution.',
      is_vacation: false
    });

    await testDb.put('weekly_reports', {
      week_start_date: '2026-11-16',
      week_end_date: '2026-11-22',
      starting_hp: 75,
      ending_hp: 82,
      net_hp_delta: 7,
      net_tone_score: 3,
      interaction_volume: 5,
      sleep_summary_json: JSON.stringify({ Good: 4, Okay: 2, Poor: 1 }),
      total_xp_earned: 540,
      active_days: 7,
      gemini_weekly_reflection: 'Consistent sleep anchored a positive week.',
      created_at: '2026-11-23T02:00:00.000Z'
    });

    // 1. Export Save Point JSON
    const exportTime = new Date(2026, 10, 25, 16, 30, 0);
    assertEqual(buildSavePointFilename(exportTime), 'rpg-task-save-2026-11-25.json', 'Filename format');

    const exported = await exportSavePointData(testDb, exportTime);
    const serialized = JSON.stringify(exported);
    const parsedBack = JSON.parse(serialized);

    const validation = validateSavePointData(parsedBack);
    assertEqual(validation.valid, true, 'Exported Save Point passes schema validation');
    assertEqual(Object.keys(parsedBack.stores).length, 7, 'All 7 stores present in Save Point');
    assert(Boolean(parsedBack.stores.character_profile[0].last_backup_at), 'Updates last_backup_at timestamp');

    // 2. Wipe/mutate database state to prove restore overwrites cleanly
    await testDb.put('character_profile', {
      id: 'main',
      character_name: 'CORRUPTED',
      overall_xp: 0,
      overall_level: 1,
      current_social_hp: 10,
      current_turn_date: '2020-01-01',
      turn_started: false,
      active_status_effects: []
    });
    await testDb.delete('tasks', 'tsk_roundtrip_1');
    await testDb.delete('weekly_reports', '2026-11-16');

    // 3. Import Save Point JSON and verify exact restoration across all 7 stores
    await importSavePointData(testDb, parsedBack);

    for (const storeName of STORE_NAMES) {
      const actualRows = await testDb.getAll(storeName);
      const expectedRows = parsedBack.stores[storeName];
      assertDeepEqual(actualRows, expectedRows, `Store "${storeName}" restored identically`);
    }

    // 4. Verify malformed Save Point fails validation
    const badCheck = validateSavePointData({ stores: { character_profile: [] } });
    assertEqual(badCheck.valid, false, 'Rejects malformed Save Point');
  } finally {
    await testDb.deleteDatabase();
  }
});

/* ==================== RUNNER ==================== */

export async function runAllTests() {
  const results = [];
  for (const t of tests) {
    const start = performance.now();
    try {
      await t.fn();
      results.push({
        suite: t.suite,
        name: t.name,
        passed: true,
        durationMs: +(performance.now() - start).toFixed(2)
      });
    } catch (err) {
      results.push({
        suite: t.suite,
        name: t.name,
        passed: false,
        error: err.message,
        durationMs: +(performance.now() - start).toFixed(2)
      });
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;
  return { total: results.length, passed: passedCount, failed: failedCount, results };
}

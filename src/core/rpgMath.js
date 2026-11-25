/**
 * Deterministic Core RPG Math Engine
 * All XP payouts, 70/30 stat splits, leveling curves, and Social HP math
 * are strictly deterministic in local application code.
 */

export const STAT_CODES = ['INT', 'VIT', 'CRF', 'STW', 'CHA', 'DSC'];

export const STAT_META = {
  INT: { code: 'INT', name: 'Intellect', focus: 'Work, Strategy & Learning' },
  VIT: { code: 'VIT', name: 'Vitality', focus: 'Health, Energy & Body' },
  CRF: { code: 'CRF', name: 'Craft', focus: 'Creative & Hands-On Building' },
  STW: { code: 'STW', name: 'Stewardship', focus: 'Home, Errands & Logistics' },
  CHA: { code: 'CHA', name: 'Charisma', focus: 'Relationships & Connection' },
  DSC: { code: 'DSC', name: 'Discipline', focus: 'Consistency, Routines & Grit' }
};

export const TASK_CATEGORIES = ['Work', 'Home', 'Health', 'Creative', 'Social', 'Admin'];

export const DIFFICULTY_TIERS = ['Cantrip', 'Standard', 'Heavy', 'Boss'];

export const TIER_XP = Object.freeze({
  None: 0,
  Routine: 10,
  Cantrip: 15,
  Standard: 35,
  Heavy: 75,
  Boss: 150
});

export const ROUTINE_STREAK_MILESTONE = 7;
export const ROUTINE_STREAK_BONUS_XP = 25;

export const SOCIAL_HP_MIN = 0;
export const SOCIAL_HP_MAX = 100;
export const MONDAY_RESET_HP = 75;
export const LOW_HP_WARNING_THRESHOLD = 40;
export const RESTORATIVE_TASK_HP_DELTA = 10;

export const SLEEP_HP_DELTA = Object.freeze({
  Good: 5,
  Okay: 0,
  Poor: -5
});

export const INTERACTION_HP_DELTA = Object.freeze({
  Good: 10,
  Neutral: 0,
  Bad: -5
});

export const HEAVY_DRAIN_HP_DELTA = -8;

/**
 * Round a positive number to the nearest 10 (standard half-up rounding).
 */
export function roundToNearest10(value) {
  return Math.round(value / 10) * 10;
}

/**
 * Individual Stat Leveling Curve:
 * XP_needed = round_to_nearest_10(100 * (current_level ^ 1.35))
 * L1->2 = 100, L2->3 = 250, L3->4 = 440, L5->6 = 880
 */
export function statXpForNextLevel(currentLevel) {
  const lvl = Math.max(1, Math.floor(currentLevel));
  return roundToNearest10(100 * Math.pow(lvl, 1.35));
}

/**
 * Overall Character Leveling Curve:
 * XP_needed = round_to_nearest_10(300 * (overall_level ^ 1.35))
 * Uses combined total XP across all 6 stats.
 */
export function overallXpForNextLevel(overallLevel) {
  const lvl = Math.max(1, Math.floor(overallLevel));
  return roundToNearest10(300 * Math.pow(lvl, 1.35));
}

/**
 * Compute current level, XP within current level, XP needed for next level,
 * and normalized progress ratio [0..1] from cumulative total XP.
 */
export function computeLevelProgress(totalXp, xpForLevelFn) {
  const safeXp = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  let remaining = safeXp;

  while (true) {
    const needed = xpForLevelFn(level);
    if (remaining >= needed) {
      remaining -= needed;
      level += 1;
    } else {
      return {
        level,
        totalXp: safeXp,
        currentLevelXp: remaining,
        xpNeededForNext: needed,
        progressRatio: needed > 0 ? Math.min(1, remaining / needed) : 0
      };
    }
  }
}

export function computeStatLevelProgress(totalXp) {
  return computeLevelProgress(totalXp, statXpForNextLevel);
}

export function computeOverallLevelProgress(totalXp) {
  return computeLevelProgress(totalXp, overallXpForNextLevel);
}

/**
 * Fixed difficulty tier XP lookup.
 */
export function getXpForTier(tier) {
  return TIER_XP[tier] ?? TIER_XP.Standard;
}

/**
 * 70% Primary / 30% Secondary stat XP split (or 100% Primary if no secondary).
 * Guarantees exact XP conservation: primaryXp + secondaryXp === totalXp.
 */
export function splitStatXp(totalXp, primaryStat, secondaryStat = null) {
  const xp = Math.max(0, Math.round(Number(totalXp) || 0));
  if (xp <= 0 || !primaryStat || !STAT_CODES.includes(primaryStat)) {
    return {};
  }

  const hasValidSecondary =
    Boolean(secondaryStat) &&
    STAT_CODES.includes(secondaryStat) &&
    secondaryStat !== primaryStat;

  if (!hasValidSecondary) {
    return { [primaryStat]: xp };
  }

  const primaryXp = Math.round(xp * 0.7);
  const secondaryXp = xp - primaryXp;
  return {
    [primaryStat]: primaryXp,
    [secondaryStat]: secondaryXp
  };
}

/**
 * Strictly additive stat update: Stat XP NEVER decreases.
 * Returns updated stat rows, new overall XP/level, and any level-up events.
 */
export function applyAdditiveStatXp(statRows, xpGains) {
  const byCode = new Map();
  for (const code of STAT_CODES) {
    const existing = statRows.find((r) => r.stat_code === code);
    byCode.set(code, {
      stat_code: code,
      total_xp: Math.max(0, existing?.total_xp || 0),
      current_level: Math.max(1, existing?.current_level || 1)
    });
  }

  const statLevelUps = [];
  let addedTotal = 0;

  for (const [code, rawDelta] of Object.entries(xpGains || {})) {
    if (!byCode.has(code)) continue;
    const delta = Math.max(0, Math.round(Number(rawDelta) || 0));
    if (delta === 0) continue;

    const row = byCode.get(code);
    const prevLevel = computeStatLevelProgress(row.total_xp).level;
    row.total_xp += delta;
    const nextProgress = computeStatLevelProgress(row.total_xp);
    row.current_level = nextProgress.level;
    addedTotal += delta;

    if (nextProgress.level > prevLevel) {
      statLevelUps.push({ stat_code: code, from: prevLevel, to: nextProgress.level });
    }
  }

  const updatedStats = STAT_CODES.map((c) => byCode.get(c));
  const combinedXp = updatedStats.reduce((sum, s) => sum + s.total_xp, 0);
  const overallProgress = computeOverallLevelProgress(combinedXp);

  return {
    updatedStats,
    addedTotal,
    overall_xp: combinedXp,
    overall_level: overallProgress.level,
    statLevelUps
  };
}

/**
 * Clamp Social / Weekly HP strictly to [0, 100].
 */
export function clampSocialHp(hp) {
  const num = Number(hp);
  if (!Number.isFinite(num)) return MONDAY_RESET_HP;
  return Math.max(SOCIAL_HP_MIN, Math.min(SOCIAL_HP_MAX, Math.round(num)));
}

export function applySocialHpDelta(currentHp, delta) {
  return clampSocialHp(currentHp + (Number(delta) || 0));
}

export function isLowHpWarning(hp) {
  return clampSocialHp(hp) <= LOW_HP_WARNING_THRESHOLD;
}

export function getSleepHpDelta(sleepQuality) {
  return SLEEP_HP_DELTA[sleepQuality] ?? 0;
}

export function getInteractionHpDelta(sentiment, isHeavyDrain = false) {
  if (sentiment === 'Bad' && isHeavyDrain) return HEAVY_DRAIN_HP_DELTA;
  return INTERACTION_HP_DELTA[sentiment] ?? 0;
}

/**
 * Normalize AI-proposed Journal HP delta to approved asymmetric bounds:
 * +10 (positive), 0 (neutral), -5 (negative), or -8 (heavy drain).
 */
export function normalizeJournalHpDelta(rawDelta, fallbackSentiment = 'Neutral') {
  if (typeof rawDelta !== 'number' || !Number.isFinite(rawDelta)) {
    return getInteractionHpDelta(fallbackSentiment);
  }
  if (rawDelta >= 5) return 10;
  if (rawDelta <= -7) return -8;
  if (rawDelta <= -2) return -5;
  return 0;
}

/**
 * Compute routine streak & XP award on completion.
 * Vacation days in dailyTurns do not break streaks.
 */
export function calculateRoutineCompletion(routine, turnDate, dailyTurns = [], isVacationMode = false) {
  const baseXp = routine.base_xp || TIER_XP.Routine;
  if (routine.last_completed_turn_date === turnDate) {
    return { alreadyCompleted: true, newStreak: routine.streak_count || 0, xpAwarded: 0, milestoneBonus: 0 };
  }

  let newStreak = 1;
  if (routine.last_completed_turn_date) {
    const isConsecutive = isConsecutiveActiveDay(routine.last_completed_turn_date, turnDate, dailyTurns);
    if (isConsecutive || isVacationMode) {
      newStreak = (routine.streak_count || 0) + 1;
    }
  }

  const milestoneBonus =
    newStreak > 0 && newStreak % ROUTINE_STREAK_MILESTONE === 0
      ? ROUTINE_STREAK_BONUS_XP
      : 0;

  return {
    alreadyCompleted: false,
    newStreak,
    bestStreak: Math.max(routine.best_streak || 0, newStreak),
    xpAwarded: baseXp + milestoneBonus,
    milestoneBonus
  };
}

/**
 * Helper: checks if two YYYY-MM-DD dates are consecutive active days
 * (ignoring any days explicitly marked is_vacation in dailyTurns).
 */
function isConsecutiveActiveDay(prevDateStr, currDateStr, dailyTurns) {
  if (!prevDateStr || !currDateStr || prevDateStr >= currDateStr) return false;
  const vacationSet = new Set(
    (dailyTurns || []).filter((d) => d.is_vacation).map((d) => d.turn_date)
  );

  const [py, pm, pd] = prevDateStr.split('-').map(Number);
  const [cy, cm, cd] = currDateStr.split('-').map(Number);
  const cursor = new Date(py, pm - 1, pd, 12, 0, 0);
  const target = new Date(cy, cm - 1, cd, 12, 0, 0);

  cursor.setDate(cursor.getDate() + 1);
  let guard = 0;
  while (cursor < target && guard < 366) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if (!vacationSet.has(iso)) {
      return false;
    }
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }

  return cursor.getTime() === target.getTime();
}

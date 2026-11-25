/**
 * Turn-Based Day Loop, Logical Turn Rollover, Monday Reset,
 * Missed End Day Recovery, and Weekly Report Benchmarking Logic.
 */

import { MONDAY_RESET_HP, clampSocialHp } from './rpgMath.js';

/**
 * Format a Date object as local YYYY-MM-DD.
 */
export function formatLocalDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parse YYYY-MM-DD into a local Date anchored at 12:00 PM to avoid DST edge issues.
 */
export function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/**
 * Add (or subtract) calendar days to a YYYY-MM-DD date string.
 */
export function addDays(dateStr, days) {
  const dt = parseLocalDate(dateStr);
  dt.setDate(dt.getDate() + days);
  return formatLocalDate(dt);
}

/**
 * Return local day of week: 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
 */
export function getDayOfWeek(dateStr) {
  return parseLocalDate(dateStr).getDay();
}

/**
 * Return Monday..Sunday bounds (YYYY-MM-DD) containing dateStr.
 */
export function getWeekBounds(dateStr) {
  const dow = getDayOfWeek(dateStr);
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const weekStart = addDays(dateStr, diffToMonday);
  const weekEnd = addDays(weekStart, 6);
  return { weekStart, weekEnd };
}

/**
 * Exact clock time string for End Day Confirmation modal (e.g., "9:15 PM").
 */
export function formatClockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Short display date (e.g., "Tue, Nov 25").
 */
export function formatShortDate(dateStr) {
  if (!dateStr) return '';
  return parseLocalDate(dateStr).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Calendar days elapsed between two YYYY-MM-DD strings.
 */
export function daysBetween(startStr, endStr) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseLocalDate(endStr).getTime() - parseLocalDate(startStr).getTime()) / msPerDay);
}

/**
 * Next logical turn date after confirming End Day.
 * Regardless of actual clock time, entries logged afterward apply to the following day.
 */
export function computeTurnRolloverDate(endedTurnDate) {
  return addDays(endedTurnDate, 1);
}

/**
 * Determine if Start Day on `newTurnDate` crosses into a new week (Monday–Sunday)
 * and therefore triggers the Monday Social HP reset to 75/100.
 */
export function shouldTriggerMondayHpReset(previousTurnDate, newTurnDate) {
  if (!previousTurnDate || !newTurnDate) return false;
  return getWeekBounds(previousTurnDate).weekStart !== getWeekBounds(newTurnDate).weekStart;
}

/**
 * Determine whether a Weekly Report should trigger on Sunday's End Day.
 */
export function isSundayTurn(turnDate) {
  return getDayOfWeek(turnDate) === 0;
}

/**
 * Inspect persisted state + current clock to decide the exact turn lifecycle phase:
 *  - 'missed_end_day': Previous started turn date < today and was never ended
 *  - 'weekly_report_pending': Previous week needs a Weekly Report BEFORE Monday 75 HP reset
 *  - 'start_day': Needs morning Start Day sleep check-in
 *  - 'active_rollover': Today was already closed early; app is rolled over to tomorrow's logical date
 *  - 'active': Normal daytime view for current_turn_date
 */
export function evaluateTurnLifecycle({
  profile,
  dailyTurns = [],
  interactions = [],
  weeklyReports = [],
  now = new Date()
}) {
  const todayStr = formatLocalDate(now);
  const turnMap = new Map(dailyTurns.map((t) => [t.turn_date, t]));
  const reportWeeks = new Set(weeklyReports.map((w) => w.week_start_date));

  const currentTurnDate = profile.current_turn_date || todayStr;
  const currentTurnRecord = turnMap.get(currentTurnDate);

  // 1. Missed End Day Recovery: started a turn on an earlier calendar day and never ended it
  if (profile.turn_started && currentTurnDate < todayStr && !currentTurnRecord?.ended_at) {
    return {
      phase: 'missed_end_day',
      missedTurnDate: currentTurnDate,
      todayStr
    };
  }

  // 2. Pending Weekly Report explicitly flagged (e.g., Sunday End Day or missed Sunday)
  if (profile.pending_weekly_report_week && !reportWeeks.has(profile.pending_weekly_report_week)) {
    const { weekStart, weekEnd } = getWeekBounds(profile.pending_weekly_report_week);
    return {
      phase: 'weekly_report_pending',
      weekStart,
      weekEnd,
      todayStr,
      beforeMondayReset: getWeekBounds(todayStr).weekStart !== weekStart
    };
  }

  // 3. Monday (or new week) Start Day check: if previous week had activity and no Weekly Report yet,
  //    trigger Weekly Report BEFORE applying Monday's 75 HP reset.
  const todayWeek = getWeekBounds(todayStr);
  if (!profile.turn_started && currentTurnDate <= todayStr) {
    const prevWeekStart = addDays(todayWeek.weekStart, -7);
    const prevWeekEnd = addDays(todayWeek.weekStart, -1);
    const hasPrevWeekActivity =
      dailyTurns.some((t) => t.turn_date >= prevWeekStart && t.turn_date <= prevWeekEnd && !t.is_vacation) ||
      interactions.some((i) => i.assigned_turn_date >= prevWeekStart && i.assigned_turn_date <= prevWeekEnd);

    if (hasPrevWeekActivity && !reportWeeks.has(prevWeekStart)) {
      return {
        phase: 'weekly_report_pending',
        weekStart: prevWeekStart,
        weekEnd: prevWeekEnd,
        todayStr,
        beforeMondayReset: true
      };
    }
  }

  // 4. Post-End-Day Logical Rollover: user ended today early; current_turn_date is already tomorrow!
  if (!profile.turn_started && currentTurnDate > todayStr) {
    return {
      phase: 'active_rollover',
      turnDate: currentTurnDate,
      todayStr
    };
  }

  // 5. Morning Start Day check-in
  if (!profile.turn_started) {
    const lastEndedTurn = [...dailyTurns]
      .filter((t) => Boolean(t.ended_at))
      .sort((a, b) => b.turn_date.localeCompare(a.turn_date))[0];

    const targetTurnDate = currentTurnDate < todayStr ? todayStr : currentTurnDate;
    const mondayReset = shouldTriggerMondayHpReset(lastEndedTurn?.turn_date, targetTurnDate);

    return {
      phase: 'start_day',
      turnDate: targetTurnDate,
      todayStr,
      isMondayReset: mondayReset
    };
  }

  // 6. Normal active daytime turn
  return {
    phase: 'active',
    turnDate: currentTurnDate,
    todayStr
  };
}

/**
 * Determine whether the 7-day Save Point backup reminder should show.
 */
export function needsBackupReminder(profile, now = new Date()) {
  const referenceIso = profile?.last_backup_at || profile?.created_at;
  if (!referenceIso) return false;
  const refDate = new Date(referenceIso);
  if (Number.isNaN(refDate.getTime())) return false;
  const elapsedDays = (now.getTime() - refDate.getTime()) / (24 * 60 * 60 * 1000);
  return elapsedDays >= 7;
}

export function getDaysSinceBackup(profile, now = new Date()) {
  if (!profile?.last_backup_at) return null;
  const refDate = new Date(profile.last_backup_at);
  if (Number.isNaN(refDate.getTime())) return null;
  return Math.floor((now.getTime() - refDate.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Compute Net Weekly Tone label from tone score.
 */
export function getToneLabel(netToneScore) {
  if (netToneScore >= 2) return 'Positive';
  if (netToneScore <= -2) return 'Strained';
  return 'Balanced';
}

/**
 * Build Weekly Report metrics & rolling 4-week / all-time historical benchmarks.
 * Strictly excludes vacation/Long Rest days from active averages.
 */
export function computeWeeklyReportData({
  weekStart,
  weekEnd,
  dailyTurns = [],
  interactions = [],
  tasks = [],
  historicalReports = [],
  fallbackEndingHp = MONDAY_RESET_HP,
  fallbackStartingHp = MONDAY_RESET_HP
}) {
  const weekTurns = dailyTurns
    .filter((t) => t.turn_date >= weekStart && t.turn_date <= weekEnd)
    .sort((a, b) => a.turn_date.localeCompare(b.turn_date));

  const activeTurns = weekTurns.filter((t) => !t.is_vacation);
  const vacationDays = weekTurns.filter((t) => t.is_vacation).length;

  const weekInteractions = interactions.filter(
    (i) => i.assigned_turn_date >= weekStart && i.assigned_turn_date <= weekEnd
  );

  const weekCompletedTasks = tasks.filter(
    (t) =>
      t.status === 'completed' &&
      (t.completed_turn_date || t.assigned_turn_date) >= weekStart &&
      (t.completed_turn_date || t.assigned_turn_date) <= weekEnd
  );

  const startingHp =
    activeTurns.length > 0 && typeof activeTurns[0].starting_hp === 'number'
      ? clampSocialHp(activeTurns[0].starting_hp)
      : clampSocialHp(fallbackStartingHp);

  const endingHp =
    activeTurns.length > 0 && typeof activeTurns[activeTurns.length - 1].ending_hp === 'number'
      ? clampSocialHp(activeTurns[activeTurns.length - 1].ending_hp)
      : clampSocialHp(fallbackEndingHp);

  const netHpDelta = endingHp - startingHp;

  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  for (const item of weekInteractions) {
    if (item.user_sentiment === 'Good' || (item.entry_type === 'Journal' && item.hp_delta > 0)) {
      positiveCount += 1;
    } else if (item.user_sentiment === 'Bad' || (item.entry_type === 'Journal' && item.hp_delta < 0)) {
      negativeCount += 1;
    } else {
      neutralCount += 1;
    }
  }

  const netToneScore = positiveCount - negativeCount;
  const interactionVolume = weekInteractions.length;

  const sleepSummary = { Good: 0, Okay: 0, Poor: 0 };
  for (const t of activeTurns) {
    if (t.sleep_quality && Object.prototype.hasOwnProperty.call(sleepSummary, t.sleep_quality)) {
      sleepSummary[t.sleep_quality] += 1;
    }
  }

  const totalXpEarned = activeTurns.reduce((sum, t) => sum + (t.total_xp_earned || 0), 0);

  // Exclude prior reports with 0 active days (full-vacation weeks) and exclude current week
  const eligibleHistory = historicalReports
    .filter((r) => r.week_start_date !== weekStart && (r.active_days ?? 1) > 0)
    .sort((a, b) => b.week_start_date.localeCompare(a.week_start_date));

  const calcAvg = (list) => {
    if (!list.length) return null;
    const avg = (fn) => Math.round((list.reduce((s, r) => s + fn(r), 0) / list.length) * 10) / 10;
    return {
      weeks: list.length,
      ending_hp: avg((r) => r.ending_hp ?? 75),
      net_tone_score: avg((r) => r.net_tone_score ?? 0),
      interaction_volume: avg((r) => r.interaction_volume ?? 0)
    };
  };

  const rolling4Week = eligibleHistory.length >= 4 ? calcAvg(eligibleHistory.slice(0, 4)) : null;
  const allTime = eligibleHistory.length >= 1 ? calcAvg(eligibleHistory) : null;

  return {
    week_start_date: weekStart,
    week_end_date: weekEnd,
    starting_hp: startingHp,
    ending_hp: endingHp,
    net_hp_delta: netHpDelta,
    net_tone_score: netToneScore,
    interaction_volume: interactionVolume,
    sleep_summary: sleepSummary,
    sleep_summary_json: JSON.stringify(sleepSummary),
    total_xp_earned: totalXpEarned,
    tasks_completed: weekCompletedTasks.length,
    active_days: activeTurns.length,
    vacation_days: vacationDays,
    sentiment_breakdown: { positive: positiveCount, neutral: neutralCount, negative: negativeCount },
    benchmarks: {
      priorWeeksCount: eligibleHistory.length,
      hasFourWeekBaseline: eligibleHistory.length >= 4,
      rolling4Week,
      allTime
    }
  };
}

/**
 * Borb — Personal, Local-First Tactical RPG Task & Life Tracker PWA
 * Main Application Controller
 */

import {
  STAT_CODES,
  TIER_XP,
  MONDAY_RESET_HP,
  RESTORATIVE_TASK_HP_DELTA,
  getXpForTier,
  splitStatXp,
  applyAdditiveStatXp,
  applySocialHpDelta,
  clampSocialHp,
  getSleepHpDelta,
  calculateRoutineCompletion
} from './core/rpgMath.js';
import {
  formatLocalDate,
  getWeekBounds,
  computeTurnRolloverDate,
  evaluateTurnLifecycle,
  isSundayTurn,
  computeWeeklyReportData
} from './core/turnLogic.js';
import { RpgDatabase, createId } from './db/database.js';
import {
  downloadSavePointFile,
  validateSavePointData,
  importSavePointData
} from './db/savePoint.js';
import {
  DEFAULT_GEMINI_MODEL,
  resolveGeminiModel,
  triageTaskWithGemini,
  evaluateEntryWithGemini,
  generateDailySummaryWithGemini,
  generateWeeklyReflectionWithGemini,
  testGeminiApiKey
} from './services/geminiApi.js';
import {
  renderTopHud,
  renderQuestsView,
  renderCharacterView,
  renderLogView,
  renderBottomThumbZone
} from './ui/components.js';
import {
  renderMissedEndDayModal,
  renderStartDayModal,
  renderEndDayConfirmModal,
  renderDailyReportModal,
  renderWeeklyReportModal,
  renderInteractionModal,
  renderTaskOverrideModal,
  renderSettingsModal
} from './ui/modals.js';

const db = new RpgDatabase();

const state = {
  snapshot: null,
  activeTab: 'quests',
  routinesExpanded: true,
  isTriaging: false,
  isSubmittingEntry: false,
  modal: null, // { type, ...payload }
  showApiKey: false,
  apiTestStatus: ''
};

const appEl = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');

function showToast(message, variant = 'default') {
  const el = document.createElement('div');
  el.className = `toast ${variant !== 'default' ? `toast--${variant}` : ''}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s ease';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

async function reloadSnapshot() {
  state.snapshot = await db.loadSnapshot();
}

function getLifecycle() {
  const { profile, dailyTurns, interactions, weeklyReports } = state.snapshot;
  return evaluateTurnLifecycle({
    profile,
    dailyTurns,
    interactions,
    weeklyReports,
    now: new Date()
  });
}

/**
 * Ensure a daily_turns record exists for the given turnDate.
 */
async function ensureDailyTurnRecord(turnDate, overrides = {}) {
  let existing = await db.get('daily_turns', turnDate);
  if (!existing) {
    existing = {
      turn_date: turnDate,
      sleep_quality: null,
      sleep_note: '',
      sleep_hp_delta: 0,
      starting_hp: clampSocialHp(state.snapshot.profile.current_social_hp),
      ending_hp: clampSocialHp(state.snapshot.profile.current_social_hp),
      total_xp_earned: 0,
      stat_xp_gained: Object.fromEntries(STAT_CODES.map((c) => [c, 0])),
      restorative_hp_gained: 0,
      interaction_hp_delta: 0,
      routines_completed: 0,
      tasks_completed: 0,
      ended_at: null,
      gemini_daily_summary: '',
      is_vacation: Boolean(state.snapshot.profile.vacation_mode),
      ...overrides
    };
    await db.put('daily_turns', existing);
  } else if (Object.keys(overrides).length > 0) {
    existing = { ...existing, ...overrides };
    await db.put('daily_turns', existing);
  }
  return existing;
}

/**
 * Apply strictly additive XP map across stats, profile, and active turn record.
 */
async function awardXpToTurn(turnDate, xpMap, { isTask = false, isRoutine = false } = {}) {
  const { profile, stats } = state.snapshot;
  const result = applyAdditiveStatXp(stats, xpMap);

  await db.putMany('stat_progress', result.updatedStats);
  const updatedProfile = {
    ...profile,
    overall_xp: result.overall_xp,
    overall_level: result.overall_level
  };
  await db.put('character_profile', updatedProfile);

  const turn = await ensureDailyTurnRecord(turnDate);
  const nextStatGains = { ...(turn.stat_xp_gained || {}) };
  for (const [code, val] of Object.entries(xpMap)) {
    nextStatGains[code] = (nextStatGains[code] || 0) + val;
  }

  await db.put('daily_turns', {
    ...turn,
    total_xp_earned: (turn.total_xp_earned || 0) + result.addedTotal,
    stat_xp_gained: nextStatGains,
    tasks_completed: (turn.tasks_completed || 0) + (isTask ? 1 : 0),
    routines_completed: (turn.routines_completed || 0) + (isRoutine ? 1 : 0),
    ending_hp: updatedProfile.current_social_hp
  });

  return result;
}

/**
 * Adjust Social HP with clamping [0..100] and record breakdown on daily turn.
 */
async function adjustSocialHp(turnDate, delta, source = 'interaction', { clearStatusEffects = false } = {}) {
  const profile = await db.get('character_profile', 'main');
  const nextHp = applySocialHpDelta(profile.current_social_hp, delta);
  const nextEffects = clearStatusEffects ? [] : [...(profile.active_status_effects || [])];

  await db.put('character_profile', {
    ...profile,
    current_social_hp: nextHp,
    active_status_effects: nextEffects
  });

  const turn = await ensureDailyTurnRecord(turnDate);
  const updates = { ending_hp: nextHp };
  if (source === 'restorative' && delta > 0) {
    updates.restorative_hp_gained = (turn.restorative_hp_gained || 0) + delta;
  } else if (source === 'interaction') {
    updates.interaction_hp_delta = (turn.interaction_hp_delta || 0) + delta;
  } else if (source === 'sleep') {
    updates.sleep_hp_delta = delta;
  }
  await db.put('daily_turns', { ...turn, ...updates });

  return nextHp;
}

/**
 * Evaluate lifecycle on boot or after closing a report and open required modal automatically.
 */
async function syncLifecycleModal() {
  await reloadSnapshot();
  const lifecycle = getLifecycle();

  if (lifecycle.phase === 'missed_end_day') {
    state.modal = {
      type: 'missed_end_day',
      missedTurnDate: lifecycle.missedTurnDate,
      todayStr: lifecycle.todayStr
    };
  } else if (lifecycle.phase === 'weekly_report_pending') {
    await openWeeklyReportFlow(lifecycle.weekStart, lifecycle.weekEnd, {
      canDismiss: false,
      saveToDb: true
    });
    return;
  } else if (lifecycle.phase === 'start_day') {
    const carryoverTasks = state.snapshot.tasks.filter(
      (t) =>
        (t.status === 'active' || t.status === 'pending_triage') &&
        t.assigned_turn_date &&
        t.assigned_turn_date < lifecycle.turnDate
    );
    state.modal = {
      type: 'start_day',
      turnDate: lifecycle.turnDate,
      isMondayReset: lifecycle.isMondayReset,
      carryoverTasks,
      draft: { sleepQuality: 'Okay', sleepNote: '' }
    };
  } else {
    state.modal = null;
  }

  render();
}

/**
 * Open End-of-Day Daily Report ("Long Rest") for a specific turn date.
 */
async function openDailyReportFlow(turnDate, { isMissedRecovery = false } = {}) {
  await reloadSnapshot();
  const { profile, stats, interactions, tasks, routines } = state.snapshot;
  const turn = await ensureDailyTurnRecord(turnDate);

  const { weekStart, weekEnd } = getWeekBounds(turnDate);
  const weekInteractions = interactions.filter(
    (i) => i.assigned_turn_date >= weekStart && i.assigned_turn_date <= weekEnd
  );
  const weekToneScore = weekInteractions.reduce((acc, i) => {
    if (i.user_sentiment === 'Good' || (i.entry_type === 'Journal' && i.hp_delta > 0)) return acc + 1;
    if (i.user_sentiment === 'Bad' || (i.entry_type === 'Journal' && i.hp_delta < 0)) return acc - 1;
    return acc;
  }, 0);

  const completedTasksCount = tasks.filter(
    (t) => t.status === 'completed' && (t.completed_turn_date || t.assigned_turn_date) === turnDate
  ).length;
  const completedRoutinesCount = routines.filter(
    (r) => r.last_completed_turn_date === turnDate
  ).length;

  const draftReport = {
    ...turn,
    turn_date: turnDate,
    ending_hp: clampSocialHp(profile.current_social_hp),
    tasks_completed: Math.max(turn.tasks_completed || 0, completedTasksCount),
    routines_completed: Math.max(turn.routines_completed || 0, completedRoutinesCount),
    week_tone_score: weekToneScore,
    is_vacation: Boolean(profile.vacation_mode || turn.is_vacation),
    level_ups: []
  };

  state.modal = {
    type: 'daily_report',
    report: draftReport,
    isGeneratingSummary: true,
    isMissedRecovery
  };
  render();
  animateReportBars();

  const summaryRes = await generateDailySummaryWithGemini(
    {
      turn_date: turnDate,
      sleep_quality: draftReport.sleep_quality || 'Okay',
      sleep_note: draftReport.sleep_note || '',
      total_xp_earned: draftReport.total_xp_earned || 0,
      stat_xp_gained: draftReport.stat_xp_gained || {},
      tasks_completed: draftReport.tasks_completed,
      routines_completed: draftReport.routines_completed,
      ending_hp: draftReport.ending_hp,
      restorative_hp_gained: draftReport.restorative_hp_gained || 0,
      interaction_hp_delta: draftReport.interaction_hp_delta || 0,
      is_vacation: draftReport.is_vacation
    },
    profile.gemini_api_key,
    profile.gemini_model
  );

  if (state.modal?.type === 'daily_report') {
    state.modal.report.gemini_daily_summary = summaryRes.summary;
    state.modal.isGeneratingSummary = false;
    render();
    animateReportBars();
  }
}

function animateReportBars() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.querySelectorAll('.report-xp-bar').forEach((bar) => {
        const target = bar.getAttribute('data-target-width');
        if (target) bar.style.width = target;
      });
    });
  });
}

/**
 * Open Weekly Report (either automatic trigger on Sunday End Day / Monday Start Day,
 * or manually viewed from Top HUD / Log).
 */
async function openWeeklyReportFlow(weekStart, weekEnd, { canDismiss = true, saveToDb = false } = {}) {
  await reloadSnapshot();
  const { profile, dailyTurns, interactions, tasks, weeklyReports } = state.snapshot;

  const existingSaved = weeklyReports.find((w) => w.week_start_date === weekStart);
  const metrics = computeWeeklyReportData({
    weekStart,
    weekEnd,
    dailyTurns,
    interactions,
    tasks,
    historicalReports: weeklyReports,
    fallbackEndingHp: profile.current_social_hp,
    fallbackStartingHp: profile.week_starting_hp ?? MONDAY_RESET_HP
  });

  if (existingSaved && !saveToDb) {
    state.modal = {
      type: 'weekly_report',
      report: {
        ...metrics,
        ...existingSaved,
        sleep_summary: JSON.parse(existingSaved.sleep_summary_json || metrics.sleep_summary_json),
        benchmarks: metrics.benchmarks
      },
      isGenerating: false,
      canDismiss
    };
    render();
    return;
  }

  state.modal = {
    type: 'weekly_report',
    report: { ...metrics, gemini_weekly_reflection: '' },
    isGenerating: true,
    canDismiss
  };
  render();

  const refRes = await generateWeeklyReflectionWithGemini(
    {
      week_start_date: weekStart,
      week_end_date: weekEnd,
      starting_hp: metrics.starting_hp,
      ending_hp: metrics.ending_hp,
      net_hp_delta: metrics.net_hp_delta,
      net_tone_score: metrics.net_tone_score,
      interaction_volume: metrics.interaction_volume,
      sleep_summary: metrics.sleep_summary,
      active_days: metrics.active_days,
      vacation_days: metrics.vacation_days,
      benchmarks: metrics.benchmarks
    },
    profile.gemini_api_key,
    profile.gemini_model
  );

  const finalRecord = {
    week_start_date: weekStart,
    week_end_date: weekEnd,
    starting_hp: metrics.starting_hp,
    ending_hp: metrics.ending_hp,
    net_hp_delta: metrics.net_hp_delta,
    net_tone_score: metrics.net_tone_score,
    interaction_volume: metrics.interaction_volume,
    sleep_summary_json: metrics.sleep_summary_json,
    total_xp_earned: metrics.total_xp_earned,
    active_days: metrics.active_days,
    gemini_weekly_reflection: refRes.reflection,
    created_at: new Date().toISOString()
  };

  if (saveToDb) {
    await db.put('weekly_reports', finalRecord);
    const freshProfile = await db.get('character_profile', 'main');
    if (freshProfile.pending_weekly_report_week === weekStart) {
      await db.put('character_profile', { ...freshProfile, pending_weekly_report_week: null });
    }
    await reloadSnapshot();
  }

  if (state.modal?.type === 'weekly_report') {
    state.modal.report = { ...metrics, ...finalRecord, benchmarks: metrics.benchmarks };
    state.modal.isGenerating = false;
    render();
  }
}

/**
 * Render full application + active modal.
 */
function render() {
  if (!state.snapshot) return;
  const { profile, stats, tasks, routines, interactions, dailyTurns, weeklyReports } = state.snapshot;
  const lifecycle = getLifecycle();

  let mainHtml = '';
  if (state.activeTab === 'quests') {
    mainHtml = renderQuestsView({
      profile,
      tasks,
      routines,
      routinesExpanded: state.routinesExpanded,
      lifecycle,
      isTriaging: state.isTriaging
    });
  } else if (state.activeTab === 'character') {
    mainHtml = renderCharacterView({ profile, stats });
  } else {
    mainHtml = renderLogView({ interactions, dailyTurns, weeklyReports });
  }

  appEl.innerHTML = `
    ${renderTopHud({ profile, activeTab: state.activeTab, lifecycle })}
    <main class="main-content">
      ${mainHtml}
    </main>
    ${renderBottomThumbZone({ isTriaging: state.isTriaging, lifecycle })}
  `;

  // Render active modal
  if (!state.modal) {
    modalRoot.innerHTML = '';
  } else {
    switch (state.modal.type) {
      case 'missed_end_day':
        modalRoot.innerHTML = renderMissedEndDayModal(state.modal);
        break;
      case 'start_day':
        modalRoot.innerHTML = renderStartDayModal({
          ...state.modal,
          isVacation: Boolean(profile.vacation_mode)
        });
        break;
      case 'end_day_confirm':
        modalRoot.innerHTML = renderEndDayConfirmModal({
          turnDate: profile.current_turn_date,
          now: state.modal.now
        });
        break;
      case 'daily_report':
        modalRoot.innerHTML = renderDailyReportModal({
          report: state.modal.report,
          stats,
          isGeneratingSummary: state.modal.isGeneratingSummary
        });
        break;
      case 'weekly_report':
        modalRoot.innerHTML = renderWeeklyReportModal(state.modal);
        break;
      case 'interaction':
        modalRoot.innerHTML = renderInteractionModal({
          draft: state.modal.draft,
          isSubmitting: state.isSubmittingEntry
        });
        break;
      case 'task_override':
        modalRoot.innerHTML = renderTaskOverrideModal({
          task: state.modal.draftTask,
          isTriaging: state.isTriaging
        });
        break;
      case 'settings':
        modalRoot.innerHTML = renderSettingsModal({
          profile,
          routines,
          showApiKey: state.showApiKey,
          apiTestStatus: state.apiTestStatus,
          draft: state.modal.draft
        });
        break;
      default:
        modalRoot.innerHTML = '';
    }
  }
}

/* ================= EVENT HANDLERS ================= */

async function handleQuickAddTask(rawText) {
  const text = rawText.trim();
  if (!text) return;

  const { profile } = state.snapshot;
  const turnDate = profile.current_turn_date;
  const nowIso = new Date().toISOString();

  // Save task immediately with optimistic fallback so capture never blocks
  const taskId = createId('tsk');
  const initialTask = {
    id: taskId,
    raw_text: text,
    quest_title: text,
    category: 'Admin',
    primary_stat: 'DSC',
    secondary_stat: null,
    difficulty_tier: 'Standard',
    is_restorative: false,
    status: 'pending_triage',
    triage_error: null,
    created_at: nowIso,
    completed_at: null,
    assigned_turn_date: turnDate,
    completed_turn_date: null,
    xp_awarded: 0
  };

  await db.put('tasks', initialTask);
  state.isTriaging = true;
  await reloadSnapshot();
  render();

  const triage = await triageTaskWithGemini(text, profile.gemini_api_key, profile.gemini_model);
  const currentTask = await db.get('tasks', taskId);
  if (currentTask && currentTask.status !== 'completed') {
    await db.put('tasks', {
      ...currentTask,
      quest_title: triage.result.quest_title,
      category: triage.result.category,
      primary_stat: triage.result.primary_stat,
      secondary_stat: triage.result.secondary_stat,
      difficulty_tier: triage.result.difficulty_tier,
      is_restorative: triage.result.is_restorative,
      status: triage.pendingTriage ? 'pending_triage' : 'active',
      triage_error: triage.error || null
    });
  }

  state.isTriaging = false;
  await reloadSnapshot();
  render();

  if (triage.pendingTriage) {
    showToast('Saved as Pending Triage (35 XP). Tap card to override or retry.', 'default');
  } else {
    showToast(`Triaged: ${triage.result.difficulty_tier} (${triage.result.primary_stat})`, 'success');
  }
}

async function handleRetryTaskTriage(taskId, updateModal = false) {
  const task = await db.get('tasks', taskId);
  if (!task) return;
  const { profile } = state.snapshot;

  state.isTriaging = true;
  render();

  const triage = await triageTaskWithGemini(task.raw_text, profile.gemini_api_key, profile.gemini_model);
  const updated = {
    ...task,
    quest_title: triage.result.quest_title,
    category: triage.result.category,
    primary_stat: triage.result.primary_stat,
    secondary_stat: triage.result.secondary_stat,
    difficulty_tier: triage.result.difficulty_tier,
    is_restorative: triage.result.is_restorative,
    status: triage.pendingTriage ? 'pending_triage' : 'active',
    triage_error: triage.error || null
  };
  await db.put('tasks', updated);
  state.isTriaging = false;
  await reloadSnapshot();

  if (updateModal && state.modal?.type === 'task_override') {
    state.modal.draftTask = { ...updated };
  }
  render();

  if (triage.pendingTriage) {
    showToast(`Triage unavailable: ${triage.error}`, 'error');
  } else {
    showToast(`AI Triage updated: ${updated.difficulty_tier} (${updated.primary_stat})`, 'success');
  }
}

async function handleCompleteTask(taskId) {
  const task = await db.get('tasks', taskId);
  if (!task || task.status === 'completed') return;

  const turnDate = state.snapshot.profile.current_turn_date;
  const totalXp = getXpForTier(task.difficulty_tier);
  const xpMap = splitStatXp(totalXp, task.primary_stat, task.secondary_stat);

  await db.put('tasks', {
    ...task,
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_turn_date: turnDate,
    xp_awarded: totalXp
  });

  await awardXpToTurn(turnDate, xpMap, { isTask: true });

  if (task.is_restorative) {
    await adjustSocialHp(turnDate, RESTORATIVE_TASK_HP_DELTA, 'restorative', {
      clearStatusEffects: true
    });
    showToast(`+${totalXp} XP • Restorative +10 Social HP!`, 'success');
  } else {
    showToast(`Quest cleared! +${totalXp} XP banked.`, 'success');
  }

  await reloadSnapshot();
  render();
}

async function handleCompleteRoutine(routineId) {
  const routine = await db.get('routines', routineId);
  if (!routine) return;

  const { profile, dailyTurns } = state.snapshot;
  const turnDate = profile.current_turn_date;
  const calc = calculateRoutineCompletion(routine, turnDate, dailyTurns, profile.vacation_mode);
  if (calc.alreadyCompleted) return;

  await db.put('routines', {
    ...routine,
    streak_count: calc.newStreak,
    best_streak: calc.bestStreak,
    last_completed_turn_date: turnDate
  });

  const targetStat = STAT_CODES.includes(routine.target_stat) ? routine.target_stat : 'DSC';
  await awardXpToTurn(turnDate, { [targetStat]: calc.xpAwarded }, { isRoutine: true });

  await reloadSnapshot();
  render();

  if (calc.milestoneBonus > 0) {
    showToast(`🔥 ${calc.newStreak}-day streak! +${calc.xpAwarded} ${targetStat} XP (+25 bonus)!`, 'success');
  } else {
    showToast(`Routine complete: +${calc.xpAwarded} ${targetStat} XP (${calc.newStreak}d streak)`, 'success');
  }
}

async function handleConfirmStartDay() {
  if (state.modal?.type !== 'start_day') return;
  const { turnDate, isMondayReset, draft } = state.modal;
  const sleepNoteInput = document.getElementById('sleep-note-input');
  const sleepNote = sleepNoteInput ? sleepNoteInput.value.trim() : draft.sleepNote || '';
  const sleepQuality = draft.sleepQuality || 'Okay';
  const sleepDelta = getSleepHpDelta(sleepQuality);

  const profile = await db.get('character_profile', 'main');
  let baseHp = clampSocialHp(profile.current_social_hp);
  let weekStartingHp = profile.week_starting_hp ?? baseHp;

  if (isMondayReset) {
    baseHp = MONDAY_RESET_HP;
    weekStartingHp = MONDAY_RESET_HP;
  }

  const nextHp = applySocialHpDelta(baseHp, sleepDelta);

  await db.put('character_profile', {
    ...profile,
    current_turn_date: turnDate,
    turn_started: true,
    current_social_hp: nextHp,
    week_starting_hp: weekStartingHp
  });

  await reloadSnapshot();
  await ensureDailyTurnRecord(turnDate, {
    sleep_quality: sleepQuality,
    sleep_note: sleepNote,
    sleep_hp_delta: sleepDelta,
    starting_hp: baseHp,
    ending_hp: nextHp,
    is_vacation: Boolean(profile.vacation_mode)
  });

  state.modal = null;
  await reloadSnapshot();
  render();

  const msg = isMondayReset
    ? `New week! Social HP reset to 75, sleep ${sleepDelta >= 0 ? `+${sleepDelta}` : sleepDelta} → ${nextHp}/100 HP.`
    : `Turn started (${sleepQuality} sleep ${sleepDelta >= 0 ? `+${sleepDelta}` : sleepDelta} HP).`;
  showToast(msg, 'success');
}

async function handleSaveAndSleep() {
  if (state.modal?.type !== 'daily_report') return;
  const { report } = state.modal;
  const endedTurnDate = report.turn_date;
  const nextTurnDate = computeTurnRolloverDate(endedTurnDate);
  const sundayTrigger = isSundayTurn(endedTurnDate);
  const { weekStart, weekEnd } = getWeekBounds(endedTurnDate);

  const existingTurn = await ensureDailyTurnRecord(endedTurnDate);
  await db.put('daily_turns', {
    ...existingTurn,
    ending_hp: clampSocialHp(report.ending_hp),
    gemini_daily_summary: report.gemini_daily_summary || '',
    ended_at: new Date().toISOString(),
    is_vacation: Boolean(report.is_vacation)
  });

  const profile = await db.get('character_profile', 'main');
  await db.put('character_profile', {
    ...profile,
    current_turn_date: nextTurnDate,
    turn_started: false,
    active_status_effects: [], // Clear temporary status tags on Save & Sleep
    pending_weekly_report_week: sundayTrigger ? weekStart : profile.pending_weekly_report_week
  });

  showToast(`Day saved! Logical turn rolled over to ${nextTurnDate}.`, 'success');

  if (sundayTrigger) {
    await openWeeklyReportFlow(weekStart, weekEnd, { canDismiss: false, saveToDb: true });
    return;
  }

  await syncLifecycleModal();
}

async function handleSubmitInteraction() {
  if (state.modal?.type !== 'interaction' || state.isSubmittingEntry) return;
  const notesEl = document.getElementById('interaction-notes-input');
  const rawText = (notesEl ? notesEl.value : state.modal.draft.rawText || '').trim();
  if (!rawText) {
    showToast('Please enter notes for this entry.', 'error');
    return;
  }

  const entryType = state.modal.draft.entryType || 'Interaction';
  const userSentiment = entryType === 'Journal' ? 'Neutral' : state.modal.draft.sentiment || 'Good';
  const { profile } = state.snapshot;
  const turnDate = profile.current_turn_date;

  state.isSubmittingEntry = true;
  state.modal.draft.rawText = rawText;
  render();

  const evalRes = await evaluateEntryWithGemini(
    { entryType, rawText, userSentiment },
    profile.gemini_api_key,
    profile.gemini_model
  );

  const r = evalRes.result;
  const xpAwarded = getXpForTier(r.xp_tier);
  const xpMap = splitStatXp(xpAwarded, r.primary_stat, r.secondary_stat);

  // Determine effective sentiment label for journal tone tracking
  const recordedSentiment =
    entryType === 'Journal'
      ? r.hp_delta > 0
        ? 'Good'
        : r.hp_delta < 0
          ? 'Bad'
          : 'Neutral'
      : userSentiment;

  await db.put('interactions_journal', {
    id: createId('int'),
    entry_type: entryType,
    raw_text: rawText,
    user_sentiment: recordedSentiment,
    primary_stat: r.primary_stat,
    secondary_stat: r.secondary_stat,
    xp_tier: r.xp_tier,
    xp_awarded: xpAwarded,
    hp_delta: r.hp_delta,
    status_effect: r.status_effect,
    dm_note: r.dm_note,
    pending_ai: evalRes.pendingAi,
    created_at: new Date().toISOString(),
    assigned_turn_date: turnDate
  });

  if (xpAwarded > 0) {
    await awardXpToTurn(turnDate, xpMap);
  }
  await adjustSocialHp(turnDate, r.hp_delta, 'interaction');

  if (r.status_effect) {
    const freshProfile = await db.get('character_profile', 'main');
    const effects = new Set(freshProfile.active_status_effects || []);
    effects.add(r.status_effect);
    await db.put('character_profile', {
      ...freshProfile,
      active_status_effects: Array.from(effects)
    });
  }

  state.isSubmittingEntry = false;
  state.modal = null;
  await reloadSnapshot();
  render();

  const hpSign = r.hp_delta >= 0 ? `+${r.hp_delta}` : `${r.hp_delta}`;
  showToast(`Logged: +${xpAwarded} XP, ${hpSign} Social HP.`, r.hp_delta < 0 ? 'default' : 'success');
}

async function handleSaveTaskOverride() {
  if (state.modal?.type !== 'task_override') return;
  const draft = state.modal.draftTask;
  const titleEl = document.getElementById('edit-quest-title');
  const primaryEl = document.getElementById('edit-primary-stat');
  const secondaryEl = document.getElementById('edit-secondary-stat');
  const categoryEl = document.getElementById('edit-category');

  const primaryStat = primaryEl ? primaryEl.value : draft.primary_stat;
  let secondaryStat = secondaryEl ? secondaryEl.value || null : draft.secondary_stat;
  if (secondaryStat === primaryStat) secondaryStat = null;

  const updated = {
    ...draft,
    quest_title: (titleEl ? titleEl.value.trim() : draft.quest_title) || draft.raw_text,
    primary_stat: primaryStat,
    secondary_stat: secondaryStat,
    category: categoryEl ? categoryEl.value : draft.category,
    status: 'active',
    triage_error: null
  };

  await db.put('tasks', updated);
  state.modal = null;
  await reloadSnapshot();
  render();
  showToast('Quest tags updated.', 'success');
}

/* ================= GLOBAL DELEGATED LISTENERS ================= */

document.addEventListener('submit', async (event) => {
  if (event.target && event.target.id === 'quick-add-form') {
    event.preventDefault();
    const input = document.getElementById('quick-add-input');
    if (!input) return;
    const val = input.value;
    input.value = '';
    await handleQuickAddTask(val);
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target && target.id === 'import-save-input') {
    const file = target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const check = validateSavePointData(parsed);
      if (!check.valid) {
        showToast(check.error, 'error');
        return;
      }
      if (!confirm(`Restore Save Point from ${parsed.exported_at || file.name}? This replaces all current local data.`)) {
        target.value = '';
        return;
      }
      await importSavePointData(db, parsed);
      state.modal = null;
      await syncLifecycleModal();
      showToast('Save Point restored across all 7 stores!', 'success');
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    } finally {
      target.value = '';
    }
  }
});

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id');

  switch (action) {
    case 'switch-tab':
      state.activeTab = btn.getAttribute('data-tab') || 'quests';
      render();
      break;

    case 'toggle-routines':
      state.routinesExpanded = !state.routinesExpanded;
      render();
      break;

    case 'complete-routine':
      await handleCompleteRoutine(id);
      break;

    case 'complete-task':
      await handleCompleteTask(id);
      break;

    case 'retry-triage':
      await handleRetryTaskTriage(id, false);
      break;

    case 'edit-task': {
      const task = state.snapshot.tasks.find((t) => t.id === id);
      if (task) {
        state.modal = { type: 'task_override', draftTask: { ...task } };
        render();
      }
      break;
    }

    case 'override-field': {
      if (state.modal?.type === 'task_override') {
        const titleEl = document.getElementById('edit-quest-title');
        const primaryEl = document.getElementById('edit-primary-stat');
        const secondaryEl = document.getElementById('edit-secondary-stat');
        const categoryEl = document.getElementById('edit-category');
        if (titleEl) state.modal.draftTask.quest_title = titleEl.value;
        if (primaryEl) state.modal.draftTask.primary_stat = primaryEl.value;
        if (secondaryEl) state.modal.draftTask.secondary_stat = secondaryEl.value || null;
        if (categoryEl) state.modal.draftTask.category = categoryEl.value;

        const field = btn.getAttribute('data-field');
        const value = btn.getAttribute('data-value');
        state.modal.draftTask[field] = value;
        render();
      }
      break;
    }

    case 'override-toggle-restorative': {
      if (state.modal?.type === 'task_override') {
        const titleEl = document.getElementById('edit-quest-title');
        const primaryEl = document.getElementById('edit-primary-stat');
        const secondaryEl = document.getElementById('edit-secondary-stat');
        const categoryEl = document.getElementById('edit-category');
        if (titleEl) state.modal.draftTask.quest_title = titleEl.value;
        if (primaryEl) state.modal.draftTask.primary_stat = primaryEl.value;
        if (secondaryEl) state.modal.draftTask.secondary_stat = secondaryEl.value || null;
        if (categoryEl) state.modal.draftTask.category = categoryEl.value;

        state.modal.draftTask.is_restorative = !state.modal.draftTask.is_restorative;
        render();
      }
      break;
    }

    case 'retry-triage-in-modal':
      if (state.modal?.type === 'task_override') {
        await handleRetryTaskTriage(state.modal.draftTask.id, true);
      }
      break;

    case 'save-task-override':
      await handleSaveTaskOverride();
      break;

    case 'delete-task':
      await db.delete('tasks', id);
      state.modal = null;
      await reloadSnapshot();
      render();
      showToast('Quest deleted.');
      break;

    case 'open-interaction-modal':
      state.modal = {
        type: 'interaction',
        draft: { entryType: 'Interaction', sentiment: 'Good', rawText: '' }
      };
      render();
      break;

    case 'set-entry-type':
      if (state.modal?.type === 'interaction') {
        const ta = document.getElementById('interaction-notes-input');
        if (ta) state.modal.draft.rawText = ta.value;
        state.modal.draft.entryType = btn.getAttribute('data-value');
        render();
      }
      break;

    case 'set-sentiment':
      if (state.modal?.type === 'interaction') {
        const ta = document.getElementById('interaction-notes-input');
        if (ta) state.modal.draft.rawText = ta.value;
        state.modal.draft.sentiment = btn.getAttribute('data-value');
        render();
      }
      break;

    case 'submit-interaction':
      await handleSubmitInteraction();
      break;

    case 'open-start-day': {
      const turnDate = state.snapshot.profile.current_turn_date;
      const carryoverTasks = state.snapshot.tasks.filter(
        (t) =>
          (t.status === 'active' || t.status === 'pending_triage') &&
          t.assigned_turn_date &&
          t.assigned_turn_date < turnDate
      );
      state.modal = {
        type: 'start_day',
        turnDate,
        isMondayReset: false,
        carryoverTasks,
        draft: { sleepQuality: 'Okay', sleepNote: '' }
      };
      render();
      break;
    }

    case 'set-sleep':
      if (state.modal?.type === 'start_day') {
        const inp = document.getElementById('sleep-note-input');
        if (inp) state.modal.draft.sleepNote = inp.value;
        state.modal.draft.sleepQuality = btn.getAttribute('data-value');
        render();
      }
      break;

    case 'confirm-start-day':
      await handleConfirmStartDay();
      break;

    case 'recover-missed-day':
      if (state.modal?.type === 'missed_end_day') {
        await openDailyReportFlow(state.modal.missedTurnDate, { isMissedRecovery: true });
      }
      break;

    case 'open-end-day-confirm':
      state.modal = { type: 'end_day_confirm', now: new Date() };
      render();
      break;

    case 'proceed-end-day':
      await openDailyReportFlow(state.snapshot.profile.current_turn_date);
      break;

    case 'save-and-sleep':
      await handleSaveAndSleep();
      break;

    case 'open-weekly-report': {
      const { weekStart, weekEnd } = getWeekBounds(state.snapshot.profile.current_turn_date);
      await openWeeklyReportFlow(weekStart, weekEnd, { canDismiss: true, saveToDb: false });
      break;
    }

    case 'view-saved-weekly': {
      const ws = btn.getAttribute('data-week');
      if (ws) {
        const { weekStart, weekEnd } = getWeekBounds(ws);
        await openWeeklyReportFlow(weekStart, weekEnd, { canDismiss: true, saveToDb: false });
      }
      break;
    }

    case 'close-weekly-report': {
      const wasBlocking = state.modal?.type === 'weekly_report' && !state.modal.canDismiss;
      state.modal = null;
      if (wasBlocking) {
        await syncLifecycleModal();
      } else {
        render();
      }
      break;
    }

    case 'open-settings': {
      const p = state.snapshot.profile;
      state.apiTestStatus = '';
      state.modal = {
        type: 'settings',
        draft: {
          character_name: p.character_name || 'Adventurer',
          gemini_api_key: p.gemini_api_key || '',
          gemini_model: resolveGeminiModel(p.gemini_model)
        }
      };
      render();
      break;
    }

    case 'toggle-show-api-key': {
      if (state.modal?.type === 'settings') {
        const nameEl = document.getElementById('settings-char-name');
        const keyEl = document.getElementById('settings-api-key');
        const modelEl = document.getElementById('settings-gemini-model');
        state.modal.draft = {
          character_name: nameEl ? nameEl.value : state.modal.draft?.character_name,
          gemini_api_key: keyEl ? keyEl.value : state.modal.draft?.gemini_api_key,
          gemini_model: modelEl ? modelEl.value : state.modal.draft?.gemini_model
        };
      }
      state.showApiKey = !state.showApiKey;
      render();
      break;
    }

    case 'save-settings': {
      const nameEl = document.getElementById('settings-char-name');
      const keyEl = document.getElementById('settings-api-key');
      const modelEl = document.getElementById('settings-gemini-model');
      const profile = await db.get('character_profile', 'main');
      const nextName = (nameEl?.value || '').trim() || 'Adventurer';
      const nextKey = (keyEl?.value || '').trim();
      const nextModel = resolveGeminiModel(modelEl?.value || state.modal?.draft?.gemini_model || DEFAULT_GEMINI_MODEL);
      await db.put('character_profile', {
        ...profile,
        character_name: nextName,
        gemini_api_key: nextKey,
        gemini_model: nextModel
      });
      if (state.modal?.type === 'settings') {
        state.modal.draft = {
          character_name: nextName,
          gemini_api_key: nextKey,
          gemini_model: nextModel
        };
      }
      await reloadSnapshot();
      render();
      showToast(`Settings saved locally (${nextModel}).`, 'success');
      break;
    }

    case 'test-gemini-key': {
      const nameEl = document.getElementById('settings-char-name');
      const keyEl = document.getElementById('settings-api-key');
      const modelEl = document.getElementById('settings-gemini-model');
      const key = (keyEl?.value || '').trim();
      const model = resolveGeminiModel(modelEl?.value || state.modal?.draft?.gemini_model || DEFAULT_GEMINI_MODEL);
      if (state.modal?.type === 'settings') {
        state.modal.draft = {
          character_name: nameEl ? nameEl.value : state.modal.draft?.character_name,
          gemini_api_key: keyEl ? keyEl.value : state.modal.draft?.gemini_api_key,
          gemini_model: model
        };
      }
      state.apiTestStatus = `Testing ${model} connection…`;
      render();
      try {
        const reply = await testGeminiApiKey(key, model);
        state.apiTestStatus = `✓ Connected (${model}): ${reply}`;
      } catch (err) {
        state.apiTestStatus = `✕ Failed (${model}): ${err.message}`;
      }
      render();
      break;
    }

    case 'toggle-vacation-mode': {
      const profile = await db.get('character_profile', 'main');
      const nextVacation = !profile.vacation_mode;
      await db.put('character_profile', { ...profile, vacation_mode: nextVacation });
      const turn = await db.get('daily_turns', profile.current_turn_date);
      if (turn) {
        await db.put('daily_turns', { ...turn, is_vacation: nextVacation });
      }
      await reloadSnapshot();
      render();
      showToast(
        nextVacation
          ? 'Vacation / Long Rest ON: streaks paused & days excluded from weekly averages.'
          : 'Vacation / Long Rest OFF: back in active campaign.'
      );
      break;
    }

    case 'add-routine': {
      const titleEl = document.getElementById('new-routine-title');
      const statEl = document.getElementById('new-routine-stat');
      const title = (titleEl?.value || '').trim();
      if (!title) {
        showToast('Enter a routine title first.', 'error');
        return;
      }
      await db.put('routines', {
        id: createId('rtn'),
        title,
        target_stat: statEl?.value || 'DSC',
        base_xp: TIER_XP.Routine,
        streak_count: 0,
        best_streak: 0,
        last_completed_turn_date: null,
        paused: false,
        created_at: new Date().toISOString()
      });
      await reloadSnapshot();
      render();
      showToast(`Routine "${title}" added.`, 'success');
      break;
    }

    case 'toggle-pause-routine': {
      const routine = await db.get('routines', id);
      if (routine) {
        await db.put('routines', { ...routine, paused: !routine.paused });
        await reloadSnapshot();
        render();
      }
      break;
    }

    case 'delete-routine':
      await db.delete('routines', id);
      await reloadSnapshot();
      render();
      showToast('Routine removed.');
      break;

    case 'export-save-point':
    case 'quick-export-save': {
      const { filename } = await downloadSavePointFile(db);
      await reloadSnapshot();
      render();
      showToast(`Exported ${filename}`, 'success');
      break;
    }

    case 'close-modal':
      state.modal = null;
      render();
      break;
  }
});

/* ================= SERVICE WORKER & BOOT ================= */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}

(async function boot() {
  try {
    await db.open();
    await syncLifecycleModal();
  } catch (err) {
    appEl.innerHTML = `
      <div class="boot-screen">
        <div class="boot-emblem">ERR</div>
        <div class="boot-text">STORAGE INIT FAILED: ${err.message}</div>
      </div>
    `;
  }
})();

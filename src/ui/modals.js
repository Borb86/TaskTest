/**
 * Modals & Bottom Sheets:
 * - Start Day Sleep Check-in (+ Carryover Tasks + Monday 75 HP Reset)
 * - Missed End Day Recovery
 * - End Day Confirmation (exact clock time)
 * - End-of-Day Daily Report ("Long Rest" with 6-stat radar, animated XP bars, Social HP breakdown, Gemini summary, Save & Sleep)
 * - Weekly Report (Ending HP, Net Tone, Volume, Sleep Distribution, 4-Week & All-Time Benchmarks, Gemini reflection)
 * - Interaction / Narrative Journal Logger
 * - Task Manual Tag Override Sheet
 * - Settings & Save Points (API Key, Routines Manager, Vacation/Long Rest Toggle, JSON Export/Import)
 */

import {
  STAT_CODES,
  STAT_META,
  DIFFICULTY_TIERS,
  TASK_CATEGORIES,
  TIER_XP,
  MONDAY_RESET_HP,
  computeStatLevelProgress,
  clampSocialHp
} from '../core/rpgMath.js';
import {
  formatShortDate,
  formatClockTime,
  getToneLabel,
  needsBackupReminder,
  getDaysSinceBackup
} from '../core/turnLogic.js';
import { AVAILABLE_GEMINI_MODELS, resolveGeminiModel } from '../services/geminiApi.js';
import { renderStatRadarSvg } from './radarChart.js';
import { escapeHtml } from './components.js';

export function renderMissedEndDayModal({ missedTurnDate, todayStr }) {
  return `
    <div class="modal-backdrop modal-backdrop--center">
      <div class="modal-sheet">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Unclosed Previous Turn</h2>
            <p class="modal-subtitle">Turn ${escapeHtml(formatShortDate(missedTurnDate))} wasn't closed before ${escapeHtml(formatShortDate(todayStr))}.</p>
          </div>
        </div>

        <div class="banner banner--amber">
          <span>Review and close yesterday's Daily Report first so your XP, HP, and streaks stay accurate before today's Start Day check-in.</span>
        </div>

        <button class="btn-primary" data-action="recover-missed-day">
          Close ${escapeHtml(formatShortDate(missedTurnDate))} & View Daily Report
        </button>
      </div>
    </div>
  `;
}

export function renderStartDayModal({ turnDate, isMondayReset, carryoverTasks, draft, isVacation }) {
  const sleep = draft.sleepQuality || 'Okay';

  return `
    <div class="modal-backdrop modal-backdrop--center">
      <div class="modal-sheet">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Start Day — ${escapeHtml(formatShortDate(turnDate))}</h2>
            <p class="modal-subtitle">Morning check-in to calibrate today's Social HP.</p>
          </div>
        </div>

        ${
          isMondayReset
            ? `<div class="banner banner--amber">
                <span><strong>New Week Reset:</strong> Social HP resets to <strong>${MONDAY_RESET_HP}/100</strong> before today's sleep modifier applies.</span>
              </div>`
            : ''
        }

        ${
          isVacation
            ? `<div class="banner banner--info">
                <span><strong>Vacation / Long Rest Active:</strong> Routine streaks are paused and today will be excluded from Weekly Report rolling averages.</span>
              </div>`
            : ''
        }

        <div class="field">
          <label class="field__label">How did you sleep?</label>
          <div class="choice-grid-3">
            <button type="button" class="choice-btn choice-btn--good ${sleep === 'Good' ? 'choice-btn--active' : ''}" data-action="set-sleep" data-value="Good">
              <span>Good</span>
              <span class="choice-btn__sub">+5 HP</span>
            </button>
            <button type="button" class="choice-btn ${sleep === 'Okay' ? 'choice-btn--active' : ''}" data-action="set-sleep" data-value="Okay">
              <span>Okay</span>
              <span class="choice-btn__sub">0 HP</span>
            </button>
            <button type="button" class="choice-btn choice-btn--bad ${sleep === 'Poor' ? 'choice-btn--active' : ''}" data-action="set-sleep" data-value="Poor">
              <span>Poor</span>
              <span class="choice-btn__sub">-5 HP</span>
            </button>
          </div>
        </div>

        <div class="field">
          <label class="field__label" for="sleep-note-input">Any reason why? (Optional)</label>
          <input
            id="sleep-note-input"
            class="field__input"
            type="text"
            placeholder="Late screen time, great workout, woke up early…"
            value="${escapeHtml(draft.sleepNote || '')}"
          />
          <span class="field__hint">Saved with today's turn for Weekly Report pattern analysis.</span>
        </div>

        ${
          carryoverTasks.length > 0
            ? `<div class="field">
                <label class="field__label">Carried Over Unfinished Tasks (${carryoverTasks.length})</label>
                <div style="display:flex; flex-direction:column; gap:6px; max-height:150px; overflow-y:auto;">
                  ${carryoverTasks
                    .map(
                      (t) => `
                    <div style="padding:7px 10px; border-radius:8px; background:#0b0d13; border:1px solid var(--border-subtle); display:flex; justify-content:space-between; gap:8px; font-size:12.5px;">
                      <span>${escapeHtml(t.quest_title || t.raw_text)}</span>
                      <span class="tier-badge tier-badge--${escapeHtml(t.difficulty_tier)}">${escapeHtml(t.difficulty_tier)}</span>
                    </div>
                  `
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }

        <button class="btn-primary" data-action="confirm-start-day">
          Begin Turn
        </button>
      </div>
    </div>
  `;
}

export function renderEndDayConfirmModal({ turnDate, now = new Date() }) {
  const clockStr = formatClockTime(now);
  return `
    <div class="modal-backdrop modal-backdrop--center">
      <div class="modal-sheet">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">End Day at ${escapeHtml(clockStr)}?</h2>
            <p class="modal-subtitle">Closing logical turn ${escapeHtml(formatShortDate(turnDate))}.</p>
          </div>
          <button class="modal-close" data-action="close-modal" aria-label="Close">✕</button>
        </div>

        <p style="margin:0; font-size:13.5px; color:var(--text-secondary);">
          Once confirmed, your End-of-Day Daily Report will generate and any tasks or interactions logged afterward will automatically apply to the <strong>following logical turn date</strong>.
        </p>

        <div class="btn-row">
          <button class="btn-secondary" data-action="close-modal">Keep Going</button>
          <button class="btn-primary" data-action="proceed-end-day">End Day Now</button>
        </div>
      </div>
    </div>
  `;
}

export function renderDailyReportModal({ report, stats, isGeneratingSummary }) {
  const statMap = new Map(stats.map((s) => [s.stat_code, s]));
  const gains = report.stat_xp_gained || {};
  const toneLabel = getToneLabel(report.week_tone_score || 0);
  const endHp = clampSocialHp(report.ending_hp);
  const restGain = report.restorative_hp_gained || 0;
  const intDelta = report.interaction_hp_delta || 0;
  const sleepDelta = report.sleep_hp_delta || 0;

  // Build 5 heart pips representing ending HP visually (matching PDF page 10)
  const filledPips = Math.round(endHp / 20);
  const pipsHtml = Array.from({ length: 5 }, (_, idx) =>
    `<span style="color:${idx < filledPips ? (endHp <= 40 ? 'var(--red)' : 'var(--amber-bright)') : '#2b2f3c'}; font-size:13px;">♥</span>`
  ).join('');

  return `
    <div class="modal-backdrop">
      <div class="modal-sheet modal-sheet--fullscreen">
        <div class="long-rest-top">
          <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${escapeHtml(formatShortDate(report.turn_date))}</span>
          <span class="long-rest-pill">🌙 Long Rest</span>
          <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-secondary);">+${report.total_xp_earned || 0} XP</span>
        </div>

        <div>
          <h2 class="modal-title" style="font-size:21px;">Day Complete — Daily Report</h2>
          <p class="modal-subtitle">
            ${report.tasks_completed} quest${report.tasks_completed === 1 ? '' : 's'} & ${report.routines_completed} routine${report.routines_completed === 1 ? '' : 's'} cleared
            ${report.is_vacation ? ' • Vacation Mode' : ''}
          </p>
        </div>

        <section class="tactical-frame panel-card">
          <div class="panel-title">
            <span>Character Stats & Growth</span>
          </div>

          <div class="report-grid">
            <div class="radar-wrap">
              ${renderStatRadarSvg(stats, { size: 172, dailyGains: gains })}
            </div>

            <div class="stat-grid" style="gap:8px;">
              ${STAT_CODES.map((code) => {
                const row = statMap.get(code) || { total_xp: 0, current_level: 1 };
                const prog = computeStatLevelProgress(row.total_xp);
                const gained = gains[code] || 0;
                const leveledUp = (report.level_ups || []).some((lu) => lu.stat_code === code);
                const pct = Math.max(gained > 0 ? 12 : 4, Math.round(prog.progressRatio * 100));
                return `
                  <div class="stat-row" style="gap:3px;">
                    <div class="stat-row__top" style="font-size:12px;">
                      <span style="font-family:var(--font-mono); font-weight:800; color:${gained > 0 ? '#ffffff' : 'var(--text-secondary)'};">
                        ${code} <span style="color:var(--text-muted); font-weight:600;">Lv${prog.level}</span>
                        ${leveledUp ? '<span class="level-up-pill">UP!</span>' : ''}
                      </span>
                      ${gained > 0 ? `<span class="xp-gain-badge">+${gained} XP</span>` : '<span style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted);">+0</span>'}
                    </div>
                    <div class="xp-bar" style="height:6px;">
                      <div class="xp-bar__fill report-xp-bar" data-target-width="${pct}%" style="width: 0%"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </section>

        <section class="tactical-frame panel-card">
          <div class="panel-title">
            <span>Social HP & Tone</span>
            <span style="font-family:var(--font-mono); font-size:13px; color:${endHp <= 40 ? 'var(--red)' : 'var(--amber-bright)'};">${endHp}/100 HP</span>
          </div>

          <div class="hp-breakdown-row">
            <div class="hp-metric">
              <div class="hp-metric__val ${restGain > 0 ? 'hp-metric__val--pos' : ''}">+${restGain}</div>
              <div class="hp-metric__lbl">Restorative</div>
            </div>
            <div class="hp-metric">
              <div class="hp-metric__val ${intDelta > 0 ? 'hp-metric__val--pos' : intDelta < 0 ? 'hp-metric__val--neg' : ''}">${intDelta >= 0 ? `+${intDelta}` : intDelta}</div>
              <div class="hp-metric__lbl">Interactions</div>
            </div>
            <div class="hp-metric">
              <div class="hp-metric__val ${sleepDelta > 0 ? 'hp-metric__val--pos' : sleepDelta < 0 ? 'hp-metric__val--neg' : 'hp-metric__val--amber'}">${sleepDelta >= 0 ? `+${sleepDelta}` : sleepDelta}</div>
              <div class="hp-metric__lbl">Sleep (${escapeHtml(report.sleep_quality || 'Okay')})</div>
            </div>
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <span class="tone-pill">Weekly Tone: ${escapeHtml(toneLabel)}</span>
            <div style="display:flex; align-items:center; gap:3px;" aria-label="HP Gauge">${pipsHtml}</div>
          </div>
        </section>

        <section class="tactical-frame panel-card" style="gap:7px;">
          <div class="panel-title" style="font-size:13px;">
            <span>Dungeon Master Debrief</span>
          </div>
          <p style="margin:0; font-size:13.5px; color:#ffe3b0; line-height:1.45;">
            ${isGeneratingSummary ? 'Drafting campfire debrief…' : escapeHtml(report.gemini_daily_summary || '')}
          </p>
        </section>

        <button class="btn-primary btn-primary--pill" data-action="save-and-sleep" ${isGeneratingSummary ? 'disabled' : ''}>
          🌙 Save & Sleep
        </button>
      </div>
    </div>
  `;
}

export function renderWeeklyReportModal({ report, isGenerating, canDismiss = true }) {
  const sleep = report.sleep_summary || JSON.parse(report.sleep_summary_json || '{"Good":0,"Okay":0,"Poor":0}');
  const totalSleep = Math.max(1, (sleep.Good || 0) + (sleep.Okay || 0) + (sleep.Poor || 0));
  const bench = report.benchmarks || { priorWeeksCount: 0, hasFourWeekBaseline: false, rolling4Week: null, allTime: null };
  const toneLabel = getToneLabel(report.net_tone_score || 0);
  const netDeltaStr = report.net_hp_delta >= 0 ? `+${report.net_hp_delta}` : `${report.net_hp_delta}`;
  const toneStr = report.net_tone_score >= 0 ? `+${report.net_tone_score}` : `${report.net_tone_score}`;

  const fmtCompare = (val, rolling, allTime, prefix = '') => {
    const parts = [];
    if (rolling !== null && rolling !== undefined) parts.push(`4w: ${prefix}${rolling}`);
    if (allTime !== null && allTime !== undefined) parts.push(`All: ${prefix}${allTime}`);
    return parts.length ? parts.join(' • ') : 'Building baseline…';
  };

  return `
    <div class="modal-backdrop">
      <div class="modal-sheet modal-sheet--fullscreen">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Weekly Alignment Report</h2>
            <p class="modal-subtitle">
              ${escapeHtml(formatShortDate(report.week_start_date))} – ${escapeHtml(formatShortDate(report.week_end_date))}
              ${report.vacation_days ? ` • ${report.vacation_days}d Vacation excluded` : ''}
            </p>
          </div>
          ${canDismiss ? '<button class="modal-close" data-action="close-modal" aria-label="Close">✕</button>' : ''}
        </div>

        <div class="bench-grid">
          <div class="bench-card">
            <div class="bench-card__title">Ending Social HP</div>
            <div class="bench-card__main" style="color:${report.ending_hp <= 40 ? 'var(--red)' : 'var(--amber-bright)'};">
              ${report.ending_hp}/100 <span style="font-size:12px; color:var(--text-secondary);">(${netDeltaStr})</span>
            </div>
            <div class="bench-card__sub">${fmtCompare(report.ending_hp, bench.rolling4Week?.ending_hp, bench.allTime?.ending_hp)}</div>
          </div>

          <div class="bench-card">
            <div class="bench-card__title">Net Tone Score</div>
            <div class="bench-card__main">${toneStr} <span style="font-size:12px; color:var(--amber-bright);">${toneLabel}</span></div>
            <div class="bench-card__sub">${fmtCompare(report.net_tone_score, bench.rolling4Week?.net_tone_score, bench.allTime?.net_tone_score)}</div>
          </div>

          <div class="bench-card">
            <div class="bench-card__title">Interaction Volume</div>
            <div class="bench-card__main">${report.interaction_volume}</div>
            <div class="bench-card__sub">${fmtCompare(report.interaction_volume, bench.rolling4Week?.interaction_volume, bench.allTime?.interaction_volume)}</div>
          </div>

          <div class="bench-card">
            <div class="bench-card__title">Active Days / XP</div>
            <div class="bench-card__main">${report.active_days || 0}d <span style="font-size:12px; color:var(--amber);">+${report.total_xp_earned || 0}</span></div>
            <div class="bench-card__sub">
              ${bench.hasFourWeekBaseline ? `Benchmarked vs ${bench.priorWeeksCount}w history` : `${bench.priorWeeksCount}/4 weeks for 4w rolling avg`}
            </div>
          </div>
        </div>

        <section class="tactical-frame panel-card" style="gap:9px;">
          <div class="panel-title" style="font-size:13.5px;">
            <span>Sleep Distribution</span>
            <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">
              G:${sleep.Good || 0} / O:${sleep.Okay || 0} / P:${sleep.Poor || 0}
            </span>
          </div>
          <div style="display:flex; height:10px; border-radius:999px; overflow:hidden; background:#181b24;">
            <div style="width:${((sleep.Good || 0) / totalSleep) * 100}%; background:var(--green);"></div>
            <div style="width:${((sleep.Okay || 0) / totalSleep) * 100}%; background:var(--amber);"></div>
            <div style="width:${((sleep.Poor || 0) / totalSleep) * 100}%; background:var(--red);"></div>
          </div>
        </section>

        <section class="tactical-frame panel-card" style="gap:7px;">
          <div class="panel-title" style="font-size:13.5px;">
            <span>Gemini Weekly Reflection</span>
          </div>
          <p style="margin:0; font-size:13.5px; color:#ffe3b0; line-height:1.45;">
            ${isGenerating ? 'Analyzing weekly patterns…' : escapeHtml(report.gemini_weekly_reflection || '')}
          </p>
        </section>

        <button class="btn-primary" data-action="close-weekly-report" ${isGenerating ? 'disabled' : ''}>
          ${canDismiss ? 'Done' : 'Acknowledge & Continue to New Week'}
        </button>
      </div>
    </div>
  `;
}

export function renderInteractionModal({ draft, isSubmitting }) {
  const mode = draft.entryType || 'Interaction';
  const sentiment = draft.sentiment || 'Good';

  return `
    <div class="modal-backdrop">
      <div class="modal-sheet">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Log Interaction / Journal</h2>
            <p class="modal-subtitle">Gemini DM awards Stat XP independently from Social HP bandwidth.</p>
          </div>
          <button class="modal-close" data-action="close-modal" aria-label="Close">✕</button>
        </div>

        <div class="choice-grid-2">
          <button type="button" class="choice-btn ${mode === 'Interaction' ? 'choice-btn--active' : ''}" data-action="set-entry-type" data-value="Interaction">
            <span>Quick Interaction</span>
            <span class="choice-btn__sub">Notes + Sentiment</span>
          </button>
          <button type="button" class="choice-btn ${mode === 'Journal' ? 'choice-btn--active' : ''}" data-action="set-entry-type" data-value="Journal">
            <span>Narrative Journal</span>
            <span class="choice-btn__sub">Freeform DM Eval</span>
          </button>
        </div>

        ${
          mode === 'Interaction'
            ? `<div class="field">
                <label class="field__label">Emotional Sentiment</label>
                <div class="choice-grid-3">
                  <button type="button" class="choice-btn choice-btn--good ${sentiment === 'Good' ? 'choice-btn--active' : ''}" data-action="set-sentiment" data-value="Good">
                    <span>Good</span>
                    <span class="choice-btn__sub">+10 HP</span>
                  </button>
                  <button type="button" class="choice-btn ${sentiment === 'Neutral' ? 'choice-btn--active' : ''}" data-action="set-sentiment" data-value="Neutral">
                    <span>Neutral</span>
                    <span class="choice-btn__sub">0 HP</span>
                  </button>
                  <button type="button" class="choice-btn choice-btn--bad ${sentiment === 'Bad' ? 'choice-btn--active' : ''}" data-action="set-sentiment" data-value="Bad">
                    <span>Bad</span>
                    <span class="choice-btn__sub">-5 HP</span>
                  </button>
                </div>
              </div>`
            : `<div class="field__hint">Write a freeform paragraph. Gemini DM will assign Stat XP, Social HP (+10 / 0 / -5 / -8 heavy drain), and an optional temporary status tag.</div>`
        }

        <div class="field">
          <label class="field__label" for="interaction-notes-input">
            ${mode === 'Journal' ? 'Narrative Entry' : 'Interaction Notes & Key Outcome'}
          </label>
          <textarea
            id="interaction-notes-input"
            class="field__textarea"
            placeholder="${mode === 'Journal' ? 'Describe what happened, how you handled it, and how it left you feeling…' : 'e.g., Navigated a tense project review calmly and aligned on next steps…'}"
          >${escapeHtml(draft.rawText || '')}</textarea>
        </div>

        <button class="btn-primary" data-action="submit-interaction" ${isSubmitting ? 'disabled' : ''}>
          ${isSubmitting ? 'Evaluating with Gemini DM…' : 'Log & Evaluate'}
        </button>
      </div>
    </div>
  `;
}

export function renderTaskOverrideModal({ task, isTriaging }) {
  return `
    <div class="modal-backdrop">
      <div class="modal-sheet">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Edit / Override Quest</h2>
            <p class="modal-subtitle">Adjust AI tags, difficulty tier, stats, or restorative flag.</p>
          </div>
          <button class="modal-close" data-action="close-modal" aria-label="Close">✕</button>
        </div>

        <div class="field">
          <label class="field__label" for="edit-quest-title">Quest Title</label>
          <input id="edit-quest-title" class="field__input" type="text" value="${escapeHtml(task.quest_title || task.raw_text)}" />
        </div>

        <div class="field">
          <label class="field__label">Difficulty Tier</label>
          <div class="choice-grid-4">
            ${DIFFICULTY_TIERS.map(
              (tier) => `
              <button type="button" class="choice-btn ${task.difficulty_tier === tier ? 'choice-btn--active' : ''}" data-action="override-field" data-field="difficulty_tier" data-value="${tier}">
                <span style="font-size:12px;">${tier}</span>
                <span class="choice-btn__sub">${TIER_XP[tier]} XP</span>
              </button>
            `
            ).join('')}
          </div>
        </div>

        <div class="choice-grid-2">
          <div class="field">
            <label class="field__label" for="edit-primary-stat">Primary Stat (70%)</label>
            <select id="edit-primary-stat" class="field__select">
              ${STAT_CODES.map(
                (c) => `<option value="${c}" ${task.primary_stat === c ? 'selected' : ''}>${c} — ${STAT_META[c].name}</option>`
              ).join('')}
            </select>
          </div>

          <div class="field">
            <label class="field__label" for="edit-secondary-stat">Secondary Stat (30%)</label>
            <select id="edit-secondary-stat" class="field__select">
              <option value="" ${!task.secondary_stat ? 'selected' : ''}>None (100% Primary)</option>
              ${STAT_CODES.map(
                (c) => `<option value="${c}" ${task.secondary_stat === c ? 'selected' : ''}>${c} — ${STAT_META[c].name}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="field">
          <label class="field__label" for="edit-category">Category</label>
          <select id="edit-category" class="field__select">
            ${TASK_CATEGORIES.map(
              (cat) => `<option value="${cat}" ${task.category === cat ? 'selected' : ''}>${cat}</option>`
            ).join('')}
          </select>
        </div>

        <div class="toggle-row">
          <div>
            <div style="font-size:13.5px; font-weight:700;">Restorative Task (+10 Social HP)</div>
            <div style="font-size:11.5px; color:var(--text-muted);">Heals +10 HP & clears temporary drain status on completion.</div>
          </div>
          <button
            type="button"
            class="switch ${task.is_restorative ? 'switch--on' : ''}"
            data-action="override-toggle-restorative"
            aria-pressed="${Boolean(task.is_restorative)}"
          ></button>
        </div>

        <div class="btn-row">
          <button type="button" class="btn-secondary" data-action="retry-triage-in-modal" ${isTriaging ? 'disabled' : ''}>
            ${isTriaging ? 'Triaging…' : '↻ Retry AI'}
          </button>
          <button type="button" class="btn-danger" data-action="delete-task" data-id="${escapeHtml(task.id)}">
            Delete
          </button>
        </div>

        <button type="button" class="btn-primary" data-action="save-task-override">
          Save Changes
        </button>
      </div>
    </div>
  `;
}

export function renderSettingsModal({ profile, routines, showApiKey, apiTestStatus, draft = null }) {
  const backupDue = needsBackupReminder(profile);
  const daysSince = getDaysSinceBackup(profile);
  const charName = draft?.character_name ?? profile.character_name ?? 'Adventurer';
  const apiKey = draft?.gemini_api_key ?? profile.gemini_api_key ?? '';
  const selectedModel = resolveGeminiModel(draft?.gemini_model ?? profile.gemini_model);
  const modelLabels = {
    'gemini-3.8-flash': 'gemini-3.8-flash (Default)',
    'gemini-3.8-flash-lite': 'gemini-3.8-flash-lite (Lightweight)',
    'gemini-3.8-pro': 'gemini-3.8-pro'
  };

  return `
    <div class="modal-backdrop">
      <div class="modal-sheet modal-sheet--fullscreen">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Settings & Save Points</h2>
            <p class="modal-subtitle">100% local IndexedDB storage • Direct Gemini API</p>
          </div>
          <button class="modal-close" data-action="close-modal" aria-label="Close">✕</button>
        </div>

        <!-- Character & Gemini API -->
        <section class="tactical-frame panel-card">
          <div class="panel-title" style="font-size:14px;">Character & Gemini API</div>

          <div class="field">
            <label class="field__label" for="settings-char-name">Character Name</label>
            <input id="settings-char-name" class="field__input" type="text" value="${escapeHtml(charName)}" />
          </div>

          <div class="field">
            <label class="field__label" for="settings-api-key">Gemini API Key (Stored Locally Only)</label>
            <div style="display:flex; gap:6px;">
              <input
                id="settings-api-key"
                class="field__input"
                type="${showApiKey ? 'text' : 'password'}"
                autocomplete="off"
                placeholder="AIza…"
                value="${escapeHtml(apiKey)}"
              />
              <button type="button" class="btn-secondary" style="width:auto; padding:0 12px;" data-action="toggle-show-api-key">
                ${showApiKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <span class="field__hint">Never sent anywhere except generativelanguage.googleapis.com.</span>
          </div>

          <div class="field">
            <label class="field__label" for="settings-gemini-model">Gemini Model</label>
            <select id="settings-gemini-model" class="field__select">
              ${AVAILABLE_GEMINI_MODELS.map(
                (m) => `<option value="${m}" ${selectedModel === m ? 'selected' : ''}>${modelLabels[m] || m}</option>`
              ).join('')}
            </select>
          </div>

          <div class="btn-row">
            <button type="button" class="btn-secondary" data-action="test-gemini-key">Test API Key</button>
            <button type="button" class="btn-primary" data-action="save-settings">Save Config</button>
          </div>
          ${apiTestStatus ? `<div class="field__hint" style="color:var(--amber-bright);">${escapeHtml(apiTestStatus)}</div>` : ''}
        </section>

        <!-- Vacation / Long Rest Toggle -->
        <section class="tactical-frame panel-card">
          <div class="toggle-row" style="border:none; padding:0; background:none;">
            <div>
              <div style="font-size:14px; font-weight:800;">Vacation / Long Rest Mode</div>
              <div style="font-size:12px; color:var(--text-secondary);">Pauses routine streaks and excludes inactive days from Weekly Report rolling averages.</div>
            </div>
            <button
              type="button"
              class="switch ${profile.vacation_mode ? 'switch--on' : ''}"
              data-action="toggle-vacation-mode"
              aria-pressed="${Boolean(profile.vacation_mode)}"
            ></button>
          </div>
        </section>

        <!-- Daily Routines Manager -->
        <section class="tactical-frame panel-card">
          <div class="panel-title" style="font-size:14px;">
            <span>Daily Routines Manager</span>
            <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">10 XP • NO AI</span>
          </div>

          <div style="display:flex; flex-direction:column; gap:7px;">
            ${
              routines.length === 0
                ? '<div class="field__hint">No routines yet. Add one below.</div>'
                : routines
                    .map(
                      (r) => `
                  <div class="routine-item" style="${r.paused ? 'opacity:0.55;' : ''}">
                    <div class="routine-item__body">
                      <div class="routine-item__title">${escapeHtml(r.title)} ${r.paused ? '(Paused)' : ''}</div>
                      <div class="routine-item__meta">
                        <span>${escapeHtml(r.target_stat || 'DSC')} +${r.base_xp || 10} XP</span>
                        <span class="streak-badge">🔥 ${r.streak_count || 0}d (best ${r.best_streak || 0}d)</span>
                      </div>
                    </div>
                    <button type="button" class="retry-btn" style="padding:4px 8px;" data-action="toggle-pause-routine" data-id="${escapeHtml(r.id)}">
                      ${r.paused ? 'Resume' : 'Pause'}
                    </button>
                    <button type="button" class="btn-danger" style="min-height:28px; padding:4px 8px; font-size:11.5px;" data-action="delete-routine" data-id="${escapeHtml(r.id)}">
                      ✕
                    </button>
                  </div>
                `
                    )
                    .join('')
            }
          </div>

          <div style="display:grid; grid-template-columns:1fr 84px auto; gap:6px; margin-top:4px;">
            <input id="new-routine-title" class="field__input" style="padding:8px 10px; font-size:13px;" type="text" placeholder="e.g., Morning stretch" />
            <select id="new-routine-stat" class="field__select" style="padding:8px 6px; font-size:12.5px;">
              ${STAT_CODES.map((c) => `<option value="${c}" ${c === 'DSC' ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
            <button type="button" class="quick-add-submit" style="height:38px;" data-action="add-routine">+ Add</button>
          </div>
        </section>

        <!-- Save Points (Backup / Restore) -->
        <section class="tactical-frame ${backupDue ? 'tactical-frame--amber' : ''} panel-card">
          <div class="panel-title" style="font-size:14px;">
            <span>Save Points (All 7 Stores)</span>
          </div>

          <div class="field__hint" style="color:${backupDue ? 'var(--amber-bright)' : 'var(--text-secondary)'};">
            ${
              daysSince === null
                ? 'No Save Point exported yet. Export a JSON snapshot regularly to protect browser storage.'
                : daysSince >= 7
                  ? `⚠ Last Save Point exported ${daysSince} days ago. Time for a fresh backup!`
                  : `Last Save Point exported ${daysSince === 0 ? 'today' : `${daysSince} day${daysSince === 1 ? '' : 's'} ago`}.`
            }
          </div>

          <div class="btn-row">
            <button type="button" class="btn-primary" data-action="export-save-point">
              ⬇ Export Save Point
            </button>
            <label class="btn-secondary" style="cursor:pointer;">
              ⬆ Import JSON
              <input id="import-save-input" type="file" accept="application/json,.json" style="display:none;" />
            </label>
          </div>
        </section>
      </div>
    </div>
  `;
}

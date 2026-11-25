/**
 * Tactical RPG OLED UI View Renderers
 * - Top HUD (Overall Level, Social/Weekly HP bar with <= 40 warning state, quick icons)
 * - Quests Daytime View (Collapsible Daily Routines + Active Tasks + Completed Today)
 * - Character Sheet View (6-Stat Radar Chart + Individual Stat Levels + Overall Level)
 * - Log View (Interactions/Journal + Daily Turns + Weekly Reports archive)
 * - Bottom Thumb Zone (+ Add Task, + Interaction / Journal, END DAY)
 */

import {
  STAT_CODES,
  STAT_META,
  getXpForTier,
  splitStatXp,
  computeStatLevelProgress,
  computeOverallLevelProgress,
  isLowHpWarning,
  clampSocialHp
} from '../core/rpgMath.js';
import {
  formatShortDate,
  needsBackupReminder,
  getToneLabel
} from '../core/turnLogic.js';
import { renderStatRadarSvg } from './radarChart.js';

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTopHud({ profile, activeTab, lifecycle }) {
  const hp = clampSocialHp(profile.current_social_hp);
  const lowHp = isLowHpWarning(hp);
  const backupDue = needsBackupReminder(profile);
  const effects = Array.isArray(profile.active_status_effects) ? profile.active_status_effects : [];
  const isRollover = lifecycle.phase === 'active_rollover';
  const turnLabel = formatShortDate(profile.current_turn_date);

  return `
    <header class="top-hud">
      <div class="hud-bar ${lowHp ? 'hud-bar--low-hp' : ''}">
        <button class="level-badge" data-action="switch-tab" data-tab="character" title="View Character Sheet">
          <span class="level-badge__label">LVL</span>
          <span class="level-badge__value">${profile.overall_level || 1}</span>
        </button>

        <div class="hud-hp-block">
          <div class="hud-hp-header">
            <span class="hud-hp-title">${lowHp ? '⚠ Low Social HP' : 'Social / Weekly HP'}</span>
            <span class="hud-hp-value">${hp}/100</span>
          </div>
          <div class="hp-track" role="progressbar" aria-valuenow="${hp}" aria-valuemin="0" aria-valuemax="100">
            <div class="hp-fill" style="width: ${hp}%"></div>
            <div class="hp-ticks"></div>
          </div>
        </div>

        <div class="hud-actions">
          <button class="icon-btn" data-action="open-weekly-report" title="Weekly Report" aria-label="Weekly Report">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 6-7"/>
            </svg>
          </button>
          <button class="icon-btn" data-action="open-settings" title="Settings & Save Points" aria-label="Settings">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            ${backupDue ? '<span class="icon-btn__dot" title="Save Point backup due"></span>' : ''}
          </button>
        </div>
      </div>

      <div class="hud-status-row">
        <span class="status-chip status-chip--turn ${isRollover ? 'status-chip--rollover' : ''}">
          ${isRollover ? `NEXT TURN • ${escapeHtml(turnLabel)}` : `TURN • ${escapeHtml(turnLabel)}`}
        </span>
        ${profile.vacation_mode ? '<span class="status-chip status-chip--vacation">⛺ Long Rest / Vacation</span>' : ''}
        ${effects.map((eff) => `<span class="status-chip status-chip--effect">⚡ ${escapeHtml(eff)}</span>`).join('')}
      </div>

      <nav class="nav-tabs" role="tablist">
        <button class="nav-tab ${activeTab === 'quests' ? 'nav-tab--active' : ''}" data-action="switch-tab" data-tab="quests" role="tab">Quests</button>
        <button class="nav-tab ${activeTab === 'character' ? 'nav-tab--active' : ''}" data-action="switch-tab" data-tab="character" role="tab">Character</button>
        <button class="nav-tab ${activeTab === 'log' ? 'nav-tab--active' : ''}" data-action="switch-tab" data-tab="log" role="tab">Log</button>
      </nav>
    </header>
  `;
}

export function renderQuestsView({
  profile,
  tasks,
  routines,
  routinesExpanded,
  lifecycle,
  isTriaging
}) {
  const hp = clampSocialHp(profile.current_social_hp);
  const lowHp = isLowHpWarning(hp);
  const turnDate = profile.current_turn_date;
  const backupDue = needsBackupReminder(profile);

  const activeRoutines = routines.filter((r) => !r.paused);
  const doneRoutinesCount = activeRoutines.filter((r) => r.last_completed_turn_date === turnDate).length;

  const activeTasks = tasks
    .filter((t) => t.status === 'active' || t.status === 'pending_triage')
    .sort((a, b) => {
      // Heavy & Boss rise cleanly above Standard/Cantrip, then newest first
      const order = { Boss: 0, Heavy: 1, Standard: 2, Cantrip: 3 };
      const diff = (order[a.difficulty_tier] ?? 2) - (order[b.difficulty_tier] ?? 2);
      return diff !== 0 ? diff : (b.created_at || '').localeCompare(a.created_at || '');
    });

  const completedToday = tasks
    .filter((t) => t.status === 'completed' && (t.completed_turn_date || t.assigned_turn_date) === turnDate)
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));

  const banners = [];

  if (lifecycle.phase === 'active_rollover') {
    banners.push(`
      <div class="banner banner--amber">
        <span>Day closed. New tasks & logs now apply to <strong>${escapeHtml(formatShortDate(turnDate))}</strong>.</span>
        <button class="banner__btn" data-action="open-start-day">Start Early</button>
      </div>
    `);
  }

  if (lowHp) {
    banners.push(`
      <div class="banner banner--warning">
        <span><strong>Bandwidth Low (${hp}/100 HP):</strong> Prioritize a Restorative task (+10 HP) before taking on Heavy Quests or Boss Fights.</span>
      </div>
    `);
  }

  if (backupDue) {
    banners.push(`
      <div class="banner banner--info">
        <span>No Save Point exported in 7+ days. Back up your local database.</span>
        <button class="banner__btn" data-action="quick-export-save">Backup</button>
      </div>
    `);
  }

  const routinesCardHtml = `
    <section class="tactical-frame routines-card">
      <button class="routines-header" data-action="toggle-routines" aria-expanded="${routinesExpanded}">
        <span class="routines-header__left">
          <span class="routines-title">Daily Routines</span>
          <span class="routines-count ${activeRoutines.length > 0 && doneRoutinesCount === activeRoutines.length ? 'routines-count--done' : ''}">
            ${doneRoutinesCount}/${activeRoutines.length}
          </span>
        </span>
        <span class="routines-chevron ${routinesExpanded ? 'routines-chevron--open' : ''}">▼</span>
      </button>
      ${
        routinesExpanded
          ? `<div class="routines-list">
              ${
                activeRoutines.length === 0
                  ? `<div style="padding:8px 6px; font-size:12.5px; color:var(--text-muted);">
                      No active routines. Manage routines in Settings.
                    </div>`
                  : activeRoutines
                      .map((r) => {
                        const isDone = r.last_completed_turn_date === turnDate;
                        return `
                          <div class="routine-item ${isDone ? 'routine-item--done' : ''}">
                            <button
                              class="tactical-check ${isDone ? 'tactical-check--checked' : ''}"
                              data-action="complete-routine"
                              data-id="${escapeHtml(r.id)}"
                              aria-label="Complete routine ${escapeHtml(r.title)}"
                              ${isDone ? 'disabled' : ''}
                            >${isDone ? '✓' : ''}</button>
                            <div class="routine-item__body">
                              <div class="routine-item__title">${escapeHtml(r.title)}</div>
                              <div class="routine-item__meta">
                                <span>${escapeHtml(r.target_stat || 'DSC')} +${r.base_xp || 10} XP</span>
                                <span class="streak-badge">🔥 ${r.streak_count || 0}d streak</span>
                              </div>
                            </div>
                          </div>
                        `;
                      })
                      .join('')
              }
            </div>`
          : ''
      }
    </section>
  `;

  const tasksListHtml =
    activeTasks.length === 0
      ? `
        <div class="empty-state">
          <div class="empty-state__title">No active quests on deck</div>
          <div class="empty-state__sub">Use the bottom bar to add a task — Gemini DM will triage it automatically.</div>
        </div>
      `
      : activeTasks.map((t) => renderTaskCard(t, turnDate)).join('');

  const completedSectionHtml =
    completedToday.length > 0
      ? `
        <div class="section-header" style="margin-top: 4px;">
          <span class="section-title">Completed This Turn</span>
          <span class="section-meta">${completedToday.length} cleared</span>
        </div>
        ${completedToday
          .map(
            (t) => `
          <div class="tactical-frame completed-card">
            <div class="task-card__top">
              <div class="task-card__main">
                <div class="task-title">${escapeHtml(t.quest_title || t.raw_text)}</div>
              </div>
              <span class="stat-xp-pill">+${t.xp_awarded || getXpForTier(t.difficulty_tier)} XP</span>
            </div>
          </div>
        `
          )
          .join('')}
      `
      : '';

  return `
    ${banners.join('')}
    ${routinesCardHtml}

    <div class="section-header">
      <span class="section-title">Active Quests</span>
      <span class="section-meta">${isTriaging ? 'DM Triaging…' : `${activeTasks.length} active`}</span>
    </div>

    ${tasksListHtml}
    ${completedSectionHtml}
  `;
}

function renderTaskCard(task, currentTurnDate) {
  const totalXp = getXpForTier(task.difficulty_tier);
  const splits = splitStatXp(totalXp, task.primary_stat, task.secondary_stat);
  const isFeatured = task.difficulty_tier === 'Heavy' || task.difficulty_tier === 'Boss';
  const isPending = task.status === 'pending_triage';
  const isCarryover = task.assigned_turn_date && task.assigned_turn_date < currentTurnDate;
  const showRawSubtitle =
    task.raw_text &&
    task.quest_title &&
    task.raw_text.trim().toLowerCase() !== task.quest_title.trim().toLowerCase();

  const splitEntries = Object.entries(splits);

  return `
    <article class="tactical-frame ${isFeatured ? 'tactical-frame--amber' : ''} task-card">
      <div class="task-card__top">
        <button
          class="tactical-check"
          data-action="complete-task"
          data-id="${escapeHtml(task.id)}"
          aria-label="Complete quest ${escapeHtml(task.quest_title || task.raw_text)}"
        ></button>

        <div class="task-card__main" data-action="edit-task" data-id="${escapeHtml(task.id)}">
          <div class="task-badges">
            <span class="tier-badge tier-badge--${escapeHtml(task.difficulty_tier)}">${escapeHtml(task.difficulty_tier)}</span>
            ${task.is_restorative ? '<span class="restorative-badge">✦ Restorative +10 HP</span>' : ''}
            ${isPending ? '<span class="pending-badge">⏳ Pending Triage</span>' : ''}
            ${isCarryover ? '<span class="carryover-badge">Carried Over</span>' : ''}
          </div>
          <div class="task-title">${escapeHtml(task.quest_title || task.raw_text)}</div>
          ${showRawSubtitle ? `<div class="task-raw">${escapeHtml(task.raw_text)}</div>` : ''}
        </div>

        <div class="task-card__right">
          <div class="stat-xp-stack">
            ${splitEntries
              .map(
                ([code, xp], idx) => `
              <span class="stat-xp-pill ${idx > 0 ? 'stat-xp-pill--secondary' : ''}">
                <span class="stat-code-tag">${escapeHtml(code)}</span> +${xp}
              </span>
            `
              )
              .join('')}
          </div>
        </div>
      </div>

      ${
        isPending
          ? `<div class="task-card__footer">
              <span style="font-size:11.5px; color:var(--text-muted);">Offline / API fallback (35 XP). Tap card to override.</span>
              <button class="retry-btn" data-action="retry-triage" data-id="${escapeHtml(task.id)}">↻ Retry AI</button>
            </div>`
          : ''
      }
    </article>
  `;
}

export function renderCharacterView({ profile, stats }) {
  const overall = computeOverallLevelProgress(profile.overall_xp);
  const statMap = new Map(stats.map((s) => [s.stat_code, s]));

  return `
    <section class="tactical-frame tactical-frame--amber panel-card">
      <div class="panel-title">
        <span>${escapeHtml(profile.character_name || 'Adventurer')}</span>
        <span style="font-family:var(--font-mono); color:var(--amber-bright);">LVL ${overall.level}</span>
      </div>

      <div class="stat-row">
        <div class="stat-row__top">
          <span style="font-size:12px; color:var(--text-secondary);">Overall Progression (Combined 6 Stats)</span>
          <span class="stat-row__nums">${overall.currentLevelXp} / ${overall.xpNeededForNext} XP</span>
        </div>
        <div class="xp-bar">
          <div class="xp-bar__fill" style="width: ${Math.round(overall.progressRatio * 100)}%"></div>
        </div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">
          Total Lifetime XP: ${overall.totalXp} XP • Strictly Additive
        </div>
      </div>

      <div class="radar-wrap">
        ${renderStatRadarSvg(stats, { size: 224 })}
      </div>
    </section>

    <section class="tactical-frame panel-card">
      <div class="panel-title">
        <span>6 Core Attributes</span>
        <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">70/30 SPLIT</span>
      </div>
      <div class="stat-grid">
        ${STAT_CODES.map((code) => {
          const row = statMap.get(code) || { stat_code: code, total_xp: 0, current_level: 1 };
          const prog = computeStatLevelProgress(row.total_xp);
          const meta = STAT_META[code];
          return `
            <div class="stat-row">
              <div class="stat-row__top">
                <span class="stat-row__name">
                  <span class="stat-row__code">${code}</span>
                  <span>${escapeHtml(meta.name)}</span>
                  <span style="font-family:var(--font-mono); font-size:11.5px; color:var(--amber-bright);">Lv ${prog.level}</span>
                </span>
                <span class="stat-row__nums">${prog.currentLevelXp} / ${prog.xpNeededForNext} XP</span>
              </div>
              <div class="xp-bar">
                <div class="xp-bar__fill" style="width: ${Math.round(prog.progressRatio * 100)}%"></div>
              </div>
              <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(meta.focus)} • ${prog.totalXp} total XP</div>
            </div>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

export function renderLogView({ interactions, dailyTurns, weeklyReports }) {
  const sortedInteractions = [...interactions].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '')
  );
  const closedTurns = [...dailyTurns]
    .filter((t) => Boolean(t.ended_at))
    .sort((a, b) => b.turn_date.localeCompare(a.turn_date));
  const sortedWeeks = [...weeklyReports].sort((a, b) =>
    b.week_start_date.localeCompare(a.week_start_date)
  );

  return `
    <div class="section-header">
      <span class="section-title">Interactions & Narrative Journal</span>
      <span class="section-meta">${sortedInteractions.length} logged</span>
    </div>

    ${
      sortedInteractions.length === 0
        ? `<div class="empty-state">
            <div class="empty-state__title">No interactions or journal logs yet</div>
            <div class="empty-state__sub">Tap "+ INTERACTION / JOURNAL" in the bottom bar to log meaningful moments.</div>
          </div>`
        : sortedInteractions
            .slice(0, 20)
            .map((item) => {
              const hpSign = item.hp_delta > 0 ? `+${item.hp_delta}` : `${item.hp_delta}`;
              const hpColor = item.hp_delta > 0 ? 'var(--green)' : item.hp_delta < 0 ? 'var(--red)' : 'var(--text-secondary)';
              return `
                <article class="tactical-frame log-entry">
                  <div class="log-entry__head">
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="tier-badge">${escapeHtml(item.entry_type)}</span>
                      <span class="sentiment-pill sentiment-pill--${escapeHtml(item.user_sentiment || 'Neutral')}">${escapeHtml(item.user_sentiment || 'Neutral')}</span>
                      <span style="font-family:var(--font-mono); font-size:11.5px; font-weight:700; color:${hpColor};">${hpSign} HP</span>
                    </div>
                    <span style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted);">${escapeHtml(formatShortDate(item.assigned_turn_date))}</span>
                  </div>
                  <div style="font-size:13.5px; color:var(--text-primary);">${escapeHtml(item.raw_text)}</div>
                  ${item.dm_note ? `<div class="dm-note">DM: ${escapeHtml(item.dm_note)}</div>` : ''}
                  <div style="display:flex; align-items:center; justify-content:space-between; font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">
                    <span>${item.primary_stat ? `${item.primary_stat}${item.secondary_stat ? ` / ${item.secondary_stat}` : ''} • +${item.xp_awarded || 0} XP` : 'No XP'}</span>
                    ${item.status_effect ? `<span style="color:#ff8a80;">⚡ ${escapeHtml(item.status_effect)}</span>` : ''}
                  </div>
                </article>
              `;
            })
            .join('')
    }

    <div class="section-header" style="margin-top:6px;">
      <span class="section-title">Daily Reports Archive</span>
      <span class="section-meta">${closedTurns.length} days</span>
    </div>

    ${
      closedTurns.length === 0
        ? `<div class="empty-state"><div class="empty-state__sub">Completed Daily Reports will archive here.</div></div>`
        : closedTurns
            .slice(0, 14)
            .map(
              (turn) => `
          <article class="tactical-frame log-entry">
            <div class="log-entry__head">
              <strong style="font-size:13.5px;">${escapeHtml(formatShortDate(turn.turn_date))}</strong>
              <span style="font-family:var(--font-mono); font-size:11.5px; color:var(--amber-bright);">+${turn.total_xp_earned || 0} XP • ${turn.ending_hp ?? 75}/100 HP</span>
            </div>
            <div style="font-size:11.5px; color:var(--text-muted); font-family:var(--font-mono);">
              Sleep: ${escapeHtml(turn.sleep_quality || 'N/A')}${turn.is_vacation ? ' • Vacation' : ''}
            </div>
            ${turn.gemini_daily_summary ? `<div class="dm-note">${escapeHtml(turn.gemini_daily_summary)}</div>` : ''}
          </article>
        `
            )
            .join('')
    }

    <div class="section-header" style="margin-top:6px;">
      <span class="section-title">Weekly Reports</span>
      <span class="section-meta">${sortedWeeks.length} weeks</span>
    </div>

    ${
      sortedWeeks.length === 0
        ? `<div class="empty-state"><div class="empty-state__sub">Weekly Reports generate on Sunday End Day (or Monday Start Day).</div></div>`
        : sortedWeeks
            .map(
              (w) => `
          <article class="tactical-frame log-entry" style="cursor:pointer;" data-action="view-saved-weekly" data-week="${escapeHtml(w.week_start_date)}">
            <div class="log-entry__head">
              <strong style="font-size:13.5px;">${escapeHtml(formatShortDate(w.week_start_date))} – ${escapeHtml(formatShortDate(w.week_end_date))}</strong>
              <span class="tone-pill" style="padding:2px 8px; font-size:11px;">${getToneLabel(w.net_tone_score)}</span>
            </div>
            <div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-secondary);">
              End HP: ${w.ending_hp}/100 (${w.net_hp_delta >= 0 ? '+' : ''}${w.net_hp_delta}) • Interactions: ${w.interaction_volume}
            </div>
          </article>
        `
            )
            .join('')
    }
  `;
}

export function renderBottomThumbZone({ isTriaging, lifecycle }) {
  const isRollover = lifecycle.phase === 'active_rollover';
  return `
    <footer class="bottom-thumb-zone">
      <form class="quick-add-form" id="quick-add-form">
        <input
          id="quick-add-input"
          class="quick-add-input"
          type="text"
          autocomplete="off"
          placeholder="${isRollover ? '+ Add task for tomorrow…' : '+ Add task or quest…'}"
          aria-label="Add new task"
        />
        <button type="submit" class="quick-add-submit" ${isTriaging ? 'disabled' : ''}>
          ${isTriaging ? '…' : '+ ADD'}
        </button>
      </form>

      <div class="thumb-action-row">
        <button type="button" class="btn-interaction" data-action="open-interaction-modal">
          <span class="btn-interaction__main">+ INTERACTION / JOURNAL</span>
          <span class="btn-interaction__sub">
            (<span class="c-good">GOOD</span> / NEUTRAL / <span class="c-bad">BAD</span>)
          </span>
        </button>

        <button type="button" class="btn-end-day" data-action="open-end-day-confirm">
          <span class="btn-end-day__inner">END DAY</span>
        </button>
      </div>
    </footer>
  `;
}

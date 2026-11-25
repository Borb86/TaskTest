/**
 * Direct Client-Side Gemini REST API Client (Structured Outputs via responseSchema)
 * Uses the user's API key saved locally in IndexedDB Settings.
 * Zero backend server required; handles offline & timeouts gracefully.
 */

import {
  STAT_CODES,
  TASK_CATEGORIES,
  DIFFICULTY_TIERS,
  getInteractionHpDelta,
  normalizeJournalHpDelta
} from '../core/rpgMath.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 15000;

export const AVAILABLE_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash'
];

export const TASK_TRIAGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: {
      type: 'STRING',
      enum: TASK_CATEGORIES
    },
    primary_stat: {
      type: 'STRING',
      enum: STAT_CODES
    },
    secondary_stat: {
      type: 'STRING',
      enum: STAT_CODES,
      nullable: true
    },
    difficulty_tier: {
      type: 'STRING',
      enum: DIFFICULTY_TIERS
    },
    is_restorative: {
      type: 'BOOLEAN'
    },
    quest_title: {
      type: 'STRING'
    }
  },
  required: [
    'category',
    'primary_stat',
    'secondary_stat',
    'difficulty_tier',
    'is_restorative',
    'quest_title'
  ]
};

export const INTERACTION_JOURNAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    primary_stat: {
      type: 'STRING',
      enum: STAT_CODES,
      nullable: true
    },
    secondary_stat: {
      type: 'STRING',
      enum: STAT_CODES,
      nullable: true
    },
    xp_tier: {
      type: 'STRING',
      enum: ['None', 'Cantrip', 'Standard', 'Heavy']
    },
    hp_delta: {
      type: 'INTEGER'
    },
    status_effect: {
      type: 'STRING',
      nullable: true
    },
    dm_note: {
      type: 'STRING'
    }
  },
  required: [
    'primary_stat',
    'secondary_stat',
    'xp_tier',
    'hp_delta',
    'status_effect',
    'dm_note'
  ]
};

const DAILY_SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' }
  },
  required: ['summary']
};

const WEEKLY_REFLECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reflection: { type: 'STRING' }
  },
  required: ['reflection']
};

async function callGeminiStructured({
  apiKey,
  model = 'gemini-2.5-flash',
  systemInstruction,
  userPrompt,
  responseSchema,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('NO_API_KEY');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('OFFLINE');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const safeModel = (model || 'gemini-2.5-flash').trim();
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(safeModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }]
          }
        ],
        generationConfig: {
          temperature: 0.25,
          responseMimeType: 'application/json',
          responseSchema
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP_${response.status}: ${errText.slice(0, 180)}`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error('EMPTY_RESPONSE');
    }

    return JSON.parse(rawText);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flow 1: Task Triage via Gemini Structured Outputs.
 * Falls back to Pending Triage (Standard Quest / 35 XP) on offline/timeout/error.
 */
export async function triageTaskWithGemini(rawText, apiKey, model = 'gemini-2.5-flash') {
  const systemInstruction = `You are an automated Dungeon Master (DM) for a personal tactical RPG life tracker.
Analyze the user's natural-language task and classify it strictly into the JSON schema.

6 Core Stats:
- INT (Intellect): Work, strategy, coding, analytical thinking, reading, learning.
- VIT (Vitality): Health, exercise, walks, nutrition, medical appointments, sleep hygiene, physical self-care.
- CRF (Craft): Creative & hands-on building, hobbies, cooking, DIY, music, miniature painting, side projects.
- STW (Stewardship): Home, chores, cleaning, groceries, bills, maintenance, errands, life admin.
- CHA (Charisma): Relationships, family time, social plans, outreach, community, tough conversations.
- DSC (Discipline): Consistency, grit, pushing through procrastinated/dreaded high-friction obligations.

Difficulty Tiers (fixed XP in app):
- Cantrip: Quick micro-task (< 15 mins).
- Standard: Focused daily task (~20–90 mins or moderate effort).
- Heavy: High-effort or high-friction task (2+ hours or dreaded task).
- Boss: Major milestone or multi-day/multi-hour big completion.

Rules:
- Assign primary_stat and optional secondary_stat (null if single-stat; never equal to primary_stat).
- Set is_restorative = true ONLY for self-care, walks, hobbies, rest, intentional downtime, or genuinely replenishing activities.
- Write a crisp, short tactical RPG quest_title (3–7 words, clear and motivating, no quotes).`;

  try {
    const parsed = await callGeminiStructured({
      apiKey,
      model,
      systemInstruction,
      userPrompt: `Triage this task:\n${rawText}`,
      responseSchema: TASK_TRIAGE_SCHEMA
    });

    const primaryStat = STAT_CODES.includes(parsed.primary_stat) ? parsed.primary_stat : 'DSC';
    const secondaryStat =
      parsed.secondary_stat &&
      STAT_CODES.includes(parsed.secondary_stat) &&
      parsed.secondary_stat !== primaryStat
        ? parsed.secondary_stat
        : null;
    const difficultyTier = DIFFICULTY_TIERS.includes(parsed.difficulty_tier)
      ? parsed.difficulty_tier
      : 'Standard';
    const category = TASK_CATEGORIES.includes(parsed.category) ? parsed.category : 'Admin';
    const questTitle =
      typeof parsed.quest_title === 'string' && parsed.quest_title.trim()
        ? parsed.quest_title.trim()
        : rawText.trim();

    return {
      ok: true,
      pendingTriage: false,
      result: {
        category,
        primary_stat: primaryStat,
        secondary_stat: secondaryStat,
        difficulty_tier: difficultyTier,
        is_restorative: Boolean(parsed.is_restorative),
        quest_title: questTitle
      }
    };
  } catch (err) {
    return {
      ok: false,
      pendingTriage: true,
      error: formatGeminiError(err),
      result: {
        category: 'Admin',
        primary_stat: 'DSC',
        secondary_stat: null,
        difficulty_tier: 'Standard',
        is_restorative: false,
        quest_title: rawText.trim()
      }
    };
  }
}

/**
 * Flow 2: Interaction or Narrative Journal Evaluation via Gemini Structured Outputs.
 */
export async function evaluateEntryWithGemini(
  { entryType, rawText, userSentiment },
  apiKey,
  model = 'gemini-2.5-flash'
) {
  const isJournal = entryType === 'Journal';

  const systemInstruction = `You are a grounded, empathetic Dungeon Master evaluating a user's ${isJournal ? 'narrative journal entry' : 'meaningful interpersonal interaction'}.
Separate accomplishment/growth (Stat XP) from emotional/bandwidth cost (Social HP).

6 Core Stats: INT, VIT, CRF, STW, CHA, DSC.
xp_tier options: "None", "Cantrip", "Standard", "Heavy".
hp_delta rules:
- Uplifting / positive / restorative: +10
- Neutral / mixed: 0
- Draining / negative: -5
- Heavy emotional drain (journal only, major conflict/exhaustion): -8
${!isJournal ? `The user explicitly selected sentiment="${userSentiment}". Respect this sentiment for hp_delta (+10 Good, 0 Neutral, -5 Bad).` : ''}
status_effect: optional short 1–2 word temporary tag (e.g., "Drained", "Low Bandwidth", "Energized") ONLY if strongly warranted, otherwise null.
dm_note: concise 1-sentence tactical RPG Dungeon Master reflection acknowledging effort and bandwidth.`;

  try {
    const parsed = await callGeminiStructured({
      apiKey,
      model,
      systemInstruction,
      userPrompt: `Entry Type: ${entryType}\n${!isJournal ? `User Sentiment: ${userSentiment}\n` : ''}Notes:\n${rawText}`,
      responseSchema: INTERACTION_JOURNAL_SCHEMA
    });

    const primaryStat =
      parsed.primary_stat && STAT_CODES.includes(parsed.primary_stat)
        ? parsed.primary_stat
        : 'CHA';
    const secondaryStat =
      parsed.secondary_stat &&
      STAT_CODES.includes(parsed.secondary_stat) &&
      parsed.secondary_stat !== primaryStat
        ? parsed.secondary_stat
        : null;
    const validTiers = ['None', 'Cantrip', 'Standard', 'Heavy'];
    const xpTier = validTiers.includes(parsed.xp_tier) ? parsed.xp_tier : 'Cantrip';

    // Keep Social HP strictly deterministic for quick interactions; normalized bounds for journals
    const hpDelta = isJournal
      ? normalizeJournalHpDelta(parsed.hp_delta, userSentiment)
      : getInteractionHpDelta(userSentiment);

    const statusEffect =
      typeof parsed.status_effect === 'string' && parsed.status_effect.trim() && hpDelta < 0
        ? parsed.status_effect.trim().slice(0, 28)
        : null;

    const dmNote =
      typeof parsed.dm_note === 'string' && parsed.dm_note.trim()
        ? parsed.dm_note.trim()
        : buildFallbackDmNote(entryType, userSentiment, hpDelta);

    return {
      ok: true,
      pendingAi: false,
      result: {
        primary_stat: primaryStat,
        secondary_stat: secondaryStat,
        xp_tier: xpTier,
        hp_delta: hpDelta,
        status_effect: statusEffect,
        dm_note: dmNote
      }
    };
  } catch (err) {
    const hpDelta = getInteractionHpDelta(userSentiment || 'Neutral');
    return {
      ok: false,
      pendingAi: true,
      error: formatGeminiError(err),
      result: {
        primary_stat: 'CHA',
        secondary_stat: 'DSC',
        xp_tier: 'Cantrip',
        hp_delta: hpDelta,
        status_effect: hpDelta <= -5 ? 'Drained' : null,
        dm_note: buildFallbackDmNote(entryType, userSentiment, hpDelta)
      }
    };
  }
}

/**
 * End-of-Day Short Gemini Summary (with deterministic offline fallback).
 */
export async function generateDailySummaryWithGemini(dayContext, apiKey, model = 'gemini-2.5-flash') {
  const fallback = buildLocalDailySummary(dayContext);
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, summary: fallback, offline: true };
  }

  try {
    const parsed = await callGeminiStructured({
      apiKey,
      model,
      systemInstruction:
        'You are a concise tactical RPG Dungeon Master giving a 2-sentence End-of-Day Campfire/Long Rest debrief. Be encouraging, grounded, and reference actual stats, sleep, or Social HP without fluff.',
      userPrompt: JSON.stringify(dayContext),
      responseSchema: DAILY_SUMMARY_SCHEMA
    });
    return {
      ok: true,
      summary: parsed.summary?.trim() || fallback,
      offline: false
    };
  } catch (_) {
    return { ok: false, summary: fallback, offline: true };
  }
}

/**
 * Weekly Report Gemini Reflection (with deterministic offline fallback).
 */
export async function generateWeeklyReflectionWithGemini(weekContext, apiKey, model = 'gemini-2.5-flash') {
  const fallback = buildLocalWeeklyReflection(weekContext);
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, reflection: fallback, offline: true };
  }

  try {
    const parsed = await callGeminiStructured({
      apiKey,
      model,
      systemInstruction:
        'You are a tactical RPG Dungeon Master writing a brief 2-3 sentence Weekly Alignment Report reflection highlighting sleep patterns, emotional/social bandwidth, and recovery trends compared against historical baselines if present.',
      userPrompt: JSON.stringify(weekContext),
      responseSchema: WEEKLY_REFLECTION_SCHEMA
    });
    return {
      ok: true,
      reflection: parsed.reflection?.trim() || fallback,
      offline: false
    };
  } catch (_) {
    return { ok: false, reflection: fallback, offline: true };
  }
}

/**
 * Test Gemini API key connectivity from Settings.
 */
export async function testGeminiApiKey(apiKey, model = 'gemini-2.5-flash') {
  const res = await callGeminiStructured({
    apiKey,
    model,
    systemInstruction: 'Respond with a short 4-word RPG readiness confirmation.',
    userPrompt: 'Ping',
    responseSchema: DAILY_SUMMARY_SCHEMA,
    timeoutMs: 10000
  });
  return res.summary || 'Connected';
}

function formatGeminiError(err) {
  const msg = err?.message || 'Unknown error';
  if (msg === 'NO_API_KEY') return 'No Gemini API key configured in Settings.';
  if (msg === 'OFFLINE') return 'Device is offline.';
  if (msg === 'TIMEOUT') return 'Gemini API request timed out.';
  return msg;
}

function buildFallbackDmNote(entryType, sentiment, hpDelta) {
  if (hpDelta > 0) return 'Logged offline — meaningful momentum and restorative energy banked.';
  if (hpDelta < 0) return 'Logged offline — tough bandwidth hit recorded; prioritize a restorative quest.';
  return `Logged offline — ${entryType.toLowerCase()} noted (${sentiment || 'Neutral'}).`;
}

function buildLocalDailySummary(ctx) {
  const xp = ctx.total_xp_earned || 0;
  const tasks = ctx.tasks_completed || 0;
  const hp = ctx.ending_hp ?? 75;
  const lowNote =
    hp <= 40
      ? ' Social HP is running low—schedule a restorative quest early tomorrow.'
      : ' Bandwidth remains steady heading into rest.';
  return `Turn ${ctx.turn_date} complete: ${tasks} quest${tasks === 1 ? '' : 's'} cleared for +${xp} XP, ending at ${hp}/100 Social HP.${lowNote}`;
}

function buildLocalWeeklyReflection(ctx) {
  const deltaStr = ctx.net_hp_delta >= 0 ? `+${ctx.net_hp_delta}` : `${ctx.net_hp_delta}`;
  const sleep = ctx.sleep_summary || { Good: 0, Okay: 0, Poor: 0 };
  return `Week closed at ${ctx.ending_hp}/100 HP (${deltaStr} net) across ${ctx.active_days} active day${ctx.active_days === 1 ? '' : 's'} with ${ctx.interaction_volume} logged interactions (Net Tone ${ctx.net_tone_score >= 0 ? '+' : ''}${ctx.net_tone_score}). Sleep check-ins: ${sleep.Good} Good, ${sleep.Okay} Okay, ${sleep.Poor} Poor.`;
}

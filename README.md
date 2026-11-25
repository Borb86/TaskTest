# Borb — Personal, Local-First Tactical RPG Task & Life Tracker (PWA)

A standalone, zero-build Progressive Web App (PWA) designed for the **Samsung Galaxy S26 Ultra** (Tactical RPG OLED theme, true `#000000` black background, amber-gold accents, one-handed bottom thumb-zone controls).

## Key Features (MVP)

- **100% Local-First IndexedDB Storage**: All 7 object stores (`character_profile`, `stat_progress`, `tasks`, `routines`, `interactions_journal`, `daily_turns`, `weekly_reports`) stored natively in browser IndexedDB.
- **Installable Offline PWA**: Includes `manifest.json`, PNG/SVG icons, and cache-first Service Worker (`sw.js`).
- **Direct Gemini REST API (Structured Outputs)**: Uses your personal API key saved locally in Settings with strict `responseSchema` for Task Triage and Interaction / Narrative Journal evaluation, plus seamless offline fallbacks (`Pending Triage` / 35 XP with one-tap retry & manual tag override).
- **Deterministic Core RPG Math**:
  - 6 strictly additive stats: `INT`, `VIT`, `CRF`, `STW`, `CHA`, `DSC` (stat XP never decreases).
  - 70% Primary / 30% Secondary split (or 100% Primary when single-stat).
  - Fixed Difficulty Tiers: Routine (`10 XP`, no AI), Cantrip (`15 XP`), Standard Quest (`35 XP`), Heavy Quest (`75 XP`), Boss Fight (`150 XP`).
  - Leveling Curves: Individual Stat `round_to_nearest_10(100 * level^1.35)`, Overall Character `round_to_nearest_10(300 * level^1.35)`.
  - Social / Weekly HP (`0–100` clamped, resets Monday Start Day to `75/100`, warning state at `<= 40 HP`).
- **Turn-Based Day Loop & Reports**:
  - Morning **Start Day** sleep check-in (`Good +5` / `Okay 0` / `Poor -5`) + carryover tasks.
  - **End Day Confirmation** displaying exact clock time + logical turn rollover to tomorrow.
  - **Long Rest Daily Report**: 6-stat SVG radar chart, animated XP gain bars, Social HP breakdown, Weekly Tone, Gemini debrief, and `Save & Sleep`.
  - **Missed End Day Recovery** & automatic **Weekly Alignment Reports** with rolling 4-week and all-time benchmarks.
- **Settings & Save Points**: Gemini API key config, Daily Routines Manager (with streaks & 7-day `+25 XP` bonus), Vacation / Long Rest toggle, and one-click Export / Import JSON Save Point (`rpg-task-save-YYYY-MM-DD.json`) with a 7-day backup reminder.

## Running Locally

Because this is a zero-build ES Modules PWA, you can run it directly with Python (using `serve.py` to guarantee proper `.js` MIME types on Windows):

```powershell
python serve.py
```

Then open:
- App: `http://localhost:8765/`
- Automated Unit Tests: `http://localhost:8765/tests/test-runner.html`

## Installing to Samsung Galaxy S26 Ultra

Host the folder on any static HTTPS host (GitHub Pages, Netlify, or Cloudflare Pages), open the URL in Chrome or Samsung Internet on your Galaxy S26 Ultra, and tap **Add to Home screen / Install app**.

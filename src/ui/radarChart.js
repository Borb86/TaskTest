/**
 * 6-Stat Tactical SVG Radar Chart (INT, VIT, CRF, STW, CHA, DSC)
 * Modeled after the End-of-Day Daily Report visual reference (glowing amber-orange hex polygon).
 */

import { STAT_CODES } from '../core/rpgMath.js';

/**
 * Render an inline SVG string for the 6-stat radar chart.
 * @param {Array<{stat_code: string, total_xp: number, current_level: number}>} stats
 * @param {Object} options
 */
export function renderStatRadarSvg(stats, { size = 186, dailyGains = null } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size * 0.34;
  const labelRadius = size * 0.445;

  const statMap = new Map(stats.map((s) => [s.stat_code, s]));

  // Normalize values so the radar chart always shows meaningful shape even at Level 1
  const rawValues = STAT_CODES.map((code) => {
    const row = statMap.get(code);
    const totalXp = row?.total_xp || 0;
    const level = row?.current_level || 1;
    // Combine level + XP so early progress is clearly visible
    return Math.max(1, level * 100 + totalXp * 0.35);
  });
  const maxVal = Math.max(140, ...rawValues);

  const pointAt = (index, ratio) => {
    // Top axis starts at -90 deg (INT at top, clockwise: VIT, CRF, STW, CHA, DSC)
    const angle = (-90 + index * 60) * (Math.PI / 180);
    return {
      x: +(cx + Math.cos(angle) * maxRadius * ratio).toFixed(1),
      y: +(cy + Math.sin(angle) * maxRadius * ratio).toFixed(1)
    };
  };

  const ringRatios = [0.25, 0.5, 0.75, 1.0];
  const ringsSvg = ringRatios
    .map((r) => {
      const pts = STAT_CODES.map((_, i) => {
        const p = pointAt(i, r);
        return `${p.x},${p.y}`;
      }).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="${r === 1 ? 'rgba(245,166,35,0.38)' : 'rgba(255,255,255,0.1)'}" stroke-width="1" ${r < 1 ? 'stroke-dasharray="2 2"' : ''} />`;
    })
    .join('');

  const axesSvg = STAT_CODES.map((_, i) => {
    const p = pointAt(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="rgba(255,255,255,0.1)" stroke-width="1" />`;
  }).join('');

  const dataPoints = STAT_CODES.map((_, i) => {
    const normalized = Math.max(0.22, Math.min(1, rawValues[i] / maxVal));
    return pointAt(i, normalized);
  });

  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');

  const vertexDots = dataPoints
    .map((p, i) => {
      const code = STAT_CODES[i];
      const gained = dailyGains && (dailyGains[code] || 0) > 0;
      return `<circle cx="${p.x}" cy="${p.y}" r="${gained ? 3.5 : 2.5}" fill="${gained ? '#ffd166' : '#ff8a24'}" />`;
    })
    .join('');

  const labelsSvg = STAT_CODES.map((code, i) => {
    const angle = (-90 + i * 60) * (Math.PI / 180);
    const lx = +(cx + Math.cos(angle) * labelRadius).toFixed(1);
    const ly = +(cy + Math.sin(angle) * labelRadius + 3.5).toFixed(1);
    const gained = dailyGains && (dailyGains[code] || 0) > 0;
    return `<text x="${lx}" y="${ly}" text-anchor="middle" fill="${gained ? '#ffbe3d' : '#9da3b4'}" font-family="ui-monospace, monospace" font-size="10.5" font-weight="700">${code}</text>`;
  }).join('');

  const gradId = `radarGrad_${size}_${Math.floor(maxVal)}`;

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="6-Stat Character Radar Chart">
      <defs>
        <radialGradient id="${gradId}" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stop-color="#ffbe3d" stop-opacity="0.72" />
          <stop offset="100%" stop-color="#ff6b24" stop-opacity="0.34" />
        </radialGradient>
      </defs>
      ${ringsSvg}
      ${axesSvg}
      <polygon points="${dataPolygon}" fill="url(#${gradId})" stroke="#ff9f2e" stroke-width="2" stroke-linejoin="round" />
      ${vertexDots}
      ${labelsSvg}
    </svg>
  `;
}

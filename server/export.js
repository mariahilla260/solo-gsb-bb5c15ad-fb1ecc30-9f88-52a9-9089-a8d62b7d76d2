'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Geom = require('../shared/geometry.js');
const { REPORT_DIR } = require('./db.js');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pointsToPath(points) {
  return 'M ' + points.map((p) =>
    `${(Math.round(p.x * 100) / 100)},${(Math.round(p.y * 100) / 100)}`
  ).join(' L ') + ' Z';
}

function cellColor(i) {
  return `hsl(${(i * 67) % 360}, 80%, 45%)`;
}

// 选一个不超过图宽 60% 的"好看"标尺长度（微米）
function pickScaleBar(report) {
  const scale = JSON.parse(report.scale_json);
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const maxPx = report.width * 0.6;
  let barUm = steps[0];
  for (const s of steps) {
    if (s / scale.umPerPixel <= maxPx) barUm = s;
    else break;
  }
  return { barUm, barPx: barUm / scale.umPerPixel };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function reportRows(report) {
  const results = JSON.parse(report.results_json);
  const scale = JSON.parse(report.scale_json);
  return results.map((r) => ({
    report_id: report.id,
    title: report.title,
    created_at: report.created_at,
    published_draft_version: report.version,
    cell: r.label,
    holes: r.holeCount,
    area_um2: r.areaUm2.toFixed(6),
    perimeter_um: r.perimeterUm.toFixed(6),
    scale_um_per_px: scale.umPerPixel.toFixed(12),
    image_width_px: report.width,
    image_height_px: report.height
  }));
}

const CSV_COLUMNS = [
  'report_id', 'title', 'created_at', 'published_draft_version',
  'cell', 'holes', 'area_um2', 'perimeter_um',
  'scale_um_per_px', 'image_width_px', 'image_height_px'
];

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // UTF-8 BOM，便于 Excel 打开
}

function reportCsv(report) {
  return toCsv(reportRows(report));
}

function combinedCsv(reports) {
  return toCsv(reports.flatMap(reportRows));
}

async function renderAnnotatedPng(report) {
  const w = report.width;
  const h = report.height;
  const cells = JSON.parse(report.cells_json);

  const imgBuf = fs.readFileSync(path.join(REPORT_DIR, report.image_file));

  const stroke = Math.max(2, Math.round(w / 450));
  const fontSize = Math.max(14, Math.round(w / 55));
  const smallFont = Math.max(11, Math.round(w / 80));

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);

  cells.forEach((cell, i) => {
    const color = cellColor(i);
    parts.push(`<path d="${pointsToPath(cell.points)}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round"/>`);
    for (const hole of cell.holes || []) {
      parts.push(`<path d="${pointsToPath(hole.points)}" fill="#000000" fill-opacity="0.18" stroke="#ff2d2d" stroke-width="${Math.max(1.5, stroke * 0.7)}" stroke-dasharray="${Math.max(5, stroke * 3)},${Math.max(3, stroke * 1.5)}" stroke-linejoin="round"/>`);
    }
  });

  // 编号标签
  cells.forEach((cell, i) => {
    const c = Geom.centroid(cell.points);
    parts.push(
      `<text x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="WenQuanYi Zen Hei, Noto Sans CJK SC, DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#fff" stroke="#000" stroke-width="${Math.max(2, fontSize / 5)}" paint-order="stroke">${i + 1}</text>`
    );
    (cell.holes || []).forEach((hole, hi) => {
      const hc = Geom.centroid(hole.points);
      parts.push(
        `<text x="${hc.x.toFixed(1)}" y="${hc.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="WenQuanYi Zen Hei, Noto Sans CJK SC, DejaVu Sans, sans-serif" font-size="${smallFont}" fill="#ffd400" stroke="#000" stroke-width="${Math.max(1.5, smallFont / 6)}" paint-order="stroke">${i + 1}.${hi + 1}</text>`
      );
    });
  });

  // 标题
  parts.push(
    `<text x="${fontSize}" y="${fontSize * 1.6}" font-family="WenQuanYi Zen Hei, Noto Sans CJK SC, DejaVu Sans, sans-serif" font-size="${fontSize * 1.15}" ` +
    `font-weight="bold" fill="#fff" stroke="#000" stroke-width="${Math.max(2, fontSize / 6)}" paint-order="stroke">${xmlEscape(report.title)}</text>`
  );

  // 比例尺（左下角）
  const { barUm, barPx } = pickScaleBar(report);
  const bx = fontSize * 1.2;
  const by = h - fontSize * 2.2;
  const bh = Math.max(6, Math.round(fontSize * 0.5));
  parts.push(
    `<rect x="${bx - stroke}" y="${by - stroke}" width="${barPx + 2 * stroke}" height="${bh + 2 * stroke}" fill="#000" opacity="0.45"/>`
  );
  parts.push(
    `<rect x="${bx}" y="${by}" width="${barPx}" height="${bh}" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(1, stroke * 0.6)}"/>`
  );
  parts.push(
    `<text x="${bx + barPx / 2}" y="${by - smallFont * 0.4}" text-anchor="middle" font-family="WenQuanYi Zen Hei, Noto Sans CJK SC, DejaVu Sans, sans-serif" ` +
    `font-size="${smallFont}" font-weight="bold" fill="#fff" stroke="#000" stroke-width="${Math.max(1.5, smallFont / 6)}" paint-order="stroke">${barUm} µm</text>`
  );

  parts.push('</svg>');

  const overlay = Buffer.from(parts.join(''));

  return sharp(imgBuf)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

module.exports = { renderAnnotatedPng, reportCsv, combinedCsv };

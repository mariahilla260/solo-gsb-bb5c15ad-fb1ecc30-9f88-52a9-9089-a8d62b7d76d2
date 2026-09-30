'use strict';

const archiver = require('archiver');

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function round(v, n = 4) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// 单份报告的测量 CSV（UTF-8 BOM，便于 Excel 直接打开）
function buildReportCsv(report) {
  const calib = report.calib;
  const header = [
    '报告ID', '报告标题', '图片文件名', '图片宽(px)', '图片高(px)',
    '定标点1 X(px)', '定标点1 Y(px)', '定标点2 X(px)', '定标点2 Y(px)',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ];
  const rows = [header];
  const c = calib || {};
  const base = [
    report.id, report.title, report.filename, report.width, report.height,
    c.p1 ? round(c.p1.x, 2) : '', c.p1 ? round(c.p1.y, 2) : '',
    c.p2 ? round(c.p2.x, 2) : '', c.p2 ? round(c.p2.y, 2) : '',
    c.distanceUm ?? '', c.scale ? round(c.scale, 6) : ''
  ];
  for (const cell of report.cells) {
    rows.push([
      ...base,
      cell.name || '',
      (cell.holes || []).length,
      round(cell.areaUm2),
      round(cell.perimeterUm)
    ]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 多份报告汇总 CSV
function buildCombinedCsv(reports) {
  const rows = [[
    '报告ID', '报告标题', '发布时间', '草稿版本', '图片文件名',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ]];
  for (const report of reports) {
    const c = report.calib || {};
    for (const cell of report.cells) {
      rows.push([
        report.id, report.title, report.createdAt, report.draftVersion, report.filename,
        c.distanceUm ?? '', c.scale ? round(c.scale, 6) : '',
        cell.name || '', (cell.holes || []).length,
        round(cell.areaUm2), round(cell.perimeterUm)
      ]);
    }
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

async function streamZip(reports, pngByName, res) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const names = new Set();
  const uniq = (n) => {
    let name = n; let k = 1;
    while (names.has(name)) name = n.replace(/(\.[^.]*)?$/, `_${k}$1`), k++;
    names.add(name);
    return name;
  };

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="reports.zip"');
  archive.on('error', (err) => { res.destroy(err); });
  archive.pipe(res);

  const combined = [];
  for (const r of reports) {
    const base = uniq(`${r.title || r.id}`.replace(/[\\/:*?"<>|]+/g, '_'));
    archive.append(pngByName[r.id], { name: `${base}_标注.png` });
    archive.append(buildReportCsv(r), { name: `${base}_测量.csv` });
    combined.push(r);
  }
  archive.append(buildCombinedCsv(combined), { name: '汇总_测量.csv' });
  await archive.finalize();
}

module.exports = { buildReportCsv, buildCombinedCsv, streamZip };

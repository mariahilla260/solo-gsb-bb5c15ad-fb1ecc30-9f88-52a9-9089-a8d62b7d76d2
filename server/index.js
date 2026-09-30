'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { initDb } = require('./db');
const geo = require('./geometry');
const { renderAnnotatedPng } = require('./render');
const { buildReportCsv, buildCombinedCsv, streamZip } = require('./exporter');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = parseInt(process.env.PORT || '8080', 10);
const IMG_DIR = path.join(DATA_DIR, 'images');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');

const db = initDb(DATA_DIR);
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

// ---------- helpers ----------

function getImageOr404(id) {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateImage(row);
}

function hydrateImage(row) {
  return {
    id: row.id,
    filename: row.filename,
    width: row.width,
    height: row.height,
    version: row.version,
    calib: row.calib ? JSON.parse(row.calib) : null,
    cells: JSON.parse(row.cells),
    published: !!row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateReport(row) {
  return {
    id: row.id,
    imageId: row.image_id,
    draftVersion: row.draft_version,
    title: row.title,
    filename: row.filename,
    width: row.width,
    height: row.height,
    calib: JSON.parse(row.calib),
    cells: JSON.parse(row.cells),
    createdAt: row.created_at
  };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// 校验客户端携带的草稿版本；过期返回 null（调用方回 409）
function checkVersion(img, version) {
  return Number.isInteger(version) && version === img.version;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
function roundPoint(p) { return { x: round3(p.x), y: round3(p.y) }; }

// 重算整份草稿中所有细胞的测量值（未定标时结果为 null）
function recompute(cells, calib) {
  const scale = calib ? calib.scale : null;
  return cells.map((c) => {
    if (scale === null) {
      return { ...c, areaUm2: null, perimeterUm: null };
    }
    const m = geo.measureCell(c.outer, c.holes, scale);
    return { ...c, areaUm2: m.areaUm2, perimeterUm: m.perimeterUm };
  });
}

// ---------- 图片 ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: IMG_DIR,
    filename: (_req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype];
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('仅支持 PNG / JPEG / WebP 格式的图片'));
    }
    cb(null, true);
  }
});

app.get('/api/images', (_req, res) => {
  const rows = db.prepare('SELECT * FROM images ORDER BY created_at DESC').all();
  res.json(rows.map(hydrateImage));
});

app.post('/api/images', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return badRequest(res, err.message);
    if (!req.file) return badRequest(res, '缺少上传文件（字段名须为 image）');
    const filePath = path.join(IMG_DIR, req.file.filename);
    let meta;
    try {
      meta = await sharp(filePath).metadata();
    } catch {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '图片文件已损坏或格式无法识别');
    }
    if (!meta.width || !meta.height) {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '无法读取图片尺寸');
    }
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO images (id, filename, stored_name, mime, width, height)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, req.file.originalname, req.file.filename, req.file.mimetype, meta.width, meta.height);
    res.status(201).json(getImageOr404(id));
  });
});

app.get('/api/images/:id', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  res.json(img);
});

app.get('/api/images/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '图片不存在' });
  res.sendFile(path.join(IMG_DIR, row.stored_name));
});

// ---------- 定标 ----------

app.put('/api/images/:id/calibration', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const { p1, p2, distanceUm } = req.body || {};
  const numErr = (m) => badRequest(res, m);
  if (!p1 || !p2 || typeof p1.x !== 'number' || typeof p1.y !== 'number' ||
      typeof p2.x !== 'number' || typeof p2.y !== 'number' ||
      !Number.isFinite(p1.x) || !Number.isFinite(p1.y) ||
      !Number.isFinite(p2.x) || !Number.isFinite(p2.y)) {
    return numErr('标尺无效：必须在原图上选择两个像素点 p1、p2（坐标 {x, y}）');
  }
  if (p1.x < 0 || p1.y < 0 || p2.x < 0 || p2.y < 0 ||
      p1.x > img.width || p1.y > img.height || p2.x > img.width || p2.y > img.height) {
    return numErr(`标尺无效：定标点越出图片范围（图片尺寸 ${img.width}×${img.height} 像素）`);
  }
  const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (pxDist < 1) {
    return numErr('标尺无效：两个定标点必须是不同的像素点（间距至少 1 像素）');
  }
  const dist = Number(distanceUm);
  if (!Number.isFinite(dist) || dist <= 0) {
    return numErr('标尺无效：实际距离必须是大于 0 的数值（微米）');
  }

  const calib = {
    p1: roundPoint(p1), p2: roundPoint(p2),
    distanceUm: dist,
    scale: dist / pxDist // μm / px
  };

  // 重新定标：草稿中的全部测量按新比例重算
  const cells = recompute(img.cells, calib);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE images SET calib = ?, cells = ?, version = version + 1,
                updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(calib), JSON.stringify(cells), img.id);
  });
  tx();
  res.json(getImageOr404(img.id));
});

// ---------- 轮廓（整批替换，任一对象非法则整次修改不生效） ----------

app.put('/api/images/:id/contours', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const rawCells = req.body.cells;
  if (!Array.isArray(rawCells)) return badRequest(res, '轮廓数据无效：cells 必须是数组');

  let next;
  try {
    // 先全部校验，任何一个细胞/孔洞失败都会抛出，数据库不发生任何写入
    next = rawCells.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`第 ${i + 1} 个细胞数据格式错误`);
      const { outer, holes } = geo.validateCell({ ...c, _seq: i + 1 }, img.width, img.height);
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, 50) : '';
      return {
        id: typeof c.id === 'string' && c.id ? c.id : crypto.randomUUID(),
        name,
        outer: outer.map(roundPoint),
        holes: holes.map((h) => h.map(roundPoint))
      };
    });
  } catch (e) {
    return badRequest(res, e.message);
  }

  next = recompute(next, img.calib);

  db.prepare(`UPDATE images SET cells = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(next), img.id);
  res.json(getImageOr404(img.id));
});

// ---------- 发布（乐观并发：携带读取时草稿版本） ----------

app.post('/api/images/:id/publish', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `发布被拒绝：草稿已过期（携带版本 ${req.body.version}，当前版本 ${img.version}）。请重新读取最新草稿后再发布`, currentVersion: img.version });
  }
  if (!img.calib) return badRequest(res, '尚不能发布：请先完成标尺定标');
  if (img.cells.length === 0) return badRequest(res, '尚不能发布：请至少圈出一个细胞外轮廓');
  for (const c of img.cells) {
    if (typeof c.areaUm2 !== 'number') return badRequest(res, '尚不能发布：存在未按当前标尺计算测量值的轮廓，请重新保存轮廓');
  }

  const reportId = crypto.randomUUID();
  const title = (typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : `${img.filename.replace(/\.[^.]+$/, '')} 报告 ${new Date().toISOString().slice(0, 10)}`;

  const srcRow = db.prepare('SELECT stored_name FROM images WHERE id = ?').get(img.id);
  const snapExt = path.extname(srcRow.stored_name);
  const snapName = `${reportId}${snapExt}`;
  // 先固化图片快照：报告永远保留发布当时的图片文件
  fs.copyFileSync(path.join(IMG_DIR, srcRow.stored_name), path.join(SNAP_DIR, snapName));

  try {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO reports
                  (id, image_id, draft_version, title, filename, snapshot_name, width, height, calib, cells)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(reportId, img.id, img.version, title, img.filename, snapName,
             img.width, img.height, JSON.stringify(img.calib), JSON.stringify(img.cells));
      db.prepare(`UPDATE images SET published = 1, version = version + 1,
                  updated_at = datetime('now') WHERE id = ?`).run(img.id);
    });
    tx();
  } catch (e) {
    fs.rmSync(path.join(SNAP_DIR, snapName), { force: true });
    throw e;
  }

  res.status(201).json({
    report: hydrateReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId)),
    image: getImageOr404(img.id)
  });
});

// ---------- 报告 ----------

app.get('/api/reports', (_req, res) => {
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  res.json(rows.map(hydrateReport));
});

function getReportOr404(id) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return row ? hydrateReport(row) : null;
}

app.get('/api/reports/:id', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.json(report);
});

app.get('/api/reports/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  res.sendFile(path.join(SNAP_DIR, row.snapshot_name));
});

app.get('/api/reports/:id/png', async (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  try {
    const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), {
      width: row.width, height: row.height,
      calib: JSON.parse(row.calib), cells: JSON.parse(row.cells)
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${row.id}_annotated.png"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: `标注图片生成失败：${e.message}` });
  }
});

app.get('/api/reports/:id/csv', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}_measurements.csv"`);
  res.send(buildReportCsv(report));
});

// 多份选定报告导出：{ ids: string[], format: 'csv' | 'png' | 'zip' }
app.post('/api/reports/export', async (req, res) => {
  const { ids, format } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, '请至少选择一份报告');
  const reports = [];
  for (const id of ids.slice(0, 50)) {
    const r = getReportOr404(id);
    if (!r) return badRequest(res, `报告 ${id} 不存在或已被删除`);
    reports.push(r);
  }

  try {
    if (format === 'csv') {
      if (reports.length === 1) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_measurements.csv"`);
        return res.send(buildReportCsv(reports[0]));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="measurements_combined.csv"');
      return res.send(buildCombinedCsv(reports));
    }

    if (format === 'png') {
      if (reports.length !== 1) return badRequest(res, 'PNG 导出仅支持单份报告，多份请选择 ZIP');
      const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(reports[0].id);
      const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), reports[0]);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_annotated.png"`);
      return res.send(buf);
    }

    if (format === 'zip') {
      const pngByName = {};
      for (const r of reports) {
        const row = db.prepare('SELECT snapshot_name FROM reports WHERE id = ?').get(r.id);
        pngByName[r.id] = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), r);
      }
      return streamZip(reports, pngByName, res);
    }

    return badRequest(res, "format 必须是 'csv'、'png' 或 'zip'");
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `导出失败：${e.message}` });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

app.listen(PORT, () => {
  console.log(`PhytoMeasure 已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});

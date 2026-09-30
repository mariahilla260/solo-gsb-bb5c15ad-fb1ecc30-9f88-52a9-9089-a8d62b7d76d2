'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');

const { db, UPLOAD_DIR, REPORT_DIR } = require('./db.js');
const DraftValidate = require('../shared/validation.js');
const { renderAnnotatedPng, reportCsv, combinedCsv } = require('./export.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '50', 10);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// 前后端共享几何/校验代码
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 }
});

// ---------- 草稿读写 ----------

function getImageOr404(id) {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!img) throw new HttpError(404, 'not_found', `图片 #${id} 不存在`);
  return img;
}

function getDraftRow(imageId) {
  return db.prepare('SELECT * FROM drafts WHERE image_id = ?').get(imageId);
}

function buildDraftPayload(img, row) {
  const scale = row.scale_json ? JSON.parse(row.scale_json) : null;
  return {
    imageId: img.id,
    width: img.width,
    height: img.height,
    version: row.version,
    scale,
    cells: JSON.parse(row.cells_json),
    results: scale ? computeResultsFromRow(row) : null,
    updatedAt: row.updated_at
  };
}

function computeResultsFromRow(row) {
  const scale = JSON.parse(row.scale_json);
  const cells = JSON.parse(row.cells_json);
  const normalized = cells.map((c) => ({
    label: c.label,
    points: c.points,
    holes: (c.holes || []).map((h) => ({ label: h.label, points: h.points }))
  }));
  return DraftValidate.computeResults(scale, normalized);
}

function sendValidationErrors(res, errors, status) {
  return res.status(status || 422).json({
    error: 'validation_failed',
    message: `存在 ${errors.length} 个无效对象，整次修改未生效`,
    errors
  });
}

// ---------- 图片 ----------

app.get('/api/images', wrap((req, res) => {
  const rows = db.prepare('SELECT id, original_name, width, height, created_at FROM images ORDER BY id DESC').all();
  res.json(rows.map((r) => ({
    ...r,
    hasScale: !!db.prepare('SELECT scale_json FROM drafts WHERE image_id = ? AND scale_json IS NOT NULL').get(r.id)
  })));
}));

app.post('/api/images', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: 'upload_failed',
        message: err.code === 'LIMIT_FILE_SIZE'
          ? `图片过大，上限为 ${MAX_UPLOAD_MB} MB`
          : `上传失败：${err.message}`
      });
    }
    (async () => {
      if (!req.file) throw new HttpError(400, 'no_file', '未收到上传文件，请选择一张显微图片（PNG/JPEG/WebP）');
      if (!ALLOWED_MIME.has(req.file.mimetype)) {
        throw new HttpError(415, 'unsupported_media_type',
          `不支持的图片类型 ${req.file.mimetype}，仅支持 image/png、image/jpeg、image/webp`);
      }
      let meta;
      try {
        meta = await sharp(req.file.buffer).metadata();
      } catch (e) {
        throw new HttpError(422, 'bad_image', '无法解码图片内容，文件可能已损坏或不是真正的图片');
      }
      if (!meta.width || !meta.height) {
        throw new HttpError(422, 'bad_image', '无法读取图片尺寸，文件可能已损坏');
      }
      const filename = crypto.randomBytes(16).toString('hex') + EXT_BY_MIME[req.file.mimetype];
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);

      const tx = db.transaction(() => {
        const info = db.prepare(`
          INSERT INTO images (filename, original_name, mime, width, height)
          VALUES (?, ?, ?, ?, ?)
        `).run(filename, req.file.originalname, req.file.mimetype, meta.width, meta.height);
        db.prepare('INSERT INTO drafts (image_id, version, scale_json, cells_json) VALUES (?, 1, NULL, ?)')
          .run(info.lastInsertRowid, '[]');
        return info.lastInsertRowid;
      });
      const id = tx();
      const img = getImageOr404(id);
      res.status(201).json(buildDraftPayload(img, getDraftRow(id)));
    })().catch(next);
  });
});

app.get('/api/images/:id', wrap((req, res) => {
  const img = getImageOr404(Number(req.params.id));
  res.json(buildDraftPayload(img, getDraftRow(img.id)));
}));

app.get('/api/images/:id/file', wrap((req, res) => {
  const img = getImageOr404(Number(req.params.id));
  res.sendFile(path.join(UPLOAD_DIR, img.filename));
}));

// ---------- 草稿：整单替换 + 版本乐观锁 ----------

app.put('/api/images/:id/draft', wrap((req, res) => {
  const img = getImageOr404(Number(req.params.id));
  const body = req.body || {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new HttpError(400, 'bad_version', '请求必须携带读取时的草稿版本 expectedVersion（正整数）');
  }

  const { errors, scale, cells, valid } = DraftValidate.validate(
    { scale: body.scale, cells: body.cells || [] },
    img.width, img.height
  );
  if (!valid) return sendValidationErrors(res, errors);

  const row = getDraftRow(img.id);
  if (row.version !== expectedVersion) {
    // 过期请求：拒绝覆盖
    throw new HttpError(409, 'version_conflict',
      `草稿已被其他操作更新（当前版本 ${row.version}，请求基于版本 ${expectedVersion}），请重新读取后再提交`,
      { currentVersion: row.version }
    );
  }

  // 规范化后的标签/坐标落库；整单在一个事务内替换
  const scaleOut = scale ? {
    p1: scale.p1, p2: scale.p2, um: scale.um,
    pixelDist: scale.pixelDist, umPerPixel: scale.umPerPixel
  } : null;
  const cellsOut = cells.map((cell) => ({
    label: cell.label,
    points: cell.points,
    holes: cell.holes.map((h) => ({ label: h.label, points: h.points }))
  }));

  const nextVersion = row.version + 1;
  db.prepare(`
    UPDATE drafts
       SET version = ?, scale_json = ?, cells_json = ?, updated_at = datetime('now')
     WHERE image_id = ? AND version = ?
  `).run(nextVersion, JSON.stringify(scaleOut), JSON.stringify(cellsOut), img.id, expectedVersion);

  res.json(buildDraftPayload(getImageOr404(img.id), getDraftRow(img.id)));
}));

// ---------- 发布报告（不可变快照） ----------

app.post('/api/images/:id/publish', wrap(async (req, res) => {
  const img = getImageOr404(Number(req.params.id));
  const body = req.body || {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new HttpError(400, 'bad_version', '发布请求必须携带读取时的草稿版本 expectedVersion（正整数）');
  }

  const row = getDraftRow(img.id);
  if (row.version !== expectedVersion) {
    throw new HttpError(409, 'version_conflict',
      `草稿已被其他操作更新（当前版本 ${row.version}，请求基于版本 ${expectedVersion}），请重新读取后再发布`,
      { currentVersion: row.version }
    );
  }
  if (!row.scale_json) {
    return sendValidationErrors(res, [
      { object: '标尺', message: '尚未完成有效定标，无法发布：请先在原图上选取两个不同像素点并填写实际微米距离' }
    ]);
  }

  const draft = { scale: JSON.parse(row.scale_json), cells: JSON.parse(row.cells_json) };
  const { errors, scale, cells, valid } = DraftValidate.validate(draft, img.width, img.height, { requireScale: true });
  if (!valid) return sendValidationErrors(res, errors);

  const results = DraftValidate.computeResults(scale, cells);
  const cellsOut = cells.map((cell) => ({
    label: cell.label,
    points: cell.points,
    holes: cell.holes.map((h) => ({ label: h.label, points: h.points }))
  }));
  const title = typeof body.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 200)
    : `${img.original_name} v${expectedVersion}`;

  // 复制发布时刻的图片为独立快照
  const ext = path.extname(img.filename) || '.png';
  const reportImage = crypto.randomBytes(16).toString('hex') + ext;
  fs.copyFileSync(path.join(UPLOAD_DIR, img.filename), path.join(REPORT_DIR, reportImage));

  const info = db.prepare(`
    INSERT INTO reports (image_id, version, title, width, height, image_file, scale_json, cells_json, results_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    img.id, expectedVersion, title, img.width, img.height, reportImage,
    JSON.stringify(scale), JSON.stringify(cellsOut), JSON.stringify(results)
  );

  res.status(201).json(reportPayload(getReportOr404(info.lastInsertRowid)));
}));

// ---------- 报告 ----------

function getReportOr404(id) {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, 'not_found', `报告 #${id} 不存在`);
  return r;
}

function reportPayload(r) {
  return {
    id: r.id,
    imageId: r.image_id,
    version: r.version,
    title: r.title,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
    scale: JSON.parse(r.scale_json),
    cells: JSON.parse(r.cells_json),
    results: JSON.parse(r.results_json)
  };
}

app.get('/api/reports', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT id, image_id, version, title, width, height, created_at
    FROM reports ORDER BY id DESC
  `).all();
  res.json(rows.map((r) => ({
    id: r.id, imageId: r.image_id, version: r.version, title: r.title,
    width: r.width, height: r.height, createdAt: r.created_at
  })));
}));

app.get('/api/reports/:id', wrap((req, res) => {
  res.json(reportPayload(getReportOr404(Number(req.params.id))));
}));

app.get('/api/reports/:id/image', wrap((req, res) => {
  const r = getReportOr404(Number(req.params.id));
  res.sendFile(path.join(REPORT_DIR, r.image_file));
}));

app.get('/api/reports/:id/annotated.png', wrap(async (req, res) => {
  const r = getReportOr404(Number(req.params.id));
  const png = await renderAnnotatedPng(r);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition',
    `attachment; filename="report-${r.id}-annotated.png"`);
  res.send(png);
}));

app.get('/api/reports/:id/measurements.csv', wrap((req, res) => {
  const r = getReportOr404(Number(req.params.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${r.id}-measurements.csv"`);
  res.send(reportCsv(r));
}));

app.get('/api/reports/export/zip', wrap(async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger);
  if (!ids.length) throw new HttpError(400, 'bad_ids', '请通过 ids 指定至少一个报告，例如 /api/reports/export/zip?ids=1,2');

  const reports = [];
  for (const id of ids) {
    try { reports.push(getReportOr404(id)); }
    catch (e) { if (e.status === 404) throw new HttpError(404, 'not_found', `报告 #${id} 不存在，无法导出`); throw e; }
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="reports-export.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (e) => { res.destroy(e); });
  archive.pipe(res);

  for (const r of reports) {
    const base = `report-${r.id}`;
    archive.append(r.image_file ? fs.createReadStream(path.join(REPORT_DIR, r.image_file)) : Buffer.alloc(0),
      { name: `${base}/original${path.extname(r.image_file)}` });
    archive.append(await renderAnnotatedPng(r), { name: `${base}/annotated.png` });
    archive.append(reportCsv(r), { name: `${base}/measurements.csv` });
    archive.append(JSON.stringify(reportPayload(r), null, 2), { name: `${base}/snapshot.json` });
  }
  archive.append(combinedCsv(reports), { name: 'all-measurements.csv' });
  await archive.finalize();
}));

// ---------- 错误处理 ----------

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `接口不存在：${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    const payload = { error: err.code, message: err.message };
    if (err.extra) Object.assign(payload, err.extra);
    return res.status(err.status).json(payload);
  }
  console.error(err);
  res.status(500).json({ error: 'internal', message: '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`植物显微切片测量应用已启动： http://localhost:${PORT}`);
});

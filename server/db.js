'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const REPORT_DIR = path.join(DATA_DIR, 'reports');

for (const d of [DATA_DIR, UPLOAD_DIR, REPORT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,              -- uploads/ 下的存储文件名
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 每张图片一份草稿（整单替换，version 乐观锁）
CREATE TABLE IF NOT EXISTS drafts (
  image_id      INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1,
  scale_json    TEXT,                       -- 含 p1/p2/um/pixelDist/umPerPixel
  cells_json    TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id      INTEGER REFERENCES images(id) ON DELETE SET NULL,
  version       INTEGER NOT NULL,           -- 发布时携带的草稿版本
  title         TEXT NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  image_file    TEXT NOT NULL,              -- reports/ 下发布时刻的图片快照
  scale_json    TEXT NOT NULL,
  cells_json    TEXT NOT NULL,
  results_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = { db, DATA_DIR, DB_PATH, UPLOAD_DIR, REPORT_DIR };

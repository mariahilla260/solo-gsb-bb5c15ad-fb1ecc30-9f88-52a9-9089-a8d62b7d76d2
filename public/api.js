'use strict';

async function jsonOrThrow(res) {
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const API = {
  async listImages() {
    return jsonOrThrow(await fetch('/api/images'));
  },
  async uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    return jsonOrThrow(await fetch('/api/images', { method: 'POST', body: fd }));
  },
  async getImage(id) {
    return jsonOrThrow(await fetch(`/api/images/${id}`));
  },
  async saveCalibration(id, version, p1, p2, distanceUm) {
    return jsonOrThrow(await fetch(`/api/images/${id}/calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, p1, p2, distanceUm })
    }));
  },
  async saveContours(id, version, cells) {
    return jsonOrThrow(await fetch(`/api/images/${id}/contours`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, cells })
    }));
  },
  async publish(id, version, title) {
    return jsonOrThrow(await fetch(`/api/images/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, title })
    }));
  },
  async listReports() {
    return jsonOrThrow(await fetch('/api/reports'));
  },
  async getReport(id) {
    return jsonOrThrow(await fetch(`/api/reports/${id}`));
  },
  exportCsvUrl(id) { return `/api/reports/${id}/csv`; },
  exportPngUrl(id) { return `/api/reports/${id}/png`; }
};

window.API = API;

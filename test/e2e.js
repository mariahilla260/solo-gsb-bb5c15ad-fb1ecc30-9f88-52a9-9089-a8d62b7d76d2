'use strict';
// 端到端冒烟测试：上传→定标→保存→冲突→校验失败→发布→报告→导出
const fs = require('fs');
const sharp = require('sharp');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

async function j(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opt);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, res };
}

(async () => {
  // 1. 准备并上传图片
  const png = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 40, g: 80, b: 40 } }
  }).png().toBuffer();
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'sample.png');
  let res = await fetch(BASE + '/api/images', { method: 'POST', body: fd });
  let d = await res.json();
  check(res.status === 201, `上传图片 201 (id=${d.imageId})`);
  check(d.version === 1 && d.cells.length === 0 && d.scale === null, '初始草稿 v1、无标尺无轮廓');
  const id = d.imageId;

  // 2. 未定标直接保存轮廓（应允许）
  const squareCell = {
    points: [
      { x: 100, y: 100 }, { x: 400, y: 100 },
      { x: 400, y: 400 }, { x: 100, y: 400 }
    ],
    holes: [
      { points: [ { x: 200, y: 200 }, { x: 260, y: 200 }, { x: 260, y: 260 }, { x: 200, y: 260 } ] }
    ]
  };
  let r = await j('PUT', `/api/images/${id}/draft`, { expectedVersion: 1, scale: null, cells: [squareCell] });
  check(r.status === 200, '未定标也可保存纯轮廓草稿');
  check(r.data.version === 2, '版本递增到 v2');
  check(r.data.results === null, '无标尺时不计算结果');

  // 3. 过期版本保存 → 409
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 1, scale: null, cells: []
  });
  check(r.status === 409 && r.data.currentVersion === 2, '过期版本被拒绝（409）');

  // 4. 自交轮廓 → 422，整次修改不生效，版本不变
  const bowtie = { points: [
    { x: 100, y: 100 }, { x: 400, y: 400 },
    { x: 400, y: 100 }, { x: 100, y: 400 }
  ], holes: [] };
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 2,
    scale: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, um: 50 },
    cells: [bowtie]
  });
  check(r.status === 422, '自交轮廓返回 422');
  check(!!r.data.errors && r.data.errors[0].message.includes('自交'), `指出对象：${r.data && r.data.errors && r.data.errors[0].object}`);
  const still = await j('GET', `/api/images/${id}`);
  check(still.data.version === 2 && still.data.cells.length === 1, '422 后草稿保持原状（整次修改不生效）');

  // 5. 无效标尺（重合点）→ 422
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 2,
    scale: { p1: { x: 5, y: 5 }, p2: { x: 5, y: 5 }, um: 10 },
    cells: [squareCell]
  });
  check(r.status === 422 && r.data.errors.some((e) => e.object === '标尺'), '无效标尺（重合点）422');

  // 6. 孔洞越出细胞 → 422
  const badHole = {
    points: squareCell.points,
    holes: [{ points: [ { x: 390, y: 390 }, { x: 450, y: 390 }, { x: 450, y: 450 }, { x: 390, y: 450 } ] }]
  };
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 2,
    scale: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, um: 50 },
    cells: [badHole]
  });
  check(r.status === 422 && r.data.errors.some((e) => e.message.includes('严格位于')), '孔洞越出细胞 422');

  // 7. 孔洞互相接触 → 422
  const touching = {
    points: squareCell.points,
    holes: [
      { points: [ { x: 200, y: 200 }, { x: 240, y: 200 }, { x: 240, y: 240 }, { x: 200, y: 240 } ] },
      { points: [ { x: 240, y: 200 }, { x: 280, y: 200 }, { x: 280, y: 240 }, { x: 240, y: 240 } ] }
    ]
  };
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 2,
    scale: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, um: 50 },
    cells: [touching]
  });
  check(r.status === 422 && r.data.errors.some((e) => e.message.includes('相互接触')), '孔洞相互接触 422');

  // 8. 合法保存 + 定标（0.5 um/px）
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 2,
    scale: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, um: 50 },
    cells: [squareCell]
  });
  check(r.status === 200, '合法定标+轮廓保存 200');
  // 外 300x300=90000 px², 洞 60x60=3600 px² → 净 86400 px² ×0.25 = 21600 µm²
  // 周长 (1200+240)×0.5 = 720 µm
  const res0 = r.data.results[0];
  check(Math.abs(res0.areaUm2 - 21600) < 1e-6, `净面积 21600 µm²（实际 ${res0.areaUm2}）`);
  check(Math.abs(res0.perimeterUm - 720) < 1e-6, `总周长 720 µm（实际 ${res0.perimeterUm}）`);

  // 9. 重新定标（100px=25µm → 0.25 um/px）：像素形状不变，结果按新比例重算
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 3,
    scale: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, um: 25 },
    cells: [squareCell]
  });
  check(r.status === 200, '重新定标保存 200');
  check(Math.abs(r.data.results[0].areaUm2 - 5400) < 1e-6, `重定标后面积 5400 µm²（实际 ${r.data.results[0].areaUm2}）`);
  check(Math.abs(r.data.results[0].perimeterUm - 360) < 1e-6, `重定标后周长 360 µm（实际 ${r.data.results[0].perimeterUm}）`);

  // 10. 发布：过期版本 409
  r = await j('POST', `/api/images/${id}/publish`, { expectedVersion: 3, title: '过期发布' });
  check(r.status === 409, '过期发布请求 409');

  // 11. 正确版本发布
  r = await j('POST', `/api/images/${id}/publish`, { expectedVersion: 4, title: '叶片横切 01' });
  check(r.status === 201, `发布成功 201（报告 #${r.data && r.data.id}）`);
  const report = r.data;
  check(report.version === 4, '报告携带发布时草稿版本 v4');
  check(Math.abs(report.results[0].areaUm2 - 5400) < 1e-6, '报告冻结当时结果');

  // 12. 发布后再改草稿（重新定标），报告结果不变
  r = await j('PUT', `/api/images/${id}/draft`, {
    expectedVersion: 4,
    scale: { p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 }, um: 50 },
    cells: [squareCell]
  });
  check(r.status === 200, '发布后草稿可继续修改');
  const repAgain = await j('GET', `/api/reports/${report.id}`);
  check(Math.abs(repAgain.data.results[0].areaUm2 - 5400) < 1e-6 &&
        Math.abs(repAgain.data.scale.umPerPixel - 0.25) < 1e-12, '已发布报告保留原标尺与结果');

  // 13. 导出 PNG / CSV / ZIP
  let gr = await fetch(`${BASE}/api/reports/${report.id}/annotated.png`);
  const pngBuf = Buffer.from(await gr.arrayBuffer());
  check(gr.status === 200 && gr.headers.get('content-type') === 'image/png', '标注 PNG 200 image/png');
  const meta = await sharp(pngBuf).metadata();
  check(meta.width === 800 && meta.height === 600, `标注 PNG 尺寸 ${meta.width}x${meta.height}`);

  gr = await fetch(`${BASE}/api/reports/${report.id}/measurements.csv`);
  const csv = await gr.text();
  check(gr.status === 200 && csv.includes('area_um2') && csv.includes('5400.000000'), 'CSV 含表头与 5400 面积');

  gr = await fetch(`${BASE}/api/reports/export/zip?ids=${report.id}`);
  const zipBuf = Buffer.from(await gr.arrayBuffer());
  check(gr.status === 200 && zipBuf.length > 1000 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b, `ZIP 导出成功（${zipBuf.length} 字节）`);

  // 14. 不存在的资源
  r = await j('GET', '/api/images/99999');
  check(r.status === 404, '不存在图片 404');
  gr = await fetch(`${BASE}/api/reports/export/zip?ids=99999`);
  check(gr.status === 404, '导出不存在报告 404');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// 几何与校验模块的快速自测（node test/geometry.test.js）
const assert = require('assert');
const G = require('../shared/geometry.js');
const V = require('../shared/validation.js');

const W = 1000, H = 800;
const scale = { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, um: 50 }; // 0.5 um/px

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }

// 基础度量
const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
assert.ok(Math.abs(G.ringAreaAbs(square) - 10000) < 1e-9);
assert.ok(Math.abs(G.ringLength(square) - 400) < 1e-9);
pass += 2;

// 测量：100x100 细胞，内有 20x20 孔洞，0.5um/px
const cell = {
  points: square,
  holes: [{ points: [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }] }]
};
const m = G.measureCell(cell, { umPerPixel: 0.5 });
assert.ok(Math.abs(m.areaUm2 - (10000 - 400) * 0.25) < 1e-9, 'area');   // 2400
assert.ok(Math.abs(m.perimeterUm - (400 + 80) * 0.5) < 1e-9, 'perimeter'); // 240
pass += 2;

// 自交检测：蝴蝶结
const bowtie = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
ok(G.checkSelfIntersection(bowtie, 'x'), 'bowtie self-intersects');

// 正常矩形不自交
ok(!G.checkSelfIntersection(square, 's'), 'square valid');

// 重合顶点
const dup = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
ok(G.checkSelfIntersection(dup, 'd'), 'duplicate vertex detected');

// 越界
let r = V.validate({ scale, cells: [{ points: square, holes: [] }, { points: [{ x: 900, y: 700 }, { x: 1001, y: 700 }, { x: 950, y: 750 }], holes: [] }] }, W, H);
ok(!r.valid && r.errors.some((e) => e.message.includes('越出')), 'out-of-bounds detected');

// 无效标尺：重合点
r = V.validate({ scale: { p1: { x: 1, y: 1 }, p2: { x: 1, y: 1 }, um: 10 }, cells: [] }, W, H);
ok(!r.valid && r.errors.some((e) => e.object === '标尺' && e.message.includes('重合')), 'coincident scale points');

// 无效标尺：微米 <= 0
r = V.validate({ scale: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, um: 0 }, cells: [] }, W, H);
ok(!r.valid, 'non-positive um');

// 孔洞触碰细胞边界（共边）→ 严格包含失败
r = V.validate({
  scale,
  cells: [{
    points: square,
    holes: [{ points: [{ x: 50, y: 90 }, { x: 70, y: 90 }, { x: 70, y: 100 }, { x: 50, y: 100 }] }]
  }]
}, W, H);
ok(!r.valid && r.errors.some((e) => e.message.includes('严格位于')), 'hole touching outer ring rejected');

// 孔洞越出细胞
r = V.validate({
  scale,
  cells: [{
    points: square,
    holes: [{ points: [{ x: 90, y: 90 }, { x: 110, y: 90 }, { x: 110, y: 110 }, { x: 90, y: 110 }] }]
  }]
}, W, H);
ok(!r.valid && r.errors.some((e) => e.message.includes('严格位于')), 'hole outside cell rejected');

// 两个孔洞相切（共用一条边）→ 拒绝
r = V.validate({
  scale,
  cells: [{
    points: square,
    holes: [
      { points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }] },
      { points: [{ x: 30, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 30, y: 30 }] }
    ]
  }]
}, W, H);
ok(!r.valid && r.errors.some((e) => e.message.includes('相互接触')), 'touching holes rejected');

// 两个孔洞分离（1px 间隙）→ 通过
r = V.validate({
  scale,
  cells: [{
    points: square,
    holes: [
      { points: [{ x: 10, y: 10 }, { x: 29, y: 10 }, { x: 29, y: 29 }, { x: 10, y: 29 }] },
      { points: [{ x: 30, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 30, y: 30 }] }
    ]
  }]
}, W, H);
ok(r.valid, `disjoint holes accepted: ${r.errors.map((e) => e.message).join('; ')}`);

// 合法草稿 → 结果正确
r = V.validate({ scale, cells: [{ points: square, holes: [{ points: [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }] }] }] }, W, H);
ok(r.valid, 'valid draft');
const res = V.computeResults(r.scale, r.cells);
assert.ok(Math.abs(res[0].areaUm2 - 2400) < 1e-9 && Math.abs(res[0].perimeterUm - 240) < 1e-9);
pass++;

// 顶点过少
r = V.validate({ scale, cells: [{ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], holes: [] }] }, W, H);
ok(!r.valid && r.errors.some((e) => e.message.includes('至少需要 3 个顶点')), 'too few points');

console.log(`全部 ${pass} 项断言通过 ✓`);

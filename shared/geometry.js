/*
 * 共享几何模块：前后端同一份代码。
 * 所有坐标均为「图像像素坐标」，缩放/平移视图不会改变坐标与测量结果。
 * 坐标系：x 向右、y 向下，原点为图片左上角。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Geom = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // 浮点比较容差（像素）
  const EPS = 1e-6;

  function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function ringLength(points) {
    let len = 0;
    for (let i = 0; i < points.length; i++) {
      len += dist(points[i], points[(i + 1) % points.length]);
    }
    return len;
  }

  // 鞋带公式（有符号面积，像素²）
  function ringAreaAbs(points) {
    let s = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      s += p.x * q.y - q.x * p.y;
    }
    return Math.abs(s) / 2;
  }

  function centroid(points) {
    let a2 = 0, cx = 0, cy = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      const cross = p.x * q.y - q.x * p.y;
      a2 += cross;
      cx += (p.x + q.x) * cross;
      cy += (p.y + q.y) * cross;
    }
    const a6 = 3 * a2;
    if (Math.abs(a6) < 1e-12) {
      let x = 0, y = 0;
      for (const p of points) { x += p.x; y += p.y; }
      return { x: x / points.length, y: y / points.length };
    }
    return { x: cx / a6, y: cy / a6 };
  }

  // 点是否在环内：1=严格内部, 0=在边界上, -1=外部
  function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      if (pointOnSegment(p, a, b)) return 0;
      const intersect =
        ((b.y > p.y) !== (a.y > p.y)) &&
        (p.x < (a.x - b.x) * (p.y - b.y) / (a.y - b.y) + b.x);
      if (intersect) inside = !inside;
    }
    return inside ? 1 : -1;
  }

  function cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  // 点到线段距离（像素）
  function pointSegDistance(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const l2 = vx * vx + vy * vy;
    if (l2 < EPS * EPS) return dist(p, a);
    let t = (wx * vx + wy * vy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * vx, py = a.y + t * vy;
    return Math.sqrt((p.x - px) ** 2 + (p.y - py) ** 2);
  }

  function pointOnSegment(p, a, b) {
    return pointSegDistance(p, a, b) <= EPS;
  }

  // 两线段关系：'intersect'(交于内部) | 'overlap'(共线重叠/端点相接) | null
  // openEnds=true 时忽略 a==b、c==d 的闭合边端点比较（配合相交使用）
  function segmentRelation(a, b, c, d) {
    const r1 = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
    const r2 = cross(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y);
    const r3 = cross(d.x - c.x, d.y - c.y, a.x - c.x, a.y - c.y);
    const r4 = cross(d.x - c.x, d.y - c.y, b.x - c.x, b.y - c.y);

    const eps = EPS;
    if (Math.abs(r1) <= eps && Math.abs(r2) <= eps &&
        Math.abs(r3) <= eps && Math.abs(r4) <= eps) {
      // 共线：检查投影重叠（端点重合也算）
      const xOverlap = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <=
                       Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + eps;
      const yOverlap = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <=
                       Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + eps;
      if (xOverlap && yOverlap) return 'overlap';
      return null;
    }
    if (((r1 > eps && r2 < -eps) || (r1 < -eps && r2 > eps)) &&
        ((r3 > eps && r4 < -eps) || (r3 < -eps && r4 > eps))) {
      return 'intersect';
    }
    // 端点落在另一线段上（非共线）
    if (pointOnSegment(a, c, d) || pointOnSegment(b, c, d) ||
        pointOnSegment(c, a, b) || pointOnSegment(d, a, b)) {
      return 'overlap';
    }
    return null;
  }

  // 两线段最小距离（像素）
  function segmentDistance(a, b, c, d) {
    if (segmentRelation(a, b, c, d)) return 0;
    return Math.min(
      pointSegDistance(a, c, d), pointSegDistance(b, c, d),
      pointSegDistance(c, a, b), pointSegDistance(d, a, b)
    );
  }

  // 环自交检查。返回 null 或 {type:'duplicate'|'self-intersect', index, other?, message}
  function checkSelfIntersection(points, label) {
    const n = points.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (dist(points[i], points[j]) <= EPS) {
          return {
            type: 'duplicate', index: j, other: i,
            message: `${label} 存在重合顶点（顶点 #${i + 1} 与 #${j + 1}），轮廓不允许自交`
          };
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        // 相邻边共享顶点是合法的
        if ((i + 1) % n === j || (j + 1) % n === i) continue;
        const c = points[j], d = points[(j + 1) % n];
        const rel = segmentRelation(a, b, c, d);
        if (rel === 'intersect' || rel === 'overlap') {
          return {
            type: 'self-intersect', index: i, other: j,
            message: `${label} 自交：第 ${i + 1} 条边与第 ${j + 1} 条边相交或重合`
          };
        }
      }
    }
    return null;
  }

  // 内环是否严格位于外环内（不触碰外边界）
  function ringStrictlyInside(inner, outer) {
    for (const p of inner) {
      if (pointInRing(p, outer) !== 1) return false;
    }
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i], b = inner[(i + 1) % inner.length];
      for (let j = 0; j < outer.length; j++) {
        const c = outer[j], d = outer[(j + 1) % outer.length];
        if (segmentDistance(a, b, c, d) <= EPS) return false;
      }
    }
    return true;
  }

  // 两环是否互不接触（边距离 > 0 且顶点互不落在对方边界上）
  function ringsDisjoint(r1, r2) {
    for (let i = 0; i < r1.length; i++) {
      const a = r1[i], b = r1[(i + 1) % r1.length];
      for (let j = 0; j < r2.length; j++) {
        const c = r2[j], d = r2[(j + 1) % r2.length];
        if (segmentDistance(a, b, c, d) <= EPS) return false;
      }
    }
    return true;
  }

  // 计算一个细胞（扣除孔洞）的面积与含孔洞边界的总周长
  // areaUm2: 外轮廓面积 - Σ孔洞面积；perimeterUm: 外轮廓周长 + Σ孔洞周长
  function measureCell(cell, scale) {
    const k = scale.umPerPixel;
    let area = ringAreaAbs(cell.points) * k * k;
    let per = ringLength(cell.points) * k;
    for (const h of cell.holes || []) {
      area -= ringAreaAbs(h.points) * k * k;
      per += ringLength(h.points) * k;
    }
    return { areaUm2: area, perimeterUm: per };
  }

  function fmt(n, digits) {
    if (!isFiniteNum(n)) return '';
    return n.toFixed(digits == null ? 3 : digits);
  }

  // 选一个"好看"的标尺长度（微米），约占图宽的 20%
  function niceScaleBarUm(widthPx, umPerPixel) {
    const targetUm = widthPx * 0.2 * umPerPixel;
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let pick = steps[0];
    for (const s of steps) {
      if (s <= targetUm) pick = s;
    }
    return pick;
  }

  return {
    EPS,
    isFiniteNum,
    dist,
    ringLength,
    ringAreaAbs,
    centroid,
    pointInRing,
    pointSegDistance,
    segmentRelation,
    segmentDistance,
    checkSelfIntersection,
    ringStrictlyInside,
    ringsDisjoint,
    measureCell,
    fmt,
    niceScaleBarUm
  };
});

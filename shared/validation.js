/*
 * 草稿校验：标尺、细胞外轮廓、孔洞关系。
 * 任何一项不通过都会返回 errors；调用方必须保证整次修改不落库。
 */
(function (root, factory) {
  const Geom = typeof require === 'function'
    ? require('./geometry.js')
    : root.Geom;
  const api = factory(Geom);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DraftValidate = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (Geom) {
  'use strict';

  function asPoint(v) {
    if (!v || typeof v !== 'object') return null;
    const x = Number(v.x);
    const y = Number(v.y);
    if (!Geom.isFiniteNum(x) || !Geom.isFiniteNum(y)) return null;
    return { x, y };
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  // 规范化并校验一组点（环）
  function readRing(rawPoints, label, errors, width, height) {
    if (!Array.isArray(rawPoints)) {
      errors.push({ object: label, message: `${label} 的顶点数据不是数组` });
      return null;
    }
    const pts = [];
    rawPoints.forEach((raw, i) => {
      const p = asPoint(raw);
      const vlabel = `${label} 顶点 #${i + 1}`;
      if (!p) {
        errors.push({ object: vlabel, message: `${vlabel} 坐标无效（需要数值类型的 x、y）` });
        return;
      }
      if (p.x < -Geom.EPS || p.y < -Geom.EPS ||
          p.x > width + Geom.EPS || p.y > height + Geom.EPS) {
        errors.push({
          object: vlabel,
          message: `${vlabel}（${round1(p.x)}, ${round1(p.y)}）越出图片范围（图片尺寸 ${width}×${height} 像素）`
        });
      }
      pts.push({
        x: Math.min(Math.max(p.x, 0), width),
        y: Math.min(Math.max(p.y, 0), height)
      });
    });
    if (pts.length < 3) {
      errors.push({ object: label, message: `${label} 至少需要 3 个顶点（当前 ${pts.length} 个），无法构成闭合轮廓` });
      return pts;
    }
    const hit = Geom.checkSelfIntersection(pts, label);
    if (hit) errors.push({ object: label, message: hit.message });
    if (Geom.ringAreaAbs(pts) <= Geom.EPS) {
      errors.push({ object: label, message: `${label} 面积为 0（所有顶点共线），不是有效轮廓` });
    }
    return pts;
  }

  function readScale(rawScale, label, errors, required) {
    if (rawScale == null) {
      if (required) {
        errors.push({ object: label, message: '缺少标尺数据：请先在图片上选取两个像素点并填写实际微米距离' });
      }
      return null;
    }
    if (typeof rawScale !== 'object') {
      errors.push({ object: label, message: '标尺数据格式无效' });
      return null;
    }
    const p1 = asPoint(rawScale.p1);
    const p2 = asPoint(rawScale.p2);
    const um = Number(rawScale.um);
    if (!p1) errors.push({ object: label, message: '标尺第一个像素点无效' });
    if (!p2) errors.push({ object: label, message: '标尺第二个像素点无效' });
    if (p1 && p2 && Geom.dist(p1, p2) <= Geom.EPS) {
      errors.push({ object: label, message: '标尺的两个像素点重合：必须选择两个不同的像素点' });
    }
    if (!Geom.isFiniteNum(um) || um <= 0) {
      errors.push({ object: label, message: `标尺实际微米距离无效（收到 ${rawScale.um}）：必须是大于 0 的数字` });
    }
    if (!p1 || !p2 || !Geom.isFiniteNum(um) || um <= 0 ||
        (p1 && p2 && Geom.dist(p1, p2) <= Geom.EPS)) {
      return null;
    }
    const pixelDist = Geom.dist(p1, p2);
    return { p1, p2, um, pixelDist, umPerPixel: um / pixelDist };
  }

  /*
   * 完整校验。返回 { errors, cells }。
   * options.requireScale=true 时标尺必填（发布场景）；
   * 保存草稿允许标尺缺省（仅保存轮廓）。
   * cells: [{ label, points, holes:[{label,points}] }]
   */
  function validate(draft, width, height, options) {
    const requireScale = !!(options && options.requireScale);
    const errors = [];
    const SCALE_LABEL = '标尺';

    const scale = readScale(draft && draft.scale, SCALE_LABEL, errors, requireScale);
    if (draft && !Array.isArray(draft.cells)) {
      errors.push({ object: '细胞列表', message: '提交的细胞列表不是数组（数据格式错误）' });
    }
    const rawCells = (draft && Array.isArray(draft.cells)) ? draft.cells : [];

    const cells = rawCells.map((rawCell, ci) => {
      const cl = `细胞 #${ci + 1}`;
      const points = readRing(rawCell && rawCell.points, cl, errors, width, height);
      const rawHoles = (rawCell && Array.isArray(rawCell.holes)) ? rawCell.holes : [];
      if (rawCell && !Array.isArray(rawCell.holes)) {
        errors.push({ object: cl, message: `${cl} 的孔洞列表不是数组（数据格式错误）` });
      }
      const holes = rawHoles.map((rawHole, hi) => {
        const hl = `${cl} 孔洞 #${hi + 1}`;
        const hpts = readRing(rawHole && rawHole.points, hl, errors, width, height);
        return { label: hl, points: hpts };
      });
      return { label: cl, points, holes };
    });

    // 结构通过后再做关系校验，避免无效环产生连带误报
    const structureOK = errors.length === 0;
    if (structureOK) {
      cells.forEach((cell) => {
        cell.holes.forEach((hole) => {
          if (!Geom.ringStrictlyInside(hole.points, cell.points)) {
            errors.push({
              object: hole.label,
              message: `${hole.label} 未严格位于 ${cell.label} 内部：孔洞不得越出、穿越或触碰所属细胞外轮廓`
            });
          }
        });
        // 同一细胞的孔洞之间互不接触（允许一个孔洞包围另一个，但边界间距必须 > 0）
        for (let i = 0; i < cell.holes.length; i++) {
          for (let j = i + 1; j < cell.holes.length; j++) {
            const h1 = cell.holes[i], h2 = cell.holes[j];
            if (!Geom.ringsDisjoint(h1.points, h2.points)) {
              errors.push({
                object: `${h1.label} / ${h2.label}`,
                message: `${h1.label} 与 ${h2.label} 相互接触或相交：同一细胞内的孔洞边界必须互不接触`
              });
            }
          }
        }
      });
    }

    return { errors, scale, cells, valid: errors.length === 0 };
  }

  // 用标尺计算全部测量结果（输入必须是 validate 通过的 cells/scale）
  function computeResults(scale, cells) {
    return cells.map((cell) => {
      const m = Geom.measureCell(
        { points: cell.points, holes: cell.holes.map((h) => ({ points: h.points })) },
        scale
      );
      return {
        label: cell.label,
        holeCount: cell.holes.length,
        areaUm2: m.areaUm2,
        perimeterUm: m.perimeterUm
      };
    });
  }

  return { validate, computeResults, readScale, asPoint };
});

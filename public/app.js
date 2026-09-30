'use strict';
/* global Geom, DraftValidate */

// ============ 通用工具 ============

const $ = (id) => document.getElementById(id);

function toast(message, kind, ms) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast ' + (kind || '');
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms || 3600);
}

function cellColor(i) {
  return `hsl(${(i * 67) % 360}, 80%, 55%)`;
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ============ 视图变换（只影响显示，绝不修改像素坐标） ============

function createView() {
  return { scale: 1, tx: 0, ty: 0, imgW: 0, imgH: 0, img: null };
}

function fitView(view, canvas, w, h, padding) {
  view.imgW = w;
  view.imgH = h;
  const p = padding == null ? 30 : padding;
  view.scale = Math.min(
    (canvas.clientWidth - 2 * p) / w,
    (canvas.clientHeight - 2 * p) / h
  );
  view.tx = (canvas.clientWidth - w * view.scale) / 2;
  view.ty = (canvas.clientHeight - h * view.scale) / 2;
}

function screenToImage(view, sx, sy) {
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale };
}
function imageToScreen(view, p) {
  return { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty };
}

// ============ 画布基类（高 DPI + 滚轮缩放 + 右键/中键平移） ============

function bindCanvas(canvas, view, onPointerDown, onPointerMove, onDblClick, onViewChange) {
  const ctx = canvas.getContext('2d');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  function eventPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  const pan = { active: false, x: 0, y: 0, tx: 0, ty: 0 };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const sp = eventPos(e);
    const before = screenToImage(view, sp.x, sp.y);
    const factor = Math.exp(-e.deltaY * 0.0012);
    view.scale = Math.min(40, Math.max(0.02, view.scale * factor));
    view.tx = sp.x - before.x * view.scale;
    view.ty = sp.y - before.y * view.scale;
    if (onViewChange) onViewChange();
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    const sp = eventPos(e);
    if (e.button === 2 || e.button === 1) {
      pan.active = true; pan.x = sp.x; pan.y = sp.y;
      pan.tx = view.tx; pan.ty = view.ty;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button === 0 && onPointerDown) onPointerDown(e, sp, screenToImage(view, sp.x, sp.y));
  });

  canvas.addEventListener('pointermove', (e) => {
    const sp = eventPos(e);
    if (pan.active) {
      view.tx = pan.tx + (sp.x - pan.x);
      view.ty = pan.ty + (sp.y - pan.y);
      if (onViewChange) onViewChange();
      return;
    }
    if (onPointerMove) onPointerMove(e, sp, screenToImage(view, sp.x, sp.y));
  });

  const endPan = () => { pan.active = false; canvas.style.cursor = ''; };
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('dblclick', (e) => {
    const sp = eventPos(e);
    if (onDblClick) onDblClick(e, sp, screenToImage(view, sp.x, sp.y));
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function drawPolygon(ctx, points, fill, stroke, lineWidth, dash) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth || 2;
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawVertex(ctx, p, color, r) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r || 4, 0, Math.PI * 2);
  ctx.fillStyle = color || '#fff';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#000';
  ctx.stroke();
}

function drawScaleBar(ctx, view, scale, w, h) {
  const barUm = Geom.niceScaleBarUm(w, scale.umPerPixel);
  const barPx = barUm / scale.umPerPixel;
  const fs = Math.max(12, w * 0.022 * view.scale + 10);
  const sx = view.tx + 14;
  const sy = view.ty + h * view.scale - 16;
  ctx.font = `bold ${fs}px sans-serif`;
  const label = `${barUm} µm`;
  const tw = ctx.measureText(label).width;
  const bx = sx;
  const by = sy - fs - 10;
  const bw = Math.max(barPx * view.scale, tw + 12);
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(bx - 6, by - 4, bw + 12, fs + 22);
  ctx.fillStyle = '#fff';
  ctx.fillRect(bx, by, bw, 6);
  ctx.fillText(label, bx, by - 3);
}

// ============ 工作台状态 ============

const canvas = $('canvas');
const view = createView();

const st = {
  draft: null,          // 服务器返回的草稿（version, scale, cells）
  image: null,          // Image 对象
  tool: 'pan',
  dirty: false,
  drawing: null,        // {kind:'cell'|'hole', points:[], hover:{}}
  selected: null,       // {type:'cell',index} 或 {type:'hole',cellIndex,index}
  calib: null,          // 定标弹窗会话 {p1,p2}
  publishing: false
};

function cells() { return (st.draft && st.draft.cells) || []; }
function selectedCellIndex() {
  if (st.selected && st.selected.type === 'cell') return st.selected.index;
  if (st.selected && st.selected.type === 'hole') return st.selected.cellIndex;
  return -1;
}

// ============ 渲染工作台 ============

function renderWorkspace() {
  const ctx = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!st.draft || !st.image) return;

  ctx.save();
  ctx.translate(view.tx, view.ty);
  ctx.scale(view.scale, view.scale);

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(st.image, 0, 0, view.imgW, view.imgH);

  // 图片边框
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 1 / view.scale;
  ctx.strokeRect(0, 0, view.imgW, view.imgH);

  const selectedCell = selectedCellIndex();

  // 已有细胞与孔洞
  cells().forEach((cell, ci) => {
    const color = cellColor(ci);
    const isSel = st.selected && st.selected.type === 'cell' && st.selected.index === ci;
    const isParent = st.selected && st.selected.type === 'hole' && st.selected.cellIndex === ci;
    drawPolygon(ctx, cell.points,
      isSel || isParent ? color + '55' : color + '26',
      isSel ? '#ffe066' : color,
      (isSel ? 3 : 2) / view.scale);

    (cell.holes || []).forEach((hole, hi) => {
      const hSel = st.selected && st.selected.type === 'hole' &&
        st.selected.cellIndex === ci && st.selected.index === hi;
      drawPolygon(ctx, hole.points, 'rgba(0,0,0,.25)',
        hSel ? '#ffe066' : '#ff3b3b',
        (hSel ? 3 : 2) / view.scale, [6 / view.scale, 4 / view.scale]);
    });
  });

  // 编号
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  cells().forEach((cell, ci) => {
    const fs = 15 / view.scale;
    ctx.font = `bold ${fs}px sans-serif`;
    const c = Geom.centroid(cell.points);
    ctx.lineWidth = 3 / view.scale;
    ctx.strokeStyle = '#000';
    ctx.strokeText(String(ci + 1), c.x, c.y);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(ci + 1), c.x, c.y);
  });

  // 标尺线（编辑中的也显示）
  const scale = st.draft.scale;
  if (scale) {
    ctx.beginPath();
    ctx.moveTo(scale.p1.x, scale.p1.y);
    ctx.lineTo(scale.p2.x, scale.p2.y);
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2.5 / view.scale;
    ctx.setLineDash([8 / view.scale, 5 / view.scale]);
    ctx.stroke();
    ctx.setLineDash([]);
    [scale.p1, scale.p2].forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 / view.scale, 0, Math.PI * 2);
      ctx.fillStyle = '#00e5ff';
      ctx.fill();
    });
  }

  // 正在绘制的环
  if (st.drawing) {
    const pts = st.drawing.points;
    if (pts.length >= 1) {
      const color = st.drawing.kind === 'cell' ? '#ffe066' : '#ff9f43';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (st.drawing.hover) ctx.lineTo(st.drawing.hover.x, st.drawing.hover.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / view.scale;
      ctx.setLineDash([5 / view.scale, 4 / view.scale]);
      ctx.stroke();
      ctx.setLineDash([]);
      pts.forEach((p, i) => {
        // 指向起点提示闭合
        if (i === 0 && pts.length >= 3 && st.drawing.hover &&
            Geom.dist(st.drawing.hover, p) < 10 / view.scale) {
          drawVertex(ctx, p, '#2fbf71', 7 / view.scale);
        } else {
          drawVertex(ctx, p, i === 0 ? '#2fbf71' : '#fff', 4 / view.scale);
        }
      });
    }
  }

  // 定标点
  if (st.calib) {
    [st.calib.p1, st.calib.p2].forEach((p, i) => {
      if (!p) return;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 / view.scale, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#2fbf71' : '#ff9f43';
      ctx.fill();
      ctx.lineWidth = 2 / view.scale;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      if (st.calib.p1 && st.calib.p2) {
        ctx.beginPath();
        ctx.moveTo(st.calib.p1.x, st.calib.p1.y);
        ctx.lineTo(st.calib.p2.x, st.calib.p2.y);
        ctx.strokeStyle = '#2fbf71';
        ctx.lineWidth = 2 / view.scale;
        ctx.stroke();
      }
    });
  }

  ctx.restore();

  if (st.draft.scale) drawScaleBar(ctx, view, st.draft.scale, view.imgW, view.imgH);
}

// ============ 命中测试（选择已有轮廓） ============

function hitTest(ip) {
  const list = cells();
  for (let ci = list.length - 1; ci >= 0; ci--) {
    const cell = list[ci];
    for (let hi = (cell.holes || []).length - 1; hi >= 0; hi--) {
      if (Geom.pointInRing(ip, cell.holes[hi].points) !== -1) {
        return { type: 'hole', cellIndex: ci, index: hi };
      }
    }
    if (Geom.pointInRing(ip, cell.points) !== -1) {
      return { type: 'cell', index: ci };
    }
  }
  return null;
}

// ============ 工作台交互 ============

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderWorkspace(); });
}

bindCanvas(canvas, view, (e, sp, ip) => {
  if (!st.draft) return;

  if (st.calib) { handleCalibClick(ip); return; }

  if (st.tool === 'cell' || st.tool === 'hole') {
    if (st.tool === 'hole' && !st.drawing && selectedCellIndex() === -1) {
      toast('请先在右侧列表或画布中选中一个细胞，再为它圈孔洞', 'warn');
      return;
    }
    if (!st.drawing) {
      st.drawing = { kind: st.tool, points: [], hover: null };
      if (st.tool === 'hole') st.drawing.cellIndex = selectedCellIndex();
    }
    // 点到起点 → 尝试闭合
    const pts = st.drawing.points;
    if (pts.length >= 3 && Geom.dist(ip, pts[0]) <= 10 / view.scale) {
      finishRing();
      return;
    }
    pts.push({ x: ip.x, y: ip.y });
    updateToolbar();
    scheduleRender();
    return;
  }

  if (st.tool === 'pan' || st.tool === 'calibrate') {
    const hit = hitTest(ip);
    st.selected = hit;
    updatePanels();
    updateToolbar();
    scheduleRender();
  }
}, (e, sp, ip) => {
  // cursor info
  if (st.draft) {
    $('cursorInfo').classList.remove('hidden');
    let extra = '';
    if (st.draft.scale) {
      extra = `　距左 ${(ip.x * st.draft.scale.umPerPixel).toFixed(1)} µm`;
    }
    $('cursorInfo').textContent =
      `图像坐标 (${ip.x.toFixed(1)}, ${ip.y.toFixed(1)}) px${extra}`;
  }
  if (st.drawing) {
    st.drawing.hover = ip;
    scheduleRender();
  } else {
    scheduleRender();
  }
}, (e, sp, ip) => {
  // 双击闭合
  if (st.drawing && st.drawing.points.length >= 3) finishRing();
}, scheduleRender);

function finishRing() {
  const d = st.drawing;
  const pts = d.points;
  if (!pts || pts.length < 3) return;

  if (d.kind === 'cell') {
    st.draft.cells.push({ label: '', points: pts.map((p) => ({ ...p })), holes: [] });
    st.selected = { type: 'cell', index: st.draft.cells.length - 1 };
  } else {
    const ci = d.cellIndex;
    if (!st.draft.cells[ci]) { cancelRing(); return; }
    st.draft.cells[ci].holes.push({ label: '', points: pts.map((p) => ({ ...p })) });
    st.selected = { type: 'hole', cellIndex: ci, index: st.draft.cells[ci].holes.length - 1 };
  }
  st.drawing = null;
  st.dirty = true;
  updateToolbar();
  updatePanels();
  scheduleRender();

  // 即时关系校验提示（不阻止继续编辑）
  const v = DraftValidate.validate(
    { scale: st.draft.scale || { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 }, um: 1 }, cells: st.draft.cells },
    view.imgW, view.imgH
  );
  const geomErrors = v.errors.filter((e) => e.object !== '标尺');
  if (geomErrors.length) toast(`提示：${geomErrors[0].message}`, 'warn', 5000);
}

function cancelRing() {
  st.drawing = null;
  updateToolbar();
  scheduleRender();
}

function undoPoint() {
  if (st.drawing && st.drawing.points.length) {
    st.drawing.points.pop();
    if (!st.drawing.points.length) st.drawing = null;
  }
  updateToolbar();
  scheduleRender();
}

function deleteSelected() {
  const sel = st.selected;
  if (!sel) return;
  if (sel.type === 'cell') {
    st.draft.cells.splice(sel.index, 1);
  } else if (sel.type === 'hole') {
    st.draft.cells[sel.cellIndex].holes.splice(sel.index, 1);
  }
  st.selected = null;
  st.dirty = true;
  updateToolbar();
  updatePanels();
  scheduleRender();
}

// ============ 工具切换 ============

function setTool(tool) {
  st.tool = tool;
  if (tool !== 'cell' && tool !== 'hole') st.drawing = null;
  if (tool === 'hole' && selectedCellIndex() === -1) {
    toast('圈孔洞前请先选中所属细胞', 'warn');
  }
  document.querySelectorAll('#draftTools .tool[data-tool]').forEach((b) => {
    b.style.outline = b.dataset.tool === tool ? '2px solid #7cc0ff' : 'none';
  });
  canvas.classList.toggle('tool-pan', tool === 'pan');
  if (tool !== 'calibrate') closeCalib(false);
  updateModeHint();
  updateToolbar();
  scheduleRender();
}

function updateModeHint() {
  const el = $('modeHint');
  const hints = {
    cell: '圈细胞模式：单击添加顶点，双击 / Enter / 点击起点闭合；Z 撤销',
    hole: '圈孔洞模式：先在右侧选中所属细胞；单击添加顶点，双击 / Enter 闭合。孔洞须严格在细胞内、彼此不接触',
    calibrate: '定标模式：在标尺两端各点一下，然后填写实际微米距离',
    pan: '平移 / 选择模式：点击轮廓选中，右键拖动平移，滚轮缩放'
  };
  el.textContent = hints[st.tool] || '';
  el.classList.toggle('hidden', st.tool === 'pan');
}

function updateToolbar() {
  const hasDraft = !!st.draft;
  $('btnSave').disabled = !hasDraft;
  $('btnPublish').disabled = !hasDraft || !st.draft.scale;
  $('btnRecalibrate').disabled = !hasDraft;
  $('btnCloseRing').disabled = !(st.drawing && st.drawing.points.length >= 3);
  $('btnUndoPoint').disabled = !(st.drawing && st.drawing.points);
  $('btnDeleteSel').disabled = !st.selected;
  $('btnFitView').disabled = !hasDraft;
}

document.querySelectorAll('#draftTools .tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});
$('btnCloseRing').addEventListener('click', () => {
  if (st.drawing && st.drawing.points.length >= 3) finishRing();
});
$('btnUndoPoint').addEventListener('click', undoPoint);
$('btnDeleteSel').addEventListener('click', deleteSelected);
$('btnFitView').addEventListener('click', () => {
  if (st.draft) { fitView(view, canvas, view.imgW, view.imgH); scheduleRender(); }
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Enter' && st.drawing && st.drawing.points.length >= 3) {
    e.preventDefault();
    finishRing();
  } else if ((e.key === 'z' || e.key === 'Z') && st.drawing) {
    undoPoint();
  } else if ((e.key === 'Escape') && st.calib) {
    closeCalib(true);
  }
});

// ============ 右侧信息面板 ============

function liveResults() {
  if (!st.draft || !st.draft.scale) return null;
  const v = DraftValidate.validate(
    { scale: st.draft.scale, cells: st.draft.cells },
    view.imgW, view.imgH
  );
  if (!v.valid) return null;
  return DraftValidate.computeResults(v.scale, v.cells);
}

function updatePanels() {
  // 标尺信息
  const sc = st.draft && st.draft.scale;
  if (sc) {
    $('scaleInfo').innerHTML =
      `像素距离：<b>${sc.pixelDist.toFixed(2)}</b> px<br>` +
      `实际距离：<b>${sc.um}</b> µm<br>` +
      `换算系数：<b>${sc.umPerPixel.toFixed(6)}</b> µm/px`;
  } else {
    $('scaleInfo').textContent = st.draft ? '尚未定标（点击「定标」）' : '尚未定标';
  }

  // 细胞列表
  const results = liveResults();
  const list = $('cellList');
  list.innerHTML = '';
  if (!cells().length) {
    list.innerHTML = '<p class="note">还没有细胞轮廓。选择「圈细胞」工具开始。</p>';
  }
  cells().forEach((cell, ci) => {
    const wrap = document.createElement('div');
    wrap.className = 'cell-item' +
      ((st.selected && (st.selected.type === 'cell' && st.selected.index === ci ||
        st.selected.type === 'hole' && st.selected.cellIndex === ci)) ? ' selected' : '');
    const head = document.createElement('div');
    head.className = 'cell-head';
    head.innerHTML =
      `<span class="swatch" style="background:${cellColor(ci)}"></span>` +
      `<span class="name">细胞 ${ci + 1}（${cell.points.length} 点 · ${(cell.holes || []).length} 孔洞）</span>` +
      (results ? `<span class="vals">${results[ci].areaUm2.toFixed(2)} µm²</span>` : '');
    head.addEventListener('click', () => {
      st.selected = { type: 'cell', index: ci };
      updatePanels(); updateToolbar(); scheduleRender();
    });
    wrap.appendChild(head);

    if ((cell.holes || []).length) {
      const hl = document.createElement('div');
      hl.className = 'hole-list';
      cell.holes.forEach((hole, hi) => {
        const he = document.createElement('div');
        he.className = 'hole-item' +
          (st.selected && st.selected.type === 'hole' &&
           st.selected.cellIndex === ci && st.selected.index === hi ? ' selected' : '');
        he.innerHTML = `<span>孔洞 ${ci + 1}.${hi + 1}（${hole.points.length} 点）</span>`;
        he.addEventListener('click', (ev) => {
          ev.stopPropagation();
          st.selected = { type: 'hole', cellIndex: ci, index: hi };
          updatePanels(); updateToolbar(); scheduleRender();
        });
        hl.appendChild(he);
      });
      wrap.appendChild(hl);
    }
    list.appendChild(wrap);
  });

  // 草稿状态
  const ds = $('draftStatus');
  if (st.draft) {
    ds.innerHTML =
      `草稿版本：<b>v${st.draft.version}</b><br>` +
      (st.dirty
        ? '<span class="dirty">● 有未保存修改（保存时会按当前定标比例重算）</span>'
        : '<span class="saved">● 已与服务器同步</span>');
  } else {
    ds.textContent = '未加载';
  }
}

// ============ 保存草稿 ============

$('btnSave').addEventListener('click', async () => {
  if (!st.draft) return;
  const btn = $('btnSave');
  btn.disabled = true;
  try {
    const v = DraftValidate.validate(
      { scale: st.draft.scale, cells: st.draft.cells },
      view.imgW, view.imgH
    );
    if (!v.valid) {
      toast('校验未通过，整次修改未保存：\n' + v.errors.slice(0, 3).map((e) => '• ' + e.message).join('\n'),
        'error', 7000);
      btn.disabled = false;
      return;
    }
    const updated = await api('PUT', `/api/images/${st.draft.imageId}/draft`, {
      expectedVersion: st.draft.version,
      scale: st.draft.scale,
      cells: st.draft.cells.map((c) => ({
        points: c.points,
        holes: (c.holes || []).map((h) => ({ points: h.points }))
      }))
    });
    applyDraft(updated, true);
    toast(`草稿已保存（v${updated.version}），测量值已按当前标尺重算`, 'success');
  } catch (err) {
    handleSaveError(err);
    btn.disabled = false;
  }
});

function handleSaveError(err) {
  if (err.status === 422 && err.data && err.data.errors) {
    const lines = err.data.errors.slice(0, 5).map((e) => `• [${e.object}] ${e.message}`);
    toast('服务器拒绝了修改，整次修改不生效：\n' + lines.join('\n'), 'error', 9000);
  } else if (err.status === 409) {
    toast(`${err.message}\n已为你重新加载最新草稿，请核对后再次提交`, 'error', 7000);
    reloadCurrentImage();
  } else {
    toast(err.message, 'error');
  }
}

async function reloadCurrentImage() {
  if (!st.draft) return;
  const id = st.draft.imageId;
  const fresh = await api('GET', `/api/images/${id}`);
  applyDraft(fresh, true);
}

function applyDraft(d, saved) {
  const sizeChanged = !st.draft ||
    st.draft.width !== d.width || st.draft.height !== d.height ||
    st.draft.imageId !== d.imageId;
  st.draft = d;
  st.dirty = !saved;
  st.selected = null;
  st.drawing = null;
  loadImageForDraft(d, sizeChanged);
  updatePanels();
  updateToolbar();
}

function loadImageForDraft(d, fit) {
  if (view.imageId === d.imageId && view.img) {
    view.imgW = d.width;
    view.imgH = d.height;
    if (fit) fitView(view, canvas, d.width, d.height);
    scheduleRender();
    return;
  }
  const img = new Image();
  img.onload = () => {
    view.img = img;
    view.imageId = d.imageId;
    view.imgW = d.width;
    view.imgH = d.height;
    if (fit) fitView(view, canvas, d.width, d.height);
    scheduleRender();
  };
  img.src = `/api/images/${d.imageId}/file?t=${d.imageId}`;
}

// ============ 定标 ============

function openCalib() {
  if (!st.draft) return;
  st.calib = { p1: null, p2: null };
  if (st.draft.scale) {
    // 重新定标：预填当前点
    st.calib.p1 = { ...st.draft.scale.p1 };
    st.calib.p2 = { ...st.draft.scale.p2 };
    $('calibUm').value = st.draft.scale.um;
  } else {
    $('calibUm').value = '';
  }
  $('calibModal').classList.remove('hidden');
  $('calibError').classList.add('hidden');
  setTool('calibrate');
  refreshCalibUI();
}

function closeCalib(resetTool) {
  st.calib = null;
  $('calibModal').classList.add('hidden');
  if (resetTool !== false) setTool('pan');
  scheduleRender();
}

function handleCalibClick(ip) {
  const c = st.calib;
  const p = {
    x: Math.min(Math.max(ip.x, 0), view.imgW),
    y: Math.min(Math.max(ip.y, 0), view.imgH)
  };
  if (!c.p1) c.p1 = p;
  else if (!c.p2) c.p2 = p;
  else { c.p1 = p; c.p2 = null; } // 重新选
  refreshCalibUI();
  scheduleRender();
}

function refreshCalibUI() {
  const c = st.calib;
  const fmtP = (p) => p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})` : '—';
  $('calibP1').textContent = fmtP(c.p1);
  $('calibP2').textContent = fmtP(c.p2);
  const d = (c.p1 && c.p2) ? Geom.dist(c.p1, c.p2) : 0;
  $('calibPx').textContent = d ? d.toFixed(2) : '—';
  $('step1').className = c.p1 ? 'done' : 'active';
  $('step2').className = !c.p1 ? '' : (c.p2 ? 'done' : 'active');
}

$('btnRecalibrate').addEventListener('click', openCalib);
document.querySelector('#draftTools .tool[data-tool="calibrate"]').addEventListener('click', openCalib);
$('calibCancel').addEventListener('click', () => closeCalib(true));
$('calibReset').addEventListener('click', () => {
  st.calib.p1 = null;
  st.calib.p2 = null;
  refreshCalibUI();
  scheduleRender();
});
$('calibApply').addEventListener('click', () => {
  const c = st.calib;
  if (!c || !c.p1 || !c.p2) {
    showCalibError('请先在图片上选择两个不同的像素点');
    return;
  }
  if (Geom.dist(c.p1, c.p2) <= Geom.EPS) {
    showCalibError('两个像素点重合，请选择两个不同的像素点');
    return;
  }
  const um = Number($('calibUm').value);
  if (!Geom.isFiniteNum(um) || um <= 0) {
    showCalibError('实际微米距离必须是大于 0 的数字');
    return;
  }
  const pixelDist = Geom.dist(c.p1, c.p2);
  // 重新定标：轮廓点像素坐标不变，仅替换标尺；所有测量自动按新系数重算
  st.draft.scale = {
    p1: c.p1, p2: c.p2, um,
    pixelDist, umPerPixel: um / pixelDist
  };
  st.dirty = true;
  closeCalib(true);
  updatePanels();
  scheduleRender();
  toast(`定标完成：1 px = ${(um / pixelDist).toFixed(6)} µm。面积与周长将按此比例计算，保存后生效`, 'success', 5200);
});

function showCalibError(msg) {
  const el = $('calibError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============ 发布 ============

$('btnPublish').addEventListener('click', async () => {
  if (!st.draft) return;
  // 发布前本地校验
  const v = DraftValidate.validate(
    { scale: st.draft.scale, cells: st.draft.cells },
    view.imgW, view.imgH
  );
  if (!v.valid) {
    toast('当前草稿存在无效对象，不能发布：\n' +
      v.errors.slice(0, 5).map((e) => `• [${e.object}] ${e.message}`).join('\n'), 'error', 9000);
    return;
  }
  $('publishVersion').textContent = 'v' + st.draft.version;
  $('publishTitle').value = '';
  $('publishError').classList.add('hidden');
  $('publishModal').classList.remove('hidden');
});

$('publishCancel').addEventListener('click', () => $('publishModal').classList.add('hidden'));
$('publishConfirm').addEventListener('click', async () => {
  const btn = $('publishConfirm');
  btn.disabled = true;
  try {
    const report = await api('POST', `/api/images/${st.draft.imageId}/publish`, {
      expectedVersion: st.draft.version,
      title: $('publishTitle').value.trim()
    });
    $('publishModal').classList.add('hidden');
    toast(`报告 #${report.id} 已发布（快照版本 v${report.version}）`, 'success', 5000);
    loadImages();
  } catch (err) {
    if (err.status === 409) {
      $('publishError').textContent = err.message + '。请先保存草稿并刷新后再发布。';
      $('publishError').classList.remove('hidden');
      reloadCurrentImage();
    } else if (err.status === 422 && err.data && err.data.errors) {
      $('publishError').textContent = err.data.errors.map((e) => `• [${e.object}] ${e.message}`).join('\n');
      $('publishError').classList.remove('hidden');
    } else {
      $('publishError').textContent = err.message;
      $('publishError').classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
  }
});

// ============ 图片上传与列表 ============

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  try {
    const res = await fetch('/api/images', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '上传失败');
    applyDraft(data, true);
    toast('图片已上传，开始定标或圈选细胞', 'success');
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
});

async function loadImages(selectId) {
  const list = await api('GET', '/api/images');
  const el = $('imageList');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<p class="note">还没有图片。</p>';
    return;
  }
  list.forEach((img) => {
    const d = document.createElement('div');
    d.className = 'image-item' + (st.draft && st.draft.imageId === img.id ? ' active' : '');
    d.innerHTML =
      `<div>${img.original_name}</div>` +
      `<div class="sub"><span>${img.width}×${img.height}</span>` +
      (img.hasScale ? '<span class="badge scale">已定标</span>' : '<span class="badge noscale">未定标</span>') +
      `<span>#${img.id}</span></div>`;
    d.addEventListener('click', () => openImage(img.id));
    el.appendChild(d);
  });
}

async function openImage(id) {
  const d = await api('GET', `/api/images/${id}`);
  applyDraft(d, true);
  loadImages(id);
}

// ============ Tab 切换 ============

$('tabWorkspace').addEventListener('click', () => switchTab('workspace'));
$('tabReports').addEventListener('click', () => switchTab('reports'));

function switchTab(name) {
  $('tabWorkspace').classList.toggle('active', name === 'workspace');
  $('tabReports').classList.toggle('active', name === 'reports');
  $('viewWorkspace').classList.toggle('active', name === 'workspace');
  $('viewReports').classList.toggle('active', name === 'reports');
  if (name === 'reports') loadReports();
  if (name === 'workspace' && st.draft) scheduleRender();
}

// ============ 报告视图（只读） ============

const reportCanvas = $('reportCanvas');
const reportView = createView();
const rst = { reports: [], selectedId: null, report: null, image: null };

bindCanvas(reportCanvas, reportView, null, null, null, () => requestAnimationFrame(renderReport));

async function loadReports() {
  rst.reports = await api('GET', '/api/reports');
  const el = $('reportList');
  el.innerHTML = '';
  if (!rst.reports.length) {
    el.innerHTML = '<p class="note">还没有已发布报告。</p>';
    $('btnExportZip').disabled = true;
    return;
  }
  rst.reports.forEach((r) => {
    const d = document.createElement('div');
    d.className = 'image-item' + (rst.selectedId === r.id ? ' active' : '');
    d.dataset.id = r.id;
    d.innerHTML =
      `<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">` +
      `<input type="checkbox" class="report-check" data-id="${r.id}">` +
      `<span style="flex:1"><div>${r.title}</div>` +
      `<div class="sub"><span>#${r.id}</span><span>快照 v${r.version}</span><span>${r.createdAt}</span></div></span></label>`;
    d.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      openReport(r.id);
    });
    d.querySelector('.report-check').addEventListener('change', updateExportButton);
    el.appendChild(d);
  });
  if (rst.selectedId && !rst.reports.some((r) => r.id === rst.selectedId)) {
    rst.selectedId = null;
  }
  if (!rst.selectedId) {
    $('reportEmptyHint').classList.remove('hidden');
  }
  updateExportButton();
}

function checkedReportIds() {
  return Array.from(document.querySelectorAll('.report-check:checked')).map((c) => Number(c.dataset.id));
}

function updateExportButton() {
  $('btnExportZip').disabled = checkedReportIds().length === 0;
}

async function openReport(id) {
  rst.selectedId = id;
  rst.report = await api('GET', `/api/reports/${id}`);
  const img = new Image();
  img.onload = () => {
    rst.image = img;
    reportView.img = img;
    fitView(reportView, reportCanvas, rst.report.width, rst.report.height);
    requestAnimationFrame(renderReport);
  };
  img.src = `/api/reports/${id}/image?t=${Date.now()}`;
  // 只更新选中样式，不重建列表（保留导出多选的勾选状态）
  document.querySelectorAll('#reportList .image-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.id) === id);
  });
  renderReportResults();
  $('btnReportPng').disabled = false;
  $('btnReportCsv').disabled = false;
  $('reportEmptyHint').classList.add('hidden');
  $('reportMeta').textContent =
    `${rst.report.title} · 快照版本 v${rst.report.version} · ${rst.report.width}×${rst.report.height} · 1 px = ${rst.report.scale.umPerPixel.toFixed(6)} µm`;
}

function renderReportResults() {
  const el = $('reportResults');
  el.innerHTML = '';
  if (!rst.report) return;
  rst.report.results.forEach((r) => {
    const d = document.createElement('div');
    d.className = 'result-card';
    d.innerHTML =
      `<b>${r.label}</b>（孔洞 ${r.holeCount} 个）<br>` +
      `面积（扣除孔洞）：<span class="num">${r.areaUm2.toFixed(3)}</span> µm²<br>` +
      `总周长（含孔洞边界）：<span class="num">${r.perimeterUm.toFixed(3)}</span> µm`;
    el.appendChild(d);
  });
}

function renderReport() {
  const ctx = reportCanvas.getContext('2d');
  const r = reportCanvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!rst.report || !rst.image) return;
  const rep = rst.report;

  ctx.save();
  ctx.translate(reportView.tx, reportView.ty);
  ctx.scale(reportView.scale, reportView.scale);
  ctx.drawImage(rst.image, 0, 0, rep.width, rep.height);

  rep.cells.forEach((cell, ci) => {
    const color = cellColor(ci);
    drawPolygon(ctx, cell.points, color + '26', color, 2 / reportView.scale);
    (cell.holes || []).forEach((hole) => {
      drawPolygon(ctx, hole.points, 'rgba(0,0,0,.25)', '#ff3b3b',
        2 / reportView.scale, [6 / reportView.scale, 4 / reportView.scale]);
    });
  });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  rep.cells.forEach((cell, ci) => {
    const c = Geom.centroid(cell.points);
    ctx.font = `bold ${15 / reportView.scale}px sans-serif`;
    ctx.lineWidth = 3 / reportView.scale;
    ctx.strokeStyle = '#000';
    ctx.strokeText(String(ci + 1), c.x, c.y);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(ci + 1), c.x, c.y);
  });

  // 发布时标尺
  const sc = rep.scale;
  ctx.beginPath();
  ctx.moveTo(sc.p1.x, sc.p1.y);
  ctx.lineTo(sc.p2.x, sc.p2.y);
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2.5 / reportView.scale;
  ctx.setLineDash([8 / reportView.scale, 5 / reportView.scale]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  drawScaleBar(ctx, reportView, rep.scale, rep.width, rep.height);
}

// 画布尺寸变化时重绘报告
new ResizeObserver(() => requestAnimationFrame(renderReport)).observe($('reportCanvasWrap'));
new ResizeObserver(() => requestAnimationFrame(renderWorkspace)).observe($('canvasWrap'));

$('btnRefreshReports').addEventListener('click', loadReports);
$('btnReportFit').addEventListener('click', () => {
  if (rst.report) { fitView(reportView, reportCanvas, rst.report.width, rst.report.height); renderReport(); }
});
$('btnReportPng').addEventListener('click', () => {
  if (rst.selectedId) window.open(`/api/reports/${rst.selectedId}/annotated.png`, '_blank');
});
$('btnReportCsv').addEventListener('click', () => {
  if (rst.selectedId) window.location.href = `/api/reports/${rst.selectedId}/measurements.csv`;
});
$('btnExportZip').addEventListener('click', () => {
  const ids = checkedReportIds();
  if (!ids.length) return;
  window.location.href = `/api/reports/export/zip?ids=${ids.join(',')}`;
});

// ============ 启动 ============

setTool('pan');
loadImages();
updatePanels();

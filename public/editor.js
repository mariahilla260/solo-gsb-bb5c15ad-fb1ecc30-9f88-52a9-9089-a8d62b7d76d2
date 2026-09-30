'use strict';

// 草稿编辑器：定标、细胞/孔洞绘制、校验保存、实时测量、乐观版本发布

const PALETTE = window.CANVAS_COLORS;

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (!Number.isFinite(v)) return '—';
  if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(3);
  return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}

const Editor = {
  imageId: null,
  img: null,           // 服务端草稿
  cells: [],           // 本地工作副本
  dirty: false,
  drawing: null,       // {kind:'cell'|'hole', points:[], cellId?}
  calibDraft: null,    // [p1] 等待第二点
  activeCellId: null,
  view: null,
  tool: 'cell',

  async open(id) {
    this.imageId = id;
    document.getElementById('view-home').classList.add('hidden');
    document.getElementById('view-editor').classList.remove('hidden');
    const data = await API.getImage(id);
    await this.applyServerData(data);

    if (!this.view) {
      this.view = new CanvasView(document.getElementById('canvas'), {
        onPoint: (pt) => this.addPoint(pt),
        onFinish: () => this.finishRing(),
        onCalibPoint: (pt) => this.addCalibPoint(pt),
        onZoom: (k) => {
          document.getElementById('zoom-indicator').textContent = `${Math.round(k * 100)}%`;
        }
      });
      this.view.bindState(() => ({
        cells: this.cells,
        drawing: this.drawing,
        activeCellId: this.activeCellId,
        calib: this.img ? this.img.calib : null,
        calibDraft: this.calibDraft
      }));
    }
    await this.view.loadImage(`/api/images/${id}/file`, data.width, data.height);
    this.setTool('cell');
    this.renderSidebar();
  },

  async applyServerData(data) {
    this.img = data;
    this.cells = JSON.parse(JSON.stringify(data.cells || []));
    for (const c of this.cells) if (!c.id) c.id = crypto.randomUUID();
    this.dirty = false;
    this.drawing = null;
    this.calibDraft = null;
    if (!this.cells.some((c) => c.id === this.activeCellId)) this.activeCellId = null;
    if (this.view) this.view.render();
  },

  close() {
    if (this.view) this.view.destroy(), (this.view = null);
    this.imageId = null;
  },

  // ---------- 工具与绘制 ----------

  setTool(t) {
    this.tool = t;
    for (const id of ['tool-calib', 'tool-cell', 'tool-hole', 'tool-pan']) {
      document.getElementById(id).classList.toggle('active', id === `tool-${t}`);
    }
    document.getElementById('tool-hole').disabled = !this.activeCellId;
    if (this.view) this.view.setTool(t);
  },

  addPoint(pt) {
    if (!this.drawing) {
      if (this.tool === 'hole') {
        if (!this.activeCellId) return this.toast('请先在细胞列表中选中一个细胞');
        this.drawing = { kind: 'hole', points: [], cellId: this.activeCellId };
      } else {
        this.drawing = { kind: 'cell', points: [] };
      }
    }
    // 与最后一点过近则忽略（防抖）
    const last = this.drawing.points[this.drawing.points.length - 1];
    if (last && Math.hypot(last.x - pt.x, last.y - pt.y) < 1.5) return;
    this.drawing.points.push({ x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 });
    this.renderDraftInfo();
    this.view.render();
  },

  undoPoint() {
    if (!this.drawing) return;
    this.drawing.points.pop();
    if (!this.drawing.points.length) this.drawing = null;
    this.renderDraftInfo();
    this.view.render();
  },

  cancelRing() {
    this.drawing = null;
    this.calibDraft = null;
    this.renderDraftInfo();
    this.view.render();
  },

  // 完成当前环：基础合法性检查后追加到工作副本（不写库，保存时整批原子提交）
  finishRing() {
    const d = this.drawing;
    if (!d || d.points.length < 3) return this.toast('轮廓至少需要 3 个顶点');
    const pts = d.points;
    const label = d.kind === 'hole' ? '孔洞' : '细胞外轮廓';

    const dup = window.ClientGeom.gArea ? this.dupIndex(pts) : null;
    if (dup) return this.toast(`${label}：第 ${dup} 个点与下一点重复`);
    if (pts.some((p) => p.x < 0 || p.y < 0 || p.x > this.img.width || p.y > this.img.height))
      return this.toast(`${label}：存在越出图片范围的顶点`);
    const si = window.ClientGeom.gSelfIntersection(pts);
    if (si) return this.toast(`${label}：第 ${si[0]}、${si[1]} 条边相交或接触，轮廓不得自交`);

    if (d.kind === 'cell') {
      const cell = {
        id: crypto.randomUUID(),
        name: `细胞 ${this.cells.length + 1}`,
        outer: pts,
        holes: [],
        areaUm2: null, perimeterUm: null
      };
      this.cells.push(cell);
      this.activeCellId = cell.id;
    } else {
      const cell = this.cells.find((c) => c.id === d.cellId);
      if (!cell) { this.drawing = null; return this.toast('所属细胞已不存在'); }
      if (!window.ClientGeom.gPointStrictlyInside(pts[0], cell.outer) ||
          !this.ringStrictlyInsideCell(pts, cell)) {
        return this.toast('孔洞必须严格位于所属细胞外轮廓内部，且不能与外轮廓接触');
      }
      for (let i = 0; i < cell.holes.length; i++) {
        if (this.ringsTouch(pts, cell.holes[i]))
          return this.toast(`孔洞与已有孔洞 ${i + 1} 接触或重叠，孔洞之间必须留有间隙`);
      }
      cell.holes.push(pts);
    }
    this.drawing = null;
    this.dirty = true;
    document.getElementById('tool-hole').disabled = false;
    this.renderSidebar();
    this.view.render();
  },

  dupIndex(poly) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) return i + 1;
    }
    return null;
  },

  ringStrictlyInsideCell(hole, cell) {
    return window.ClientGeom.gRingStrictlyInside(hole, cell.outer);
  },

  ringsTouch(a, b) {
    const G = window.ClientGeom;
    if (G.gPointStrictlyInside(b[0], a) || G.gPointStrictlyInside(a[0], b)) return true;
    for (const [p1, p2] of G.gEdges(a)) {
      for (const [q1, q2] of G.gEdges(b)) {
        if (G.gSegsTouch(p1, p2, q1, q2)) return true;
      }
    }
    return false;
  },

  // ---------- 定标 ----------

  addCalibPoint(pt) {
    if (!this.calibDraft) {
      this.calibDraft = [pt];
    } else {
      const p1 = this.calibDraft[0], p2 = pt;
      this.calibDraft = [p1, p2];
      this.view.render();
      const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (px < 1) {
        this.calibDraft = null;
        return this.toast('两个定标点必须是不同的像素点（间距至少 1 像素）');
      }
      const answer = prompt(`两点像素距离 ${px.toFixed(2)} px。\n请输入这两点对应的实际距离（微米 μm）：`, this.img.calib ? String(this.img.calib.distanceUm) : '');
      if (answer === null) { this.calibDraft = null; this.view.render(); return; }
      const dist = Number(answer);
      if (!Number.isFinite(dist) || dist <= 0) {
        this.calibDraft = null;
        return this.toast('标尺无效：实际距离必须是大于 0 的数值，本次定标未生效');
      }
      this.saveCalibration(p1, p2, dist);
    }
    this.view.render();
  },

  async saveCalibration(p1, p2, distanceUm) {
    try {
      const updated = await API.saveCalibration(this.imageId, this.img.version, p1, p2, distanceUm);
      // 保留本地未保存的几何草稿，按新比例重算其测量值
      const oldScale = this.img.calib ? this.img.calib.scale : null;
      this.img = updated;
      const m = window.ClientGeom.clientMeasure(this.cells, updated.calib.scale);
      if (m) this.cells.forEach((c, i) => { c.areaUm2 = m[i].areaUm2; c.perimeterUm = m[i].perimeterUm; });
      this.calibDraft = null;
      this.toast(`定标成功：1 px = ${updated.calib.scale.toFixed(6)} μm，全部草稿测量已按新比例重算`, true);
      this.renderSidebar();
      this.view.render();
    } catch (e) {
      this.calibDraft = null;
      if (e.status === 409) return this.handleConflict(e);
      this.toast(e.message);
    }
  },

  // ---------- 保存轮廓（整批原子） ----------

  async saveAll() {
    if (!this.cells.length) return this.toast('还没有任何细胞轮廓');
    const err = window.ClientGeom.clientValidate(this.cells, this.img.width, this.img.height);
    if (err) return this.toast(err);
    try {
      const payload = this.cells.map((c) => ({ id: c.id, name: c.name, outer: c.outer, holes: c.holes }));
      const updated = await API.saveContours(this.imageId, this.img.version, payload);
      await this.applyServerData(updated);
      this.renderSidebar();
      this.toast('轮廓已保存，测量值已按当前标尺计算', true);
    } catch (e) {
      if (e.status === 409) return this.handleConflict(e);
      this.toast(e.message);
    }
  },

  async handleConflict(e) {
    this.toast(`${e.message} 正在加载最新草稿…`);
    try {
      const fresh = await API.getImage(this.imageId);
      await this.applyServerData(fresh);
      this.renderSidebar();
    } catch (_) { /* ignore */ }
  },

  // ---------- 发布 ----------

  async publish() {
    if (!this.img.calib) return this.toast('请先完成标尺定标');
    if (!this.cells.length) return this.toast('请至少圈出一个细胞外轮廓');
    if (this.dirty) return this.toast('有未保存的轮廓修改，请先点击「保存全部轮廓」再发布');
    const title = prompt('报告标题：', `${this.img.filename.replace(/\.[^.]+$/, '')} 报告`);
    if (title === null) return;
    try {
      const { report } = await API.publish(this.imageId, this.img.version, title);
      this.img = await API.getImage(this.imageId);
      this.dirty = false;
      this.renderSidebar();
      this.toast(`报告已发布并冻结（草稿版本 v${report.draftVersion}）。可在「已发布报告」中查看与导出。`, true);
    } catch (e) {
      if (e.status === 409) return this.handleConflict(e);
      this.toast(e.message);
    }
  },

  // ---------- UI ----------

  deleteCell(id) {
    if (!confirm('删除该细胞及其全部孔洞？')) return;
    this.cells = this.cells.filter((c) => c.id !== id);
    if (this.activeCellId === id) this.activeCellId = this.cells[0] ? this.cells[0].id : null;
    this.dirty = true;
    this.renderSidebar();
    this.view.render();
  },

  deleteHole(cellId, idx) {
    const cell = this.cells.find((c) => c.id === cellId);
    cell.holes.splice(idx, 1);
    this.dirty = true;
    this.renderSidebar();
    this.view.render();
  },

  renameCell(id, name) {
    const cell = this.cells.find((c) => c.id === id);
    if (cell) { cell.name = name; this.dirty = true; }
  },

  selectCell(id) {
    this.activeCellId = id;
    this.renderSidebar();
  },

  renderDraftInfo() {
    const el = document.getElementById('draft-info');
    if (this.drawing) {
      const kind = this.drawing.kind === 'hole' ? '孔洞（红色）' : '细胞外轮廓';
      el.innerHTML = `正在绘制<b>${kind}</b>：已放置 ${this.drawing.points.length} 个点（至少 3 个，双击或回车完成）`;
    } else if (this.calibDraft) {
      el.innerHTML = `正在放置<b>定标点</b>：已选 ${this.calibDraft.length}/2 点`;
    } else {
      el.textContent = '';
    }
  },

  renderSidebar() {
    document.getElementById('ed-title').textContent = this.img.filename;
    document.getElementById('ed-version').textContent =
      `草稿 v${this.img.version}${this.dirty ? ' · 有未保存修改' : ''}`;

    // 定标信息
    const c = this.img.calib;
    const calibEl = document.getElementById('calib-info');
    if (c) {
      calibEl.innerHTML =
        `<span class="ok">已定标</span><br>` +
        `p1: (${c.p1.x.toFixed(1)}, ${c.p1.y.toFixed(1)})，p2: (${c.p2.x.toFixed(1)}, ${c.p2.y.toFixed(1)})<br>` +
        `像素距离 ${Math.hypot(c.p2.x - c.p1.x, c.p2.y - c.p1.y).toFixed(2)} px = <b>${c.distanceUm} μm</b><br>` +
        `比例：<b>1 px = ${c.scale.toFixed(6)} μm</b>（重新定标将自动重算全部测量）`;
    } else {
      calibEl.innerHTML = '<span class="err">尚未定标</span>：选择「定标点工具」，在图上点选两个点并输入实际微米距离。';
    }

    // 细胞列表
    const list = document.getElementById('cell-list');
    list.innerHTML = '';
    if (!this.cells.length) {
      list.innerHTML = '<p class="hint">还没有细胞。选择「画细胞外轮廓」工具开始圈选。</p>';
    }
    const live = window.ClientGeom.clientMeasure(this.cells, c ? c.scale : null);
    this.cells.forEach((cell, i) => {
      const row = document.createElement('div');
      row.className = 'cell-row' + (cell.id === this.activeCellId ? ' active' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = PALETTE[i % PALETTE.length];
      row.appendChild(sw);

      const inp = document.createElement('input');
      inp.className = 'name-edit';
      inp.value = cell.name || '';
      inp.addEventListener('change', () => this.renameCell(cell.id, inp.value));
      inp.addEventListener('focus', () => this.selectCell(cell.id));
      row.appendChild(inp);

      const holes = document.createElement('button');
      holes.textContent = `🕓 孔洞 ${cell.holes.length}`;
      holes.title = '为该细胞画孔洞';
      holes.onclick = () => {
        this.selectCell(cell.id);
        this.setTool('hole');
      };
      row.appendChild(holes);

      const del = document.createElement('button');
      del.textContent = '删除';
      del.onclick = () => this.deleteCell(cell.id);
      row.appendChild(del);

      list.appendChild(row);

      // 孔洞条目
      cell.holes.forEach((h, hi) => {
        const sub = document.createElement('div');
        sub.className = 'cell-row';
        sub.style.marginLeft = '26px';
        sub.innerHTML = `<span class="sub2">🕳 孔洞 ${hi + 1}（${h.length} 点）</span>`;
        const hd = document.createElement('button');
        hd.textContent = '删';
        hd.onclick = () => this.deleteHole(cell.id, hi);
        sub.appendChild(hd);
        list.appendChild(sub);
      });

      // 工作副本中实时测量值（保存后由服务端值覆盖）
      if (this.dirty && live) {
        cell.areaUm2 = live[i].areaUm2;
        cell.perimeterUm = live[i].perimeterUm;
      }
    });

    // 测量表
    const wrap = document.getElementById('measure-table-wrap');
    if (!c) {
      wrap.innerHTML = '<p class="hint">完成定标后显示面积（μm²）与含孔洞边界的总周长（μm）。</p>';
    } else if (!this.cells.length) {
      wrap.innerHTML = '<p class="hint">尚无细胞。</p>';
    } else {
      const rows = this.cells.map((cell, i) => `
        <tr>
          <td><span style="color:${PALETTE[i % PALETTE.length]}">●</span> ${cell.name || `细胞 ${i + 1}`}${this.dirty ? ' *' : ''}</td>
          <td>${cell.holes.length}</td>
          <td>${fmt(cell.areaUm2)}</td>
          <td>${fmt(cell.perimeterUm)}</td>
        </tr>`).join('');
      wrap.innerHTML = `
        <table class="measure">
          <thead><tr><th>细胞</th><th>孔洞</th><th>净面积 μm²</th><th>总周长 μm</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${this.dirty ? '<p class="hint">* 为未保存的实时计算值；保存后以服务端结果为准。缩放/平移不改变数值。</p>' : ''}`;
    }

    document.getElementById('save-contours').disabled = !this.dirty;
    document.getElementById('tool-hole').disabled = !this.activeCellId;
    this.renderDraftInfo();
  },

  toast(msg, ok = false) {
    const el = document.getElementById('status-toast');
    el.textContent = msg;
    el.classList.remove('hidden', 'ok');
    if (ok) el.classList.add('ok');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
  },

  onKey(e) {
    if (!this.imageId || document.getElementById('view-editor').classList.contains('hidden')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'Escape') {
      if (this.drawing || this.calibDraft) { this.cancelRing(); e.preventDefault(); }
    } else if (e.key === 'Enter' && this.drawing) {
      this.finishRing(); e.preventDefault();
    } else if (e.key === 'Backspace' && this.drawing) {
      this.undoPoint(); e.preventDefault();
    }
  },

  bindUI() {
    document.getElementById('tool-calib').onclick = () => this.setTool('calib');
    document.getElementById('tool-cell').onclick = () => this.setTool('cell');
    document.getElementById('tool-hole').onclick = () => {
      if (!this.activeCellId && this.cells.length) this.activeCellId = this.cells[0].id;
      this.setTool('hole');
    };
    document.getElementById('tool-pan').onclick = () => this.setTool('pan');
    document.getElementById('fit-view').onclick = () => this.view && this.view.fit();
    document.getElementById('finish-ring').onclick = () => this.finishRing();
    document.getElementById('undo-point').onclick = () => this.undoPoint();
    document.getElementById('cancel-ring').onclick = () => this.cancelRing();
    document.getElementById('save-contours').onclick = () => this.saveAll();
    document.getElementById('publish-btn').onclick = () => this.publish();
  }
};

window.Editor = Editor;

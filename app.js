'use strict';

/* =========================================================
 * 型紙製図アプリ
 * 座標はすべて mm 単位で保持。角度は 0°=右, 90°=上（反時計回り）。
 * ========================================================= */

// ===== 定数 =====
const STORAGE_INDEX = 'pattern:index';
const GRID = 10;              // 細グリッド間隔 (mm)
const GRID_MAJOR = 50;        // 太グリッド間隔 (mm)
const HISTORY_MAX = 50;
const TAP_THRESHOLD = 8;      // これ以上動いたらドラッグ扱い (px)
const SNAP_ENDPOINT_PX = 14;  // 既存端点へのスナップ半径 (px)
const SNAP_GRID_PX = 10;      // グリッド交点へのスナップ半径 (px)
const LINE_HIT_PX = 14;       // 線の選択判定距離 (px)
const HANDLE_HIT_PX = 26;     // ハンドルのつかみ判定 (px)
const ZOOM_MIN = 0.3, ZOOM_MAX = 20;

// ===== 状態 =====
let drawing = null;                        // { id, name, lines, updatedAt, view }
let view = { panX: -30, panY: -30, zoom: 2 }; // panX/panY: viewBox左上(mm), zoom: px/mm
let mode = 'draw';                         // 'move' | 'draw'
let currentStyle = 'solid';                // 'solid' | 'dashed'
let selectedId = null;
let pending = null;                        // { x1,y1, x2,y2, hasEnd }
let history = [];
let historyIndex = -1;
let saveTimer = null;

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const linesLayer = $('linesLayer');
const labelsLayer = $('labelsLayer');
const overlayLayer = $('overlayLayer');
const inpLen = $('inpLen');
const inpAng = $('inpAng');

const SVG_NS = 'http://www.w3.org/2000/svg';

// ===== ユーティリティ =====
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function screenToMm(px, py) {
  return { x: view.panX + px / view.zoom, y: view.panY + py / view.zoom };
}
function mmToScreen(mx, my) {
  return { x: (mx - view.panX) * view.zoom, y: (my - view.panY) * view.zoom };
}
function lineLength(l) {
  return Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
}
function lineAngle(l) {
  // 0°=右, 90°=上（画面のyは下向きなので符号反転）
  const deg = Math.atan2(-(l.y2 - l.y1), l.x2 - l.x1) * 180 / Math.PI;
  return (deg + 360) % 360;
}
function endFromLenAngle(x1, y1, len, deg) {
  const rad = deg * Math.PI / 180;
  return { x: x1 + len * Math.cos(rad), y: y1 - len * Math.sin(rad) };
}
function round1(v) {
  return Math.round(v * 10) / 10;
}
function fmt(v) {
  const r = round1(v);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// 画面距離で最寄りの既存端点を探す（吸着圏内になければnull）
function nearestEndpoint(mm, excludeLineId) {
  let best = null, bestD = SNAP_ENDPOINT_PX;
  const cur = mmToScreen(mm.x, mm.y);
  for (const l of drawing.lines) {
    if (l.id === excludeLineId) continue;
    for (const p of [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]) {
      const s = mmToScreen(p.x, p.y);
      const d = Math.hypot(s.x - cur.x, s.y - cur.y);
      if (d < bestD) { bestD = d; best = { x: p.x, y: p.y }; }
    }
  }
  return best;
}

// タップ位置(mm)をスナップ: 既存端点 > グリッド交点 > 1mm丸め
function snapPoint(mm, excludeLineId) {
  const best = nearestEndpoint(mm, excludeLineId);
  if (best) return best;

  const gx = Math.round(mm.x / GRID) * GRID;
  const gy = Math.round(mm.y / GRID) * GRID;
  const dGrid = Math.hypot((gx - mm.x) * view.zoom, (gy - mm.y) * view.zoom);
  if (dGrid < SNAP_GRID_PX) return { x: gx, y: gy };

  return { x: Math.round(mm.x), y: Math.round(mm.y) };
}

// ===== 保存（localStorage） =====
function loadIndex() {
  try { return JSON.parse(localStorage.getItem(STORAGE_INDEX)) || []; }
  catch { return []; }
}
function saveIndex(idx) {
  localStorage.setItem(STORAGE_INDEX, JSON.stringify(idx));
}
function saveNow() {
  if (!drawing) return;
  drawing.updatedAt = Date.now();
  drawing.view = { ...view };
  localStorage.setItem('pattern:' + drawing.id, JSON.stringify(drawing));
  const idx = loadIndex().filter(e => e.id !== drawing.id);
  idx.unshift({ id: drawing.id, name: drawing.name, updatedAt: drawing.updatedAt });
  saveIndex(idx);
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function createDrawing() {
  const d = {
    id: uid(),
    name: '無題',
    lines: [],
    updatedAt: Date.now(),
    view: null,
  };
  localStorage.setItem('pattern:' + d.id, JSON.stringify(d));
  return d;
}
function openDrawing(id) {
  let d = null;
  try { d = JSON.parse(localStorage.getItem('pattern:' + id)); } catch { }
  if (!d) return false;
  drawing = d;
  view = d.view ? { ...d.view } : { panX: -30, panY: -30, zoom: 2 };
  selectedId = null;
  pending = null;
  history = [JSON.stringify(drawing.lines)];
  historyIndex = 0;
  render();
  return true;
}

// ===== 履歴（undo/redo） =====
function commit() {
  history.length = historyIndex + 1;
  history.push(JSON.stringify(drawing.lines));
  if (history.length > HISTORY_MAX) history.shift();
  historyIndex = history.length - 1;
  scheduleSave();
  render();
}
function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  drawing.lines = JSON.parse(history[historyIndex]);
  if (selectedId && !drawing.lines.some(l => l.id === selectedId)) selectedId = null;
  pending = null;
  scheduleSave();
  render();
}
function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  drawing.lines = JSON.parse(history[historyIndex]);
  if (selectedId && !drawing.lines.some(l => l.id === selectedId)) selectedId = null;
  pending = null;
  scheduleSave();
  render();
}

// ===== 描画 =====
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function render() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const vw = w / view.zoom, vh = h / view.zoom;
  canvas.setAttribute('viewBox', `${view.panX} ${view.panY} ${vw} ${vh}`);

  // グリッド
  const showMinor = view.zoom >= 0.8;
  $('gridMinorPath').setAttribute('stroke-width', 1 / view.zoom);
  $('gridMajorPath').setAttribute('stroke-width', 1.5 / view.zoom);
  for (const [id, url] of [['gridRectMinor', showMinor], ['gridRectMajor', true]]) {
    const r = $(id);
    r.setAttribute('x', view.panX);
    r.setAttribute('y', view.panY);
    r.setAttribute('width', vw);
    r.setAttribute('height', vh);
    r.setAttribute('visibility', url ? 'visible' : 'hidden');
  }

  renderLines();
  renderOverlay();
  updateToolbar();
}

function renderLines() {
  linesLayer.innerHTML = '';
  labelsLayer.innerHTML = '';
  for (const l of drawing.lines) {
    const sel = l.id === selectedId;
    const attrs = {
      x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
      stroke: sel ? '#0a84ff' : '#2b2b2b',
      'stroke-width': (sel ? 3 : 1.8) / view.zoom,
      'stroke-linecap': 'round',
    };
    if (l.style === 'dashed') attrs['stroke-dasharray'] = `${8 / view.zoom} ${6 / view.zoom}`;
    linesLayer.appendChild(svgEl('line', attrs));
    addLabel(l, sel ? '#0a84ff' : '#c0392b');
  }
}

function addLabel(l, color) {
  const len = lineLength(l);
  if (len < 0.5) return;
  const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
  let rot = Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180 / Math.PI;
  if (rot > 90 || rot <= -90) rot += 180; // 文字が逆さまにならないように
  const t = svgEl('text', {
    transform: `translate(${mx} ${my}) rotate(${rot})`,
    y: -5 / view.zoom,
    'text-anchor': 'middle',
    'font-size': 13 / view.zoom,
    fill: color,
  });
  t.textContent = fmt(len);
  labelsLayer.appendChild(t);
}

function renderOverlay() {
  overlayLayer.innerHTML = '';
  const z = view.zoom;

  // 選択中の線の端点ハンドル
  if (selectedId) {
    const l = drawing.lines.find(x => x.id === selectedId);
    if (l) {
      for (const p of [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]) {
        overlayLayer.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: 8 / z,
          fill: '#fff', stroke: '#0a84ff', 'stroke-width': 2.5 / z,
        }));
      }
    }
  }

  // 作成中の線（プレビュー）
  if (pending) {
    if (pending.hasEnd) {
      const attrs = {
        x1: pending.x1, y1: pending.y1, x2: pending.x2, y2: pending.y2,
        stroke: '#0a84ff', 'stroke-width': 2.2 / z, 'stroke-linecap': 'round',
      };
      if (currentStyle === 'dashed') attrs['stroke-dasharray'] = `${8 / z} ${6 / z}`;
      overlayLayer.appendChild(svgEl('line', attrs));
      addLabelTo(overlayLayer, pending);
      // 回転ハンドル（先端）
      overlayLayer.appendChild(svgEl('circle', {
        cx: pending.x2, cy: pending.y2, r: 10 / z,
        fill: 'rgba(10,132,255,0.15)', stroke: '#0a84ff', 'stroke-width': 2.5 / z,
      }));
    }
    // 起点マーカー
    overlayLayer.appendChild(svgEl('circle', {
      cx: pending.x1, cy: pending.y1, r: 5 / z,
      fill: '#0a84ff', stroke: '#fff', 'stroke-width': 1.5 / z,
    }));
  }
}

function addLabelTo(layer, l) {
  const len = lineLength(l);
  if (len < 0.5) return;
  const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
  let rot = Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180 / Math.PI;
  if (rot > 90 || rot <= -90) rot += 180;
  const t = svgEl('text', {
    transform: `translate(${mx} ${my}) rotate(${rot})`,
    y: -5 / view.zoom,
    'text-anchor': 'middle',
    'font-size': 13 / view.zoom,
    fill: '#0a84ff',
    'font-weight': 'bold',
  });
  t.textContent = fmt(len);
  layer.appendChild(t);
}

function updateToolbar() {
  $('btnMove').classList.toggle('active', mode === 'move');
  $('btnDraw').classList.toggle('active', mode === 'draw');
  $('btnSolid').classList.toggle('active', currentStyle === 'solid');
  $('btnDashed').classList.toggle('active', currentStyle === 'dashed');
  $('btnUndo').disabled = historyIndex <= 0;
  $('btnRedo').disabled = historyIndex >= history.length - 1;

  const hasPendingLine = pending && pending.hasEnd;
  $('btnConfirm').classList.toggle('hidden', !hasPendingLine);
  $('btnCancel').classList.toggle('hidden', !pending);
  $('btnDelete').classList.toggle('hidden', !selectedId);

  // 長さ・角度欄（入力中は上書きしない）
  let target = null;
  if (selectedId) target = drawing.lines.find(l => l.id === selectedId);
  else if (hasPendingLine) target = pending;
  if (target) {
    if (document.activeElement !== inpLen) inpLen.value = round1(lineLength(target));
    if (document.activeElement !== inpAng) inpAng.value = round1(lineAngle(target));
  } else if (!pending) {
    if (document.activeElement !== inpLen) inpLen.value = '';
    if (document.activeElement !== inpAng) inpAng.value = '';
  }

  // ヒント
  let hint;
  if (mode === 'move') {
    hint = selectedId
      ? '線をドラッグで移動、端点ハンドルで変形。長さ・角度・線種の変更、削除ができます'
      : 'ドラッグで表示移動、ピンチで拡大縮小。線をタップで選択';
  } else if (!pending) {
    hint = 'キャンバスをタップして起点を置く（2本指で表示移動）';
  } else if (!pending.hasEnd) {
    hint = '終点をタップすると線が確定。または長さをmmで入力';
  } else {
    hint = '先端の○をドラッグで回転（15°スナップ・端点に吸着）。数値で微調整して［確定］';
  }
  $('hint').textContent = hint;
  $('drawingName').textContent = drawing ? drawing.name : '';
}

// ===== ポインタ操作 =====
const pointers = new Map(); // pointerId -> {x, y}
let gesture = null;
// gesture: { type: 'single', startX, startY, moved, drag, startView }
//          drag: null | 'pan' | 'pendingEnd' | 'sel1' | 'sel2'
//          { type: 'pinch', startDist, startMid, startView, worldMid }

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pos = eventPos(e);

  if (pointers.size === 2) {
    // ピンチ開始（進行中のタップ/ドラッグは破棄）
    const [p1, p2] = [...pointers.values()];
    const rect = canvas.getBoundingClientRect();
    const mid = { x: (p1.x + p2.x) / 2 - rect.left, y: (p1.y + p2.y) / 2 - rect.top };
    gesture = {
      type: 'pinch',
      startDist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
      startView: { ...view },
      worldMid: screenToMm(mid.x, mid.y),
    };
    return;
  }
  if (pointers.size > 2) return;

  // 1本指: つかむ対象を判定
  let drag = null, startLine = null;
  if (pending && pending.hasEnd && nearScreen(pos, pending.x2, pending.y2, HANDLE_HIT_PX)) {
    drag = 'pendingEnd';
  } else if (selectedId) {
    const l = drawing.lines.find(x => x.id === selectedId);
    if (l && nearScreen(pos, l.x1, l.y1, HANDLE_HIT_PX)) drag = 'sel1';
    else if (l && nearScreen(pos, l.x2, l.y2, HANDLE_HIT_PX)) drag = 'sel2';
    else if (l) {
      // 選択中の線の本体をつかんだら、線ごと移動
      const mm = screenToMm(pos.x, pos.y);
      const d = distToSegment(mm, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
      if (d * view.zoom < LINE_HIT_PX) { drag = 'lineBody'; startLine = { ...l }; }
    }
  }
  gesture = {
    type: 'single',
    startX: pos.x, startY: pos.y,
    moved: false,
    drag,
    startLine,
    startMm: screenToMm(pos.x, pos.y),
    startView: { ...view },
  };
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture && gesture.type === 'pinch' && pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const rect = canvas.getBoundingClientRect();
    const midLocal = { x: mid.x - rect.left, y: mid.y - rect.top };
    let zoom = gesture.startView.zoom * (dist / Math.max(1, gesture.startDist));
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
    view.zoom = zoom;
    view.panX = gesture.worldMid.x - midLocal.x / zoom;
    view.panY = gesture.worldMid.y - midLocal.y / zoom;
    render();
    return;
  }

  if (!gesture || gesture.type !== 'single') return;
  const pos = eventPos(e);
  const dx = pos.x - gesture.startX, dy = pos.y - gesture.startY;
  if (Math.hypot(dx, dy) > TAP_THRESHOLD) gesture.moved = true;
  if (!gesture.moved) return;

  if (gesture.drag === 'pendingEnd') {
    const mm = screenToMm(pos.x, pos.y);
    // 既存端点が近くにあれば、長さ・角度を変えてでもそこへ吸着
    const ep = nearestEndpoint(mm);
    if (ep && !(ep.x === pending.x1 && ep.y === pending.y1)) {
      pending.x2 = ep.x; pending.y2 = ep.y;
      render();
      return;
    }
    // 起点を中心に回転（長さ固定・15°スナップ、近くなければ1°刻み）
    const len = lineLength(pending);
    let deg = Math.atan2(-(mm.y - pending.y1), mm.x - pending.x1) * 180 / Math.PI;
    const near15 = Math.round(deg / 15) * 15;
    deg = Math.abs(deg - near15) <= 3 ? near15 : Math.round(deg);
    const p = endFromLenAngle(pending.x1, pending.y1, len, deg);
    pending.x2 = p.x; pending.y2 = p.y;
    render();
  } else if (gesture.drag === 'lineBody') {
    // 選択中の線をまるごと移動（1mm刻み、端点同士は吸着）
    const cur = screenToMm(pos.x, pos.y);
    const rawDx = cur.x - gesture.startMm.x;
    const rawDy = cur.y - gesture.startMm.y;
    const l0 = gesture.startLine;
    const l = drawing.lines.find(x => x.id === selectedId);
    if (!l) return;
    let dx = Math.round(rawDx), dy = Math.round(rawDy);
    let best = null, bestD = SNAP_ENDPOINT_PX;
    for (const [ex, ey] of [[l0.x1, l0.y1], [l0.x2, l0.y2]]) {
      const target = nearestEndpoint({ x: ex + rawDx, y: ey + rawDy }, l.id);
      if (target) {
        const s = mmToScreen(ex + rawDx, ey + rawDy);
        const t = mmToScreen(target.x, target.y);
        const d = Math.hypot(s.x - t.x, s.y - t.y);
        if (d < bestD) { bestD = d; best = { dx: target.x - ex, dy: target.y - ey }; }
      }
    }
    if (best) { dx = best.dx; dy = best.dy; }
    l.x1 = round1(l0.x1 + dx); l.y1 = round1(l0.y1 + dy);
    l.x2 = round1(l0.x2 + dx); l.y2 = round1(l0.y2 + dy);
    render();
  } else if (gesture.drag === 'sel1' || gesture.drag === 'sel2') {
    const l = drawing.lines.find(x => x.id === selectedId);
    if (!l) return;
    const p = snapPoint(screenToMm(pos.x, pos.y), l.id);
    if (gesture.drag === 'sel1') { l.x1 = p.x; l.y1 = p.y; }
    else { l.x2 = p.x; l.y2 = p.y; }
    render();
  } else {
    // パン（両モード共通: ドラッグ=表示移動、タップ=モード別動作）
    view.panX = gesture.startView.panX - dx / gesture.startView.zoom;
    view.panY = gesture.startView.panY - dy / gesture.startView.zoom;
    render();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);

  if (gesture && gesture.type === 'pinch') {
    if (pointers.size < 2) { gesture = null; scheduleSave(); }
    return;
  }
  if (!gesture || gesture.type !== 'single') return;
  const g = gesture;
  gesture = null;

  if (g.moved) {
    if (g.drag === 'sel1' || g.drag === 'sel2' || g.drag === 'lineBody') commit(); // 移動を確定
    else if (g.drag === 'pendingEnd') render();
    else scheduleSave(); // パン位置を保存
    return;
  }

  // タップ
  if (e.type === 'pointercancel') return;
  const pos = eventPos(e);
  if (mode === 'draw') {
    handleDrawTap(pos);
  } else {
    handleMoveTap(pos);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function nearScreen(pos, mx, my, r) {
  const s = mmToScreen(mx, my);
  return Math.hypot(s.x - pos.x, s.y - pos.y) < r;
}

function handleDrawTap(pos) {
  const p = snapPoint(screenToMm(pos.x, pos.y));
  if (!pending) {
    pending = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, hasEnd: false };
  } else if (!pending.hasEnd) {
    // 2点目のタップ → その場で線を確定（確定ボタン不要）
    if (p.x === pending.x1 && p.y === pending.y1) return; // 同じ点は無視
    drawing.lines.push({
      id: uid(),
      x1: round1(pending.x1), y1: round1(pending.y1),
      x2: round1(p.x), y2: round1(p.y),
      style: currentStyle,
    });
    pending = null;
    commit();
    return;
  } else {
    // 長さ入力のプレビュー表示中に別の場所をタップ → 起点を置き直す
    pending = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, hasEnd: false };
  }
  render();
}

function handleMoveTap(pos) {
  const mm = screenToMm(pos.x, pos.y);
  let best = null, bestD = LINE_HIT_PX / view.zoom;
  for (const l of drawing.lines) {
    const d = distToSegment(mm, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
    if (d < bestD) { bestD = d; best = l; }
  }
  selectedId = best ? best.id : null;
  if (best) currentStyle = best.style; // 線種トグルに選択線の状態を反映
  render();
}

// ===== ツールバー操作 =====
$('btnMove').addEventListener('click', () => {
  mode = 'move'; pending = null; render();
});
$('btnDraw').addEventListener('click', () => {
  mode = 'draw'; selectedId = null; render();
});
$('btnSolid').addEventListener('click', () => setStyle('solid'));
$('btnDashed').addEventListener('click', () => setStyle('dashed'));
function setStyle(s) {
  currentStyle = s;
  if (selectedId) {
    const l = drawing.lines.find(x => x.id === selectedId);
    if (l && l.style !== s) { l.style = s; commit(); return; }
  }
  render();
}

$('btnConfirm').addEventListener('click', () => {
  if (!pending || !pending.hasEnd) return;
  drawing.lines.push({
    id: uid(),
    x1: round1(pending.x1), y1: round1(pending.y1),
    x2: round1(pending.x2), y2: round1(pending.y2),
    style: currentStyle,
  });
  pending = null;
  commit();
});
$('btnCancel').addEventListener('click', () => { pending = null; render(); });
$('btnDelete').addEventListener('click', () => {
  if (!selectedId) return;
  drawing.lines = drawing.lines.filter(l => l.id !== selectedId);
  selectedId = null;
  commit();
});
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);

// 長さ・角度の数値入力
inpLen.addEventListener('change', () => applyInputs('len'));
inpAng.addEventListener('change', () => applyInputs('ang'));
function applyInputs(changed) {
  const len = parseFloat(inpLen.value);
  const ang = parseFloat(inpAng.value);

  if (selectedId) {
    const l = drawing.lines.find(x => x.id === selectedId);
    if (!l) return;
    const newLen = (!isNaN(len) && len > 0) ? len : lineLength(l);
    const newAng = !isNaN(ang) ? ang : lineAngle(l);
    const p = endFromLenAngle(l.x1, l.y1, newLen, newAng);
    l.x2 = round1(p.x); l.y2 = round1(p.y);
    commit();
    return;
  }

  if (pending) {
    if (!pending.hasEnd) {
      // 起点のみ → 長さ入力で線を生成（角度は入力値 or 0°）
      if (changed === 'len' && !isNaN(len) && len > 0) {
        const deg = !isNaN(ang) ? ang : 0;
        const p = endFromLenAngle(pending.x1, pending.y1, len, deg);
        pending.x2 = p.x; pending.y2 = p.y;
        pending.hasEnd = true;
      }
    } else {
      const newLen = (!isNaN(len) && len > 0) ? len : lineLength(pending);
      const newAng = !isNaN(ang) ? ang : lineAngle(pending);
      const p = endFromLenAngle(pending.x1, pending.y1, newLen, newAng);
      pending.x2 = p.x; pending.y2 = p.y;
    }
    render();
  }
}

// ===== 名前変更 =====
$('drawingName').addEventListener('click', () => {
  const name = prompt('製図の名前', drawing.name);
  if (name && name.trim()) {
    drawing.name = name.trim();
    saveNow();
    render();
  }
});

// ===== 製図一覧 =====
$('btnList').addEventListener('click', () => {
  renderList();
  $('listOverlay').classList.remove('hidden');
});
$('btnCloseList').addEventListener('click', () => $('listOverlay').classList.add('hidden'));
$('listOverlay').addEventListener('click', (e) => {
  if (e.target === $('listOverlay')) $('listOverlay').classList.add('hidden');
});
$('btnNew').addEventListener('click', () => {
  saveNow();
  const d = createDrawing();
  openDrawing(d.id);
  saveNow();
  $('listOverlay').classList.add('hidden');
});

function renderList() {
  const ul = $('drawingList');
  ul.innerHTML = '';
  const idx = loadIndex();
  if (idx.length === 0) {
    const li = document.createElement('li');
    li.className = 'item-empty';
    li.textContent = '保存された製図はありません';
    ul.appendChild(li);
    return;
  }
  for (const e of idx) {
    const li = document.createElement('li');
    if (drawing && e.id === drawing.id) li.classList.add('current');

    const info = document.createElement('div');
    info.className = 'item-info';
    const nm = document.createElement('div');
    nm.className = 'item-name';
    nm.textContent = e.name;
    const dt = document.createElement('div');
    dt.className = 'item-date';
    dt.textContent = new Date(e.updatedAt).toLocaleString('ja-JP');
    info.appendChild(nm);
    info.appendChild(dt);
    li.appendChild(info);

    const btnRen = document.createElement('button');
    btnRen.textContent = '名前変更';
    btnRen.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const name = prompt('製図の名前', e.name);
      if (!name || !name.trim()) return;
      const d = JSON.parse(localStorage.getItem('pattern:' + e.id));
      if (d) {
        d.name = name.trim();
        localStorage.setItem('pattern:' + e.id, JSON.stringify(d));
      }
      const idx2 = loadIndex();
      const ent = idx2.find(x => x.id === e.id);
      if (ent) { ent.name = name.trim(); saveIndex(idx2); }
      if (drawing && drawing.id === e.id) drawing.name = name.trim();
      renderList(); render();
    });
    li.appendChild(btnRen);

    const btnDel = document.createElement('button');
    btnDel.textContent = '削除';
    btnDel.className = 'danger';
    btnDel.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!confirm(`「${e.name}」を削除しますか？`)) return;
      localStorage.removeItem('pattern:' + e.id);
      saveIndex(loadIndex().filter(x => x.id !== e.id));
      if (drawing && drawing.id === e.id) {
        const idx2 = loadIndex();
        if (idx2.length) openDrawing(idx2[0].id);
        else { const d = createDrawing(); openDrawing(d.id); saveNow(); }
      }
      renderList();
    });
    li.appendChild(btnDel);

    li.addEventListener('click', () => {
      if (drawing && e.id !== drawing.id) {
        saveNow();
        openDrawing(e.id);
      }
      $('listOverlay').classList.add('hidden');
    });
    ul.appendChild(li);
  }
}

// ===== PNG書き出し =====
$('btnExport').addEventListener('click', exportPNG);
function exportPNG() {
  if (!drawing.lines.length) { alert('書き出す線がありません'); return; }
  const MARGIN = 20; // mm
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of drawing.lines) {
    x0 = Math.min(x0, l.x1, l.x2); y0 = Math.min(y0, l.y1, l.y2);
    x1 = Math.max(x1, l.x1, l.x2); y1 = Math.max(y1, l.y1, l.y2);
  }
  x0 -= MARGIN; y0 -= MARGIN; x1 += MARGIN; y1 += MARGIN;
  const wMm = x1 - x0, hMm = y1 - y0;
  const scale = Math.min(4, 4096 / wMm, 4096 / hMm); // px/mm
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(wMm * scale);
  cv.height = Math.ceil(hMm * scale);
  const ctx = cv.getContext('2d');
  const X = (mm) => (mm - x0) * scale;
  const Y = (mm) => (mm - y0) * scale;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);

  // グリッド
  for (const [step, color, lw] of [[GRID, '#d5e3f0', 1], [GRID_MAJOR, '#a8c6e0', 2]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
      ctx.moveTo(X(gx), 0); ctx.lineTo(X(gx), cv.height);
    }
    for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
      ctx.moveTo(0, Y(gy)); ctx.lineTo(cv.width, Y(gy));
    }
    ctx.stroke();
  }

  // 線
  for (const l of drawing.lines) {
    ctx.strokeStyle = '#222';
    ctx.lineWidth = Math.max(1.5, scale * 0.5);
    ctx.lineCap = 'round';
    ctx.setLineDash(l.style === 'dashed' ? [scale * 4, scale * 3] : []);
    ctx.beginPath();
    ctx.moveTo(X(l.x1), Y(l.y1));
    ctx.lineTo(X(l.x2), Y(l.y2));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 長さラベル
  ctx.fillStyle = '#c0392b';
  ctx.font = `${scale * 4}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  for (const l of drawing.lines) {
    const mx = (X(l.x1) + X(l.x2)) / 2, my = (Y(l.y1) + Y(l.y2)) / 2;
    let rot = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
    if (rot > Math.PI / 2 || rot <= -Math.PI / 2) rot += Math.PI;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(rot);
    ctx.fillText(fmt(lineLength(l)), 0, -scale * 1.5);
    ctx.restore();
  }

  cv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${drawing.name || '型紙'}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ===== 起動 =====
window.addEventListener('resize', render);

(function boot() {
  const idx = loadIndex();
  if (idx.length) {
    if (!openDrawing(idx[0].id)) {
      const d = createDrawing();
      openDrawing(d.id);
      saveNow();
    }
  } else {
    const d = createDrawing();
    openDrawing(d.id);
    saveNow();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* http配信時は無視 */ });
  }
})();

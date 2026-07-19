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
const DOUBLE_TAP_MS = 400;    // ダブルタップ判定の間隔
const DOUBLE_TAP_PX = 40;     // ダブルタップ判定の位置ずれ許容 (px)
const ZOOM_MIN = 0.3, ZOOM_MAX = 20;

// ===== 状態 =====
let drawing = null;                        // { id, name, lines, updatedAt, view }
let view = { panX: -30, panY: -30, zoom: 2 }; // panX/panY: viewBox左上(mm), zoom: px/mm
// 入力の役割分担: ペン（とマウス）=描く、指=表示移動・選択
let mode = 'draw';                         // 'draw' | 'rect' | 'dim'
let currentStyle = 'solid';                // 'solid' | 'dashed'
let selectedIds = [];                      // 選択中の線ID（複数可）
let marquee = null;                        // 範囲選択ドラッグ中の矩形 { x1,y1,x2,y2 } (mm)
let lastTouchTap = null;                   // ダブルタップ判定用 { t, x, y }
let pending = null;                        // { x1,y1, x2,y2, hasEnd }
let rectPending = null;                    // 四角形ドラッグ中のプレビュー { x1,y1,x2,y2 }
let rectAnchor = null;                     // 寸法入力パネル用の左上角
let seamLoop = null;                       // 縫い代パネル用の外形ループ
let seamDir = 'out';                       // 'out'（外側・縫い代線） | 'in'（内側・点線）
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

// 今から引く線に付ける線種（寸法モードなら 'dim'）
function drawStyle() {
  return mode === 'dim' ? 'dim' : currentStyle;
}

// 画面距離で最寄りの既存端点を探す（吸着圏内になければnull）。縫い代線・寸法線は対象外
// exclude: 除外する線ID（文字列1つ or Set）
function nearestEndpoint(mm, exclude) {
  const excl = exclude instanceof Set ? exclude : (exclude ? new Set([exclude]) : null);
  let best = null, bestD = SNAP_ENDPOINT_PX;
  const cur = mmToScreen(mm.x, mm.y);
  for (const l of drawing.lines) {
    if ((excl && excl.has(l.id)) || l.style === 'seam' || l.style === 'dim') continue;
    for (const p of [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]) {
      const s = mmToScreen(p.x, p.y);
      const d = Math.hypot(s.x - cur.x, s.y - cur.y);
      if (d < bestD) { bestD = d; best = { x: p.x, y: p.y }; }
    }
  }
  return best;
}

// 最寄りの線の中点を探す（寸法モードで「端から真ん中まで」を測るため）
function nearestMidpoint(mm, exclude) {
  const excl = exclude instanceof Set ? exclude : (exclude ? new Set([exclude]) : null);
  let best = null, bestD = SNAP_ENDPOINT_PX;
  const cur = mmToScreen(mm.x, mm.y);
  for (const l of drawing.lines) {
    if ((excl && excl.has(l.id)) || l.style === 'seam' || l.style === 'dim') continue;
    const px = (l.x1 + l.x2) / 2, py = (l.y1 + l.y2) / 2;
    const s = mmToScreen(px, py);
    const d = Math.hypot(s.x - cur.x, s.y - cur.y);
    if (d < bestD) { bestD = d; best = { x: round1(px), y: round1(py) }; }
  }
  return best;
}

// タップ位置(mm)をスナップ: 既存端点 >（寸法モードは線の中点も）> グリッド交点 > 1mm丸め
function snapPoint(mm, excludeLineId) {
  const best = nearestEndpoint(mm, excludeLineId);
  if (best) return best;

  if (mode === 'dim') {
    const mid = nearestMidpoint(mm, excludeLineId);
    if (mid) return mid;
  }

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
  selectedIds = [];
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
  selectedIds = selectedIds.filter(id => drawing.lines.some(l => l.id === id));
  pending = null;
  scheduleSave();
  render();
}
function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  drawing.lines = JSON.parse(history[historyIndex]);
  selectedIds = selectedIds.filter(id => drawing.lines.some(l => l.id === id));
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
    const sel = selectedIds.includes(l.id);
    const seam = l.style === 'seam';
    const dim = l.style === 'dim';
    const color = sel ? '#0a84ff' : dim ? '#2e7d32' : seam ? '#8f8f8f' : '#2b2b2b';
    const attrs = {
      x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
      stroke: color,
      'stroke-width': (sel ? 3 : (seam || dim) ? 1.2 : 1.8) / view.zoom,
      'stroke-linecap': 'round',
    };
    if (l.style === 'dashed') attrs['stroke-dasharray'] = `${8 / view.zoom} ${6 / view.zoom}`;
    linesLayer.appendChild(svgEl('line', attrs));
    if (dim) addDimArrows(linesLayer, l, color);
    addLabel(l, sel ? '#0a84ff' : dim ? '#2e7d32' : seam ? '#8f8f8f' : '#c0392b');
  }
}

// 寸法線の両端に矢じりを描く
function addDimArrows(layer, l, color) {
  const len = lineLength(l);
  if (len < 0.5) return;
  const ux = (l.x2 - l.x1) / len, uy = (l.y2 - l.y1) / len;
  const ah = 9 / view.zoom, aw = 3.5 / view.zoom; // 矢じりの長さ・半幅
  for (const [px, py, dx, dy] of [[l.x1, l.y1, ux, uy], [l.x2, l.y2, -ux, -uy]]) {
    const bx = px + dx * ah, by = py + dy * ah;
    const nx = -dy, ny = dx;
    layer.appendChild(svgEl('path', {
      d: `M ${bx + nx * aw} ${by + ny * aw} L ${px} ${py} L ${bx - nx * aw} ${by - ny * aw}`,
      fill: 'none', stroke: color,
      'stroke-width': 1.2 / view.zoom, 'stroke-linejoin': 'round',
    }));
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

  // 選択中の線の端点ハンドル（1本だけ選択しているとき）
  const selOne = singleSel();
  if (selOne) {
    for (const p of [{ x: selOne.x1, y: selOne.y1 }, { x: selOne.x2, y: selOne.y2 }]) {
      overlayLayer.appendChild(svgEl('circle', {
        cx: p.x, cy: p.y, r: 8 / z,
        fill: '#fff', stroke: '#0a84ff', 'stroke-width': 2.5 / z,
      }));
    }
  }

  // 範囲選択の矩形
  if (marquee) {
    overlayLayer.appendChild(svgEl('rect', {
      x: marquee.x1, y: marquee.y1,
      width: marquee.x2 - marquee.x1, height: marquee.y2 - marquee.y1,
      fill: 'rgba(10,132,255,0.08)', stroke: '#0a84ff',
      'stroke-width': 1.5 / z, 'stroke-dasharray': `${6 / z} ${4 / z}`,
    }));
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

  // 四角形ドラッグのプレビュー
  if (rectPending) {
    const x = Math.min(rectPending.x1, rectPending.x2);
    const y = Math.min(rectPending.y1, rectPending.y2);
    const w = Math.abs(rectPending.x2 - rectPending.x1);
    const h = Math.abs(rectPending.y2 - rectPending.y1);
    overlayLayer.appendChild(svgEl('rect', {
      x, y, width: w, height: h,
      fill: 'rgba(10,132,255,0.06)', stroke: '#0a84ff', 'stroke-width': 2.2 / z,
    }));
    if (w >= 1) {
      const tw = svgEl('text', {
        x: x + w / 2, y: y - 6 / z,
        'text-anchor': 'middle', 'font-size': 13 / z, fill: '#0a84ff', 'font-weight': 'bold',
      });
      tw.textContent = fmt(w);
      overlayLayer.appendChild(tw);
    }
    if (h >= 1) {
      const th = svgEl('text', {
        transform: `translate(${x - 6 / z} ${y + h / 2}) rotate(-90)`,
        'text-anchor': 'middle', 'font-size': 13 / z, fill: '#0a84ff', 'font-weight': 'bold',
      });
      th.textContent = fmt(h);
      overlayLayer.appendChild(th);
    }
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
  $('btnRect').classList.toggle('active', mode === 'rect');
  $('btnDim').classList.toggle('active', mode === 'dim');
  $('btnSolid').classList.toggle('active', currentStyle === 'solid');
  $('btnDashed').classList.toggle('active', currentStyle === 'dashed');
  $('btnUndo').disabled = historyIndex <= 0;
  $('btnRedo').disabled = historyIndex >= history.length - 1;

  const hasPendingLine = pending && pending.hasEnd;
  $('btnConfirm').classList.toggle('hidden', !hasPendingLine);
  $('btnCancel').classList.toggle('hidden', !pending);
  $('btnDelete').classList.toggle('hidden', selectedIds.length === 0);

  // 長さ・角度欄（入力中は上書きしない。複数選択中は表示しない）
  let target = singleSel();
  if (!target && hasPendingLine) target = pending;
  if (target) {
    if (document.activeElement !== inpLen) inpLen.value = round1(lineLength(target));
    if (document.activeElement !== inpAng) inpAng.value = round1(lineAngle(target));
  } else if (!pending) {
    if (document.activeElement !== inpLen) inpLen.value = '';
    if (document.activeElement !== inpAng) inpAng.value = '';
  }

  // ヒント
  let hint;
  if (mode === 'rect') {
    hint = 'ペン: ドラッグで四角形、タップで寸法入力。指: 表示移動・線の選択';
  } else if (mode === 'dim') {
    hint = '寸法: ペンで測りたい区間をドラッグ（線の端・中央に吸着）。タップ2回でも可';
  } else if (pending && !pending.hasEnd) {
    hint = 'ペンで終点をタップすると線が確定（長さ入力も可）。指タップで起点を解除';
  } else if (pending) {
    hint = '先端の○をドラッグで回転（15°スナップ・端点に吸着）。数値で微調整して［確定］';
  } else if (selectedIds.length > 1) {
    hint = `${selectedIds.length}本を選択中。指ドラッグでまとめて移動、［削除］でまとめて削除`;
  } else if (selectedIds.length === 1) {
    hint = '線をドラッグで移動、端点ハンドルで変形。指で空きをタップすると選択解除';
  } else {
    hint = 'ペン: ドラッグで線／タップで起点。指: 表示移動・タップで選択・空きをダブルタップ→ドラッグで範囲選択';
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
    marquee = null;
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
  const isTouch = e.pointerType === 'touch';
  let drag = null, startLines = null;
  if (isTouch && lastTouchTap &&
      performance.now() - lastTouchTap.t < DOUBLE_TAP_MS &&
      Math.hypot(pos.x - lastTouchTap.x, pos.y - lastTouchTap.y) < DOUBLE_TAP_PX) {
    // 指のダブルタップ→ドラッグ: 範囲選択
    drag = 'marquee';
    lastTouchTap = null;
  } else if (pending && pending.hasEnd && nearScreen(pos, pending.x2, pending.y2, HANDLE_HIT_PX)) {
    drag = 'pendingEnd';
  } else if (selectedIds.length) {
    const one = singleSel();
    if (one && nearScreen(pos, one.x1, one.y1, HANDLE_HIT_PX)) drag = 'sel1';
    else if (one && nearScreen(pos, one.x2, one.y2, HANDLE_HIT_PX)) drag = 'sel2';
    else {
      // 選択中の線の本体をつかんだら、選択している線をまとめて移動
      const mm = screenToMm(pos.x, pos.y);
      const hit = drawing.lines.some(l => selectedIds.includes(l.id) &&
        distToSegment(mm, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }) * view.zoom < LINE_HIT_PX);
      if (hit) {
        drag = 'lineBody';
        startLines = selectedIds.map(id => ({ ...drawing.lines.find(x => x.id === id) }));
      }
    }
  }
  // ペンのドラッグで描く: 四角形モードは対角指定、通常モードは始点→終点の線
  if (!drag && !isTouch) drag = (mode === 'rect') ? 'rectDraw' : 'lineDraw';
  gesture = {
    type: 'single',
    startX: pos.x, startY: pos.y,
    moved: false,
    drag,
    isTouch,
    startLines,
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
    // 選択中の線をまるごと移動（1mm刻み、端点は選択外の線の端点に吸着）
    const cur = screenToMm(pos.x, pos.y);
    const rawDx = cur.x - gesture.startMm.x;
    const rawDy = cur.y - gesture.startMm.y;
    const excl = new Set(selectedIds);
    let dx = Math.round(rawDx), dy = Math.round(rawDy);
    let best = null, bestD = SNAP_ENDPOINT_PX;
    for (const l0 of gesture.startLines) {
      for (const [ex, ey] of [[l0.x1, l0.y1], [l0.x2, l0.y2]]) {
        const target = nearestEndpoint({ x: ex + rawDx, y: ey + rawDy }, excl);
        if (target) {
          const s = mmToScreen(ex + rawDx, ey + rawDy);
          const t = mmToScreen(target.x, target.y);
          const d = Math.hypot(s.x - t.x, s.y - t.y);
          if (d < bestD) { bestD = d; best = { dx: target.x - ex, dy: target.y - ey }; }
        }
      }
    }
    if (best) { dx = best.dx; dy = best.dy; }
    for (const l0 of gesture.startLines) {
      const l = drawing.lines.find(x => x.id === l0.id);
      if (!l) continue;
      l.x1 = round1(l0.x1 + dx); l.y1 = round1(l0.y1 + dy);
      l.x2 = round1(l0.x2 + dx); l.y2 = round1(l0.y2 + dy);
    }
    render();
  } else if (gesture.drag === 'marquee') {
    // 範囲選択: 矩形に完全に入った線を選択（プレビューしながら更新）
    const a = gesture.startMm, b = screenToMm(pos.x, pos.y);
    marquee = {
      x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
    };
    const inRect = (x, y) => x >= marquee.x1 && x <= marquee.x2 && y >= marquee.y1 && y <= marquee.y2;
    selectedIds = drawing.lines
      .filter(l => inRect(l.x1, l.y1) && inRect(l.x2, l.y2))
      .map(l => l.id);
    render();
  } else if (gesture.drag === 'rectDraw') {
    const a = snapPoint(gesture.startMm);
    const b = snapPoint(screenToMm(pos.x, pos.y));
    rectPending = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    render();
  } else if (gesture.drag === 'lineDraw') {
    const a = snapPoint(gesture.startMm);
    const b = snapPoint(screenToMm(pos.x, pos.y));
    selectedIds = [];
    pending = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, hasEnd: true };
    render();
  } else if (gesture.drag === 'sel1' || gesture.drag === 'sel2') {
    const l = singleSel();
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
    else if (g.drag === 'rectDraw') finishRectDrag();
    else if (g.drag === 'lineDraw') finishLineDrag();
    else if (g.drag === 'marquee') { marquee = null; render(); } // 選択は確定済み
    else if (g.drag === 'pendingEnd') render();
    else scheduleSave(); // パン位置を保存
    return;
  }
  if (g.drag === 'rectDraw') rectPending = null;

  // タップ
  if (e.type === 'pointercancel') return;
  const pos = eventPos(e);
  if (g.isTouch) {
    // 指タップ: 起点があれば解除、なければ線の選択/選択解除
    if (pending) {
      pending = null;
      lastTouchTap = null;
      render();
    } else {
      const hit = hitLine(screenToMm(pos.x, pos.y));
      selectLine(hit);
      // 空振りのタップだけをダブルタップ（範囲選択）の1回目として数える
      // （線をタップ選択→すぐドラッグで移動、が誤判定されないように）
      lastTouchTap = hit ? null : { t: performance.now(), x: pos.x, y: pos.y };
    }
  } else if (mode === 'rect') {
    handleRectTap(pos);
  } else {
    handleDrawTap(pos);
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
  const mm = screenToMm(pos.x, pos.y);
  if (!pending) {
    // ペンのタップは常に「点を置く」（選択は指タップの役割）
    selectedIds = [];
    const p0 = snapPoint(mm);
    pending = { x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y, hasEnd: false };
    render();
    return;
  }
  const p = snapPoint(mm);
  if (!pending.hasEnd) {
    // 2点目のタップ → その場で線を確定（確定ボタン不要）
    if (p.x === pending.x1 && p.y === pending.y1) return; // 同じ点は無視
    drawing.lines.push({
      id: uid(),
      x1: round1(pending.x1), y1: round1(pending.y1),
      x2: round1(p.x), y2: round1(p.y),
      style: drawStyle(),
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

// ペンのドラッグ終了 → 始点から離した点までの線を作成
function finishLineDrag() {
  const p = pending;
  pending = null;
  if (!p || lineLength(p) < 1) { render(); return; } // 短すぎるものは誤操作とみなす
  drawing.lines.push({
    id: uid(),
    x1: round1(p.x1), y1: round1(p.y1),
    x2: round1(p.x2), y2: round1(p.y2),
    style: drawStyle(),
  });
  commit();
}

function hitLine(mm) {
  let best = null, bestD = LINE_HIT_PX / view.zoom;
  for (const l of drawing.lines) {
    const d = distToSegment(mm, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}
function selectLine(l) {
  selectedIds = l ? [l.id] : [];
  if (l && l.style !== 'seam' && l.style !== 'dim') currentStyle = l.style; // 線種トグルに選択線の状態を反映
  render();
}
// 1本だけ選択しているときその線を返す（0本・複数ならnull）
function singleSel() {
  return selectedIds.length === 1
    ? (drawing.lines.find(l => l.id === selectedIds[0]) || null)
    : null;
}
function handleMoveTap(pos) {
  selectLine(hitLine(screenToMm(pos.x, pos.y)));
}

// ===== ツールバー操作 =====
$('btnSolid').addEventListener('click', () => setStyle('solid'));
$('btnDashed').addEventListener('click', () => setStyle('dashed'));
function setStyle(s) {
  currentStyle = s;
  let changed = false;
  for (const id of selectedIds) {
    const l = drawing.lines.find(x => x.id === id);
    if (l && l.style !== s) { l.style = s; changed = true; }
  }
  if (changed) { commit(); return; }
  render();
}

$('btnConfirm').addEventListener('click', () => {
  if (!pending || !pending.hasEnd) return;
  drawing.lines.push({
    id: uid(),
    x1: round1(pending.x1), y1: round1(pending.y1),
    x2: round1(pending.x2), y2: round1(pending.y2),
    style: drawStyle(),
  });
  pending = null;
  commit();
});
$('btnCancel').addEventListener('click', () => { pending = null; render(); });
$('btnDelete').addEventListener('click', () => {
  if (!selectedIds.length) return;
  drawing.lines = drawing.lines.filter(l => !selectedIds.includes(l.id));
  selectedIds = [];
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

  if (selectedIds.length) {
    const l = singleSel();
    if (!l) return; // 複数選択中は数値では編集しない
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

// ===== 四角形ツール =====
$('btnRect').addEventListener('click', () => {
  mode = (mode === 'rect') ? 'draw' : 'rect';
  pending = null;
  selectedIds = [];
  rectPending = null;
  render();
});

// ===== 寸法ツール =====
$('btnDim').addEventListener('click', () => {
  mode = (mode === 'dim') ? 'draw' : 'dim';
  pending = null;
  selectedIds = [];
  rectPending = null;
  render();
});

// 四角形モードでタップ → その点を左上角として寸法入力パネルを開く
function handleRectTap(pos) {
  rectAnchor = snapPoint(screenToMm(pos.x, pos.y));
  $('rectOverlay').classList.remove('hidden');
}

// 四角形モードのドラッグ終了 → 対角2点から四角形を作成
function finishRectDrag() {
  const r = rectPending;
  rectPending = null;
  if (!r) { render(); return; }
  const x = Math.min(r.x1, r.x2), y = Math.min(r.y1, r.y2);
  const w = Math.abs(r.x2 - r.x1), h = Math.abs(r.y2 - r.y1);
  if (w < 1 || h < 1) { render(); return; } // 細すぎるものは誤操作とみなす
  pushRectLines(x, y, w, h);
  commit();
}

function pushRectLines(ox, oy, w, h) {
  const pts = [[ox, oy], [ox + w, oy], [ox + w, oy + h], [ox, oy + h]];
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % 4];
    drawing.lines.push({
      id: uid(),
      x1: round1(x1), y1: round1(y1), x2: round1(x2), y2: round1(y2),
      style: currentStyle,
    });
  }
}

$('btnRectCancel').addEventListener('click', () => {
  rectAnchor = null;
  $('rectOverlay').classList.add('hidden');
});
$('rectOverlay').addEventListener('click', (e) => {
  if (e.target === $('rectOverlay')) { rectAnchor = null; $('rectOverlay').classList.add('hidden'); }
});
$('btnRectCreate').addEventListener('click', () => {
  const w = parseFloat($('inpRectW').value);
  const h = parseFloat($('inpRectH').value);
  if (!(w > 0) || !(h > 0)) { alert('幅と高さをmmで入力してください'); return; }
  let ox, oy;
  if (rectAnchor) {
    ox = rectAnchor.x; oy = rectAnchor.y; // タップした点を左上角に
  } else if (pending) {
    ox = pending.x1; oy = pending.y1;
  } else {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    ox = Math.round((view.panX + cw / 2 / view.zoom - w / 2) / GRID) * GRID;
    oy = Math.round((view.panY + ch / 2 / view.zoom - h / 2) / GRID) * GRID;
  }
  pushRectLines(ox, oy, w, h);
  pending = null;
  selectedIds = [];
  rectAnchor = null;
  $('rectOverlay').classList.add('hidden');
  commit();
});

// ===== 縫い代／内側線の自動生成 =====
$('btnSeam').addEventListener('click', () => {
  const sel = singleSel();
  if (!sel || sel.style === 'seam' || sel.style === 'dim') {
    alert('線を1本タップで選択してから押してください');
    return;
  }
  const loop = traceLoop(sel);
  if (!loop) {
    alert('選択した線がつながった閉じた形になっていません。\n端点同士をぴったり合わせて（吸着させて）ください');
    return;
  }
  seamLoop = loop;
  updateSeamDirButtons();
  $('seamOverlay').classList.remove('hidden');
});
$('btnSeamOut').addEventListener('click', () => { seamDir = 'out'; updateSeamDirButtons(); });
$('btnSeamIn').addEventListener('click', () => { seamDir = 'in'; updateSeamDirButtons(); });
function updateSeamDirButtons() {
  $('btnSeamOut').classList.toggle('active', seamDir === 'out');
  $('btnSeamIn').classList.toggle('active', seamDir === 'in');
}
$('btnSeamCancel').addEventListener('click', () => {
  seamLoop = null;
  $('seamOverlay').classList.add('hidden');
});
$('seamOverlay').addEventListener('click', (e) => {
  if (e.target === $('seamOverlay')) { seamLoop = null; $('seamOverlay').classList.add('hidden'); }
});
$('btnSeamCreate').addEventListener('click', () => {
  const d = parseFloat($('inpSeamW').value);
  if (!(d > 0)) { alert('幅をmmで入力してください'); return; }
  if (!seamLoop) return;
  const out = offsetPolygon(seamLoop, seamDir === 'in' ? -d : d);
  const style = seamDir === 'in' ? 'dashed' : 'seam'; // 内側は点線（折り・出来上がり線）
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[(i + 1) % out.length];
    drawing.lines.push({
      id: uid(),
      x1: round1(a.x), y1: round1(a.y), x2: round1(b.x), y2: round1(b.y),
      style,
    });
  }
  seamLoop = null;
  $('seamOverlay').classList.add('hidden');
  commit();
});

// 選択した線から端点同士がつながった閉じたループをたどる（縫い代線・寸法線は無視）
function traceLoop(startLine) {
  const key = (x, y) => x + ',' + y;
  const map = new Map();
  for (const l of drawing.lines) {
    if (l.style === 'seam' || l.style === 'dim') continue;
    for (const k of [key(l.x1, l.y1), key(l.x2, l.y2)]) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(l);
    }
  }
  const pts = [{ x: startLine.x1, y: startLine.y1 }];
  const used = new Set([startLine.id]);
  let cur = { x: startLine.x2, y: startLine.y2 };
  for (let guard = 0; guard < 500; guard++) {
    if (cur.x === pts[0].x && cur.y === pts[0].y) return pts.length >= 3 ? pts : null;
    pts.push({ ...cur });
    const conns = (map.get(key(cur.x, cur.y)) || []).filter(l => !used.has(l.id));
    if (conns.length !== 1) return null; // 行き止まり・分岐は閉形と判断できない
    const l = conns[0];
    used.add(l.id);
    cur = (l.x1 === cur.x && l.y1 === cur.y) ? { x: l.x2, y: l.y2 } : { x: l.x1, y: l.y1 };
  }
  return null;
}

// 多角形を外側へdだけオフセットした頂点列を返す（角はマイター接合）
function offsetPolygon(pts, d) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const s = area > 0 ? 1 : -1;
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = s * (b.y - a.y) / len, ny = s * -(b.x - a.x) / len;
    edges.push({ ax: a.x + nx * d, ay: a.y + ny * d, bx: b.x + nx * d, by: b.y + ny * d });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const e1 = edges[(i + n - 1) % n], e2 = edges[i];
    out.push(intersectLines(e1, e2) || { x: e2.ax, y: e2.ay });
  }
  return out;
}
function intersectLines(e1, e2) {
  const d1x = e1.bx - e1.ax, d1y = e1.by - e1.ay;
  const d2x = e2.bx - e2.ax, d2y = e2.by - e2.ay;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((e2.ax - e1.ax) * d2y - (e2.ay - e1.ay) * d2x) / den;
  return { x: e1.ax + t * d1x, y: e1.ay + t * d1y };
}

// ===== バックアップ（書き出し／読み込み） =====
function buildBackupData() {
  saveNow();
  const drawings = loadIndex()
    .map(e => { try { return JSON.parse(localStorage.getItem('pattern:' + e.id)); } catch { return null; } })
    .filter(Boolean);
  return { app: 'katagami-seizu', version: 1, drawings };
}
$('btnBackup').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(buildBackupData())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  a.download = `katagami-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
function applyBackupData(data) {
  if (!data || data.app !== 'katagami-seizu' || !Array.isArray(data.drawings)) return -1;
  let count = 0;
  for (const d of data.drawings) {
    if (!d || !d.id || !Array.isArray(d.lines)) continue;
    localStorage.setItem('pattern:' + d.id, JSON.stringify(d));
    const idx = loadIndex().filter(e => e.id !== d.id);
    idx.unshift({ id: d.id, name: d.name || '無題', updatedAt: d.updatedAt || Date.now() });
    saveIndex(idx);
    count++;
  }
  if (count > 0 && drawing && data.drawings.some(d => d && d.id === drawing.id)) {
    openDrawing(drawing.id); // 開いている製図が上書きされたら読み直す
  }
  return count;
}
$('btnRestore').addEventListener('click', () => $('fileRestore').click());
$('fileRestore').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data = null;
    try { data = JSON.parse(reader.result); } catch { }
    const count = applyBackupData(data);
    if (count < 0) alert('バックアップファイルの形式が正しくありません');
    else {
      alert(`${count}件の製図を読み込みました`);
      renderList();
      render();
    }
  };
  reader.readAsText(f);
});

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
    const seam = l.style === 'seam';
    const dim = l.style === 'dim';
    ctx.strokeStyle = dim ? '#2e7d32' : seam ? '#8f8f8f' : '#222';
    ctx.lineWidth = (seam || dim) ? Math.max(1, scale * 0.3) : Math.max(1.5, scale * 0.5);
    ctx.lineCap = 'round';
    ctx.setLineDash(l.style === 'dashed' ? [scale * 4, scale * 3] : []);
    ctx.beginPath();
    ctx.moveTo(X(l.x1), Y(l.y1));
    ctx.lineTo(X(l.x2), Y(l.y2));
    ctx.stroke();
    if (dim) {
      // 両端の矢じり
      const len = lineLength(l);
      if (len >= 0.5) {
        const ux = (l.x2 - l.x1) / len, uy = (l.y2 - l.y1) / len;
        const ah = 4, aw = 1.5; // mm
        ctx.setLineDash([]);
        for (const [px, py, dx, dy] of [[l.x1, l.y1, ux, uy], [l.x2, l.y2, -ux, -uy]]) {
          const bx = px + dx * ah, by = py + dy * ah;
          const nx = -dy, ny = dx;
          ctx.beginPath();
          ctx.moveTo(X(bx + nx * aw), Y(by + ny * aw));
          ctx.lineTo(X(px), Y(py));
          ctx.lineTo(X(bx - nx * aw), Y(by - ny * aw));
          ctx.stroke();
        }
      }
    }
  }
  ctx.setLineDash([]);

  // 長さラベル
  ctx.font = `${scale * 4}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  for (const l of drawing.lines) {
    ctx.fillStyle = l.style === 'dim' ? '#2e7d32' : l.style === 'seam' ? '#8f8f8f' : '#c0392b';
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

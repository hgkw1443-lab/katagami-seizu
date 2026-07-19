// ヘッドレスEdge(CDP)で型紙アプリの主要フローを検証する
const CDP_PORT = 9333;
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8123/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 既存タブは流用しない（ダウンロード操作が残す小型ポップアップに接続すると
// レイアウト高さ0でrender()が動かず誤検出するため、毎回正しいサイズの新規ウィンドウを作る）
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
const newTarget = await new Promise((res) => {
  bws.onmessage = (ev) => res(JSON.parse(ev.data));
  bws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank', newWindow: true, width: 1180, height: 820 } }));
});
bws.close();
const targetId = newTarget.result.targetId;
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.id === targetId);
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
};
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`CDP timeout: ${method} ${JSON.stringify(params).slice(0, 120)}`));
      }
    }, 15000);
  });
}
async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.result.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  return r.result.result.value;
}

const results = [];
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Page.bringToFront'); // 非アクティブタブはレイアウト幅0になりrender()が動かないため前面化
await send('Page.navigate', { url: APP_URL });
await sleep(1500);

// テスト前に前回のSWキャッシュとデータを完全クリアして再読込
await evaluate(`(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const r of regs) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  localStorage.clear();
})()`, true);
await send('Page.navigate', { url: APP_URL });
await sleep(1200);
events.length = 0; // ここから発生したエラーだけを数える

check('タイトル', (await evaluate('document.title')) === '型紙製図');
check('ページ読み込みでエラーなし', events.filter((e) => e.method === 'Runtime.exceptionThrown').length === 0);
check('初期状態: 製図が作成されている', await evaluate('drawing && Array.isArray(drawing.lines) && drawing.lines.length === 0'));
check('初期モードは描画', (await evaluate('mode')) === 'draw');

// --- 2点タップで線を引く ---
await evaluate('handleDrawTap({x:200, y:200})');
check('1回目タップで起点が置かれる', await evaluate('pending && !pending.hasEnd'));
await evaluate('handleDrawTap({x:400, y:200})');
check('2点目のタップで即確定される', (await evaluate('drawing.lines.length')) === 1);
check('確定後はpendingが消える', (await evaluate('pending')) === null);
const line0Len = await evaluate('Math.round(lineLength(drawing.lines[0]))');
check('線の長さ=100mm (200px/zoom2)', line0Len === 100, `len=${line0Len}`);
check('線は実線', (await evaluate('drawing.lines[0].style')) === 'solid');
check('長さラベルが表示される', await evaluate("[...labelsLayer.querySelectorAll('text')].some(t => t.textContent === '100')"));

// --- 長さ指定+角度指定で線を引く ---
await evaluate('handleDrawTap({x:200, y:200})'); // 既存端点にスナップするはず
check('起点が既存端点(50,70)にスナップ', await evaluate('pending.x1 === drawing.lines[0].x1 && pending.y1 === drawing.lines[0].y1'));
await evaluate("(() => { const i=document.getElementById('inpAng'); i.value='90'; i.dispatchEvent(new Event('change')); })()");
await evaluate("(() => { const i=document.getElementById('inpLen'); i.value='250'; i.dispatchEvent(new Event('change')); })()");
check('長さ入力でプレビューが出る', await evaluate('pending && pending.hasEnd'));
const angLen = await evaluate('({l: Math.round(lineLength(pending)*10)/10, a: Math.round(lineAngle(pending))})');
check('長さ250mm・角度90°', angLen.l === 250 && angLen.a === 90, JSON.stringify(angLen));
check('90°は上向き(y2<y1)', await evaluate('pending.y2 < pending.y1'));
await evaluate("document.getElementById('btnConfirm').click()");
check('2本目が確定', (await evaluate('drawing.lines.length')) === 2);

// --- 移動モードで選択・編集 ---
await evaluate("document.getElementById('btnMove').click()");
check('移動モードに切替', (await evaluate('mode')) === 'move');
// 1本目の線の中点(画面座標)をタップ
await evaluate(`(() => {
  const l = drawing.lines[0];
  const s = mmToScreen((l.x1+l.x2)/2, (l.y1+l.y2)/2);
  handleMoveTap(s);
})()`);
check('線をタップで選択できる', (await evaluate('selectedId')) === (await evaluate('drawing.lines[0].id')));
check('削除ボタンが表示される', await evaluate("!document.getElementById('btnDelete').classList.contains('hidden')"));
// 長さを変更
await evaluate("(() => { const i=document.getElementById('inpLen'); i.value='300'; i.dispatchEvent(new Event('change')); })()");
const editedLen = await evaluate('Math.round(lineLength(drawing.lines[0]))');
check('選択線の長さを300に変更', editedLen === 300, `len=${editedLen}`);
// 点線に変更
await evaluate("document.getElementById('btnDashed').click()");
check('選択線を点線に変更', (await evaluate('drawing.lines[0].style')) === 'dashed');
check('SVGにdasharrayが付く', await evaluate("!!linesLayer.querySelector('line[stroke-dasharray]')"));

// --- undo/redo ---
await evaluate("document.getElementById('btnUndo').click()");
check('undoで実線に戻る', (await evaluate('drawing.lines[0].style')) === 'solid');
await evaluate("document.getElementById('btnRedo').click()");
check('redoで点線に戻る', (await evaluate('drawing.lines[0].style')) === 'dashed');
// --- 線ごと移動（本体ドラッグ） ---
await evaluate(`(() => {
  const l = drawing.lines[0];
  handleMoveTap(mmToScreen((l.x1+l.x2)/2, (l.y1+l.y2)/2));
})()`);
await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const l = drawing.lines[0];
  const s = mmToScreen((l.x1+l.x2)/2, (l.y1+l.y2)/2);
  const opts = (x, y) => ({ pointerId: 20, isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(s.x, s.y)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(s.x + 80, s.y + 40)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(s.x + 80, s.y + 40)));
})()`);
const movedLine = await evaluate('({x1: drawing.lines[0].x1, y1: drawing.lines[0].y1, x2: drawing.lines[0].x2, y2: drawing.lines[0].y2})');
check('線本体のドラッグで平行移動 (+40,+20mm)',
  movedLine.x1 === 110 && movedLine.y1 === 90 && movedLine.x2 === 410 && movedLine.y2 === 90,
  JSON.stringify(movedLine));
// 端点近くまで戻すと吸着してぴったり揃う
await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const l = drawing.lines[0];
  const s = mmToScreen((l.x1+l.x2)/2, (l.y1+l.y2)/2);
  const opts = (x, y) => ({ pointerId: 21, isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(s.x, s.y)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(s.x - 83, s.y - 42)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(s.x - 83, s.y - 42)));
})()`);
const snappedLine = await evaluate('({x1: drawing.lines[0].x1, y1: drawing.lines[0].y1})');
check('移動中に他の線の端点へ吸着する', snappedLine.x1 === 70 && snappedLine.y1 === 70, JSON.stringify(snappedLine));
check('移動もundo対象',
  await evaluate("(() => { document.getElementById('btnUndo').click(); const v = drawing.lines[0].x1 === 110; document.getElementById('btnRedo').click(); return v && drawing.lines[0].x1 === 70; })()"));

// --- 作成中プレビュー先端の端点吸着 ---
await evaluate("document.getElementById('btnDraw').click()");
await evaluate('handleDrawTap({x:900, y:500})');
await evaluate("(() => { const i=document.getElementById('inpLen'); i.value='100'; i.dispatchEvent(new Event('change')); })()");
await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const s = mmToScreen(pending.x2, pending.y2);
  const t = mmToScreen(drawing.lines[0].x2, drawing.lines[0].y2);
  const opts = (id, x, y) => ({ pointerId: id, isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(22, s.x, s.y)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(22, t.x + 3, t.y + 3)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(22, t.x + 3, t.y + 3)));
})()`);
check('プレビュー先端が既存端点に吸着',
  await evaluate('pending.x2 === drawing.lines[0].x2 && pending.y2 === drawing.lines[0].y2'));
await evaluate("document.getElementById('btnCancel').click()");
check('✕でプレビュー解除', (await evaluate('pending')) === null);

// 削除→undo
await evaluate(`(() => {
  const l = drawing.lines[0];
  const s = mmToScreen((l.x1+l.x2)/2, (l.y1+l.y2)/2);
  handleMoveTap(s);
})()`);
await evaluate("document.getElementById('btnDelete').click()");
check('削除で1本になる', (await evaluate('drawing.lines.length')) === 1);
await evaluate("document.getElementById('btnUndo').click()");
check('undoで2本に戻る', (await evaluate('drawing.lines.length')) === 2);

// --- 自動保存とリロード復元 ---
await sleep(500);
const savedCount = await evaluate("JSON.parse(localStorage.getItem('pattern:' + drawing.id)).lines.length");
check('自動保存されている', savedCount === 2, `saved=${savedCount}`);
await send('Page.navigate', { url: APP_URL });
await sleep(1200);
check('リロード後に復元される', (await evaluate('drawing.lines.length')) === 2);

// --- PNG書き出し（クラッシュしないこと） ---
await evaluate('exportPNG()');
await sleep(600);
const errors2 = events.filter((e) => e.method === 'Runtime.exceptionThrown');
check('PNG書き出しでエラーなし', errors2.length === 0, JSON.stringify(errors2.slice(0, 1)));

// --- 描画モードでの線選択・移動 ---
await evaluate(`handleDrawTap((() => { const l = drawing.lines[0]; return mmToScreen((l.x1+l.x2)/2, (l.y1+l.y2)/2); })())`);
check('描画モードで線タップ→選択される', await evaluate('selectedId === drawing.lines[0].id && !pending'));
await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const l = drawing.lines[0];
  const s = mmToScreen((l.x1+l.x2)/2, (l.y1+l.y2)/2);
  const opts = (x, y) => ({ pointerId: 30, isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(s.x, s.y)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(s.x + 40, s.y + 20)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(s.x + 40, s.y + 20)));
})()`);
check('描画モードのまま線をドラッグで移動できる',
  await evaluate('drawing.lines[0].x1 === 90 && drawing.lines[0].y1 === 80'),
  await evaluate('JSON.stringify([drawing.lines[0].x1, drawing.lines[0].y1])'));
await evaluate('handleDrawTap({x:1000, y:600})');
check('空きタップで選択解除して起点が置かれる', await evaluate('!selectedId && pending && !pending.hasEnd'));
await evaluate("document.getElementById('btnCancel').click()");
await evaluate("document.getElementById('btnUndo').click()"); // 移動を元に戻す

// --- 四角形ツール（タップ→寸法入力） ---
await evaluate("document.getElementById('btnSolid').click()");
await evaluate("document.getElementById('btnRect').click()");
check('四角形モードに切替', (await evaluate('mode')) === 'rect');
await evaluate('handleRectTap({x:200, y:400})'); // (70,170)
check('タップで寸法パネルが開く', await evaluate("!document.getElementById('rectOverlay').classList.contains('hidden')"));
await evaluate(`(() => {
  document.getElementById('inpRectW').value = '300';
  document.getElementById('inpRectH').value = '200';
  document.getElementById('btnRectCreate').click();
})()`);
check('四角形が4本の線で作成される', (await evaluate('drawing.lines.length')) === 6);
const rectCoords = await evaluate("JSON.stringify(drawing.lines.slice(2).map(l => [l.x1,l.y1,l.x2,l.y2,l.style]))");
check('四角形の座標が正しい（タップ点が左上角）',
  rectCoords === JSON.stringify([[70,170,370,170,'solid'],[370,170,370,370,'solid'],[370,370,70,370,'solid'],[70,370,70,170,'solid']]),
  rectCoords);

// --- 四角形ツール（ドラッグで対角指定） ---
await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const opts = (x, y) => ({ pointerId: 40, isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(600, 500)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(800, 600)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(800, 600)));
})()`);
const dragRect = await evaluate("JSON.stringify(drawing.lines.slice(6).map(l => [l.x1,l.y1,l.x2,l.y2]))");
check('ドラッグで四角形が作成される',
  (await evaluate('drawing.lines.length')) === 10 &&
  dragRect === JSON.stringify([[270,220,370,220],[370,220,370,270],[370,270,270,270],[270,270,270,220]]),
  dragRect);
await evaluate("document.getElementById('btnUndo').click()"); // ドラッグ分を戻す
check('（後始末）undoで6本に戻る', (await evaluate('drawing.lines.length')) === 6);

// --- 縫い代の自動生成（外側） ---
await evaluate('handleMoveTap(mmToScreen(220, 170))'); // 四角形の上辺を選択
check('四角形の辺を選択できる', await evaluate('!!selectedId'));
await evaluate("document.getElementById('btnSeam').click()");
check('縫い代パネルが開く', await evaluate("!document.getElementById('seamOverlay').classList.contains('hidden')"));
await evaluate(`(() => {
  document.getElementById('inpSeamW').value = '10';
  document.getElementById('btnSeamOut').click();
  document.getElementById('btnSeamCreate').click();
})()`);
check('縫い代線が4本追加される',
  await evaluate("drawing.lines.length === 10 && drawing.lines.slice(6).every(l => l.style === 'seam')"));
const seamPts = await evaluate("JSON.stringify(drawing.lines.filter(l => l.style==='seam').flatMap(l => [[l.x1,l.y1],[l.x2,l.y2]]).map(p => p.join(',')).sort())");
const expSeam = JSON.stringify(['60,160','60,160','60,380','60,380','380,160','380,160','380,380','380,380'].sort());
check('縫い代が10mm外側にオフセットされる', seamPts === expSeam, seamPts);
check('縫い代込みでもPNG書き出しが動く',
  (await evaluate("(() => { try { exportPNG(); return true; } catch (e) { return false; } })()")) === true);

// --- 内側オフセット（点線） ---
await evaluate('handleMoveTap(mmToScreen(220, 170))'); // 上辺を再選択
await evaluate("document.getElementById('btnSeam').click()");
await evaluate(`(() => {
  document.getElementById('inpSeamW').value = '10';
  document.getElementById('btnSeamIn').click();
  document.getElementById('btnSeamCreate').click();
})()`);
check('内側の点線が4本追加される',
  await evaluate("drawing.lines.length === 14 && drawing.lines.slice(10).every(l => l.style === 'dashed')"));
const inPts = await evaluate("JSON.stringify(drawing.lines.slice(10).flatMap(l => [[l.x1,l.y1],[l.x2,l.y2]]).map(p => p.join(',')).sort())");
const expIn = JSON.stringify(['80,180','80,180','80,360','80,360','360,180','360,180','360,360','360,360'].sort());
check('内側に10mmオフセットされる', inPts === expIn, inPts);

// --- バックアップ（書き出し／読み込み） ---
const backupJson = await evaluate('JSON.stringify(buildBackupData())');
const backup = JSON.parse(backupJson);
check('バックアップデータが生成できる',
  backup.app === 'katagami-seizu' && backup.drawings.length >= 1 && backup.drawings.some((d) => d.lines && d.lines.length === 14));
await evaluate("(() => { localStorage.removeItem('pattern:' + drawing.id); saveIndex(loadIndex().filter(e => e.id !== drawing.id)); })()");
check('（確認）削除でデータが消えている', (await evaluate("!!localStorage.getItem('pattern:' + drawing.id)")) === false);
const restoredCount = await evaluate(`applyBackupData(${backupJson})`);
check('バックアップから復元できる',
  restoredCount >= 1 && (await evaluate("JSON.parse(localStorage.getItem('pattern:' + drawing.id)).lines.length")) === 14);

// --- 実ポインタイベント経路（タップ・パン・ピンチ） ---
await evaluate("pending = null; selectedId = null; mode = 'draw'; render()");
await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const opts = (x, y) => ({ pointerId: 7, isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(500, 300)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(500, 300)));
})()`);
check('実イベント: タップで起点が置かれる', await evaluate('pending && !pending.hasEnd'));

await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const opts = (x, y) => ({ pointerId: 8, isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  window.__before = { ...view };
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(600, 300)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(650, 340)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(650, 340)));
})()`);
const panOk = await evaluate(
  'Math.abs(view.panX - (__before.panX - 50 / __before.zoom)) < 0.01 && Math.abs(view.panY - (__before.panY - 40 / __before.zoom)) < 0.01');
check('実イベント: ドラッグでパン', panOk);

const pinchOk = await evaluate(`(() => {
  const r = canvas.getBoundingClientRect();
  const opts = (id, x, y) => ({ pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true });
  const before = { ...view };
  const worldMid = screenToMm(500, 300);
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(9, 400, 300)));
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(10, 600, 300)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(9, 350, 300)));
  canvas.dispatchEvent(new PointerEvent('pointermove', opts(10, 650, 300)));
  const after = screenToMm(500, 300);
  const zoomOk = Math.abs(view.zoom - before.zoom * 1.5) < 0.01;
  const anchorOk = Math.abs(after.x - worldMid.x) < 0.05 && Math.abs(after.y - worldMid.y) < 0.05;
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(9, 350, 300)));
  canvas.dispatchEvent(new PointerEvent('pointerup', opts(10, 650, 300)));
  return zoomOk && anchorOk;
})()`);
check('実イベント: ピンチでズーム（中心固定）', pinchOk);

// --- スクリーンショット ---
const shot = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('fs');
fs.writeFileSync(process.env.SHOT_PATH || 'shot.png', Buffer.from(shot.result.data, 'base64'));

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
ws.close();
process.exit(fails ? 1 : 0);

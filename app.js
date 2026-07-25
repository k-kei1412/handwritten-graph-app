'use strict';

/* ==========================================================================
   0. Constants / small utilities
   ========================================================================== */

const API_KEY_STORAGE = 'handdrawn_graph_gemini_api_key';
const GEMINI_MODEL = 'gemini-2.5-flash';
const LINE_COLORS = ['#4c8bf5', '#f5824c', '#4cf5a0', '#f54c8b', '#c94cf5', '#f5e14c', '#4cd9f5'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fmtNum(n) {
  if (!isFinite(n)) return '∞';
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
}

function getRelPos(evt, el) {
  const rect = el.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/* ==========================================================================
   1. API key management
   ========================================================================== */

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}
function setApiKey(key) {
  localStorage.setItem(API_KEY_STORAGE, key);
}
function clearApiKey() {
  localStorage.removeItem(API_KEY_STORAGE);
}

const apiModal = document.getElementById('api-modal');
const apiKeyInput = document.getElementById('api-key-input');
const toggleKeyVisibility = document.getElementById('toggle-key-visibility');

function openApiModal() {
  apiKeyInput.value = getApiKey();
  toggleKeyVisibility.checked = false;
  apiKeyInput.type = 'password';
  apiModal.classList.remove('hidden');
}
function closeApiModal() {
  apiModal.classList.add('hidden');
}

document.getElementById('btn-api-key').addEventListener('click', openApiModal);
document.getElementById('btn-close-modal').addEventListener('click', closeApiModal);
document.getElementById('btn-save-key').addEventListener('click', () => {
  const v = apiKeyInput.value.trim();
  if (!v) {
    setStatus('APIキーが空です');
    return;
  }
  setApiKey(v);
  setStatus('APIキーを保存しました');
  closeApiModal();
});
document.getElementById('btn-clear-key').addEventListener('click', () => {
  clearApiKey();
  apiKeyInput.value = '';
  setStatus('APIキーを削除しました');
});
toggleKeyVisibility.addEventListener('change', () => {
  apiKeyInput.type = toggleKeyVisibility.checked ? 'text' : 'password';
});

function setStatus(text) {
  document.getElementById('status-text').textContent = text;
}

/* ==========================================================================
   2. Tool state (pen / eraser / rect / lasso)
   ========================================================================== */

let currentTool = 'pen';
const toolButtons = {
  pen: document.getElementById('btn-pen'),
  eraser: document.getElementById('btn-eraser'),
  rect: document.getElementById('btn-rect'),
  lasso: document.getElementById('btn-lasso'),
};

function selectTool(tool) {
  currentTool = tool;
  Object.entries(toolButtons).forEach(([name, btn]) => {
    btn.classList.toggle('selected', name === tool);
  });
  if (tool === 'pen' || tool === 'eraser') {
    cancelSelection();
  }
}
Object.entries(toolButtons).forEach(([name, btn]) => {
  btn.addEventListener('click', () => selectTool(name));
});

/* ==========================================================================
   3. Ink canvas (handwriting) — stroke based so it survives resizes
   ========================================================================== */

const leftWrap = document.querySelector('#left-pane .canvas-wrap');
const inkCanvas = document.getElementById('ink-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const inkCtx = inkCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

let inkDpr = 1;
let strokes = []; // {tool, points:[{x,y}], width, color}
let activeStroke = null;

function fitCanvasToWrap(canvas, wrap) {
  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  return dpr;
}

function redrawAllStrokes() {
  inkCtx.setTransform(inkDpr, 0, 0, inkDpr, 0, 0);
  inkCtx.clearRect(0, 0, inkCanvas.width / inkDpr, inkCanvas.height / inkDpr);
  for (const s of strokes) drawStrokePath(s);
}

function drawStrokePath(s) {
  if (s.points.length < 1) return;
  inkCtx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  inkCtx.strokeStyle = '#111';
  inkCtx.lineWidth = s.width;
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  inkCtx.beginPath();
  inkCtx.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) inkCtx.lineTo(s.points[i].x, s.points[i].y);
  if (s.points.length === 1) inkCtx.lineTo(s.points[0].x + 0.1, s.points[0].y + 0.1);
  inkCtx.stroke();
}

function drawStrokeSegment(s) {
  const n = s.points.length;
  if (n < 2) return;
  inkCtx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  inkCtx.strokeStyle = '#111';
  inkCtx.lineWidth = s.width;
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  inkCtx.beginPath();
  inkCtx.moveTo(s.points[n - 2].x, s.points[n - 2].y);
  inkCtx.lineTo(s.points[n - 1].x, s.points[n - 1].y);
  inkCtx.stroke();
}

/* ---- selection state ---- */
let selection = null; // {type:'rect'|'lasso', points:[{x,y}], rectStart, rectEnd}
let isSelecting = false;

function cancelSelection() {
  selection = null;
  isSelecting = false;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  document.getElementById('selection-actions').classList.add('hidden');
  document.getElementById('btn-recognize').disabled = true;
}

function drawOverlaySelection() {
  overlayCtx.setTransform(inkDpr, 0, 0, inkDpr, 0, 0);
  overlayCtx.clearRect(0, 0, overlayCanvas.width / inkDpr, overlayCanvas.height / inkDpr);
  if (!selection) return;
  overlayCtx.setLineDash([6, 5]);
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = '#4c8bf5';
  overlayCtx.fillStyle = 'rgba(76,139,245,0.12)';
  overlayCtx.beginPath();
  if (selection.type === 'rect' && selection.rectStart && selection.rectEnd) {
    const { rectStart: a, rectEnd: b } = selection;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    overlayCtx.rect(x, y, w, h);
  } else if (selection.type === 'lasso' && selection.points.length > 1) {
    overlayCtx.moveTo(selection.points[0].x, selection.points[0].y);
    for (let i = 1; i < selection.points.length; i++) overlayCtx.lineTo(selection.points[i].x, selection.points[i].y);
    if (!isSelecting) overlayCtx.closePath();
  }
  overlayCtx.fill();
  overlayCtx.stroke();
  overlayCtx.setLineDash([]);
}

function selectionBounds() {
  if (!selection) return null;
  let pts;
  if (selection.type === 'rect') pts = [selection.rectStart, selection.rectEnd];
  else pts = selection.points;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
  };
}

/* ---- pointer handling on left pane ---- */

leftWrap.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  leftWrap.setPointerCapture(e.pointerId);
  const pos = getRelPos(e, leftWrap);

  if (currentTool === 'pen' || currentTool === 'eraser') {
    activeStroke = {
      tool: currentTool,
      width: currentTool === 'eraser' ? 22 : 3,
      points: [pos],
    };
    strokes.push(activeStroke);
    drawStrokePath(activeStroke);
  } else {
    cancelSelection();
    isSelecting = true;
    if (currentTool === 'rect') {
      selection = { type: 'rect', rectStart: pos, rectEnd: pos, points: [] };
    } else {
      selection = { type: 'lasso', points: [pos] };
    }
    drawOverlaySelection();
  }
});

leftWrap.addEventListener('pointermove', (e) => {
  if (activeStroke) {
    const pos = getRelPos(e, leftWrap);
    activeStroke.points.push(pos);
    drawStrokeSegment(activeStroke);
  } else if (isSelecting && selection) {
    const pos = getRelPos(e, leftWrap);
    if (selection.type === 'rect') selection.rectEnd = pos;
    else selection.points.push(pos);
    drawOverlaySelection();
  }
});

function finishPointer(e) {
  if (activeStroke) {
    activeStroke = null;
  } else if (isSelecting && selection) {
    isSelecting = false;
    const b = selectionBounds();
    if (b && b.w > 12 && b.h > 12) {
      document.getElementById('selection-actions').classList.remove('hidden');
      document.getElementById('btn-recognize').disabled = false;
      setStatus(`選択完了 (${Math.round(b.w)}×${Math.round(b.h)}px)`);
    } else {
      cancelSelection();
    }
    drawOverlaySelection();
  }
}
leftWrap.addEventListener('pointerup', finishPointer);
leftWrap.addEventListener('pointercancel', finishPointer);

document.getElementById('btn-clear-ink').addEventListener('click', () => {
  strokes = [];
  redrawAllStrokes();
  cancelSelection();
});
document.getElementById('btn-cancel-select').addEventListener('click', cancelSelection);
document.getElementById('btn-confirm-select').addEventListener('click', recognizeSelection);
document.getElementById('btn-recognize').addEventListener('click', recognizeSelection);

/* ==========================================================================
   4. Extract selection as base64 PNG
   ========================================================================== */

function extractSelectionPng() {
  const b = selectionBounds();
  if (!b) return null;
  const dpr = inkDpr;
  const pxX = Math.round(b.x * dpr), pxY = Math.round(b.y * dpr);
  const pxW = Math.round(b.w * dpr), pxH = Math.round(b.h * dpr);

  const tmp = document.createElement('canvas');
  tmp.width = pxW;
  tmp.height = pxH;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = '#ffffff';
  tctx.fillRect(0, 0, pxW, pxH);

  if (selection.type === 'lasso') {
    tctx.save();
    tctx.beginPath();
    const pts = selection.points;
    tctx.moveTo((pts[0].x - b.x) * dpr, (pts[0].y - b.y) * dpr);
    for (let i = 1; i < pts.length; i++) tctx.lineTo((pts[i].x - b.x) * dpr, (pts[i].y - b.y) * dpr);
    tctx.closePath();
    tctx.clip();
  }

  tctx.drawImage(inkCanvas, pxX, pxY, pxW, pxH, 0, 0, pxW, pxH);
  if (selection.type === 'lasso') tctx.restore();

  return tmp.toDataURL('image/png').split(',')[1];
}

/* ==========================================================================
   5. Gemini API call
   ========================================================================== */

const SYSTEM_PROMPT = `あなたは手書きの一次関数の数式を解析するアシスタントです。
画像には手書きの数式が1つ含まれています。"y = ax + b" のような傾き切片形式、または "ax + by = c" のような一般形式のどちらかで書かれています。
どちらの形式であっても、必ず一般形 a*x + b*y = c の係数 a, b, c に変換し、次のJSON形式のみを出力してください。
説明文、前置き、マークダウンのコードブロック記号は一切含めないでください。JSONオブジェクトのみを返してください。

出力フォーマット:
{"type": "line", "a": 数値, "b": 数値, "c": 数値}

例1: 手書きが "y = 2x + 1" の場合 → 2x - y = -1 なので {"type": "line", "a": 2, "b": -1, "c": -1}
例2: 手書きが "3x + 2y = 6" の場合 → {"type": "line", "a": 3, "b": 2, "c": 6}`;

async function callGemini(base64Png) {
  const apiKey = getApiKey();
  if (!apiKey) {
    openApiModal();
    throw new Error('APIキーが設定されていません。');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{
      parts: [
        { text: SYSTEM_PROMPT },
        { inlineData: { mimeType: 'image/png', data: base64Png } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini APIエラー (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Geminiから有効な応答がありませんでした。');

  const cleaned = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Geminiの応答をJSONとして解析できませんでした: ' + cleaned.slice(0, 150));
  }

  const a = Number(parsed.a), b = Number(parsed.b), c = Number(parsed.c);
  if (!isFinite(a) || !isFinite(b) || !isFinite(c) || (a === 0 && b === 0)) {
    throw new Error('認識結果の係数が不正です。');
  }
  return { a, b, c };
}

async function recognizeSelection() {
  if (!selection) return;
  const png = extractSelectionPng();
  if (!png) {
    setStatus('選択範囲がありません');
    return;
  }
  document.getElementById('loading-overlay').classList.remove('hidden');
  setStatus('認識中...');
  try {
    const { a, b, c } = await callGemini(png);
    addLineFromCoeffs(a, b, c);
    setStatus(`認識成功: ${fmtNum(a)}x + ${fmtNum(b)}y = ${fmtNum(c)}`);
    cancelSelection();
  } catch (err) {
    console.error(err);
    setStatus('エラー: ' + err.message);
    alert(err.message);
  } finally {
    document.getElementById('loading-overlay').classList.add('hidden');
  }
}

/* ==========================================================================
   6. Graph: view transform, lines, rendering
   ========================================================================== */

const rightWrap = document.querySelector('#right-pane .canvas-wrap');
const graphCanvas = document.getElementById('graph-canvas');
const graphCtx = graphCanvas.getContext('2d');
const formulaPanel = document.getElementById('formula-panel');
const emptyMsg = document.getElementById('graph-empty-msg');

let graphDpr = 1;
let view = { scale: 60, panX: null, panY: null, initialized: false };
let lines = []; // {id, p1:{x,y}, p2:{x,y}, a,b,c, color}
let lineIdSeq = 1;

function initViewIfNeeded() {
  const rect = rightWrap.getBoundingClientRect();
  if (!view.initialized) {
    view.panX = rect.width / 2;
    view.panY = rect.height / 2;
    view.initialized = true;
  }
}

function screenX(wx) { return view.panX + wx * view.scale; }
function screenY(wy) { return view.panY - wy * view.scale; }
function worldX(sx) { return (sx - view.panX) / view.scale; }
function worldY(sy) { return (view.panY - sy) / view.scale; }

function niceStep(scale) {
  const target = 70;
  const raw = target / scale;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  return step * mag;
}

function clipLineToWorldRect(a, b, c, xmin, xmax, ymin, ymax) {
  const pts = [];
  const eps = 1e-9;
  const consider = (x, y) => {
    if (x >= xmin - eps && x <= xmax + eps && y >= ymin - eps && y <= ymax + eps) pts.push({ x, y });
  };
  if (Math.abs(b) > eps) {
    consider(xmin, (c - a * xmin) / b);
    consider(xmax, (c - a * xmax) / b);
  }
  if (Math.abs(a) > eps) {
    consider((c - b * ymin) / a, ymin);
    consider((c - b * ymax) / a, ymax);
  }
  // de-duplicate near-identical points (line through a corner)
  const uniq = [];
  for (const p of pts) {
    if (!uniq.some(q => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6)) uniq.push(p);
  }
  if (uniq.length < 2) return null;
  // pick the two points that are farthest apart
  let best = null, bestD = -1;
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const d = dist(uniq[i], uniq[j]);
      if (d > bestD) { bestD = d; best = [uniq[i], uniq[j]]; }
    }
  }
  return best;
}

function addLineFromCoeffs(a, b, c) {
  const rect = rightWrap.getBoundingClientRect();
  initViewIfNeeded();
  const xmin = worldX(rect.width * 0.1);
  const xmax = worldX(rect.width * 0.9);
  const ymin = worldY(rect.height * 0.9);
  const ymax = worldY(rect.height * 0.1);

  const clipped = clipLineToWorldRect(a, b, c, xmin, xmax, ymin, ymax);
  let p1, p2;
  if (clipped) {
    [p1, p2] = clipped;
  } else if (Math.abs(b) > 1e-9) {
    p1 = { x: xmin, y: (c - a * xmin) / b };
    p2 = { x: xmax, y: (c - a * xmax) / b };
  } else {
    p1 = { x: c / a, y: ymin };
    p2 = { x: c / a, y: ymax };
  }
  const color = LINE_COLORS[(lineIdSeq - 1) % LINE_COLORS.length];
  lines.push({ id: lineIdSeq++, p1, p2, a, b, c, color });
  recomputeCoeffs(lines[lines.length - 1]);
  drawGraph();
  renderFormulaPanel();
}

function recomputeCoeffs(line) {
  const a = line.p2.y - line.p1.y;
  const b = -(line.p2.x - line.p1.x);
  const c = a * line.p1.x + b * line.p1.y;
  line.a = a; line.b = b; line.c = c;
}

function lineLabel(line) {
  const { a, b, c } = line;
  let main;
  if (Math.abs(b) > 1e-9) {
    const m = -a / b, k = c / b;
    main = `y = ${fmtNum(m)}x ${k >= 0 ? '+' : '-'} ${fmtNum(Math.abs(k))}`;
  } else {
    main = `x = ${fmtNum(c / a)}`;
  }
  const sub = `${fmtNum(a)}x ${b >= 0 ? '+' : '-'} ${fmtNum(Math.abs(b))}y = ${fmtNum(c)}`;
  return { main, sub };
}

function renderFormulaPanel() {
  formulaPanel.innerHTML = '';
  emptyMsg.style.display = lines.length === 0 ? 'flex' : 'none';
  for (const line of lines) {
    const { main, sub } = lineLabel(line);
    const item = document.createElement('div');
    item.className = 'formula-item';
    item.dataset.lineId = line.id;
    item.innerHTML = `
      <span class="formula-color" style="background:${line.color}"></span>
      <span class="formula-text">
        <div class="formula-main">${main}</div>
        <div class="formula-sub">${sub}</div>
      </span>
      <button class="formula-del" title="削除">✕</button>`;
    item.querySelector('.formula-del').addEventListener('click', () => {
      lines = lines.filter(l => l.id !== line.id);
      drawGraph();
      renderFormulaPanel();
    });
    formulaPanel.appendChild(item);
  }
}

function updateFormulaItemDOM(line) {
  const item = formulaPanel.querySelector(`[data-line-id="${line.id}"]`);
  if (!item) return;
  const { main, sub } = lineLabel(line);
  item.querySelector('.formula-main').textContent = main;
  item.querySelector('.formula-sub').textContent = sub;
}

let graphRedrawScheduled = false;
function scheduleGraphRedraw() {
  // During a touch drag, pointermove can fire many times per visual frame
  // (iPad touch sampling is often faster than the 60Hz display refresh).
  // Calling drawGraph() synchronously on every event lets Safari/WebKit start
  // compositing a new canvas frame before the previous one finished, which is
  // what produces the smeared/repeated "ghost" artifacts seen while panning.
  // Coalescing to at most one drawGraph() per requestAnimationFrame fixes it.
  if (graphRedrawScheduled) return;
  graphRedrawScheduled = true;
  requestAnimationFrame(() => {
    graphRedrawScheduled = false;
    drawGraph();
  });
}

function drawGraph() {
  graphCtx.setTransform(graphDpr, 0, 0, graphDpr, 0, 0);
  const rect = rightWrap.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  graphCtx.clearRect(0, 0, W, H);
  graphCtx.fillStyle = '#16181c';
  graphCtx.fillRect(0, 0, W, H);

  const step = niceStep(view.scale);
  const wLeft = worldX(0), wRight = worldX(W);
  const wTop = worldY(0), wBottom = worldY(H);

  // grid
  graphCtx.strokeStyle = '#2a2d33';
  graphCtx.lineWidth = 1;
  graphCtx.beginPath();
  const startX = Math.floor(wLeft / step) * step;
  for (let x = startX; x <= wRight; x += step) {
    const sx = Math.round(screenX(x)) + 0.5;
    graphCtx.moveTo(sx, 0);
    graphCtx.lineTo(sx, H);
  }
  const startY = Math.floor(wBottom / step) * step;
  for (let y = startY; y <= wTop; y += step) {
    const sy = Math.round(screenY(y)) + 0.5;
    graphCtx.moveTo(0, sy);
    graphCtx.lineTo(W, sy);
  }
  graphCtx.stroke();

  // axes — screenY(0)/screenX(0) can land far outside the canvas after panning
  // (e.g. the x-axis scrolled out of view); guard against drawing/text calls at
  // such extreme coordinates since some browsers (notably Safari/WebKit) can
  // corrupt canvas rendering when asked to draw at very large coordinates
  const axisY = screenY(0), axisX = screenX(0);
  const xAxisVisible = axisY >= -1000 && axisY <= H + 1000;
  const yAxisVisible = axisX >= -1000 && axisX <= W + 1000;

  graphCtx.strokeStyle = '#6a6f78';
  graphCtx.lineWidth = 1.5;
  graphCtx.beginPath();
  if (xAxisVisible) {
    graphCtx.moveTo(0, Math.round(axisY) + 0.5);
    graphCtx.lineTo(W, Math.round(axisY) + 0.5);
  }
  if (yAxisVisible) {
    graphCtx.moveTo(Math.round(axisX) + 0.5, 0);
    graphCtx.lineTo(Math.round(axisX) + 0.5, H);
  }
  graphCtx.stroke();

  // axis labels
  graphCtx.fillStyle = '#8b909a';
  graphCtx.font = '11px -apple-system, sans-serif';
  if (xAxisVisible) {
    graphCtx.textAlign = 'center';
    graphCtx.textBaseline = 'top';
    for (let x = startX; x <= wRight; x += step) {
      if (Math.abs(x) < step * 1e-6) continue;
      graphCtx.fillText(fmtNum(x), screenX(x), axisY + 4);
    }
  }
  if (yAxisVisible) {
    graphCtx.textAlign = 'right';
    graphCtx.textBaseline = 'middle';
    for (let y = startY; y <= wTop; y += step) {
      if (Math.abs(y) < step * 1e-6) continue;
      graphCtx.fillText(fmtNum(y), axisX - 6, screenY(y));
    }
  }

  // lines — no endpoint handles: slope is fixed once a line is recognized,
  // the only interaction is grabbing the line itself to translate it.
  // margin (in world units) so the line is drawn a bit past the edges —
  // avoids a visible cut-off tip when panning, since it's an infinite line, not a segment
  const marginX = (wRight - wLeft) * 0.05;
  const marginY = (wTop - wBottom) * 0.05;
  for (const line of lines) {
    const clipped = clipLineToWorldRect(
      line.a, line.b, line.c,
      wLeft - marginX, wRight + marginX, wBottom - marginY, wTop + marginY
    );
    if (clipped) {
      graphCtx.strokeStyle = line.color;
      graphCtx.lineWidth = 3;
      graphCtx.beginPath();
      graphCtx.moveTo(screenX(clipped[0].x), screenY(clipped[0].y));
      graphCtx.lineTo(screenX(clipped[1].x), screenY(clipped[1].y));
      graphCtx.stroke();
    }
  }
}

/* ---- graph interaction: pan / pinch-zoom / drag line ---- */

const activePointers = new Map(); // pointerId -> {x,y}
let dragTarget = null; // {line, startWorld, origP1, origP2}
let panState = null; // {startScreen, startPanX, startPanY}
let pinchState = null; // {prevDist, prevMid}

// Hit-tests the line itself (there are no endpoint handles). Distance is computed
// in world space and converted to screen pixels via view.scale — screenX/screenY
// are a uniform scale (plus a y-flip), which preserves distances up to that
// single scale factor, so this stays accurate at any zoom level.
function hitTestLineBody(pos) {
  const HIT_PX = 18;
  const wx = worldX(pos.x), wy = worldY(pos.y);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const { a, b, c } = line;
    const norm = Math.hypot(a, b);
    if (norm < 1e-9) continue;
    const worldDist = Math.abs(a * wx + b * wy - c) / norm;
    if (worldDist * view.scale <= HIT_PX) return { line };
  }
  return null;
}

rightWrap.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  rightWrap.setPointerCapture(e.pointerId);
  const pos = getRelPos(e, rightWrap);
  activePointers.set(e.pointerId, pos);

  if (activePointers.size === 1) {
    const bodyHit = hitTestLineBody(pos);
    if (bodyHit) {
      dragTarget = {
        line: bodyHit.line,
        startWorld: { x: worldX(pos.x), y: worldY(pos.y) },
        origP1: { ...bodyHit.line.p1 },
        origP2: { ...bodyHit.line.p2 },
      };
    } else {
      panState = { startScreen: pos, startPanX: view.panX, startPanY: view.panY };
    }
  } else if (activePointers.size === 2 && !dragTarget) {
    const pts = Array.from(activePointers.values());
    pinchState = { prevDist: dist(pts[0], pts[1]), prevMid: mid(pts[0], pts[1]) };
    panState = null;
  }
});

rightWrap.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  const pos = getRelPos(e, rightWrap);
  activePointers.set(e.pointerId, pos);

  if (dragTarget) {
    // Translate both endpoints by the same snapped delta, so the direction
    // p2-p1 (and therefore the slope) never changes — only c does.
    const step = niceStep(view.scale);
    const curWorld = { x: worldX(pos.x), y: worldY(pos.y) };
    const dx = Math.round((curWorld.x - dragTarget.startWorld.x) / step) * step;
    const dy = Math.round((curWorld.y - dragTarget.startWorld.y) / step) * step;
    dragTarget.line.p1 = { x: dragTarget.origP1.x + dx, y: dragTarget.origP1.y + dy };
    dragTarget.line.p2 = { x: dragTarget.origP2.x + dx, y: dragTarget.origP2.y + dy };
    recomputeCoeffs(dragTarget.line);
    scheduleGraphRedraw();
    updateFormulaItemDOM(dragTarget.line);
  } else if (activePointers.size === 2 && pinchState) {
    const pts = Array.from(activePointers.values());
    const newDist = dist(pts[0], pts[1]);
    const newMid = mid(pts[0], pts[1]);
    const wx = worldX(pinchState.prevMid.x), wy = worldY(pinchState.prevMid.y);
    const scaleFactor = newDist / Math.max(1, pinchState.prevDist);
    view.scale = clamp(view.scale * scaleFactor, 8, 500);
    view.panX = pinchState.prevMid.x - wx * view.scale;
    view.panY = pinchState.prevMid.y + wy * view.scale;
    view.panX += (newMid.x - pinchState.prevMid.x);
    view.panY += (newMid.y - pinchState.prevMid.y);
    pinchState.prevDist = newDist;
    pinchState.prevMid = newMid;
    scheduleGraphRedraw();
  } else if (panState) {
    view.panX = panState.startPanX + (pos.x - panState.startScreen.x);
    view.panY = panState.startPanY + (pos.y - panState.startScreen.y);
    scheduleGraphRedraw();
  }
});

function releasePointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size === 0) {
    dragTarget = null;
    panState = null;
    pinchState = null;
  } else if (activePointers.size === 1) {
    pinchState = null;
    const remaining = Array.from(activePointers.values())[0];
    panState = { startScreen: remaining, startPanX: view.panX, startPanY: view.panY };
  }
}
rightWrap.addEventListener('pointerup', releasePointer);
rightWrap.addEventListener('pointercancel', releasePointer);

/* wheel zoom (trackpad / mouse, useful when testing on desktop Safari/Chrome) */
rightWrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = rightWrap.getBoundingClientRect();
  const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const wx = worldX(pos.x), wy = worldY(pos.y);
  const factor = Math.pow(1.0015, -e.deltaY);
  view.scale = clamp(view.scale * factor, 8, 500);
  view.panX = pos.x - wx * view.scale;
  view.panY = pos.y + wy * view.scale;
  scheduleGraphRedraw();
}, { passive: false });

document.getElementById('btn-reset-view').addEventListener('click', () => {
  const rect = rightWrap.getBoundingClientRect();
  view.scale = 60;
  view.panX = rect.width / 2;
  view.panY = rect.height / 2;
  drawGraph();
});
document.getElementById('btn-clear-graph').addEventListener('click', () => {
  lines = [];
  drawGraph();
  renderFormulaPanel();
});

/* ==========================================================================
   7. Layout / resize
   ========================================================================== */

function layoutAll() {
  inkDpr = fitCanvasToWrap(inkCanvas, leftWrap);
  fitCanvasToWrap(overlayCanvas, leftWrap);
  redrawAllStrokes();
  cancelSelection();

  graphDpr = fitCanvasToWrap(graphCanvas, rightWrap);
  initViewIfNeeded();
  drawGraph();
}

window.addEventListener('resize', layoutAll);
window.addEventListener('orientationchange', () => setTimeout(layoutAll, 200));

// 'resize' only fires for actual browser-window size changes; it does NOT fire
// when a sibling element (e.g. formula-panel growing/shrinking as lines are
// added/removed) changes canvas-wrap's size via flex layout. That mismatch left
// each canvas's backing store at its old (larger) size, so its stale bottom
// strip never got cleared/redrawn and visibly overlapped the panel below it —
// most noticeable while panning, since every pan frame only redraws within the
// new-but-never-applied smaller size. Observing the wraps directly catches
// any real box-size change, regardless of what caused it.
const canvasWrapResizeObserver = new ResizeObserver(() => layoutAll());
canvasWrapResizeObserver.observe(leftWrap);
canvasWrapResizeObserver.observe(rightWrap);

selectTool('pen');
layoutAll();
renderFormulaPanel();
if (!getApiKey()) setStatus('APIキー未設定');

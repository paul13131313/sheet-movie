// content.js — 描画エンジン + ページ内コントロールパネル
// active-cell-border + cell-borderのDOM要素からセルサイズ・位置を自動検出
(function () {
  'use strict';

  console.log('[SheetsOverlay] content.js 読み込み開始');

  // --- 状態 ---
  let video = null;
  let srcCanvas = null;
  let srcCtx = null;
  let dstCanvas = null;
  let dstCtx = null;
  let playing = false;
  let ready = false;
  let rafId = null;

  // グリッド情報（自動検出）
  let gridX = 0;    // グリッド開始X（行ヘッダー右端）
  let gridY = 0;    // グリッド開始Y（列ヘッダー下端）
  let cellW = 100;  // セル幅（ボーダー間の間隔）
  let cellH = 20;   // セル高（ボーダー間の間隔）
  let pitchX = 101; // セル繰り返し間隔X（セル幅+ボーダー幅、ズーム依存）
  let pitchY = 21;  // セル繰り返し間隔Y（セル高+ボーダー幅、ズーム依存）

  let opts = {
    opacity: 1.0,
    grid: true
  };

  // --- セルサイズ・位置の自動検出 ---
  function detectCellGeometry() {
    // active-cell-borderの4辺からセルサイズを取得
    const activeBorders = document.querySelectorAll('.active-cell-border');
    const aHoriz = [];
    const aVert = [];
    for (const b of activeBorders) {
      const r = b.getBoundingClientRect();
      if (r.width > r.height) aHoriz.push(r);
      else aVert.push(r);
    }

    if (aHoriz.length >= 2 && aVert.length >= 2) {
      const topY = Math.min(...aHoriz.map(r => r.top));
      const bottomY = Math.max(...aHoriz.map(r => r.top));
      const leftX = Math.min(...aVert.map(r => r.left));
      const rightX = Math.max(...aVert.map(r => r.left));

      cellW = Math.round(rightX - leftX);
      cellH = Math.round(bottomY - topY);

      // pitch = セル幅 + グリッドボーダー幅
      // ボーダー幅はズームに比例: 100%で1px、50%で0.5px
      // ズーム率 = cellH / 20（デフォルト行高20px）
      const zoomFactor = cellH / 20;
      const borderWidth = zoomFactor;
      pitchX = cellW + borderWidth;
      pitchY = cellH + borderWidth;

      // グリッド開始位置 = ヘッダー端から計算
      const rowBg = document.querySelector('.row-headers-background');
      const colBg = document.querySelector('.column-headers-background');
      const headerRight = rowBg ? rowBg.getBoundingClientRect().right : 0;
      const headerBottom = colBg ? colBg.getBoundingClientRect().bottom : 0;

      // アクティブセルからヘッダーまでの距離をpitchで割って開始位置を逆算
      if (pitchX > 0) {
        const distX = leftX - headerRight;
        const cellsFromLeft = Math.round(distX / pitchX);
        gridX = leftX - cellsFromLeft * pitchX;
      }
      if (pitchY > 0) {
        const distY = topY - headerBottom;
        const cellsFromTop = Math.round(distY / pitchY);
        gridY = topY - cellsFromTop * pitchY;
      }
    } else {
      // フォールバック: ヘッダー位置のみ
      const rowBg = document.querySelector('.row-headers-background');
      const colBg = document.querySelector('.column-headers-background');
      if (rowBg) gridX = rowBg.getBoundingClientRect().right;
      if (colBg) gridY = colBg.getBoundingClientRect().bottom;
    }

    console.log('[SheetsOverlay] セル検出: ' + cellW + 'x' + cellH +
      'px, pitch:' + pitchX.toFixed(1) + 'x' + pitchY.toFixed(1) +
      ', origin:(' + gridX.toFixed(1) + ',' + gridY.toFixed(1) + ')');
  }

  // --- Canvas生成・配置 ---
  function createCanvases() {
    srcCanvas = document.createElement('canvas');
    srcCtx = srcCanvas.getContext('2d');
    dstCanvas = document.createElement('canvas');
    dstCanvas.id = 'sheets-video-overlay';
    dstCanvas.style.cssText =
      'position:fixed;pointer-events:none;z-index:1002;top:0;left:0;';
    dstCtx = dstCanvas.getContext('2d');
    document.body.appendChild(dstCanvas);
  }

  // --- DOM追従: オーバーレイをセル領域のみに配置 ---
  function syncRect() {
    if (!dstCanvas) return;
    detectCellGeometry();

    // 右端: 縦スクロールバーに少し食い込む（隙間防止、スクロールバーが上に表示）
    let rightLimit = window.innerWidth;
    const vScroll = document.querySelector('.native-scrollbar-y');
    if (vScroll) {
      rightLimit = Math.round(vScroll.getBoundingClientRect().left) + 2;
    }
    const w = rightLimit - gridX;

    // 下端: 横スクロールバーに少し食い込む（隙間防止）+ タブバーの上端
    let bottomLimit = window.innerHeight;
    const hScroll = document.querySelector('.native-scrollbar-x');
    if (hScroll) {
      bottomLimit = Math.min(bottomLimit, Math.round(hScroll.getBoundingClientRect().top) + 2);
    }
    const tabBar = document.querySelector('.docs-sheet-container-bar');
    if (tabBar) {
      bottomLimit = Math.min(bottomLimit, Math.round(tabBar.getBoundingClientRect().top));
    }
    const h = bottomLimit - gridY;
    if (w <= 0 || h <= 0) return;

    dstCanvas.style.top = gridY + 'px';
    dstCanvas.style.left = gridX + 'px';
    dstCanvas.style.width = w + 'px';
    dstCanvas.style.height = h + 'px';
    dstCanvas.width = Math.round(w);
    dstCanvas.height = Math.round(h);
  }

  let syncPending = false;
  function requestSync() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(() => { syncRect(); syncPending = false; });
  }

  let listenersAttached = false;
  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    window.addEventListener('resize', requestSync);
    document.addEventListener('scroll', requestSync, { capture: true });
  }

  // --- ピクセル化（セル単位） ---
  function pixelate() {
    if (!video || !srcCanvas || !dstCanvas) return;
    if (video.readyState < 2) return;

    const cw = dstCanvas.width;
    const ch = dstCanvas.height;
    if (cw === 0 || ch === 0 || cellW <= 0 || cellH <= 0) return;

    // 動画をsrcCanvasに描画
    srcCanvas.width = cw;
    srcCanvas.height = ch;
    srcCtx.drawImage(video, 0, 0, cw, ch);
    const srcData = srcCtx.getImageData(0, 0, cw, ch);

    dstCtx.clearRect(0, 0, cw, ch);
    dstCtx.globalAlpha = opts.opacity;

    // セルごとに色をサンプリングして塗りつぶす（pitchで位置、cellW/Hで塗りサイズ）
    for (let y = 0; y < ch; y += pitchY) {
      for (let x = 0; x < cw; x += pitchX) {
        const w = Math.min(cellW, cw - x);
        const h = Math.min(cellH, ch - y);

        const sx = Math.min(Math.floor(x + w / 2), cw - 1);
        const sy = Math.min(Math.floor(y + h / 2), ch - 1);
        const idx = (sy * cw + sx) * 4;
        const r = srcData.data[idx];
        const g = srcData.data[idx + 1];
        const b = srcData.data[idx + 2];

        dstCtx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        dstCtx.fillRect(x, y, w, h);
      }
    }

    dstCtx.globalAlpha = 1.0;
  }

  // --- グリッド線 ---
  function drawGrid() {
    if (!dstCanvas) return;
    const cw = dstCanvas.width;
    const ch = dstCanvas.height;

    dstCtx.strokeStyle = 'rgba(180, 180, 180, 0.15)';
    dstCtx.lineWidth = 1;
    dstCtx.globalAlpha = 1.0;

    for (let x = 0; x <= cw; x += pitchX) {
      dstCtx.beginPath();
      dstCtx.moveTo(x + 0.5, 0);
      dstCtx.lineTo(x + 0.5, ch);
      dstCtx.stroke();
    }
    for (let y = 0; y <= ch; y += pitchY) {
      dstCtx.beginPath();
      dstCtx.moveTo(0, y + 0.5);
      dstCtx.lineTo(cw, y + 0.5);
      dstCtx.stroke();
    }
  }

  // --- 描画ループ ---
  function render() {
    if (!playing) return;
    syncRect();
    pixelate();
    if (opts.grid) drawGrid();
    rafId = requestAnimationFrame(render);
  }

  // --- 動画読み込み ---
  function loadVideoFromBlob(blob) {
    console.log('[SheetsOverlay] loadVideoFromBlob, size:', blob.size);

    if (!dstCanvas) createCanvases();
    detectCellGeometry();
    syncRect();
    attachListeners();

    if (video) {
      video.pause();
      if (video.src) URL.revokeObjectURL(video.src);
    }

    const blobUrl = URL.createObjectURL(blob);
    video = document.createElement('video');
    video.loop = true;
    video.muted = false;
    video.playsInline = true;
    video.src = blobUrl;

    video.addEventListener('loadeddata', () => {
      ready = true;
      console.log('[SheetsOverlay] 動画読み込み完了',
        video.videoWidth + 'x' + video.videoHeight);
      detectCellGeometry();
      syncRect();
      updatePanelStatus('OK ' + video.videoWidth + 'x' + video.videoHeight);
    });
    video.addEventListener('error', () => {
      console.error('[SheetsOverlay] 動画エラー', video.error);
      updatePanelStatus('エラー: ' + (video.error ? video.error.message : '不明'));
    });
  }

  function doPlay() {
    if (!video || !ready) return;
    detectCellGeometry();
    syncRect();
    video.play().then(() => {
      playing = true;
      render();
    }).catch(err => console.error('[SheetsOverlay] 再生エラー', err));
  }

  function doPause() {
    if (!video) return;
    video.pause();
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
  }

  function doStop() {
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (dstCtx && dstCanvas) dstCtx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
  }

  function setOptions(newOpts) {
    if (newOpts.opacity !== undefined) opts.opacity = newOpts.opacity;
    if (newOpts.grid !== undefined) opts.grid = newOpts.grid;
    if (!playing && video && ready) {
      syncRect(); pixelate();
      if (opts.grid) drawGrid();
    }
  }

  // ===========================================================
  //  コントロールパネル
  // ===========================================================
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'svo-panel';
    panel.innerHTML = `
      <style>
        #svo-panel {
          position: fixed; top: 10px; right: 10px; z-index: 99999;
          background: #1e1e1e; color: #e0e0e0;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 13px; border-radius: 8px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
          padding: 14px; width: 260px; cursor: move; user-select: none;
        }
        #svo-panel h2 { margin: 0 0 10px 0; font-size: 13px; color: #0F9D58; text-align: center; }
        #svo-panel .svo-row { margin-bottom: 8px; }
        #svo-panel label { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 3px; }
        #svo-panel input[type="range"] { width: 100%; accent-color: #0F9D58; }
        #svo-panel button {
          padding: 5px 0; background: #333; color: #e0e0e0;
          border: 1px solid #555; border-radius: 4px; cursor: pointer;
          font-size: 12px; transition: background 0.15s;
        }
        #svo-panel button:hover { background: #0F9D58; border-color: #0F9D58; color: #fff; }
        #svo-panel button:disabled { opacity: 0.4; cursor: not-allowed; }
        #svo-panel .svo-btns { display: flex; gap: 4px; }
        #svo-panel .svo-btns button { flex: 1; }
        #svo-panel .svo-file-label {
          display: block; padding: 6px; background: #333; border: 1px dashed #555;
          border-radius: 4px; text-align: center; cursor: pointer; font-size: 12px;
        }
        #svo-panel .svo-file-label:hover { background: #444; border-color: #0F9D58; }
        #svo-panel .svo-status { font-size: 10px; color: #888; text-align: center; margin-top: 2px; }
        #svo-panel .svo-toggle {
          position: absolute; top: 4px; right: 8px;
          cursor: pointer; font-size: 16px; color: #888;
        }
      </style>
      <span class="svo-toggle" id="svo-toggle">\u2212</span>
      <h2>Sheets Video Overlay</h2>
      <div id="svo-body">
        <div class="svo-row">
          <label class="svo-file-label" id="svo-file-label">\uD83C\uDFAC \u52D5\u753B\u3092\u9078\u629E</label>
          <input type="file" id="svo-file" accept="video/mp4,video/*" style="display:none">
          <div class="svo-status" id="svo-status"></div>
        </div>
        <div class="svo-row svo-btns">
          <button id="svo-play" disabled>\u25B6</button>
          <button id="svo-pause" disabled>\u23F8</button>
          <button id="svo-stop" disabled>\u23F9</button>
          <button id="svo-mute" disabled>\uD83D\uDD0A</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // ドラッグ移動
    let dragging = false, dx = 0, dy = 0;
    panel.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'LABEL') return;
      dragging = true;
      dx = e.clientX - panel.offsetLeft;
      dy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.right = 'auto';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // 折りたたみ
    document.getElementById('svo-toggle').addEventListener('click', () => {
      const body = document.getElementById('svo-body');
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      document.getElementById('svo-toggle').textContent = hidden ? '\u2212' : '+';
    });

    // ファイル選択
    document.getElementById('svo-file-label').addEventListener('click', () => {
      document.getElementById('svo-file').click();
    });
    document.getElementById('svo-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      updatePanelStatus(file.name);
      loadVideoFromBlob(file);
      document.getElementById('svo-play').disabled = false;
      document.getElementById('svo-pause').disabled = false;
      document.getElementById('svo-stop').disabled = false;
      document.getElementById('svo-mute').disabled = false;
    });

    // ボタン
    document.getElementById('svo-play').addEventListener('click', doPlay);
    document.getElementById('svo-pause').addEventListener('click', doPause);
    document.getElementById('svo-stop').addEventListener('click', doStop);
    document.getElementById('svo-mute').addEventListener('click', () => {
      if (!video) return;
      video.muted = !video.muted;
      document.getElementById('svo-mute').textContent = video.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    });

    panel.style.pointerEvents = 'auto';
  }

  function updatePanelStatus(text) {
    const el = document.getElementById('svo-status');
    if (el) el.textContent = text;
  }

  // --- popup互換 ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'PLAY': doPlay(); break;
      case 'PAUSE': doPause(); break;
      case 'STOP': doStop(); break;
      case 'SET_OPTS': setOptions(msg.payload || {}); break;
    }
    sendResponse({ ok: true });
    return false;
  });

  // --- 初期化 ---
  createPanel();
  detectCellGeometry();
  console.log('[SheetsOverlay] 初期化完了 cell=' + cellW + 'x' + cellH +
    ' origin=(' + gridX + ',' + gridY + ')');
})();

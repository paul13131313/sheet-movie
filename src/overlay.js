// overlay.js — コア描画エンジン（ページコンテキストで動作）
(function () {
  'use strict';

  // --- 状態 ---
  let video = null;
  let srcCanvas = null;
  let srcCtx = null;
  let dstCanvas = null;
  let dstCtx = null;
  let gridEl = null;
  let playing = false;
  let ready = false;
  let rafId = null;

  let opts = {
    opacity: 0.7,
    mosaic: 8,
    grid: true
  };

  // --- 4-1. セル領域の検出 ---
  function findGridEl() {
    // 優先度1: div[role="grid"] のうち最大面積
    let candidates = Array.from(document.querySelectorAll('div[role="grid"]'));
    let best = pickLargest(candidates);
    if (best) {
      console.log('[SheetsOverlay] grid検出: div[role="grid"]', best);
      return best;
    }

    // 優先度2: div.waffle のうち最大面積
    candidates = Array.from(document.querySelectorAll('div.waffle'));
    best = pickLargest(candidates);
    if (best) {
      console.log('[SheetsOverlay] grid検出: div.waffle', best);
      return best;
    }

    // 優先度3: body（最終手段）
    console.warn('[SheetsOverlay] grid未検出、document.bodyを使用');
    return document.body;
  }

  function pickLargest(els) {
    let largest = null;
    let maxArea = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > maxArea) {
        maxArea = area;
        largest = el;
      }
    }
    return largest;
  }

  // gridElの再探索タイマー
  let gridRetryTimer = null;
  function ensureGridEl() {
    if (gridEl && gridEl.isConnected) return;
    gridEl = findGridEl();
    if (!gridEl || !gridEl.isConnected) {
      if (!gridRetryTimer) {
        gridRetryTimer = setInterval(() => {
          gridEl = findGridEl();
          if (gridEl && gridEl.isConnected) {
            clearInterval(gridRetryTimer);
            gridRetryTimer = null;
            syncRect();
          }
        }, 3000);
      }
    }
  }

  // --- 4-2. Canvas生成・配置 ---
  function createCanvases() {
    // srcCanvas: 動画フレーム描画用（非表示）
    srcCanvas = document.createElement('canvas');
    srcCtx = srcCanvas.getContext('2d');

    // dstCanvas: オーバーレイ本体
    dstCanvas = document.createElement('canvas');
    dstCanvas.id = 'sheets-video-overlay';
    dstCanvas.style.cssText = [
      'position: fixed',
      'pointer-events: none',
      'z-index: 9999',
      'top: 0',
      'left: 0'
    ].join(';');
    dstCtx = dstCanvas.getContext('2d');

    document.body.appendChild(dstCanvas);
    console.log('[SheetsOverlay] Canvas生成完了');
  }

  // --- 4-3. DOM追従 ---
  function syncRect() {
    ensureGridEl();
    if (!gridEl || !dstCanvas) return;

    const r = gridEl.getBoundingClientRect();
    dstCanvas.style.top = r.top + 'px';
    dstCanvas.style.left = r.left + 'px';
    dstCanvas.style.width = r.width + 'px';
    dstCanvas.style.height = r.height + 'px';
    dstCanvas.width = Math.round(r.width);
    dstCanvas.height = Math.round(r.height);
  }

  let syncPending = false;
  function requestSync() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(() => {
      syncRect();
      syncPending = false;
    });
  }

  function attachListeners() {
    window.addEventListener('resize', requestSync);
    document.addEventListener('scroll', requestSync, { capture: true });

    if (gridEl && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(requestSync);
      ro.observe(gridEl);
    }
  }

  // --- 4-4. ピクセル化アルゴリズム ---
  function pixelate() {
    if (!video || !srcCanvas || !dstCanvas) return;
    if (video.readyState < 2) return;

    const mosaicSize = opts.mosaic || 8;
    const sw = Math.ceil(dstCanvas.width / mosaicSize);
    const sh = Math.ceil(dstCanvas.height / mosaicSize);

    srcCanvas.width = sw;
    srcCanvas.height = sh;
    srcCtx.drawImage(video, 0, 0, sw, sh);

    dstCtx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
    dstCtx.imageSmoothingEnabled = false;
    dstCtx.globalAlpha = opts.opacity;
    dstCtx.drawImage(srcCanvas, 0, 0, sw, sh, 0, 0, dstCanvas.width, dstCanvas.height);
    dstCtx.globalAlpha = 1.0;
  }

  // --- 4-5. グリッド線描画 ---
  function drawGrid() {
    if (!dstCanvas) return;
    const mosaicSize = opts.mosaic || 8;
    dstCtx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
    dstCtx.lineWidth = 1;
    dstCtx.globalAlpha = 1.0;

    for (let x = 0; x < dstCanvas.width; x += mosaicSize) {
      dstCtx.beginPath();
      dstCtx.moveTo(x + 0.5, 0);
      dstCtx.lineTo(x + 0.5, dstCanvas.height);
      dstCtx.stroke();
    }
    for (let y = 0; y < dstCanvas.height; y += mosaicSize) {
      dstCtx.beginPath();
      dstCtx.moveTo(0, y + 0.5);
      dstCtx.lineTo(dstCanvas.width, y + 0.5);
      dstCtx.stroke();
    }
  }

  // --- 4-6. 描画ループ ---
  function render() {
    if (!playing) return;
    syncRect();
    pixelate();
    if (opts.grid) drawGrid();
    rafId = requestAnimationFrame(render);
  }

  // --- 4-7. 公開API ---
  function loadVideo(dataUrl) {
    if (!dstCanvas) {
      createCanvases();
    }
    ensureGridEl();
    syncRect();
    attachListeners();

    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }

    video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.src = dataUrl;

    video.addEventListener('loadeddata', () => {
      ready = true;
      console.log('[SheetsOverlay] 動画読み込み完了',
        video.videoWidth + 'x' + video.videoHeight);
      notifyStatus();
    });

    video.addEventListener('error', (e) => {
      console.error('[SheetsOverlay] 動画エラー', e);
      notifyStatus();
    });
  }

  function play() {
    if (!video || !ready) return;
    video.play();
    playing = true;
    render();
    notifyStatus();
  }

  function pause() {
    if (!video) return;
    video.pause();
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    notifyStatus();
  }

  function stop() {
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (dstCtx && dstCanvas) {
      dstCtx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
    }
    notifyStatus();
  }

  function setOptions(newOpts) {
    if (newOpts.opacity !== undefined) opts.opacity = newOpts.opacity;
    if (newOpts.mosaic !== undefined) opts.mosaic = newOpts.mosaic;
    if (newOpts.grid !== undefined) opts.grid = newOpts.grid;
    // 停止中でもプレビュー更新
    if (!playing && video && ready) {
      syncRect();
      pixelate();
      if (opts.grid) drawGrid();
    }
  }

  function captureFrame() {
    if (!dstCanvas) return;
    const dataUrl = dstCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'sheets-overlay-capture.png';
    a.click();
    console.log('[SheetsOverlay] フレームキャプチャ完了');
  }

  function getStatus() {
    return {
      ready: ready,
      playing: playing,
      error: video ? (video.error ? video.error.message : null) : null
    };
  }

  function notifyStatus() {
    window.dispatchEvent(new CustomEvent('sheets-overlay-status', {
      detail: getStatus()
    }));
  }

  // --- content.jsからのメッセージ受信 ---
  window.addEventListener('sheets-overlay-command', (e) => {
    const { type, payload } = e.detail;
    switch (type) {
      case 'LOAD_VIDEO':
        loadVideo(payload.dataUrl);
        break;
      case 'PLAY':
        play();
        break;
      case 'PAUSE':
        pause();
        break;
      case 'STOP':
        stop();
        break;
      case 'SET_OPTS':
        setOptions(payload);
        break;
      case 'CAPTURE_FRAME':
        captureFrame();
        break;
      default:
        console.warn('[SheetsOverlay] 不明なコマンド:', type);
    }
  });

  // グローバルAPI（デバッグ用）
  window.__sheetsOverlay = {
    loadVideo, play, pause, stop, setOptions, captureFrame, getStatus
  };

  console.log('[SheetsOverlay] overlay.js 初期化完了');
})();

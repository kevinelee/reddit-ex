(function () {
  'use strict';

  const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
  const STORAGE_KEY = 'rr_history';
  const PIN_KEY = 'rr_pinned';
  const WIDTH_KEY = 'rr_width';
  const DEFAULT_WIDTH = 520;
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 1000;
  const POSITION_KEY = 'rr_position';
  const HEIGHT_KEY = 'rr_height';
  const REDIRECT_KEY = 'rr_redirect';
  const SCORE_SORT_KEY = 'rr_scoreSort';
  const FLAIR_BLOCKLIST_KEY = 'rr_flairBlocklist';
  const DEFAULT_HEIGHT = 380;
  const MIN_HEIGHT = 160;
  const MAX_HEIGHT = 700;
  const VIDEO_KEYS = new Set([
    ' ', 'k', 'K', 'f', 'F', 'm', 'M',
    'j', 'J', 'l', 'L',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    ',', '.',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  ]);
  // Arrow keys double as post-list navigation, so inside the panel they should
  // only go to video seek/volume when a video is actually being hovered —
  // never auto-activated — otherwise they navigate the listing instead.
  const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

  // Elements within a .thing that should not trigger the panel
  const PASSTHROUGH_SEL = [
    '.arrow',
    '.expando-button',
    '.expando',          // expanded media area — let user watch videos in-place
    '.hide-button',
    '.share',
    '.save-button',
    '.report-button',
    '.crosspost-button',
    '.post-sharing-button',
    '.author',
    '.subreddit',
    '.domain a',
    'time',
    '.rr-hide-btn',
  ].join(', ');

  let redirectEnabled = true;
  let scoreSortEnabled = false;
  let naturalOrderCounter = 0;
  let panel = null;
  let tab = null;
  let tabPopup = null;
  let tabPopupTimeout = null;
  let currentPostId = null;
  let selectedThingEl = null;
  let hoveredThingEl = null;
  let history = [];
  let panelWidth = DEFAULT_WIDTH;
  let panelPosition = 'right'; // 'right' | 'bottom'
  let panelHeight = DEFAULT_HEIGHT;
  let loadGen = 0;
  let activeVideoEl = null;
  let activeVideoIframe = null;
  let videoIsHovered = false; // true only while the mouse is actually over a video/its iframe
  let lastFetchTime = 0;
  const FETCH_MIN_GAP = 800;
  let contextMenuEl = null;
  let contextMenuThingEl = null;
  let contextMenuFlairInfo = null;
  let flairBlocklist = []; // [{ sub: 'leagueoflegends', flair: 'esports', subLabel: 'r/leagueoflegends', flairLabel: 'Esports' }]

  // ── Storage ───────────────────────────────────────────────────────────────

  function loadHistory() {
    return new Promise(resolve => {
      chrome.storage.local.get(STORAGE_KEY, data => {
        const raw = data[STORAGE_KEY] || [];
        const cutoff = Date.now() - TWO_WEEKS;
        history = raw.filter(p => p.timestamp > cutoff);
        resolve();
      });
    });
  }

  function saveHistory() {
    chrome.storage.local.set({ [STORAGE_KEY]: history });
  }

  function upsertHistory(entry) {
    const idx = history.findIndex(p => p.id === entry.id);
    if (idx !== -1) {
      history[idx] = { ...history[idx], ...entry, timestamp: Date.now() };
    } else {
      history.unshift(entry);
    }
    history.sort((a, b) => b.timestamp - a.timestamp);
    saveHistory();
  }

  function markRead(id) {
    const entry = history.find(p => p.id === id);
    if (entry && !entry.read) {
      entry.read = true;
      saveHistory();
      updateReadCount();
    }
  }

  function removeFromHistory(id) {
    history = history.filter(p => p.id !== id);
    saveHistory();
    updateReadCount();
    const histView = panel.querySelector('#rr-history-view');
    renderHistoryList(histView);
  }

  function loadWidth() {
    return new Promise(resolve => {
      chrome.storage.local.get(WIDTH_KEY, data => {
        const stored = data[WIDTH_KEY] || DEFAULT_WIDTH;
        panelWidth = Math.max(MIN_WIDTH, Math.min(stored, window.innerWidth - 80));
        resolve();
      });
    });
  }

  function loadPosition() {
    return new Promise(resolve => {
      chrome.storage.local.get(POSITION_KEY, data => {
        panelPosition = data[POSITION_KEY] || 'right';
        resolve();
      });
    });
  }

  function loadPanelHeight() {
    return new Promise(resolve => {
      chrome.storage.local.get(HEIGHT_KEY, data => {
        const stored = data[HEIGHT_KEY] || DEFAULT_HEIGHT;
        panelHeight = Math.max(MIN_HEIGHT, Math.min(stored, window.innerHeight - 80));
        resolve();
      });
    });
  }

  function loadRedirect() {
    return new Promise(resolve => {
      chrome.storage.local.get(REDIRECT_KEY, data => {
        redirectEnabled = data[REDIRECT_KEY] !== false; // default: true
        resolve();
      });
    });
  }

  function loadScoreSort() {
    return new Promise(resolve => {
      chrome.storage.local.get(SCORE_SORT_KEY, data => {
        scoreSortEnabled = data[SCORE_SORT_KEY] === true; // default: off
        resolve();
      });
    });
  }

  function loadFlairBlocklist() {
    return new Promise(resolve => {
      chrome.storage.local.get(FLAIR_BLOCKLIST_KEY, data => {
        flairBlocklist = data[FLAIR_BLOCKLIST_KEY] || [];
        resolve();
      });
    });
  }

  function saveFlairBlocklist() {
    chrome.storage.local.set({ [FLAIR_BLOCKLIST_KEY]: flairBlocklist });
  }

  function applyHeight() {
    if (!panel) return;
    panelHeight = Math.max(MIN_HEIGHT, Math.min(panelHeight, window.innerHeight - 80));
    panel.style.height = panelHeight + 'px';
    if (panel.classList.contains('rr-open')) {
      document.body.style.marginBottom = panelHeight + 'px';
    }
  }

  function applyPanelPosition(pos) {
    panelPosition = pos;
    chrome.storage.local.set({ [POSITION_KEY]: pos });

    if (panel) {
      if (pos === 'bottom') {
        panel.classList.add('rr-bottom');
        panel.style.width = '';
        applyHeight();
      } else {
        panel.classList.remove('rr-bottom');
        panel.style.height = '';
        applyWidth();
      }
      if (panel.classList.contains('rr-open')) {
        if (pos === 'bottom') {
          document.body.style.marginRight = '';
          document.body.style.marginBottom = panelHeight + 'px';
        } else {
          document.body.style.marginBottom = '';
          document.body.style.marginRight = panelWidth + 'px';
        }
      }
      panel.querySelectorAll('.rr-seg-btn[data-pos]').forEach(btn => {
        btn.classList.toggle('rr-seg-active', btn.dataset.pos === pos);
      });
    }

    if (tab) {
      tab.classList.toggle('rr-bottom', pos === 'bottom');
    }
  }

  function applyWidth() {
    if (!panel || panelPosition === 'bottom') return;
    panelWidth = Math.max(MIN_WIDTH, Math.min(panelWidth, window.innerWidth - 80));
    panel.style.width = panelWidth + 'px';
    if (panel.classList.contains('rr-open')) {
      document.body.style.marginRight = panelWidth + 'px';
    }
  }

  // ── Panel / Tab build ─────────────────────────────────────────────────────

  function buildPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'rr-panel';
    panel.innerHTML = `
      <div id="rr-resize"></div>
      <div id="rr-header">
        <button id="rr-back" class="rr-btn rr-hidden">← Back</button>
        <span id="rr-read-count"></span>
        <div id="rr-header-actions">
          <button id="rr-settings-toggle" class="rr-btn" title="Settings">⚙</button>
          <button id="rr-newtab" class="rr-btn rr-hidden">↗ New Tab</button>
          <button id="rr-hide" class="rr-btn rr-hidden">Hide</button>
          <button id="rr-close" class="rr-btn">✕</button>
        </div>
      </div>
      <div id="rr-settings" class="rr-hidden">
        <div id="rr-settings-inner">
          <div class="rr-setting-row">
            <span class="rr-setting-label">Panel Position</span>
            <div class="rr-seg-control">
              <button class="rr-seg-btn${panelPosition === 'right' ? ' rr-seg-active' : ''}" data-pos="right">▶ Right</button>
              <button class="rr-seg-btn${panelPosition === 'bottom' ? ' rr-seg-active' : ''}" data-pos="bottom">▼ Bottom</button>
            </div>
          </div>
          <div class="rr-setting-row">
            <span class="rr-setting-label">Redirect to Old Reddit</span>
            <label class="rr-toggle">
              <input type="checkbox" id="rr-redirect-toggle" ${redirectEnabled ? 'checked' : ''}>
              <span class="rr-toggle-track"></span>
            </label>
          </div>
          <div class="rr-setting-row">
            <span class="rr-setting-label">Sort Unread by Upvotes</span>
            <label class="rr-toggle">
              <input type="checkbox" id="rr-score-sort-toggle" ${scoreSortEnabled ? 'checked' : ''}>
              <span class="rr-toggle-track"></span>
            </label>
          </div>
          <div class="rr-flair-section">
            <span class="rr-setting-label">Blocked Flairs</span>
            <div id="rr-flair-list"></div>
          </div>
          <div class="rr-kb-legend">
            <div class="rr-kb-group">
              <div class="rr-kb-group-title">Navigation</div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Move selection</span><span class="rr-kb-keys"><kbd class="rr-kb-key">↑</kbd><kbd class="rr-kb-key">↓</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Open selected post</span><span class="rr-kb-keys"><kbd class="rr-kb-key">→</kbd><kbd class="rr-kb-key">Enter</kbd><kbd class="rr-kb-key">Space</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Back to history</span><span class="rr-kb-keys"><kbd class="rr-kb-key">←</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Close panel / menu</span><span class="rr-kb-keys"><kbd class="rr-kb-key">Esc</kbd></span></div>
            </div>
            <div class="rr-kb-group">
              <div class="rr-kb-group-title">Hover a post</div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Expand media + mark read</span><span class="rr-kb-keys"><kbd class="rr-kb-key">E</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Expand media only</span><span class="rr-kb-keys"><kbd class="rr-kb-key">1</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Mark as read</span><span class="rr-kb-keys"><kbd class="rr-kb-key">G</kbd><kbd class="rr-kb-key">2</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Hide post</span><span class="rr-kb-keys"><kbd class="rr-kb-key">H</kbd><kbd class="rr-kb-key">4</kbd></span></div>
            </div>
            <div class="rr-kb-group">
              <div class="rr-kb-group-title">Right-click menu</div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Open in new tab</span><span class="rr-kb-keys"><kbd class="rr-kb-key">T</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Open in side panel</span><span class="rr-kb-keys"><kbd class="rr-kb-key">P</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Mark as read</span><span class="rr-kb-keys"><kbd class="rr-kb-key">R</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Hide</span><span class="rr-kb-keys"><kbd class="rr-kb-key">H</kbd></span></div>
            </div>
            <div class="rr-kb-group">
              <div class="rr-kb-group-title">Video (hover)</div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Play / pause</span><span class="rr-kb-keys"><kbd class="rr-kb-key">Space</kbd><kbd class="rr-kb-key">K</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Fullscreen</span><span class="rr-kb-keys"><kbd class="rr-kb-key">F</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Mute</span><span class="rr-kb-keys"><kbd class="rr-kb-key">M</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Seek ±5s (Shift=10s)</span><span class="rr-kb-keys"><kbd class="rr-kb-key">←</kbd><kbd class="rr-kb-key">→</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Volume</span><span class="rr-kb-keys"><kbd class="rr-kb-key">↑</kbd><kbd class="rr-kb-key">↓</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Skip 10s</span><span class="rr-kb-keys"><kbd class="rr-kb-key">J</kbd><kbd class="rr-kb-key">L</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Frame step</span><span class="rr-kb-keys"><kbd class="rr-kb-key">,</kbd><kbd class="rr-kb-key">.</kbd></span></div>
              <div class="rr-kb-row"><span class="rr-kb-desc">Jump to %</span><span class="rr-kb-keys"><kbd class="rr-kb-key">0</kbd>–<kbd class="rr-kb-key">9</kbd></span></div>
            </div>
          </div>
        </div>
      </div>
      <div id="rr-body">
        <div id="rr-history-view"></div>
        <div id="rr-loader" class="rr-hidden"><div class="rr-spinner"></div></div>
        <iframe id="rr-iframe" class="rr-hidden"></iframe>
        <div id="rr-drag-overlay" class="rr-hidden"></div>
      </div>
    `;
    document.body.appendChild(panel);
    applyWidth();
    renderFlairBlocklist();

    const resizeHandle = panel.querySelector('#rr-resize');
    const dragOverlay = panel.querySelector('#rr-drag-overlay');
    resizeHandle.addEventListener('mousedown', e => {
      e.preventDefault();
      document.body.style.userSelect = 'none';
      document.body.style.cursor = panelPosition === 'bottom' ? 'ns-resize' : 'ew-resize';
      resizeHandle.classList.add('rr-resizing');
      dragOverlay.classList.remove('rr-hidden');

      const onMouseMove = ev => {
        if (panelPosition === 'bottom') {
          panelHeight = Math.max(MIN_HEIGHT, Math.min(window.innerHeight, window.innerHeight - ev.clientY));
          applyHeight();
        } else {
          panelWidth = Math.max(MIN_WIDTH, Math.min(window.innerWidth, window.innerWidth - ev.clientX));
          applyWidth();
        }
      };
      const onMouseUp = () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        resizeHandle.classList.remove('rr-resizing');
        dragOverlay.classList.add('rr-hidden');
        if (panelPosition === 'bottom') {
          chrome.storage.local.set({ [HEIGHT_KEY]: panelHeight });
        } else {
          chrome.storage.local.set({ [WIDTH_KEY]: panelWidth });
        }
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    panel.querySelector('#rr-close').addEventListener('click', closePanel);
    panel.querySelector('#rr-settings-toggle').addEventListener('click', () => {
      panel.querySelector('#rr-settings').classList.toggle('rr-hidden');
    });
    panel.querySelectorAll('.rr-seg-btn[data-pos]').forEach(btn => {
      btn.addEventListener('click', () => applyPanelPosition(btn.dataset.pos));
    });
    panel.querySelector('#rr-redirect-toggle').addEventListener('change', e => {
      redirectEnabled = e.target.checked;
      chrome.runtime.sendMessage({ type: 'rr_setRedirect', enabled: redirectEnabled });
    });
    panel.querySelector('#rr-score-sort-toggle').addEventListener('change', e => {
      scoreSortEnabled = e.target.checked;
      chrome.storage.local.set({ [SCORE_SORT_KEY]: scoreSortEnabled });
      reorderListing();
    });
    document.addEventListener('keydown', e => {
      // Context menu hotkeys — consumed before everything else
      if (contextMenuEl?.classList.contains('rr-ctx-visible')) {
        switch (e.key) {
          case 'Escape': hideContextMenu(); return;
          case 't': case 'T': e.preventDefault(); execContextAction('newtab'); return;
          case 'p': case 'P': e.preventDefault(); execContextAction('panel'); return;
          case 'r': case 'R': e.preventDefault(); execContextAction('markread'); return;
          case 'h': case 'H': e.preventDefault(); execContextAction('hide'); return;
        }
        return; // swallow all other keys while menu is open
      }

      handleNavKeydown(e);
    });
    panel.querySelector('#rr-back').addEventListener('click', showHistoryView);
    panel.querySelector('#rr-newtab').addEventListener('click', () => {
      const src = panel.querySelector('#rr-iframe').dataset.url;
      if (src) window.open(src, '_blank');
    });
    panel.querySelector('#rr-hide').addEventListener('click', hideCurrentPost);
  }

  function buildTab() {
    if (tab) return;
    tab = document.createElement('button');
    tab.id = 'rr-tab';
    tab.textContent = '▶';
    tab.addEventListener('click', togglePanel);
    document.body.appendChild(tab);
    buildTabPopup();
  }

  function buildTabPopup() {
    if (tabPopup) return;
    tabPopup = document.createElement('div');
    tabPopup.id = 'rr-tab-popup';
    tabPopup.innerHTML = `
      <div id="rr-tab-popup-list"></div>
      <div id="rr-tab-popup-footer">
        <button class="rr-btn" id="rr-tab-popup-open">Open Panel</button>
      </div>
    `;
    document.body.appendChild(tabPopup);

    const showPopup = () => {
      clearTimeout(tabPopupTimeout);
      renderTabPopup();
      const rect = tab.getBoundingClientRect();
      if (panelPosition === 'bottom') {
        const popupWidth = 280;
        tabPopup.style.right = '';
        tabPopup.style.top = 'auto';
        tabPopup.style.transform = 'none';
        const left = Math.max(8, Math.min(rect.left + rect.width / 2 - popupWidth / 2, window.innerWidth - popupWidth - 8));
        tabPopup.style.left = left + 'px';
        tabPopup.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      } else {
        tabPopup.style.left = '';
        tabPopup.style.bottom = '';
        tabPopup.style.top = '';
        tabPopup.style.transform = '';
        tabPopup.style.right = (window.innerWidth - rect.left) + 'px';
      }
      tabPopup.classList.add('rr-tab-popup-visible');
    };
    const hidePopup = () => {
      tabPopupTimeout = setTimeout(() => {
        tabPopup.classList.remove('rr-tab-popup-visible');
      }, 150);
    };

    tab.addEventListener('mouseenter', showPopup);
    tab.addEventListener('mouseleave', hidePopup);
    tabPopup.addEventListener('mouseenter', () => clearTimeout(tabPopupTimeout));
    tabPopup.addEventListener('mouseleave', hidePopup);

    tabPopup.querySelector('#rr-tab-popup-open').addEventListener('click', () => {
      tabPopup.classList.remove('rr-tab-popup-visible');
      openPanel();
      showHistoryView();
    });
  }

  function renderTabPopup() {
    const list = tabPopup.querySelector('#rr-tab-popup-list');
    const recent = history.slice(0, 6);
    if (recent.length === 0) {
      list.innerHTML = '<p class="rr-tab-popup-empty">No history yet.</p>';
      return;
    }
    list.innerHTML = recent.map(p => `
      <div class="rr-tab-popup-item${p.read ? ' rr-read' : ' rr-unread'}"
           data-url="${esc(p.url)}" data-id="${esc(p.id)}">
        <div class="rr-dot"></div>
        <div class="rr-tab-popup-title">${esc(p.title)}</div>
      </div>
    `).join('');
    list.querySelectorAll('.rr-tab-popup-item').forEach(el => {
      el.addEventListener('click', () => {
        tabPopup.classList.remove('rr-tab-popup-visible');
        loadPost(el.dataset.url, el.dataset.id);
      });
    });
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  function openPanel() {
    buildPanel();
    panel.classList.add('rr-open');
    document.body.classList.add('rr-pushed');
    if (panelPosition === 'bottom') {
      document.body.style.marginBottom = panelHeight + 'px';
    } else {
      document.body.style.marginRight = panelWidth + 'px';
    }
    tab.style.display = 'none';
    chrome.storage.local.set({ [PIN_KEY]: true });
  }

  function closePanel() {
    panel.classList.remove('rr-open');
    document.body.style.marginRight = '';
    document.body.style.marginBottom = '';
    setTimeout(() => document.body.classList.remove('rr-pushed'), 220);
    tab.style.display = '';
    chrome.storage.local.set({ [PIN_KEY]: false });
  }

  function togglePanel() {
    if (panel && panel.classList.contains('rr-open')) {
      closePanel();
    } else {
      openPanel();
      showHistoryView();
    }
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  function showHistoryView() {
    if (!panel) return;
    currentPostId = null;

    panel.querySelector('#rr-back').classList.add('rr-hidden');
    panel.querySelector('#rr-newtab').classList.add('rr-hidden');
    panel.querySelector('#rr-hide').classList.add('rr-hidden');
    updateReadCount();

    const iframe = panel.querySelector('#rr-iframe');
    iframe.srcdoc = '<!DOCTYPE html><html><head></head><body></body></html>';
    iframe.classList.add('rr-hidden');

    const histView = panel.querySelector('#rr-history-view');
    histView.classList.remove('rr-hidden');
    renderHistoryList(histView);
  }

  function renderHistoryList(container) {
    if (history.length === 0) {
      container.innerHTML = '<p class="rr-empty">No history yet.<br>Click any post to start reading.</p>';
      return;
    }

    container.innerHTML = history.map(p => `
      <div class="rr-hist-item${p.read ? ' rr-read' : ' rr-unread'}${p.id === currentPostId ? ' rr-selected' : ''}"
           data-id="${esc(p.id)}" data-url="${esc(p.url)}">
        <div class="rr-dot"></div>
        <div class="rr-hist-content">
          <div class="rr-hist-title">${esc(p.title)}</div>
          <div class="rr-hist-meta">${esc(p.sub)} · ${timeAgo(p.timestamp)}</div>
        </div>
        <button class="rr-hist-remove" data-id="${esc(p.id)}" title="Remove from history">✕</button>
      </div>
    `).join('');

    container.querySelectorAll('.rr-hist-item').forEach(el => {
      el.addEventListener('click', () => loadPost(el.dataset.url, el.dataset.id));
    });

    container.querySelectorAll('.rr-hist-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        removeFromHistory(btn.dataset.id);
      });
    });
  }

  async function showPostView(url) {
    if (!panel) return;
    panel.querySelector('#rr-back').classList.remove('rr-hidden');
    panel.querySelector('#rr-newtab').classList.remove('rr-hidden');
    panel.querySelector('#rr-hide').classList.remove('rr-hidden');
    panel.querySelector('#rr-history-view').classList.add('rr-hidden');

    const loader = panel.querySelector('#rr-loader');
    const iframe = panel.querySelector('#rr-iframe');
    const gen = ++loadGen;

    loader.classList.remove('rr-hidden');
    loader.innerHTML = '<div class="rr-spinner"></div>';
    iframe.classList.add('rr-hidden');
    setActiveVideo(null, null);
    iframe.srcdoc = '<!DOCTYPE html><html><head></head><body></body></html>';
    iframe.dataset.url = url;

    try {
      const now = Date.now();
      const gap = now - lastFetchTime;
      if (gap < FETCH_MIN_GAP) await new Promise(r => setTimeout(r, FETCH_MIN_GAP - gap));
      if (gen !== loadGen) return;
      lastFetchTime = Date.now();

      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        if (gen !== loadGen) return;
        if (response.status === 429) {
          loader.innerHTML = `<p class="rr-empty">Reddit is rate-limiting requests.<br><button class="rr-btn rr-retry">Retry</button></p>`;
          loader.querySelector('.rr-retry').addEventListener('click', () => showPostView(url));
        } else {
          loader.innerHTML = `<p class="rr-empty">Failed to load (${response.status}).</p>`;
        }
        return;
      }
      const html = await response.text();
      if (gen !== loadGen) return;

      const doc = new DOMParser().parseFromString(html, 'text/html');

      // Extract score info before removing sidebar
      const scoreEl = doc.querySelector('.linkinfo .score');
      const scoreNum = parseInt((scoreEl?.querySelector('.number')?.textContent?.trim() ?? '').replace(/,/g, ''), 10);
      const pctMatch = scoreEl?.textContent?.match(/(\d+)\s*%\s*upvoted/);
      const upvotePct = pctMatch ? parseInt(pctMatch[1], 10) : null;

      // Hide sidebar — score info already extracted above
      const sideEl = doc.querySelector('.side');
      if (sideEl) sideEl.style.display = 'none';

      // Reverse-engineer ups/downs from net score + upvote ratio
      // score = ups - downs, ratio = ups / (ups + downs)
      // => total = score / (2R - 1), ups = total * R, downs = total * (1-R)
      let upsDisplay = '', downsDisplay = '', pctDisplay = '';
      if (!isNaN(scoreNum) && upvotePct !== null) {
        const R = upvotePct / 100;
        let ups = scoreNum, downs = 0;
        const denom = 2 * R - 1;
        if (R >= 0.99) {
          ups = scoreNum; downs = 0;
        } else if (R <= 0.01) {
          ups = 0; downs = Math.abs(scoreNum);
        } else if (Math.abs(denom) > 0.02) {
          const total = Math.round(Math.abs(scoreNum) / Math.abs(denom));
          ups = Math.round(total * R);
          downs = Math.max(0, total - ups);
        }
        upsDisplay = ups.toLocaleString();
        downsDisplay = downs.toLocaleString();
        pctDisplay = `${upvotePct}%`;
      }

      // Inject vote bar under .title inside .top-matter and color-code its background
      const topMatter = doc.querySelector('.top-matter');
      if (topMatter && pctDisplay) {
        const voteBar = doc.createElement('div');
        voteBar.className = 'rr-vote-bar';
        voteBar.innerHTML =
          `<span class="rr-up">▲ ${upsDisplay}</span>` +
          `<span class="rr-sep">|</span>` +
          `<span class="rr-dn">▼ ${downsDisplay}</span>` +
          `<span class="rr-sep">|</span>` +
          `<span class="rr-pct">${pctDisplay}</span>`;

        const titleEl = topMatter.querySelector('.title');
        if (titleEl) titleEl.insertAdjacentElement('afterend', voteBar);
        else topMatter.appendChild(voteBar);

        let bg;
        if      (upvotePct >= 90) bg = 'rgba(34,160,50,0.13)';
        else if (upvotePct >= 80) bg = 'rgba(105,185,40,0.14)';
        else if (upvotePct >= 70) bg = 'rgba(178,205,0,0.16)';
        else if (upvotePct >= 60) bg = 'rgba(225,168,0,0.17)';
        else if (upvotePct >= 50) bg = 'rgba(248,118,0,0.17)';
        else if (upvotePct >= 40) bg = 'rgba(238,62,18,0.17)';
        else if (upvotePct >= 30) bg = 'rgba(208,22,22,0.18)';
        else                      bg = 'rgba(160,0,0,0.32)';
        topMatter.style.cssText += `background-color:${bg};border-radius:4px;padding:4px 6px;`;
      }

      // Inject base href + scoped styles
      const base = doc.createElement('base');
      base.href = 'https://old.reddit.com/';
      base.target = '_blank';
      doc.head.insertBefore(base, doc.head.firstChild);

      // Block Reddit's frame-busting code by making top/parent look like the current window.
      // Must run before any of Reddit's existing <script> tags execute.
      const frameGuard = doc.createElement('script');
      frameGuard.textContent = `(function(){
        try { Object.defineProperty(window,'top',{configurable:true,get:function(){return window;}}); } catch(e){}
        try { Object.defineProperty(window,'parent',{configurable:true,get:function(){return window;}}); } catch(e){}
      })();`;
      doc.head.insertBefore(frameGuard, base.nextSibling);

      const style = doc.createElement('style');
      style.textContent = `
        body { font-size: 11px !important; }
        .content { width: auto !important; margin-right: 10px !important; }
        .rr-vote-bar { display: flex; align-items: center; gap: 5px; font-size: 20px; font-weight: 600; margin-top: 4px; flex-wrap: wrap; }
        .rr-up { color: #ff4500; }
        .rr-dn { color: #7193ff; }
        .rr-sep { color: #aaa; font-weight: 400; }
        .rr-pct { color: #336; }
        .comment .entry {
          cursor: pointer;
          border-radius: 4px;
          transition: background 0.12s, transform 0.12s, box-shadow 0.12s;
        }
        .comment .entry:hover {
          background: rgba(0, 121, 211, 0.07) !important;
          transform: scale(1.01);
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
          position: relative;
          z-index: 1;
        }
        @keyframes rr-video-pulse {
          0%, 100% { box-shadow: 0 0 0 3px rgba(0, 121, 211, 0.75), 0 0 14px rgba(0, 121, 211, 0.5); }
          50%       { box-shadow: 0 0 0 3px rgba(0, 121, 211, 0.2),  0 0 6px  rgba(0, 121, 211, 0.15); }
        }
        .reddit-video-player-root.rr-video-active {
          outline: 3px solid rgba(0, 121, 211, 0.85);
          border-radius: 4px;
          animation: rr-video-pulse 1.4s ease-in-out infinite;
        }
      `;
      doc.head.appendChild(style);

      const commentScript = doc.createElement('script');
      commentScript.textContent = `(function(){
        document.addEventListener('click', function(e) {
          // Prevent expand/collapse anchors from navigating; let their inline onclick still fire
          if (e.target.closest('.expand')) {
            e.preventDefault();
            return;
          }
          if (e.target.closest('a, button, input')) return;
          // Don't collapse if the click is releasing a text selection (copying)
          var sel = window.getSelection();
          if (sel && sel.toString().length > 0) return;
          var entry = e.target.closest('.entry');
          if (!entry) return;
          var comment = entry.closest('.comment');
          if (!comment) return;
          var expandBtn = comment.querySelector('.expand');
          if (expandBtn) expandBtn.click();
        }, true);
      })();`;
      doc.body.appendChild(commentScript);

      const scrollScript = doc.createElement('script');
      scrollScript.textContent = `(function(){
        window.addEventListener('DOMContentLoaded', function() {
          var header = document.getElementById('header');
          if (header) window.scrollTo(0, header.offsetTop + header.offsetHeight);
        });
      })();`;
      doc.body.appendChild(scrollScript);

      const automodScript = doc.createElement('script');
      automodScript.textContent = `(function(){
        function collapseAutoMod() {
          document.querySelectorAll('.thing.stickied').forEach(function(thing) {
            var authorEl = thing.querySelector('.author');
            if (authorEl && authorEl.textContent.trim() === 'AutoModerator') {
              var expandBtn = thing.querySelector('.expand');
              if (expandBtn) expandBtn.click();
            }
          });
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', collapseAutoMod);
        } else {
          collapseAutoMod();
        }
      })();`;
      doc.body.appendChild(automodScript);

      iframe.addEventListener('load', () => setupIframeVideoControls(iframe), { once: true });
      iframe.srcdoc = doc.documentElement.outerHTML;
      loader.classList.add('rr-hidden');
      iframe.classList.remove('rr-hidden');
    } catch (err) {
      if (gen !== loadGen) return;
      const is429 = err?.message?.includes('429') || err?.message?.includes('ERR_HTTP_RESPONSE_CODE_FAILURE');
      if (is429) {
        loader.innerHTML = `<p class="rr-empty">Reddit is rate-limiting requests.<br><button class="rr-btn rr-retry">Retry</button></p>`;
        loader.querySelector('.rr-retry').addEventListener('click', () => showPostView(url));
      } else {
        loader.innerHTML = '<p class="rr-empty">Failed to load.</p>';
      }
    }
  }

  // ── Post loading ──────────────────────────────────────────────────────────

  function loadPost(url, id) {
    currentPostId = id;
    openPanel();
    showPostView(url);
    markRead(id);
    updateListingReadState(id);
  }

  // ── Click interception ────────────────────────────────────────────────────

  function openThingInNewTab(thing) {
    window.open('https://old.reddit.com' + thing.dataset.permalink, '_blank');
  }

  function interceptPostClicks() {
    // Track which .thing the mouse is currently over (for H-key hide)
    document.addEventListener('mouseover', e => {
      hoveredThingEl = e.target.closest('.thing[data-permalink]') || null;
    });

    // Middle-click anywhere on a post row → open in new tab
    document.addEventListener('auxclick', e => {
      if (e.button !== 1) return;
      const thing = e.target.closest('.thing[data-permalink]');
      if (!thing || e.target.closest(PASSTHROUGH_SEL)) return;
      e.preventDefault();
      openThingInNewTab(thing);
    }, true);

    // Right-click on a post → custom context menu
    // Ctrl+right-click → silent mark-as-read (no menu)
    document.addEventListener('contextmenu', e => {
      const thing = e.target.closest('.thing[data-permalink]');
      if (!thing || e.target.closest(PASSTHROUGH_SEL)) {
        hideContextMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey) {
        // Ctrl+right-click: mark as read silently, no menu
        const id = (thing.dataset.fullname || '').replace('t3_', '');
        const url = 'https://old.reddit.com' + thing.dataset.permalink;
        const title = thing.querySelector('a.title')?.textContent?.trim() || '';
        const sub = thing.dataset.subredditPrefixed || '';
        upsertHistory({ id, url, title, sub, timestamp: Date.now(), read: true });
        updateListingReadState(id);
        updateReadCount();
        return;
      }

      const flairEl = e.target.closest('.linkflairlabel');
      const flairInfo = flairEl
        ? { sub: thing.dataset.subredditPrefixed || '', flair: (flairEl.getAttribute('title') || flairEl.textContent || '').trim() }
        : null;
      showContextMenu(thing, e.clientX, e.clientY, flairInfo);
    }, true);

    // Dismiss context menu on outside click or scroll
    document.addEventListener('click', e => {
      if (contextMenuEl?.classList.contains('rr-ctx-visible') && !contextMenuEl.contains(e.target)) {
        hideContextMenu();
      }
    }, true);
    document.addEventListener('scroll', () => hideContextMenu(), true);

    // Clicking a video expando button → mark as read (without opening the panel)
    document.addEventListener('click', e => {
      const expandoBtn = e.target.closest('.expando-button.video');
      if (!expandoBtn) return;
      const thing = expandoBtn.closest('.thing[data-permalink]');
      if (!thing) return;
      const id = (thing.dataset.fullname || '').replace('t3_', '');
      if (!id) return;
      const url = 'https://old.reddit.com' + thing.dataset.permalink;
      const title = thing.querySelector('a.title')?.textContent?.trim() || '';
      const sub = thing.dataset.subredditPrefixed || '';
      upsertHistory({ id, url, title, sub, timestamp: Date.now(), read: true });
      updateListingReadState(id);
      updateReadCount();
    }, true);

    // Capture phase so we run before Reddit's inline onclick="click_thing(this)"
    document.addEventListener('click', e => {
      // meta/cmd+click → open in new tab
      if (e.metaKey) {
        const thing = e.target.closest('.thing[data-permalink]');
        if (thing && !e.target.closest(PASSTHROUGH_SEL)) {
          e.preventDefault();
          e.stopPropagation();
          openThingInNewTab(thing);
        }
        return;
      }

      // Let native Reddit controls pass through untouched
      if (e.target.closest(PASSTHROUGH_SEL)) return;

      const thing = e.target.closest('.thing[data-permalink]');
      if (!thing) return;

      const permalink = thing.dataset.permalink;
      if (!permalink) return;

      e.preventDefault();
      e.stopPropagation();

      const id = (thing.dataset.fullname || '').replace('t3_', '');
      const url = 'https://old.reddit.com' + permalink;
      const title = thing.querySelector('a.title')?.textContent?.trim() || '';
      const sub = thing.dataset.subredditPrefixed || '';

      // Highlight selected post row
      if (selectedThingEl && selectedThingEl !== thing) {
        selectedThingEl.classList.remove('rr-thing-selected');
      }
      selectedThingEl = thing;
      thing.classList.add('rr-thing-selected');

      upsertHistory({ id, url, title, sub, timestamp: Date.now(), read: false });
      loadPost(url, id);
    }, true);
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────

  function navigateThings(dir) {
    const siteTable = document.querySelector('#siteTable');
    if (!siteTable) return;
    const things = [...siteTable.querySelectorAll(':scope > .thing[data-permalink]')];
    if (things.length === 0) return;

    let idx = selectedThingEl ? things.indexOf(selectedThingEl) : -1;
    idx = Math.max(0, Math.min(things.length - 1, idx + dir));

    if (selectedThingEl) selectedThingEl.classList.remove('rr-thing-selected');
    selectedThingEl = things[idx];
    selectedThingEl.classList.add('rr-thing-selected');
    selectedThingEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function openSelectedThing() {
    if (!selectedThingEl) return;
    const permalink = selectedThingEl.dataset.permalink;
    if (!permalink) return;
    const id = (selectedThingEl.dataset.fullname || '').replace('t3_', '');
    const url = 'https://old.reddit.com' + permalink;
    const title = selectedThingEl.querySelector('a.title')?.textContent?.trim() || '';
    const sub = selectedThingEl.dataset.subredditPrefixed || '';
    upsertHistory({ id, url, title, sub, timestamp: Date.now(), read: false });
    loadPost(url, id);
  }

  // Shared nav/hotkey handling — bound to the main document AND to the panel
  // iframe's document, so keyboard shortcuts keep working while focus is in
  // the right-hand panel instead of requiring a click back onto the listing.
  function handleNavKeydown(e) {
    if (e.key === 'Escape' && panel.classList.contains('rr-open')) { closePanel(); return; }
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      navigateThings(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'ArrowRight' && selectedThingEl) {
      e.preventDefault();
      openSelectedThing();
    } else if (e.key === 'ArrowLeft' && currentPostId) {
      e.preventDefault();
      showHistoryView();
    } else if ((e.key === 'Enter' || e.key === ' ') && selectedThingEl) {
      e.preventDefault();
      openSelectedThing();
    } else if ((e.key === 'h' || e.key === 'H') && hoveredThingEl) {
      e.preventDefault();
      hideThingEl(hoveredThingEl);
    } else if ((e.key === 'e' || e.key === 'E') && hoveredThingEl) {
      e.preventDefault();
      const expando = hoveredThingEl.querySelector('.expando-button:not(.rr-extra-expando)');
      if (expando) expando.click();
      const _eid = (hoveredThingEl.dataset.fullname || '').replace('t3_', '');
      const _eurl = 'https://old.reddit.com' + hoveredThingEl.dataset.permalink;
      const _etitle = hoveredThingEl.querySelector('a.title')?.textContent?.trim() || '';
      const _esub = hoveredThingEl.dataset.subredditPrefixed || '';
      upsertHistory({ id: _eid, url: _eurl, title: _etitle, sub: _esub, timestamp: Date.now(), read: true });
      updateListingReadState(_eid);
      updateReadCount();
    } else if ((e.key === 'g' || e.key === 'G') && hoveredThingEl) {
      e.preventDefault();
      const _id = (hoveredThingEl.dataset.fullname || '').replace('t3_', '');
      const _url = 'https://old.reddit.com' + hoveredThingEl.dataset.permalink;
      const _title = hoveredThingEl.querySelector('a.title')?.textContent?.trim() || '';
      const _sub = hoveredThingEl.dataset.subredditPrefixed || '';
      upsertHistory({ id: _id, url: _url, title: _title, sub: _sub, timestamp: Date.now(), read: true });
      updateListingReadState(_id);
      updateReadCount();
    } else if (e.key === '1' && hoveredThingEl) {
      e.preventDefault();
      const expando = hoveredThingEl.querySelector('.expando-button:not(.rr-extra-expando)');
      if (expando) expando.click();
    } else if (e.key === '2' && hoveredThingEl) {
      e.preventDefault();
      const _2id = (hoveredThingEl.dataset.fullname || '').replace('t3_', '');
      const _2url = 'https://old.reddit.com' + hoveredThingEl.dataset.permalink;
      const _2title = hoveredThingEl.querySelector('a.title')?.textContent?.trim() || '';
      const _2sub = hoveredThingEl.dataset.subredditPrefixed || '';
      upsertHistory({ id: _2id, url: _2url, title: _2title, sub: _2sub, timestamp: Date.now(), read: true });
      updateListingReadState(_2id);
      updateReadCount();
    } else if (e.key === '4' && hoveredThingEl) {
      e.preventDefault();
      hideThingEl(hoveredThingEl);
    }
  }

  // ── Flair blocklist ───────────────────────────────────────────────────────

  function normalizeSub(sub) {
    return (sub || '').replace(/^\/?r\//i, '').trim().toLowerCase();
  }

  function normalizeFlair(flair) {
    return (flair || '').trim().toLowerCase();
  }

  function getThingFlair(thing) {
    const flairEl = thing.querySelector('.linkflairlabel');
    if (!flairEl) return '';
    return (flairEl.getAttribute('title') || flairEl.textContent || '').trim();
  }

  function isFlairBlocked(thing) {
    if (flairBlocklist.length === 0) return false;
    const sub = normalizeSub(thing.dataset.subredditPrefixed);
    const flair = normalizeFlair(getThingFlair(thing));
    if (!sub || !flair) return false;
    return flairBlocklist.some(b => b.sub === sub && b.flair === flair);
  }

  function applyFlairFilter(root) {
    if (flairBlocklist.length === 0) return;
    (root || document).querySelectorAll('.thing[data-permalink]').forEach(thing => {
      if (isFlairBlocked(thing)) thing.classList.add('rr-flair-hidden');
    });
  }

  function addFlairBlock(subLabel, flairLabel) {
    const sub = normalizeSub(subLabel);
    const flair = normalizeFlair(flairLabel);
    if (!sub || !flair) return;
    if (flairBlocklist.some(b => b.sub === sub && b.flair === flair)) return;
    flairBlocklist.push({ sub, flair, subLabel: subLabel || sub, flairLabel: flairLabel.trim() });
    saveFlairBlocklist();
    applyFlairFilter();
    renderFlairBlocklist();
  }

  function removeFlairBlock(sub, flair) {
    flairBlocklist = flairBlocklist.filter(b => !(b.sub === sub && b.flair === flair));
    saveFlairBlocklist();
    renderFlairBlocklist();
  }

  function renderFlairBlocklist() {
    const list = panel?.querySelector('#rr-flair-list');
    if (!list) return;
    if (flairBlocklist.length === 0) {
      list.innerHTML = '<p class="rr-flair-empty">No flairs blocked yet.<br>Right-click a flair on a post to hide it.</p>';
      return;
    }
    list.innerHTML = flairBlocklist.map(b => `
      <div class="rr-flair-item" data-sub="${esc(b.sub)}" data-flair="${esc(b.flair)}">
        <span class="rr-flair-item-label">${esc(b.flairLabel)} <span class="rr-flair-item-sub">in r/${esc(b.sub)}</span></span>
        <button class="rr-flair-remove" title="Unblock">✕</button>
      </div>
    `).join('');
    list.querySelectorAll('.rr-flair-item').forEach(el => {
      el.querySelector('.rr-flair-remove').addEventListener('click', () => {
        removeFlairBlock(el.dataset.sub, el.dataset.flair);
      });
    });
  }

  // ── Listing read state ────────────────────────────────────────────────────

  function updateListingReadState(id) {
    document.querySelectorAll(`.thing[data-fullname="t3_${id}"]`).forEach(el => {
      el.classList.add('rr-listing-read');
    });
  }

  function applyReadStateToListing() {
    history.filter(p => p.read).forEach(p => updateListingReadState(p.id));
  }

  // Reads the visible score off a listing row. Posts with a hidden score show a
  // "•" instead of a number — those count as 0 so they sink to the bottom.
  function parseThingScore(thing) {
    const el = thing.querySelector('.score.unvoted') || thing.querySelector('.score');
    const raw = (el?.textContent || '').replace(/,/g, '').trim();
    const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*([km])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    const suffix = (m[2] || '').toLowerCase();
    return Math.round(n * (suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1));
  }

  function reorderListing() {
    const siteTable = document.querySelector('#siteTable');
    if (!siteTable) return;

    // Remove any stale divider before recomputing order/positions
    siteTable.querySelector(':scope > #rr-read-divider')?.remove();

    const things = [...siteTable.querySelectorAll(':scope > .thing[data-permalink]')];
    if (things.length === 0) return;

    // Stamp the listing's natural order once so sorting can be undone
    things.forEach(t => {
      if (t.dataset.rrOrder === undefined) t.dataset.rrOrder = String(naturalOrderCounter++);
    });

    const readIds = new Set(history.filter(p => p.read).map(p => p.id));
    const isRead = t => readIds.has((t.dataset.fullname || '').replace('t3_', ''));
    const natural = (a, b) => Number(a.dataset.rrOrder) - Number(b.dataset.rrOrder);

    const unread = things.filter(t => !isRead(t)).sort(
      scoreSortEnabled
        ? (a, b) => parseThingScore(b) - parseThingScore(a) || natural(a, b)
        : natural
    );
    const read = things.filter(isRead).sort(natural);

    const ordered = [...unread, ...read];
    if (!ordered.every((t, i) => t === things[i])) {
      const placeholder = document.createTextNode('');
      siteTable.insertBefore(placeholder, things[0]);
      things.forEach(t => t.remove());

      const fragment = document.createDocumentFragment();
      ordered.forEach(t => fragment.appendChild(t));
      siteTable.insertBefore(fragment, placeholder);
      placeholder.remove();
    }

    // Mark the boundary between unread and read posts
    if (unread.length > 0 && read.length > 0) {
      const divider = document.createElement('div');
      divider.id = 'rr-read-divider';
      read[0].insertAdjacentElement('beforebegin', divider);
    }
  }

  // ── Panel iframe video controls ───────────────────────────────────────────

  function setupIframeVideoControls(panelIframe) {
    const iDoc = panelIframe.contentDocument;
    if (!iDoc) {
      console.log('[rr-video] could not access panel iframe contentDocument');
      return;
    }
    console.log('[rr-video] attaching video listeners inside panel iframe');

    // Activate immediately if there's already a video in the panel
    const existingVideo = iDoc.querySelector('video');
    if (existingVideo) {
      console.log('[rr-video] auto-activating video on panel load', existingVideo);
      setActiveVideo(existingVideo, null);
    }

    iDoc.addEventListener('mouseover', e => {
      const video = e.target.closest('video');
      if (video) {
        videoIsHovered = true;
        if (video !== activeVideoEl) setActiveVideo(video, null);
      }
    });

    iDoc.addEventListener('mouseout', e => {
      if (e.target !== activeVideoEl) return;
      if (activeVideoEl.contains(e.relatedTarget)) return;
      console.log('[rr-video] mouse left video in panel iframe');
      videoIsHovered = false;
      setActiveVideo(null, null);
    });

    // Only one video plays at a time — pause the listing/other panel video
    // whenever a video inside this panel starts playing.
    iDoc.addEventListener('play', e => {
      if (e.target.tagName === 'VIDEO') {
        pauseOtherVideos(e.target, null);
      }
    }, true);

    // Handle keys when the panel iframe itself has focus
    iDoc.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (VIDEO_KEYS.has(e.key) && !(ARROW_KEYS.has(e.key) && !videoIsHovered)) {
        // Auto-activate the first video in the panel if the user hasn't hovered one yet
        // (arrows are excluded — those stay reserved for list navigation until hovered)
        if (!activeVideoEl) {
          const video = iDoc.querySelector('video');
          if (video) {
            console.log('[rr-video] auto-activating video for keydown');
            setActiveVideo(video, null);
          }
        }
        console.log('[rr-video] keydown in panel iframe:', e.key, '| activeVideoEl:', activeVideoEl);
        const handled = dispatchVideoKey(e.key, e.shiftKey);
        if (handled) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        console.log('[rr-video] key not handled — no active video');
      }
      // Fall through to the same nav/hotkey handling as the main document,
      // so arrows/H/G/E/etc. keep working while focus is inside the panel.
      handleNavKeydown(e);
    });
  }

  // ── Video control ─────────────────────────────────────────────────────────

  function controlVideo(video, key, shiftKey) {
    switch (key) {
      case ' ': case 'k': case 'K':
        video.paused ? video.play() : video.pause(); break;
      case 'f': case 'F':
        if (!document.fullscreenElement) {
          (video.closest('[class*="player"]') || video).requestFullscreen?.();
        } else {
          document.exitFullscreen();
        }
        break;
      case 'm': case 'M':
        video.muted = !video.muted; break;
      case 'ArrowLeft':
        video.currentTime = Math.max(0, video.currentTime - (shiftKey ? 10 : 5)); break;
      case 'ArrowRight':
        video.currentTime = Math.min(video.duration, video.currentTime + (shiftKey ? 10 : 5)); break;
      case 'ArrowUp':
        video.volume = Math.min(1, video.volume + 0.1); break;
      case 'ArrowDown':
        video.volume = Math.max(0, video.volume - 0.1); break;
      case 'j': case 'J':
        video.currentTime = Math.max(0, video.currentTime - 10); break;
      case 'l': case 'L':
        video.currentTime = Math.min(video.duration, video.currentTime + 10); break;
      case ',':
        video.currentTime = Math.max(0, video.currentTime - 1 / 30); break;
      case '.':
        video.currentTime = Math.min(video.duration, video.currentTime + 1 / 30); break;
      default:
        if (key >= '0' && key <= '9') {
          video.currentTime = video.duration * (parseInt(key) / 10);
        }
    }
  }

  function setActiveVideo(video, iframe) {
    if (activeVideoEl) {
      activeVideoEl.closest('.reddit-video-player-root')?.classList.remove('rr-video-active');
      console.log('[rr-video] deactivated', activeVideoEl);
    }
    activeVideoEl = video;
    activeVideoIframe = iframe;
    if (activeVideoEl) {
      activeVideoEl.closest('.reddit-video-player-root')?.classList.add('rr-video-active');
      console.log('[rr-video] activated', activeVideoEl, '| player root:', activeVideoEl.closest('.reddit-video-player-root'));
    }
  }

  // Enforce single-video playback: pause every other <video> (listing + panel)
  // and tell every other v.redd.it iframe (cross-origin, can't touch its DOM
  // directly) to pause too, whenever one video starts playing.
  function pauseOtherVideos(sourceVideo, sourceIframe) {
    document.querySelectorAll('video').forEach(v => {
      if (v !== sourceVideo && !v.paused) v.pause();
    });
    document.querySelectorAll('iframe[src*="v.redd.it"]').forEach(f => {
      if (f !== sourceIframe) f.contentWindow?.postMessage({ type: 'rr-video-pause' }, '*');
    });

    const panelIframe = panel?.querySelector('#rr-iframe');
    const iDoc = panelIframe?.contentDocument;
    if (iDoc) {
      iDoc.querySelectorAll('video').forEach(v => {
        if (v !== sourceVideo && !v.paused) v.pause();
      });
      iDoc.querySelectorAll('iframe[src*="v.redd.it"]').forEach(f => {
        if (f !== sourceIframe) f.contentWindow?.postMessage({ type: 'rr-video-pause' }, '*');
      });
    }
  }

  function dispatchVideoKey(key, shiftKey) {
    if (activeVideoEl && activeVideoEl.isConnected) {
      console.log('[rr-video] dispatching key to native video:', key);
      controlVideo(activeVideoEl, key, shiftKey);
      return true;
    }
    if (activeVideoIframe && activeVideoIframe.isConnected) {
      console.log('[rr-video] dispatching key to iframe:', key);
      activeVideoIframe.contentWindow.postMessage({ type: 'rr-video-key', key, shiftKey }, '*');
      return true;
    }
    return false;
  }

  function setupVideoControls() {
    document.addEventListener('mouseover', e => {
      const video = e.target.closest('video');
      if (video) {
        videoIsHovered = true;
        if (video !== activeVideoEl) setActiveVideo(video, null);
        return;
      }
      const iframe = e.target.closest('iframe[src*="v.redd.it"]');
      if (iframe) {
        videoIsHovered = true;
        if (iframe !== activeVideoIframe) setActiveVideo(null, iframe);
      }
    });

    document.addEventListener('mouseout', e => {
      if (e.target !== activeVideoEl) return;
      if (activeVideoEl.contains(e.relatedTarget)) return;
      console.log('[rr-video] mouse left video, deactivated');
      videoIsHovered = false;
      setActiveVideo(null, null);
    });

    document.addEventListener('play', e => {
      if (e.target.tagName === 'VIDEO') {
        if (e.target !== activeVideoEl) {
          console.log('[rr-video] play event — activating video', e.target);
          setActiveVideo(e.target, null);
        }
        pauseOtherVideos(e.target, null);
      }
    }, true);

    // A video inside a cross-origin v.redd.it iframe (listing or panel) started
    // playing — pause everything else so only one video plays at a time.
    window.addEventListener('message', e => {
      if (e.data?.type !== 'rr-video-playing') return;
      let sourceIframe = null;
      document.querySelectorAll('iframe[src*="v.redd.it"]').forEach(f => {
        if (f.contentWindow === e.source) sourceIframe = f;
      });
      if (!sourceIframe) {
        const iDoc = panel?.querySelector('#rr-iframe')?.contentDocument;
        iDoc?.querySelectorAll('iframe[src*="v.redd.it"]').forEach(f => {
          if (f.contentWindow === e.source) sourceIframe = f;
        });
      }
      pauseOtherVideos(null, sourceIframe);
    });

    document.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (!VIDEO_KEYS.has(e.key)) return;
      if (ARROW_KEYS.has(e.key) && !videoIsHovered) return; // let arrows fall through to list navigation
      console.log('[rr-video] keydown:', e.key, '| activeVideoEl:', activeVideoEl, '| activeVideoIframe:', activeVideoIframe);
      const handled = dispatchVideoKey(e.key, e.shiftKey);
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else {
        console.log('[rr-video] key not handled — no active video');
      }
    });
  }

  // ── Read counter ──────────────────────────────────────────────────────────

  function updateReadCount() {
    const el = panel?.querySelector('#rr-read-count');
    if (!el) return;
    const count = history.filter(p => p.read).length;
    el.textContent = count > 0 ? `${count} read` : '';
  }

  // ── Hide post ─────────────────────────────────────────────────────────────

  async function hideThingEl(thing) {
    const fullname = thing.dataset.fullname || '';
    const id = fullname.replace('t3_', '');
    if (!id) return;

    // Snapshot all copies immediately so the loop is stable
    const allCopies = [...document.querySelectorAll(`.thing[data-fullname="${fullname}"]`)];

    // Animate out: fade + height collapse (runs in parallel with the fetch)
    allCopies.forEach(el => {
      el.style.transition = 'opacity 0.25s ease, transform 0.25s ease, max-height 0.35s ease, margin-top 0.35s ease, margin-bottom 0.35s ease';
      el.style.overflow   = 'hidden';
      el.style.maxHeight  = el.offsetHeight + 'px';
      void el.offsetHeight; // force reflow so transition picks up the start value
      el.style.opacity    = '0';
      el.style.transform  = 'translateX(-6px)';
      el.style.maxHeight  = '0';
      el.style.marginTop  = '0';
      el.style.marginBottom = '0';
    });

    // Fire the API call without blocking the animation
    const modhash = document.querySelector('input[name=uh]')?.value || '';
    fetch('https://old.reddit.com/api/hide', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `id=${encodeURIComponent(fullname)}&uh=${encodeURIComponent(modhash)}`,
    }).catch(err => console.error('[rr] hide failed', err));

    // Wait for animation to finish, then clean up the DOM
    await new Promise(r => setTimeout(r, 380));
    allCopies.forEach(el => el.remove());

    // Clear hover/selection state if they pointed at this post
    if (hoveredThingEl?.dataset.fullname === fullname) hoveredThingEl = null;
    if (selectedThingEl?.dataset.fullname === fullname) selectedThingEl = null;

    // Remove from history if it was there
    const inHistory = history.some(p => p.id === id);
    if (inHistory) {
      removeFromHistory(id);
    }

    // If this post was open in the panel, return to history view
    if (id === currentPostId) {
      showHistoryView();
    }
  }

  async function hideCurrentPost() {
    if (!currentPostId) return;
    const modhash = document.querySelector('input[name=uh]')?.value || '';
    try {
      await fetch('https://old.reddit.com/api/hide', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `id=t3_${currentPostId}&uh=${encodeURIComponent(modhash)}`,
      });
    } catch (e) {
      console.error('[rr] hide failed', e);
    }
    document.querySelectorAll(`.thing[data-fullname="t3_${currentPostId}"]`).forEach(el => el.remove());
    removeFromHistory(currentPostId);
    showHistoryView();
  }

  // ── Context menu ──────────────────────────────────────────────────────────

  function buildContextMenu() {
    if (contextMenuEl) return;
    contextMenuEl = document.createElement('div');
    contextMenuEl.id = 'rr-context-menu';
    contextMenuEl.innerHTML = `
      <div class="rr-ctx-item" data-action="newtab">
        <span class="rr-ctx-label">Open in New Tab</span>
        <kbd class="rr-ctx-key">T</kbd>
      </div>
      <div class="rr-ctx-item" data-action="panel">
        <span class="rr-ctx-label">Open in Side Panel</span>
        <kbd class="rr-ctx-key">P</kbd>
      </div>
      <div class="rr-ctx-sep"></div>
      <div class="rr-ctx-item" data-action="markread">
        <span class="rr-ctx-label">Mark as Read</span>
        <kbd class="rr-ctx-key">R</kbd>
      </div>
      <div class="rr-ctx-item rr-ctx-danger" data-action="hide">
        <span class="rr-ctx-label">Hide</span>
        <kbd class="rr-ctx-key">H</kbd>
      </div>
      <div class="rr-ctx-item rr-ctx-danger rr-ctx-hideflair rr-hidden" data-action="hideflair">
        <span class="rr-ctx-label" id="rr-ctx-hideflair-label">Hide Flair</span>
      </div>
    `;
    document.body.appendChild(contextMenuEl);

    contextMenuEl.addEventListener('click', e => {
      const item = e.target.closest('.rr-ctx-item');
      if (!item) return;
      execContextAction(item.dataset.action);
    });
  }

  function showContextMenu(thing, x, y, flairInfo) {
    buildContextMenu();
    contextMenuThingEl = thing;
    contextMenuFlairInfo = flairInfo && flairInfo.flair ? flairInfo : null;

    const flairItem = contextMenuEl.querySelector('.rr-ctx-hideflair');
    if (contextMenuFlairInfo) {
      contextMenuEl.querySelector('#rr-ctx-hideflair-label').textContent = `Hide Flair "${contextMenuFlairInfo.flair}"`;
      flairItem.classList.remove('rr-hidden');
    } else {
      flairItem.classList.add('rr-hidden');
    }

    // Initial position at cursor
    contextMenuEl.style.left = x + 'px';
    contextMenuEl.style.top = y + 'px';
    contextMenuEl.classList.add('rr-ctx-visible');

    // Nudge back on-screen if it overflows the viewport
    requestAnimationFrame(() => {
      const rect = contextMenuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        contextMenuEl.style.left = Math.max(8, x - rect.width) + 'px';
      }
      if (rect.bottom > window.innerHeight - 8) {
        contextMenuEl.style.top = Math.max(8, y - rect.height) + 'px';
      }
    });
  }

  function hideContextMenu() {
    if (!contextMenuEl) return;
    contextMenuEl.classList.remove('rr-ctx-visible');
    contextMenuThingEl = null;
    contextMenuFlairInfo = null;
  }

  function execContextAction(action) {
    const thing = contextMenuThingEl; // capture before hiding clears them
    const flairInfo = contextMenuFlairInfo;
    hideContextMenu();
    if (action === 'hideflair') {
      if (flairInfo) addFlairBlock(flairInfo.sub, flairInfo.flair);
      return;
    }
    if (!thing) return;

    const id = (thing.dataset.fullname || '').replace('t3_', '');
    const url = 'https://old.reddit.com' + thing.dataset.permalink;
    const title = thing.querySelector('a.title')?.textContent?.trim() || '';
    const sub = thing.dataset.subredditPrefixed || '';

    switch (action) {
      case 'newtab':
        window.open(url, '_blank');
        break;

      case 'panel':
        if (selectedThingEl && selectedThingEl !== thing) {
          selectedThingEl.classList.remove('rr-thing-selected');
        }
        selectedThingEl = thing;
        thing.classList.add('rr-thing-selected');
        upsertHistory({ id, url, title, sub, timestamp: Date.now(), read: false });
        loadPost(url, id);
        break;

      case 'markread':
        upsertHistory({ id, url, title, sub, timestamp: Date.now(), read: true });
        updateListingReadState(id);
        updateReadCount();
        break;

      case 'hide':
        hideThingEl(thing);
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function esc(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  // ── Top-matter expando buttons ────────────────────────────────────────────

  function injectExpandoButtons(root) {
    (root || document).querySelectorAll('.thing[data-permalink]').forEach(thing => {
      const topMatter = thing.querySelector('.top-matter');
      if (!topMatter || topMatter.querySelector('.rr-tm-actions')) return;

      // Wrapper sits on the right of .top-matter, holds all injected buttons
      const actions = document.createElement('div');
      actions.className = 'rr-tm-actions';
      topMatter.appendChild(actions);

      // H hide button — every post
      const hideBtn = document.createElement('div');
      hideBtn.className = 'rr-hide-btn';
      hideBtn.title = 'Hide post (H)';
      hideBtn.textContent = 'H';
      actions.appendChild(hideBtn);
      hideBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        hideThingEl(thing);
      });

      // Expando proxy — only for posts with native media
      const nativeExpando = thing.querySelector('.expando-button:not(.rr-extra-expando)');
      if (!nativeExpando) return;

      const btn = document.createElement('div');
      btn.className = 'expando-button collapsed hide-when-pinned video rr-extra-expando';
      btn.title = 'Expand media';
      actions.appendChild(btn);

      let rrExpanded = false;
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        nativeExpando.click();
        rrExpanded = !rrExpanded;
        btn.classList.toggle('collapsed', !rrExpanded);
        btn.classList.toggle('expanded', rrExpanded);
      });
    });
  }

  function watchForNewThings() {
    const siteTable = document.querySelector('#siteTable');
    if (!siteTable) return;
    const observer = new MutationObserver(() => {
      injectExpandoButtons(siteTable);
      applyFlairFilter(siteTable);
    });
    observer.observe(siteTable, { childList: true, subtree: false });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function hideSidebar() {
    const side = document.querySelector('.side');
    if (side) side.style.display = 'none';
  }

  function isPostPage() {
    return /\/comments\//.test(window.location.pathname);
  }

  function setupDirectPostPage() {
    document.addEventListener('click', function(e) {
      if (e.target.closest('.expand')) {
        e.preventDefault();
        return;
      }
      if (e.target.closest('a, button, input')) return;
      // Don't collapse if the click is releasing a text selection (copying)
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const entry = e.target.closest('.entry');
      if (!entry) return;
      const comment = entry.closest('.comment');
      if (!comment) return;
      const expandBtn = comment.querySelector('.expand');
      if (expandBtn) expandBtn.click();
    }, true);
  }

  async function init() {
    setupVideoControls();

    if (isPostPage()) {
      setupDirectPostPage();
      return;
    }

    await loadHistory();
    await loadWidth();
    await loadPanelHeight();
    await loadPosition();
    await loadRedirect();
    await loadScoreSort();
    await loadFlairBlocklist();
    buildPanel();
    buildTab();

    if (panelPosition === 'bottom') {
      panel.classList.add('rr-bottom');
      tab.classList.add('rr-bottom');
      applyHeight();
    }

    interceptPostClicks();
    applyReadStateToListing();
    reorderListing();
    hideSidebar();
    injectExpandoButtons();
    applyFlairFilter();
    watchForNewThings();

    chrome.storage.local.get(PIN_KEY, data => {
      if (data[PIN_KEY]) {
        openPanel();
        showHistoryView();
      }
    });
  }

  init();
})();

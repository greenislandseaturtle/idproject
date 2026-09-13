/* 共用：API 呼叫、登入狀態、頁首頁尾、工具函式 */
(function (global) {
  'use strict';

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function fmtDate(s) { return s ? String(s).replace(/-/g, '/') : ''; }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function pct(score) { return score == null ? '--' : Math.round(Number(score) * 100) + '%'; }
  function sideZh(side) { return side === 'left' ? '左側' : side === 'right' ? '右側' : ''; }

  let toastTimer = null;
  function toast(msg, isError) {
    let t = $('#toast');
    if (!t) { t = el('<div id="toast" class="toast"></div>'); document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, isError ? 5000 : 3000);
  }

  const ERRORS = {
    unauthorized: '登入已失效，請重新登入', forbidden: '沒有權限執行此操作', rate_limited: '操作太頻繁，請稍後再試',
    invalid_input: '資料未填完整或格式錯誤', invalid_photo_count: '照片數量不符', invalid_photo: '照片格式錯誤',
    unsupported_format: '不支援的照片格式', invalid_side: '每張照片都要標左／右側', file_too_large: '照片超過 10MB',
    invalid_group_count: '個體分組數量不符', invalid_group: '有個體分組沒有照片', captcha_failed: '人機驗證未通過，請重試',
    compare_failed: '比對服務暫時無法使用，請稍後再試', not_found: '找不到紀錄', invalid_status: '目前狀態不允許此操作',
    invalid_individual: '編號格式錯誤（英數字、底線、連字號，2 到 30 字）', internal_error: '伺服器發生錯誤', network: '網路錯誤，請稍後再試'
  };
  function errMsg(code) { return ERRORS[code] || code || '未知錯誤'; }

  // ---------- 佔位圖（紙雕海龜） ----------
  const PH_COLORS = [['#2B5CA8', '#3F7BC8', '#6AA1DE', '#CBE2F7'], ['#1D3F7A', '#2B5CA8', '#3F7BC8', '#9CC5EE'], ['#3F7BC8', '#6AA1DE', '#9CC5EE', '#EEF5FC']];
  function placeholderSvg(seed, w, h) {
    const c = PH_COLORS[Math.abs(hash(String(seed))) % PH_COLORS.length];
    const rot = (Math.abs(hash(String(seed) + 'r')) % 50) - 25;
    w = w || 262; h = h || 156;
    const cx = w / 2, cy = h * 0.42, s = Math.min(w, h) / 156;
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid slice" fill="none" style="background:' + c[0] + '">' +
      '<path class="cut" d="M0 ' + (h * 0.64) + ' C' + (w * 0.2) + ' ' + (h * 0.5) + ' ' + (w * 0.35) + ' ' + (h * 0.83) + ' ' + (w * 0.53) + ' ' + (h * 0.7) + ' C' + (w * 0.73) + ' ' + (h * 0.58) + ' ' + (w * 0.88) + ' ' + (h * 0.77) + ' ' + w + ' ' + (h * 0.62) + ' V' + h + ' H0 Z" fill="' + c[1] + '"></path>' +
      '<path class="cut" d="M0 ' + (h * 0.81) + ' C' + (w * 0.23) + ' ' + (h * 0.7) + ' ' + (w * 0.38) + ' ' + (h * 0.96) + ' ' + (w * 0.61) + ' ' + (h * 0.85) + ' C' + (w * 0.8) + ' ' + (h * 0.76) + ' ' + (w * 0.92) + ' ' + (h * 0.9) + ' ' + w + ' ' + (h * 0.82) + ' V' + h + ' H0 Z" fill="' + c[2] + '"></path>' +
      '<g class="cut" transform="translate(' + cx + ' ' + cy + ') rotate(' + rot + ') scale(' + s + ')" fill="' + c[3] + '"><ellipse cx="0" cy="0" rx="24" ry="18"></ellipse><circle cx="28" cy="-5" r="7"></circle><path d="M-15 -13 C-28 -28 -37 -24 -31 -9 Z"></path><path d="M-15 13 C-28 28 -37 24 -31 9 Z"></path><path d="M13 -17 C17 -31 28 -31 24 -18 Z"></path><path d="M13 17 C17 31 28 31 24 18 Z"></path></g>' +
      '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + (12 * s) + '" ry="' + (9 * s) + '" transform="rotate(' + rot + ' ' + cx + ' ' + cy + ')" fill="' + c[2] + '"></ellipse></svg>';
  }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  /** 圖片容器：有 src 顯示圖片（載入失敗退回佔位圖），無 src 顯示佔位圖 */
  function imgBox(src, seed, cls, style) {
    const box = el('<div class="ph ' + (cls || '') + '" style="' + (style || '') + '">' + placeholderSvg(seed) + '</div>');
    if (src) {
      const img = document.createElement('img');
      img.loading = 'lazy'; img.alt = '';
      img.onerror = function () { img.remove(); };
      img.src = src;
      box.appendChild(img);
    }
    return box;
  }

  // ---------- API ----------
  async function api(action, payload) {
    if (!APP_CONFIG.APPS_SCRIPT_URL) throw new Error('not_configured');
    const body = Object.assign({ action: action }, payload || {});
    if (action.indexOf('public_') !== 0) {
      const a = Auth.current();
      if (!a) throw new Error('unauthorized');
      body.idToken = a.token;
    }
    let resp;
    try {
      resp = await fetch(APP_CONFIG.APPS_SCRIPT_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
      });
    } catch (e) { throw new Error('network'); }
    let data;
    try { data = await resp.json(); } catch (e) { throw new Error('internal_error'); }
    if (!data.ok) {
      if (data.error === 'unauthorized') Auth.clear();
      throw new Error(data.error || 'internal_error');
    }
    return data.data;
  }

  // ---------- 登入（Google Identity Services + localStorage） ----------
  const Auth = (function () {
    const KEY = 'turtle_v2_auth';
    const BUFFER = 60;
    function parseJwt(token) {
      try {
        const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(atob(b).split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')));
      } catch (e) { return null; }
    }
    function save(token, extra) {
      const p = parseJwt(token);
      if (!p || !p.exp || p.email_verified !== true) return null;
      const d = Object.assign({ token: token, exp: p.exp, email: p.email || '', name: p.name || p.email || '', researcher: false }, extra || {});
      try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { }
      return d;
    }
    function current() {
      let raw; try { raw = localStorage.getItem(KEY); } catch (e) { return null; }
      if (!raw) return null;
      let d; try { d = JSON.parse(raw); } catch (e) { return null; }
      if (!d || !d.token || !d.exp) return null;
      if (d.exp - BUFFER <= Math.floor(Date.now() / 1000)) { clear(); return null; }
      return d;
    }
    function update(patch) { const d = current(); if (!d) return; Object.assign(d, patch); try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { } }
    function clear() { try { localStorage.removeItem(KEY); } catch (e) { } }
    return { parseJwt: parseJwt, save: save, current: current, update: update, clear: clear };
  })();

  let gisReady = null;
  function loadGis() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (resolve, reject) {
      if (!APP_CONFIG.GOOGLE_CLIENT_ID) { reject(new Error('not_configured')); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
      s.onload = function () { resolve(global.google); };
      s.onerror = function () { reject(new Error('network')); };
      document.head.appendChild(s);
    });
    return gisReady;
  }
  /** 開啟登入視窗，成功後 resolve 使用者資料（含 researcher 旗標） */
  function login() {
    return new Promise(function (resolve, reject) {
      const bg = el('<div class="modal-bg"><div class="modal small paper">' +
        '<div class="modal-head"><div class="mtitle">登入</div><div class="close" title="關閉">' + iconX() + '</div></div>' +
        '<div class="modal-body"><div style="font-size:14px;color:var(--muted);line-height:1.7">使用 Google 帳號登入後，可保留回報紀錄、選擇候選個體、設定是否公開。</div>' +
        '<div id="gsiBtn" style="display:flex;justify-content:center;min-height:44px"></div>' +
        '<div style="font-size:12px;color:var(--muted)">若在 LINE、Facebook 等 App 內建瀏覽器無法登入，請改用外部瀏覽器（Chrome、Safari）開啟本頁。</div></div></div></div>');
      document.body.appendChild(bg);
      const closeFn = function () { bg.remove(); reject(new Error('cancelled')); };
      $('.close', bg).addEventListener('click', closeFn);
      bg.addEventListener('click', function (e) { if (e.target === bg) closeFn(); });
      loadGis().then(function (google) {
        google.accounts.id.initialize({
          client_id: APP_CONFIG.GOOGLE_CLIENT_ID, auto_select: false, ux_mode: 'popup',
          callback: async function (resp) {
            if (!resp || !resp.credential) { toast('登入失敗', true); return; }
            const d = Auth.save(resp.credential);
            if (!d) { toast('Email 未驗證', true); return; }
            try {
              const me = await api('user_whoami');
              Auth.update({ researcher: !!me.researcher, name: me.name || d.name });
            } catch (e) { /* 旗標查不到就當一般使用者 */ }
            bg.remove();
            resolve(Auth.current());
          }
        });
        google.accounts.id.renderButton($('#gsiBtn', bg), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', locale: 'zh-TW', width: 280 });
      }).catch(function (err) {
        $('#gsiBtn', bg).innerHTML = '<div style="color:var(--coral);font-size:13px">' + (err.message === 'not_configured' ? '尚未設定 Google 登入' : '無法載入 Google 登入') + '</div>';
      });
    });
  }
  function logout() {
    Auth.clear();
    if (global.google && global.google.accounts) { try { global.google.accounts.id.disableAutoSelect(); } catch (e) { } }
    location.href = 'index.html';
  }
  /** 需要登入的頁面：沒登入就開登入視窗，取消則導回首頁 */
  async function requireLogin(opts) {
    let a = Auth.current();
    if (a) return a;
    try { a = await login(); } catch (e) { location.href = 'index.html'; throw e; }
    if (opts && opts.researcher && !a.researcher) { toast('此頁僅限研究員', true); location.href = 'index.html'; throw new Error('forbidden'); }
    return a;
  }

  // ---------- 頁首／頁尾 ----------
  function iconX() { return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5B7395" stroke-width="2.4" stroke-linecap="round"><path d="M6 6 L18 18"></path><path d="M18 6 L6 18"></path></svg>'; }
  function headerWaves() {
    return '<svg class="waves" viewBox="0 0 1280 230" preserveAspectRatio="none" fill="none">' +
      '<path class="cut" d="M0 0 H820 C760 62 786 128 700 160 C612 194 520 176 452 230 H0 Z" fill="#1D3F7A"></path>' +
      '<path class="cut" d="M0 0 H730 C676 52 700 112 622 142 C542 174 462 166 400 230 H0 Z" fill="#2B5CA8"></path>' +
      '<path class="cut" d="M0 0 H640 C596 46 618 100 546 128 C472 158 404 156 348 230 H0 Z" fill="#3F7BC8"></path>' +
      '<path class="cut" d="M0 0 H550 C516 40 534 88 470 114 C404 142 348 146 298 230 H0 Z" fill="#6AA1DE"></path>' +
      '<path class="cut" d="M0 0 H455 C432 34 446 76 392 100 C334 126 282 134 244 230 H0 Z" fill="#9CC5EE"></path>' +
      '<circle cx="600" cy="52" r="9" stroke="#CBE2F7" stroke-width="2" opacity="0.7"></circle><circle cx="628" cy="84" r="5" stroke="#CBE2F7" stroke-width="2" opacity="0.6"></circle>' +
      '<circle cx="512" cy="150" r="6" stroke="#EEF5FC" stroke-width="2" opacity="0.7"></circle><circle cx="700" cy="120" r="4" stroke="#CBE2F7" stroke-width="2" opacity="0.6"></circle>' +
      '<g class="cut" transform="translate(560 96) rotate(-18)" fill="#CBE2F7"><ellipse cx="0" cy="0" rx="26" ry="20"></ellipse><circle cx="30" cy="-6" r="8"></circle><path d="M-16 -14 C-30 -30 -40 -26 -34 -10 Z"></path><path d="M-16 14 C-30 30 -40 26 -34 10 Z"></path><path d="M14 -18 C18 -34 30 -34 26 -20 Z"></path><path d="M14 18 C18 34 30 34 26 20 Z"></path><path d="M-26 0 C-36 -4 -38 4 -28 4 Z"></path></g>' +
      '<g transform="translate(560 96) rotate(-18)" fill="#6AA1DE"><ellipse cx="0" cy="0" rx="14" ry="10"></ellipse></g></svg>';
  }
  function footerWaves() {
    return '<svg viewBox="0 0 1280 90" preserveAspectRatio="none" fill="none"><path d="M0 40 C160 10 300 70 480 44 C660 18 820 74 1000 46 C1120 28 1200 40 1280 30 V90 H0 Z" fill="#9CC5EE"></path><path d="M0 64 C180 40 320 88 500 66 C680 44 840 92 1020 68 C1140 52 1210 64 1280 56 V90 H0 Z" fill="#6AA1DE"></path></svg>';
  }
  /**
   * 頁首：opts = { active, title, sub(html), researcher(bool: 研究員版頁首) }
   * 一般：個體總覽／上傳照片比對／我的紀錄(登入後)；研究員：儀表板／模型資料庫／上傳照片比對／個體總覽
   */
  function renderHeader(opts) {
    const a = Auth.current();
    const isResearcherPage = !!opts.researcher;
    const tabs = isResearcherPage
      ? [['admin.html', '儀表板'], ['database.html', '綠島海龜模型資料庫'], ['upload.html', '上傳照片比對'], ['index.html', '個體總覽']]
      : [['index.html', '個體總覽'], ['upload.html', '上傳照片比對']].concat(a ? [['records.html', '我的紀錄']] : []).concat(a && a.researcher ? [['admin.html', '儀表板']] : []);
    const nav = tabs.map(function (t) { return '<a href="' + t[0] + '" class="' + (t[1] === opts.active ? 'active' : '') + '">' + esc(t[1]) + '</a>'; }).join('');
    const userHtml = a
      ? '<div class="user-chip" id="userChip" title="登出"><div class="avatar ' + (a.researcher ? 'researcher' : '') + '">' + esc((a.researcher ? '研' : (a.name || '?').charAt(0))) + '</div><div class="name">' + esc((a.researcher ? '研究員・' : '') + a.name) + '</div></div>'
      : '<button class="btn btn-ghost btn-sm" id="loginBtn" style="min-height:40px;padding:9px 22px">登入</button>';
    const header = el('<header class="site-header">' + headerWaves() +
      '<div class="brand"><div class="brand-title">海龜個體辨識系統' + (isResearcherPage ? '<span class="role-badge">研究員</span>' : '') + '</div><div class="brand-sub">' + (isResearcherPage ? '綠島（調查）· GREEN ISLAND' : '綠島 · GREEN ISLAND') + '</div></div>' +
      '<div class="topnav"><nav class="tabs">' + nav + '</nav>' + userHtml + '</div>' +
      '<div class="page-title"><h1>' + esc(opts.title) + '</h1><div class="sub" id="pageSub">' + (opts.sub || '') + '</div></div></header>');
    document.body.insertBefore(header, document.body.firstChild);
    const footer = el('<div class="site-footer">' + footerWaves() + '</div>');
    document.body.appendChild(footer);
    const lb = $('#loginBtn', header);
    if (lb) lb.addEventListener('click', function () { login().then(function () { location.reload(); }).catch(function () { }); });
    const uc = $('#userChip', header);
    if (uc) uc.addEventListener('click', function () { if (confirm('要登出嗎？')) logout(); });
  }

  // ---------- Modal ----------
  function openModal(titleHtml, bodyEl, opts) {
    const bg = el('<div class="modal-bg"><div class="modal ' + ((opts && opts.small) ? 'small' : '') + '">' +
      '<div class="modal-head"><svg class="wave" viewBox="0 0 860 86" preserveAspectRatio="none" fill="none"><path d="M0 70 C120 52 220 88 360 70 C500 52 600 90 740 72 C800 64 830 70 860 62 V86 H0 Z" fill="#CBE2F7"></path></svg>' +
      '<div class="mtitle">' + titleHtml + '</div><div class="close" title="關閉">' + iconX() + '</div></div><div class="modal-body"></div></div></div>');
    $('.modal-body', bg).appendChild(bodyEl);
    const close = function () { bg.remove(); document.removeEventListener('keydown', onKey); if (opts && opts.onClose) opts.onClose(); };
    const onKey = function (e) { if (e.key === 'Escape') close(); };
    $('.close', bg).addEventListener('click', close);
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    return { el: bg, close: close };
  }
  function lightbox(src) {
    if (!src) return;
    const lb = el('<div class="lightbox"><img src="' + esc(src) + '" alt=""></div>');
    lb.addEventListener('click', function () { lb.remove(); });
    document.body.appendChild(lb);
  }
  function confirmDialog(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      const body = el('<div style="display:flex;flex-direction:column;gap:18px"><div style="font-size:14px;line-height:1.7;color:var(--ink)">' + message + '</div>' +
        '<div style="display:flex;gap:12px;justify-content:flex-end"><button class="btn btn-ghost" id="cNo">取消</button><button class="btn ' + (danger ? 'btn-coral' : 'btn-primary') + '" id="cOk">' + esc(okLabel || '確定') + '</button></div></div>');
      const m = openModal(esc(title), body, { small: true, onClose: function () { resolve(false); } });
      $('#cNo', body).addEventListener('click', function () { m.close(); });
      $('#cOk', body).addEventListener('click', function () { resolve(true); m.el.remove(); });
    });
  }

  // ---------- 照片壓縮 / base64 ----------
  const MAX_EDGE = 2000, QUALITY = 0.78, SKIP_BYTES = 1024 * 1024;
  async function compressPhoto(file) {
    try {
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
      const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.type === 'image/jpeg' && file.size <= SKIP_BYTES) { bmp.close(); return file; }
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', QUALITY); });
      if (!blob || blob.size >= file.size) return file;
      return blob;
    } catch (e) { return file; }
  }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { const s = r.result; const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  async function preparePhoto(p) {
    const c = await compressPhoto(p.file);
    const original = c === p.file;
    return { filename: original ? p.file.name : p.file.name.replace(/\.[^.]+$/, '') + '.jpg', mime: original ? p.file.type : 'image/jpeg', side: p.side, dataBase64: await toBase64(c) };
  }

  // ---------- 表單共用：地點／物種 chip 群（含「其他」自填） ----------
  function chipSelect(container, options, opts) {
    const state = { value: opts && opts.value || options[0], custom: '' };
    const other = (opts && opts.other) || '其他';
    const list = options.concat(opts && opts.allowOther ? [other] : []);
    function render() {
      container.innerHTML = '';
      const chips = el('<div class="chips"></div>');
      list.forEach(function (o) {
        const c = el('<div class="chip ' + (state.value === o ? 'chip-on' : 'chip-off') + '" style="padding:9px 22px;font-size:14px;min-height:40px">' + esc(o) + '</div>');
        c.addEventListener('click', function () { state.value = o; render(); if (opts && opts.onChange) opts.onChange(state); });
        chips.appendChild(c);
      });
      container.appendChild(chips);
      if (state.value === other) {
        const inp = el('<input class="input" style="margin-top:10px" maxlength="' + ((opts && opts.maxLength) || 30) + '" placeholder="' + esc((opts && opts.placeholder) || '請輸入') + '">');
        inp.value = state.custom;
        inp.addEventListener('input', function () { state.custom = inp.value; });
        container.appendChild(inp);
        inp.focus();
      }
    }
    render();
    return {
      get: function () { return { value: state.value, custom: state.custom.trim(), resolved: state.value === other ? state.custom.trim() : state.value }; },
      set: function (v) { state.value = v; render(); }
    };
  }

  global.T = { esc: esc, $: $, $$: $$, el: el, fmtDate: fmtDate, fmtDateTime: fmtDateTime, pct: pct, sideZh: sideZh, toast: toast, errMsg: errMsg,
    placeholderSvg: placeholderSvg, imgBox: imgBox, api: api, Auth: Auth, login: login, logout: logout, requireLogin: requireLogin,
    renderHeader: renderHeader, openModal: openModal, lightbox: lightbox, confirmDialog: confirmDialog, iconX: iconX,
    compressPhoto: compressPhoto, toBase64: toBase64, preparePhoto: preparePhoto, chipSelect: chipSelect };
})(window);

/* 上傳比對：表單 → 側別與分組 → 比對（未登入同步／登入後台輪詢）→ 結果與「是它！」 */
(function () {
  'use strict';
  const { $, $$, el, esc, api, toast, errMsg, imgBox, Auth, login, preparePhoto, chipSelect, fmtDate, pct, sideZh, openModal, lightbox } = T;
  const auth = Auth.current();
  T.renderHeader({ active: '上傳照片比對', title: '上傳照片比對', sub: '', researcher: !!(auth && auth.researcher) });

  const ALLOWED = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];
  const MAX_BYTES = 10 * 1024 * 1024;
  let cfg = { locations: ['石朗', '大白沙', '柴口', '公館', '溫泉'], species: ['綠蠵龜', '玳瑁', '無法判斷'], other: '其他', maxPhotos: 12, maxPhotosAnon: 6, maxGroups: 6, turnstile: false };
  const photos = [];          // {file, url, side, group}
  let groups = [];            // [{id, active}]
  let nextGroupId = 1;
  let selecting = null;       // 選擇模式中的 group id
  let form = { date: '', location: '', species: '', isPublic: false };
  let locSel, spSel;
  let turnstileWidget = null;

  // ---------- 步驟 1 ----------
  if (auth) { $('#anonNote').classList.add('hidden'); if (!auth.researcher) $('#publicField').style.display = ''; }
  $('#noteLogin').addEventListener('click', function (e) { e.preventDefault(); login().then(function () { location.reload(); }).catch(function () { }); });
  $('#sightingDate').max = new Date().toISOString().slice(0, 10);
  locSel = chipSelect($('#locationSel'), cfg.locations, { allowOther: true, placeholder: '請輸入地點名稱', maxLength: 30 });
  spSel = chipSelect($('#speciesSel'), cfg.species, { allowOther: true, placeholder: '請輸入物種名稱', maxLength: 20 });

  const dz = $('#dropzone'), fi = $('#fileInput');
  dz.addEventListener('click', function () { fi.click(); });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
  dz.addEventListener('drop', function (e) { e.preventDefault(); dz.classList.remove('drag'); addFiles(e.dataTransfer.files); });
  fi.addEventListener('change', function () { addFiles(fi.files); fi.value = ''; });
  $('#addMore').addEventListener('click', function () { fi.click(); });

  function maxPhotos() { return auth ? cfg.maxPhotos : cfg.maxPhotosAnon; }
  function addFiles(list) {
    Array.prototype.forEach.call(list || [], function (f) {
      if (photos.length >= maxPhotos()) { toast('最多 ' + maxPhotos() + ' 張照片', true); return; }
      if (ALLOWED.indexOf(f.type) === -1) { toast('不支援的格式：' + f.name, true); return; }
      if (f.size > MAX_BYTES) { toast(f.name + ' 超過 10MB', true); return; }
      const p = { file: f, url: URL.createObjectURL(f), side: null, group: null };
      if (f.type === 'image/heic' || f.type === 'image/heif') p.url = '';
      photos.push(p);
    });
    $('#toGrouping').disabled = photos.length === 0;
    $('#maxPhotos').textContent = maxPhotos();
    if (!$('#stepGroup').classList.contains('hidden')) renderPhotos();
    else if (photos.length) toast('已加入 ' + photos.length + ' 張照片');
  }

  $('#toGrouping').addEventListener('click', function () {
    const date = $('#sightingDate').value;
    const loc = locSel.get(), sp = spSel.get();
    if (!date) { toast('請選擇目擊日期', true); return; }
    if (!loc.resolved) { toast('請選擇或輸入目擊地點', true); return; }
    if (!sp.resolved) { toast('請選擇或輸入物種', true); return; }
    if (!photos.length) { toast('請至少上傳一張照片', true); return; }
    form = { date: date, location: loc, species: sp, isPublic: $('#isPublic').checked };
    $('#pageSub').innerHTML = '<span>目擊日期：<span class="num">' + esc(fmtDate(date)) + '</span></span><span class="dot">・</span><span>目擊地點：' + esc(loc.resolved) + '</span><span class="dot">・</span><span>物種：' + esc(sp.resolved) + '</span>';
    $('#stepForm').classList.add('hidden'); $('#stepGroup').classList.remove('hidden');
    renderPhotos(); renderGroups();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#backToForm').addEventListener('click', function () { $('#stepGroup').classList.add('hidden'); $('#stepForm').classList.remove('hidden'); });

  // ---------- 步驟 2 ----------
  function groupIndex(gid) { return groups.findIndex(function (g) { return g.id === gid; }); }
  function renderPhotos() {
    $('#photoCount').textContent = photos.length;
    const grid = $('#photoGrid'); grid.innerHTML = '';
    photos.forEach(function (p, i) {
      const gi = p.group ? groupIndex(p.group) : -1;
      const item = el('<div class="photo-item ' + (selecting ? 'selectable' : '') + ' ' + (p.group === selecting && selecting ? 'selected' : '') + '">' +
        '<div class="pimg">' + (p.url ? '<img src="' + esc(p.url) + '" alt="">' : T.placeholderSvg(p.file.name)) +
        (gi >= 0 ? '<div class="badge ' + (gi === 0 ? 'g1' : '') + '">個體 <span class="num">' + (gi + 1) + '</span></div>' : '') +
        '<div class="remove" title="移除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B7395" stroke-width="2.6" stroke-linecap="round"><path d="M6 6 L18 18"></path><path d="M18 6 L6 18"></path></svg></div></div>' +
        '<div class="fname num">' + esc(p.file.name) + (!p.url ? '（HEIC 無法預覽，仍可比對）' : '') + '</div>' +
        '<div style="display:flex;gap:8px"><div class="chip ' + (p.side === 'left' ? 'chip-on' : 'chip-off') + '" data-side="left" style="padding:4px 16px;font-size:12px;min-height:28px">左</div><div class="chip ' + (p.side === 'right' ? 'chip-on' : 'chip-off') + '" data-side="right" style="padding:4px 16px;font-size:12px;min-height:28px">右</div></div></div>');
      $$('.chip', item).forEach(function (c) { c.addEventListener('click', function (e) { e.stopPropagation(); p.side = c.dataset.side; renderPhotos(); }); });
      $('.remove', item).addEventListener('click', function (e) { e.stopPropagation(); photos.splice(i, 1); pruneGroups(); renderPhotos(); renderGroups(); });
      item.addEventListener('click', function () {
        if (!selecting) return;
        p.group = p.group === selecting ? null : selecting;
        renderPhotos(); renderGroups();
      });
      grid.appendChild(item);
    });
  }
  function pruneGroups() { groups.forEach(function (g) { g.count = photos.filter(function (p) { return p.group === g.id; }).length; }); }
  function renderGroups() {
    const list = $('#groupList'); list.innerHTML = '';
    groups.forEach(function (g, gi) {
      const members = photos.filter(function (p) { return p.group === g.id; });
      const card = el('<div class="paper group-card ' + (selecting === g.id ? 'active' : '') + '"><div style="display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-size:14px;font-weight:700;color:var(--navy)">個體 <span class="num">' + (gi + 1) + '</span>' + (selecting === g.id ? '<span style="color:var(--muted);font-weight:400;font-size:12px">（選擇模式中，點照片加入）</span>' : '') + '</div>' +
        '<div style="display:flex;gap:6px"><div class="plus-btn ' + (selecting === g.id ? 'on' : '') + '" title="選擇照片"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + (selecting === g.id ? '#FFF' : '#2B5CA8') + '" stroke-width="2.5" stroke-linecap="round"><path d="M12 5 V 19"></path><path d="M5 12 H 19"></path></svg></div>' +
        '<div class="plus-btn del" title="刪除分組"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B7395" stroke-width="2.6" stroke-linecap="round"><path d="M6 6 L18 18"></path><path d="M18 6 L6 18"></path></svg></div></div></div>' +
        '<div class="gthumbs"></div></div>');
      const th = $('.gthumbs', card);
      if (!members.length) th.innerHTML = '<div style="font-size:12px;color:var(--muted)">尚未加入照片</div>';
      members.forEach(function (p) {
        const t = el('<div style="display:flex;flex-direction:column;gap:3px;align-items:center"><div class="gthumb">' + (p.url ? '<img src="' + esc(p.url) + '">' : '') + '</div><div style="font-size:10px;color:var(--muted)">' + (p.side ? (p.side === 'left' ? '左' : '右') : '未標側') + '・<span class="num">' + esc(p.file.name.replace(/\.[^.]+$/, '').slice(0, 10)) + '</span></div></div>');
        th.appendChild(t);
      });
      $('.plus-btn:not(.del)', card).addEventListener('click', function () { selecting = selecting === g.id ? null : g.id; renderPhotos(); renderGroups(); });
      $('.plus-btn.del', card).addEventListener('click', function () {
        photos.forEach(function (p) { if (p.group === g.id) p.group = null; });
        groups.splice(gi, 1); if (selecting === g.id) selecting = null;
        renderPhotos(); renderGroups();
      });
      list.appendChild(card);
    });
  }
  $('#addGroup').addEventListener('click', function () {
    if (groups.length >= cfg.maxGroups) { toast('最多 ' + cfg.maxGroups + ' 個個體分組', true); return; }
    const g = { id: nextGroupId++ }; groups.push(g); selecting = g.id; renderPhotos(); renderGroups();
  });

  /** 組出送後端的 groups：有分組者一組；未分組每張自成一組 */
  function buildGroups() {
    const out = [];
    groups.forEach(function (g) {
      const m = photos.filter(function (p) { return p.group === g.id; });
      if (m.length) out.push(m);
    });
    photos.filter(function (p) { return !p.group || groupIndex(p.group) === -1; }).forEach(function (p) { out.push([p]); });
    return out;
  }

  // ---------- 步驟 3：比對 ----------
  $('#startCompare').addEventListener('click', async function () {
    if (photos.some(function (p) { return !p.side; })) { toast('每張照片都要標示左／右側', true); return; }
    const gs = buildGroups();
    if (gs.length > cfg.maxGroups) { toast('個體分組（含未分組照片）最多 ' + cfg.maxGroups + ' 個', true); return; }
    const btn = this; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 準備照片…';
    try {
      const payloadGroups = [];
      for (const g of gs) payloadGroups.push({ photos: await Promise.all(g.map(preparePhoto)) });
      const base = { sightingDate: form.date, location: form.location.value, customLocation: form.location.custom, species: form.species.value, customSpecies: form.species.custom, groups: payloadGroups };
      $('#stepGroup').classList.add('hidden'); $('#stepResult').classList.remove('hidden');
      if (auth) await uploadAndPoll(base, gs);
      else await anonCompare(base, gs);
    } catch (e) {
      toast(errMsg(e.message), true);
      $('#stepResult').classList.add('hidden'); $('#stepGroup').classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = '開始比對'; }
  });

  function showWaiting(msg, sub) {
    $('#stepResult').innerHTML = '<div class="paper" style="padding:40px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center"><span class="spinner dark" style="width:32px;height:32px;border-width:4px"></span><div style="font-size:16px;font-weight:700;color:var(--navy)">' + esc(msg) + '</div><div style="font-size:13px;color:var(--muted);line-height:1.7" id="waitSub">' + (sub || '') + '</div></div>';
  }

  async function anonCompare(base, gs) {
    showWaiting('比對進行中…', '第一次比對需要喚醒辨識服務，可能需要 1 到 2 分鐘，請不要關閉頁面。');
    if (cfg.turnstile && turnstileWidget !== null && window.turnstile) base.turnstileToken = window.turnstile.getResponse(turnstileWidget) || '';
    let data;
    try { data = await api('public_compare', base); }
    catch (e) {
      if (e.message === 'compare_failed' || e.message === 'network') {
        $('#waitSub').textContent = '辨識服務喚醒中，30 秒後自動重試一次…';
        await new Promise(function (r) { setTimeout(r, 30000); });
        if (cfg.turnstile && window.turnstile && turnstileWidget !== null) { window.turnstile.reset(turnstileWidget); }
        data = await api('public_compare', base);
      } else throw e;
    }
    renderResults(data.groups.map(function (g, i) { return { index: i + 1, candidates: g.candidates, photos: gs[i], status: 'anon' }; }), { anon: true });
  }

  async function uploadAndPoll(base, gs) {
    base.isPublic = form.isPublic;
    showWaiting('照片上傳中…');
    const r = await api('user_upload', base);
    const groupIds = r.groupIds;
    showWaiting('已收到照片，比對進行中', '比對在後台進行，通常 1 到 3 分鐘完成。您可以關閉瀏覽器，稍後到「我的紀錄」查看結果並選擇個體。');
    const started = Date.now();
    while (Date.now() - started < 12 * 60 * 1000) {
      await new Promise(function (res) { setTimeout(res, 6000); });
      let st;
      try { st = await api('user_group_status', { groupIds: groupIds }); } catch (e) { continue; }
      const allDone = st.every(function (g) { return g.status && g.status !== '待比對' && g.status !== '比對中'; });
      if (allDone) {
        renderResults(st.map(function (g, i) { return { index: i + 1, groupId: g.groupId, candidates: g.candidates, photos: gs[i], status: g.status, serverPhotos: g.photos }; }), { anon: false });
        return;
      }
    }
    showWaiting('比對還在進行', '請稍後到「我的紀錄」查看結果。');
  }

  // ---------- 結果 ----------
  function renderResults(list, opts) {
    const wrap = $('#stepResult'); wrap.innerHTML = '';
    $('#pageSub').insertAdjacentHTML('afterbegin', '');
    T.$('.page-title h1').textContent = '比對結果';
    list.forEach(function (g) {
      const block = el('<div class="paper result-block"></div>');
      block.appendChild(viewer(g));
      const right = el('<div style="flex:1;display:flex;flex-direction:column;gap:14px;min-width:0"><div style="font-size:15px;font-weight:700;color:var(--navy)">候選個體<span style="color:var(--muted);font-weight:400;font-size:12px">（' + (g.photos.length > 1 ? '左右側各自比對後合併排序，同一個體取較高側分數，取前 3' : sideZh(g.photos[0].side) + '資料庫比對，相似度由高到低取 3') + '）</span></div><div class="cands" style="display:flex;flex-direction:column;gap:12px"></div><div class="actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"></div></div>');
      const cands = $('.cands', right), actions = $('.actions', right);
      if (g.status === '比對失敗') cands.innerHTML = '<div class="empty">比對失敗，研究員可在儀表板重新比對</div>';
      else if (!g.candidates.length) cands.innerHTML = '<div class="empty">資料庫中沒有同物種同側的照片可比對，此為新個體或尚無資料</div>';
      g.candidates.forEach(function (c, ci) {
        const row = el('<div class="cand ' + (ci === 0 ? 'top' : '') + '"><div class="cinfo"><div class="cid"><span class="num">' + esc(c.id) + '</span>' + (c.nickname ? '（' + esc(c.nickname) + '）' : '') + '</div><div class="cscore">相似度 <b class="num">' + pct(c.score) + '</b>' + (g.photos.length > 1 ? '（來自' + sideZh(c.side) + '比對）' : '') + '</div></div></div>');
        row.insertBefore(imgBox(c.thumb, c.id, 'cthumb'), row.firstChild);
        if (!opts.anon) {
          const b = el('<button class="btn ' + (ci === 0 ? 'btn-coral' : 'btn-ghost') + '">是它！</button>');
          b.addEventListener('click', function () { choose(g, c.id, row, block); });
          row.appendChild(b);
        }
        cands.appendChild(row);
      });
      if (opts.anon) {
        actions.innerHTML = '<div style="font-size:13px;color:var(--muted)">未登入之比對結果不會儲存，關閉頁面後即消失。<a href="#" class="loginLink">登入</a>後可保留紀錄並選擇「是它！」。</div>';
        $('.loginLink', actions).addEventListener('click', function (e) { e.preventDefault(); login().then(function () { location.reload(); }).catch(function () { }); });
      } else if (g.status === '待選擇') {
        const none = el('<button class="btn btn-ghost" style="color:var(--muted);font-weight:500;font-size:13px">都不是</button>');
        none.addEventListener('click', function () { choose(g, null, null, block); });
        actions.appendChild(none);
        if (auth.researcher) actions.appendChild(el('<div style="font-size:12px;color:var(--muted)">研究員選定即直接完成入庫；「都不是」可輸入新編號建立個體。</div>'));
        else actions.appendChild(el('<div style="font-size:12px;color:var(--muted)">選擇後由研究員審查確認；也可稍後到「我的紀錄」再選。</div>'));
      } else {
        actions.appendChild(el('<div class="tag tag-gray">狀態：' + esc(g.status) + '</div>'));
      }
      block.appendChild(right);
      wrap.appendChild(block);
    });
    if (!opts.anon) wrap.appendChild(el('<div style="display:flex;justify-content:center"><a class="btn btn-ghost" href="records.html">前往我的紀錄</a></div>'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function viewer(g) {
    let idx = 0;
    const box = el('<div class="viewer"><div style="display:flex;align-items:center;justify-content:space-between"><div style="font-size:15px;font-weight:700;color:var(--navy)">個體 <span class="num">' + g.index + '</span>・您上傳的照片</div><div class="num counter" style="font-size:13px;color:var(--muted);font-weight:600"></div></div>' +
      '<div style="position:relative"><div class="vimg"></div><div class="side-tag"></div><div class="nav prev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2B5CA8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6 L9 12 L15 18"></path></svg></div><div class="nav next"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2B5CA8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6 L15 12 L9 18"></path></svg></div></div>' +
      '<div class="dots"></div><div class="fname" style="font-size:11px;color:var(--muted);text-align:center"></div></div>');
    const n = g.photos.length;
    function draw() {
      const p = g.photos[idx];
      const vi = $('.vimg', box); vi.innerHTML = p.url ? '<img src="' + esc(p.url) + '" alt="">' : T.placeholderSvg(p.file.name);
      $('.side-tag', box).textContent = sideZh(p.side);
      $('.counter', box).textContent = (idx + 1) + ' / ' + n;
      $('.dots', box).innerHTML = g.photos.map(function (_, i) { return '<i class="' + (i === idx ? 'on' : '') + '"></i>'; }).join('');
      const L = g.photos.filter(function (x) { return x.side === 'left'; }).length;
      $('.fname', box).innerHTML = '<span class="num">' + esc(p.file.name) + '</span>' + (n > 1 ? '・此個體共 ' + n + ' 張（左 ' + L + '／右 ' + (n - L) + '）' : '');
      $$('.nav', box).forEach(function (x) { x.style.display = n > 1 ? '' : 'none'; });
    }
    $('.prev', box).addEventListener('click', function () { idx = (idx - 1 + n) % n; draw(); });
    $('.next', box).addEventListener('click', function () { idx = (idx + 1) % n; draw(); });
    draw();
    return box;
  }

  async function choose(g, individualId, row, block) {
    const payload = { groupId: g.groupId, individualId: individualId, none: individualId === null };
    if (auth.researcher) {
      const extra = await researcherChooseDialog(individualId);
      if (!extra) return;
      Object.assign(payload, extra);
    }
    try {
      const r = await api('user_choose', payload);
      $$('.btn', block).forEach(function (b) { b.disabled = true; });
      if (row) row.classList.add('chosen');
      const actions = $('.actions', block); actions.innerHTML = '';
      actions.appendChild(el('<div class="tag ' + (r.status === '完成' ? 'tag-green' : 'tag-orange') + '">' + (r.status === '完成' ? '已完成入庫：' + esc(r.individual) : (individualId ? '已選擇 ' + esc(individualId) + '，等待研究員審查' : '已回報「都不是」，等待研究員審查')) + '</div>'));
      toast(r.status === '完成' ? '已入庫' : '已送出，等待研究員審查');
    } catch (e) { toast(errMsg(e.message), true); }
  }
  /** 研究員：是它→選是否納入索引；都不是→輸入新編號 */
  function researcherChooseDialog(individualId) {
    return new Promise(function (resolve) {
      const body = el('<div style="display:flex;flex-direction:column;gap:16px">' +
        (individualId ? '<div style="font-size:14px">將此群組所有照片入庫至 <b class="num">' + esc(individualId) + '</b>。</div>' :
          '<div class="field"><div class="label">新個體編號 <span class="req">*</span></div><input class="input input-block" id="newId" placeholder="例如 TW00061" maxlength="30" style="text-transform:uppercase"></div><div class="field"><div class="label">暱稱（可留空）</div><input class="input input-block" id="nick" maxlength="30"></div>') +
        '<label class="checkbox-row"><input type="checkbox" id="inc" checked><span>納入比對索引（下次「更新比對資料」時生效）</span></label>' +
        '<div style="display:flex;gap:12px;justify-content:flex-end"><button class="btn btn-ghost" id="no">取消</button><button class="btn btn-primary" id="ok">確認入庫</button></div></div>');
      const m = openModal(individualId ? '確認入庫' : '建立新個體', body, { small: true, onClose: function () { resolve(null); } });
      $('#no', body).addEventListener('click', function () { m.close(); });
      $('#ok', body).addEventListener('click', function () {
        const out = { includeIndex: $('#inc', body).checked };
        if (!individualId) {
          out.newIndividualId = ($('#newId', body).value || '').trim().toUpperCase();
          out.nickname = ($('#nick', body).value || '').trim();
          if (!/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(out.newIndividualId)) { toast(errMsg('invalid_individual'), true); return; }
        }
        m.el.remove(); resolve(out);
      });
    });
  }

  // ---------- 初始化：讀設定、預熱、Turnstile ----------
  (async function init() {
    try {
      const c = await api('public_config');
      cfg = Object.assign(cfg, c);
      locSel = chipSelect($('#locationSel'), cfg.locations, { allowOther: true, other: cfg.other, placeholder: '請輸入地點名稱', maxLength: 30 });
      spSel = chipSelect($('#speciesSel'), cfg.species, { allowOther: true, other: cfg.other, placeholder: '請輸入物種名稱', maxLength: 20 });
      $('#maxPhotos').textContent = maxPhotos();
      if (!auth && cfg.turnstile && APP_CONFIG.TURNSTILE_SITE_KEY) {
        const s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true;
        s.onload = function () { turnstileWidget = window.turnstile.render('#turnstileBox', { sitekey: APP_CONFIG.TURNSTILE_SITE_KEY, theme: 'light' }); };
        document.head.appendChild(s);
      }
      api('public_warmup').catch(function () { });   // 提前喚醒辨識服務，降低 cold start 逾時
    } catch (e) {
      if (e.message === 'not_configured') toast('系統尚未設定（config.js）', true);
    }
  })();
})();

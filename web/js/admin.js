/* 研究員儀表板：統計、更新比對資料（索引同步）、待審查清單、審查視窗、重新比對 */
(function () {
  'use strict';
  const { $, $$, el, esc, api, toast, errMsg, imgBox, fmtDate, fmtDateTime, pct, sideZh, openModal, lightbox } = T;
  T.renderHeader({ active: '儀表板', title: '儀表板', sub: '', researcher: true });

  let pending = [], srcFilter = '全部', syncTimer = null;

  async function loadStats() {
    try {
      const d = await api('admin_dashboard');
      $('#sUsers').textContent = d.users; $('#sInd').textContent = d.individuals;
      $('#sPhotos').textContent = d.photos.public + d.photos.survey; $('#sPhotosP').textContent = d.photos.public; $('#sPhotosS').textContent = d.photos.survey;
      $('#sPending').textContent = d.pending.public + d.pending.survey; $('#sPendingP').textContent = d.pending.public; $('#sPendingS').textContent = d.pending.survey;
      $('#sheetLink').href = d.sheetUrl;
      renderIndex(d.index);
    } catch (e) { toast(errMsg(e.message), true); }
  }
  function renderIndex(ix) {
    const dt = fmtDateTime(ix.lastUpdatedAt);
    $('#sIndexDate').textContent = dt ? dt.split(' ')[0] : '尚未更新';
    $('#sIndexInfo').innerHTML = (dt ? '<span class="num">' + dt.split(' ')[1] + '</span>・' : '') + '索引 <span class="num">' + (ix.indexedPhotos || 0) + '</span> 張照片';
    const btn = $('#syncBtn');
    if (ix.running) {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 更新中…';
      $('#syncInfo').textContent = '已加入 ' + (ix.added || 0) + '、移除 ' + (ix.removed || 0) + (ix.remaining != null ? '、剩餘 ' + ix.remaining : '') + (ix.error ? '・' + ix.error : '');
      if (!syncTimer) syncTimer = setInterval(pollSync, 8000);
    } else {
      btn.disabled = false; btn.textContent = '更新比對資料';
      $('#syncInfo').textContent = ix.error ? '上次更新有錯誤：' + ix.error : (ix.finishedAt ? '上次更新完成：加入 ' + (ix.added || 0) + '、移除 ' + (ix.removed || 0) : '依「納入比對索引」勾選結果重建索引');
      if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    }
  }
  async function pollSync() { try { renderIndex(await api('admin_index_status')); } catch (e) { } }
  $('#syncBtn').addEventListener('click', async function () {
    try { renderIndex(await api('admin_index_sync')); toast('已開始更新比對資料，會在背景進行'); }
    catch (e) { toast(errMsg(e.message), true); }
  });

  // ---------- 依 Sheet 同步：先預覽差異，確認後套用 ----------
  const SYNC_LABEL = { move: '搬移＋改名', rename: '改名', share: '改分享權限', species: '物種改為個體清單值' };
  $('#sheetSyncBtn').addEventListener('click', function () { sheetSyncPreview(); });
  async function sheetSyncPreview() {
    const body = el('<div style="display:flex;flex-direction:column;gap:14px;font-size:13px"><div class="empty" style="padding:24px"><span class="spinner dark"></span> 正在比對 Sheet 與 Drive…</div></div>');
    const m = openModal('依 Sheet 同步（預覽）', body);
    let p;
    try { p = await api('admin_sheet_sync_preview'); }
    catch (e) { body.innerHTML = '<div class="empty">' + esc(errMsg(e.message)) + '</div>'; return; }
    const s = p.summary;
    const changes = p.items.length + s.removes + s.creates;
    const stat = function (k, v, warn) { return '<div class="paper" style="padding:10px 14px;min-width:110px"><div style="font-size:11px;color:var(--muted)">' + k + '</div><div class="num" style="font-size:22px;font-weight:700;color:' + (warn && v ? 'var(--coral)' : 'var(--navy)') + '">' + v + '</div></div>'; };
    const section = function (title, rows) { return rows ? '<div><div style="font-weight:700;color:var(--navy);margin-bottom:6px">' + title + '</div><div style="max-height:220px;overflow:auto;border:1px solid var(--blue5)">' + rows + '</div></div>' : ''; };
    const line = function (html) { return '<div style="padding:6px 10px;border-bottom:1px solid var(--blue5)">' + html + '</div>'; };
    const who = function (x) { return '第 <span class="num">' + x.row + '</span> 列・<span class="num">' + esc(x.individual || '—') + '</span>' + (x.side ? '・' + esc(x.side) : '') + (x.date ? '・<span class="num">' + esc(x.date) + '</span>' : ''); };
    body.innerHTML =
      '<div style="color:var(--muted);line-height:1.7">只處理狀態為「完成」的列；物種以「個體清單」為準。套用後會自動開始「更新比對資料」，同步「納入比對索引」與編號／側別／物種的變更。</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' + stat('搬移＋改名', s.move) + stat('改名', s.rename) + stat('改分享權限', s.share) + stat('修正物種', s.species) + stat('新建個體', s.creates) + stat('刪除列（照片不存在）', s.removes, true) + stat('錯誤（跳過）', s.errors, true) + stat('Drive 多出的照片', s.orphans, true) + '</div>' +
      section('將修正的照片', p.items.map(function (x) { return line(who(x) + '：' + x.actions.map(function (a) { return esc(SYNC_LABEL[a.type] + (a.to ? '→' + a.to : '')); }).join('、')); }).join('')) +
      section('新建個體', p.creates.map(function (c) { return line('<span class="num">' + esc(c.id) + '</span>・' + esc(c.species || '物種未填')); }).join('')) +
      section('將刪除的列（Drive 已找不到照片，內容會備份到「異動紀錄」）', p.removes.map(function (x) { return line(who(x)); }).join('')) +
      section('錯誤（這些列不會處理，請到 Sheet 修正）', p.errors.map(function (x) { return line(who(x) + '：<span style="color:var(--coral)">' + esc(x.error) + '</span>'); }).join('')) +
      section('Drive 有照片但 Sheet 沒有紀錄（僅列出，不處理）', p.orphans.map(function (o) { return line(esc(o.folder) + '/<a href="' + esc(o.url) + '" target="_blank" rel="noopener">' + esc(o.name) + '</a>'); }).join('')) +
      (changes ? '' : '<div class="empty" style="padding:16px">Sheet 與 Drive 一致，沒有需要修正的項目</div>') +
      '<div style="display:flex;gap:12px;justify-content:flex-end"><button class="btn btn-ghost" id="scancel">取消</button>' + (changes ? '<button class="btn btn-orange" id="sok">確認套用</button>' : '') + '</div>';
    $('#scancel', body).addEventListener('click', function () { m.close(); });
    if (!changes) return;
    $('#sok', body).addEventListener('click', async function () {
      const btn = $('#sok', body); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 套用中…';
      try {
        const r = await api('admin_sheet_sync_apply', { fingerprint: p.fingerprint });
        const d = r.done;
        toast('同步完成：搬移 ' + d.move + '、改名 ' + d.rename + '、權限 ' + d.share + '、物種 ' + d.species + '、刪除列 ' + d.removes + (d.failed ? '、失敗 ' + d.failed : '') + (r.remaining ? '；尚有 ' + r.remaining + ' 項未完成，請再按一次同步' : ''), !!(d.failed || r.remaining));
        m.close(); loadStats(); loadPending();
      } catch (e) {
        toast(errMsg(e.message), true);
        if (e.message === 'plan_changed') { m.close(); sheetSyncPreview(); }
        else { btn.disabled = false; btn.textContent = '確認套用'; }
      }
    });
  }

  async function loadPending() {
    try { pending = await api('admin_pending_list'); renderPending(); }
    catch (e) { toast(errMsg(e.message), true); }
  }
  function renderPending() {
    const f = $('#srcFilter'); f.innerHTML = '';
    ['全部', '民眾回報', '水下調查'].forEach(function (s) {
      const c = el('<div class="chip ' + (srcFilter === s ? 'chip-orange' : 'chip-off') + '" style="padding:5px 14px;min-height:30px;font-size:12px">' + s + '</div>');
      c.addEventListener('click', function () { srcFilter = s; renderPending(); });
      f.appendChild(c);
    });
    const list = pending.filter(function (g) { return srcFilter === '全部' || g.source === srcFilter; });
    $('#pendingTotal').textContent = pending.length;
    const box = $('#pendingList'); box.innerHTML = '';
    $('#pendingEmpty').classList.toggle('hidden', list.length > 0);
    list.forEach(function (g) {
      let desc;
      if (g.status === '比對失敗') desc = '<span style="color:var(--coral)">比對失敗，請重新比對</span>';
      else if (g.source === '水下調查') desc = '比對結果已出・調查員尚未選擇';
      else if (g.individual) desc = '民眾選擇：<span class="num">' + esc(g.individual.id) + '</span>' + (g.individual.nickname ? '（' + esc(g.individual.nickname) + '）' : '');
      else desc = g.status === '審查' ? '民眾回報「都不是」（需指定編號）' : '未選擇個體（候選待確認）';
      const row = el('<div class="row"><div class="rthumb"></div><div class="num" style="width:96px;color:var(--muted)">' + esc(fmtDate(g.date)) + '</div><div style="width:70px;font-weight:500">' + esc(g.location) + '</div><div style="width:70px;color:var(--muted)">' + esc(g.species) + '</div>' +
        '<div style="width:92px"><span class="tag ' + (g.source === '水下調查' ? 'tag-blue' : 'tag-green') + '">' + esc(g.source) + '</span></div><div style="flex:1;min-width:160px">' + desc + '<span style="color:var(--muted)">・' + g.photoCount + ' 張・' + esc(g.userName) + '</span></div>' +
        '<button class="btn btn-ghost-orange btn-xs recmp"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#B86A10" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12 A 8 8 0 1 1 17.5 6"></path><path d="M17.5 2 V 6 H 21.5"></path></svg>重新比對</button><button class="btn btn-primary btn-xs review" style="box-shadow:0 3px 0 var(--navy)">審查</button></div>');
      $('.rthumb', row).replaceWith(imgBox(g.thumb, g.groupId, 'rthumb', 'width:56px;height:40px'));
      $('.recmp', row).addEventListener('click', async function () {
        const b = this; b.disabled = true; b.innerHTML = '<span class="spinner dark"></span>';
        try { const r = await api('admin_recompare', { groupId: g.groupId }); g.candidates = r.candidates; if (g.status === '比對失敗') g.status = '待選擇'; toast('已重新比對'); renderPending(); }
        catch (e) { toast(errMsg(e.message), true); b.disabled = false; b.textContent = '重新比對'; }
      });
      $('.review', row).addEventListener('click', function () { openReview(g); });
      box.appendChild(row);
    });
  }

  async function openReview(g) {
    const body = el('<div class="empty"><span class="spinner dark"></span></div>');
    const m = openModal('審查・<span class="num">' + esc(fmtDate(g.date)) + '</span>・' + esc(g.location) + '・' + esc(g.species) + ' <span class="tag ' + (g.source === '水下調查' ? 'tag-blue' : 'tag-green') + '" style="font-size:12px">' + esc(g.source) + '</span>', body);
    let d;
    try { d = await api('admin_group_detail', { groupId: g.groupId }); } catch (e) { body.innerHTML = '<div class="empty">' + esc(errMsg(e.message)) + '</div>'; return; }
    body.className = ''; body.innerHTML = ''; body.style.cssText = 'display:flex;flex-direction:column;gap:18px';
    body.appendChild(el('<div style="font-size:13px;color:var(--muted)">上傳者：' + esc(d.userName) + '（' + esc(d.email) + '）・上傳於 ' + esc(fmtDateTime(d.uploaded)) + '・公開：' + (d.isPublic ? '是' : '否') + '</div>'));
    const ph = el('<div style="display:flex;gap:10px;flex-wrap:wrap"></div>');
    d.photos.forEach(function (p) {
      const w = el('<div style="display:flex;flex-direction:column;gap:4px;align-items:center"><div class="tag tag-blue" style="font-size:11px">' + sideZh(p.side) + '</div></div>');
      const im = imgBox(p.thumb, p.fileId, '', 'width:180px;height:126px;cursor:zoom-in'); im.addEventListener('click', function () { lightbox(p.thumb); });
      w.insertBefore(im, w.firstChild); ph.appendChild(w);
    });
    body.appendChild(ph);
    let selected = d.individual ? d.individual.id : '';
    const cands = el('<div style="display:flex;flex-direction:column;gap:10px"><div style="font-size:14px;font-weight:700;color:var(--navy)">候選個體' + (d.individual ? '（民眾已選 <span class="num">' + esc(d.individual.id) + '</span>）' : '') + '</div></div>');
    if (!d.candidates.length) cands.appendChild(el('<div class="empty" style="padding:14px">無候選（資料庫尚無同物種同側照片或比對失敗）</div>'));
    const rows = [];
    d.candidates.forEach(function (c, i) {
      const row = el('<div class="cand ' + (selected === c.id ? 'chosen' : (i === 0 ? 'top' : '')) + '" style="cursor:pointer"><div class="cinfo"><div class="cid"><span class="num">' + esc(c.id) + '</span>' + (c.nickname ? '（' + esc(c.nickname) + '）' : '') + '</div><div class="cscore">相似度 <b class="num">' + pct(c.score) + '</b>（來自' + sideZh(c.side) + '比對）</div></div><div class="tag tag-gray pick">選擇</div></div>');
      row.insertBefore(imgBox(c.thumb, c.id, 'cthumb'), row.firstChild);
      row.addEventListener('click', function () { selected = c.id; idInput.value = c.id; refresh(); });
      rows.push([row, c.id]); cands.appendChild(row);
    });
    body.appendChild(cands);
    const form = el('<div style="display:flex;flex-direction:column;gap:12px;padding-top:14px;border-top:2px solid var(--bg)"><div class="field"><div class="label">入庫編號 <span class="req">*</span> <span style="font-size:12px;color:var(--muted);font-weight:400">點上方候選帶入，或輸入既有／新編號（新編號會自動建立個體）</span></div><div style="display:flex;gap:10px;flex-wrap:wrap"><input class="input" id="rid" style="text-transform:uppercase" maxlength="30" placeholder="例如 TW00061"><input class="input" id="rnick" maxlength="30" placeholder="暱稱（新個體可填）"></div></div>' +
      '<label class="checkbox-row"><input type="checkbox" id="rinc" checked><span>納入比對索引（下次「更新比對資料」時生效）</span></label>' +
      '<div style="display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap"><button class="btn btn-ghost" id="rcancel">取消</button><button class="btn btn-primary" id="rok">確認完成入庫</button></div></div>');
    body.appendChild(form);
    const idInput = $('#rid', form); idInput.value = selected;
    idInput.addEventListener('input', function () { selected = idInput.value.trim().toUpperCase(); refresh(); });
    function refresh() { rows.forEach(function (r) { r[0].className = 'cand ' + (r[1] === selected ? 'chosen' : ''); $('.pick', r[0]).textContent = r[1] === selected ? '已選' : '選擇'; }); }
    refresh();
    $('#rcancel', form).addEventListener('click', function () { m.close(); });
    $('#rok', form).addEventListener('click', async function () {
      const id = idInput.value.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(id)) { toast(errMsg('invalid_individual'), true); return; }
      const b = this; b.disabled = true; b.innerHTML = '<span class="spinner"></span> 入庫中…';
      try {
        await api('admin_review', { groupId: g.groupId, individualId: id, includeIndex: $('#rinc', form).checked, nickname: $('#rnick', form).value.trim() });
        toast('已完成入庫：' + id); m.close(); loadPending(); loadStats();
      } catch (e) { toast(errMsg(e.message), true); b.disabled = false; b.textContent = '確認完成入庫'; }
    });
  }

  T.requireLogin({ researcher: true }).then(function () { loadStats(); loadPending(); }).catch(function () { });
})();

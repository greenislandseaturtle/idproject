/* 研究員模型資料庫：個體清單、左右側照片、納入索引切換、編輯暱稱／物種、新增其他照片、更新比對資料 */
(function () {
  'use strict';
  const { $, $$, el, esc, api, toast, errMsg, imgBox, fmtDate, fmtDateTime, sideZh, openModal, lightbox, preparePhoto, chipSelect } = T;
  T.renderHeader({ active: '綠島海龜模型資料庫', title: '綠島海龜模型資料庫', sub: '', researcher: true });

  let individuals = [], current = null, cfg = { locations: ['石朗', '大白沙', '柴口', '公館', '溫泉'], species: ['綠蠵龜', '玳瑁', '無法判斷'], other: '其他' }, syncTimer = null;

  async function loadList() {
    try { individuals = await api('admin_individuals'); renderList(); }
    catch (e) { $('#indList').innerHTML = '<div class="empty">' + esc(errMsg(e.message)) + '</div>'; }
  }
  function renderList() {
    const q = $('#search').value.trim().toUpperCase();
    const box = $('#indList'); box.innerHTML = '';
    const list = individuals.filter(function (i) { return !q || i.id.indexOf(q) !== -1 || (i.nickname || '').toUpperCase().indexOf(q) !== -1; });
    if (!list.length) { box.innerHTML = '<div class="empty">沒有個體</div>'; return; }
    list.forEach(function (i) {
      const item = el('<div class="db-item ' + (current && current.id === i.id ? 'on' : '') + '"><div class="dthumb">' + (i.thumb ? '<img src="' + esc(i.thumb) + '">' : '') + '</div><div style="flex:1;min-width:0"><div style="font-weight:700"><span class="num">' + esc(i.id) + '</span>' + (i.nickname ? '（' + esc(i.nickname) + '）' : '') + '</div><div style="font-size:11px;opacity:.8">' + esc(i.species || '物種未定') + '・左 ' + i.left + '／右 ' + i.right + '・已納入 ' + i.inIndex + '</div></div></div>');
      item.addEventListener('click', function () { openIndividual(i.id); });
      box.appendChild(item);
    });
  }
  $('#search').addEventListener('input', renderList);

  async function openIndividual(id) {
    const main = $('#main'); main.innerHTML = '<div class="paper empty"><span class="spinner dark"></span></div>';
    try {
      const d = await api('admin_individual_photos', { individualId: id });
      current = d.individual; renderList();
      main.innerHTML = '';
      const idx = individuals.findIndex(function (i) { return i.id === id; });
      const head = el('<div class="paper" style="padding:18px 22px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div style="font-size:22px;font-weight:900;color:var(--navy)"><span class="num">' + esc(d.individual.id) + '</span>' + (d.individual.nickname ? '（' + esc(d.individual.nickname) + '）' : '') + '</div><span class="tag tag-green">' + esc(d.individual.species || '物種未定') + '</span><span style="font-size:13px;color:var(--muted)">經常出沒點：' + esc(d.individual.locations.join('、') || '—') + '</span></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" id="prev" ' + (idx <= 0 ? 'disabled' : '') + '>上一個體</button><button class="btn btn-ghost btn-sm" id="edit">編輯資料</button><button class="btn btn-ghost btn-sm" id="next" ' + (idx >= individuals.length - 1 ? 'disabled' : '') + '>下一個體</button></div></div>');
      $('#prev', head).addEventListener('click', function () { openIndividual(individuals[idx - 1].id); });
      $('#next', head).addEventListener('click', function () { openIndividual(individuals[idx + 1].id); });
      $('#edit', head).addEventListener('click', function () { editDialog(d.individual); });
      main.appendChild(head);
      ['left', 'right'].forEach(function (side) {
        const arr = d.photos[side];
        const inN = arr.filter(function (p) { return p.inIndex; }).length;
        const sec = el('<div class="paper" style="padding:18px 22px;display:flex;flex-direction:column;gap:12px"><div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px"><div style="font-size:15px;font-weight:700;color:var(--navy)">' + sideZh(side) + '<span style="font-size:12px;color:var(--muted);font-weight:400">（已納入 ' + inN + '・未納入 ' + (arr.length - inN) + '）</span></div><button class="btn btn-ghost btn-sm add">新增其他照片</button></div><div class="photo-tiles"></div></div>');
        const tiles = $('.photo-tiles', sec);
        if (!arr.length) tiles.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:16px">此側尚無照片</div>';
        arr.forEach(function (p) {
          const t = el('<div class="tile"><div class="corner ' + (p.inIndex ? 'in' : 'out') + '">' + (p.inIndex ? '已納入' : '未納入') + '</div><div class="date"><span class="num">' + esc(fmtDate(p.date)) + '</span>・' + esc(p.location) + '・' + esc(p.source) + (p.isPublic ? '' : '・未公開') + '</div></div>');
          const im = imgBox(p.thumb, p.fileId, '', 'position:absolute;inset:0'); t.insertBefore(im, t.firstChild);
          t.addEventListener('click', function () { tileMenu(p, t); });
          tiles.appendChild(t);
        });
        $('.add', sec).addEventListener('click', function () { addPhotosDialog(d.individual, side); });
        main.appendChild(sec);
      });
    } catch (e) { main.innerHTML = '<div class="paper empty">' + esc(errMsg(e.message)) + '</div>'; }
  }

  function tileMenu(p, tile) {
    const body = el('<div style="display:flex;flex-direction:column;gap:14px"><div class="ph" style="height:260px"></div><div style="font-size:13px;color:var(--muted)">日期 <span class="num">' + esc(fmtDate(p.date)) + '</span>・地點 ' + esc(p.location) + '・來源 ' + esc(p.source) + '・公開：' + (p.isPublic ? '是' : '否') + '・群組 <span class="num">' + esc(p.groupId) + '</span></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ' + (p.inIndex ? 'btn-ghost' : 'btn-primary') + '" id="tog">' + (p.inIndex ? '取消納入比對索引' : '納入比對索引') + '</button><a class="btn btn-ghost" href="' + esc(p.url) + '" target="_blank" rel="noopener">在 Drive 開啟</a></div></div>');
    $('.ph', body).replaceWith(imgBox(p.thumb, p.fileId, '', 'height:260px;cursor:zoom-in'));
    $('.ph', body).addEventListener('click', function () { lightbox(p.thumb); });
    const m = openModal('照片', body, { small: true });
    $('#tog', body).addEventListener('click', async function () {
      try { const r = await api('admin_set_index', { fileId: p.fileId, include: !p.inIndex }); p.inIndex = r.inIndex; toast(p.inIndex ? '已標記納入，下次更新比對資料時生效' : '已取消納入，下次更新時移除'); m.close(); openIndividual(current.id); loadList(); }
      catch (e) { toast(errMsg(e.message), true); }
    });
  }

  function editDialog(ind) {
    const body = el('<div style="display:flex;flex-direction:column;gap:14px"><div class="field"><div class="label">暱稱</div><input class="input input-block" id="enick" maxlength="30" value="' + esc(ind.nickname) + '"></div><div class="field"><div class="label">物種</div><div id="esp"></div></div><div style="display:flex;gap:12px;justify-content:flex-end"><button class="btn btn-ghost" id="ecancel">取消</button><button class="btn btn-primary" id="eok">儲存</button></div></div>');
    const initial = cfg.species.indexOf(ind.species) !== -1 ? ind.species : (ind.species ? cfg.other : cfg.species[0]);
    const sp = chipSelect($('#esp', body), cfg.species, { allowOther: true, other: cfg.other, value: initial, placeholder: '請輸入物種名稱', maxLength: 20 });
    if (initial === cfg.other) { const inp = $('input', $('#esp', body)); if (inp) inp.value = ind.species; }
    const m = openModal('編輯 <span class="num">' + esc(ind.id) + '</span>', body, { small: true });
    $('#ecancel', body).addEventListener('click', function () { m.close(); });
    $('#eok', body).addEventListener('click', async function () {
      const inp = $('input', $('#esp', body)); const species = sp.get().value === cfg.other ? (inp ? inp.value.trim() : '') : sp.get().value;
      try { await api('admin_update_individual', { individualId: ind.id, nickname: $('#enick', body).value.trim(), species: species }); toast('已儲存'); m.close(); await loadList(); openIndividual(ind.id); }
      catch (e) { toast(errMsg(e.message), true); }
    });
  }

  function addPhotosDialog(ind, side) {
    const files = [];
    const body = el('<div style="display:flex;flex-direction:column;gap:14px"><div style="font-size:13px;color:var(--muted)">直接加入 <b class="num">' + esc(ind.id) + '</b> 的' + sideZh(side) + '照片（來源＝水下調查、公開、完成入庫，不經比對）。</div>' +
      '<div class="field"><div class="label">目擊日期 <span class="req">*</span></div><input type="date" class="input" id="adate" max="' + new Date().toISOString().slice(0, 10) + '"></div><div class="field"><div class="label">目擊地點 <span class="req">*</span></div><div id="aloc"></div></div>' +
      '<div class="field"><div class="label">照片 <span class="req">*</span></div><input type="file" id="afiles" accept="image/jpeg,image/png,image/heic,image/heif" multiple><div id="acount" style="font-size:12px;color:var(--muted)"></div></div>' +
      '<label class="checkbox-row"><input type="checkbox" id="ainc" checked><span>納入比對索引</span></label><div style="display:flex;gap:12px;justify-content:flex-end"><button class="btn btn-ghost" id="acancel">取消</button><button class="btn btn-primary" id="aok">加入</button></div></div>');
    const loc = chipSelect($('#aloc', body), cfg.locations, { allowOther: true, other: cfg.other, placeholder: '請輸入地點名稱', maxLength: 30 });
    $('#afiles', body).addEventListener('change', function () { files.length = 0; Array.prototype.forEach.call(this.files, function (f) { if (f.size <= 10 * 1024 * 1024) files.push({ file: f, side: side }); }); $('#acount', body).textContent = files.length + ' 張'; });
    const m = openModal('新增其他照片', body, { small: true });
    $('#acancel', body).addEventListener('click', function () { m.close(); });
    $('#aok', body).addEventListener('click', async function () {
      const date = $('#adate', body).value, l = loc.get();
      if (!date || !l.resolved || !files.length) { toast('請填日期、地點並選擇照片', true); return; }
      const b = this; b.disabled = true; b.innerHTML = '<span class="spinner"></span> 上傳中…';
      try {
        const photos = await Promise.all(files.map(preparePhoto));
        const r = await api('admin_add_photos', { individualId: ind.id, sightingDate: date, location: l.value, customLocation: l.custom, photos: photos, includeIndex: $('#ainc', body).checked });
        toast('已加入 ' + r.added + ' 張'); m.close(); await loadList(); openIndividual(ind.id);
      } catch (e) { toast(errMsg(e.message), true); b.disabled = false; b.textContent = '加入'; }
    });
  }

  function renderSync(ix) {
    const dt = fmtDateTime(ix.lastUpdatedAt);
    $('#syncInfo').textContent = '上次更新：' + (dt || '尚未更新') + '・目前索引 ' + (ix.indexedPhotos || 0) + ' 張照片' + (ix.running ? '・更新中（已加入 ' + (ix.added || 0) + '、移除 ' + (ix.removed || 0) + '）' : '') + (ix.error ? '・' + ix.error : '');
    $('#syncBtn').disabled = !!ix.running; $('#syncBtn').textContent = ix.running ? '更新中…' : '更新比對資料';
    if (ix.running && !syncTimer) syncTimer = setInterval(async function () { try { renderSync(await api('admin_index_status')); } catch (e) { } }, 8000);
    if (!ix.running && syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }
  $('#syncBtn').addEventListener('click', async function () {
    try { renderSync(await api('admin_index_sync')); toast('已開始更新比對資料'); } catch (e) { toast(errMsg(e.message), true); }
  });

  T.requireLogin({ researcher: true }).then(async function () {
    try { cfg = Object.assign(cfg, await api('public_config')); } catch (e) { }
    loadList();
    try { renderSync(await api('admin_index_status')); } catch (e) { }
  }).catch(function () { });
})();

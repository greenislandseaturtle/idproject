/* 我的紀錄：每個群組一張卡；待選擇者可在此選候選；公開切換；刪除紀錄 */
(function () {
  'use strict';
  const { $, $$, el, esc, api, toast, errMsg, imgBox, fmtDate, pct, sideZh, confirmDialog, lightbox } = T;
  T.renderHeader({ active: '我的紀錄', title: '我的紀錄', sub: '' });

  const STATUS_TAG = { '待比對': 'tag-gray', '比對中': 'tag-gray', '待選擇': 'tag-orange', '審查': 'tag-orange', '完成': 'tag-green', '比對失敗': 'tag-coral' };
  const STATUS_LABEL = { '待比對': '比對排隊中', '比對中': '比對中', '待選擇': '請選擇個體', '審查': '審查中', '完成': '已確認', '比對失敗': '比對失敗' };

  async function load() {
    try {
      const d = await api('user_my_records');
      $('#photoCount').textContent = d.photoCount; $('#indCount').textContent = d.individualCount;
      const list = $('#list'); list.innerHTML = '';
      $('#status').classList.toggle('hidden', d.groups.length > 0);
      $('#status').textContent = '還沒有回報紀錄';
      d.groups.forEach(function (g) { list.appendChild(card(g)); });
      if (d.groups.some(function (g) { return g.status === '待比對' || g.status === '比對中'; })) setTimeout(load, 15000);
    } catch (e) { $('#status').textContent = errMsg(e.message); }
  }

  function card(g) {
    const c = el('<div class="paper" style="padding:20px 24px;display:flex;flex-direction:column;gap:16px">' +
      '<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap"><div class="photos" style="display:flex;gap:10px;flex-wrap:wrap"></div>' +
      '<div style="flex:1;min-width:240px;display:flex;flex-direction:column;gap:8px">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="font-size:16px;font-weight:700;color:var(--navy)">個體：' + (g.individual ? '<span class="num">' + esc(g.individual.id) + '</span>' + (g.individual.nickname ? '（' + esc(g.individual.nickname) + '）' : '') : (g.status === '完成' ? '—' : '待確認')) + '</div><span class="tag ' + (STATUS_TAG[g.status] || 'tag-gray') + '">' + esc(STATUS_LABEL[g.status] || g.status) + '</span></div>' +
      '<div style="font-size:13px;color:var(--muted)">日期：<span class="num">' + esc(fmtDate(g.date)) + '</span>・地點：' + esc(g.location) + '・物種：' + esc(g.species) + '・' + g.photoCount + ' 張・' + esc(g.source) + '</div>' +
      '<div style="font-size:12px;color:var(--muted)">上傳於 ' + esc(T.fmtDateTime(g.uploaded)) + '</div>' +
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:6px"><label class="checkbox-row"><input type="checkbox" class="pub" ' + (g.isPublic ? 'checked' : '') + '><span>目擊資訊公開</span></label><button class="btn btn-ghost btn-xs del" style="color:var(--coral)">刪除紀錄</button></div>' +
      '</div></div><div class="cands"></div></div>');
    const ph = $('.photos', c);
    (g.photos || []).forEach(function (p) {
      const box = el('<div style="display:flex;flex-direction:column;gap:4px;align-items:center"><div class="tag tag-blue" style="font-size:11px">' + sideZh(p.side) + '</div></div>');
      const im = imgBox(p.thumb, p.fileId, '', 'width:150px;height:105px;cursor:zoom-in');
      im.addEventListener('click', function () { lightbox(p.thumb); });
      box.insertBefore(im, box.firstChild);
      ph.appendChild(box);
    });
    $('.pub', c).addEventListener('change', async function () {
      const cb = this;
      try { await api('user_set_public', { groupId: g.groupId, isPublic: cb.checked }); toast(cb.checked ? '已設為公開' : '已取消公開'); }
      catch (e) { cb.checked = !cb.checked; toast(errMsg(e.message), true); }
    });
    $('.del', c).addEventListener('click', async function () {
      const ok = await confirmDialog('刪除紀錄', '將刪除這筆回報的 <b>' + g.photoCount + ' 張照片</b>與所有相關資料，包含已入庫的照片。<br>此操作<b style="color:var(--coral)">無法復原</b>，確定要刪除嗎？', '確定刪除', true);
      if (!ok) return;
      try { await api('user_delete_group', { groupId: g.groupId }); toast('已刪除'); c.remove(); load(); }
      catch (e) { toast(errMsg(e.message), true); }
    });
    if (g.status === '待選擇') {
      const cs = $('.cands', c);
      cs.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding-top:14px;border-top:2px solid var(--bg)';
      cs.appendChild(el('<div style="font-size:14px;font-weight:700;color:var(--navy)">您尚未選擇個體，比對候選如下：</div>'));
      if (!g.candidates.length) cs.appendChild(el('<div class="empty">資料庫尚無可比對的同物種同側照片</div>'));
      g.candidates.forEach(function (cd, i) {
        const row = el('<div class="cand ' + (i === 0 ? 'top' : '') + '"><div class="cinfo"><div class="cid"><span class="num">' + esc(cd.id) + '</span>' + (cd.nickname ? '（' + esc(cd.nickname) + '）' : '') + '</div><div class="cscore">相似度 <b class="num">' + pct(cd.score) + '</b>' + (g.photoCount > 1 ? '（來自' + sideZh(cd.side) + '比對）' : '') + '</div></div></div>');
        row.insertBefore(imgBox(cd.thumb, cd.id, 'cthumb'), row.firstChild);
        const b = el('<button class="btn ' + (i === 0 ? 'btn-coral' : 'btn-ghost') + '">是它！</button>');
        b.addEventListener('click', function () { choose(g, cd.id); });
        row.appendChild(b); cs.appendChild(row);
      });
      const none = el('<div><button class="btn btn-ghost" style="color:var(--muted);font-weight:500;font-size:13px">都不是</button></div>');
      $('button', none).addEventListener('click', function () { choose(g, null); });
      cs.appendChild(none);
    }
    return c;
  }
  async function choose(g, id) {
    try { await api('user_choose', { groupId: g.groupId, individualId: id, none: id === null }); toast('已送出，等待研究員審查'); load(); }
    catch (e) { toast(errMsg(e.message), true); }
  }

  T.requireLogin().then(load).catch(function () { });
})();

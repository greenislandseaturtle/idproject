/* 公開總覽頁：篩選（物種／出沒點／目擊次數）＋個體詳細視窗 */
(function () {
  'use strict';
  const { $, el, esc, api, toast, errMsg, imgBox, openModal, lightbox, fmtDate } = T;
  T.renderHeader({ active: '個體總覽', title: '綠島海龜個體總覽', sub: '僅顯示已確認且公開之個體資料' });

  const state = { data: null, species: '全部', location: '全部', count: '' };
  const COUNT_OPTS = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5+', '5 次以上']];

  function chipRow(container, options, current, onPick) {
    container.innerHTML = '';
    options.forEach(function (o) {
      const val = Array.isArray(o) ? o[0] : o, label = Array.isArray(o) ? o[1] : o;
      const c = el('<div class="chip ' + (current === val ? 'chip-on' : 'chip-off') + ' ' + (/^\d/.test(label) ? 'num' : '') + '">' + esc(label) + '</div>');
      c.addEventListener('click', function () { onPick(current === val && container.id === 'fCount' ? '' : val); });
      container.appendChild(c);
    });
  }
  function renderFilters() {
    chipRow($('#fSpecies'), ['全部'].concat(state.data.species), state.species, function (v) { state.species = v; render(); });
    chipRow($('#fLocation'), ['全部'].concat(state.data.locations), state.location, function (v) { state.location = v; render(); });
    chipRow($('#fCount'), COUNT_OPTS, state.count, function (v) { state.count = v; render(); });
  }
  function matches(ind) {
    if (state.species !== '全部' && ind.species !== state.species) return false;
    if (state.location !== '全部' && ind.locations.indexOf(state.location) === -1) return false;
    if (state.count) {
      if (state.count === '5+') { if (ind.sightings < 5) return false; }
      else if (String(ind.sightings) !== state.count) return false;
    }
    return true;
  }
  function render() {
    renderFilters();
    const cards = $('#cards');
    cards.innerHTML = '';
    const list = state.data.individuals.filter(matches);
    $('#status').textContent = list.length ? '' : '沒有符合條件的個體';
    $('#status').classList.toggle('hidden', !!list.length);
    list.forEach(function (ind) {
      const card = el('<div class="paper card"><div class="body"><div class="title"><span class="num">' + esc(ind.id) + '</span>' + (ind.nickname ? '（' + esc(ind.nickname) + '）' : '') + '</div>' +
        '<div class="meta">' + esc(ind.species || '物種未定') + '・' + esc(ind.locationsRaw.join('、') || '地點未知') + '・目擊 ' + ind.sightings + ' 次</div></div></div>');
      card.insertBefore(imgBox(ind.thumb, ind.id, 'thumb', 'height:156px'), card.firstChild);
      card.addEventListener('click', function () { openDetail(ind); });
      cards.appendChild(card);
    });
  }

  async function openDetail(ind) {
    const body = el('<div class="empty"><span class="spinner dark"></span></div>');
    const title = '<span class="num">' + esc(ind.id) + '</span>' + (ind.nickname ? '（' + esc(ind.nickname) + '）' : '') +
      '<span style="display:flex;align-items:center;gap:10px;font-size:13px;font-weight:400;color:var(--muted)"><span class="chip chip-static" style="background:var(--green-bg);color:var(--green);padding:3px 12px;min-height:24px;font-size:12px;font-weight:700">' + esc(ind.species || '物種未定') + '</span>經常出沒點：' + esc(ind.locationsRaw.join('、') || '未知') + '・目擊次數：<span class="num">' + ind.sightings + '</span></span>';
    openModal(title, body);
    try {
      const d = await api('public_individual', { individualId: ind.id });
      if (!d) { body.innerHTML = '<div class="empty">此個體目前沒有公開照片</div>'; return; }
      body.className = ''; body.innerHTML = ''; body.style.cssText = 'display:flex;flex-direction:column;gap:18px';
      // 以「日期＋地點＋來源」分組成一次目擊，左右側各取第一張，其餘可點看
      const groups = {};
      ['left', 'right'].forEach(function (side) {
        d.photos[side].forEach(function (p) {
          const k = p.date + '|' + p.location + '|' + p.source;
          if (!groups[k]) groups[k] = { date: p.date, location: p.location, source: p.source, left: [], right: [] };
          groups[k][side].push(p);
        });
      });
      Object.keys(groups).sort().reverse().forEach(function (k) {
        const g = groups[k];
        const row = el('<div class="sighting"><div class="sphotos"></div><div class="sinfo"><div><span class="k">日期：</span><span class="num">' + esc(fmtDate(g.date)) + '</span></div><div><span class="k">地點：</span>' + esc(g.location) + '</div>' +
          '<div style="display:flex;align-items:center;gap:8px"><span class="k">來源：</span><span class="tag ' + (g.source === '水下調查' ? 'tag-blue' : 'tag-green') + '">' + esc(g.source) + '</span></div></div></div>');
        const sp = $('.sphotos', row);
        ['left', 'right'].forEach(function (side) {
          const arr = g[side];
          const box = el('<div class="sside"><div class="sl">' + (side === 'left' ? '左側' : '右側') + (arr.length > 1 ? '（' + arr.length + ' 張，點選看其他）' : '') + '</div></div>');
          if (!arr.length) { box.appendChild(el('<div class="none">此側無照片</div>')); }
          else {
            let idx = 0;
            const holder = el('<div></div>');
            function draw() {
              const im = imgBox(arr[idx].thumb, ind.id + side + idx, 'simg');
              im.addEventListener('click', function () {
                if (arr.length > 1) { idx = (idx + 1) % arr.length; draw(); }
                else lightbox(arr[0].thumb.replace('sz=w800', 'sz=w1600'));
              });
              holder.innerHTML = ''; holder.appendChild(im);
            }
            draw();
            box.appendChild(holder);
          }
          sp.appendChild(box);
        });
        body.appendChild(row);
      });
    } catch (e) { body.innerHTML = '<div class="empty">' + esc(errMsg(e.message)) + '</div>'; }
  }

  (async function init() {
    try {
      state.data = await api('public_overview');
      render();
    } catch (e) {
      $('#status').textContent = e.message === 'not_configured' ? '系統尚未設定（config.js）' : errMsg(e.message);
    }
  })();
})();

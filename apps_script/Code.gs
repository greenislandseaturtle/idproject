/**
 * 綠島海龜個體辨識系統 v2 — Google Apps Script 後端
 *
 * 部署步驟：
 *   1) 建立與目標 Google Sheet 連結的容器型 Apps Script 專案，貼上本檔
 *   2) 「專案設定 → 指令碼屬性」設定（敏感值不寫在程式碼裡）：
 *        CLOUD_RUN_API_KEY      Cloud Run 的 X-API-Key
 *        CLOUD_RUN_ADMIN_TOKEN  Cloud Run 索引維護端點的 X-Admin-Token
 *        GOOGLE_CLIENT_ID       前端 Google 登入的 OAuth Client ID（驗 idToken audience）
 *        TURNSTILE_SECRET       Cloudflare Turnstile secret（未設定＝略過人機驗證）
 *   3) 執行 initializeSheets() 一次（建分頁與標題、Drive 子資料夾）
 *   4) 執行 installTriggers() 一次（每分鐘 processPendingCompares）
 *   5) 部署為 Web App：執行身分「我」、存取權限「任何人」
 *
 * 所有請求走 doPost + JSON（Content-Type: text/plain 避開 CORS preflight）。
 * 路由以 body.action 分三類：public_*（免登入）、user_*（需 idToken）、admin_*（需研究員 idToken）。
 */

// ====================== 設定（公開值） ======================
const CONFIG = {
  SHEET_ID: '1zImpsCTjM8ky7CP2ZdzQJC3YapLh51nVefz1Q68Q7Yw',
  DRIVE_ROOT_ID: '1wOLoiKDGSn8siFsA_y5WrHLm9dg_a37y',
  CLOUD_RUN_URL: 'https://turtle-api-841875653967.asia-east1.run.app',
  RESEARCHER_EMAILS: ['greenislandseaturtle@tourlearning089.com'],
  MAX_FILE_SIZE_MB: 10,
  ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/heic', 'image/heif'],
  MAX_PHOTOS_PER_UPLOAD: 12,
  MAX_GROUPS_PER_UPLOAD: 6,
  MAX_PHOTOS_ANON: 6,
  RATE_LIMIT_PER_EMAIL_PER_HOUR: 6,      // 每個帳號每小時上傳批次數
  GLOBAL_UPLOAD_LIMIT_PER_HOUR: 40,      // 全站每小時上傳批次數
  GLOBAL_ANON_LIMIT_PER_HOUR: 30,        // 全站每小時未登入比對次數
  GLOBAL_READ_LIMIT_PER_HOUR: 600,       // 全站每小時公開查詢次數
  LOCATIONS: ['石朗', '大白沙', '柴口', '公館', '溫泉'],
  SPECIES: ['綠蠵龜', '玳瑁', '無法判斷'],
  OTHER: '其他',
  SHEETS: { RECORDS: '回報紀錄', INDIVIDUALS: '個體清單', AUDIT: '異動紀錄' },
  FOLDERS: { REPORTS: '回報照片', DATABASE: '資料庫' },
  OVERVIEW_CACHE_SEC: 300
};

// 「回報紀錄」欄位（A=1）。一張照片一列；Q 之後為隱藏系統欄。
const COL = {
  UPLOADED: 1,     // A 上傳時間
  STATUS: 2,       // B 狀態
  SOURCE: 3,       // C 來源（民眾回報 / 水下調查）
  USER_NAME: 4,    // D google帳號名稱
  INDIVIDUAL: 5,   // E 編號
  SIGHT_DATE: 6,   // F 目擊日期（yyyy-MM-dd）
  LOCATION: 7,     // G 地點
  SPECIES: 8,      // H 物種
  SIDE: 9,         // I 側（左 / 右）
  PUBLIC: 10,      // J 公開（TRUE/FALSE）
  INDEX: 11,       // K 納入比對索引（TRUE/FALSE）
  PHOTO_URL: 12,   // L 照片url
  CAND1: 13,       // M 候選1
  CAND2: 14,       // N 候選2
  CAND3: 15,       // O 候選3
  GROUP: 16,       // P 群組編號
  FILE_ID: 17,     // Q FileID（隱藏，主鍵）
  EMAIL: 18,       // R Email（隱藏）
  PATH: 19         // S 目前路徑（隱藏）
};
const LAST_COL = COL.PATH;

// 「個體清單」欄位
const IND = { ID: 1, NICKNAME: 2, SPECIES: 3, NOTES: 4, CREATED: 5 };

const STATUS = {
  PENDING: '待比對',
  COMPARING: '比對中',
  AWAITING: '待選擇',
  REVIEW: '審查',
  DONE: '完成',
  FAILED: '比對失敗'
};
const SOURCE = { PUBLIC: '民眾回報', SURVEY: '水下調查' };

// ====================== 共用工具 ======================
function getProp_(key) { return PropertiesService.getScriptProperties().getProperty(key); }
function setProp_(key, val) { PropertiesService.getScriptProperties().setProperty(key, val); }
function getRequiredProp_(key) {
  const v = getProp_(key);
  if (!v) throw new Error('Missing script property: ' + key);
  return v;
}
function getSheet_(name) {
  const sh = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('Sheet not found: ' + name);
  return sh;
}
function jsonResp_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResp_({ ok: true, data: data === undefined ? null : data }); }
function fail_(code) { return jsonResp_({ ok: false, error: code }); }
function logError_(label, err) { console.error(label + ': ' + (err && err.stack ? err.stack : err)); }
function tz_() { return Session.getScriptTimeZone() || 'Asia/Taipei'; }
function fmt_(d, pattern) { return Utilities.formatDate(d, tz_(), pattern); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function sanitizeInput_(str, maxLength) {
  if (str === null || str === undefined) return '';
  let s = String(str).replace(/[\x00-\x1f\x7f]/g, '').replace(/[<>]/g, '').trim();
  if (typeof maxLength === 'number' && s.length > maxLength) s = s.substring(0, maxLength);
  return s;
}
function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}
function randomToken_(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function isResearcher_(email) {
  return CONFIG.RESEARCHER_EMAILS.map(function (e) { return e.toLowerCase(); })
    .indexOf(String(email || '').toLowerCase()) !== -1;
}
/** 側別統一：sheet 存「左/右」，API 用 left/right。 */
function sideNorm_(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'left' || s === '左' || s === 'l') return 'left';
  if (s === 'right' || s === '右' || s === 'r') return 'right';
  return '';
}
function sideZh_(side) { return side === 'left' ? '左' : side === 'right' ? '右' : ''; }
function sideLR_(side) { return side === 'left' ? 'L' : 'R'; }
function normalizeIndividualId_(raw) {
  const id = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(id) ? id : '';
}
function validDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : ''; }
function validSpecies_(s) {
  const v = sanitizeInput_(s, 20);
  return v ? v : '';
}
/** 地點：五個固定選項或「其他」自填；自填時直接存自填文字。 */
function resolveLocation_(location, customLocation) {
  const loc = sanitizeInput_(location, 30);
  if (CONFIG.LOCATIONS.indexOf(loc) !== -1) return loc;
  if (loc === CONFIG.OTHER) return sanitizeInput_(customLocation, 30);
  return '';
}
function resolveSpecies_(species, customSpecies) {
  const sp = sanitizeInput_(species, 20);
  if (CONFIG.SPECIES.indexOf(sp) !== -1) return sp;
  if (sp === CONFIG.OTHER) {
    const c = sanitizeInput_(customSpecies, 20);
    return c ? c : '';
  }
  return '';
}
/** 比對用物種鍵：固定三種原樣；自填物種一律歸「其他」（其他只跟其他比）。 */
function speciesKey_(species) {
  const sp = String(species || '').trim();
  if (CONFIG.SPECIES.indexOf(sp) !== -1) return sp;
  return CONFIG.OTHER;
}

// ---------- 頻率限制（CacheService 固定小時窗口） ----------
function hourKey_(prefix, id) {
  return prefix + (id ? sha256Hex_(String(id).toLowerCase()).substring(0, 32) + '_' : '') + Math.floor(Date.now() / 3600000);
}
function checkAndBump_(key, limit) {
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { return true; }
  try {
    const cur = parseInt(cache.get(key) || '0', 10);
    if (cur >= limit) return false;
    cache.put(key, String(cur + 1), 3700);
    return true;
  } finally { lock.releaseLock(); }
}

// ---------- Drive ----------
function getOrCreateChildFolder_(parentId, name) {
  const parent = DriveApp.getFolderById(parentId);
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
/** 回報照片/{年}/{年-月}、資料庫 兩棵子樹的根 ID 快取在 Script Properties。 */
function folderId_(kind) {
  const key = 'FOLDER_' + kind;
  let id = getProp_(key);
  if (id) return id;
  id = getOrCreateChildFolder_(CONFIG.DRIVE_ROOT_ID, CONFIG.FOLDERS[kind]).getId();
  setProp_(key, id);
  return id;
}
function reportMonthFolder_(date) {
  const y = getOrCreateChildFolder_(folderId_('REPORTS'), fmt_(date, 'yyyy'));
  return getOrCreateChildFolder_(y.getId(), fmt_(date, 'yyyy-MM'));
}
function getFileParentId_(fileId) {
  try {
    const parents = DriveApp.getFileById(fileId).getParents();
    return parents.hasNext() ? parents.next().getId() : null;
  } catch (e) { return null; }
}
function moveFile_(fileId, targetFolderId) {
  const file = DriveApp.getFileById(fileId);
  file.moveTo(DriveApp.getFolderById(targetFolderId));
  return file;
}
function cleanupEmptyAncestors_(folderId, stopAtRootId) {
  let curId = folderId, safety = 6;
  while (curId && curId !== stopAtRootId && safety-- > 0) {
    let folder;
    try { folder = DriveApp.getFolderById(curId); } catch (e) { break; }
    if (folder.getFiles().hasNext() || folder.getFolders().hasNext()) break;
    const parents = folder.getParents();
    if (!parents.hasNext()) break;
    const parentId = parents.next().getId();
    try { folder.setTrashed(true); } catch (e) { break; }
    curId = parentId;
  }
}
function setFilePublic_(fileId, isPublic) {
  try {
    const f = DriveApp.getFileById(fileId);
    if (isPublic) f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    else f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
  } catch (err) { logError_('setFilePublic_ ' + fileId, err); }
}
function publicThumbUrl_(fileId, w) {
  return fileId ? 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + (w || 400) : '';
}
function fileViewUrl_(fileId) { return 'https://drive.google.com/file/d/' + fileId + '/view'; }
/** 未公開照片給本人／研究員看：回傳 data URI 縮圖（不必開分享）。 */
function inlineThumb_(fileId) {
  try {
    const blob = DriveApp.getFileById(fileId).getThumbnail();
    if (!blob) return '';
    return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (err) { return ''; }
}
function extFromMime_(mime) {
  return mime === 'image/png' ? 'png' : (mime === 'image/heic' || mime === 'image/heif') ? 'heic' : 'jpg';
}

function logAudit_(actor, groupId, field, oldVal, newVal) {
  try {
    getSheet_(CONFIG.SHEETS.AUDIT).appendRow([new Date(), actor || '', groupId || '', field, String(oldVal || ''), String(newVal || '')]);
  } catch (err) { logError_('logAudit_', err); }
}
function invalidatePublicCache_() {
  const cache = CacheService.getScriptCache();
  cache.remove('public_overview');
  cache.remove('public_individuals_ts');
  setProp_('PUBLIC_CACHE_VER', String(Date.now()));
}

// ====================== Cloud Run 客戶端（呼叫者身分） ======================
/**
 * Cloud Run 以 --no-allow-unauthenticated 部署，只接受 Google 簽發的 OIDC ID token。
 * 組織政策禁止建立服務帳戶金鑰，故不走 v1 的「SA 金鑰簽 JWT」；改用 IAM Credentials API：
 * 指令碼擁有者的 OAuth token（appsscript.json 宣告 cloud-platform scope）呼叫 generateIdToken，
 * 以服務帳戶身分取得 ID token（擁有者需有該 SA 的 roles/iam.serviceAccountTokenCreator，
 * SA 需有 Cloud Run 的 roles/run.invoker）。結果快取 50 分鐘（有效 1 小時）。
 */
const SERVICE_ACCOUNT_EMAIL = 'turtle-api-sa@greenisland-idproject.iam.gserviceaccount.com';
function getIdToken_(audience) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'idtoken_' + sha256Hex_(audience).substring(0, 40);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const resp = UrlFetchApp.fetch(
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + SERVICE_ACCOUNT_EMAIL + ':generateIdToken', {
      method: 'post', contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ audience: audience, includeEmail: true }),
      muteHttpExceptions: true
    });
  if (resp.getResponseCode() !== 200) throw new Error('generateIdToken failed: ' + resp.getResponseCode() + ' ' + resp.getContentText().substring(0, 200));
  const token = JSON.parse(resp.getContentText()).token;
  cache.put(cacheKey, token, 50 * 60);
  return token;
}
function cloudRunBase_() {
  if (!CONFIG.CLOUD_RUN_URL) throw new Error('CLOUD_RUN_URL not configured');
  return CONFIG.CLOUD_RUN_URL.replace(/\/+$/, '');
}
function cloudRunRequest_(path, options) {
  const base = cloudRunBase_();
  const headers = Object.assign({
    'Authorization': 'Bearer ' + getIdToken_(base),
    'X-API-Key': getRequiredProp_('CLOUD_RUN_API_KEY')
  }, (options && options.headers) || {});
  const params = Object.assign({ method: 'get' }, options || {}, { headers: headers, muteHttpExceptions: true });
  const resp = UrlFetchApp.fetch(base + path, params);
  return { code: resp.getResponseCode(), body: resp.getContentText() };
}
function cloudRunJson_(path, options) {
  const r = cloudRunRequest_(path, options);
  if (r.code !== 200) throw new Error(path + ' ' + r.code + ': ' + String(r.body).substring(0, 200));
  return JSON.parse(r.body);
}
function adminHeaders_() { return { 'X-Admin-Token': getRequiredProp_('CLOUD_RUN_ADMIN_TOKEN') }; }

/** 比對一張：回傳 [{individual_id, similarity}]（同側、同物種鍵；無法判斷＝不限物種）。 */
function crCompare_(blob, side, species) {
  return cloudRunJson_('/compare', {
    method: 'post', payload: { file: blob, side: side, species: speciesKey_(species) }
  }).results || [];
}
function crHealth_() {
  try {
    const base = cloudRunBase_();
    const resp = UrlFetchApp.fetch(base + '/health', {
      method: 'get', headers: { 'Authorization': 'Bearer ' + getIdToken_(base) }, muteHttpExceptions: true
    });
    return { code: resp.getResponseCode(), body: resp.getContentText() };
  } catch (err) { return { code: 0, body: String(err) }; }
}
function crManifest_() { return cloudRunJson_('/index/manifest', { method: 'get', headers: adminHeaders_() }); }
function crIndexApply_(payload) {
  return cloudRunJson_('/index/apply', {
    method: 'post', contentType: 'application/json', headers: adminHeaders_(), payload: JSON.stringify(payload)
  });
}

// ====================== 診斷（在編輯器手動執行，看執行紀錄） ======================
function diagCloudRun() {
  const out = {
    cloudRunUrl: CONFIG.CLOUD_RUN_URL || '(空白！請用最新版 Code.gs)',
    hasApiKey: !!getProp_('CLOUD_RUN_API_KEY'),
    hasAdminToken: !!getProp_('CLOUD_RUN_ADMIN_TOKEN'),
    hasClientId: !!getProp_('GOOGLE_CLIENT_ID'),
    owner: currentOwnerEmail_()
  };
  try {
    const base = cloudRunBase_();
    const resp = UrlFetchApp.fetch(
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + SERVICE_ACCOUNT_EMAIL + ':generateIdToken', {
        method: 'post', contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({ audience: base, includeEmail: true }), muteHttpExceptions: true
      });
    out.generateIdToken = resp.getResponseCode() + ' ' + (resp.getResponseCode() === 200 ? 'OK' : resp.getContentText().substring(0, 300));
    if (resp.getResponseCode() === 200) {
      const h = crHealth_();
      out.health = h.code + ' ' + String(h.body).substring(0, 200);
      const m = cloudRunRequest_('/index/manifest', { method: 'get', headers: adminHeaders_() });
      out.manifest = m.code + ' ' + String(m.body).substring(0, 100);
    }
  } catch (err) { out.error = String(err && err.message || err); }
  console.log(JSON.stringify(out, null, 2));
  return JSON.stringify(out, null, 2);
}
function currentOwnerEmail_() {
  try { return Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; }
}

// ====================== 初始化 ======================
function initializeSheets() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(CONFIG.SHEETS.RECORDS);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEETS.RECORDS);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['上傳時間', '狀態', '來源', 'google帳號名稱', '編號', '目擊日期', '地點', '物種', '側',
      '公開', '納入比對索引', '照片url', '候選1', '候選2', '候選3', '群組編號', 'FileID', 'Email', '目前路徑']);
    sh.setFrozenRows(1);
    sh.hideColumns(COL.FILE_ID, 3);
    sh.getRange(2, COL.PUBLIC, sh.getMaxRows() - 1, 2).insertCheckboxes();
  }
  sh = ss.getSheetByName(CONFIG.SHEETS.INDIVIDUALS);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEETS.INDIVIDUALS);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['編號', '暱稱', '物種', '備註', '建立時間']);
    sh.setFrozenRows(1);
  }
  sh = ss.getSheetByName(CONFIG.SHEETS.AUDIT);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEETS.AUDIT);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['時間', '操作者', '群組編號', '欄位', '舊值', '新值']);
    sh.setFrozenRows(1);
  }
  sh.hideSheet();
  const first = ss.getSheets()[0];
  if (first.getName() !== CONFIG.SHEETS.RECORDS && first.getLastRow() === 0 && ss.getSheets().length > 3) {
    ss.deleteSheet(first);
  }
  folderId_('REPORTS');
  folderId_('DATABASE');
  return 'initializeSheets OK';
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processPendingCompares') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processPendingCompares').timeBased().everyMinutes(1).create();
  return 'installTriggers OK: processPendingCompares 每 1 分鐘';
}

// ====================== 身分驗證 ======================
function verifyGoogleIdToken_(idToken) {
  if (!idToken) throw new Error('missing_id_token');
  const cache = CacheService.getScriptCache();
  const cacheKey = 'idtok_' + sha256Hex_(idToken).substring(0, 40);
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('invalid_id_token');
  const info = JSON.parse(resp.getContentText());
  if (info.aud !== getRequiredProp_('GOOGLE_CLIENT_ID')) throw new Error('wrong_audience');
  if (String(info.email_verified) !== 'true') throw new Error('email_not_verified');
  const user = { email: String(info.email || '').toLowerCase(), name: sanitizeInput_(info.name || info.email, 40) };
  const ttl = Math.min(300, Math.floor(Number(info.exp || 0) - Date.now() / 1000));
  if (ttl > 0) cache.put(cacheKey, JSON.stringify(user), ttl);
  return user;
}

/** Cloudflare Turnstile；未設定 secret 時略過（開發期）。 */
function verifyTurnstile_(token) {
  const secret = getProp_('TURNSTILE_SECRET');
  if (!secret) return true;
  if (!token) return false;
  try {
    const resp = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post', payload: { secret: secret, response: String(token) }, muteHttpExceptions: true
    });
    return resp.getResponseCode() === 200 && JSON.parse(resp.getContentText()).success === true;
  } catch (err) { logError_('turnstile', err); return false; }
}

// ====================== 路由 ======================
function doGet() { return fail_('use_post'); }

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return fail_('bad_request');
    const body = JSON.parse(e.postData.contents);
    const action = String(body.action || '');

    if (action.indexOf('public_') === 0) {
      if (!checkAndBump_(hourKey_('rl_read_'), CONFIG.GLOBAL_READ_LIMIT_PER_HOUR)) return fail_('rate_limited');
      return handlePublic_(action, body);
    }
    if (action.indexOf('user_') === 0) {
      let user;
      try { user = verifyGoogleIdToken_(body.idToken); } catch (err) { return fail_('unauthorized'); }
      return handleUser_(action, body, user);
    }
    if (action.indexOf('admin_') === 0) {
      let user;
      try { user = verifyGoogleIdToken_(body.idToken); } catch (err) { return fail_('unauthorized'); }
      if (!isResearcher_(user.email)) return fail_('forbidden');
      return handleAdmin_(action, body, user);
    }
    return fail_('unknown_action');
  } catch (err) {
    logError_('doPost', err);
    return fail_('internal_error');
  }
}

function handlePublic_(action, body) {
  try {
    switch (action) {
      case 'public_config': return ok_(publicConfig_());
      case 'public_overview': return ok_(getOverview_());
      case 'public_individual': return ok_(getIndividualPublic_(body.individualId));
      case 'public_warmup': { const h = crHealth_(); return ok_({ up: h.code === 200 }); }
      case 'public_compare': return anonCompare_(body);
      default: return fail_('unknown_action');
    }
  } catch (err) { logError_(action, err); return fail_('internal_error'); }
}

function handleUser_(action, body, user) {
  try {
    switch (action) {
      case 'user_whoami': return ok_({ email: user.email, name: user.name, researcher: isResearcher_(user.email) });
      case 'user_upload': return uploadReport_(body, user);
      case 'user_group_status': return ok_(getGroupStatus_(body.groupIds, user));
      case 'user_my_records': return ok_(getMyRecords_(user));
      case 'user_choose': return chooseCandidate_(body, user);
      case 'user_set_public': return setGroupPublic_(body, user);
      case 'user_delete_group': return deleteGroup_(body, user);
      default: return fail_('unknown_action');
    }
  } catch (err) { logError_(action, err); return fail_('internal_error'); }
}

function handleAdmin_(action, body, user) {
  try {
    switch (action) {
      case 'admin_dashboard': return ok_(getDashboard_());
      case 'admin_pending_list': return ok_(getPendingList_());
      case 'admin_group_detail': return ok_(getGroupDetail_(body.groupId));
      case 'admin_review': return reviewGroup_(body, user);
      case 'admin_recompare': return recompareGroup_(body, user);
      case 'admin_individuals': return ok_(listIndividualsAdmin_());
      case 'admin_individual_photos': return ok_(getIndividualPhotosAdmin_(body.individualId));
      case 'admin_set_index': return setIndexFlag_(body, user);
      case 'admin_update_individual': return updateIndividual_(body, user);
      case 'admin_add_photos': return addPhotosToIndividual_(body, user);
      case 'admin_index_sync': return ok_(startIndexSync_(user));
      case 'admin_index_status': return ok_(indexSyncStatus_());
      default: return fail_('unknown_action');
    }
  } catch (err) { logError_(action, err); return fail_('internal_error'); }
}

function publicConfig_() {
  return {
    locations: CONFIG.LOCATIONS, species: CONFIG.SPECIES, other: CONFIG.OTHER,
    maxPhotos: CONFIG.MAX_PHOTOS_PER_UPLOAD, maxPhotosAnon: CONFIG.MAX_PHOTOS_ANON,
    maxGroups: CONFIG.MAX_GROUPS_PER_UPLOAD, maxFileMb: CONFIG.MAX_FILE_SIZE_MB,
    turnstile: !!getProp_('TURNSTILE_SECRET')
  };
}

// ====================== 讀表工具 ======================
function readRecords_() {
  const sh = getSheet_(CONFIG.SHEETS.RECORDS);
  const last = sh.getLastRow();
  if (last < 2) return { sh: sh, rows: [] };
  const data = sh.getRange(2, 1, last - 1, LAST_COL).getValues();
  const rows = data.map(function (r, i) { return recordFromRow_(r, i + 2); });
  return { sh: sh, rows: rows };
}
function recordFromRow_(r, rowNum) {
  return {
    row: rowNum,
    uploaded: r[COL.UPLOADED - 1] instanceof Date ? r[COL.UPLOADED - 1] : null,
    status: String(r[COL.STATUS - 1] || '').trim(),
    source: String(r[COL.SOURCE - 1] || '').trim(),
    userName: String(r[COL.USER_NAME - 1] || ''),
    individual: String(r[COL.INDIVIDUAL - 1] || '').trim().toUpperCase(),
    date: dateStr_(r[COL.SIGHT_DATE - 1]),
    location: String(r[COL.LOCATION - 1] || '').trim(),
    species: String(r[COL.SPECIES - 1] || '').trim(),
    side: sideNorm_(r[COL.SIDE - 1]),
    isPublic: isTrue_(r[COL.PUBLIC - 1]),
    inIndex: isTrue_(r[COL.INDEX - 1]),
    photoUrl: String(r[COL.PHOTO_URL - 1] || ''),
    candidates: [r[COL.CAND1 - 1], r[COL.CAND2 - 1], r[COL.CAND3 - 1]].map(parseCandidate_).filter(Boolean),
    groupId: String(r[COL.GROUP - 1] || '').trim(),
    fileId: String(r[COL.FILE_ID - 1] || '').trim(),
    email: String(r[COL.EMAIL - 1] || '').trim().toLowerCase(),
    path: String(r[COL.PATH - 1] || '')
  };
}
function dateStr_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return fmt_(v, 'yyyy-MM-dd');
  return String(v || '').trim();
}
function candidateCell_(c) { return c ? c.id + ' (' + c.score.toFixed(4) + ', ' + sideLR_(c.side) + ')' : ''; }
function parseCandidate_(cell) {
  const m = String(cell || '').match(/^([A-Z0-9_-]+)\s*\(([0-9.]+),\s*([LR])\)/i);
  if (!m) return null;
  return { id: m[1].toUpperCase(), score: parseFloat(m[2]), side: m[3].toUpperCase() === 'L' ? 'left' : 'right' };
}
function groupRows_(rows) {
  const map = {};
  rows.forEach(function (r) {
    if (!r.groupId) return;
    if (!map[r.groupId]) map[r.groupId] = [];
    map[r.groupId].push(r);
  });
  return map;
}
function readIndividuals_() {
  const sh = getSheet_(CONFIG.SHEETS.INDIVIDUALS);
  const last = sh.getLastRow();
  const map = {};
  if (last < 2) return { sh: sh, map: map };
  const data = sh.getRange(2, 1, last - 1, 5).getValues();
  data.forEach(function (r, i) {
    const id = String(r[IND.ID - 1] || '').trim().toUpperCase();
    if (id) map[id] = { row: i + 2, id: id, nickname: String(r[IND.NICKNAME - 1] || ''), species: String(r[IND.SPECIES - 1] || ''), notes: String(r[IND.NOTES - 1] || '') };
  });
  return { sh: sh, map: map };
}
function ensureIndividual_(id, species, nickname) {
  const ind = readIndividuals_();
  if (ind.map[id]) {
    if (species && !ind.map[id].species) ind.sh.getRange(ind.map[id].row, IND.SPECIES).setValue(species);
    if (nickname && !ind.map[id].nickname) ind.sh.getRange(ind.map[id].row, IND.NICKNAME).setValue(nickname);
    return ind.map[id];
  }
  ind.sh.appendRow([id, nickname || '', species || '', '', new Date()]);
  return { id: id, nickname: nickname || '', species: species || '' };
}

/** 給候選／總覽用的個體樣本照（只用完成＋公開；同側優先）。 */
function buildSampleMap_(rows) {
  const map = {};
  rows.forEach(function (r) {
    if (r.status !== STATUS.DONE || !r.isPublic || !r.individual || !r.fileId) return;
    if (!map[r.individual]) map[r.individual] = { left: '', right: '' };
    if (r.side && !map[r.individual][r.side]) map[r.individual][r.side] = r.fileId;
  });
  return map;
}
function sampleThumb_(sampleMap, id, preferSide) {
  const s = sampleMap[id];
  if (!s) return '';
  const fid = (preferSide && s[preferSide]) || s.left || s.right;
  return publicThumbUrl_(fid, 400);
}
function decorateCandidates_(cands, indMap, sampleMap, preferSide) {
  return cands.map(function (c) {
    const info = indMap[c.id] || {};
    return {
      id: c.id, nickname: info.nickname || '', species: info.species || '',
      score: c.score, side: c.side, thumb: sampleThumb_(sampleMap, c.id, preferSide || c.side)
    };
  });
}

// ====================== 照片驗證與比對合併 ======================
function validatePhotos_(photos, maxCount) {
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > maxCount) return 'invalid_photo_count';
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p || !p.dataBase64 || !p.mime) return 'invalid_photo';
    if (CONFIG.ALLOWED_MIME_TYPES.indexOf(p.mime) === -1) return 'unsupported_format';
    if (!sideNorm_(p.side)) return 'invalid_side';
    if (Math.floor(p.dataBase64.length * 0.75) > CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) return 'file_too_large';
  }
  return '';
}
/**
 * 同一個體多張照片的比對結果合併：同一候選個體出現在多張／兩側時取最高分，回傳前 3。
 * perPhoto: [{side, results:[{individual_id, similarity}]}]
 */
function mergeCandidates_(perPhoto) {
  const best = {};
  perPhoto.forEach(function (p) {
    (p.results || []).forEach(function (r) {
      const id = String(r.individual_id || '').toUpperCase();
      const score = Number(r.similarity || 0);
      if (!id) return;
      if (!best[id] || score > best[id].score) best[id] = { id: id, score: score, side: p.side };
    });
  });
  return Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
}
/** groups: [{photos:[{side, blob}]}] → [[cand...], ...] */
function compareGroups_(groups, species) {
  return groups.map(function (g) {
    const perPhoto = g.photos.map(function (p) {
      return { side: p.side, results: crCompare_(p.blob, p.side, species) };
    });
    return mergeCandidates_(perPhoto);
  });
}
/** body.groups: [{photos:[{side, mime, dataBase64, filename}]}]；未分組照片前端已各自成組。 */
function parseGroups_(body, maxPhotos, maxGroups) {
  const groups = Array.isArray(body.groups) ? body.groups : [];
  if (groups.length === 0 || groups.length > maxGroups) return { error: 'invalid_group_count' };
  let all = [];
  for (let i = 0; i < groups.length; i++) {
    const photos = groups[i] && groups[i].photos;
    if (!Array.isArray(photos) || photos.length === 0) return { error: 'invalid_group' };
    all = all.concat(photos);
  }
  const err = validatePhotos_(all, maxPhotos);
  if (err) return { error: err };
  return {
    groups: groups.map(function (g) {
      return { photos: g.photos.map(function (p) { return { side: sideNorm_(p.side), mime: p.mime, dataBase64: p.dataBase64 }; }) };
    })
  };
}

// ====================== 未登入比對（不儲存） ======================
function anonCompare_(body) {
  if (!verifyTurnstile_(body.turnstileToken)) return fail_('captcha_failed');
  const sightingDate = validDate_(body.sightingDate);
  const location = resolveLocation_(body.location, body.customLocation);
  const species = resolveSpecies_(body.species, body.customSpecies);
  if (!sightingDate || !location || !species) return fail_('invalid_input');
  const parsed = parseGroups_(body, CONFIG.MAX_PHOTOS_ANON, CONFIG.MAX_GROUPS_PER_UPLOAD);
  if (parsed.error) return fail_(parsed.error);
  if (!checkAndBump_(hourKey_('rl_anon_'), CONFIG.GLOBAL_ANON_LIMIT_PER_HOUR)) return fail_('rate_limited');

  const groups = parsed.groups.map(function (g) {
    return { photos: g.photos.map(function (p) { return { side: p.side, blob: Utilities.newBlob(Utilities.base64Decode(p.dataBase64), p.mime, 'q.' + extFromMime_(p.mime)) }; }) };
  });
  let results;
  try { results = compareGroups_(groups, species); }
  catch (err) { logError_('anonCompare_', err); return fail_('compare_failed'); }

  const rec = readRecords_();
  const ind = readIndividuals_();
  const sampleMap = buildSampleMap_(rec.rows);
  return ok_({
    sightingDate: sightingDate, location: location, species: species,
    groups: results.map(function (cands, i) {
      return {
        index: i + 1,
        photoCount: groups[i].photos.length,
        sides: groups[i].photos.map(function (p) { return p.side; }),
        candidates: decorateCandidates_(cands, ind.map, sampleMap)
      };
    })
  });
}

// ====================== 登入上傳（民眾／研究員共用） ======================
function uploadReport_(body, user) {
  const sightingDate = validDate_(body.sightingDate);
  const location = resolveLocation_(body.location, body.customLocation);
  const species = resolveSpecies_(body.species, body.customSpecies);
  if (!sightingDate || !location || !species) return fail_('invalid_input');
  const parsed = parseGroups_(body, CONFIG.MAX_PHOTOS_PER_UPLOAD, CONFIG.MAX_GROUPS_PER_UPLOAD);
  if (parsed.error) return fail_(parsed.error);
  if (!checkAndBump_(hourKey_('rl_up_', user.email), CONFIG.RATE_LIMIT_PER_EMAIL_PER_HOUR)) return fail_('rate_limited');
  if (!checkAndBump_(hourKey_('rl_upall_'), CONFIG.GLOBAL_UPLOAD_LIMIT_PER_HOUR)) return fail_('rate_limited');

  const researcher = isResearcher_(user.email);
  const source = researcher ? SOURCE.SURVEY : SOURCE.PUBLIC;
  const now = new Date();
  const stamp = fmt_(now, 'yyyyMMddHHmmss') + '_' + randomToken_(4);
  const folder = reportMonthFolder_(now);
  const sh = getSheet_(CONFIG.SHEETS.RECORDS);
  const rowsData = [];
  const groupIds = [];

  parsed.groups.forEach(function (g, gi) {
    const groupId = stamp + '_個體' + (gi + 1);
    groupIds.push(groupId);
    g.photos.forEach(function (p) {
      const name = fmt_(now, 'yyyyMMdd_HHmmss') + '_' + randomToken_(4) + '_' + sideLR_(p.side) + '.' + extFromMime_(p.mime);
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.dataBase64), p.mime, name));
      const row = new Array(LAST_COL).fill('');
      row[COL.UPLOADED - 1] = now;
      row[COL.STATUS - 1] = STATUS.PENDING;
      row[COL.SOURCE - 1] = source;
      row[COL.USER_NAME - 1] = user.name;
      row[COL.SIGHT_DATE - 1] = sightingDate;
      row[COL.LOCATION - 1] = location;
      row[COL.SPECIES - 1] = species;
      row[COL.SIDE - 1] = sideZh_(p.side);
      row[COL.PUBLIC - 1] = researcher ? true : (body.isPublic === true);
      row[COL.INDEX - 1] = false;
      row[COL.PHOTO_URL - 1] = fileViewUrl_(file.getId());
      row[COL.GROUP - 1] = groupId;
      row[COL.FILE_ID - 1] = file.getId();
      row[COL.EMAIL - 1] = user.email;
      row[COL.PATH - 1] = CONFIG.FOLDERS.REPORTS + '/' + fmt_(now, 'yyyy') + '/' + fmt_(now, 'yyyy-MM');
      rowsData.push(row);
    });
  });
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rowsData.length, LAST_COL).setValues(rowsData);
  sh.getRange(start, COL.SIGHT_DATE, rowsData.length, 1).setNumberFormat('@');
  return ok_({ groupIds: groupIds, source: source, message: '已收到照片，比對進行中，可關閉瀏覽器' });
}

/** 前端輪詢用：回傳指定群組目前狀態與候選。 */
function getGroupStatus_(groupIds, user) {
  const ids = Array.isArray(groupIds) ? groupIds.map(String) : [];
  if (ids.length === 0) return [];
  const rec = readRecords_();
  const byGroup = groupRows_(rec.rows);
  const ind = readIndividuals_();
  const sampleMap = buildSampleMap_(rec.rows);
  return ids.map(function (gid) {
    const rows = byGroup[gid];
    if (!rows || rows[0].email !== user.email) return { groupId: gid, error: 'not_found' };
    return groupSummary_(gid, rows, ind.map, sampleMap, true);
  });
}

/** 群組摘要（本人或研究員視角：含未公開照片的內嵌縮圖）。 */
function groupSummary_(gid, rows, indMap, sampleMap, withPhotos) {
  const first = rows[0];
  const info = first.individual ? (indMap[first.individual] || { id: first.individual }) : null;
  const out = {
    groupId: gid, status: first.status, source: first.source, uploaded: first.uploaded ? first.uploaded.toISOString() : '',
    userName: first.userName, email: first.email,
    date: first.date, location: first.location, species: first.species,
    isPublic: first.isPublic,
    individual: info ? { id: first.individual, nickname: info.nickname || '' } : null,
    candidates: decorateCandidates_(first.candidates, indMap, sampleMap),
    photoCount: rows.length,
    sides: rows.map(function (r) { return r.side; })
  };
  if (withPhotos) {
    out.photos = rows.map(function (r) {
      return {
        fileId: r.fileId, side: r.side, inIndex: r.inIndex,
        thumb: (r.status === STATUS.DONE && r.isPublic) ? publicThumbUrl_(r.fileId, 400) : inlineThumb_(r.fileId)
      };
    });
  }
  return out;
}

// ====================== 後台比對 trigger ======================
function processPendingCompares() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const rec = readRecords_();
    const byGroup = groupRows_(rec.rows);
    const pendingGroups = Object.keys(byGroup).filter(function (gid) {
      return byGroup[gid].every(function (r) { return r.status === STATUS.PENDING; });
    });
    if (pendingGroups.length === 0) return;
    const start = Date.now();
    const TIME_LIMIT_MS = 4 * 60 * 1000;
    let done = 0;
    for (let i = 0; i < pendingGroups.length && done < 4; i++) {
      if (Date.now() - start > TIME_LIMIT_MS) break;
      runCompareForGroup_(rec.sh, byGroup[pendingGroups[i]], true);
      done++;
    }
  } finally { lock.releaseLock(); }
}

/** 對一個群組跑比對並回寫候選；keepStatus=false 時進入待選擇。 */
function runCompareForGroup_(sh, rows, advanceStatus) {
  const setStatus = function (s) { rows.forEach(function (r) { sh.getRange(r.row, COL.STATUS).setValue(s); }); };
  if (advanceStatus) { setStatus(STATUS.COMPARING); SpreadsheetApp.flush(); }
  try {
    const perPhoto = rows.map(function (r) {
      const blob = DriveApp.getFileById(r.fileId).getBlob();
      return { side: r.side, results: crCompare_(blob, r.side, r.species) };
    });
    const cands = mergeCandidates_(perPhoto);
    const cells = [candidateCell_(cands[0]), candidateCell_(cands[1]), candidateCell_(cands[2])];
    rows.forEach(function (r) { sh.getRange(r.row, COL.CAND1, 1, 3).setValues([cells]); });
    if (advanceStatus) setStatus(STATUS.AWAITING);
    return cands;
  } catch (err) {
    logError_('runCompareForGroup_ ' + rows[0].groupId, err);
    if (advanceStatus) setStatus(STATUS.FAILED);
    throw err;
  }
}

// ====================== 使用者動作 ======================
function ownedGroup_(groupId, user) {
  const gid = String(groupId || '').trim();
  if (!gid) return null;
  const rec = readRecords_();
  const rows = groupRows_(rec.rows)[gid];
  if (!rows || rows[0].email !== user.email) return null;
  return { sh: rec.sh, rows: rows, all: rec.rows };
}

/**
 * 「是它！」／「都不是」：
 *   民眾 → 預填編號（都不是＝留空）、狀態=審查、照片不搬
 *   研究員 → 直接完成入庫（可帶 includeIndex、newIndividualId、nickname）
 */
function chooseCandidate_(body, user) {
  const g = ownedGroup_(body.groupId, user);
  if (!g) return fail_('not_found');
  const status = g.rows[0].status;
  if ([STATUS.AWAITING, STATUS.REVIEW].indexOf(status) === -1) return fail_('invalid_status');
  const chosen = body.none === true ? '' : normalizeIndividualId_(body.individualId);
  if (body.none !== true && !chosen) return fail_('invalid_individual');

  if (isResearcher_(user.email)) {
    const target = chosen || normalizeIndividualId_(body.newIndividualId);
    if (!target) return fail_('invalid_individual');
    completeGroup_(g.sh, g.rows, target, body.includeIndex !== false, sanitizeInput_(body.nickname, 30), user.email);
    return ok_({ status: STATUS.DONE, individual: target });
  }
  g.rows.forEach(function (r) {
    g.sh.getRange(r.row, COL.INDIVIDUAL).setValue(chosen);
    g.sh.getRange(r.row, COL.STATUS).setValue(STATUS.REVIEW);
  });
  logAudit_(user.email, g.rows[0].groupId, '民眾選擇', g.rows[0].individual, chosen || '都不是');
  return ok_({ status: STATUS.REVIEW, individual: chosen || null });
}

function setGroupPublic_(body, user) {
  const g = ownedGroup_(body.groupId, user);
  if (!g) return fail_('not_found');
  const isPublic = body.isPublic === true;
  g.rows.forEach(function (r) {
    g.sh.getRange(r.row, COL.PUBLIC).setValue(isPublic);
    if (r.status === STATUS.DONE) setFilePublic_(r.fileId, isPublic);
  });
  logAudit_(user.email, g.rows[0].groupId, '公開', g.rows[0].isPublic, isPublic);
  invalidatePublicCache_();
  return ok_({ isPublic: isPublic });
}

/** 刪除整個群組：Drive 檔案（含已入庫）進垃圾桶、Sheet 列刪除。索引由下次「更新比對資料」清掉。 */
function deleteGroup_(body, user) {
  const g = ownedGroup_(body.groupId, user);
  if (!g) return fail_('not_found');
  g.rows.forEach(function (r) {
    try { DriveApp.getFileById(r.fileId).setTrashed(true); } catch (err) { logError_('trash ' + r.fileId, err); }
  });
  g.rows.map(function (r) { return r.row; }).sort(function (a, b) { return b - a; })
    .forEach(function (rowNum) { g.sh.deleteRow(rowNum); });
  logAudit_(user.email, g.rows[0].groupId, '刪除紀錄', g.rows.length + ' 張', '');
  invalidatePublicCache_();
  return ok_({ deleted: g.rows.length });
}

function getMyRecords_(user) {
  const rec = readRecords_();
  const byGroup = groupRows_(rec.rows);
  const ind = readIndividuals_();
  const sampleMap = buildSampleMap_(rec.rows);
  const out = [];
  Object.keys(byGroup).forEach(function (gid) {
    const rows = byGroup[gid];
    if (rows[0].email !== user.email) return;
    out.push(groupSummary_(gid, rows, ind.map, sampleMap, true));
  });
  out.sort(function (a, b) { return (b.uploaded || '').localeCompare(a.uploaded || ''); });
  const individuals = {};
  out.forEach(function (g) { if (g.individual) individuals[g.individual.id] = true; });
  return { groups: out, photoCount: out.reduce(function (n, g) { return n + g.photoCount; }, 0), individualCount: Object.keys(individuals).length };
}

// ====================== 入庫（狀態改完成的唯一觸發點） ======================
/**
 * 把群組所有照片搬到 資料庫/{編號}/{編號}_L|_R/，改名 {編號}_{L|R}_{目擊日期}_{序號}.ext，
 * 寫入編號／納入索引／狀態=完成；公開者開啟分享；確保個體清單有此編號。
 */
function completeGroup_(sh, rows, individualId, includeIndex, nickname, actor) {
  const first = rows[0];
  ensureIndividual_(individualId, first.species, nickname);
  const dbRoot = folderId_('DATABASE');
  const indFolder = getOrCreateChildFolder_(dbRoot, individualId);
  const sideFolders = {};
  const counters = {};
  rows.forEach(function (r) {
    const lr = sideLR_(r.side);
    if (!sideFolders[lr]) {
      sideFolders[lr] = getOrCreateChildFolder_(indFolder.getId(), individualId + '_' + lr);
      counters[lr] = countFiles_(sideFolders[lr]);
    }
    counters[lr] += 1;
    const ext = (DriveApp.getFileById(r.fileId).getName().match(/\.([a-z0-9]+)$/i) || [0, 'jpg'])[1].toLowerCase();
    const newName = individualId + '_' + lr + '_' + r.date.replace(/-/g, '') + '_' + String(counters[lr]).padStart(2, '0') + '.' + ext;
    const sourceParent = getFileParentId_(r.fileId);
    const file = moveFile_(r.fileId, sideFolders[lr].getId());
    file.setName(newName);
    if (sourceParent) cleanupEmptyAncestors_(sourceParent, folderId_('REPORTS'));
    const isPublic = first.source === SOURCE.SURVEY ? true : r.isPublic;
    sh.getRange(r.row, COL.INDIVIDUAL).setValue(individualId);
    sh.getRange(r.row, COL.STATUS).setValue(STATUS.DONE);
    sh.getRange(r.row, COL.PUBLIC).setValue(isPublic);
    sh.getRange(r.row, COL.INDEX).setValue(includeIndex === true);
    sh.getRange(r.row, COL.PATH).setValue(CONFIG.FOLDERS.DATABASE + '/' + individualId + '/' + individualId + '_' + lr);
    setFilePublic_(r.fileId, isPublic);
  });
  logAudit_(actor, first.groupId, '完成入庫', first.individual, individualId + (includeIndex ? '（納入索引）' : ''));
  invalidatePublicCache_();
}
function countFiles_(folder) {
  let n = 0;
  const it = folder.getFiles();
  while (it.hasNext()) { it.next(); n++; }
  return n;
}

// ====================== 研究員動作 ======================
function getDashboard_() {
  const rec = readRecords_();
  const ind = readIndividuals_();
  const byGroup = groupRows_(rec.rows);
  const users = {};
  let photosPublic = 0, photosSurvey = 0, pendingPublic = 0, pendingSurvey = 0;
  rec.rows.forEach(function (r) {
    if (r.email) users[r.email] = true;
    if (r.status === STATUS.DONE) { if (r.source === SOURCE.SURVEY) photosSurvey++; else photosPublic++; }
  });
  Object.keys(byGroup).forEach(function (gid) {
    const f = byGroup[gid][0];
    if (isPendingForReview_(f)) { if (f.source === SOURCE.SURVEY) pendingSurvey++; else pendingPublic++; }
  });
  return {
    users: Object.keys(users).length,
    individuals: Object.keys(ind.map).length,
    photos: { public: photosPublic, survey: photosSurvey },
    pending: { public: pendingPublic, survey: pendingSurvey },
    index: indexSyncStatus_(),
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.SHEET_ID
  };
}
/** 待審查定義：民眾＝狀態審查；調查＝比對結果已出但尚未選（待選擇）；比對失敗也列出供重比。 */
function isPendingForReview_(first) {
  if (first.status === STATUS.REVIEW || first.status === STATUS.FAILED) return true;
  return first.status === STATUS.AWAITING && first.source === SOURCE.SURVEY;
}
function getPendingList_() {
  const rec = readRecords_();
  const byGroup = groupRows_(rec.rows);
  const ind = readIndividuals_();
  const sampleMap = buildSampleMap_(rec.rows);
  const out = [];
  Object.keys(byGroup).forEach(function (gid) {
    const rows = byGroup[gid];
    if (!isPendingForReview_(rows[0])) return;
    const s = groupSummary_(gid, rows, ind.map, sampleMap, false);
    s.thumb = inlineThumb_(rows[0].fileId);
    out.push(s);
  });
  out.sort(function (a, b) { return (a.uploaded || '').localeCompare(b.uploaded || ''); });
  return out;
}
function getGroupDetail_(groupId) {
  const gid = String(groupId || '').trim();
  const rec = readRecords_();
  const rows = groupRows_(rec.rows)[gid];
  if (!rows) return null;
  const ind = readIndividuals_();
  return groupSummary_(gid, rows, ind.map, buildSampleMap_(rec.rows), true);
}
/** 研究員審查確認：指定既有或新編號 → 完成入庫。 */
function reviewGroup_(body, user) {
  const gid = String(body.groupId || '').trim();
  const rec = readRecords_();
  const rows = groupRows_(rec.rows)[gid];
  if (!rows) return fail_('not_found');
  if ([STATUS.REVIEW, STATUS.AWAITING, STATUS.FAILED].indexOf(rows[0].status) === -1) return fail_('invalid_status');
  const target = normalizeIndividualId_(body.individualId);
  if (!target) return fail_('invalid_individual');
  completeGroup_(rec.sh, rows, target, body.includeIndex !== false, sanitizeInput_(body.nickname, 30), user.email);
  return ok_({ status: STATUS.DONE, individual: target });
}
/** 重新比對：以最新索引重找前三候選，狀態與已選編號不動。 */
function recompareGroup_(body, user) {
  const gid = String(body.groupId || '').trim();
  const rec = readRecords_();
  const rows = groupRows_(rec.rows)[gid];
  if (!rows) return fail_('not_found');
  if (rows[0].status === STATUS.DONE) return fail_('invalid_status');
  try {
    const wasFailed = rows[0].status === STATUS.FAILED;
    const cands = runCompareForGroup_(rec.sh, rows, wasFailed);
    logAudit_(user.email, gid, '重新比對', '', cands.map(function (c) { return c.id; }).join(','));
    const ind = readIndividuals_();
    return ok_({ candidates: decorateCandidates_(cands, ind.map, buildSampleMap_(rec.rows)) });
  } catch (err) { return fail_('compare_failed'); }
}

function listIndividualsAdmin_() {
  const rec = readRecords_();
  const ind = readIndividuals_();
  const stats = {};
  rec.rows.forEach(function (r) {
    if (r.status !== STATUS.DONE || !r.individual) return;
    if (!stats[r.individual]) stats[r.individual] = { left: 0, right: 0, inIndex: 0, locations: {}, thumbFile: '' };
    const s = stats[r.individual];
    if (r.side === 'left') s.left++; else if (r.side === 'right') s.right++;
    if (r.inIndex) s.inIndex++;
    if (r.location) s.locations[r.location] = true;
    if (!s.thumbFile) s.thumbFile = r.fileId;
  });
  const ids = Object.keys(ind.map);
  Object.keys(stats).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
  return ids.sort().map(function (id) {
    const info = ind.map[id] || {};
    const s = stats[id] || { left: 0, right: 0, inIndex: 0, locations: {}, thumbFile: '' };
    return {
      id: id, nickname: info.nickname || '', species: info.species || '', notes: info.notes || '',
      left: s.left, right: s.right, inIndex: s.inIndex, locations: Object.keys(s.locations),
      thumb: s.thumbFile ? inlineThumb_(s.thumbFile) : ''
    };
  });
}
function getIndividualPhotosAdmin_(individualId) {
  const id = normalizeIndividualId_(individualId);
  if (!id) return null;
  const rec = readRecords_();
  const ind = readIndividuals_();
  const info = ind.map[id] || { id: id, nickname: '', species: '' };
  const photos = { left: [], right: [] };
  const locations = {};
  rec.rows.forEach(function (r) {
    if (r.status !== STATUS.DONE || r.individual !== id) return;
    if (r.location) locations[r.location] = true;
    const p = {
      fileId: r.fileId, groupId: r.groupId, date: r.date, location: r.location, source: r.source,
      isPublic: r.isPublic, inIndex: r.inIndex, url: r.photoUrl,
      thumb: r.isPublic ? publicThumbUrl_(r.fileId, 400) : inlineThumb_(r.fileId)
    };
    if (r.side === 'left') photos.left.push(p); else if (r.side === 'right') photos.right.push(p);
  });
  const byDateDesc = function (a, b) { return (b.date || '').localeCompare(a.date || ''); };
  photos.left.sort(byDateDesc); photos.right.sort(byDateDesc);
  return { individual: { id: id, nickname: info.nickname, species: info.species, locations: Object.keys(locations) }, photos: photos };
}
/** 單張照片切換「納入比對索引」。實際索引變更在「更新比對資料」時生效。 */
function setIndexFlag_(body, user) {
  const fileId = String(body.fileId || '').trim();
  const include = body.include === true;
  const rec = readRecords_();
  const r = rec.rows.filter(function (x) { return x.fileId === fileId; })[0];
  if (!r) return fail_('not_found');
  if (r.status !== STATUS.DONE) return fail_('invalid_status');
  rec.sh.getRange(r.row, COL.INDEX).setValue(include);
  logAudit_(user.email, r.groupId, '納入比對索引', r.inIndex, include);
  return ok_({ fileId: fileId, inIndex: include });
}
function updateIndividual_(body, user) {
  const id = normalizeIndividualId_(body.individualId);
  if (!id) return fail_('invalid_individual');
  const ind = readIndividuals_();
  const cur = ind.map[id];
  if (!cur) return fail_('not_found');
  if (body.nickname !== undefined) ind.sh.getRange(cur.row, IND.NICKNAME).setValue(sanitizeInput_(body.nickname, 30));
  if (body.species !== undefined) {
    const sp = sanitizeInput_(body.species, 20);
    ind.sh.getRange(cur.row, IND.SPECIES).setValue(sp);
    const rec = readRecords_();
    rec.rows.forEach(function (r) {
      if (r.individual === id && r.status === STATUS.DONE) rec.sh.getRange(r.row, COL.SPECIES).setValue(sp);
    });
  }
  if (body.notes !== undefined) ind.sh.getRange(cur.row, IND.NOTES).setValue(sanitizeInput_(body.notes, 200));
  logAudit_(user.email, '', '個體清單 ' + id, '', JSON.stringify({ nickname: body.nickname, species: body.species }));
  invalidatePublicCache_();
  return ok_({ id: id });
}
/** 研究員「新增其他照片」到既有個體：直接完成＋公開，來源=水下調查。 */
function addPhotosToIndividual_(body, user) {
  const id = normalizeIndividualId_(body.individualId);
  if (!id) return fail_('invalid_individual');
  const ind = readIndividuals_();
  if (!ind.map[id]) return fail_('not_found');
  const sightingDate = validDate_(body.sightingDate);
  const location = resolveLocation_(body.location, body.customLocation);
  if (!sightingDate || !location) return fail_('invalid_input');
  const photos = Array.isArray(body.photos) ? body.photos : [];
  const err = validatePhotos_(photos, CONFIG.MAX_PHOTOS_PER_UPLOAD);
  if (err) return fail_(err);
  const species = ind.map[id].species || speciesKey_(body.species);
  const now = new Date();
  const groupId = fmt_(now, 'yyyyMMddHHmmss') + '_' + randomToken_(4) + '_補充';
  const folder = reportMonthFolder_(now);
  const sh = getSheet_(CONFIG.SHEETS.RECORDS);
  const rowsData = [];
  photos.forEach(function (p) {
    const side = sideNorm_(p.side);
    const name = fmt_(now, 'yyyyMMdd_HHmmss') + '_' + randomToken_(4) + '_' + sideLR_(side) + '.' + extFromMime_(p.mime);
    const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.dataBase64), p.mime, name));
    const row = new Array(LAST_COL).fill('');
    row[COL.UPLOADED - 1] = now; row[COL.STATUS - 1] = STATUS.AWAITING; row[COL.SOURCE - 1] = SOURCE.SURVEY;
    row[COL.USER_NAME - 1] = user.name; row[COL.SIGHT_DATE - 1] = sightingDate; row[COL.LOCATION - 1] = location;
    row[COL.SPECIES - 1] = species; row[COL.SIDE - 1] = sideZh_(side); row[COL.PUBLIC - 1] = true; row[COL.INDEX - 1] = false;
    row[COL.PHOTO_URL - 1] = fileViewUrl_(file.getId()); row[COL.GROUP - 1] = groupId; row[COL.FILE_ID - 1] = file.getId();
    row[COL.EMAIL - 1] = user.email; row[COL.PATH - 1] = CONFIG.FOLDERS.REPORTS;
    rowsData.push(row);
  });
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rowsData.length, LAST_COL).setValues(rowsData);
  sh.getRange(start, COL.SIGHT_DATE, rowsData.length, 1).setNumberFormat('@');
  SpreadsheetApp.flush();
  const rows = readRecords_().rows.filter(function (r) { return r.groupId === groupId; });
  completeGroup_(sh, rows, id, body.includeIndex !== false, '', user.email);
  return ok_({ groupId: groupId, individual: id, added: rows.length });
}

// ====================== 公開總覽 ======================
function getOverview_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('public_overview');
  if (cached) return JSON.parse(cached);
  const rec = readRecords_();
  const ind = readIndividuals_();
  const agg = {};
  rec.rows.forEach(function (r) {
    if (r.status !== STATUS.DONE || !r.isPublic || !r.individual) return;
    if (!agg[r.individual]) agg[r.individual] = { locations: {}, dates: {}, left: '', right: '', lastDate: '' };
    const a = agg[r.individual];
    if (r.location) a.locations[r.location] = true;
    if (r.date) a.dates[r.date] = true;
    if (r.side && !a[r.side]) a[r.side] = r.fileId;
    if (r.date > a.lastDate) a.lastDate = r.date;
  });
  const individuals = Object.keys(agg).map(function (id) {
    const a = agg[id];
    const info = ind.map[id] || {};
    const locs = Object.keys(a.locations);
    return {
      id: id, nickname: info.nickname || '', species: info.species || '',
      locations: locs.map(function (l) { return CONFIG.LOCATIONS.indexOf(l) === -1 ? CONFIG.OTHER : l; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; }),
      locationsRaw: locs,
      sightings: Object.keys(a.dates).length,
      lastDate: a.lastDate,
      thumb: publicThumbUrl_(a.left || a.right, 600)
    };
  }).sort(function (x, y) { return (y.lastDate || '').localeCompare(x.lastDate || '') || x.id.localeCompare(y.id); });
  const hasOther = individuals.some(function (i) { return i.locations.indexOf(CONFIG.OTHER) !== -1; });
  const out = { individuals: individuals, locations: CONFIG.LOCATIONS.concat(hasOther ? [CONFIG.OTHER] : []), species: CONFIG.SPECIES.slice(0, 2), generatedAt: new Date().toISOString() };
  try { cache.put('public_overview', JSON.stringify(out), CONFIG.OVERVIEW_CACHE_SEC); } catch (e) { /* 超過 100KB 就不快取 */ }
  return out;
}
function getIndividualPublic_(individualId) {
  const id = normalizeIndividualId_(individualId);
  if (!id) return null;
  const rec = readRecords_();
  const ind = readIndividuals_();
  const info = ind.map[id] || {};
  const photos = { left: [], right: [] };
  const locations = {}, dates = {};
  rec.rows.forEach(function (r) {
    if (r.status !== STATUS.DONE || !r.isPublic || r.individual !== id) return;
    if (r.location) locations[r.location] = true;
    if (r.date) dates[r.date] = true;
    const p = { date: r.date, location: r.location, source: r.source, thumb: publicThumbUrl_(r.fileId, 800), url: r.photoUrl };
    if (r.side === 'left') photos.left.push(p); else if (r.side === 'right') photos.right.push(p);
  });
  if (photos.left.length + photos.right.length === 0) return null;
  const byDateDesc = function (a, b) { return (b.date || '').localeCompare(a.date || ''); };
  photos.left.sort(byDateDesc); photos.right.sort(byDateDesc);
  return { individual: { id: id, nickname: info.nickname || '', species: info.species || '', locations: Object.keys(locations), sightings: Object.keys(dates).length }, photos: photos };
}

// ====================== 索引同步（「更新比對資料」） ======================
/**
 * 目標集合 = 回報紀錄中 狀態=完成 且 納入比對索引=TRUE 的照片。
 * 與 Cloud Run 索引 manifest 做差集：多的移除、缺的分批加入（Cloud Run 自行從 Drive 下載）、物種變更同步。
 * 單次執行約 4 分鐘上限，未完成則以一次性 trigger 續跑；進度存 Script Property INDEX_SYNC。
 */
function startIndexSync_(user) {
  const st = indexSyncStatus_();
  if (st.running && Date.now() - new Date(st.startedAt).getTime() < 30 * 60 * 1000) return st;
  setProp_('INDEX_SYNC', JSON.stringify({ running: true, startedAt: new Date().toISOString(), by: user ? user.email : 'trigger', added: 0, removed: 0, remaining: null, error: '' }));
  scheduleIndexSyncContinue_(1);
  return indexSyncStatus_();
}
function indexSyncStatus_() {
  const raw = getProp_('INDEX_SYNC');
  const st = raw ? JSON.parse(raw) : { running: false };
  st.lastUpdatedAt = getProp_('INDEX_LAST_UPDATED') || '';
  st.indexedPhotos = parseInt(getProp_('INDEX_PHOTO_COUNT') || '0', 10);
  return st;
}
function scheduleIndexSyncContinue_(minutes) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'indexSyncStep') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('indexSyncStep').timeBased().after(Math.max(1, minutes) * 60 * 1000).create();
}
function indexSyncStep() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'indexSyncStep') ScriptApp.deleteTrigger(t);
  });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { scheduleIndexSyncContinue_(1); return; }
  const start = Date.now();
  const TIME_LIMIT_MS = 4 * 60 * 1000;
  const BATCH = 8;
  const st = indexSyncStatus_();
  try {
    const rec = readRecords_();
    const ind = readIndividuals_();
    const desired = {};
    rec.rows.forEach(function (r) {
      if (r.status === STATUS.DONE && r.inIndex && r.fileId && r.side && r.individual) {
        const species = (ind.map[r.individual] && ind.map[r.individual].species) || r.species;
        desired[r.fileId] = { file_id: r.fileId, individual_id: r.individual, side: r.side, species: speciesKey_(species) };
      }
    });
    const manifest = crManifest_();
    const current = manifest.items || {};   // file_id → {individual_id, side, species}
    const removes = Object.keys(current).filter(function (fid) { return !desired[fid]; });
    const adds = Object.keys(desired).filter(function (fid) {
      const c = current[fid];
      return !c || c.individual_id !== desired[fid].individual_id || c.side !== desired[fid].side;
    }).map(function (fid) { return desired[fid]; });
    const speciesUpdates = Object.keys(desired).filter(function (fid) {
      const c = current[fid];
      return c && c.individual_id === desired[fid].individual_id && c.species !== desired[fid].species;
    }).map(function (fid) { return { file_id: fid, species: desired[fid].species }; });

    if (removes.length || speciesUpdates.length) {
      crIndexApply_({ removes: removes, species_updates: speciesUpdates });
      st.removed = (st.removed || 0) + removes.length;
    }
    let i = 0;
    while (i < adds.length && Date.now() - start < TIME_LIMIT_MS) {
      const batch = adds.slice(i, i + BATCH);
      const r = crIndexApply_({ adds: batch });
      st.added = (st.added || 0) + (r.added || 0);
      if (r.failed && r.failed.length) st.error = '部分照片加入失敗：' + r.failed.slice(0, 5).join(', ');
      i += batch.length;
    }
    st.remaining = adds.length - i;
    if (st.remaining > 0) {
      setProp_('INDEX_SYNC', JSON.stringify(st));
      scheduleIndexSyncContinue_(1);
      return;
    }
    const finalManifest = crManifest_();
    setProp_('INDEX_PHOTO_COUNT', String(Object.keys(finalManifest.items || {}).length));
    setProp_('INDEX_LAST_UPDATED', new Date().toISOString());
    st.running = false; st.finishedAt = new Date().toISOString();
    setProp_('INDEX_SYNC', JSON.stringify(st));
  } catch (err) {
    logError_('indexSyncStep', err);
    st.running = false; st.error = String(err && err.message || err);
    setProp_('INDEX_SYNC', JSON.stringify(st));
  } finally { lock.releaseLock(); }
}

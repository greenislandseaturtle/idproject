// 部署後填入實際值（皆為公開值，可進 git）
const APP_CONFIG = {
  // Apps Script Web App URL（部署 → 管理部署 → 網頁應用程式 URL）
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyi3iNecJ9quvWrHOK3xO9Heke08f8tA8V5zzhfaGMr8QtqP-uyDHSm2QknBgXU2ked/exec',
  // Google OAuth Client ID（GCP 主控台 → API 和服務 → 憑證 → OAuth 用戶端 ID（網頁應用程式））
  GOOGLE_CLIENT_ID: '841875653967-ik5e2p5rgjtariagmmjjr7c1as08ji6b.apps.googleusercontent.com',
  // Cloudflare Turnstile site key；留空＝未登入比對不顯示人機驗證（後端也會略過）
  TURNSTILE_SITE_KEY: '0x4AAAAAAEyMzucwXqJBUalQ'
};

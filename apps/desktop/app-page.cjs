const { fileURLToPath } = require('node:url');
const path = require('node:path');

// 프레임 URL 이 우리 index.html 인가. 문자열 비교는 Chromium 이 ~ [ ] 를 다르게 인코딩해 깨지므로
// 경로로 디코딩해서 비교하고, #hash·?query 는 무시한다. file: 외에는 전부 거부.
function isAppPage(frameUrl, indexHtml) {
  try {
    const u = new URL(frameUrl);
    if (u.protocol !== 'file:') return false;
    u.hash = '';
    u.search = '';
    return path.resolve(fileURLToPath(u)) === path.resolve(indexHtml);
  } catch { return false; }
}
module.exports = { isAppPage };

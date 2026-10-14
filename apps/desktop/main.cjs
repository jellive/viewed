const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');

const UD = '--user-data-dir=';
const ud = process.argv.find((a) => a.startsWith(UD));
if (ud) app.setPath('userData', path.resolve(ud.slice(UD.length)));

const indexHtml = path.join(__dirname, '..', 'web', 'dist', 'index.html');
const indexUrl = pathToFileURL(indexHtml).href;
let win = null;

const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
// ENOENT = 아직 없음({}). 그 외 읽기·파싱 오류는 던진다 — 빈 객체로 덮어써 토큰을 지우지 않는다.
async function readAll() {
  let text;
  try { text = await fs.readFile(secretsFile(), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('corrupt secrets.json');
  return parsed;
}
async function decrypt(b64) {
  const out = await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'));
  return typeof out === 'string' ? out : out.result;   // 44.x: { shouldReEncrypt, result }
}

function assertSender(e) {
  const ok = win && !win.isDestroyed() && e.sender === win.webContents &&
    e.senderFrame === e.sender.mainFrame && e.senderFrame.url === indexUrl;
  if (!ok) throw new Error('forbidden sender');
}

// 읽기-수정-쓰기 전체를 한 줄로 세운다.
let chain = Promise.resolve();
const serialize = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

ipcMain.handle('secret:get', (e, name) => {
  assertSender(e);
  return serialize(async () => {
    const all = await readAll();
    if (!all[name]) return null;
    try { return await decrypt(all[name]); } catch { return null; }   // 복호화 실패 = 재입력 (spec §7)
  });
});
ipcMain.handle('secret:set', (e, name, value) => {
  assertSender(e);
  return serialize(async () => {
    const all = await readAll();
    all[name] = (await safeStorage.encryptStringAsync(value)).toString('base64');
    const tmp = secretsFile() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
    await fs.rename(tmp, secretsFile());
  });
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1200, height: 900, title: 'viewed',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const wc = win.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());   // 단일 페이지 앱: 이동 없음
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(indexHtml);
});
app.on('window-all-closed', () => app.quit());

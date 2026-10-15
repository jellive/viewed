const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const { isAppPage } = require('./app-page.cjs');
const { createRepos, info, ops } = require('./local-git.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

const UD = '--user-data-dir=';
const ud = process.argv.find((a) => a.startsWith(UD));
if (ud) app.setPath('userData', path.resolve(ud.slice(UD.length)));

const indexHtml = path.join(__dirname, '..', 'web', 'dist', 'index.html');
let win = null;

const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
// ENOENT = 아직 없음({}). 그 외 읽기·파싱 오류는 던진다 — 빈 객체로 덮어써 토큰을 지우지 않는다.
async function readAll() {
  let text;
  try { text = await fs.readFile(secretsFile(), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new CorruptError(); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CorruptError();
  return parsed;
}
class CorruptError extends Error { constructor() { super('corrupt secrets.json'); } }
async function decrypt(b64) {
  const out = await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'));
  return typeof out === 'string' ? out : out.result;   // 44.x: { shouldReEncrypt, result }
}

function assertSender(e) {
  const ok = win && !win.isDestroyed() && e.sender === win.webContents &&
    e.senderFrame === e.sender.mainFrame && isAppPage(e.senderFrame.url, indexHtml);
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
    let all;
    try { all = await readAll(); } catch (e) {
      if (!(e instanceof CorruptError)) throw e;   // EACCES 등은 그대로 거부 — 파일을 건드리지 않는다
      // 깨진 파일은 지우지 않고 격리한다(원본 바이트 보존). 이후 새 파일로 이어간다.
      const q = `${secretsFile()}.corrupt-${Date.now()}`;
      await fs.rename(secretsFile(), q);
      await fs.chmod(q, 0o600);
      all = {};
    }
    all[name] = (await safeStorage.encryptStringAsync(value)).toString('base64');
    const tmp = secretsFile() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
    await fs.rename(tmp, secretsFile());
  });
});

// 로컬 git 모드 — 대화상자로 고른 레포만, 정해진 읽기 명령만
const repos = createRepos(() => app.getPath('userData'));
ipcMain.handle('repo:pick', async (e) => {
  assertSender(e);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return repos.add(r.filePaths[0]);
});
ipcMain.handle('repo:list', (e) => { assertSender(e); return repos.list(); });
ipcMain.handle('repo:info', async (e, repo) => { assertSender(e); return info(await repos.allowed(repo)); });
ipcMain.handle('repo:git', async (e, repo, op, a, b) => {
  assertSender(e);
  if (!Object.hasOwn(ops, op)) throw new Error('unknown git op');
  return ops[op](await repos.allowed(repo), a, b);
});

// 같은 userData 로 두 번째 인스턴스를 띄우면 secrets.json 쓰기가 엇갈린다 — 하나만 허용
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
});

if (gotLock) app.whenReady().then(() => {
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

const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const ud = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (ud) app.setPath('userData', ud.split('=')[1]);

const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
async function readAll() {
  try { return JSON.parse(await fs.readFile(secretsFile(), 'utf8')); } catch { return {}; }
}
async function decrypt(b64) {
  const out = await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'));
  return typeof out === 'string' ? out : out.result;   // 44.x: { shouldReEncrypt, result }
}

ipcMain.handle('secret:get', async (_e, name) => {
  const all = await readAll();
  if (!all[name]) return null;
  try { return await decrypt(all[name]); } catch { return null; }   // 복호화 실패 = 재입력 (spec §7)
});
ipcMain.handle('secret:set', async (_e, name, value) => {
  const all = await readAll();
  all[name] = (await safeStorage.encryptStringAsync(value)).toString('base64');
  await fs.writeFile(secretsFile(), JSON.stringify(all), { mode: 0o600 });
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200, height: 900, title: 'viewed',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
});
app.on('window-all-closed', () => app.quit());

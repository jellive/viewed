import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isAppPage } = require('../app-page.cjs');

const roots = ['/opt/x/viewed/apps/web/dist/index.html', '/tmp/a~b/[x]/dist/index.html', '/tmp/sp ace/é/dist/index.html'];
for (const root of roots) {
  test(`isAppPage accepts the real page and fragments/queries: ${root}`, () => {
    const u = pathToFileURL(root).href;
    expect(isAppPage(u, root)).toBe(true);
    expect(isAppPage(`${u}#settings`, root)).toBe(true);
    expect(isAppPage(`${u}?x=1`, root)).toBe(true);
    expect(isAppPage(u.replace(/~/g, '%7E').replace(/\[/g, '%5B').replace(/\]/g, '%5D'), root)).toBe(true);
    expect(isAppPage('file:///other.html', root)).toBe(false);
    expect(isAppPage('http://127.0.0.1:1/index.html', root)).toBe(false);
    expect(isAppPage('', root)).toBe(false);
    expect(isAppPage('not a url', root)).toBe(false);
  });
}

// Chrome 3분할 런처 + 통합 프롬프트 바 (Electron은 하단 입력창 전용, 전송은 Chrome DevTools Protocol 사용)
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9222;
const BAR_HEIGHT = 120;
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'llm-triple-chrome-profile');

const SITES = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/', host: 'chatgpt.com',
    editor: ['#prompt-textarea', 'div[contenteditable="true"]'] },
  { name: 'Gemini', url: 'https://gemini.google.com/app', host: 'gemini.google.com',
    editor: ['div.ql-editor[contenteditable="true"]', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'] },
  { name: 'Claude', url: 'https://claude.ai/new', host: 'claude.ai',
    editor: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'] },
];

function findChrome() {
  const c = [
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  return c.find(p => fs.existsSync(p));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDebugPort(timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

function launchChrome(chrome, site, i, wa, sf) {
  // Chrome 창 좌표는 물리 픽셀 기준
  const W = Math.floor(wa.width / 3);
  const x = Math.round((wa.x + i * W) * sf);
  const y = Math.round(wa.y * sf);
  const w = Math.round((i === 2 ? wa.width - 2 * W : W) * sf);
  const h = Math.round((wa.height - BAR_HEIGHT) * sf);
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    `--window-position=${x},${y}`, `--window-size=${w},${h}`,
    `--app=${site.url}`,
  ];
  spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
}

// ---- CDP ----
async function listPages() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter(t => t.type === 'page');
}

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
  });
}

async function sendTo(site, text) {
  const page = (await listPages()).find(t => t.url.includes(site.host));
  if (!page) return false;
  const s = await cdpSession(page.webSocketDebuggerUrl);
  try {
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const r = await s.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        for (const sel of ${JSON.stringify(site.editor)}) {
          const el = document.querySelector(sel);
          if (el) { el.focus(); document.execCommand('selectAll'); return true; }
        }
        return false;
      })()`,
    });
    if (!r.result?.result?.value) return false;
    await s.send('Input.insertText', { text });
    await sleep(400);
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await s.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...key });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    return true;
  } finally { s.close(); }
}

async function tileWindows(wa) {
  const W = Math.floor(wa.width / 3);
  const H = wa.height - BAR_HEIGHT;
  const pages = await listPages();
  for (const [i, site] of SITES.entries()) {
    const page = pages.find(t => t.url.includes(site.host));
    if (!page) continue;
    const s = await cdpSession(page.webSocketDebuggerUrl);
    try {
      const w = await s.send('Browser.getWindowForTarget');
      const windowId = w.result?.windowId;
      if (windowId === undefined) continue;
      // 최대화/최소화 상태에서는 bounds가 무시되므로 먼저 normal로 복원
      await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await s.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: wa.x + i * W, top: wa.y, width: i === 2 ? wa.width - 2 * W : W, height: H },
      });
    } finally { s.close(); }
  }
}

async function newChat() {
  for (const site of SITES) {
    const page = (await listPages()).find(t => t.url.includes(site.host));
    if (!page) continue;
    const s = await cdpSession(page.webSocketDebuggerUrl);
    await s.send('Page.navigate', { url: site.url });
    s.close();
  }
}

app.whenReady().then(async () => {
  const chrome = findChrome();
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea; // DIP
  const sf = disp.scaleFactor;

  const bar = new BrowserWindow({
    x: wa.x, y: wa.y + wa.height - BAR_HEIGHT, width: wa.width, height: BAR_HEIGHT,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: false,
    title: 'LLM 통합 프롬프트 바',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  bar.loadFile(path.join(__dirname, 'bar.html'));

  if (!chrome) {
    bar.webContents.once('did-finish-load', () =>
      bar.webContents.executeJavaScript(`document.getElementById('status').textContent='Chrome(chrome.exe)을 찾지 못했습니다'`));
    return;
  }
  // 입력창 + Chrome 3창을 지정한 모니터의 작업영역에 맞춰 배치
  const placeBar = d => {
    const a = d.workArea;
    bar.setBounds({ x: a.x, y: a.y + a.height - BAR_HEIGHT, width: a.width, height: BAR_HEIGHT });
  };
  const layoutOn = async d => { placeBar(d); await tileWindows(d.workArea); };
  const currentDisplay = () => screen.getDisplayMatching(bar.getBounds());

  // 닫힌 창이 있으면 다시 열어 준다. 새로 연 창이 있으면 true 반환
  const safePages = () => listPages().catch(() => []);
  const ensureWindows = async () => {
    const has = (pages, s) => pages.some(t => t.url.includes(s.host));
    let pages = await safePages();
    const missing = SITES.filter(s => !has(pages, s));
    if (!missing.length) return false;
    const d = currentDisplay();
    const portWasDown = pages.length === 0 && !(await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.ok).catch(() => false));
    missing.forEach(s => launchChrome(chrome, s, SITES.indexOf(s), d.workArea, d.scaleFactor));
    if (portWasDown) await waitForDebugPort();
    for (let n = 0; n < 20; n++) {
      await sleep(500);
      pages = await safePages();
      if (SITES.every(s => has(pages, s))) break;
    }
    await sleep(1500); // 페이지 로딩 대기
    await layoutOn(d).catch(() => {});
    return true;
  };

  ipcMain.handle('send-prompt', async (_e, { text, targets }) => {
    await ensureWindows().catch(() => {});
    const results = {};
    await Promise.all(SITES.map(async (site, i) => {
      if (!targets[i]) return;
      try { results[site.name] = await sendTo(site, text); } catch { results[site.name] = false; }
    }));
    return results;
  });
  ipcMain.on('new-chat', async () => {
    const created = await ensureWindows().catch(() => false);
    if (!created) await newChat().catch(() => {});
  });
  // 3분할 복귀: 입력창이 있는 모니터 기준으로 처음 상태로 되돌림 (닫힌 창은 다시 열기)
  ipcMain.handle('reset-layout', async () => {
    await ensureWindows().catch(() => {});
    await layoutOn(currentDisplay());
    return true;
  });
  // 모니터 이동: 다음 모니터로 통째로 이동 (마지막 모니터 다음은 첫 모니터)
  ipcMain.handle('move-monitor', async () => {
    await ensureWindows().catch(() => {});
    const all = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
    const cur = currentDisplay();
    const idx = all.findIndex(d => d.id === cur.id);
    await layoutOn(all[(idx + 1) % all.length]);
    return all.length;
  });

  // 시작: 이미 열린 창은 재사용하고, 없는 창만 열어 3분할 배치
  await ensureWindows().catch(() => {});
  for (let n = 0; n < 3; n++) { await sleep(1000); await layoutOn(currentDisplay()).catch(() => {}); }
});

app.on('window-all-closed', () => app.quit());

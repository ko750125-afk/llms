// Chrome 3분할 런처 + 통합 프롬프트 바 (Electron은 하단 입력창 전용, 전송은 Chrome DevTools Protocol 사용)
const { app, BrowserWindow, ipcMain, screen, clipboard, dialog, nativeImage, shell } = require('electron');
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

let isAppQuitting = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDebugPort(timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: controller.signal });
      clearTimeout(timer);
      if (r.ok) return true;
    } catch {}
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
async function listPages(timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data.filter(t => t.type === 'page') : [];
  } catch {
    return [];
  }
}

function cdpSession(wsUrl, connectTimeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let ws;
    let timer = null;
    let isSettled = false;
    let id = 0;
    const pending = new Map();

    const cleanup = (err) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!isSettled) {
        isSettled = true;
        reject(err || new Error('CDP connection failed'));
      }
      // 대기 중인 모든 프로미스 거부 및 메모리 정리 (hang 방지)
      for (const [, entry] of pending.entries()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(err || new Error('CDP session closed'));
      }
      pending.clear();
    };

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return reject(e);
    }

    timer = setTimeout(() => {
      try { ws.close(); } catch {}
      cleanup(new Error(`CDP connection timeout (${connectTimeoutMs}ms)`));
    }, connectTimeoutMs);

    ws.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
          const entry = pending.get(m.id);
          if (entry.timer) clearTimeout(entry.timer);
          entry.resolve(m);
          pending.delete(m.id);
        }
      } catch (err) {
        console.error('Failed to parse CDP message:', err);
      }
    };

    ws.onerror = err => {
      cleanup(err instanceof Error ? err : new Error('CDP WebSocket error'));
    };

    ws.onclose = () => {
      cleanup(new Error('CDP WebSocket closed'));
    };

    ws.onopen = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      isSettled = true;
      resolve({
        send: (method, params = {}, cmdTimeoutMs = 5000) => new Promise((res, rej) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return rej(new Error(`Cannot send ${method}: WebSocket not open`));
          }
          const i = ++id;
          const cmdTimer = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP command ${method} timeout (${cmdTimeoutMs}ms)`));
          }, cmdTimeoutMs);
          pending.set(i, { resolve: res, reject: rej, timer: cmdTimer });
          ws.send(JSON.stringify({ id: i, method, params }));
        }),
        close: () => {
          try { ws.close(); } catch {}
        },
      });
    };
  });
}

async function sendTo(site, text) {
  const page = (await listPages()).find(t => t.url.includes(site.host));
  if (!page) return false;
  let s;
  try {
    s = await cdpSession(page.webSocketDebuggerUrl);
  } catch {
    return false;
  }
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
  } catch (err) {
    console.error(`Failed to send prompt to ${site.name}:`, err);
    return false;
  } finally {
    if (s) s.close();
  }
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

async function minimizeChromeWindows() {
  const pages = await (listPages().catch(() => []));
  for (const site of SITES) {
    const page = pages.find(t => t.url.includes(site.host));
    if (!page) continue;
    try {
      const s = await cdpSession(page.webSocketDebuggerUrl);
      const w = await s.send('Browser.getWindowForTarget');
      if (w.result?.windowId !== undefined) {
        await s.send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'minimized' } });
      }
      s.close();
    } catch {}
  }
}

async function restoreChromeWindows(wa) {
  const pages = await (listPages().catch(() => []));
  for (const site of SITES) {
    const page = pages.find(t => t.url.includes(site.host));
    if (!page) continue;
    try {
      const s = await cdpSession(page.webSocketDebuggerUrl);
      const w = await s.send('Browser.getWindowForTarget');
      if (w.result?.windowId !== undefined) {
        await s.send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'normal' } });
      }
      s.close();
    } catch {}
  }
  if (wa) await tileWindows(wa).catch(() => {});
}

async function closeChromeWindows() {
  const pages = await (listPages().catch(() => []));
  for (const site of SITES) {
    const page = pages.find(t => t.url.includes(site.host));
    if (!page) continue;
    try {
      const s = await cdpSession(page.webSocketDebuggerUrl);
      await s.send('Page.close');
      s.close();
    } catch {}
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
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.ico'))
      ? path.join(__dirname, 'build', 'icon.ico')
      : path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  bar.loadFile(path.join(__dirname, 'bar.html'));

  // 공용 프롬프트 바 최소화/복원 시 크롬 창도 함께 내리고 올리기
  let syncState = false;
  bar.on('minimize', async () => {
    if (syncState) return;
    syncState = true;
    await minimizeChromeWindows().catch(() => {});
    syncState = false;
  });
  bar.on('restore', async () => {
    if (syncState) return;
    syncState = true;
    await restoreChromeWindows(currentDisplay().workArea).catch(() => {});
    syncState = false;
  });
  bar.on('close', async () => {
    await closeChromeWindows().catch(() => {});
  });

  // 모니터 연결/해제 시 프롬프트 바에 실시간 통지
  const notifyMonitorCount = () => {
    if (bar && !bar.isDestroyed()) {
      bar.webContents.send('monitor-changed', screen.getAllDisplays().length);
    }
  };
  screen.on('display-added', notifyMonitorCount);
  screen.on('display-removed', notifyMonitorCount);

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

  let notepadWindow = null;
  const NOTEPAD_WIDTH = 880;
  const NOTEPAD_HEIGHT = 640;

  // 창을 모니터 작업 영역 중앙에 배치하는 범용 헬퍼 함수
  function centerWindowOnDisplay(win, width, height, disp) {
    if (!win || win.isDestroyed()) return;
    const a = disp.workArea;
    const x = Math.round(a.x + (a.width - width) / 2);
    const y = Math.round(a.y + Math.max(20, (a.height - BAR_HEIGHT - height) / 2));
    win.setBounds({ x, y, width, height });
  }

  function createNotepadWindow() {
    notepadWindow = new BrowserWindow({
      width: NOTEPAD_WIDTH,
      height: NOTEPAD_HEIGHT,
      frame: false,
      resizable: true,
      minWidth: 640,
      minHeight: 480,
      alwaysOnTop: true,
      show: false,
      title: 'LLM 워크스페이스 메모장 & UI 스케치',
      icon: fs.existsSync(path.join(__dirname, 'build', 'icon.ico'))
        ? path.join(__dirname, 'build', 'icon.ico')
        : path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-notepad.js'),
      },
    });
    notepadWindow.loadFile(path.join(__dirname, 'notepad.html'));
    
    // 창 닫기(X) 시 완전히 닫지 않고 숨기기(hide)로 처리하여 재오픈 시 즉시 반응
    notepadWindow.on('close', (e) => {
      if (!isAppQuitting) {
        e.preventDefault();
        notepadWindow.hide();
      }
    });
  }

  createNotepadWindow();

  // ---- 독립 전면 설정 창 (사이트 & 스킬 관리) ----
  let settingsWindow = null;
  const SETTINGS_WIDTH = 800;
  const SETTINGS_HEIGHT = 600;

  function createSettingsWindow() {
    settingsWindow = new BrowserWindow({
      width: SETTINGS_WIDTH,
      height: SETTINGS_HEIGHT,
      frame: false,
      resizable: true,
      minWidth: 680,
      minHeight: 500,
      alwaysOnTop: true,
      show: false,
      title: 'CTR 설정 - 사이트 및 스킬 문서 관리',
      icon: fs.existsSync(path.join(__dirname, 'build', 'icon.ico'))
        ? path.join(__dirname, 'build', 'icon.ico')
        : path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-settings.js'),
      },
    });
    settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

    settingsWindow.on('close', (e) => {
      if (!isAppQuitting) {
        e.preventDefault();
        settingsWindow.hide();
      }
    });
  }

  createSettingsWindow();

  const DATA_DIR = path.join(app.getPath('userData'), 'ctr-data');
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  }
  const SITES_FILE = path.join(DATA_DIR, 'sites.json');
  const SKILLS_FILE = path.join(DATA_DIR, 'skills.json');

  const DEFAULT_SITES_LIST = [
    { name: 'Google', url: 'https://www.google.com' },
    { name: 'YouTube', url: 'https://www.youtube.com' },
    { name: 'GitHub', url: 'https://github.com' }
  ];

  const DEFAULT_SKILLS_LIST = [
    {
      id: 'skill-1',
      name: '요약',
      title: '요약',
      trigger: '/요약',
      content: '[지시사항]\n제공된 내용의 핵심 요점을 누락 없이 간결한 3줄로 명확하게 요약해 주세요.'
    },
    {
      id: 'skill-2',
      name: '번역',
      title: '번역',
      trigger: '/번역',
      content: '[지시사항]\n원문의 뉘앙스를 자연스럽고 유려한 현대 한국어 비즈니스 스타일로 번역해 주세요.'
    },
    {
      id: 'skill-3',
      name: '코드리뷰',
      title: '코드리뷰',
      trigger: '/코드리뷰',
      content: '[지시사항]\n다음 코드의 잠재적 버그, 가독성, 예외 처리, 성능 최적화 포인트를 단계별로 점검하고 리팩토링 제안을 작성해 주세요.'
    }
  ];

  async function safeReadJson(filePath, fallbackData) {
    try {
      if (fs.existsSync(filePath)) {
        const text = await fs.promises.readFile(filePath, 'utf-8');
        return JSON.parse(text);
      }
    } catch (err) {
      console.error(`Error reading JSON from ${filePath}:`, err);
    }
    return fallbackData;
  }

  async function safeWriteJson(filePath, data) {
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error(`Error writing JSON to ${filePath}:`, err);
      return false;
    }
  }

  async function readSitesData() {
    const data = await safeReadJson(SITES_FILE, DEFAULT_SITES_LIST);
    return Array.isArray(data) && data.length > 0 ? data : DEFAULT_SITES_LIST;
  }

  async function writeSitesData(data) {
    return safeWriteJson(SITES_FILE, data);
  }

  async function readSkillsData() {
    const raw = await safeReadJson(SKILLS_FILE, DEFAULT_SKILLS_LIST);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map(s => {
        const cleanName = (s.name || (s.trigger ? s.trigger.replace(/^\//, '') : s.title) || '').trim();
        return {
          ...s,
          name: cleanName,
          title: cleanName,
          trigger: '/' + cleanName
        };
      });
    }
    return DEFAULT_SKILLS_LIST;
  }

  async function writeSkillsData(data) {
    return safeWriteJson(SKILLS_FILE, data);
  }

  ipcMain.handle('send-prompt', async (_e, { text, targets }) => {
    await ensureWindows().catch(() => {});
    const results = {};
    const effectiveTargets = targets || [true, true, true];
    await Promise.all(SITES.map(async (site, i) => {
      if (!effectiveTargets[i]) return;
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
  // 현재 연결된 모니터 개수 반환 (단일 모니터 vs 듀얼 모니터 판별)
  ipcMain.handle('get-monitor-count', () => {
    return screen.getAllDisplays().length;
  });
  // 전체 최소화 (입력창 + 3개 LLM 창 함께 내리기)
  ipcMain.handle('minimize-all', async () => {
    if (notepadWindow && !notepadWindow.isDestroyed() && notepadWindow.isVisible()) {
      notepadWindow.hide();
    }
    await minimizeChromeWindows().catch(() => {});
    bar.minimize();
    return true;
  });
  // 전체 종료 (입력창 + 3개 LLM 창 함께 닫기)
  ipcMain.handle('close-all', async () => {
    isAppQuitting = true;
    if (notepadWindow && !notepadWindow.isDestroyed()) {
      notepadWindow.destroy();
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
    }
    await closeChromeWindows().catch(() => {});
    app.quit();
  });

  // 메모장 열기/닫기 토글
  ipcMain.handle('toggle-notepad', () => {
    if (!notepadWindow || notepadWindow.isDestroyed()) {
      createNotepadWindow();
    }
    if (notepadWindow.isVisible()) {
      notepadWindow.hide();
      return false;
    } else {
      centerWindowOnDisplay(notepadWindow, NOTEPAD_WIDTH, NOTEPAD_HEIGHT, currentDisplay());
      notepadWindow.show();
      notepadWindow.focus();
      return true;
    }
  });

  ipcMain.on('hide-notepad', () => {
    if (notepadWindow && !notepadWindow.isDestroyed()) {
      notepadWindow.hide();
    }
  });

  // 전용 설정 창 열기/닫기 토글
  ipcMain.handle('toggle-settings', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      createSettingsWindow();
    }
    if (settingsWindow.isVisible()) {
      settingsWindow.hide();
      return false;
    } else {
      centerWindowOnDisplay(settingsWindow, SETTINGS_WIDTH, SETTINGS_HEIGHT, currentDisplay());
      settingsWindow.show();
      settingsWindow.focus();
      return true;
    }
  });

  ipcMain.on('hide-settings', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.hide();
    }
  });

  ipcMain.handle('toggle-maximize-settings', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return false;
    if (settingsWindow.isMaximized()) {
      settingsWindow.unmaximize();
      return false;
    } else {
      settingsWindow.maximize();
      return true;
    }
  });

  // 사이트 및 스킬 데이터 IPC 핸들러 (실시간 동기화 브로드캐스트 포함)
  ipcMain.handle('get-sites', async () => readSitesData());
  ipcMain.handle('save-sites', async (_e, sites) => {
    await writeSitesData(sites);
    if (bar && !bar.isDestroyed()) {
      bar.webContents.send('sync-data', { type: 'sites', data: sites });
    }
    return true;
  });

  ipcMain.handle('get-skills', async () => readSkillsData());
  ipcMain.handle('save-skills', async (_e, skills) => {
    await writeSkillsData(skills);
    if (bar && !bar.isDestroyed()) {
      bar.webContents.send('sync-data', { type: 'skills', data: skills });
    }
    return true;
  });

  // 메모장 창 최대화/이전 크기 복원 토글
  ipcMain.handle('toggle-maximize-notepad', () => {
    if (!notepadWindow || notepadWindow.isDestroyed()) return false;
    if (notepadWindow.isMaximized()) {
      notepadWindow.unmaximize();
      return false;
    } else {
      notepadWindow.maximize();
      return true;
    }
  });

  // 텍스트 클립보드 복사
  ipcMain.handle('copy-text', (_e, text) => {
    clipboard.writeText(text || '');
    return true;
  });

  // 캔버스 이미지 클립보드 복사 (PNG 이미지 + HTML img 태그 동시 복사로 모든 웹/앱 붙여넣기 100% 호환)
  ipcMain.handle('copy-image', (_e, dataUrl) => {
    try {
      const base64Data = (dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const img = nativeImage.createFromBuffer(buffer);
      clipboard.write({
        image: img,
        html: `<img src="${dataUrl}">`,
      });
      return true;
    } catch (err) {
      console.error('Failed to copy image to clipboard:', err);
      return false;
    }
  });

  // 텍스트 파일 저장 다이얼로그 (비동기 논블로킹 I/O)
  ipcMain.handle('save-text-file', async (_e, text) => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(notepadWindow || bar, {
        title: '텍스트 메모 저장',
        defaultPath: path.join(app.getPath('documents'), `prompt-memo-${Date.now()}.txt`),
        filters: [
          { name: 'Text Files (*.txt)', extensions: ['txt'] },
          { name: 'All Files (*.*)', extensions: ['*'] },
        ],
      });
      if (canceled || !filePath) return { success: false, canceled: true };
      await fs.promises.writeFile(filePath, text || '', 'utf-8');
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 이미지 파일 저장 다이얼로그 (비동기 논블로킹 I/O)
  ipcMain.handle('save-image-file', async (_e, dataUrl) => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(notepadWindow || bar, {
        title: 'UI 스케치 이미지 저장',
        defaultPath: path.join(app.getPath('pictures'), `ui-sketch-${Date.now()}.png`),
        filters: [
          { name: 'PNG Images (*.png)', extensions: ['png'] },
          { name: 'All Files (*.*)', extensions: ['*'] },
        ],
      });
      if (canceled || !filePath) return { success: false, canceled: true };
      const base64Data = (dataUrl || '').replace(/^data:image\/png;base64,/, '');
      await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'));
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 메모장에서 하단 제어기로 텍스트 주입
  ipcMain.handle('send-to-control-bar', (_e, text) => {
    if (bar && !bar.isDestroyed()) {
      bar.webContents.send('set-prompt', text);
    }
    return true;
  });

  // Windows 파일 탐색기 열기 (기본 위치: 내 PC / 드라이브 선택)
  ipcMain.handle('open-explorer', () => {
    try {
      spawn('explorer.exe', ['shell:MyComputerFolder'], { detached: true }).unref();
      return true;
    } catch (e) {
      console.error('Failed to open explorer:', e);
      return false;
    }
  });

  // 브라우저로 사이트 URL 열기
  ipcMain.handle('open-url', (_e, targetUrl) => {
    if (!targetUrl) return false;
    try {
      let finalUrl = targetUrl.trim();
      if (!/^https?:\/\//i.test(finalUrl)) {
        finalUrl = 'https://' + finalUrl;
      }
      shell.openExternal(finalUrl);
      return true;
    } catch (e) {
      console.error('Failed to open URL:', e);
      return false;
    }
  });

  // CTR 높이 확장/축소 토글 (위쪽으로 패널 펼치기 - 숫자 전달 시 지정 높이로 확장)
  ipcMain.handle('set-bar-height', (_e, customHeightOrExpanded) => {
    if (!bar || bar.isDestroyed()) return 120;
    try {
      const disp = currentDisplay();
      const wa = disp.workArea;
      let targetHeight = 120;
      if (typeof customHeightOrExpanded === 'number') {
        targetHeight = customHeightOrExpanded;
      } else if (customHeightOrExpanded) {
        targetHeight = 200;
      }
      const targetY = wa.y + wa.height - targetHeight;
      bar.setBounds({
        x: wa.x,
        y: targetY,
        width: wa.width,
        height: targetHeight,
      });
      return targetHeight;
    } catch (e) {
      console.error('Failed to set bar height:', e);
      return 120;
    }
  });

  // 시작: 이미 열린 창은 재사용하고, 없는 창만 열어 3분할 배치
  await ensureWindows().catch(() => {});
  for (let n = 0; n < 3; n++) { await sleep(1000); await layoutOn(currentDisplay()).catch(() => {}); }
});

app.on('window-all-closed', () => app.quit());

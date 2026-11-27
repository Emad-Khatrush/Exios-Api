// The Chrome that runs WhatsApp Web on the dyno, kept small (owner 2026-11-27: a QR scan took the
// dyno to 200% memory; after a link WhatsApp Web loads every chat with its contact photo).

// Every Chrome process on the dyno: the browser, its renderers, the GPU/network/utility helpers and
// crashpad. Their command lines start with the Chrome binary; only the browser's carries the profile
// path (wwebjs_auth), so counting by that path alone missed the renderers that hold the chats.
const CHROME_PATTERN = /(^|\/)chrome(-linux64\/chrome|_crashpad_handler)?(\s|$)|chrome-linux64\/chrome/;

function chromeArgs({ singleProcess = true } = {}) {
  return [
    // Run browser, renderer, GPU and utility work in one process instead of 5-8, removing
    // per-process overhead (biggest single saving).
    ...(singleProcess ? ['--single-process', '--no-zygote'] : []),
    '--renderer-process-limit=1',
    '--disable-site-isolation-trials',
    // No images: after a link WhatsApp Web shows every chat with its contact photo and media
    // thumbnails, each one decoded in memory. The server sends images itself (downloaded in Node),
    // and the QR is read from the page's data, so nothing it needs is an image.
    '--blink-settings=imagesEnabled=false',
    // Chrome's reduced-memory mode (smaller caches, lower-res buffers).
    '--enable-low-end-device-mode',
    // Chrome only honours the LAST --disable-features flag, so keep one.
    '--disable-features=site-per-process,IsolateOrigins,TranslateUI,Translate,BackForwardCache,MediaRouter,OptimizationHints,AudioServiceOutOfProcess,AutofillServerCommunication,CertificateTransparencyComponentUpdater,PaintHolding,DialMediaRouteProvider',
    '--js-flags=--max-old-space-size=256 --optimize-for-size',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-accelerated-2d-canvas',
    '--disable-dev-shm-usage',
    '--disable-cache',
    '--disk-cache-size=1',
    '--media-cache-size=1',
    '--aggressive-cache-discard',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    '--mute-audio',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-hang-monitor',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--disable-prompt-on-repost',
    // Keep WhatsApp's timers running at full speed in a headless tab.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--ignore-certificate-errors',
    '--log-level=3',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ];
}

// `ps -eo rss=,args=` output → the memory of every Chrome process, in MB, and how many there are
function chromeMemoryMb(psOutput) {
  let kb = 0;
  let processes = 0;
  for (const line of String(psOutput || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !CHROME_PATTERN.test(match[2])) continue;
    kb += Number(match[1]);
    processes += 1;
  }
  return { mb: Math.round(kb / 1024), processes };
}

// The dyno's Chrome memory now (Linux only; elsewhere nothing is counted)
function readChromeMemory() {
  if (process.platform !== 'linux') return { mb: 0, processes: 0 };
  try {
    return chromeMemoryMb(require('child_process').execSync('ps -eo rss=,args=', { encoding: 'utf8', timeout: 3000 }));
  } catch (_) {
    return { mb: 0, processes: 0 };
  }
}

module.exports = { chromeArgs, chromeMemoryMb, readChromeMemory, CHROME_PATTERN };

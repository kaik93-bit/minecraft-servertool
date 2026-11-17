// Öffnet die Oberfläche als eigenständiges App-Fenster (Edge/Chrome "--app"-Modus:
// keine Adressleiste, keine Tabs – sieht aus wie ein normales Programm).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function findBrowser() {
  const env = process.env;
  const candidates = [
    path.join(env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function openAppWindow(url) {
  if (process.env.MCST_NO_WINDOW === '1') return console.log(`(Fenster unterdrückt) ${url}`); // für Tests
  const opts = { detached: true, stdio: 'ignore', windowsHide: false };
  try {
    if (process.platform === 'win32') {
      const browser = findBrowser();
      if (browser) {
        spawn(browser, [`--app=${url}`, '--window-size=1400,900'], opts).unref();
      } else {
        spawn('explorer.exe', [url], opts).unref(); // Standardbrowser
      }
    } else if (process.platform === 'darwin') {
      spawn('open', [url], opts).unref();
    } else {
      spawn('xdg-open', [url], opts).unref();
    }
  } catch (err) {
    console.error('Fenster konnte nicht geöffnet werden:', err.message);
  }
}

module.exports = { openAppWindow };

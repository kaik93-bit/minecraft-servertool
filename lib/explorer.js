// Öffnet einen Ordner im Windows-Explorer und holt das Fenster in den Vordergrund.
// Ist der Ordner schon offen, wird das vorhandene Fenster nach vorne geholt (kein zweites Fenster).
//
// Windows verbietet Hintergrundprogrammen normalerweise, Fenster nach vorne zu holen
// (das Fenster blinkt dann nur in der Taskleiste). Deshalb:
//  1. AttachThreadInput-Trick + SetForegroundWindow
//  2. Fallback: SwitchToThisWindow
const { execFile, spawn } = require('child_process');

const SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class McstExplorerFg {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  public static bool Force(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); // minimiert -> wiederherstellen
    uint pid;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
    if (GetForegroundWindow() != h) SwitchToThisWindow(h, true);
    return GetForegroundWindow() == h;
  }
}
'@
$target = [IO.Path]::GetFullPath($env:MCST_PATH).TrimEnd('\\')
$shell = New-Object -ComObject Shell.Application
function Find-ExplorerWindow {
  foreach ($w in @($shell.Windows())) {
    try {
      $p = $w.Document.Folder.Self.Path
      if ($p -and ($p.TrimEnd('\\') -ieq $target)) { return $w }
    } catch {}
  }
  return $null
}
$win = Find-ExplorerWindow
$opened = $false
if ($env:MCST_TEST -eq '1') { Write-Output ('test:windows=' + @($shell.Windows()).Count + ';found=' + [bool]$win); exit }
if (-not $win) {
  Start-Process explorer.exe -ArgumentList ('"' + $target + '"')
  $opened = $true
  for ($i = 0; $i -lt 40 -and -not $win; $i++) { Start-Sleep -Milliseconds 150; $win = Find-ExplorerWindow }
}
if ($win) {
  Start-Sleep -Milliseconds 100
  $ok = [McstExplorerFg]::Force([IntPtr]([long]$win.HWND))
  Write-Output ('ok;opened=' + $opened + ';front=' + $ok)
} else {
  Write-Output ('notfound;opened=' + $opened)
}
`;

function openFolder(dir) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
      return resolve('opened');
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, MCST_PATH: dir } },
      (err, stdout) => {
        if (err) {
          // Notfall: einfach öffnen (dann evtl. ohne Vordergrund)
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
          return resolve('fallback');
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

module.exports = { openFolder, SCRIPT };

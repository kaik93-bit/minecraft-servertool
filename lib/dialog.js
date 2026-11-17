// Öffnet den nativen Windows-Dialog "Datei öffnen" bzw. "Ordner auswählen"
// (das Tool läuft lokal, daher erscheint der Dialog auf deinem Bildschirm).
//
// Der Dialog bleibt im Vordergrund, bis man etwas auswählt oder abbricht:
//  - er gehört zu einem unsichtbaren "TopMost"-Fenster (immer oben),
//  - und wird aktiv in den Vordergrund geholt (AttachThreadInput-Trick, da Windows
//    Hintergrundprozessen das sonst verbietet).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRELUDE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class McstForeground {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  public static void Force(IntPtr h) {
    uint pid;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
  }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[System.Windows.Forms.Application]::EnableVisualStyles()

# Unsichtbares Besitzer-Fenster, immer im Vordergrund
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
[McstForeground]::Force($owner.Handle)
$owner.Activate()
`;

const FILE_SCRIPT = `${PRELUDE}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Minecraft-Server-Datei auswählen (server.jar, run.bat, ...)'
$d.Filter = 'Server-Startdatei (*.jar;*.bat;*.cmd)|*.jar;*.bat;*.cmd|Alle Dateien (*.*)|*.*'
if ($env:MCST_INITIAL -and (Test-Path -LiteralPath $env:MCST_INITIAL)) { $d.InitialDirectory = $env:MCST_INITIAL }
if ($env:MCST_TEST -ne '1') {
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
}
$owner.Close()
`;

const FOLDER_SCRIPT = `${PRELUDE}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Ordner auswählen'
$d.ShowNewFolderButton = $true
if ($env:MCST_INITIAL -and (Test-Path -LiteralPath $env:MCST_INITIAL)) { $d.SelectedPath = $env:MCST_INITIAL }
if ($env:MCST_TEST -ne '1') {
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
}
$owner.Close()
`;

let open = false;

function browse(type = 'file', initial = '') {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(Object.assign(new Error('Der Auswahldialog gibt es nur unter Windows – bitte den Pfad eintippen.'), { status: 501 }));
    }
    if (open) return reject(Object.assign(new Error('Es ist bereits ein Auswahldialog geöffnet.'), { status: 409 }));
    open = true;

    let start = initial ? path.resolve(initial) : '';
    if (start && fs.existsSync(start) && fs.statSync(start).isFile()) start = path.dirname(start);

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', type === 'folder' ? FOLDER_SCRIPT : FILE_SCRIPT],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env, MCST_INITIAL: start }, timeout: 30 * 60 * 1000 },
      (err, stdout, stderr) => {
        open = false;
        if (err) return reject(new Error(`Dialog konnte nicht geöffnet werden: ${String(stderr || err.message).trim()}`));
        const result = String(stdout).trim();
        resolve(result || null); // null = abgebrochen
      }
    );
  });
}

module.exports = { browse, FILE_SCRIPT, FOLDER_SCRIPT };

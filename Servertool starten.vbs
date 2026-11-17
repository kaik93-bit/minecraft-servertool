' Startet das Minecraft Servertool ohne Konsolenfenster
' und oeffnet die Oberflaeche als eigenes App-Fenster.
' Nutzt ein mitgeliefertes Node.js (Ordner "node"), sonst ein installiertes.
Option Explicit
Dim sh, fso, dir, nodeExe, npmCmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

If fso.FileExists(dir & "\node\node.exe") Then
  nodeExe = """" & dir & "\node\node.exe"""
  npmCmd = nodeExe & " """ & dir & "\node\node_modules\npm\bin\npm-cli.js"" install --omit=dev"
Else
  If sh.Run("cmd /c where node >nul 2>&1", 0, True) <> 0 Then
    MsgBox "Node.js wurde nicht gefunden. Bitte von https://nodejs.org installieren.", 16, "Minecraft Servertool"
    WScript.Quit 1
  End If
  nodeExe = "node"
  npmCmd = "npm install --omit=dev"
End If

' Falls Abhaengigkeiten fehlen: einmalig installieren (kurz sichtbar)
If Not fso.FolderExists(dir & "\node_modules") Then
  sh.Run "cmd /c echo Installiere Abhaengigkeiten (einmalig) ... & " & npmCmd, 1, True
End If

sh.Run nodeExe & " server.js --detach", 0, False

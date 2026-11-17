@echo off
cd /d "%~dp0"
set "NODE=node"
if exist "node\node.exe" set "NODE=%~dp0node\node.exe"
if not exist node_modules (
  echo Installiere Abhaengigkeiten ...
  if exist "node\node.exe" ("%NODE%" "node\node_modules\npm\bin\npm-cli.js" install --omit=dev) else (call npm install --omit=dev)
)
"%NODE%" server.js --detach

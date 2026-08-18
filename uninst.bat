@echo off
REM screenshared - desinstalador (Windows)
REM Apaga o que o programa baixou e criou. Nada foi instalado no sistema,
REM entao nao ha registro nem Painel de Controle envolvido.
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   screenshared - desinstalar
echo.
echo   Vai apagar desta pasta:
echo.

set "ACHOU="
if exist "bin\cloudflared.exe" (
  for %%F in ("bin\cloudflared.exe") do set /a MB=%%~zF/1048576
  echo     bin\cloudflared.exe          ^(!MB! MB^)
  set "ACHOU=1"
)
if exist "bin\node" (
  echo     bin\node\                     ^(copia portatil do Node^)
  set "ACHOU=1"
)
if exist "bin" if not exist "bin\cloudflared.exe" if not exist "bin\node" (
  echo     bin\
  set "ACHOU=1"
)
if exist "screenshared.config.json" (
  echo     screenshared.config.json      ^(App ID do Discord, convite, texto^)
  set "ACHOU=1"
)
if exist "tunnel.log" (
  echo     tunnel.log
  set "ACHOU=1"
)

if not defined ACHOU (
  echo     nada. Ja esta limpo.
  echo.
  pause
  exit /b 0
)

echo.
echo   O codigo em si ^(server.js, run.js, public\^) NAO sera apagado.
echo   Para sumir de vez, apague esta pasta depois.
echo.
set /p RESP=  Confirma? [s/N]
if /i not "%RESP%"=="s" (
  echo.
  echo   Cancelado, nada foi apagado.
  echo.
  pause
  exit /b 0
)

echo.
REM mata so o cloudflared desta pasta - o de outro projeto nao e' problema nosso
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=(Get-Location).Path; Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.StartsWith($p) } | ForEach-Object { Write-Host '  Encerrando cloudflared desta pasta...'; Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }" 2>nul

if exist "bin" (
  rmdir /s /q "bin"
  if exist "bin" (echo   x nao consegui apagar bin\ - feche o programa e rode de novo) else (echo   - bin\ apagado)
)
if exist "screenshared.config.json" (
  del /q "screenshared.config.json"
  echo   - screenshared.config.json apagado
)
if exist "tunnel.log" (
  del /q "tunnel.log"
  echo   - tunnel.log apagado
)

echo.
echo   Pronto. Sobrou so o codigo; apague a pasta se quiser remover tudo.
echo.
pause
exit /b 0

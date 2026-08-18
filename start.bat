@echo off
REM telar - inicia o espelhamento de tela (Windows)
REM Primeira execucao se vira sozinha: se nao houver Node, baixa uma copia
REM portatil para bin\ e usa ela. Nada e instalado no sistema.
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODEVER=v22.20.0"
set "NODE="

REM 1) Node ja instalado e novo o bastante?
where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NMAJOR=%%v"
  if defined NMAJOR if !NMAJOR! GEQ 16 set "NODE=node"
)

REM 2) copia portatil de uma execucao anterior?
if not defined NODE if exist "bin\node\node.exe" set "NODE=bin\node\node.exe"

REM 3) baixar
if not defined NODE goto getnode
goto run

:getnode
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "NARCH=arm64") else (set "NARCH=x64")
set "PKG=node-%NODEVER%-win-%NARCH%"
echo.
echo   Node.js nao encontrado no sistema.
echo   Baixando uma copia portatil para bin\ ^(~30 MB, so desta vez^)...
echo.

if not exist "bin" mkdir "bin"
curl -fsSL -o "bin\node.zip" "https://nodejs.org/dist/%NODEVER%/%PKG%.zip"
if errorlevel 1 goto nonode
if not exist "bin\node.zip" goto nonode

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath 'bin\node.zip' -DestinationPath 'bin' -Force"
if errorlevel 1 goto nonode

del /q "bin\node.zip" >nul 2>nul
if exist "bin\node" rmdir /s /q "bin\node"
move "bin\%PKG%" "bin\node" >nul
if not exist "bin\node\node.exe" goto nonode

echo   Node portatil pronto em bin\node
set "NODE=bin\node\node.exe"

:run
"%NODE%" run.js %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" pause
exit /b %EXITCODE%

:nonode
echo.
echo   Nao consegui preparar o Node.js automaticamente.
echo.
echo   Baixe o instalador LTS em https://nodejs.org, instale,
echo   feche esta janela, abra de novo e rode este arquivo.
echo.
pause
exit /b 1

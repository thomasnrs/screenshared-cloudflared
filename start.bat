@echo off
REM telar - inicia o espelhamento de tela (Windows)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set NODEMAJOR=%%v
if not defined NODEMAJOR goto nonode
if %NODEMAJOR% LSS 16 goto oldnode

node run.js %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" pause
exit /b %EXITCODE%

:nonode
echo.
echo   Node.js nao encontrado.
echo.
echo   Baixe o instalador LTS em https://nodejs.org e rode este arquivo de novo.
echo   Se ja instalou agora, feche e reabra esta janela.
echo.
pause
exit /b 1

:oldnode
echo.
echo   Node.js muito antigo (versao %NODEMAJOR%). Precisa da 16 ou mais nova.
echo   Atualize em https://nodejs.org
echo.
pause
exit /b 1

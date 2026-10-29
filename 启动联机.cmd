@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or later is required. Please install Node.js and try again.
  pause
  popd
  exit /b 1
)
echo Starting Mind Meld. Keep this window open while playing.
echo Open the local address, create a room, and send the LAN invitation to your friend.
node server.cjs
popd
pause

@echo off
echo ============================================
echo   Claude Runner — Update
echo ============================================
echo.

echo [1/4] Stopping bot...
taskkill /f /im node.exe 2>nul
timeout /t 2 /nobreak >nul

echo [2/4] Pulling latest changes...
git pull
if errorlevel 1 (
    echo ERROR: git pull failed. Check your git configuration.
    pause
    exit /b 1
)

echo [3/4] Installing dependencies...
npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo [4/4] Starting bot...
echo.
echo ============================================
echo   Update complete — starting bot...
echo ============================================
npm run bot

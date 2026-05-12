@echo off
echo ============================================
echo  Volkswagen Hazard Detection System
echo ============================================

:: Start backend
echo [1/2] Starting FastAPI backend on port 8000...
start "VW Backend" cmd /k "cd /d %~dp0backend && python -m uvicorn main:app --reload --port 8000"

:: Wait for backend to start
timeout /t 3 /nobreak >nul

:: Start frontend
echo [2/2] Starting React frontend on port 5173...
start "VW Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Backend:  http://localhost:8000
echo Frontend: http://localhost:5173
echo API Docs: http://localhost:8000/docs
echo.
echo Both services started. Close this window to stop.
pause

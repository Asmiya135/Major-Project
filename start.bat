@echo off
echo ============================================================
echo  Volkswagen Hazard Detection — full demo on one laptop
echo    Global server  : http://localhost:8000
echo    Car A (models) : http://localhost:8001
echo    Car B (BT rx)  : http://localhost:8002
echo    UI             : http://localhost:5173
echo ============================================================

start "SERVER (global)" cmd /k call "%~dp0start_server.bat"
timeout /t 3 /nobreak >nul
start "CAR A" cmd /k call "%~dp0start_car.bat" car-A 8001
set WARMUP_MODELS=0
start "CAR B" cmd /k call "%~dp0start_car.bat" car-B 8002
start "UI" /d "%~dp0frontend" cmd /k npm run dev
timeout /t 8 /nobreak >nul

echo.
echo  Car A live detection : http://localhost:5173/pipeline
echo  Car B (2nd tab)      : http://localhost:5173/pipeline?edge=8002
echo  Trip / navigation    : http://localhost:5173/
echo  Global server console: http://localhost:5173/server
start "" "http://localhost:5173/pipeline?edge=8001"
start "" "http://localhost:5173/pipeline?edge=8002"
start "" "http://localhost:5173/server"
pause

@echo off
:: ===== LAPTOP 1: GLOBAL SERVER =====
:: Starts the server (port 8000, reachable from the car laptops) + the UI for the server console.
echo This laptop's IP addresses (give the Wi-Fi one to the car laptops):
ipconfig | findstr /i "IPv4"
echo.
start "SERVER (global)" cmd /k "%~dp0start_server.bat"
start "UI" cmd /k "cd /d %~dp0frontend && npm run dev"
timeout /t 8 /nobreak >nul
start "" "http://localhost:5173/server"
echo Server console: http://localhost:5173/server
echo If the cars cannot reach it, allow port 8000 once (admin cmd):
echo   netsh advfirewall firewall add rule name="VW hazard server" dir=in action=allow protocol=TCP localport=8000
pause

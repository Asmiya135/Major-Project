@echo off
:: ===== LAPTOP 2 / 3: ONE CAR (client) =====
::   start_client_laptop.bat <car-name> <server-ip> [bluetooth-peer]
::   e.g. laptop 2:  start_client_laptop.bat car-A 192.168.1.20 4C:5F:70:11:22:33@4
::        laptop 3:  start_client_laptop.bat car-B 192.168.1.20 4C:5F:70:44:55:66@4
:: bluetooth-peer = the OTHER car's address, shown in its status bar Bluetooth badge (MAC@channel).
if "%~2"=="" (
  echo Usage: start_client_laptop.bat car-A ^<server-ip^> [other-car-bt-address]
  pause
  exit /b 1
)
set CLIENT_ID=%~1
set SERVER_URL=http://%~2:8000
set VITE_SERVER_URL=http://%~2:8000
set VITE_EDGE_URL=http://localhost:8001
set BT_PEERS=%~3
:: Bluetooth simulation over Wi-Fi as a backup to real Bluetooth (both run; duplicates are ignored)
set BT_SIM_IFACE=lan
if "%BT_MODE%"=="" set BT_MODE=auto
if /i "%BT_MODE%"=="rfcomm" if "%BT_PEERS%"=="" set BT_MODE=auto

echo Car %CLIENT_ID%  ->  server %SERVER_URL%   BT peer: %BT_PEERS%
start "CAR %CLIENT_ID%" cmd /k call "%~dp0start_car.bat" %CLIENT_ID% 8001
start "UI" /d "%~dp0frontend" cmd /k npm run dev
timeout /t 10 /nobreak >nul
start "" "http://localhost:5173/pipeline?edge=8001"
pause

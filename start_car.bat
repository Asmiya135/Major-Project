@echo off
:: CLIENT (car) edge agent — runs every model on the car.
::   start_car.bat car-A 8001
::   start_car.bat car-B 8002
:: Optional env before calling:
::   SERVER_URL=http://<server-ip>:8000      (when the server is on another laptop)
::   BT_PEERS=AA:BB:CC:DD:EE:FF@4            (real Bluetooth RFCOMM peer car(s), comma separated)
::   ANTHROPIC_API_KEY=...                   (GenAI verification questions; template otherwise)
::   WARMUP_MODELS=0                         (car that only receives Bluetooth alerts)
set CLIENT_ID=%1
set EDGE_PORT=%2
if "%CLIENT_ID%"=="" set CLIENT_ID=car-A
if "%EDGE_PORT%"=="" set EDGE_PORT=8001
cd /d "%~dp0backend"
echo Car %CLIENT_ID% edge agent on http://localhost:%EDGE_PORT%
"%~dp0backend\venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port %EDGE_PORT%

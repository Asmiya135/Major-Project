@echo off
:: GLOBAL SERVER — one instance for all cars (port 8000)
cd /d %~dp0server
echo Global server on http://localhost:8000  (API docs: /docs)
"%~dp0backend\venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8000

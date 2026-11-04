@echo off
:: Clean slate between demo takes. Close the SERVER / CAR windows first.
cd /d %~dp0
if exist server\data rmdir /s /q server\data
if exist backend\client_data rmdir /s /q backend\client_data
echo Demo data cleared (server reports/clusters/FL models + every car's queue and Bluetooth log).
pause

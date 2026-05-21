@echo off
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "127.0.0.1:8788.*LISTEN"') do taskkill /F /PID %%a >nul 2>&1
echo r2c-proxy stopped.

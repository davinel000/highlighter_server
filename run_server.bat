@echo off
setlocal

if not exist ".venv\Scripts\activate.bat" (
    echo Virtual environment not found. Create it with: python -m venv .venv
    exit /b 1
)

set "HOST_IP="
for /f "usebackq tokens=* delims=" %%I in (`powershell -NoProfile -Command "$ip = Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notmatch '^(127|169\.254)' } ^| Select-Object -First 1 -ExpandProperty IPAddress; if($ip){Write-Output $ip}"`) do set "HOST_IP=%%I"

if not defined HOST_IP (
    set "HOST_IP=127.0.0.1"
)

call .venv\Scripts\activate.bat

set "HOST=192.168.50.100"
set "PORT=9888"

echo Detected IPv4 address: %HOST_IP%
echo Starting highlight server (reachable at http://%HOST_IP%:%PORT%) ...
python server\server.py

endlocal

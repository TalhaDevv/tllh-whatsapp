@echo off
title TLLH-WA — Terminal 2 (Node.js Bridge)
cd /d "%~dp0"

echo [TLLH-WA] Node.js Bridge baslatiliyor...

:: Node versiyon kontrolu
node --version >nul 2>&1
if errorlevel 1 (
    echo [HATA] Node.js bulunamadi. https://nodejs.org adresinden yukleyin.
    pause
    exit /b 1
)

:: Bagimliliklar yuklu mu?
if not exist node_modules (
    echo [SETUP] npm bagimliliklari yukleniyor...
    npm install
)

:: Node bridge'i baslat
echo [START] Baileys bridge baslatiliyor...
node tllh_whatsapp.js

pause
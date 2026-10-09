@echo off
title TLLH-WA — Terminal 1 (Python Core)
cd /d "%~dp0"

echo [TLLH-WA] Python Core baslatiliyor...

:: .env dosyasi yoksa ornekten kopyala
if not exist .env (
    echo [SETUP] .env bulunamadi, .env.example kopyalaniyor...
    copy .env.example .env
)

:: Sanal ortam yoksa olustur
if not exist venv_new (
    echo [SETUP] Python sanal ortami olusturuluyor...
    python -m venv venv_new
    venv_new\Scripts\python.exe -m pip install fastapi uvicorn[standard] httpx aiofiles python-multipart aiosqlite pydantic python-dotenv jinja2
)

:: Veritabani kur
echo [SETUP] Veritabani hazirlanıyor...
venv_new\Scripts\python.exe db_setup.py

:: Python core'u baslat
echo [START] FastAPI sunucusu baslatiliyor...
venv_new\Scripts\python.exe tllh_whatsapp.py

pause
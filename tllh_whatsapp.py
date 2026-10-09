"""
TLLH-WA — Python Core + FastAPI (Terminal 1)

Yerel WhatsApp köprüsünün veri ve pano tarafı.
Gelen mesajları, silinen mesajları ve tek seferlik medyayı SQLite'a yazar.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiosqlite
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

load_dotenv()

# ---------------------------------------------------------------------------
# Konfigürasyon
# ---------------------------------------------------------------------------
DB_PATH      = os.getenv("DB_PATH",          "./tllh_data.db")
HOST         = os.getenv("DASHBOARD_HOST",   "127.0.0.1")
PORT         = int(os.getenv("DASHBOARD_PORT",    "8000"))
NODE_PORT    = int(os.getenv("NODE_BRIDGE_PORT",  "3001"))
CACHE_PP_DIR = Path(os.getenv("CACHE_PATH", "./cache")) / "pp"
ARSIV_DIR    = Path(os.getenv("ARSIV_PATH", "./arsiv"))

CACHE_PP_DIR.mkdir(parents=True, exist_ok=True)
ARSIV_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Loglama — Terminal 1'e özel temiz çıktı
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("tllh")
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)


def clog(msg: str) -> None:
    """Terminal 1 icin zaman damgali temiz log."""
    try:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
    except UnicodeEncodeError:
        safe = msg.encode("ascii", errors="replace").decode("ascii")
        print(f"[{time.strftime('%H:%M:%S')}] {safe}", flush=True)


# ---------------------------------------------------------------------------
# Veritabanı yardımcıları
# ---------------------------------------------------------------------------
async def db_con() -> aiosqlite.Connection:
    con = await aiosqlite.connect(DB_PATH)
    con.row_factory = aiosqlite.Row
    await con.execute("PRAGMA journal_mode=WAL")
    await con.execute("PRAGMA foreign_keys=ON")
    return con


async def setting_get(key: str, default: str = "") -> str:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT value FROM settings WHERE key=?", (key,)
        ) as cur:
            row = await cur.fetchone()
            return row["value"] if row else default


async def setting_set(key: str, value: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, int(time.time())),
        )
        await db.commit()


async def is_global_locked() -> bool:
    val = await setting_get("global_lock", "true")
    return val.lower() == "true"


async def is_room_active(chat_jid: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT is_active FROM permissions WHERE chat_jid=?", (chat_jid,)
        ) as cur:
            row = await cur.fetchone()
            return bool(row and row["is_active"])


# ---------------------------------------------------------------------------
# FIX-3: hidden_chats yardımcısı — her zaman temiz liste döner
# ---------------------------------------------------------------------------
async def get_hidden_chats() -> list[str]:
    """settings tablosundaki hidden_chats JSON listesini güvenli biçimde çeker."""
    raw = await setting_get("hidden_chats", "[]")
    try:
        result = json.loads(raw)
        return result if isinstance(result, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


# ---------------------------------------------------------------------------
# Node.js API çağrısı (Python → Node)
# ---------------------------------------------------------------------------
async def node_send_message(jid: str, text: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"http://127.0.0.1:{NODE_PORT}/send_message",
                json={"jid": jid, "text": text},
            )
            return r.status_code == 200
    except Exception as exc:
        clog(f"[⚠ NODE] Mesaj gönderilemedi: {exc}")
        return False


# ---------------------------------------------------------------------------
# FastAPI uygulaması
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    clog("=" * 47)
    clog("  TLLH-WA v2 -- Python Core (Terminal 1)")
    clog("=" * 47)
    clog(f"[🚀 BAŞLADI] Dashboard: http://{HOST}:{PORT}")
    yield
    clog("[DURDURULDU] Python core kapatıldı.")


app = FastAPI(title="TLLH-WA Core", lifespan=lifespan)

# Statik dosyalar — klasörler garantili oluşturulur, mount hatası yakala
static_dir = Path("./static")
static_dir.mkdir(exist_ok=True)
# Dummy dosya koy: StaticFiles bos klasörde hata vermez ama güvenlik için
(static_dir / ".keep").touch()
CACHE_PP_DIR.mkdir(parents=True, exist_ok=True)
(CACHE_PP_DIR / ".keep").touch()

try:
    app.mount("/static", StaticFiles(directory="static"), name="static")
except Exception:
    pass
try:
    app.mount("/cache/pp", StaticFiles(directory=str(CACHE_PP_DIR)), name="pp_cache")
except Exception:
    pass

templates_dir = Path("./templates")
templates_dir.mkdir(exist_ok=True)
templates = Jinja2Templates(directory="templates")


# ---------------------------------------------------------------------------
# Pydantic modelleri
# ---------------------------------------------------------------------------
class MsgPayload(BaseModel):
    msg_id:      str
    chat_jid:    str
    sender_jid:  str
    sender_name: str | None = None
    msg_type:    str        = "text"
    content:     str | None = None
    is_from_me:  int        = 0
    timestamp:   int
    raw_json:    str | None = None


class ViewOncePayload(BaseModel):
    msg_id:      str
    chat_jid:    str
    sender_jid:  str
    sender_name: str | None = None
    media_type:  str
    file_path:   str
    file_size:   int | None = None
    timestamp:   int


class DeletedPayload(BaseModel):
    deleted_msg_id: str
    chat_jid:       str
    deleted_by_jid: str
    cached_msg:     dict | None = None
    deleted_at:     int


class ConnectedPayload(BaseModel):
    self_jid:   str
    wa_version: str | None = None
    ts:         int


class ContactUpdatePayload(BaseModel):
    jid:       str
    name:      str | None = None
    push_name: str | None = None
    is_group:  int        = 0


class CommandPayload(BaseModel):
    command:  str
    chat_jid: str
    sender:   str
    ts:       int


# ---------------------------------------------------------------------------
# Webhook endpoint'leri
# ---------------------------------------------------------------------------
@app.post("/webhook/connected")
async def webhook_connected(payload: ConnectedPayload):
    await setting_set("self_jid", payload.self_jid)
    clog(f"[✅ BAĞLANDI] WhatsApp bağlantısı kuruldu: {payload.self_jid}")
    return {"ok": True}


@app.post("/webhook/disconnected")
async def webhook_disconnected(req: Request):
    data = await req.json()
    clog(f"[❌ KESİLDİ] Bağlantı kesildi. Sebep: {data.get('reason', '?')}")
    return {"ok": True}


@app.post("/webhook/message")
async def webhook_message(payload: MsgPayload):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR IGNORE INTO messages
               (msg_id, chat_jid, sender_jid, sender_name, msg_type, content,
                is_from_me, timestamp, raw_json)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                payload.msg_id, payload.chat_jid, payload.sender_jid,
                payload.sender_name, payload.msg_type, payload.content,
                payload.is_from_me, payload.timestamp, payload.raw_json,
            ),
        )
        await db.commit()

    name_label = payload.sender_name or payload.sender_jid.split("@")[0]
    type_icons = {
        "text": "💬", "image": "📷", "video": "🎥",
        "audio": "🎵", "document": "📄", "sticker": "🎭",
    }

    if payload.is_from_me:
        clog(f"[📤 BEN] → {payload.chat_jid}: {(payload.content or '')[:80]}")
    else:
        icon = type_icons.get(payload.msg_type, "📩")
        preview = payload.content or payload.msg_type
        clog(f"[{icon} MESAJ] {name_label} @ {payload.chat_jid}: {preview[:80]}")

    return {"ok": True}


@app.post("/webhook/view_once")
async def webhook_view_once(payload: ViewOncePayload):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR IGNORE INTO view_once_media
               (msg_id, chat_jid, sender_jid, sender_name, media_type,
                file_path, file_size, timestamp)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                payload.msg_id, payload.chat_jid, payload.sender_jid,
                payload.sender_name, payload.media_type,
                payload.file_path, payload.file_size, payload.timestamp,
            ),
        )
        await db.commit()

    name_label = payload.sender_name or payload.sender_jid.split("@")[0]
    icon = "📷" if payload.media_type == "image" else "🎥"
    clog(f"[{icon} TEK SEFERLİK] {name_label} bir {payload.media_type} gönderdi. Arşivlendi: {Path(payload.file_path).name}")
    return {"ok": True}


@app.post("/webhook/deleted")
async def webhook_deleted(payload: DeletedPayload):
    cached      = payload.cached_msg or {}
    orig_msg    = cached.get("message", {})
    sender_jid  = (
        cached.get("key", {}).get("participant") or
        cached.get("key", {}).get("remoteJid", "")
    )
    sender_name = cached.get("pushName", "")
    msg_type    = "unknown"
    content     = None

    if orig_msg:
        content = (
            orig_msg.get("conversation") or
            (orig_msg.get("extendedTextMessage") or {}).get("text") or
            None
        )
        if orig_msg.get("imageMessage"):    msg_type = "image"
        elif orig_msg.get("videoMessage"):  msg_type = "video"
        elif content:                        msg_type = "text"

    orig_ts = cached.get("messageTimestamp", 0)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO deleted_msgs
               (orig_msg_id, chat_jid, sender_jid, sender_name,
                deleted_by_jid, msg_type, content, original_ts, deleted_at, raw_json)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                payload.deleted_msg_id, payload.chat_jid,
                sender_jid, sender_name,
                payload.deleted_by_jid, msg_type, content,
                orig_ts, payload.deleted_at,
                json.dumps(cached) if cached else None,
            ),
        )
        await db.commit()

    del_name = payload.deleted_by_jid.split("@")[0]
    preview  = f": \"{content[:60]}\"" if content else f" ({msg_type})"
    clog(f"[🗑 SİLİNDİ] {del_name} bir mesajı sildi{preview}")
    return {"ok": True}


@app.post("/webhook/contact_update")
async def webhook_contact_update(payload: ContactUpdatePayload):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO contacts (jid, name, push_name, is_group, updated_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(jid) DO UPDATE SET
                 name=COALESCE(excluded.name, name),
                 push_name=COALESCE(excluded.push_name, push_name),
                 is_group=excluded.is_group,
                 updated_at=excluded.updated_at""",
            (payload.jid, payload.name, payload.push_name, payload.is_group, int(time.time())),
        )
        await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Komut işleyici
# ---------------------------------------------------------------------------
@app.post("/command")
async def handle_command(payload: CommandPayload):
    cmd      = payload.command.strip().lower()
    chat_jid = payload.chat_jid

    if cmd == ".unlock":
        await setting_set("global_lock", "false")
        clog("[🔓 UNLOCK] Global kilit kaldırıldı.")
        await node_send_message(chat_jid, "🔓 Sistem kilidi kaldırıldı.")

    elif cmd == ".lock":
        await setting_set("global_lock", "true")
        clog("[🔒 LOCK] Global kilit aktif.")
        await node_send_message(chat_jid, "🔒 Sistem kilitlendi.")

    elif cmd.startswith(".start"):
        if await is_global_locked():
            await node_send_message(chat_jid, "⛔ Sistem kilitli. Önce .unlock kullan.")
            return {"ok": False, "reason": "locked"}
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """INSERT INTO permissions (chat_jid, is_active, added_at)
                   VALUES (?,1,?)
                   ON CONFLICT(chat_jid) DO UPDATE SET is_active=1, added_at=excluded.added_at""",
                (chat_jid, int(time.time())),
            )
            await db.commit()
        clog(f"[▶ START] Oda aktifleştirildi: {chat_jid}")
        await node_send_message(chat_jid, "▶️ Bu odada AI asistan aktif.")

    elif cmd.startswith(".stop"):
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE permissions SET is_active=0, stopped_at=? WHERE chat_jid=?",
                (int(time.time()), chat_jid),
            )
            await db.commit()
        clog(f"[⏹ STOP] Oda durduruldu: {chat_jid}")
        await node_send_message(chat_jid, "⏹️ Bu odada AI asistan durduruldu.")

    return {"ok": True}


# ---------------------------------------------------------------------------
# Dashboard API endpoint'leri
# ---------------------------------------------------------------------------
@app.get("/api/chats")
async def api_chats():
    """
    FIX-3: hidden_chats listesindeki JID'ler Python tarafında eksiksiz filtreleniyor.
    SQL'e güvenmek yerine uygulama katmanında set lookup ile çıkarılıyor.
    """
    # FIX-3: hidden listesini al — her çağrıda taze çek
    hidden: set[str] = set(await get_hidden_chats())

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT m.chat_jid,
                      c.name, c.push_name, c.pp_path, c.is_group,
                      MAX(m.timestamp) AS last_ts,
                      (SELECT content FROM messages m2
                       WHERE m2.chat_jid = m.chat_jid
                       ORDER BY m2.timestamp DESC LIMIT 1) AS last_msg,
                      COUNT(*) AS msg_count
               FROM messages m
               LEFT JOIN contacts c ON c.jid = m.chat_jid
               GROUP BY m.chat_jid
               ORDER BY last_ts DESC
               LIMIT 300"""
        ) as cur:
            rows = await cur.fetchall()

    result = []
    for r in rows:
        jid = r["chat_jid"]

        # FIX-3: hidden set'te varsa tamamen atla — dashboard'a asla sızmaz
        if jid in hidden:
            continue

        pp_file = CACHE_PP_DIR / f"{jid.replace('@', '_').replace('.', '_')}.jpg"
        result.append({
            "jid":       jid,
            "name":      r["name"] or r["push_name"] or jid.split("@")[0],
            "is_group":  r["is_group"] or 0,
            "last_ts":   r["last_ts"],
            "last_msg":  (r["last_msg"] or "")[:100],
            "msg_count": r["msg_count"],
            "pp_url":    f"/cache/pp/{pp_file.name}" if pp_file.exists() else None,
        })

    return result


@app.get("/api/messages/{chat_jid:path}")
async def api_messages(chat_jid: str, limit: int = 50, offset: int = 0):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT msg_id, sender_jid, sender_name, msg_type, content,
                      media_path, timestamp, is_from_me
               FROM messages WHERE chat_jid=?
               ORDER BY timestamp DESC LIMIT ? OFFSET ?""",
            (chat_jid, limit, offset),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in reversed(rows)]


@app.get("/api/deleted")
async def api_deleted(limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM deleted_msgs ORDER BY deleted_at DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/view_once")
async def api_view_once(limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM view_once_media ORDER BY timestamp DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/stats")
async def api_stats():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        stats: dict[str, Any] = {}
        queries = [
            ("messages",       "total_messages",  ""),
            ("deleted_msgs",   "total_deleted",   ""),
            ("view_once_media","total_view_once",  ""),
            ("permissions",    "active_rooms",    " WHERE is_active=1"),
        ]
        for table, col, where in queries:
            async with db.execute(f"SELECT COUNT(*) AS c FROM {table}{where}") as cur:
                row = await cur.fetchone()
                stats[col] = row["c"] if row else 0

    stats["global_lock"] = await is_global_locked()
    stats["self_jid"]    = await setting_get("self_jid", "")
    return stats


@app.post("/api/hide_chat")
async def api_hide_chat(req: Request):
    data = await req.json()
    jid  = data.get("jid", "").strip()
    if not jid:
        raise HTTPException(400, "jid gerekli")

    # FIX-3: get_hidden_chats() ile tutarlı okuma
    hidden = await get_hidden_chats()
    if jid not in hidden:
        hidden.append(jid)
    await setting_set("hidden_chats", json.dumps(hidden))
    clog(f"[👁 GİZLİ] Sohbet gizlendi: {jid}")
    return {"ok": True}


@app.post("/api/unhide_chat")
async def api_unhide_chat(req: Request):
    data = await req.json()
    jid  = data.get("jid", "").strip()
    if not jid:
        raise HTTPException(400, "jid gerekli")

    hidden = await get_hidden_chats()
    hidden = [h for h in hidden if h != jid]
    await setting_set("hidden_chats", json.dumps(hidden))
    clog(f"[👁 GÖSTER] Sohbet tekrar görünür: {jid}")
    return {"ok": True}


@app.get("/api/permissions")
async def api_permissions():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM permissions ORDER BY added_at DESC"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Dashboard HTML
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
    )


# ---------------------------------------------------------------------------
# Giriş noktası
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "tllh_whatsapp:app",
        host=HOST,
        port=PORT,
        reload=False,
        log_level="warning",
    )
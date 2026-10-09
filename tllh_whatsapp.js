'use strict';

/**
 * TLLH-WA — Node.js Baileys Bridge (Terminal 2)
 *
 * Düzeltmeler:
 *  FIX-1: msgById FIFO cache — her upsert'te set() çağrısı + 2000 limit koruması
 *  FIX-5: Stealth — sock.readMessages() hiçbir yerde çağrılmıyor,
 *          tüm mesaj/medya işlemlerinde sadece 'paused' presence gönderiliyor,
 *          markOnlineOnConnect: false kesin olarak korunuyor
 */

const path         = require('path');
const fs           = require('fs');
const http         = require('http');
const https        = require('https');
require('dotenv').config();

// --------------------------------------------------------------------------
// Baileys ESM dinamik import
// --------------------------------------------------------------------------
let baileys;
let makeWASocket, useMultiFileAuthState, DisconnectReason,
    downloadMediaMessage, fetchLatestBaileysVersion;

async function loadBaileys() {
    baileys                   = await import('@whiskeysockets/baileys');
    // Baileys v6 farklı export isimleri kullanabilir, hepsini dene
    makeWASocket              = baileys.default?.makeWASocket
                             ?? baileys.makeWASocket
                             ?? baileys.default;
    useMultiFileAuthState     = baileys.useMultiFileAuthState;
    DisconnectReason          = baileys.DisconnectReason;
    downloadMediaMessage      = baileys.downloadMediaMessage;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
}

// --------------------------------------------------------------------------
// Konfigürasyon
// --------------------------------------------------------------------------
const CONFIG = {
    NODE_PORT:      parseInt(process.env.NODE_BRIDGE_PORT  ?? '3001'),
    PYTHON_PORT:    parseInt(process.env.PYTHON_CORE_PORT  ?? '8000'),
    AUTH_DIR:       path.resolve('./auth_state'),
    VIEW_ONCE_DIR:  path.resolve(process.env.ARSIV_PATH    ?? './arsiv', 'tek_seferlik'),
    CACHE_PP_DIR:   path.resolve(process.env.CACHE_PATH    ?? './cache', 'pp'),
    FIFO_MAX:       2000,
    RECONNECT_BASE: 3000,
    RECONNECT_MAX:  30000,
};

[CONFIG.AUTH_DIR, CONFIG.VIEW_ONCE_DIR, CONFIG.CACHE_PP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// --------------------------------------------------------------------------
// FIX-1: FIFO in-memory mesaj cache (anti-delete vault)
// --------------------------------------------------------------------------
const msgById = new Map();

/**
 * Gelen her mesajı cache'e yazar.
 * Map 2000 girişi aşarsa en eski girişi (FIFO) siler.
 */
function cacheMessage(msg) {
    if (!msg?.key?.id) return;

    // Derin kopya — orijinal referans değişse bile cache bozulmasın
    msgById.set(msg.key.id, JSON.parse(JSON.stringify(msg)));

    // FIFO: 2000 üstüne çıkınca en eski girişi sil
    if (msgById.size > CONFIG.FIFO_MAX) {
        const oldestKey = msgById.keys().next().value;
        msgById.delete(oldestKey);
    }
}

// --------------------------------------------------------------------------
// FIX-5: Terminal 2'ye özel sessiz logger
// Baileys'in kendi pino logları sadece bu terminale akar.
// Python Core (Terminal 1) asla bu logları görmez.
// --------------------------------------------------------------------------
const silentLogger = {
    level:  'silent',
    trace:  (...a) => process.stdout.write('[BAILEYS:TRACE] ' + a.join(' ') + '\n'),
    debug:  (...a) => process.stdout.write('[BAILEYS:DEBUG] ' + a.join(' ') + '\n'),
    info:   (...a) => process.stdout.write('[BAILEYS:INFO]  ' + a.join(' ') + '\n'),
    warn:   (...a) => process.stdout.write('[BAILEYS:WARN]  ' + a.join(' ') + '\n'),
    error:  (...a) => process.stderr.write('[BAILEYS:ERROR] ' + a.join(' ') + '\n'),
    fatal:  (...a) => process.stderr.write('[BAILEYS:FATAL] ' + a.join(' ') + '\n'),
    child:  () => silentLogger,
};

// --------------------------------------------------------------------------
// HTTP — Python Core'a JSON POST
// --------------------------------------------------------------------------
function postToPython(endpoint, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req  = http.request(
            {
                hostname: '127.0.0.1',
                port:     CONFIG.PYTHON_PORT,
                path:     endpoint,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end',  () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

async function safePython(endpoint, payload) {
    try {
        await postToPython(endpoint, payload);
    } catch (err) {
        process.stderr.write(`[BRIDGE:WARN] Python ulaşılamaz (${endpoint}): ${err.message}\n`);
    }
}

// --------------------------------------------------------------------------
// Mesaj zarfı açıcı (ephemeral + view-once katmanları)
// --------------------------------------------------------------------------
/**
 * unwrapMessage — tüm sarmal katmanlarını while döngüsüyle eritir.
 * WhatsApp hiyerarşiyi değiştirse bile en içteki ham mesaja ulaşır.
 */
function unwrapMessage(msg) {
    let raw = msg?.message;
    if (!raw) return null;

    // Sarmal katmanları tamamen eriyene kadar döngüyle aç
    while (
        raw?.ephemeralMessage?.message           ||
        raw?.viewOnceMessageV2?.message          ||
        raw?.viewOnceMessageV2Extension?.message ||
        raw?.viewOnceMessage?.message
    ) {
        if (raw?.ephemeralMessage?.message)           raw = raw.ephemeralMessage.message;
        if (raw?.viewOnceMessageV2?.message)          raw = raw.viewOnceMessageV2.message;
        if (raw?.viewOnceMessageV2Extension?.message) raw = raw.viewOnceMessageV2Extension.message;
        if (raw?.viewOnceMessage?.message)            raw = raw.viewOnceMessage.message;
    }
    return raw;
}

/**
 * isViewOnce — ham JSON string'i üzerinden tespit eder.
 * Nesne hiyerarşisine bağımlı değil; WhatsApp sarmal yapısını değiştirse de çalışır.
 */
function isViewOnce(msg) {
    const str = JSON.stringify(msg?.message || {});
    return (
        str.includes('"viewOnce":true')              ||
        str.includes('"viewOnceMessageV2"')          ||
        str.includes('"viewOnceMessageV2Extension"') ||
        str.includes('"viewOnceMessage"')
    );
}

/**
 * getMediaInfo — unwrap sonrası veya hala sarmalı çözülmemiş objeyi de yakalar.
 */
function getMediaInfo(raw) {
    if (!raw) return null;
    // Doğrudan imageMessage/videoMessage
    if (raw.imageMessage) return { type: 'image', ext: 'jpg' };
    if (raw.videoMessage) return { type: 'video', ext: 'mp4' };
    // Hala V2 sarmalı açılmamışsa manuel kontrol
    if (raw?.viewOnceMessageV2?.message?.imageMessage)          return { type: 'image', ext: 'jpg' };
    if (raw?.viewOnceMessageV2?.message?.videoMessage)          return { type: 'video', ext: 'mp4' };
    if (raw?.viewOnceMessageV2Extension?.message?.imageMessage) return { type: 'image', ext: 'jpg' };
    if (raw?.viewOnceMessageV2Extension?.message?.videoMessage) return { type: 'video', ext: 'mp4' };
    if (raw?.viewOnceMessage?.message?.imageMessage)            return { type: 'image', ext: 'jpg' };
    if (raw?.viewOnceMessage?.message?.videoMessage)            return { type: 'video', ext: 'mp4' };
    return null;
}

// --------------------------------------------------------------------------
// Gönderici adı
// --------------------------------------------------------------------------
function getSenderName(msg) {
    return (
        msg.pushName ||
        msg.key?.participant?.split('@')[0] ||
        msg.key?.remoteJid?.split('@')[0] ||
        'unknown'
    );
}

// --------------------------------------------------------------------------
// FIX-5: Stealth yardımcısı
// Hiçbir koşulda sock.readMessages() çağrılmıyor.
// Sadece 'paused' presence gönderiliyor — bu bile opsiyonel ve hata toleranslı.
// --------------------------------------------------------------------------
async function stealthPresence(sock, chatJid) {
    try {
        await sock.sendPresenceUpdate('paused', chatJid);
    } catch {
        // Presence hatası asla işlemi durdurmaz
    }
}

// --------------------------------------------------------------------------
// View-once interceptor (TOP LEVEL — FIX-5 stealth korunuyor)
// --------------------------------------------------------------------------
async function interceptViewOnce(sock, msg) {
    try {
        // 1. Sarmalları katman katman elle eri — while loop yerine sıralı if zinciri
        let inner = msg.message;
        if (!inner) return false;

        if (inner?.ephemeralMessage?.message)           inner = inner.ephemeralMessage.message;
        if (inner?.viewOnceMessageV2?.message)          inner = inner.viewOnceMessageV2.message;
        if (inner?.viewOnceMessageV2Extension?.message) inner = inner.viewOnceMessageV2Extension.message;
        if (inner?.viewOnceMessage?.message)            inner = inner.viewOnceMessage.message;

        // 2. Medya tipi kontrolü
        const isImage = !!inner?.imageMessage;
        const isVideo = !!inner?.videoMessage;
        if (!isImage && !isVideo) {
            process.stdout.write(`[VIEW-ONCE:DEBUG] Medya tipi cozulemedi: ${JSON.stringify(inner).substring(0, 200)}\n`);
            return false;
        }

        const mediaType = isImage ? 'image' : 'video';
        const ext       = isImage ? 'jpg'   : 'mp4';

        process.stdout.write(`[VIEW-ONCE BYPASS] Tek seferlik ${mediaType} yakalandi! Sunucudan zorla indiriliyor...\n`);

        // 3. WhatsApp CDN'den zorla indir — 3 deneme hakkı
        let buffer = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    {
                        logger:          silentLogger,
                        reuploadRequest: sock?.updateMediaMessage,
                    }
                );
                if (buffer && buffer.length > 0) break;
            } catch (dlErr) {
                process.stdout.write(`[VIEW-ONCE] Deneme ${attempt}/3 basarisiz: ${dlErr.message}\n`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
            }
        }

        if (!buffer || buffer.length === 0) {
            process.stdout.write(`[VIEW-ONCE] Sunucu medyayi vermedi, pipeline\'a paslanıyor.\n`);
            return false;
        }

        // 4. Dosyayı arsiv/tek_seferlik klasörüne kaydet
        const senderName = getSenderName(msg)
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .toLowerCase()
            .substring(0, 40);
        const ts       = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000));
        const fileName = `${senderName}_${ts}_${Math.floor(Math.random() * 9999)}.${ext}`;
        const filePath = path.join(CONFIG.VIEW_ONCE_DIR, fileName);

        fs.writeFileSync(filePath, buffer);
        process.stdout.write(`[VIEW-ONCE] Arsivlendi: ${fileName} (${buffer.length} byte)\n`);

        await safePython('/webhook/view_once', {
            msg_id:      msg.key.id,
            chat_jid:    msg.key.remoteJid,
            sender_jid:  msg.key.participant ?? msg.key.remoteJid,
            sender_name: getSenderName(msg),
            media_type:  mediaType,
            file_path:   filePath,
            file_size:   buffer.length,
            timestamp:   ts,
        });

        return true;
    } catch (err) {
        process.stderr.write(`[VIEW-ONCE:HATA] ${err.message}\n`);
        return false;
    }
}

// --------------------------------------------------------------------------
// Silme dedektörü (FIX-1: cache lookup artık çalışıyor)
// --------------------------------------------------------------------------
async function handleMessageUpdate(update) {
    try {
        const { key, update: upd } = update;

        // Yöntem 1: protocolMessage.type üzerinden REVOKE tespiti
        const protoType  = upd?.message?.protocolMessage?.type;
        const isRevoke1  = protoType === 0 || protoType === 'REVOKE';

        // Yöntem 2: Bazı Baileys versiyonlarında messageStubType ile gelir
        const stubType   = upd?.messageStubType;
        const isRevoke2  = stubType === 1 || stubType === 'REVOKE';

        // Yöntem 3: message alanı silinmiş ama key varsa (bazı WA sürümlerinde)
        const isRevoke3  = upd?.message === null && !!key?.id;

        if (!isRevoke1 && !isRevoke2 && !isRevoke3) return;

        // Silinen mesajın ID'si: önce protocolMessage key'inden, sonra update key'inden al
        const deletedMsgId = upd?.message?.protocolMessage?.key?.id ?? key.id;

        // FIX-1: FIFO cache'den orijinal mesajı çek
        const cached = msgById.get(deletedMsgId) ?? null;

        await safePython('/webhook/deleted', {
            deleted_msg_id: deletedMsgId,
            chat_jid:       key.remoteJid,
            deleted_by_jid: key.participant ?? key.remoteJid,
            cached_msg:     cached,
            deleted_at:     Math.floor(Date.now() / 1000),
        });
    } catch (err) {
        process.stderr.write(`[DELETE:HATA] ${err.message}\n`);
    }
}

// --------------------------------------------------------------------------
// Text içerik ve tip çıkarıcılar
// --------------------------------------------------------------------------
function extractTextContent(raw) {
    if (!raw) return null;
    return (
        raw?.conversation                        ||
        raw?.extendedTextMessage?.text           ||
        raw?.imageMessage?.caption               ||
        raw?.videoMessage?.caption               ||
        raw?.documentMessage?.caption            ||
        null
    );
}

function extractMsgType(raw) {
    if (!raw) return 'unknown';
    if (raw.conversation || raw.extendedTextMessage) return 'text';
    if (raw.imageMessage)    return 'image';
    if (raw.videoMessage)    return 'video';
    if (raw.audioMessage)    return 'audio';
    if (raw.documentMessage) return 'document';
    if (raw.stickerMessage)  return 'sticker';
    if (raw.locationMessage) return 'location';
    if (raw.contactMessage)  return 'contact';
    if (raw.reactionMessage) return 'reaction';
    return 'unknown';
}

// --------------------------------------------------------------------------
// Self-chat komut yönlendirici (.lock / .unlock / .start / .stop)
// --------------------------------------------------------------------------
async function handleSelfCommand(sock, msg, text, selfJid) {
    const selfBase = selfJid.split('@')[0].split(':')[0];
    const chatBase = msg.key.remoteJid.split('@')[0];
    const isSelf   = chatBase === selfBase || msg.key.remoteJid === selfJid;
    if (!isSelf) return false;

    const cmd = text.trim().toLowerCase();
    if (!['.lock', '.unlock', '.start', '.stop'].some(c => cmd.startsWith(c))) return false;

    await safePython('/command', {
        command:  cmd,
        chat_jid: msg.key.remoteJid,
        sender:   selfJid,
        ts:       Math.floor(Date.now() / 1000),
    });
    return true;
}

// --------------------------------------------------------------------------
// Profil fotoğrafı önbelleği
// --------------------------------------------------------------------------
async function fetchAndCachePP(sock, jid) {
    try {
        const safeName = jid.replace(/[^a-zA-Z0-9]/g, '_');
        const ppPath   = path.join(CONFIG.CACHE_PP_DIR, `${safeName}.jpg`);
        if (fs.existsSync(ppPath)) return ppPath;

        const url = await sock.profilePictureUrl(jid, 'image');
        if (!url) return null;

        const buffer = await new Promise((res, rej) => {
            const proto = url.startsWith('https') ? https : http;
            proto.get(url, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end',  () => res(Buffer.concat(chunks)));
                resp.on('error', rej);
            }).on('error', rej);
        });

        fs.writeFileSync(ppPath, buffer);
        return ppPath;
    } catch {
        return null;
    }
}

// --------------------------------------------------------------------------
// Node API sunucusu (Python → Node komutları için)
// --------------------------------------------------------------------------
function startNodeApiServer(sock) {
    const express = require('express');
    const app     = express();
    app.use(express.json());

    // Python'dan profil fotoğrafı talebi
    app.post('/fetch_pp', async (req, res) => {
        const { jid } = req.body ?? {};
        if (!jid) return res.status(400).json({ error: 'jid gerekli' });
        const pp = await fetchAndCachePP(sock, jid);
        res.json({ pp_path: pp });
    });

    // Python'dan mesaj gönderme talebi
    // FIX-5: Bu endpoint dışında bot HİÇBİR ZAMAN kendi başına mesaj okuma/işaret etme yapmaz
    app.post('/send_message', async (req, res) => {
        try {
            const { jid, text } = req.body ?? {};
            if (!jid || !text) return res.status(400).json({ error: 'jid ve text gerekli' });
            await sock.sendMessage(jid, { text });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Sağlık kontrolü
    app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

    // Port çakışması varsa otomatik +1 ile dener
    function tryListen(port) {
        const srv = app.listen(port, '127.0.0.1', () => {
            process.stdout.write(`[NODE-API] 127.0.0.1:${port} üzerinde dinleniyor\n`);
        });
        srv.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                process.stdout.write(`[NODE-API] Port ${port} meşgul, ${port + 1} deneniyor\n`);
                tryListen(port + 1);
            } else {
                process.stderr.write(`[NODE-API:HATA] ${err.message}\n`);
            }
        });
    }

    tryListen(CONFIG.NODE_PORT);
}

// --------------------------------------------------------------------------
// Ana socket bağlantısı
// --------------------------------------------------------------------------
async function connectToWhatsApp(retryCount = 0) {
    const { version } = await fetchLatestBaileysVersion();
    process.stdout.write(`[BAILEYS] WA sürümü: ${version.join('.')}\n`);

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);

    const sock = makeWASocket({
        version,
        logger:              silentLogger,
        auth:                state,
        // Phantom mod — online görünme
        markOnlineOnConnect: false,
        // Sadece son dönem mesajları çek — tüm tarihi çekmeye çalışma (çok yavaş)
        syncFullHistory:     false,
        generateHighQualityLinkPreview: false,
        browser:             ['TLLH-WA', 'Chrome', '124.0.0'],
        // Baileys "unavailable message" retry isteğinde bu callback çağrılır.
        // FIFO cache'de varsa döner, yoksa undefined — Baileys telefondan tekrar ister.
        getMessage: async (key) => {
            const cached = msgById.get(key.id);
            return cached?.message ?? undefined;
        },
    });

    sock.ev.on('creds.update', saveCreds);

    // ------------------------------------------------------------------
    // Bağlantı yaşam döngüsü
    // ------------------------------------------------------------------
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            try {
                const qrTerminal = require('qrcode-terminal');
                qrTerminal.generate(qr, { small: true });
            } catch {
                // qrcode-terminal yoksa ham string yaz
            }
            process.stdout.write('[QR] WhatsApp uygulamanizla QR kodunu tarayin.\n');
        }

        if (connection === 'open') {
            const selfJid  = sock.user?.id ?? '';
            retryCount = 0;
            process.stdout.write(`[BAĞLANDI] WhatsApp bağlandı: ${selfJid}\n`);

            await safePython('/webhook/connected', {
                self_jid:   selfJid,
                wa_version: version.join('.'),
                ts:         Math.floor(Date.now() / 1000),
            });

            startNodeApiServer(sock);
        }

        if (connection === 'close') {
            const code           = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason?.loggedOut;
            process.stdout.write(`[KESİLDİ] Kod: ${code} | Yeniden bağlan: ${shouldReconnect}\n`);

            if (shouldReconnect) {
                const delay = Math.min(
                    CONFIG.RECONNECT_BASE * Math.pow(1.5, retryCount),
                    CONFIG.RECONNECT_MAX
                );
                process.stdout.write(
                    `[YENİDEN BAĞ] ${Math.round(delay / 1000)}s sonra deneme #${retryCount + 1}\n`
                );
                setTimeout(() => connectToWhatsApp(retryCount + 1), delay);
            } else {
                process.stdout.write('[ÇIKIŞ] Oturum kapatıldı. auth_state/ klasörünü silerek yeniden bağlanın.\n');
                await safePython('/webhook/disconnected', { reason: 'logged_out' });
            }
        }
    });

    // ------------------------------------------------------------------
    // messaging-history.set — ilk bağlantıda toplu geçmiş senkronizasyonu
    // WhatsApp tüm eski mesajları, grupları ve kişileri tek pakette gönderir.
    // Mesajlar 50'şerli batch'lerle Python'a iletilir — Terminal 1 kilitlenmez.
    // ------------------------------------------------------------------
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages: histMsgs, isLatest }) => {
        process.stdout.write(
            `[SENKRON] Gecmis veriler: ${chats.length} sohbet, ${contacts.length} kisi, ${histMsgs.length} mesaj. isLatest=${isLatest}\n`
        );

        // 1) Kişileri Python'a bildir
        for (const c of contacts) {
            if (!c.id) continue;
            await safePython('/webhook/contact_update', {
                jid:       c.id,
                name:      c.name || c.verifiedName || c.notify || null,
                push_name: c.notify || null,
                is_group:  c.id.endsWith('@g.us') ? 1 : 0,
            });
        }

        // 2) Sohbet isimlerini / grupları güncelle
        for (const chat of chats) {
            if (!chat.id) continue;
            await safePython('/webhook/contact_update', {
                jid:      chat.id,
                name:     chat.name || null,
                is_group: chat.id.endsWith('@g.us') ? 1 : 0,
            });
        }

        // 3) Eski mesajları cache'e al ve Python'a batch olarak ilet
        const BATCH = 50;
        const DELAY = 200; // ms — Terminal 1'i boğmamak için
        let sent = 0;

        for (let i = 0; i < histMsgs.length; i++) {
            const msg = histMsgs[i];
            if (!msg?.message) continue;

            // Anti-delete cache'e ekle
            cacheMessage(msg);

            const raw     = unwrapMessage(msg);
            const text    = extractTextContent(raw) ?? '';
            const msgType = extractMsgType(raw);
            const ts      = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000));
            const fromMe  = msg.key.fromMe ?? false;
            const selfJid = sock.user?.id ?? '';

            await safePython('/webhook/message', {
                msg_id:      msg.key.id,
                chat_jid:    msg.key.remoteJid,
                sender_jid:  msg.key.participant ?? (fromMe ? selfJid : msg.key.remoteJid),
                sender_name: getSenderName(msg),
                msg_type:    msgType,
                content:     text,
                is_from_me:  fromMe ? 1 : 0,
                timestamp:   ts,
                raw_json:    null, // Geçmiş mesajlarda raw_json saklamıyoruz — yer tasarrufu
            });

            sent++;

            // Her BATCH mesajda kısa bekleme
            if (sent % BATCH === 0) {
                process.stdout.write(`[SENKRON] ${sent}/${histMsgs.length} mesaj iletildi...\n`);
                await new Promise(r => setTimeout(r, DELAY));
            }
        }

        process.stdout.write(`[SENKRON] Tamamlandi: ${sent} mesaj, ${contacts.length} kisi, ${chats.length} sohbet islendi.\n`);
    });

    // ------------------------------------------------------------------
    // messages.upsert — merkezi mesaj işleme hattı
    // ------------------------------------------------------------------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg?.message) continue;

            // FIX-1: Her mesaj HEMEN cache'e alınıyor — anti-delete vault dolduruluyor
            cacheMessage(msg);

            const selfJid = sock.user?.id ?? '';
            const chatJid = msg.key.remoteJid ?? '';
            const fromMe  = msg.key.fromMe ?? false;

            // FIX-5: Stealth presence — 'paused' gönder, asla readMessages() çağırma
            await stealthPresence(sock, chatJid);

            // TOP LEVEL view-once intercept — diğer her şeyden önce çalışır
            if (isViewOnce(msg)) {
                const handled = await interceptViewOnce(sock, msg);
                if (handled) continue; // normal pipeline'ı tamamen atla
            }

            const raw     = unwrapMessage(msg);
            const text    = extractTextContent(raw) ?? '';
            const msgType = extractMsgType(raw);
            const ts      = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000));

            // Self-chat komut yönlendirme
            if (fromMe && text) {
                const handled = await handleSelfCommand(sock, msg, text, selfJid);
                if (handled) continue;
            }

            // Python Core'a ilet
            await safePython('/webhook/message', {
                msg_id:      msg.key.id,
                chat_jid:    chatJid,
                sender_jid:  msg.key.participant ?? (fromMe ? selfJid : chatJid),
                sender_name: getSenderName(msg),
                msg_type:    msgType,
                content:     text,
                is_from_me:  fromMe ? 1 : 0,
                timestamp:   ts,
                raw_json:    JSON.stringify(msg),
            });
        }
    });

    // ------------------------------------------------------------------
    // messages.update — silme dedektörü
    // ------------------------------------------------------------------
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            await handleMessageUpdate(update);
        }
    });

    // ------------------------------------------------------------------
    // contacts.update — iletişim bilgisi güncellemeleri
    // ------------------------------------------------------------------
    sock.ev.on('contacts.update', async (contacts) => {
        for (const c of contacts) {
            if (!c.id) continue;
            await safePython('/webhook/contact_update', {
                jid:       c.id,
                name:      c.name     ?? c.notify ?? null,
                push_name: c.notify   ?? null,
                is_group:  0,
            });
        }
    });

    // ------------------------------------------------------------------
    // groups.update — grup metadata güncellemeleri
    // ------------------------------------------------------------------
    sock.ev.on('groups.update', async (groups) => {
        for (const g of groups) {
            if (!g.id) continue;
            await safePython('/webhook/contact_update', {
                jid:      g.id,
                name:     g.subject ?? null,
                is_group: 1,
            });
        }
    });

    return sock;
}

// --------------------------------------------------------------------------
// Giriş noktası
// --------------------------------------------------------------------------
(async () => {
    process.stdout.write('╔═══════════════════════════════════════════╗\n');
    process.stdout.write('║  TLLH-WA v2 — Node.js Bridge (Terminal 2) ║\n');
    process.stdout.write('╚═══════════════════════════════════════════╝\n');

    await loadBaileys();
    await connectToWhatsApp();
})().catch((err) => {
    process.stderr.write(`[FATAL] ${err.stack ?? err.message}\n`);
    process.exit(1);
});
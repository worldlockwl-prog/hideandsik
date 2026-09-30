-- ceviri (translation mode) script
print("(Loaded) ceviri script for GTPS Cloud")

--------------------------------------------------------------------------------
-- AYARLAR
--------------------------------------------------------------------------------
local CONFIG = {
    -- Google Cloud Translation API anahtari (console.cloud.google.com -> "Cloud Translation API")
    GOOGLE_API_KEY = "BURAYA_API_KEY",
    API_URL = "https://translation.googleapis.com/language/translate/v2",

    DB_FILE = "ceviri.db",

    DEFAULT_ENABLED = true,     -- yeni oyuncularda ceviri modu acik mi
    DEFAULT_LANG = "en",        -- ulkesi COUNTRY_LANG'da yoksa verilecek dil
    TRUST_SPEAKER_LANG = true,  -- konusanla ayni dildeki oyunculara API cagrisi yapma

    ASCII_OUTPUT = true,        -- ceviriyi ASCII'ye cevir (s/c/g/i/o/u), oyun Turkce harf gostermiyorsa
    AUTO_ITEM_NAMES = true,     -- item adlarini otomatik bypass'a ekle
    AUTO_ITEM_MIN_WORDS = 2,    -- sadece bu kadar ve daha fazla kelimeli item adlari ("Rock" gibi tek kelimeler haric)

    MIN_LETTERS = 2,            -- bypass disinda en az bu kadar harf yoksa API'ye gitme
    MAX_MESSAGE_LEN = 200,
    DAILY_CHAR_LIMIT = 16000,   -- gunluk API karakter limiti (~500k/ay = Google ucretsiz kota)

    DELIVER_DELAY = 0.1,        -- cevirinin orijinal mesajdan sonra gelmesi icin bekleme (sn)
    CACHE_DAYS = 30,
    MEMORY_CACHE_MAX = 3000,

    SHOW_CONSOLE = true,
    SHOW_BUBBLE = true,
    CONSOLE_FORMAT = "`s[%s] %s`s: `o%s",  -- etiket, konusan adi, ceviri
}

-- Yeni dil eklemek icin buraya bir satir ve LANG_ORDER'a anahtarini ekle.
local LANGS = {
    tr  = { name = "Turkce",    tag = "TR",  google = "tr" },
    en  = { name = "English",   tag = "EN",  google = "en" },
    id  = { name = "Indonesia", tag = "ID",  google = "id" },
    fil = { name = "Filipino",  tag = "FIL", google = "tl" },
}
local LANG_ORDER = { "tr", "en", "id", "fil" }

-- Player:getCountry() -> dil
local COUNTRY_LANG = { tr = "tr", id = "id", ph = "fil" }

local GOOGLE_TO_LANG = { fil = "fil" }
for key, lang in pairs(LANGS) do
    GOOGLE_TO_LANG[lang.google] = key
end

--------------------------------------------------------------------------------
-- VERITABANI
--------------------------------------------------------------------------------
local sqlOpen = (sqlite and sqlite.open) or (db and db.open)
local DB = sqlOpen(CONFIG.DB_FILE)

DB:query("CREATE TABLE IF NOT EXISTS ceviri_cache (k TEXT PRIMARY KEY, v TEXT, src TEXT, ts INTEGER)")
DB:query("CREATE TABLE IF NOT EXISTS ceviri_players (uid INTEGER PRIMARY KEY, lang TEXT, enabled INTEGER)")
DB:query("CREATE TABLE IF NOT EXISTS ceviri_meta (k TEXT PRIMARY KEY, v TEXT)")
DB:query("DELETE FROM ceviri_cache WHERE ts < ?", os.time() - CONFIG.CACHE_DAYS * 86400)

local function firstRow(rows)
    if type(rows) == "table" and type(rows[1]) == "table" then
        return rows[1]
    end
    return nil
end

--------------------------------------------------------------------------------
-- BYPASS (cevrilmeyecek ifadeler)
--------------------------------------------------------------------------------
local phrases = {}   -- "legendary wings" -> true
local maxWords = {}  -- ilk kelime -> o kelimeyle baslayan en uzun ifadenin kelime sayisi

-- Kelimenin basindaki/sonundaki noktalamayi atar: "wl?" -> "wl", "(dl)" -> "dl"
local function wordCore(token)
    local core = token:match("^%p*(.-)%p*$")
    if core == nil or core == "" then
        return token:lower()
    end
    return core:lower()
end

local function addPhrase(text)
    if type(text) ~= "string" then return end
    text = text:gsub("`.", "")
    local words = {}
    for token in text:gmatch("%S+") do
        words[#words + 1] = wordCore(token)
    end
    if #words == 0 then return end
    phrases[table.concat(words, " ")] = true
    if (maxWords[words[1]] or 0) < #words then
        maxWords[words[1]] = #words
    end
end

local bypassCount, itemCount = 0, 0
for key in pairs(require("ceviri_bypass")) do
    addPhrase(key)
    bypassCount = bypassCount + 1
end

if CONFIG.AUTO_ITEM_NAMES then
    local total = getItemsCount()
    if type(total) == "number" then
        for id = 0, total - 1 do
            local item = getItem(id)
            if item then
                local name = item:getName()
                if type(name) == "string" and name ~= "" then
                    local _, words = name:gsub("%S+", "")
                    if words >= CONFIG.AUTO_ITEM_MIN_WORDS then
                        addPhrase(name)
                        itemCount = itemCount + 1
                    end
                end
            end
        end
    end
end
print("[ceviri] bypass: " .. bypassCount .. " liste + " .. itemCount .. " item adi yuklendi")

local function htmlEscape(s)
    return (s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

local function countLetters(s)
    local _, ascii = s:gsub("%a", "")
    local _, multi = s:gsub("[\192-\247]", "")
    return ascii + multi
end

-- Mesaji HTML'e cevirir, bypass ifadelerini <span translate="no"> icine alir.
-- Donus: html, apiGerekliMi
local function protectMessage(text)
    local tokens = {}
    for startPos, token, endPos in text:gmatch("()(%S+)()") do
        local lead = #token:match("^%p*")
        local trail = #token:match("%p*$")
        if lead + trail >= #token then
            lead, trail = 0, 0
        end
        tokens[#tokens + 1] = {
            core = wordCore(token),
            coreStart = startPos + lead,
            coreEnd = endPos - 1 - trail,
        }
    end

    local out, plain = {}, {}
    local cursor = 1
    local i = 1
    while i <= #tokens do
        local matchLen = 0
        local first = tokens[i].core
        local limit = maxWords[first]
        if limit then
            local n = math.min(limit, #tokens - i + 1)
            while n >= 1 do
                local parts = {}
                for j = i, i + n - 1 do
                    parts[#parts + 1] = tokens[j].core
                end
                if phrases[table.concat(parts, " ")] then
                    matchLen = n
                    break
                end
                n = n - 1
            end
        end
        -- "5wl", "100dl" gibi sayi + bypass
        if matchLen == 0 then
            local suffix = first:match("^%d+(%a[%w]*)$")
            if suffix and phrases[suffix] then
                matchLen = 1
            end
        end

        if matchLen > 0 then
            local spanStart = tokens[i].coreStart
            local spanEnd = tokens[i + matchLen - 1].coreEnd
            local before = text:sub(cursor, spanStart - 1)
            out[#out + 1] = htmlEscape(before)
            plain[#plain + 1] = before
            out[#out + 1] = '<span translate="no">' .. htmlEscape(text:sub(spanStart, spanEnd)) .. "</span>"
            cursor = spanEnd + 1
            i = i + matchLen
        else
            i = i + 1
        end
    end
    local rest = text:sub(cursor)
    out[#out + 1] = htmlEscape(rest)
    plain[#plain + 1] = rest

    return table.concat(out), countLetters(table.concat(plain)) >= CONFIG.MIN_LETTERS
end

--------------------------------------------------------------------------------
-- METIN YARDIMCILARI
--------------------------------------------------------------------------------
local function utf8Char(cp)
    if not cp or cp < 0 then return "" end
    if cp < 128 then return string.char(cp) end
    if cp < 2048 then
        return string.char(192 + math.floor(cp / 64), 128 + cp % 64)
    end
    if cp < 65536 then
        return string.char(224 + math.floor(cp / 4096), 128 + math.floor(cp / 64) % 64, 128 + cp % 64)
    end
    return string.char(240 + math.floor(cp / 262144), 128 + math.floor(cp / 4096) % 64,
        128 + math.floor(cp / 64) % 64, 128 + cp % 64)
end

local ENTITIES = { amp = "&", lt = "<", gt = ">", quot = '"', apos = "'", nbsp = " " }

local function htmlDecode(s)
    s = s:gsub("<span[^>]*>", ""):gsub("</span>", "")
    return (s:gsub("&(#?[xX]?%w+);", function(ent)
        local hex = ent:match("^#[xX](%x+)$")
        if hex then return utf8Char(tonumber(hex, 16)) end
        local dec = ent:match("^#(%d+)$")
        if dec then return utf8Char(tonumber(dec)) end
        return ENTITIES[ent]
    end))
end

local ASCII_FOLD = {
    ["ç"] = "c", ["Ç"] = "C", ["ş"] = "s", ["Ş"] = "S", ["ğ"] = "g", ["Ğ"] = "G",
    ["ı"] = "i", ["İ"] = "I", ["ö"] = "o", ["Ö"] = "O", ["ü"] = "u", ["Ü"] = "U",
    ["â"] = "a", ["Â"] = "A", ["î"] = "i", ["Î"] = "I", ["û"] = "u", ["Û"] = "U",
    ["á"] = "a", ["à"] = "a", ["ä"] = "a", ["ã"] = "a", ["Á"] = "A", ["À"] = "A",
    ["é"] = "e", ["è"] = "e", ["ê"] = "e", ["ë"] = "e", ["É"] = "E",
    ["í"] = "i", ["ì"] = "i", ["ï"] = "i", ["Í"] = "I",
    ["ó"] = "o", ["ò"] = "o", ["ô"] = "o", ["õ"] = "o", ["Ó"] = "O",
    ["ú"] = "u", ["ù"] = "u", ["Ú"] = "U", ["ñ"] = "n", ["Ñ"] = "N",
    ["‘"] = "'", ["’"] = "'", ["“"] = '"', ["”"] = '"', ["…"] = "...", ["–"] = "-", ["—"] = "-",
}

-- Oyuncunun mesajini temizler: renk kodlari, fazla bosluklar
local function cleanInput(s)
    s = s:gsub("`.", ""):gsub("[\r\n\t]", " "):gsub("%s+", " ")
    return s:match("^%s*(.-)%s*$")
end

-- API'den gelen metni oyunda guvenle gosterilecek hale getirir
local function cleanOutput(s)
    if CONFIG.ASCII_OUTPUT then
        s = s:gsub("[\192-\247][\128-\191]*", function(ch) return ASCII_FOLD[ch] or "" end)
    end
    s = s:gsub("`", "'"):gsub("|", "/"):gsub("[\r\n\t]", " "):gsub("%s+", " ")
    return s:match("^%s*(.-)%s*$")
end

local function sameText(a, b)
    return a:lower():gsub("[%p%s]", "") == b:lower():gsub("[%p%s]", "")
end

--------------------------------------------------------------------------------
-- GOOGLE TRANSLATE
--------------------------------------------------------------------------------
local apiPausedUntil = 0
local lastErrorLog = 0

local function logApiError(msg)
    if os.time() - lastErrorLog >= 60 then
        lastErrorLog = os.time()
        print("[ceviri] API hatasi: " .. msg)
    end
end

local apiKeySet = CONFIG.GOOGLE_API_KEY ~= "" and CONFIG.GOOGLE_API_KEY ~= "BURAYA_API_KEY"
if not apiKeySet then
    print("[ceviri] UYARI: GOOGLE_API_KEY ayarlanmamis, ceviri calismayacak")
end

-- Coroutine icinden cagrilmali. Donus: ceviri (html), kaynakDil  |  nil
local function googleTranslate(html, targetLang)
    local body = json.encode({ q = html, target = LANGS[targetLang].google, format = "html" })
    local res, status = http.post(CONFIG.API_URL .. "?key=" .. CONFIG.GOOGLE_API_KEY,
        { ["Content-Type"] = "application/json; charset=utf-8" }, body)
    status = tonumber(status)

    if status ~= 200 or type(res) ~= "string" then
        if status == 429 then
            apiPausedUntil = os.time() + 60
        elseif status == 400 or status == 401 or status == 403 then
            apiPausedUntil = os.time() + 300
        else
            apiPausedUntil = os.time() + 10
        end
        logApiError("status=" .. tostring(status) .. " " .. tostring(res):sub(1, 200))
        return nil
    end

    local data = json.decode(res)
    local t = type(data) == "table" and type(data.data) == "table"
        and type(data.data.translations) == "table" and data.data.translations[1]
    if type(t) ~= "table" or type(t.translatedText) ~= "string" then
        logApiError("beklenmeyen cevap: " .. res:sub(1, 200))
        return nil
    end
    return t.translatedText, t.detectedSourceLanguage
end

--------------------------------------------------------------------------------
-- CEVIRI (onbellek + ayni anda gelen ayni istekleri birlestirme)
--------------------------------------------------------------------------------
local memCache, memCount = {}, 0
local inflight = {}

local today = os.date("%Y-%m-%d")
local usedToday = 0
do
    local row = firstRow(DB:query("SELECT v FROM ceviri_meta WHERE k = ?", "chars_" .. today))
    usedToday = row and tonumber(row.v) or 0
end

local function rollDay()
    local now = os.date("%Y-%m-%d")
    if now ~= today then
        today, usedToday = now, 0
    end
end

local function addUsage(chars)
    rollDay()
    usedToday = usedToday + chars
    DB:query("INSERT OR REPLACE INTO ceviri_meta (k, v) VALUES (?, ?)", "chars_" .. today, tostring(usedToday))
end

local function memPut(key, value)
    if memCount >= CONFIG.MEMORY_CACHE_MAX then
        memCache, memCount = {}, 0
    end
    if memCache[key] == nil then
        memCount = memCount + 1
    end
    memCache[key] = value
end

-- cb(ceviri) : ceviri nil ise hata, "" ise cevirmeye gerek yok (zaten o dilde)
local function translate(text, html, targetLang, cb)
    local key = targetLang .. "|" .. text:lower()

    local cached = memCache[key]
    if cached == nil then
        local row = firstRow(DB:query("SELECT v FROM ceviri_cache WHERE k = ?", key))
        if row and type(row.v) == "string" then
            cached = row.v
            memPut(key, cached)
        end
    end
    if cached ~= nil then
        cb(cached)
        return
    end

    -- ayni metin zaten cevriliyorsa sonucu bekle (15 sn'den eskiyse takilmis sayilir)
    local pending = inflight[key]
    if pending and os.time() - pending.started < 15 then
        table.insert(pending.callbacks, cb)
        return
    end

    if not apiKeySet or os.time() < apiPausedUntil then
        cb(nil)
        return
    end
    rollDay()
    if usedToday + #text > CONFIG.DAILY_CHAR_LIMIT then
        logApiError("gunluk karakter limiti doldu (" .. usedToday .. ")")
        cb(nil)
        return
    end

    inflight[key] = { started = os.time(), callbacks = { cb } }
    addUsage(#text)

    coroutine.wrap(function()
        local raw, detected = googleTranslate(html, targetLang)
        local result = nil
        if raw then
            result = cleanOutput(htmlDecode(raw))
            if GOOGLE_TO_LANG[detected or ""] == targetLang or result == "" or sameText(result, text) then
                result = ""
            end
            memPut(key, result)
            DB:query("INSERT OR REPLACE INTO ceviri_cache (k, v, src, ts) VALUES (?, ?, ?, ?)",
                key, result, tostring(detected or ""), os.time())
        end

        local callbacks = inflight[key] and inflight[key].callbacks or {}
        inflight[key] = nil
        for _, fn in ipairs(callbacks) do
            fn(result)
        end
    end)()
end

--------------------------------------------------------------------------------
-- OYUNCU AYARLARI
--------------------------------------------------------------------------------
local settings = {}

local function getSettings(player)
    local uid = player:getUserID()
    local s = settings[uid]
    if s then return s end

    local row = firstRow(DB:query("SELECT lang, enabled FROM ceviri_players WHERE uid = ?", uid))
    if row then
        s = { lang = row.lang, enabled = tonumber(row.enabled) == 1 }
    else
        local country = player:getCountry()
        country = type(country) == "string" and country:lower() or ""
        s = { lang = COUNTRY_LANG[country] or CONFIG.DEFAULT_LANG, enabled = CONFIG.DEFAULT_ENABLED }
    end
    if not LANGS[s.lang] then
        s.lang = CONFIG.DEFAULT_LANG
    end
    settings[uid] = s
    return s
end

local function saveSettings(player, s)
    settings[player:getUserID()] = s
    DB:query("INSERT OR REPLACE INTO ceviri_players (uid, lang, enabled) VALUES (?, ?, ?)",
        player:getUserID(), s.lang, s.enabled and 1 or 0)
end

onPlayerDisconnectCallback(function(player)
    settings[player:getUserID()] = nil
    return false
end)

--------------------------------------------------------------------------------
-- DUNYA SOHBETI
--------------------------------------------------------------------------------
-- Cevap geldiginde oyuncu objelerini yeniden buluyoruz, cikmis/dunya degistirmis oyuncuya gondermiyoruz.
local function deliverWorldChat(worldName, speakerUID, speakerNetID, speakerName, original, translated, lang, receivers)
    local speakerHere = false
    local targets = {}
    for _, p in ipairs(getServerPlayers()) do
        if p:getWorldName() == worldName then
            local uid = p:getUserID()
            if uid == speakerUID then
                speakerHere = true
            elseif receivers[uid] then
                targets[#targets + 1] = p
            end
        end
    end

    for _, p in ipairs(targets) do
        if CONFIG.SHOW_CONSOLE then
            p:onConsoleMessage(string.format(CONFIG.CONSOLE_FORMAT, LANGS[lang].tag, speakerName, translated))
        end
        if CONFIG.SHOW_BUBBLE and speakerHere then
            p:onTalkBubble(speakerNetID, original .. " `s(" .. translated .. ")", 0)
        end
    end
end

local function handleWorldChat(world, player, message)
    local text = cleanInput(message)
    if text == "" or #text > CONFIG.MAX_MESSAGE_LEN then return end

    local speakerUID = player:getUserID()
    local speakerLang = getSettings(player).lang

    local groups = {}
    local hasTarget = false
    for _, p in ipairs(world:getPlayers()) do
        if p:getType() == 0 and p:getUserID() ~= speakerUID then
            local s = getSettings(p)
            if s.enabled and not (CONFIG.TRUST_SPEAKER_LANG and s.lang == speakerLang) then
                groups[s.lang] = groups[s.lang] or {}
                groups[s.lang][p:getUserID()] = true
                hasTarget = true
            end
        end
    end
    if not hasTarget then return end

    local html, needsApi = protectMessage(text)
    if not needsApi then return end

    local worldName = world:getName()
    local speakerNetID = player:getNetID()
    local speakerName = player:getName()

    for lang, receivers in pairs(groups) do
        translate(text, html, lang, function(translated)
            if not translated or translated == "" then return end
            timer.setTimeout(CONFIG.DELIVER_DELAY, function()
                deliverWorldChat(worldName, speakerUID, speakerNetID, speakerName, text, translated, lang, receivers)
            end)
        end)
    end
end

onPlayerChatCallback(function(world, player, message)
    if type(message) == "string" and message ~= "" and message:sub(1, 1) ~= "/" then
        handleWorldChat(world, player, message)
    end
    return false
end)

--------------------------------------------------------------------------------
-- /ceviri KOMUTU VE MENU
--------------------------------------------------------------------------------
registerLuaCommand({
    command = "ceviri",
    roleRequired = 0,
    description = "Ceviri modunu ac/kapat ve dilini sec."
})

local function showMenu(player)
    local s = getSettings(player)
    local d = "set_default_color|`o\n" ..
        "add_label_with_icon|big|`wCeviri Modu``|left|18|\n" ..
        "add_spacer|small|\n" ..
        "add_textbox|Durum: " .. (s.enabled and "`2ACIK" or "`4KAPALI") .. "|left|\n" ..
        "add_textbox|`oDilin: `w" .. LANGS[s.lang].name .. "|left|\n" ..
        "add_smalltext|`oBaska dilde yazilan mesajlarin cevirisi altinda gri renkte gosterilir.|\n" ..
        "add_spacer|small|\n" ..
        "add_button|ceviri_toggle|" .. (s.enabled and "`4Ceviriyi Kapat" or "`2Ceviriyi Ac") .. "|noflags|0|0|\n" ..
        "add_spacer|small|\n" ..
        "add_textbox|`oDilini sec:|left|\n"
    for _, key in ipairs(LANG_ORDER) do
        local label = (key == s.lang and "`2> " or "`w") .. LANGS[key].name
        d = d .. "add_button|ceviri_lang_" .. key .. "|" .. label .. "|noflags|0|0|\n"
    end
    d = d .. "add_quick_exit|\n" ..
        "end_dialog|ceviri_menu|Kapat||\n"
    player:onDialogRequest(d)
end

onPlayerCommandCallback(function(world, player, fullCommand)
    local cmd, arg = fullCommand:match("^/?(%S+)%s*(.-)%s*$")
    if not cmd or cmd:lower() ~= "ceviri" then return false end

    arg = (arg or ""):lower()
    local s = getSettings(player)
    if LANGS[arg] then
        s.lang = arg
        saveSettings(player, s)
        player:onConsoleMessage("`2[Ceviri] `oDilin `w" .. LANGS[arg].name .. " `oolarak ayarlandi.")
    elseif arg == "ac" or arg == "on" then
        s.enabled = true
        saveSettings(player, s)
        player:onConsoleMessage("`2[Ceviri] `oCeviri modu acildi.")
    elseif arg == "kapat" or arg == "off" then
        s.enabled = false
        saveSettings(player, s)
        player:onConsoleMessage("`2[Ceviri] `oCeviri modu kapatildi.")
    else
        showMenu(player)
    end
    return true
end)

onPlayerDialogCallback(function(world, player, data)
    if data["dialog_name"] ~= "ceviri_menu" then return false end

    local btn = data["buttonClicked"] or ""
    local s = getSettings(player)
    if btn == "ceviri_toggle" then
        s.enabled = not s.enabled
        saveSettings(player, s)
        showMenu(player)
    else
        local lang = btn:match("^ceviri_lang_(%w+)$")
        if lang and LANGS[lang] then
            s.lang = lang
            saveSettings(player, s)
            showMenu(player)
        end
    end
    return true
end)

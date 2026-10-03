print("(Loaded) ceviri script for GTPS Cloud")

local bypass = {
    ['WL'] = true,
    ['DL'] = true,
    ['BGL'] = true,
    ['gg'] = true,
    ['ez'] = true,
    ['wp'] = true,
}

local CONFIG = {
    SOURCE = "Autodetect",
    TARGET = "en",

    MYMEMORY_URL = "https://api.mymemory.translated.net/get",
    MYMEMORY_EMAIL = "",

    AUTO_ITEM_NAMES = true,
    AUTO_ITEM_MIN_WORDS = 2,

    MIN_LETTERS = 2,
    MAX_MESSAGE_LEN = 200,
    DAILY_CHAR_LIMIT = 4500,
    CACHE_MAX = 3000,
    DELIVER_DELAY = 0.1,

    SHOW_BUBBLE = true,
    SHOW_CONSOLE = true,
    CONSOLE_FORMAT = "`5%s: `w%s",
}

local phrases = {}
local maxWords = {}

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
for key in pairs(bypass) do
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

local function countLetters(s)
    local _, ascii = s:gsub("%a", "")
    local _, multi = s:gsub("[\192-\247]", "")
    return ascii + multi
end

local function splitMessage(text)
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

    local segments = {}
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
        if matchLen == 0 then
            local suffix = first:match("^%d+(%a[%w]*)$")
            if suffix and phrases[suffix] then
                matchLen = 1
            end
        end

        if matchLen > 0 then
            local spanStart = tokens[i].coreStart
            local spanEnd = tokens[i + matchLen - 1].coreEnd
            if spanStart > cursor then
                segments[#segments + 1] = { text = text:sub(cursor, spanStart - 1) }
            end
            segments[#segments + 1] = { text = text:sub(spanStart, spanEnd), keep = true }
            cursor = spanEnd + 1
            i = i + matchLen
        else
            i = i + 1
        end
    end
    if cursor <= #text then
        segments[#segments + 1] = { text = text:sub(cursor) }
    end

    local letters = 0
    for _, seg in ipairs(segments) do
        if not seg.keep then
            letters = letters + countLetters(seg.text)
        end
    end
    return segments, letters >= CONFIG.MIN_LETTERS
end

local function buildMasked(segments)
    local out, kept = {}, {}
    for _, seg in ipairs(segments) do
        if seg.keep then
            kept[#kept + 1] = seg.text
            out[#out + 1] = "[" .. #kept .. "]"
        else
            out[#out + 1] = seg.text
        end
    end
    return table.concat(out), kept
end

local function restoreMasked(s, kept)
    for n, original in ipairs(kept) do
        local count
        s, count = s:gsub("%[%s*" .. n .. "%s*%]", (original:gsub("%%", "%%%%")), 1)
        if count == 0 then
            return nil
        end
    end
    return s
end

local function urlencode(s)
    return (s:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", string.byte(c)) end))
end

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
    ["á"] = "a", ["à"] = "a", ["ä"] = "a", ["é"] = "e", ["è"] = "e", ["ê"] = "e",
    ["í"] = "i", ["ó"] = "o", ["ú"] = "u", ["ñ"] = "n",
    ["‘"] = "'", ["’"] = "'", ["“"] = '"', ["”"] = '"', ["…"] = "...", ["–"] = "-", ["—"] = "-",
}

local function cleanInput(s)
    s = s:gsub("`.", ""):gsub("[\r\n\t]", " "):gsub("%s+", " ")
    return s:match("^%s*(.-)%s*$")
end

local function cleanOutput(s)
    s = s:gsub("[\192-\247][\128-\191]*", function(ch) return ASCII_FOLD[ch] or "" end)
    s = s:gsub("`", "'"):gsub("|", "/"):gsub("[\r\n\t]", " "):gsub("%s+", " ")
    return s:match("^%s*(.-)%s*$")
end

local function sameText(a, b)
    return a:lower():gsub("[%p%s]", "") == b:lower():gsub("[%p%s]", "")
end

local apiPausedUntil = 0
local lastErrorLog = 0

local function logError(msg)
    if os.time() - lastErrorLog >= 60 then
        lastErrorLog = os.time()
        print("[ceviri] " .. msg)
    end
end

local function parseMyMemory(body, status, masked, kept)
    status = tonumber(status)
    if status ~= 200 or type(body) ~= "string" then
        apiPausedUntil = os.time() + (status == 429 and 300 or 10)
        logError("API status=" .. tostring(status))
        return nil
    end

    local data = json.decode(body)
    if type(data) ~= "table" then
        apiPausedUntil = os.time() + 10
        logError("API bozuk cevap: " .. body:sub(1, 150))
        return nil
    end
    local code = tonumber(data.responseStatus)
    if body:find("DISTINCT LANGUAGES", 1, true) then
        return ""
    end
    if code ~= 200 or data.quotaFinished == true then
        apiPausedUntil = os.time() + ((data.quotaFinished == true or code == 429) and 1800 or 10)
        logError("API hata: " .. body:sub(1, 150))
        return nil
    end

    local txt = nil
    if type(data.matches) == "table" then
        for _, m in ipairs(data.matches) do
            if type(m) == "table" and m["created-by"] == "MT!" and type(m.translation) == "string" then
                local target = type(m.target) == "string" and m.target:lower():match("^(%a+)")
                if target == nil or target == CONFIG.TARGET then
                    txt = m.translation
                    break
                end
            end
        end
    end
    if not txt then
        return ""
    end

    local restored = restoreMasked(htmlDecode(txt), kept)
    if not restored then
        print("[ceviri] bypass korunamadi: " .. masked .. " -> " .. txt)
        return ""
    end
    return cleanOutput(restored)
end

local USAGE_KEY = "ceviri_usage_" .. tostring(getServerID())
local usage = loadDataFromServer(USAGE_KEY)
if type(usage) ~= "table" then
    usage = {}
end

local function canSpend(chars)
    local day = tostring(math.floor(os.time() / 86400))
    if usage.day ~= day then
        usage.day = day
        usage.chars = 0
    end
    return (tonumber(usage.chars) or 0) + chars <= CONFIG.DAILY_CHAR_LIMIT
end

local function spend(chars)
    usage.chars = (tonumber(usage.chars) or 0) + chars
    saveDataToServer(USAGE_KEY, usage)
end

local cache, cacheCount = {}, 0
local pending = {}

local function cachePut(key, value)
    if cacheCount >= CONFIG.CACHE_MAX then
        cache, cacheCount = {}, 0
    end
    if cache[key] == nil then
        cacheCount = cacheCount + 1
    end
    cache[key] = value
end

local function deliver(world, speakerNetID, speakerName, translated)
    local line = string.format(CONFIG.CONSOLE_FORMAT, speakerName, translated)
    for _, p in ipairs(world:getPlayers()) do
        if CONFIG.SHOW_BUBBLE then
            p:onTalkBubble(speakerNetID, translated, 0, 0)
        end
        if CONFIG.SHOW_CONSOLE then
            p:onConsoleMessage(line, 0)
        end
    end
end

local function handleChat(world, player, message)
    local text = cleanInput(message)
    if text == "" or #text > CONFIG.MAX_MESSAGE_LEN then return end

    local segments, needsApi = splitMessage(text)
    if not needsApi then return end

    local speakerNetID = player:getNetID()
    local speakerName = player:getCleanName()
    local key = text:lower()

    local cached = cache[key]
    if cached ~= nil then
        if cached ~= "" then
            timer.setTimeout(CONFIG.DELIVER_DELAY, function()
                deliver(world, speakerNetID, speakerName, cached)
            end)
        end
        return
    end

    if pending[key] and os.time() - pending[key] < 15 then return end
    if os.time() < apiPausedUntil then return end
    if not canSpend(#text) then
        logError("gunluk karakter limiti doldu")
        return
    end

    pending[key] = os.time()
    spend(#text)

    local masked, kept = buildMasked(segments)
    local url = CONFIG.MYMEMORY_URL .. "?q=" .. urlencode(masked) ..
        "&langpair=" .. CONFIG.SOURCE .. "%7C" .. CONFIG.TARGET .. "&mt=1"
    if CONFIG.MYMEMORY_EMAIL ~= "" then
        url = url .. "&de=" .. urlencode(CONFIG.MYMEMORY_EMAIL)
    end

    coroutine.wrap(function()
        local body, status = http.get(url)
        local translated = parseMyMemory(body, status, masked, kept)
        pending[key] = nil
        if translated == nil then return end
        if sameText(translated, text) then
            translated = ""
        end
        cachePut(key, translated)
        if translated ~= "" then
            deliver(world, speakerNetID, speakerName, translated)
        end
    end)()
end

onPlayerChatCallback(function(world, player, message)
    if type(message) == "string" and message ~= "" and message:sub(1, 1) ~= "/" then
        handleChat(world, player, message)
    end
    return false
end)

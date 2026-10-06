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
    PROVIDER = "claude",
    FALLBACK_PROVIDER = "",

    GEMINI_KEY = "BURAYA_GEMINI_KEY",
    GEMINI_MODEL = "gemini-flash-lite-latest",

    CLAUDE_KEY = "BURAYA_CLAUDE_KEY",
    CLAUDE_MODEL = "claude-haiku-4-5",

    DEFAULT_LANG = "en",
    TRUST_SPEAKER_LANG = true,

    AUTO_ITEM_NAMES = true,
    AUTO_ITEM_MIN_WORDS = 2,

    MIN_LETTERS = 2,
    MAX_MESSAGE_LEN = 200,
    DAILY_REQUEST_LIMIT = 3000,
    CACHE_MAX = 3000,
    DELIVER_DELAY = 0.1,

    SHOW_BUBBLE = true,
    SHOW_CONSOLE = true,
    LOGIN_HINT = true,
}

local LANGS = {
    tr = { name = "Turkce", prompt = "Turkish" },
    en = { name = "English", prompt = "English" },
    id = { name = "Bahasa Indonesia", prompt = "Indonesian" },
    ph = { name = "Filipino", prompt = "Filipino (Tagalog)" },
}
local LANG_ORDER = { "tr", "en", "id", "ph" }
local COUNTRY_LANG = { tr = "tr", id = "id", ph = "ph" }

local SYSTEM_PROMPT = "You translate Growtopia game chat. Players type casually with slang, typos and Turkish written without Turkish characters. " ..
    "Translate the meaning naturally, the way a native player would write it, not word by word. " ..
    "Text inside <keep>...</keep> is an item name or game term: copy it exactly, including the tags. Keep numbers. " ..
    "Translate the message into every requested language code. If the message is already in that language, return it unchanged. " ..
    "Reply with only a JSON object whose keys are the requested language codes and whose values are the translations."

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

local function buildTagged(segments)
    local out, kept = {}, {}
    for _, seg in ipairs(segments) do
        if seg.keep then
            kept[#kept + 1] = seg.text
            out[#out + 1] = "<keep>" .. seg.text .. "</keep>"
        else
            out[#out + 1] = seg.text
        end
    end
    return table.concat(out), kept
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
    s = s:gsub("</?keep>", "")
    s = s:gsub("[\192-\247][\128-\191]*", function(ch) return ASCII_FOLD[ch] or "" end)
    s = s:gsub("`", "'"):gsub("|", "/"):gsub("[\r\n\t]", " "):gsub("%s+", " ")
    return s:match("^%s*(.-)%s*$")
end

local function sameText(a, b)
    return a:lower():gsub("[%p%s]", "") == b:lower():gsub("[%p%s]", "")
end

local function keptIntact(s, kept)
    local lower = s:lower()
    for _, word in ipairs(kept) do
        if not lower:find(word:lower(), 1, true) then
            return false
        end
    end
    return true
end

local pausedUntil = {}
local lastErrorLog = 0

local function logError(msg)
    if os.time() - lastErrorLog >= 60 then
        lastErrorLog = os.time()
        print("[ceviri] " .. msg)
    end
end

local function providerReady(provider)
    local key
    if provider == "claude" then
        key = CONFIG.CLAUDE_KEY
    elseif provider == "gemini" then
        key = CONFIG.GEMINI_KEY
    end
    if type(key) ~= "string" or key == "" or key:sub(1, 6) == "BURAYA" then
        return false
    end
    return os.time() >= (pausedUntil[provider] or 0)
end

local function pickProvider()
    if providerReady(CONFIG.PROVIDER) then return CONFIG.PROVIDER end
    if providerReady(CONFIG.FALLBACK_PROVIDER) then return CONFIG.FALLBACK_PROVIDER end
    return nil
end

local function buildRequest(provider, tagged, langs)
    local names = {}
    for _, code in ipairs(langs) do
        names[#names + 1] = code .. " (" .. LANGS[code].prompt .. ")"
    end
    local userText = "Languages: " .. table.concat(names, ", ") .. "\nMessage: " .. tagged

    if provider == "claude" then
        return {
            url = "https://api.anthropic.com/v1/messages",
            headers = {
                ["Content-Type"] = "application/json",
                ["x-api-key"] = CONFIG.CLAUDE_KEY,
                ["anthropic-version"] = "2023-06-01",
            },
            body = json.encode({
                model = CONFIG.CLAUDE_MODEL,
                max_tokens = 400,
                system = SYSTEM_PROMPT,
                messages = { { role = "user", content = userText } },
            }),
        }
    end

    return {
        url = "https://generativelanguage.googleapis.com/v1beta/models/" .. CONFIG.GEMINI_MODEL .. ":generateContent",
        headers = {
            ["Content-Type"] = "application/json",
            ["x-goog-api-key"] = CONFIG.GEMINI_KEY,
        },
        body = json.encode({
            systemInstruction = { parts = { { text = SYSTEM_PROMPT } } },
            contents = { { role = "user", parts = { { text = userText } } } },
            generationConfig = { maxOutputTokens = 400, responseMimeType = "application/json" },
            safetySettings = {
                { category = "HARM_CATEGORY_HARASSMENT", threshold = "BLOCK_NONE" },
                { category = "HARM_CATEGORY_HATE_SPEECH", threshold = "BLOCK_NONE" },
                { category = "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold = "BLOCK_NONE" },
                { category = "HARM_CATEGORY_DANGEROUS_CONTENT", threshold = "BLOCK_NONE" },
            },
        }),
    }
end

local function responseText(provider, data)
    local out = {}
    if provider == "claude" then
        if type(data.content) == "table" then
            for _, block in ipairs(data.content) do
                if type(block) == "table" and block.type == "text" and type(block.text) == "string" then
                    out[#out + 1] = block.text
                end
            end
        end
    else
        local cand = type(data.candidates) == "table" and data.candidates[1]
        local parts = type(cand) == "table" and type(cand.content) == "table" and cand.content.parts
        if type(parts) == "table" then
            for _, part in ipairs(parts) do
                if type(part) == "table" and type(part.text) == "string" and not part.thought then
                    out[#out + 1] = part.text
                end
            end
        end
    end
    return table.concat(out)
end

local function parseResponse(provider, res, status, langs, kept, original)
    status = tonumber(status)
    if status ~= 200 or type(res) ~= "string" then
        if status == 400 or status == 401 or status == 403 or status == 404 then
            pausedUntil[provider] = os.time() + 300
        else
            pausedUntil[provider] = os.time() + 3
        end
        logError(provider .. " status=" .. tostring(status) .. " " .. tostring(res):sub(1, 200))
        return nil
    end

    local data = json.decode(res)
    if type(data) ~= "table" then
        logError(provider .. " bozuk cevap: " .. res:sub(1, 200))
        return nil
    end

    local jsonText = responseText(provider, data):match("%b{}")
    local translations = jsonText and json.decode(jsonText)
    if type(translations) ~= "table" then
        logError(provider .. " JSON vermedi: " .. res:sub(1, 200))
        return nil
    end

    local result = {}
    for _, code in ipairs(langs) do
        local value = translations[code]
        if type(value) == "string" and keptIntact(value, kept) then
            value = cleanOutput(value)
            if value == "" or sameText(value, original) then
                value = ""
            end
        else
            value = ""
        end
        result[code] = value
    end
    return result
end

local USAGE_KEY = "ceviri_usage_" .. tostring(getServerID())
local usage = loadDataFromServer(USAGE_KEY)
if type(usage) ~= "table" then
    usage = {}
end

local function canSpend()
    local day = tostring(math.floor(os.time() / 86400))
    if usage.day ~= day then
        usage.day = day
        usage.count = 0
    end
    return (tonumber(usage.count) or 0) < CONFIG.DAILY_REQUEST_LIMIT
end

local function spend()
    usage.count = (tonumber(usage.count) or 0) + 1
    saveDataToServer(USAGE_KEY, usage)
end

local settings = {}

local function settingsKey(uid)
    return "ceviri_lang_" .. tostring(uid)
end

local function getSettings(player)
    local uid = player:getUserID()
    local s = settings[uid]
    if s then return s end

    local data = loadDataFromServer(settingsKey(uid))
    if type(data) == "table" and LANGS[data.lang] then
        s = { lang = data.lang, enabled = tonumber(data.enabled) ~= 0 }
    else
        local country = player:getCountry()
        country = type(country) == "string" and country:lower() or ""
        s = { lang = COUNTRY_LANG[country] or CONFIG.DEFAULT_LANG, enabled = true }
    end
    settings[uid] = s
    return s
end

local function saveSettings(player, s)
    local uid = player:getUserID()
    settings[uid] = s
    saveDataToServer(settingsKey(uid), { lang = s.lang, enabled = s.enabled and 1 or 0 })
end

local cache, cacheCount = {}, 0
local pending = {}

local function cachePut(key, entry)
    if cache[key] == nil then
        if cacheCount >= CONFIG.CACHE_MAX then
            cache, cacheCount = {}, 0
        end
        cacheCount = cacheCount + 1
    end
    cache[key] = entry
end

local function requestTranslation(provider, tagged, kept, langs, original, onDone, allowFallback)
    local request = buildRequest(provider, tagged, langs)
    coroutine.wrap(function()
        local res, status = http.post(request.url, request.headers, request.body)
        local result = parseResponse(provider, res, status, langs, kept, original)
        if result then
            onDone(result)
            return
        end
        local fallback = CONFIG.FALLBACK_PROVIDER
        if allowFallback and fallback ~= provider and providerReady(fallback) then
            timer.setTimeout(0.05, function()
                requestTranslation(fallback, tagged, kept, langs, original, onDone, false)
            end)
        else
            onDone(nil)
        end
    end)()
end

local function deliver(world, speakerUID, speakerNetID, speakerName, entry)
    for _, p in ipairs(world:getPlayers()) do
        local uid = p:getUserID()
        local s = settings[uid]
        if uid ~= speakerUID and s and s.enabled then
            local translated = entry[s.lang]
            if translated and translated ~= "" then
                if CONFIG.SHOW_BUBBLE then
                    p:sendVariant({ "OnTalkBubble", speakerNetID, "CP:0_PL:1_OID:_player_chat=`5[ " .. translated.." ]", 0, 0 })
                end
                if CONFIG.SHOW_CONSOLE then
                    p:sendVariant({"OnConsoleMessage", "CP:0_PL:1_OID:_CT:[W]_ `6<`w" .. speakerName .. " `2[Translated]`6> `$`b" .. translated})
                end
            end
        end
    end
end

local function handleChat(world, player, message)
    local text = cleanInput(message)
    if text == "" or #text > CONFIG.MAX_MESSAGE_LEN then return end

    local speakerUID = player:getUserID()
    local speaker = getSettings(player)

    local targets = {}
    local hasTarget = false
    for _, p in ipairs(world:getPlayers()) do
        if p:getUserID() ~= speakerUID then
            local s = getSettings(p)
            if s.enabled and not (CONFIG.TRUST_SPEAKER_LANG and s.lang == speaker.lang) then
                targets[s.lang] = true
                hasTarget = true
            end
        end
    end
    if not hasTarget then return end

    local segments, needsApi = splitMessage(text)
    if not needsApi then return end

    local key = text:lower()
    local entry = cache[key] or {}
    local missing = {}
    for _, code in ipairs(LANG_ORDER) do
        if targets[code] and entry[code] == nil then
            missing[#missing + 1] = code
        end
    end

    local speakerNetID = player:getNetID()
    local speakerName = player:getCleanName()

    if #missing == 0 then
        timer.setTimeout(CONFIG.DELIVER_DELAY, function()
            deliver(world, speakerUID, speakerNetID, speakerName, entry)
        end)
        return
    end

    if pending[key] and os.time() - pending[key] < 15 then return end
    local provider = pickProvider()
    if not provider then return end
    if not canSpend() then
        logError("gunluk istek limiti doldu")
        return
    end

    pending[key] = os.time()
    spend()

    local tagged, kept = buildTagged(segments)
    requestTranslation(provider, tagged, kept, missing, text, function(result)
        pending[key] = nil
        if not result then return end
        for code, value in pairs(result) do
            entry[code] = value
        end
        cachePut(key, entry)
        deliver(world, speakerUID, speakerNetID, speakerName, entry)
    end, true)
end

onPlayerChatCallback(function(world, player, message)
    if type(message) == "string" and message ~= "" and message:sub(1, 1) ~= "/" then
        handleChat(world, player, message)
    end
    return false
end)

registerLuaCommand({
    command = "dil",
    roleRequired = 0,
    description = "Ceviri dilini sec."
})

registerLuaCommand({
    command = "lang",
    roleRequired = 0,
    description = "Choose your translation language."
})

local function showMenu(player)
    local s = getSettings(player)
    local status = s.enabled and ("`2" .. LANGS[s.lang].name) or "`4OFF / KAPALI"
    local d = "set_default_color|`o\n" ..
        "add_label_with_icon|big|`wTranslation / Ceviri``|left|18|\n" ..
        "add_spacer|small|\n" ..
        "add_textbox|`oSecili dil / Language: " .. status .. "|left|\n" ..
        "add_smalltext|`oDiger oyuncularin mesajlari sectigin dile cevrilir.|\n" ..
        "add_smalltext|`oOther players' messages are translated into your language.|\n" ..
        "add_spacer|small|\n"
    for _, code in ipairs(LANG_ORDER) do
        local label = LANGS[code].name
        if s.enabled and s.lang == code then
            label = "`2> " .. label .. " <"
        end
        d = d .. "add_button|ceviri_lang_" .. code .. "|" .. label .. "|no_flags|0|0|\n"
    end
    d = d .. "add_spacer|small|\n" ..
        "add_button|ceviri_toggle|" .. (s.enabled and "`4Ceviriyi Kapat / Turn Off" or "`2Ceviriyi Ac / Turn On") .. "|no_flags|0|0|\n" ..
        "end_dialog|ceviri_menu|Kapat||\n"
    player:onDialogRequest(d)
end

onPlayerCommandCallback(function(world, player, fullCommand)
    local cmd = (fullCommand:match("^/?(%S+)") or ""):lower()
    if cmd ~= "dil" and cmd ~= "lang" then return false end
    showMenu(player)
    return true
end)

onPlayerDialogCallback(function(world, player, data)
    local btn = data["buttonClicked"] or ""
    if btn:sub(1, 7) ~= "ceviri_" then return false end

    local s = getSettings(player)
    if btn == "ceviri_toggle" then
        saveSettings(player, { lang = s.lang, enabled = not s.enabled })
    else
        local code = btn:match("^ceviri_lang_(%a+)$")
        if code and LANGS[code] then
            saveSettings(player, { lang = code, enabled = true })
            player:onConsoleMessage("`2[Ceviri] `oDil / Language: `w" .. LANGS[code].name)
        end
    end
    showMenu(player)
    return true
end)

onPlayerLoginCallback(function(player)
    if CONFIG.LOGIN_HINT then
        player:onConsoleMessage("`2[Ceviri] `oCeviri dilini secmek icin `w/dil `o- Type `w/lang `oto choose your translation language.")
    end
    return false
end)

onPlayerDisconnectCallback(function(player)
    settings[player:getUserID()] = nil
    return false
end)

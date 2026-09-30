-- MODULE
-- Ceviri modunda CEVRILMEYECEK kelime / ifade listesi.
-- Buyuk-kucuk harf farketmez, cok kelimeli ifadeler desteklenir ("Legendary Wings").
-- 13800 satirlik listeni bu tablonun icine yapistir, sondaki "return bypass" satiri kalsin.
local bypass = {
    ['WL'] = true,
    ['DL'] = true,
    ['BGL'] = true,
    ['gg'] = true,
    ['ez'] = true,
    ['wp'] = true,
}

return bypass

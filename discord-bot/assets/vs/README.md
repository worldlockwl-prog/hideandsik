# /vs Case Battle — kasa ve item ayarları

Bu klasörü botun kök klasörüne `assets/vs` olarak koy:

```
<bot>/assets/vs/itemler.json      tüm itemler
<bot>/assets/vs/itemler/*.png     item görselleri
<bot>/assets/vs/kasalar/*.json    her kasa ayrı dosya (fiyat, görünüm, içerik + şanslar)
```

Başka bir yerde tutmak istersen `vs.ts` içindeki `VS_KLASORU` sabitini değiştir.
Değişiklikler **bot yeniden başlatılınca** geçerli olur. Animasyon GIF'leri için
botta `npm i gifenc` kurulu olmalı.

## 1) Itemler — `itemler.json`

```json
{"id": "efsanevi_01", "ad": "Ejderha Yumurtası", "nadirlik": "efsanevi", "deger": 1500, "gorsel": "itemler/efsanevi_01.png"}
```

| Alan | Açıklama |
|---|---|
| `id` | Kasa dosyalarında bu item'e bu isimle başvurulur. Benzersiz olmalı. |
| `ad` | Ekranda görünen isim |
| `nadirlik` | `siradan`, `siradisi`, `gizemli`, `destansi`, `efsanevi` |
| `deger` | Item'in DL değeri (battle'ı kazanan, iki tarafın açtığı itemlerin toplamını alır) |
| `gorsel` | PNG yolu. Yazmazsan `itemler/<id>.png` kullanılır. |

Görseli değiştirmek için `itemler/` içindeki PNG'nin üzerine aynı isimle kendi PNG'ni koy.
Kare, şeffaf arka planlı (örn. 256×256) PNG'ler en iyi sonucu verir. Dosya bulunamazsa bot
çökmez: konsola uyarı yazar ve nadirlik renginde bir taş ikonu çizer.

## 2) Kasalar — `kasalar/<kasa>.json`

Klasördeki her `.json` bir kasadır; menüde fiyata göre sıralanır. Yeni kasa eklemek için
bir dosyayı kopyalayıp `id`'sini değiştirmen yeterli (slash komutunu yeniden kaydetmen gerekir).

```json
{
  "id": "bronz",
  "ad": "Bronz Kasa",
  "emoji": "🥉",
  "fiyat": 50,
  "gorunum": {"renk": "#b4692e", "susleme": "#ffcf40", "alev": ["#fff3b0", "#ff9a1f", "#ff3d00"]},
  "icerik": [
    {"item": "siradan_01", "sans": 3.4},
    {"item": "efsanevi_01", "sans": 0.15},
    ...
  ]
}
```

### İçerik ve şanslar

- `icerik`: bu kasadan **çıkabilecek itemler** ve her birinin **yüzde şansı**.
  Listede olmayan item bu kasadan çıkmaz.
- `sans` toplamı 100 olmalı. Olmazsa bot konsola uyarı yazar ve oranları 100'e göre ölçekler
  (yani 2'ye 1 oranında yazdığın iki item yine 2'ye 1 çıkar).
- Örnek: `{"item": "efsanevi_03", "sans": 0.05}` → bu item her 2000 açılışta ortalama 1 kez çıkar.

### Görünüm

| Alan | Açıklama |
|---|---|
| `renk` | Sandık gövdesinin rengi |
| `susleme` | Metal şeritler, kenarlar, kilit |
| `alev` | Sandığı saran alevin 3 rengi: içten (en parlak) dışa doğru |
| `gorsel` | (isteğe bağlı) Çizim yerine kendi kasa PNG'n, örn. `"kasalar/bronz.png"` |

Renkler `#rrggbb` biçiminde olmalı.

## Kâr/zarar kontrolü

Bot açılırken her kasa için konsola şunu yazar:

```
[vs] Bronz Kasa (50 DL, 72 item) ortalama geri dönüş: %95.0
```

Bu, kasanın fiyatına göre ortalama ne kadar item değeri çıktığıdır. %100'ün altı kasanın
(senin) uzun vadede kazandığı anlamına gelir. Varsayılan kasaların hepsi %95'e ayarlı.
Şansları ya da item değerlerini değiştirdikten sonra bu satıra bak; %100'ü geçerse yanında
uyarı çıkar.

## Animasyon hızı

`vs.ts` içindeki `ZAMANLAMA` sabiti: sallanma kare sayısı/süresi, item'in yükselme hızı ve
item çıktıktan sonra bir sonraki tura geçmeden önceki bekleme.

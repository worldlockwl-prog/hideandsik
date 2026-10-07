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

## 2) Kasalar — otomatik oluşturucu (önerilen)

Kasa içerikleri ve fiyatları elle yazılmaz, **algoritma hesaplar**:

```
node araclar/kasalari-olustur.cjs
```

Bu komut `araclar/kasa-tasarimi.json` + `assets/vs/itemler.json` dosyalarını okuyup
`assets/vs/kasalar/*.json` dosyalarını üretir ve bir özet tablo basar (fiyat, kâr şansı,
efsanevi şansı...). **Item değerlerini değiştirdikten sonra bu komutu tekrar çalıştır**, sonra
botu yeniden başlat.

### Algoritma

1. Tasarımda her nadirliğin çıkma şansı verilir; biri `"dolgu"` olur ve kalan şansı alır.
2. Bir nadirliğin içinde item şansı **değeriyle ters orantılı**: aynı nadirlikte 1.000 DL'lik
   item, 100 DL'liğe göre 10 kat daha nadir çıkar. (`"esitlik": 0` yaparsan hepsi eşit şanslı olur.)
3. Kasanın ortalama item değeri hesaplanır, **fiyat = ortalama / rtp**, sonra yuvarlak sayıya çekilir.
4. Yuvarlamadan sonra RTP tam tutsun diye dolgu dışı şanslar aynı oranda hafifçe ölçeklenir.

### Tasarım dosyası (`araclar/kasa-tasarimi.json`)

```json
"rtp": 0.93,
{
  "id": "elmas", "ad": "Elmas Kasa", "emoji": "💎",
  "gorunum": {"renk": "#2f9fd0", "susleme": "#e8fdff", "alev": ["#e8fdff", "#4fd8ff", "#1a4dff"]},
  "sanslar": {"gizemli": "dolgu", "destansi": 70, "efsanevi": 0.15},
  "filtre": {"gizemli": {"min": 40}, "destansi": {"min": 300}}
}
```

| Alan | Açıklama |
|---|---|
| `rtp` | Ortalama geri dönüş. 0.93 = açılan her 100 DL'den ortalama 93 DL item çıkar, 7 DL kasada kalır. Kasa başına da yazılabilir. |
| `sanslar` | Nadirlik → yüzde şans. Yazılmayan nadirlik o kasadan hiç çıkmaz. |
| `filtre` | Nadirlik içinden sadece belirli değer aralığındaki itemleri al: `min`, `max`, `haric: ["id"]` |
| `fiyat` | (isteğe bağlı) Fiyatı sabitlemek istersen yaz; algoritma şansları bu fiyata göre ayarlar. |
| `gorunum` | Sandığın gövde/süsleme rengi ve 3 renkli alevi (`#rrggbb`). İsteğe bağlı `gorsel`: kendi kasa PNG'n. |

Daha cömert bir kasa için `rtp`'yi yükselt; daha çok "büyük vurgun" hissi için yüksek
nadirliklerin şansını artır (fiyat otomatik yükselir).

### Elle düzenleme

İstersen `assets/vs/kasalar/<kasa>.json` dosyalarını elle de düzenleyebilirsin: `icerik` listesi
o kasadan çıkabilecek itemleri ve her birinin yüzde şansını içerir. Ama oluşturucuyu tekrar
çalıştırırsan elle yaptığın değişikliklerin üzerine yazılır.

## Kâr/zarar kontrolü

Bot açılırken her kasa için konsola şunu yazar:

```
[vs] Elmas Kasa (600 DL, 39 item) ortalama geri dönüş: %93.0
```

%100'ün altı kasanın (senin) uzun vadede kazandığı anlamına gelir; %100'ü geçerse yanında
uyarı çıkar.

**Jackpot riski:** efsanevi itemler 50.000–100.000 DL. Uzun vadede kasa yine kârlıdır ama tek
bir efsanevi düşüşü çok büyük bir ödemedir (ör. Efsane Kasa'da her ~287 açılışta bir).
Ekonomin bu kadar büyük tek seferlik ödemeleri kaldıramıyorsa efsanevi değerlerini düşür ya da
tasarımdan efsanevi şanslarını azalt ve oluşturucuyu tekrar çalıştır.

## Animasyon nasıl çalışıyor

Rakip katıldığı an bütün kasalar açılır ve kazanan belli olur (ödeme de o an yapılır). Ardından
battle'ın tamamı **önceden tek bir GIF olarak çizilir** ve tek seferde gösterilir; turlar arasında
mesaj düzenlenmez, resim yeniden yüklenmez. 5'ten fazla kasalı battle'lar 5'er turluk GIF'lere
bölünür (dosya boyutu için). GIF bitince mesaj sabit sonuç resmine çevrilir.

- Item önce sahnede görünür, bir sonraki turun başında envantere uçar ve orada kalır.
- GIF'in son karesi 10 dakika sürecek şekilde ayarlı: Discord GIF'leri döngüye soktuğu için
  aksi halde animasyon başa sarıp envanter "geri gidiyormuş" gibi görünürdü.
- Hazırlık süresi yaklaşık: 3 kasa ~3 sn, 5 kasa ~5 sn (bu sırada bot diğer komutlara cevap verir).

`vs.ts` içindeki `ZAMANLAMA` sabitiyle kare sayıları/süreleri, item çıktıktan sonraki bekleme ve
bir GIF'e sığacak tur sayısı (`gifBasinaTur`) ayarlanabilir.

## Güvenlik notları

- **Emanet (`emanet.json`)**: oyuncudan düşülen ama henüz ödenmemiş/iade edilmemiş her giriş
  ücreti bu dosyaya yazılır. Bot lobi ya da battle sırasında çöker/yeniden başlarsa, açılışta
  dosyada kalan tutarlar sahiplerine otomatik iade edilir (konsola `Yarım kalan battle iadesi`
  yazar). Bu dosyayı elle düzenleme; normalde hep boş (`[]`) durur. Bot bu klasöre yazabilmeli.
- **Aynı anda en fazla 3 battle** animasyona girer (`MAX_ESZAMANLI_BATTLE`). Sınır doluyken
  lobiler açık kalır, "Katıl"a basan kişiye birazdan tekrar denemesi söylenir.

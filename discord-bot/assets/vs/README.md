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
3. Tasarımda `fiyat` yazılıysa o fiyat kullanılır. Yazılmamışsa kasanın ortalama item değeri
   hesaplanır, **fiyat = ortalama / rtp**, sonra yuvarlak sayıya çekilir.
4. RTP tam tutsun diye dolgudan değerli nadirliklerin şansları aynı oranda hafifçe ölçeklenir
   (dolgudan ucuz olanlar tasarımdaki gibi kalır).

### Tasarım dosyası (`araclar/kasa-tasarimi.json`)

```json
"rtp": 0.93,
{
  "id": "elmas", "ad": "Elmas Kasa", "emoji": "💎", "fiyat": 250,
  "gorunum": {"renk": "#2f9fd0", "susleme": "#e8fdff", "alev": ["#e8fdff", "#4fd8ff", "#1a4dff"]},
  "sanslar": {"gizemli": 30, "destansi": "dolgu", "efsanevi": 0.02},
  "filtre": {"gizemli": {"min": 40}}
}
```

Hazır gelen kasalar (hepsi %93 RTP, fiyatlar item seviyelerine göre seçildi):

| Kasa | Fiyat | Ağırlıkla çıkan | Kâr şansı | Efsanevi |
|---|---|---|---|---|
| 📦 Çaylak | 5 DL | Sıradan / Sıradışı | %31 | yok |
| 🥉 Bronz | 15 DL | Sıradışı / Gizemli | %33 | yok |
| 🥈 Gümüş | 40 DL | Gizemli | %31 | yok |
| 🥇 Altın | 100 DL | Gizemli / Destansı (≤500) | %28 | 1/34.483 |
| 💎 Elmas | 250 DL | Destansı | %25 | 1/6.288 |
| 🔥 Efsane | 750 DL | Destansı (≥400) | %32 | 1/2.582 |

| Alan | Açıklama |
|---|---|
| `rtp` | Ortalama geri dönüş. 0.93 = açılan her 100 DL'den ortalama 93 DL item çıkar, 7 DL kasada kalır. Kasa başına da yazılabilir. |
| `sanslar` | Nadirlik → yüzde şans. Yazılmayan nadirlik o kasadan hiç çıkmaz. |
| `filtre` | Nadirlik içinden sadece belirli değer aralığındaki itemleri al: `min`, `max`, `haric: ["id"]` |
| `fiyat` | Kasanın fiyatı; algoritma şansları bu fiyata göre ayarlar. Silersen fiyatı algoritma seçer. |
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
[vs] Elmas Kasa (250 DL, 46 item) ortalama geri dönüş: %93.0
```

%100'ün altı kasanın (senin) uzun vadede kazandığı anlamına gelir; %100'ü geçerse yanında
uyarı çıkar.

**Jackpot riski:** efsanevi itemler 50.000–100.000 DL. Uzun vadede kasa yine kârlıdır ama tek
bir efsanevi düşüşü çok büyük bir ödemedir (ör. Efsane Kasa'da her ~2.600 açılışta bir).
Ekonomin bu kadar büyük tek seferlik ödemeleri kaldıramıyorsa efsanevi değerlerini düşür ya da
tasarımdan efsanevi şanslarını azalt ve oluşturucuyu tekrar çalıştır.

## Animasyon nasıl çalışıyor

Rakip katıldığı an bütün kasalar açılır, çıkacak itemler ve kazanan belli olur (ödeme de o an
yapılır). Animasyon sadece bu hazır sonuçları gösterir. Her tur üç adım:

1. **"Kasa açılıyor" GIF'i** (~2 sn): iki kapalı sandık alevler içinde sallanır.
2. **Sonuç (sabit resim)** (~1,6 sn): açılan itemler sandık alanında (nadirlik, ad, değer),
   toplamlar güncellenmiş.
3. **Envantere düşme GIF'i** (~1,2 sn): item sahneden iz bırakarak envanterdeki yuvasına uçar,
   oturunca halka çıkar; sahnedeki ışık ve yazılar söner.

### Neden böyle

Discord GIF'leri kendi sunucusunda yeniden işliyor ve nasıl oynatılacağına kendisi karar veriyor:
istediği an baştan başlatabiliyor (pencere odağı, kaydırma, mesaj düzenlenmesi, mobil), döngüye
sokabiliyor, uzun kareleri kesebiliyor ya da sadece ilk kareyi gösterebiliyor. Buna karşı:

- **Sallanma GIF'inde hiçbir item yok.** Sallanan sandıkların dikişsiz, sonsuz döngüsü (1,2 sn;
  son karesi ilk karesiyle birebir birleşir). Discord ne yaparsa yapsın aynı görüntü.
- **Item önce sabit resimde** görünür; sabit resim oynamaz, geri gitmez.
- **Düşme GIF'i kısa ve tek seferlik:** ilk karesi az önceki sabit resimle birebir aynı, içinde
  sadece o turun itemi var, sonunda item yuvasında 8 sn sabit durur (Discord GIF'i döngüye soksa
  bile) ve ~1,2 sn sonra sıradaki tura geçilir.
- Bir GIF'te sadece hareket eden bölgeler değişir; geri kalan her şey önceki resimle aynıdır.
- Aşırı uzun kare yok (en uzun kare 1 sn).

Düşme efektini kapatmak istersen `vs.ts` içinde `ZAMANLAMA.envantereDusme: false` yap: item sonuç
resminde doğrudan yuvasında görünür.

Envanterde her turun numaralı bir yuvası var; sıradaki tur yuvası belirgin, son eklenen item
nadirlik renginde parlar, önde olan oyuncunun toplamının yanında yeşil ok çıkar. Sıradaki GIF'ler
ve resimler önceden arka planda hazırlanır; battle sırasında bot diğer komutlara cevap vermeye
devam eder. Animasyonda bir hata olursa bile oyunculara doğrudan sonuç ekranı gösterilir.

`vs.ts` içindeki `ZAMANLAMA` sabitiyle bütün süreler ayarlanabilir.

## Güvenlik notları

- **Emanet (`emanet.json`)**: oyuncudan düşülen ama henüz ödenmemiş/iade edilmemiş her giriş
  ücreti bu dosyaya yazılır. Bot lobi ya da battle sırasında çöker/yeniden başlarsa, açılışta
  dosyada kalan tutarlar sahiplerine otomatik iade edilir (konsola `Yarım kalan battle iadesi`
  yazar). Bu dosyayı elle düzenleme; normalde hep boş (`[]`) durur. Bot bu klasöre yazabilmeli.
- **Aynı anda en fazla 3 battle** animasyona girer (`MAX_ESZAMANLI_BATTLE`). Sınır doluyken
  lobiler açık kalır, "Katıl"a basan kişiye birazdan tekrar denemesi söylenir.
- **Bekleme süresi (cooldown)**: maç bittikten sonra (sonuç ekranı gelince) iki oyuncu da
  **45 sn** yeni battle açamaz ve katılamaz. Maç oynanmadan biterse (iptal, kimse katılmadı,
  kurulum süresi doldu) sadece açan kişi **15 sn** bekler. Süreler `vs.ts` içinde
  `MAC_SONRASI_BEKLEME` / `IPTAL_SONRASI_BEKLEME`. Bot yeniden başlarsa bekleme süreleri sıfırlanır.
  Bekleme mesajındaki geri sayım bitince mesaj "✅ Bekleme süren doldu" yazısına döner.

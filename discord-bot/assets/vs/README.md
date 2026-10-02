# /vs Case Battle — kasa ve item ayarları

Bu klasörü botun kök klasörüne `assets/vs` olarak koy (yani `<bot>/assets/vs/ayarlar.json`).
Başka bir yerde tutmak istersen `vs.ts` içindeki `VS_KLASORU` sabitini değiştir.
Değişiklikler **bot yeniden başlatılınca** geçerli olur.

## Item görselini değiştirmek

`itemler/` içindeki PNG'nin üzerine aynı isimle kendi PNG'ni koy, bu kadar.
Kare ve şeffaf arka planlı (örn. 256×256) PNG'ler en iyi sonucu verir.
Dosya bulunamazsa bot çökmez: konsola uyarı yazar ve nadirlik renginde bir taş ikonu çizer.

## Item eklemek / düzenlemek (`ayarlar.json` → `itemler`)

```json
{"ad": "Ejder Pulu", "nadirlik": "destansi", "deger": 150, "gorsel": "itemler/destansi_01.png"}
```

| Alan | Açıklama |
|---|---|
| `ad` | Ekranda görünen isim |
| `nadirlik` | `siradan`, `siradisi`, `gizemli`, `destansi`, `efsanevi` |
| `deger` | Item'in DL değeri (kazanan bunların toplamını alır) |
| `gorsel` | Bu klasöre göre PNG yolu |

Varsayılan havuz 100 item: 15 Sıradan, 25 Sıradışı, 25 Gizemli, 25 Destansı, 10 Efsanevi.
Sayıları serbestçe değiştirebilirsin.

## Şans nasıl işliyor (`ayarlar.json` → `kasalar`)

Kasa önce `sanslar` tablosuna göre bir **nadirlik** seçer, sonra o nadirlikteki itemlerden
birini **eşit şansla** seçer. Örneğin Çaylak Kasası'nda Efsanevi şansı %0.1'dir; Efsanevi
çıktığında 10 efsanevi itemden her biri eşit ihtimalle gelir.

```json
{"id": "caylak", "ad": "Çaylak Kasası", "emoji": "📦", "fiyat": 25, "renk": "#b07a45",
 "sanslar": {"siradan": 60.8, "siradisi": 28, "gizemli": 9.5, "destansi": 1.6, "efsanevi": 0.1}}
```

- `sanslar` yüzde cinsinden, toplamı 100 olmalı.
- `renk`: görsel yoksa çizilen sandığın rengi.
- `gorsel` (isteğe bağlı): kendi kasa PNG'ni kullanmak için, örn. `"gorsel": "kasalar/caylak.png"`.
- `id` değiştirilirse / kasa eklenirse slash komutunu yeniden kaydetmen gerekir (seçenekler değişir).

## Kâr/zarar kontrolü

Bot açılırken her kasa için konsola şunu yazar:

```
[vs] Çaylak Kasası (25 DL) ortalama geri dönüş: %95.2
```

Bu, kasanın fiyatına göre ortalama ne kadar item değeri çıktığıdır. %100'ün altı kasanın
(senin) uzun vadede kazandığı anlamına gelir. Item değerlerini ya da şansları değiştirdikten
sonra bu satıra bak; %100'ü geçerse yanında uyarı çıkar.

// Kasa oluşturucu: kasa-tasarimi.json + itemler.json -> assets/vs/kasalar/*.json
//
// Kullanım (bot klasöründen):
//   node araclar/kasalari-olustur.cjs                 -> assets/vs klasörünü kullanır
//   node araclar/kasalari-olustur.cjs <assets/vs yolu>
//
// Algoritma (her kasa için):
//   1) Tasarımda her nadirliğin çıkma şansı verilir; biri "dolgu" olur ve kalan şansı alır.
//   2) Bir nadirliğin içinde item şansı değeriyle TERS orantılıdır (ağırlık = 1 / değer^esitlik):
//      aynı nadirlikte 1000 DL'lik item, 100 DL'lik olandan 10 kat daha nadir çıkar.
//   3) Kasanın ortalama item değeri hesaplanır; fiyat = ortalama / rtp, sonra yuvarlak sayıya çekilir.
//   4) Yuvarlamadan sonra RTP tam tutsun diye dolgu dışındaki nadirliklerin şansları aynı oranda
//      hafifçe ölçeklenir (genelde %1-3).
// Item değerlerini değiştirdikten sonra bu scripti tekrar çalıştırman yeterli; fiyatlar ve
// şanslar yeniden hesaplanır. Botu yeniden başlatmayı unutma.

const fs = require('fs');
const path = require('path');

const VS = path.resolve(process.argv[2] || path.join(__dirname, '..', 'assets', 'vs'));
const NADIRLIKLER = ['siradan', 'siradisi', 'gizemli', 'destansi', 'efsanevi'];
const NADIRLIK_ADI = { siradan: 'Sıradan', siradisi: 'Sıradışı', gizemli: 'Gizemli', destansi: 'Destansı', efsanevi: 'Efsanevi' };

const oku = dosya => JSON.parse(fs.readFileSync(dosya, 'utf-8'));
const itemler = oku(path.join(VS, 'itemler.json'));
const tasarim = oku(path.join(__dirname, 'kasa-tasarimi.json'));

// Yuvarlak fiyat: küçük kasalarda 5'in, büyüklerde 10/50/100'ün katı
function yuvarlakFiyat(x) {
    const adim = x < 50 ? 5 : x < 200 ? 10 : x < 1000 ? 50 : 100;
    return Math.max(adim, Math.round(x / adim) * adim);
}

const sayi = n => n.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
const olasilik = p => p >= 0.01 ? `%${sayi(p * 100)}` : `1/${sayi(Math.round(1 / p))}`;

const kasaKlasoru = path.join(VS, 'kasalar');
fs.mkdirSync(kasaKlasoru, { recursive: true });
const yazilanlar = new Set();
const ozet = [];

for (const k of tasarim.kasalar) {
    const rtp = k.rtp ?? tasarim.rtp;
    const esitlik = k.esitlik ?? tasarim.esitlik ?? 1;
    const hata = m => { throw new Error(`[${k.id}] ${m}`); };

    // --- 1) Nadirlik başına item havuzu (filtre: min/max değer) ve iç ağırlıklar ---
    const gruplar = {};
    for (const n of Object.keys(k.sanslar)) {
        if (!NADIRLIKLER.includes(n)) hata(`bilinmeyen nadirlik "${n}"`);
        const filtre = (k.filtre && k.filtre[n]) || {};
        const liste = itemler.filter(i => i.nadirlik === n
            && (filtre.min === undefined || i.deger >= filtre.min)
            && (filtre.max === undefined || i.deger <= filtre.max)
            && !(filtre.haric || []).includes(i.id));
        if (!liste.length) hata(`${NADIRLIK_ADI[n]} için filtreye uyan item yok`);
        const agirliklar = liste.map(i => Math.pow(i.deger, -esitlik));
        const toplam = agirliklar.reduce((a, b) => a + b, 0);
        const ic = liste.map((i, x) => ({ item: i, pay: agirliklar[x] / toplam }));
        gruplar[n] = { ic, ortalama: ic.reduce((t, s) => t + s.item.deger * s.pay, 0) };
    }

    const dolgu = Object.keys(k.sanslar).find(n => k.sanslar[n] === 'dolgu');
    if (!dolgu) hata('bir nadirliğin şansı "dolgu" olmalı (kalan şansı o alır)');
    const digerleri = Object.keys(k.sanslar).filter(n => n !== dolgu);
    const p0 = Object.fromEntries(digerleri.map(n => [n, k.sanslar[n] / 100]));

    // --- 2-3) Doğal fiyat ve yuvarlak fiyat ---
    const beklenen = olc => {
        const digerToplam = digerleri.reduce((t, n) => t + p0[n] * olc, 0);
        return digerleri.reduce((t, n) => t + p0[n] * olc * gruplar[n].ortalama, 0) + (1 - digerToplam) * gruplar[dolgu].ortalama;
    };
    const dogalFiyat = beklenen(1) / rtp;
    const fiyat = k.fiyat ?? yuvarlakFiyat(dogalFiyat);

    // --- 4) Yuvarlanmış fiyatta RTP tutsun: dolgu dışı şansları aynı oranda ölçekle ---
    const hedef = rtp * fiyat;
    const E0 = gruplar[dolgu].ortalama;
    const egim = digerleri.reduce((t, n) => t + p0[n] * (gruplar[n].ortalama - E0), 0);
    const olcek = (hedef - E0) / egim;
    const p = Object.fromEntries(digerleri.map(n => [n, p0[n] * olcek]));
    p[dolgu] = 1 - digerleri.reduce((t, n) => t + p[n], 0);
    if (!(olcek > 0) || p[dolgu] < 0.02) hata(`şanslar bu fiyata uymuyor (dolgu şansı %${(p[dolgu] * 100).toFixed(2)}); tasarımdaki şansları düşür`);

    // --- Item başına şans (yüzde, 6 ondalık) ---
    const icerik = [];
    for (const n of NADIRLIKLER) {
        if (!gruplar[n]) continue;
        for (const s of gruplar[n].ic) icerik.push({ item: s.item.id, sans: +(p[n] * s.pay * 100).toFixed(6) });
    }
    // Yuvarlama artığını en sık çıkan iteme ekle: toplam tam 100 olsun
    const fark = +(100 - icerik.reduce((t, s) => t + s.sans, 0)).toFixed(6);
    icerik.reduce((a, b) => (b.sans > a.sans ? b : a)).sans = +(icerik.reduce((a, b) => (b.sans > a.sans ? b : a)).sans + fark).toFixed(6);

    // --- İstatistikler ---
    const degerOf = id => itemler.find(i => i.id === id).deger;
    const gercekRtp = icerik.reduce((t, s) => t + degerOf(s.item) * s.sans / 100, 0) / fiyat;
    const karSansi = icerik.filter(s => degerOf(s.item) >= fiyat).reduce((t, s) => t + s.sans / 100, 0);
    const sirali = [...icerik].sort((a, b) => degerOf(a.item) - degerOf(b.item));
    let birikim = 0;
    const medyan = degerOf(sirali.find(s => (birikim += s.sans / 100) >= 0.5).item);

    const cikti = {
        id: k.id, ad: k.ad, emoji: k.emoji, fiyat,
        gorunum: k.gorunum,
        icerik
    };
    const satirlar = [
        '{',
        `  "id": ${JSON.stringify(cikti.id)},`,
        `  "ad": ${JSON.stringify(cikti.ad)},`,
        `  "emoji": ${JSON.stringify(cikti.emoji)},`,
        `  "fiyat": ${cikti.fiyat},`,
        `  "gorunum": ${JSON.stringify(cikti.gorunum)},`,
        '  "icerik": [',
        ...icerik.map((s, x) => `    ${JSON.stringify(s)}${x < icerik.length - 1 ? ',' : ''}`),
        '  ]',
        '}',
        ''
    ];
    fs.writeFileSync(path.join(kasaKlasoru, `${k.id}.json`), satirlar.join('\n'));
    yazilanlar.add(`${k.id}.json`);

    ozet.push({
        Kasa: `${k.emoji} ${k.ad}`,
        Fiyat: `${sayi(fiyat)} DL`,
        Item: icerik.length,
        RTP: `%${(gercekRtp * 100).toFixed(1)}`,
        'Kâr şansı': `%${(karSansi * 100).toFixed(1)}`,
        'Tipik sonuç': `${sayi(medyan)} DL`,
        ...Object.fromEntries(NADIRLIKLER.filter(n => p[n] !== undefined).map(n => [NADIRLIK_ADI[n], olasilik(p[n])]))
    });
}

console.table(ozet);
console.log('Kâr şansı = açılan item\'in kasa fiyatından değerli çıkma ihtimali.');
console.log('Tipik sonuç = açılışların yarısında bundan az, yarısında bundan çok değerli item çıkar.');

const fazlalar = fs.readdirSync(kasaKlasoru).filter(f => f.endsWith('.json') && !yazilanlar.has(f));
if (fazlalar.length) {
    console.warn(`\n⚠️  kasalar/ içinde tasarımda olmayan dosyalar var (bot bunları da yükler): ${fazlalar.join(', ')}`);
}

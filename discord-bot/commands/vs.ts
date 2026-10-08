import { createRequire } from 'module';
// Bot ESM olarak çalışıyor: CommonJS paketi olan gifenc'i require ile yüklemek için
const require = createRequire(import.meta.url);
import {
    ChatInputCommandInteraction,
    ApplicationCommandOptionType,
    ApplicationCommandOptionData,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageActionRowComponentBuilder,
    MessageComponentInteraction,
    Message,
    User
} from 'discord.js';
import { createCanvas, loadImage, Image, Canvas, CanvasRenderingContext2D } from 'canvas';
import { randomInt } from 'crypto';
import { readFileSync, readdirSync, writeFileSync, renameSync } from 'fs';
import path from 'path';
import { Command, CommandDeferType } from '../structers/command';
import { dbManager } from '../db/db';
import config2 from './config.json'

// gifenc'in (npm i gifenc) TypeScript tip dosyası yok; kullandığımız kısmı burada tanımlıyoruz.
interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: {
        palette?: number[][]; delay?: number; repeat?: number;
        transparent?: boolean; transparentIndex?: number; dispose?: number;
    }): void;
    finish(): void;
    bytes(): Uint8Array;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gifenc = require('gifenc') as {
    GIFEncoder(): GifEncoder;
    quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): number[][];
};

const DL = '<:DL:1381246442089349255>';

// Kasa/item ayarları ve PNG'ler bu klasörde. Bot kök klasöründen çalıştırılıyorsa:
//   <bot>/assets/vs/itemler.json        -> tüm itemler (ad, nadirlik, değer, PNG)
//   <bot>/assets/vs/kasalar/*.json      -> her kasa ayrı dosya: fiyat, görünüm, içerik + şanslar
//   <bot>/assets/vs/itemler/*.png       -> item görselleri
// Değişiklikler bot yeniden başlatılınca geçerli olur.
const VS_KLASORU = path.join(process.cwd(), 'assets', 'vs');

// Animasyon zamanlaması. Hızlandırmak/yavaşlatmak için sadece bu sayıları değiştir (ms).
const ZAMANLAMA = {
    // Hareketler zamana bağlı: kare sayısını artırıp gecikmeyi düşürmek animasyonu akıcılaştırır,
    // hızını değiştirmez (ama GIF büyür ve hazırlanması uzar). 40 ms = saniyede 25 kare.
    gecisKaresi: 12,         // tur başı: önceki item envantere uçar, yeni sandık düşer
    gecisGecikme: 40,
    sallanmaKaresi: 25,      // sandığın sallandığı kare sayısı
    sallanmaGecikme: 40,     // her sallanma karesinin süresi -> 25 x 40 = 1 sn
    patlamaKaresi: 5,
    patlamaGecikme: 40,
    yukselmeKaresi: 10,      // item'in sandıktan yükseldiği kare sayısı
    yukselmeGecikme: 40,
    sonucuGoster: 2200,      // item çıktıktan sonra ekranda kalma süresi (sıradaki turun GIF'inin ilk karesi)
    sonucuGosterKalabalik: 1600, // 5'ten fazla kasalı battle'da aynı bekleme
    yuklemePayi: 1000        // GIF'in izleyicinin Discord'unda inip başlaması için ek bekleme
};

// ==================================================
// NADİRLİK / ITEM / KASA TANIMLARI (assets/vs'den)
// ==================================================
const NADIRLIKLER = [
    { id: 'siradan', ad: 'Sıradan', renk: '#9aa0ab' },
    { id: 'siradisi', ad: 'Sıradışı', renk: '#3ddc84' },
    { id: 'gizemli', ad: 'Gizemli', renk: '#2f9bff' },
    { id: 'destansi', ad: 'Destansı', renk: '#b14cff' },
    { id: 'efsanevi', ad: 'Efsanevi', renk: '#ffb300' }
] as const;

interface KasaItemi {
    id: string;
    ad: string;
    seviye: number;  // NADIRLIKLER içindeki sıra: 0 Sıradan ... 4 Efsanevi
    renk: string;
    deger: number;   // DL karşılığı
    gorsel: string;  // VS_KLASORU'na göre PNG yolu
    resim?: Image | null; // yüklenince dolar, PNG yoksa null (yedek ikon çizilir)
}

interface KasaGorunumu {
    renk: string;                    // sandık gövdesi
    susleme: string;                 // metal şeritler, kenarlar, kilit
    alev: [string, string, string];  // alevin içten dışa renkleri
    gorsel?: string;                 // isteğe bağlı: çizim yerine kendi kasa PNG'n
}

interface Kasa {
    id: string;
    ad: string;
    emoji: string;
    fiyat: number;
    gorunum: KasaGorunumu;
    resim?: Image | null;
    icerik: { item: KasaItemi; agirlik: number }[];
    toplamAgirlik: number;
    nadirlikSansi: number[]; // nadirlik başına toplam şans (%)
    rtp: number;             // ortalama geri dönüş (fiyata oranla)
}

function jsonOku<T>(dosya: string): T {
    try {
        return JSON.parse(readFileSync(dosya, 'utf-8')) as T;
    } catch (err) {
        throw new Error(`[vs] ${dosya} okunamadı: ${(err as Error).message}`);
    }
}

const HEX_RENK = /^#[0-9a-fA-F]{6}$/;

function ayarlariYukle(): Kasa[] {
    // --- Itemler ---
    const hamItemler = jsonOku<{ id: string; ad: string; nadirlik: string; deger: number; gorsel?: string }[]>(path.join(VS_KLASORU, 'itemler.json'));
    const itemler = new Map<string, KasaItemi>();
    for (const it of hamItemler) {
        const seviye = NADIRLIKLER.findIndex(n => n.id === it.nadirlik);
        if (seviye === -1) throw new Error(`[vs] itemler.json: "${it.id}" bilinmeyen nadirlik "${it.nadirlik}"`);
        if (!(it.deger > 0)) throw new Error(`[vs] itemler.json: "${it.id}" değeri 0'dan büyük olmalı`);
        if (itemler.has(it.id)) throw new Error(`[vs] itemler.json: "${it.id}" iki kere tanımlı`);
        itemler.set(it.id, {
            id: it.id, ad: it.ad, seviye, renk: NADIRLIKLER[seviye].renk,
            deger: Math.floor(it.deger), gorsel: it.gorsel ?? `itemler/${it.id}.png`
        });
    }

    // --- Kasalar: kasalar/ klasöründeki her .json bir kasa ---
    const kasaKlasoru = path.join(VS_KLASORU, 'kasalar');
    const kasalar = readdirSync(kasaKlasoru).filter(f => f.endsWith('.json')).map((dosya): Kasa => {
        const k = jsonOku<{ id: string; ad: string; emoji: string; fiyat: number; gorunum: KasaGorunumu; icerik: { item: string; sans: number }[] }>(path.join(kasaKlasoru, dosya));
        const hata = (m: string) => new Error(`[vs] kasalar/${dosya}: ${m}`);
        if (!k.id || !k.ad || !Number.isInteger(k.fiyat) || k.fiyat <= 0) throw hata('id, ad ve fiyat (pozitif tam sayı) zorunlu');
        const renkler = [k.gorunum?.renk, k.gorunum?.susleme, ...(k.gorunum?.alev ?? [])];
        if (renkler.length !== 5 || !renkler.every(r => HEX_RENK.test(r ?? ''))) {
            throw hata('gorunum.renk, gorunum.susleme ve 3 renkli gorunum.alev "#rrggbb" biçiminde olmalı');
        }
        if (!k.icerik?.length) throw hata('icerik boş');

        const icerik = k.icerik.map(s => {
            const item = itemler.get(s.item);
            if (!item) throw hata(`"${s.item}" itemler.json'da yok`);
            if (!(s.sans > 0)) throw hata(`"${s.item}" şansı 0'dan büyük olmalı`);
            // 1/1.000.000 yüzde hassasiyet: 1/30.000 gibi çok küçük şanslar da tam karşılanır
            return { item, agirlik: Math.round(s.sans * 1_000_000) };
        });
        const toplamSans = k.icerik.reduce((t, s) => t + s.sans, 0);
        if (Math.abs(toplamSans - 100) > 0.01) {
            console.warn(`[vs] kasalar/${dosya}: şansların toplamı %${toplamSans.toFixed(2)}, 100'e göre oranlanarak kullanılacak`);
        }
        const toplamAgirlik = icerik.reduce((t, s) => t + s.agirlik, 0);
        const nadirlikSansi = NADIRLIKLER.map((_, i) =>
            icerik.filter(s => s.item.seviye === i).reduce((t, s) => t + s.agirlik, 0) / toplamAgirlik * 100);
        const ortalama = icerik.reduce((t, s) => t + s.item.deger * s.agirlik, 0) / toplamAgirlik;
        return {
            id: k.id, ad: k.ad, emoji: k.emoji, fiyat: k.fiyat, gorunum: k.gorunum,
            icerik, toplamAgirlik, nadirlikSansi, rtp: ortalama / k.fiyat
        };
    }).sort((a, b) => a.fiyat - b.fiyat);

    if (kasalar.length === 0) throw new Error(`[vs] ${kasaKlasoru} içinde kasa yok`);
    if (kasalar.length > 25) throw new Error('[vs] Discord menüsü en fazla 25 kasa gösterebilir');
    const idler = new Set<string>();
    for (const k of kasalar) {
        if (idler.has(k.id)) throw new Error(`[vs] "${k.id}" id'li iki kasa var`);
        idler.add(k.id);
        // Item değerleri/şanslar değiştirilince kasanın kâra mı zarara mı geçtiği konsoldan görülsün
        const uyari = k.rtp > 1 ? '  ⚠️ %100 üstü: bu kasa uzun vadede para kaybettirir!' : '';
        console.log(`[vs] ${k.ad} (${k.fiyat} DL, ${k.icerik.length} item) ortalama geri dönüş: %${(k.rtp * 100).toFixed(1)}${uyari}`);
    }
    return kasalar;
}

const KASALAR = ayarlariYukle();
const KASA_MAP = new Map(KASALAR.map(k => [k.id, k]));

const MAX_KASA = 10;
const KURULUM_SURESI = 90_000;   // kurucu bu süre boyunca hiçbir şeye basmazsa kurulum iptal
const LOBI_SURESI = 120_000;     // bu sürede rakip katılmazsa battle iptal + iade

// --- ZIRH 1: AYNI ANDA TEK BATTLE (hem kurucu hem rakip için) ---
const aktifOynayanlar = new Set<string>();

// --- BEKLEME SÜRESİ (cooldown) ---
// Maç bittiği an (sonuç ekranı gelince) iki oyuncu da bu süre boyunca yeni battle açamaz/katılamaz.
// Maç oynanmadan biterse (iptal, kimse katılmadı, kurulum süresi doldu) sadece açan kişi kısa süre bekler.
const MAC_SONRASI_BEKLEME = 45_000;
const IPTAL_SONRASI_BEKLEME = 15_000;
const beklemeBitisi = new Map<string, number>();

// Bekleme bitmediyse bitiş zamanını, bittiyse null döner
function beklemedeMi(kullanici: string): number | null {
    const bitis = beklemeBitisi.get(kullanici);
    if (bitis === undefined) return null;
    if (bitis <= Date.now()) {
        beklemeBitisi.delete(kullanici);
        return null;
    }
    return bitis;
}

function beklemeYazisi(bitis: number): string {
    // <t:...:R> Discord'da canlı geri sayım olarak görünür ("12 saniye içinde")
    return `⏳ Son battle'ından sonra biraz beklemelisin: <t:${Math.ceil(bitis / 1000)}:R> tekrar deneyebilirsin.`;
}

// Bekleme mesajını gösterir; süre dolunca mesajı "hazırsın" yazısına çevirir.
// (Yoksa Discord'un geri sayımı sıfırdan sonra "1 saniye önce", "2 saniye önce" diye saymaya devam ediyor.)
async function beklemeyiBildir(bitis: number, goster: (metin: string) => Promise<unknown>, duzenle: (metin: string) => Promise<unknown>) {
    await goster(beklemeYazisi(bitis));
    setTimeout(() => {
        duzenle('✅ Bekleme süren doldu, tekrar `/vs` kullanabilirsin.').catch(() => { });
    }, Math.max(0, bitis - Date.now()) + 500).unref();
}

// --- ZIRH 2: AYNI ANDA OYNANAN BATTLE SINIRI ---
// GIF üretimi işlemciyi yoruyor; çok sayıda battle aynı anda animasyona girerse bot yavaşlar.
// Sınır doluysa lobiler açık kalır, sadece "Katıl" o an reddedilir.
const MAX_ESZAMANLI_BATTLE = 3;
let oynananBattleSayisi = 0;

// --- ZIRH 3: EMANET (bot çökse/yeniden başlasa bile para kaybolmasın) ---
// Oyuncudan düşülen ama henüz ödemesi/iadesi yapılmamış her tutar bu dosyada tutulur.
// Bot açılınca dosyada kalan kayıtlar (yarım kalmış battle'lar) sahiplerine iade edilir.
interface Emanet { battle: string; kullanici: string; miktar: number; zaman: number }
const EMANET_DOSYASI = path.join(VS_KLASORU, 'emanet.json');

function emanetleriOku(): Emanet[] {
    try {
        return JSON.parse(readFileSync(EMANET_DOSYASI, 'utf-8')) as Emanet[];
    } catch {
        return [];
    }
}

function emanetleriYaz(liste: Emanet[]) {
    // Önce geçici dosyaya yazıp sonra adını değiştiriyoruz: yazarken çökse bile dosya bozulmaz
    const gecici = EMANET_DOSYASI + '.tmp';
    writeFileSync(gecici, JSON.stringify(liste, null, 2));
    renameSync(gecici, EMANET_DOSYASI);
}

function emanetEkle(battle: string, kullanici: string, miktar: number) {
    emanetleriYaz([...emanetleriOku(), { battle, kullanici, miktar, zaman: Date.now() }]);
}

// Ödeme/iade yapılmadan HEMEN ÖNCE çağrılır: kayıt silinip sonra para verilir,
// böylece hiçbir senaryoda aynı tutar iki kere ödenmez.
function emanetKapat(battle: string, kullanici?: string) {
    emanetleriYaz(emanetleriOku().filter(e => !(e.battle === battle && (!kullanici || e.kullanici === kullanici))));
}

// Sadece süreç başına bir kere çalışır: o an dosyada olan her kayıt önceki çalışmadan kalmadır.
let yarimKalanlarIadeEdildi = false;
function yarimKalanlariIadeEt() {
    if (yarimKalanlarIadeEdildi) return;
    for (const e of emanetleriOku()) {
        emanetKapat(e.battle, e.kullanici);
        dbManager.addDL(e.kullanici, e.miktar);
        console.log(`[vs] Yarım kalan battle iadesi: ${e.kullanici} +${e.miktar} DL (battle ${e.battle})`);
    }
    yarimKalanlarIadeEdildi = true;
}
try {
    yarimKalanlariIadeEt();
} catch (err) {
    // Veritabanı henüz hazır değilse ilk /vs komutunda tekrar denenecek
    console.warn('[vs] Yarım kalan battle iadeleri şimdi yapılamadı, ilk /vs komutunda denenecek:', (err as Error).message);
}

function itemCek(kasa: Kasa): KasaItemi {
    // Tower'daki gibi kriptografik üreteç: sonuç V8'in PRNG'sinden tahmin edilemez.
    let r = randomInt(kasa.toplamAgirlik);
    for (const s of kasa.icerik) {
        if (r < s.agirlik) return s.item;
        r -= s.agirlik;
    }
    return kasa.icerik[kasa.icerik.length - 1].item;
}

function toplamFiyat(kasalar: Kasa[]): number {
    return kasalar.reduce((t, k) => t + k.fiyat, 0);
}

// ==================================================
// PNG YÜKLEME (önbellekli)
// ==================================================
const gorselOnbellegi = new Map<string, Promise<Image | null>>();

function gorselYukle(dosya: string): Promise<Image | null> {
    const tam = path.join(VS_KLASORU, dosya);
    let yukleme = gorselOnbellegi.get(tam);
    if (!yukleme) {
        yukleme = loadImage(tam).catch(() => {
            console.warn(`[vs] Görsel bulunamadı, yedek çizim kullanılacak: ${tam}`);
            return null;
        });
        gorselOnbellegi.set(tam, yukleme);
    }
    return yukleme;
}

// Çizim senkron olduğu için kullanılacak görseller çizimden önce yüklenip nesneye yazılıyor
async function gorselleriHazirla(itemler: KasaItemi[], kasalar: Kasa[]) {
    await Promise.all([
        ...itemler.filter(i => i.resim === undefined).map(async i => { i.resim = await gorselYukle(i.gorsel); }),
        ...kasalar.filter(k => k.resim === undefined).map(async k => { k.resim = k.gorunum.gorsel ? await gorselYukle(k.gorunum.gorsel) : null; })
    ]);
}

// Bot açılırken tüm PNG'leri arka planda ısıt; ilk battle'da bekleme olmasın
void gorselleriHazirla(KASALAR.flatMap(k => k.icerik.map(s => s.item)), KASALAR);

// ==================================================
// CANVAS ÇİZİM MOTORU
// ==================================================
// Tüm çizim 1000x620 mantıksal koordinatta yapılır. Sabit resimler bu boyutta,
// animasyonlu GIF'ler dosya boyutu küçük kalsın diye %80 ölçekte üretilir
// (Discord zaten ~550px genişlikte gösteriyor, fark görünmüyor).
const GENISLIK = 1000;
const YUKSEKLIK = 620;
const GIF_OLCEK = 0.8;
const PANEL_W = 460;
const PANEL_X: [number, number] = [14, 526];
// Kurulum/lobi ekranı
const PANEL_Y = 136;
const PANEL_H = 408;
// Battle/sonuç ekranı: üstteki kasa şeridi yerine ince ilerleme çubuğu var, paneller daha büyük
const B_PANEL_Y = 72;
const B_PANEL_H = 474;
const OYUNCU_RENKLERI: [string, string] = ['#2469ff', '#ff122a'];

interface OyuncuGorunumu {
    isim: string;
    avatar: Image | null;
    acilanlar: KasaItemi[];
    toplam: number;
}

// Bir oyuncunun kutu açma sahnesinin tek bir karesi
interface KutuSahnesi {
    kasa: Kasa;
    item: KasaItemi;
    evre: 'gecis' | 'salla' | 'patla' | 'yuksel' | 'son';
    t: number;    // evre içindeki ilerleme 0..1
    kare: number; // tur başından beri geçen süre / 100 ms (alev titremesi, sallanma, kıvılcımlar)
    faz: number;  // iki oyuncunun sandığı aynı anda aynı yöne sallanmasın
    onceki: KasaItemi | null; // geçişte envantere uçan bir önceki turun itemi
    kapanis?: boolean;        // son turdan sonra: sadece item envantere uçar, yeni sandık düşmez
}

interface CizimDurumu {
    asama: 'kurulum' | 'lobi' | 'battle' | 'bitti';
    kasalar: Kasa[];
    aktifTur: number;
    oyuncular: [OyuncuGorunumu, OyuncuGorunumu | null];
    sahneler?: [KutuSahnesi, KutuSahnesi];
    kazanan?: 0 | 1 | -1; // -1 = berabere
    altYazi: string;
}

// 25700 -> "25.700"
const sayi = (n: number) => n.toLocaleString('tr-TR');
const yumusakCikis = (t: number) => 1 - Math.pow(1 - t, 3);
const geriSekme = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
// Yere düşüp iki kere hafifçe seken hareket (0..1): ivmeli düşüş, %10 ve %3'lük sekmeler
const zipla = (t: number) => {
    if (t < 0.55) return Math.pow(t / 0.55, 2);
    if (t < 0.82) return 1 - 0.1 * Math.sin((t - 0.55) / 0.27 * Math.PI);
    return 1 - 0.03 * Math.sin((t - 0.82) / 0.18 * Math.PI);
};
const sinirla = (t: number) => Math.max(0, Math.min(1, t));
// Kareden kareye aynı kalan "rastgele" sayı (kıvılcım konumları için)
const sabitRastgele = (n: number) => {
    const x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
};

// Hex rengi beyaza (oran > 0) ya da siyaha (oran < 0) doğru kaydırır
function renkTon(hex: string, oran: number): string {
    const n = parseInt(hex.slice(1), 16);
    const hedef = oran > 0 ? 255 : 0;
    const o = Math.abs(oran);
    const kanal = (c: number) => Math.round(c + (hedef - c) * o);
    return `rgb(${kanal(n >> 16)}, ${kanal((n >> 8) & 255)}, ${kanal(n & 255)})`;
}

function yuvarlakYol(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function neonKutu(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, dolgu: string, neon: string | null, blur: number = 25) {
    yuvarlakYol(ctx, x, y, w, h, r);
    if (neon) {
        ctx.shadowColor = neon;
        ctx.shadowBlur = blur;
    }
    ctx.fillStyle = dolgu;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
}

function kisalt(ctx: CanvasRenderingContext2D, metin: string, maxGenislik: number): string {
    if (ctx.measureText(metin).width <= maxGenislik) return metin;
    let s = metin;
    while (s.length > 0 && ctx.measureText(s + '…').width > maxGenislik) s = s.slice(0, -1);
    return s + '…';
}

// Metni verilen genişliğe sığana kadar küçült
function sigdirFont(ctx: CanvasRenderingContext2D, metin: string, maxGenislik: number, boyut: number, minBoyut: number, aile: string = 'Arial') {
    ctx.font = `bold ${boyut}px ${aile}`;
    while (boyut > minBoyut && ctx.measureText(metin).width > maxGenislik) ctx.font = `bold ${--boyut}px ${aile}`;
}

// Arka plan her karede aynı: bir kez çizilip saklanıyor, sonra sadece kopyalanıyor
let arkaPlanOnbellegi: Canvas | null = null;
function cizArkaPlan(ctx: CanvasRenderingContext2D) {
    if (!arkaPlanOnbellegi) {
        arkaPlanOnbellegi = createCanvas(GENISLIK, YUKSEKLIK);
        arkaPlaniOlustur(arkaPlanOnbellegi.getContext('2d'));
    }
    ctx.drawImage(arkaPlanOnbellegi, 0, 0);
}

function arkaPlaniOlustur(ctx: CanvasRenderingContext2D) {
    const bg = ctx.createRadialGradient(GENISLIK / 2, YUKSEKLIK / 2, 50, GENISLIK / 2, YUKSEKLIK / 2, GENISLIK);
    bg.addColorStop(0, '#15151e');
    bg.addColorStop(1, '#050508');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, GENISLIK, YUKSEKLIK);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < GENISLIK; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, YUKSEKLIK); ctx.stroke();
    }
    for (let y = 0; y < YUKSEKLIK; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(GENISLIK, y); ctx.stroke();
    }
}

function cizAvatar(ctx: CanvasRenderingContext2D, oyuncu: OyuncuGorunumu, cx: number, cy: number, r: number, renk: string) {
    ctx.save();
    ctx.shadowColor = renk;
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = renk;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (oyuncu.avatar) {
        ctx.drawImage(oyuncu.avatar, cx - r, cy - r, r * 2, r * 2);
    } else {
        // Avatar indirilemediyse baş harf
        ctx.fillStyle = '#1b1c22';
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.floor(r)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(oyuncu.isim.charAt(0).toUpperCase(), cx, cy + 2);
    }
    ctx.restore();
}

function cizEtiket(ctx: CanvasRenderingContext2D, metin: string, cx: number, cy: number, renk: string, boyut: number = 18) {
    ctx.font = `bold ${boyut}px Arial`;
    const w = ctx.measureText(metin).width + boyut * 2.2;
    const h = boyut * 2;
    neonKutu(ctx, cx - w / 2, cy - h / 2, w, h, h / 2, '#121318', renk, 16);
    yuvarlakYol(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.strokeStyle = renk;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = renk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(metin, cx, cy + 1);
}

// Item/kazanan arkasındaki ışık hüzmeleri
function cizIsinlar(ctx: CanvasRenderingContext2D, cx: number, cy: number, yaricap: number, renk: string, opaklik: number = 1, donus: number = 0) {
    ctx.save();
    ctx.globalAlpha *= opaklik;
    ctx.translate(cx, cy);
    ctx.rotate(donus);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, yaricap);
    g.addColorStop(0, renk + 'cc');
    g.addColorStop(1, renk + '00');
    ctx.fillStyle = g;
    for (let i = 0; i < 12; i++) {
        ctx.rotate(Math.PI / 6);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(yaricap, -yaricap * 0.13);
        ctx.lineTo(yaricap, yaricap * 0.13);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
}

function cizParilti(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, renk: string) {
    ctx.save();
    ctx.fillStyle = renk;
    ctx.shadowColor = renk;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.quadraticCurveTo(x, y, x - r, y);
    ctx.quadraticCurveTo(x, y, x, y - r);
    ctx.fill();
    ctx.restore();
}

// Sandığın arkasından yükselen alevler + uçuşan kıvılcımlar.
// Renkler kasanın gorunum.alev ayarından gelir; `kare` değiştikçe alevler titrer.
function cizAlevler(ctx: CanvasRenderingContext2D, cx: number, tabanY: number, genislik: number, yukseklik: number, alev: [string, string, string], kare: number, faz: number, guc: number) {
    if (guc <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const dil = 9;
    const katmanlar: [string, number][] = [[alev[2], 1], [alev[1], 0.72], [alev[0], 0.42]];
    katmanlar.forEach(([renk, olcek], katman) => {
        for (let i = 0; i < dil; i++) {
            const o = i / (dil - 1) - 0.5;
            const merkezlik = 1 - Math.abs(o) * 1.1;
            const titreme = 0.7 + 0.3 * Math.abs(Math.sin(kare * 0.9 + i * 1.7 + faz + katman));
            const h = yukseklik * (0.55 + 0.45 * guc) * Math.max(0.35, merkezlik) * titreme * olcek;
            if (h < 4) continue;
            const fw = (genislik / dil) * 2.1 * olcek + 6;
            const bx = cx + o * genislik * 0.95;
            const salinim = Math.sin(kare * 0.7 + i * 2.3 + faz) * fw * 0.35;
            const g = ctx.createLinearGradient(0, tabanY, 0, tabanY - h);
            g.addColorStop(0, renk + 'ff');
            g.addColorStop(0.55, renk + 'aa');
            g.addColorStop(1, renk + '00');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.moveTo(bx - fw / 2, tabanY);
            ctx.bezierCurveTo(bx - fw / 2, tabanY - h * 0.45, bx - fw * 0.15 + salinim, tabanY - h * 0.75, bx + salinim, tabanY - h);
            ctx.bezierCurveTo(bx + fw * 0.15 + salinim, tabanY - h * 0.75, bx + fw / 2, tabanY - h * 0.45, bx + fw / 2, tabanY);
            ctx.closePath();
            ctx.fill();
        }
    });

    // Kıvılcımlar: her biri kendi hızında yukarı süzülüp sönüyor
    const yol = yukseklik * 1.5;
    for (let i = 0; i < 16; i++) {
        const r1 = sabitRastgele(i + faz * 10);
        const r2 = sabitRastgele(i * 3.7 + faz * 20);
        const ilerleme = ((kare * (6 + r2 * 6) + r2 * yol) % yol);
        ctx.globalAlpha = Math.max(0, 1 - ilerleme / yol) * guc;
        ctx.fillStyle = i % 2 === 0 ? alev[0] : alev[1];
        ctx.beginPath();
        ctx.arc(cx + (r1 - 0.5) * genislik * 1.15 + Math.sin(kare * 0.5 + i) * 6, tabanY - ilerleme, 1.5 + r1 * 2.5, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

// PNG'si olmayan item için nadirlik renginde kesme taş ikonu
function cizYedekIkon(ctx: CanvasRenderingContext2D, item: KasaItemi, cx: number, cy: number, boyut: number) {
    const r = boyut * 0.45;
    const ust = cy - r * 0.55;
    const kus = cy - r * 0.05;
    ctx.save();
    const g = ctx.createLinearGradient(cx - r, ust, cx + r, cy + r);
    g.addColorStop(0, renkTon(item.renk, 0.55));
    g.addColorStop(0.5, item.renk);
    g.addColorStop(1, renkTon(item.renk, -0.45));
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, ust);
    ctx.lineTo(cx + r * 0.55, ust);
    ctx.lineTo(cx + r, kus);
    ctx.lineTo(cx, cy + r * 0.95);
    ctx.lineTo(cx - r, kus);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = Math.max(1, boyut / 60);
    ctx.stroke();
    ctx.restore();
}

function cizItemGorseli(ctx: CanvasRenderingContext2D, item: KasaItemi, cx: number, cy: number, boyut: number, parlama: boolean) {
    ctx.save();
    if (parlama) {
        ctx.shadowColor = item.renk;
        ctx.shadowBlur = boyut * 0.25;
    }
    if (item.resim) {
        const olcek = Math.min(boyut / item.resim.width, boyut / item.resim.height);
        const w = item.resim.width * olcek;
        const h = item.resim.height * olcek;
        ctx.drawImage(item.resim, cx - w / 2, cy - h / 2, w, h);
    } else {
        cizYedekIkon(ctx, item, cx, cy, boyut);
    }
    ctx.restore();
}

// Metalik şerit dolgusu (dikey gradyan)
function metal(ctx: CanvasRenderingContext2D, renk: string, y0: number, y1: number) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, renkTon(renk, 0.45));
    g.addColorStop(0.5, renk);
    g.addColorStop(1, renkTon(renk, -0.45));
    return g;
}

// Kasa: gorunum.gorsel PNG'si varsa o, yoksa kasanın renklerinde çizilmiş süslü sandık.
// (cx, cy) gövdenin ortası. parlama 0..1: kapak aralığından sızan alev ışığının gücü.
// acik=true iken kapak arkaya açılmış, ağızdan isikRengi'nde ışık yükseliyor.
// Kapalı sandık her karede sadece açısı ve parlaması değişerek tekrar çiziliyordu (kare başına ~5 ms).
// Artık kasa + boyut + parlama seviyesi başına bir kez çizilip saklanıyor, karelerde döndürülüp kopyalanıyor.
const kapaliSandikOnbellegi = new Map<string, { canvas: Canvas; yari: number }>();
function cizKutu(ctx: CanvasRenderingContext2D, kasa: Kasa, cx: number, cy: number, boyut: number, aci: number, acik: boolean, isikRengi: string, parlama: number) {
    if (acik || kasa.resim) {
        cizKutuHam(ctx, kasa, cx, cy, boyut, aci, acik, isikRengi, parlama, true);
        return;
    }
    const seviye = Math.round(sinirla(parlama) * 6) / 6;
    const anahtar = `${kasa.id}|${boyut}|${seviye}|${isikRengi}`;
    let sprite = kapaliSandikOnbellegi.get(anahtar);
    if (!sprite) {
        const yari = Math.ceil(boyut * 1.15);
        const c = createCanvas(yari * 2, yari * 2);
        cizKutuHam(c.getContext('2d'), kasa, yari, yari, boyut, 0, false, isikRengi, seviye, false);
        sprite = { canvas: c, yari };
        if (kapaliSandikOnbellegi.size > 300) kapaliSandikOnbellegi.clear(); // kasa ayarları değişirse şişmesin
        kapaliSandikOnbellegi.set(anahtar, sprite);
    }
    // Zemin gölgesi sandıkla birlikte dönmesin diye ayrı çiziliyor
    const gH = boyut * 0.48;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + gH / 2 + 6, boyut * 0.56, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.rotate(aci);
    ctx.drawImage(sprite.canvas, -sprite.yari, -sprite.yari);
    ctx.restore();
}

function cizKutuHam(ctx: CanvasRenderingContext2D, kasa: Kasa, cx: number, cy: number, boyut: number, aci: number, acik: boolean, isikRengi: string, parlama: number, golge: boolean) {
    const G = kasa.gorunum;
    const w = boyut;
    const gH = boyut * 0.48;   // gövde yüksekliği
    const kH = boyut * 0.28;   // kapak yüksekliği
    const ust = -gH / 2;       // gövdenin üst kenarı (yerel koordinat)
    const seritX = [-w * 0.3, w * 0.3];
    const seritW = w * 0.08;

    ctx.save();
    if (golge) {
        // Zemin gölgesi
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.beginPath();
        ctx.ellipse(cx, cy + gH / 2 + 6, w * 0.56, 11, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.translate(cx, cy);
    ctx.rotate(aci);

    if (kasa.resim) {
        if (acik) {
            cizHuzme(ctx, w, ust, isikRengi);
            cizAgiz(ctx, w, ust, isikRengi);
        }
        const olcek = Math.min(boyut / kasa.resim.width, boyut / kasa.resim.height);
        ctx.drawImage(kasa.resim, -kasa.resim.width * olcek / 2, -kasa.resim.height * olcek / 2, kasa.resim.width * olcek, kasa.resim.height * olcek);
        ctx.restore();
        return;
    }

    if (acik) {
        cizHuzme(ctx, w, ust, isikRengi);
        // Kapağın iç yüzü: gövdenin arkasında dik duran, yukarı doğru hafif daralan levha
        const kapakUst = ust - kH * 1.5;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 2, ust);
        ctx.lineTo(-w / 2 + 16, kapakUst + 14);
        ctx.quadraticCurveTo(-w / 2 + 18, kapakUst, -w / 2 + 32, kapakUst);
        ctx.lineTo(w / 2 - 32, kapakUst);
        ctx.quadraticCurveTo(w / 2 - 18, kapakUst, w / 2 - 16, kapakUst + 14);
        ctx.lineTo(w / 2 - 2, ust);
        ctx.closePath();
        const ic = ctx.createLinearGradient(0, kapakUst, 0, ust);
        ic.addColorStop(0, renkTon(G.renk, -0.35));
        ic.addColorStop(1, renkTon(G.renk, -0.75));
        ctx.fillStyle = ic;
        ctx.fill();
        const yansima = ctx.createLinearGradient(0, ust, 0, kapakUst);
        yansima.addColorStop(0, isikRengi + '99');
        yansima.addColorStop(1, isikRengi + '00');
        ctx.fillStyle = yansima;
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = metal(ctx, G.susleme, kapakUst, ust);
        ctx.stroke();
        cizAgiz(ctx, w, ust, isikRengi);
    }

    // --- Gövde: ahşap tahtalar ---
    const govde = ctx.createLinearGradient(0, ust, 0, gH / 2);
    govde.addColorStop(0, renkTon(G.renk, 0.12));
    govde.addColorStop(1, renkTon(G.renk, -0.5));
    yuvarlakYol(ctx, -w / 2, ust, w, gH, 12);
    ctx.fillStyle = govde;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 2;
    for (const oran of [0.36, 0.66]) {
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 6, ust + gH * oran);
        ctx.lineTo(w / 2 - 6, ust + gH * oran);
        ctx.stroke();
    }
    // Metal kenar ve şeritler
    ctx.fillStyle = metal(ctx, G.susleme, ust, ust + gH * 0.14);
    ctx.fillRect(-w / 2 + 2, ust, w - 4, gH * 0.14);
    ctx.fillStyle = metal(ctx, G.susleme, gH / 2 - gH * 0.14, gH / 2);
    ctx.fillRect(-w / 2 + 2, gH / 2 - gH * 0.14, w - 4, gH * 0.14);
    for (const sx of seritX) {
        ctx.fillStyle = metal(ctx, G.susleme, ust, gH / 2);
        ctx.fillRect(sx - seritW / 2, ust, seritW, gH);
    }
    yuvarlakYol(ctx, -w / 2, ust, w, gH, 12);
    ctx.lineWidth = 4;
    ctx.strokeStyle = metal(ctx, G.susleme, ust, gH / 2);
    ctx.stroke();
    // Köşe perçinleri
    ctx.fillStyle = renkTon(G.susleme, 0.5);
    for (const px of [-w / 2 + 11, w / 2 - 11]) {
        for (const py of [ust + gH * 0.32, gH / 2 - gH * 0.3]) {
            ctx.beginPath();
            ctx.arc(px, py, Math.max(2.5, w * 0.016), 0, Math.PI * 2);
            ctx.fill();
        }
    }

    if (!acik) {
        // --- Kubbe kapak ---
        yuvarlakYol(ctx, -w / 2 - 5, ust - kH, w + 10, kH + 8, kH * 0.75);
        const kapak = ctx.createLinearGradient(0, ust - kH, 0, ust);
        kapak.addColorStop(0, renkTon(G.renk, 0.3));
        kapak.addColorStop(1, renkTon(G.renk, -0.25));
        ctx.fillStyle = kapak;
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = metal(ctx, G.susleme, ust - kH, ust);
        ctx.stroke();
        for (const sx of seritX) {
            ctx.fillStyle = metal(ctx, G.susleme, ust - kH, ust);
            ctx.fillRect(sx - seritW / 2, ust - kH + 3, seritW, kH);
        }
        // Kapaktaki amblem taşı (alev renginde parlıyor)
        const ay = ust - kH * 0.5;
        const ar = kH * 0.32;
        ctx.save();
        ctx.shadowColor = G.alev[1];
        ctx.shadowBlur = 10 + 25 * parlama;
        ctx.beginPath();
        ctx.moveTo(0, ay - ar);
        ctx.lineTo(ar * 0.8, ay);
        ctx.lineTo(0, ay + ar);
        ctx.lineTo(-ar * 0.8, ay);
        ctx.closePath();
        const tas = ctx.createLinearGradient(0, ay - ar, 0, ay + ar);
        tas.addColorStop(0, G.alev[0]);
        tas.addColorStop(1, G.alev[2]);
        ctx.fillStyle = tas;
        ctx.fill();
        ctx.restore();
        // Kapak parlaması
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + kH * 0.8, ust - kH + 7);
        ctx.lineTo(w / 2 - kH * 0.8, ust - kH + 7);
        ctx.stroke();

        // Kapak aralığından sızan alev ışığı: "patlamak üzere"
        if (parlama > 0) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, 0.35 + parlama);
            ctx.shadowColor = G.alev[1];
            ctx.shadowBlur = 20 + 30 * parlama;
            ctx.fillStyle = G.alev[0];
            ctx.fillRect(-w / 2 + 4, ust - 1, w - 8, 3 + 4 * parlama);
            ctx.shadowBlur = 0;
            if (parlama > 0.4) {
                ctx.globalCompositeOperation = 'lighter';
                const isin = ctx.createLinearGradient(0, ust, 0, ust - boyut * 0.6 * parlama);
                isin.addColorStop(0, G.alev[1] + 'aa');
                isin.addColorStop(1, G.alev[1] + '00');
                ctx.fillStyle = isin;
                for (const ix of [-0.32, -0.1, 0.12, 0.34]) {
                    ctx.beginPath();
                    ctx.moveTo(w * ix - 6, ust);
                    ctx.lineTo(w * ix + 6, ust);
                    ctx.lineTo(w * ix * 1.4 + 14, ust - boyut * 0.6 * parlama);
                    ctx.lineTo(w * ix * 1.4 - 14, ust - boyut * 0.6 * parlama);
                    ctx.closePath();
                    ctx.fill();
                }
            }
            ctx.restore();
        }
    }

    // --- Kilit ---
    const kilitW = w * 0.15;
    const kilitH = gH * 0.42;
    const kilitY = acik ? ust + 3 : ust - kilitH * 0.35;
    yuvarlakYol(ctx, -kilitW / 2, kilitY, kilitW, kilitH, 6);
    ctx.fillStyle = metal(ctx, G.susleme, kilitY, kilitY + kilitH);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = renkTon(G.susleme, -0.5);
    ctx.stroke();
    ctx.fillStyle = '#1a1206';
    ctx.beginPath();
    ctx.arc(0, kilitY + kilitH * 0.42, kilitW * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-kilitW * 0.05, kilitY + kilitH * 0.42, kilitW * 0.1, kilitH * 0.3);
    ctx.restore();
}

// Açık sandıktan yukarı yükselen ışık hüzmesi (kapağın arkasında kalır)
function cizHuzme(ctx: CanvasRenderingContext2D, w: number, ust: number, renk: string) {
    const boy = w * 1.6;
    const huzme = ctx.createLinearGradient(0, ust, 0, ust - boy);
    huzme.addColorStop(0, renk + 'b0');
    huzme.addColorStop(1, renk + '00');
    ctx.fillStyle = huzme;
    ctx.beginPath();
    ctx.moveTo(-w * 0.42, ust);
    ctx.lineTo(w * 0.42, ust);
    ctx.lineTo(w * 0.72, ust - boy);
    ctx.lineTo(-w * 0.72, ust - boy);
    ctx.closePath();
    ctx.fill();
}

// Açık sandığın ağzı: içeriden parlayan ışık
function cizAgiz(ctx: CanvasRenderingContext2D, w: number, ust: number, renk: string) {
    const agiz = ctx.createRadialGradient(0, ust, 2, 0, ust, w * 0.48);
    agiz.addColorStop(0, '#ffffff');
    agiz.addColorStop(0.35, renk);
    agiz.addColorStop(1, renkTon(renk, -0.6));
    ctx.fillStyle = agiz;
    ctx.beginPath();
    ctx.ellipse(0, ust, w / 2 - 6, w * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();
}

// Kurulum/lobi üst şeridi: sıradaki kasalar
function cizUstSerit(ctx: CanvasRenderingContext2D, d: CizimDurumu) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#e8e9ee';
    ctx.fillText('CASE BATTLE', GENISLIK / 2, 26);

    const n = d.kasalar.length;
    const kutuW = 88;
    const kutuH = 72;
    const bosluk = 8;
    const kutuY = 52;

    if (n === 0) {
        yuvarlakYol(ctx, GENISLIK / 2 - 200, kutuY, 400, kutuH, 12);
        ctx.setLineDash([10, 8]);
        ctx.strokeStyle = '#3a3d4a';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 24px Arial';
        ctx.fillStyle = '#6b6f7c';
        ctx.fillText('Menüden kasa ekle', GENISLIK / 2, kutuY + kutuH / 2);
        return;
    }

    const toplamW = n * kutuW + (n - 1) * bosluk;
    for (let k = 0; k < n; k++) {
        const kasa = d.kasalar[k];
        const sx = GENISLIK / 2 - toplamW / 2 + k * (kutuW + bosluk);
        neonKutu(ctx, sx, kutuY, kutuW, kutuH, 12, '#16171d', null);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.font = '32px "Segoe UI Emoji", Arial';
        ctx.fillText(kasa.emoji, sx + kutuW / 2, kutuY + 28);
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#b3b5c4';
        ctx.fillText(`${sayi(kasa.fiyat)} DL`, sx + kutuW / 2, kutuY + 58);
    }
}

// Battle üst kısmı: tur bilgisi + bölmeli ilerleme çubuğu
function cizBattleBasligi(ctx: CanvasRenderingContext2D, d: CizimDurumu) {
    const n = d.kasalar.length;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#ffffff';
    const baslik = d.asama === 'bitti'
        ? 'CASE BATTLE  •  SONUÇ'
        : `TUR ${d.aktifTur + 1}/${n}  •  ${d.kasalar[d.aktifTur].ad.toLocaleUpperCase('tr-TR')}`;
    ctx.fillText(baslik, GENISLIK / 2, 26);
    if (d.asama === 'bitti') return; // sonuçta KAZANDI/KAYBETTİ etiketleri bu alana taşıyor

    const cubukW = 700;
    const bosluk = 6;
    const parcaW = (cubukW - (n - 1) * bosluk) / n;
    for (let k = 0; k < n; k++) {
        const px = GENISLIK / 2 - cubukW / 2 + k * (parcaW + bosluk);
        const aktif = k === d.aktifTur;
        const acildi = k < d.aktifTur;
        neonKutu(ctx, px, 50, parcaW, 10, 5, aktif ? '#ffffff' : (acildi ? '#6b6f7c' : '#22242c'), aktif ? '#ffffff' : null, 12);
    }
}

// Kurulum / lobi ekranındaki büyük oyuncu kartı (ya da boş koltuk)
function cizBeklemePaneli(ctx: CanvasRenderingContext2D, d: CizimDurumu, index: 0 | 1) {
    const oyuncu = d.oyuncular[index];
    const x = PANEL_X[index];
    const y = PANEL_Y;
    const renk = OYUNCU_RENKLERI[index];
    const cx = x + PANEL_W / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (oyuncu) {
        neonKutu(ctx, x, y, PANEL_W, PANEL_H, 22, '#111218', renk, 18);
        cizAvatar(ctx, oyuncu, cx, y + 130, 84, renk);
        ctx.font = 'bold 38px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(kisalt(ctx, oyuncu.isim, PANEL_W - 50), cx, y + 262);
        if (d.asama === 'kurulum') cizEtiket(ctx, 'KASALARI SEÇİYOR', cx, y + 330, '#ffb300', 24);
        else cizEtiket(ctx, 'HAZIR', cx, y + 330, '#12ff5e', 24);
        return;
    }

    // Boş koltuk: kesikli çerçeve
    yuvarlakYol(ctx, x, y, PANEL_W, PANEL_H, 22);
    ctx.fillStyle = '#0d0e13';
    ctx.fill();
    ctx.setLineDash([14, 10]);
    ctx.strokeStyle = '#3a3d4a';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, y + 130, 84, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = 'bold 84px Arial';
    ctx.fillStyle = '#3a3d4a';
    ctx.fillText('?', cx, y + 134);

    ctx.font = 'bold 34px Arial';
    ctx.fillStyle = '#8b8f9c';
    ctx.fillText('RAKİP BEKLENİYOR', cx, y + 262);
    ctx.font = '23px Arial';
    ctx.fillStyle = '#5c606d';
    ctx.fillText(d.asama === 'lobi' ? 'Katılmak için ⚔️ Katıl butonuna bas' : 'Battle henüz açılmadı', cx, y + 312);
}

// Kutu açılma sahnesi (oyuncunun kendi alanı). Evreler:
//   salla : sandık giderek şiddetlenen şekilde sağa sola sallanır, alevler büyür, kapaktan ışık sızar
//   patla : beyaz parlama, kapak açılır, halka dalgası
//   yuksel: item sandığın ağzından yükselir ve büyür
//   son   : item yerinde, nadirlik etiketi görünür
function cizSahne(ctx: CanvasRenderingContext2D, s: KutuSahnesi, x: number, y: number, w: number, h: number) {
    const cx = x + w / 2;
    const G = s.kasa.gorunum;
    const item = s.item;

    ctx.save();
    yuvarlakYol(ctx, x, y, w, h, 18);
    ctx.fillStyle = '#0a0b0f';
    ctx.fill();
    ctx.clip();

    if (s.evre === 'gecis') {
        // Yeni sandık yukarıdan düşüp yere sekerek oturuyor, inişte toz halkası
        const boyut = 172;
        const kutuY = y + h * 0.64;
        const tabanY = kutuY + boyut * 0.24;
        const dt = s.kapanis ? 0 : sinirla((s.t - 0.2) / 0.8);
        if (dt > 0) {
            const baslaY = y - boyut * 0.7;
            const kY = baslaY + (kutuY - baslaY) * zipla(dt);
            if (dt > 0.6) cizAlevler(ctx, cx, tabanY, boyut * 1.5, boyut * 0.9, G.alev, s.kare, s.faz, (dt - 0.6) / 0.4 * 0.45);
            cizKutu(ctx, s.kasa, cx, kY, boyut, 0, false, G.alev[1], 0);
            if (dt > 0.55) {
                const r = sinirla((dt - 0.55) / 0.45);
                ctx.save();
                ctx.globalAlpha = 1 - r;
                ctx.strokeStyle = G.alev[0];
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.ellipse(cx, tabanY + 4, boyut * (0.55 + 0.6 * r), 8 + 14 * r, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = 'rgba(200, 200, 210, 0.8)';
                for (let i = 0; i < 10; i++) {
                    const yon = i % 2 === 0 ? -1 : 1;
                    const uzak = boyut * (0.4 + 0.5 * r) * (0.6 + sabitRastgele(i) * 0.6);
                    ctx.beginPath();
                    ctx.arc(cx + yon * uzak, tabanY - r * 30 * sabitRastgele(i + 5), 3 + 4 * (1 - r), 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 22px Arial';
        ctx.globalAlpha = sinirla(s.t * 2);
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        const yazi = s.kapanis ? 'SONUÇ HESAPLANIYOR' : 'SIRADAKİ KASA';
        ctx.strokeText(yazi, cx, y + 24);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(yazi, cx, y + 24);
        ctx.globalAlpha = 1;
    } else if (s.evre === 'salla') {
        const t = s.t;
        const boyut = 172;
        const kutuY = y + h * 0.64;
        const tabanY = kutuY + boyut * 0.24;

        const glow = ctx.createRadialGradient(cx, kutuY, 10, cx, kutuY, w * 0.55);
        glow.addColorStop(0, G.alev[1] + (t > 0.5 ? '66' : '33'));
        glow.addColorStop(1, G.alev[1] + '00');
        ctx.fillStyle = glow;
        ctx.fillRect(x, y, w, h);

        // Arkadaki büyük alev: kapağın üstünü aşıp sahnenin üstüne kadar yükselir
        cizAlevler(ctx, cx, tabanY, boyut * 1.5, Math.min(tabanY - y - 8, boyut * (1.15 + 0.6 * t)), G.alev, s.kare, s.faz, 0.45 + 0.55 * t);

        // Sallanma: genlik giderek artıyor, araya küçük zıplamalar
        const genlik = 0.05 + 0.16 * t;
        const aci = Math.sin(s.kare * 1.9 + s.faz) * genlik;
        const kayma = Math.sin(s.kare * 2.7 + s.faz) * 5 * t;
        const zipla = -Math.abs(Math.sin(s.kare * 1.4 + s.faz)) * 9 * t;
        cizKutu(ctx, s.kasa, cx + kayma, kutuY + zipla, boyut, aci, false, G.alev[1], 0.15 + 0.85 * t);
        // Öndeki küçük alevler sandığın alt köşelerini sarıyor
        for (const yon of [-1, 1]) {
            cizAlevler(ctx, cx + kayma + yon * boyut * 0.47, tabanY + 4, boyut * 0.32, boyut * (0.35 + 0.3 * t), G.alev, s.kare + yon * 2, s.faz + yon, 0.6 + 0.4 * t);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 22px Arial';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.strokeText('KASA AÇILIYOR' + '.'.repeat(1 + Math.floor(s.kare / 3) % 3), cx, y + 24);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('KASA AÇILIYOR' + '.'.repeat(1 + Math.floor(s.kare / 3) % 3), cx, y + 24);
    } else {
        const patlama = s.evre === 'patla';
        const t = s.evre === 'son' ? 1 : s.t;
        const kutuY = y + h - 50;
        const boyut = 150;
        // Patlama anında kapak henüz açılmadı (ilk kare), sonra açık
        const acik = !patlama || t > 0.3;

        // Nadirlik yükseldikçe efekt büyüyor: Sıradan sade, Efsanevi tam ışık şöleni
        const guc = [0.15, 0.3, 0.45, 0.7, 1][item.seviye] * (patlama ? t : 1);
        const itemSonY = y + h * 0.34;
        const glow = ctx.createRadialGradient(cx, itemSonY, 10, cx, itemSonY, w * 0.6);
        glow.addColorStop(0, item.renk + (item.seviye >= 3 ? '88' : '44'));
        glow.addColorStop(1, item.renk + '00');
        ctx.globalAlpha = patlama ? t : 1;
        ctx.fillStyle = glow;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
        cizIsinlar(ctx, cx, itemSonY, w * 0.65, item.renk, guc, s.kare * 0.05);

        cizAlevler(ctx, cx, kutuY + boyut * 0.24, boyut * 1.35, boyut * (patlama ? 1.4 : 0.75), G.alev, s.kare, s.faz, patlama ? 1 : 0.4);
        cizKutu(ctx, s.kasa, cx, kutuY, boyut, 0, acik, item.renk, 1);

        // Item: ağızdan çıkıp yerine yükseliyor, hafif büyüyüp oturuyor
        if (!patlama || t >= 1) {
            const yt = s.evre === 'yuksel' ? s.t : (patlama ? 0 : 1);
            const agizY = kutuY - boyut * 0.24;
            const itemY = agizY + (itemSonY - agizY) * yumusakCikis(yt);
            const boyutItem = 128 * (0.3 + 0.7 * geriSekme(yt));
            cizItemGorseli(ctx, item, cx, itemY, boyutItem, true);
        }

        if (patlama) {
            // Beyaz parlama + genişleyen halka
            ctx.fillStyle = `rgba(255, 255, 255, ${(1 - t) * 0.85})`;
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = G.alev[0];
            ctx.globalAlpha = 1 - t * 0.8;
            ctx.lineWidth = 10 * (1 - t) + 2;
            ctx.beginPath();
            ctx.arc(cx, kutuY - boyut * 0.24, 30 + t * w * 0.5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
        } else if (s.evre === 'son' || s.t > 0.5) {
            if (item.seviye >= 3) {
                cizParilti(ctx, cx - 120, itemSonY - 45, 13, item.renk);
                cizParilti(ctx, cx + 125, itemSonY - 15, 10, '#ffffff');
                cizParilti(ctx, cx + 95, itemSonY + 60, 7, item.renk);
                cizParilti(ctx, cx - 100, itemSonY + 55, 8, '#ffffff');
            }
            const nadirlik = NADIRLIKLER[item.seviye].ad.toLocaleUpperCase('tr-TR');
            ctx.font = 'bold 20px Arial';
            cizEtiket(ctx, nadirlik, x + 16 + (ctx.measureText(nadirlik).width + 44) / 2, y + 30, item.renk, 20);
        }
    }
    ctx.restore();
}

// Item kartı: kare (PNG üstte, değer altta) ya da yatay (PNG solda, değer sağda)
function cizItemKarti(ctx: CanvasRenderingContext2D, item: KasaItemi, x: number, y: number, w: number, h: number) {
    neonKutu(ctx, x, y, w, h, 10, '#16171d', null);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, item.renk + '00');
    g.addColorStop(1, item.renk + '55');
    yuvarlakYol(ctx, x, y, w, h, 10);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = item.renk;
    ctx.fillRect(x + 8, y + h - 4, w - 16, 3);

    const metin = `${sayi(item.deger)} DL`;
    ctx.textBaseline = 'middle';
    if (w > h * 1.6) {
        const ikon = h * 0.9;
        cizItemGorseli(ctx, item, x + 3 + ikon / 2, y + h / 2 - 1, ikon, false);
        ctx.textAlign = 'center';
        sigdirFont(ctx, metin, w - ikon - 8, 19, 10);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(metin, x + ikon + 4 + (w - ikon - 4) / 2, y + h / 2);
        return;
    }

    const isimli = h >= 120;
    const ikon = Math.min(w * 0.82, h * (isimli ? 0.52 : 0.62));
    cizItemGorseli(ctx, item, x + w / 2, y + h * (isimli ? 0.36 : 0.4), ikon, false);
    ctx.textAlign = 'center';
    if (isimli) {
        ctx.font = 'bold 17px Arial';
        ctx.fillStyle = '#c9cbd6';
        ctx.fillText(kisalt(ctx, item.ad, w - 8), x + w / 2, y + h * 0.7);
    }
    sigdirFont(ctx, metin, w - 6, isimli ? 22 : 21, 11);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(metin, x + w / 2, y + h * (isimli ? 0.86 : 0.84));
}

function cizBosYuva(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    yuvarlakYol(ctx, x, y, w, h, 10);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = '#2a2c36';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `bold ${Math.floor(Math.min(w, h) * 0.45)}px Arial`;
    ctx.fillStyle = '#2a2c36';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x + w / 2, y + h / 2 + 1);
}

// Battle sırasında panelin altındaki envanter: 5'e kadar büyük kare kartlar, fazlası iki sıra yatay kart
const SAHNE_Y = 90;      // panelin üstüne göre
const SAHNE_H = 240;
const ENVANTER_Y = 372;
const ENVANTER_H = 94;
function envanterYuvasi(n: number, panelX: number, k: number): { x: number; y: number; w: number; h: number } {
    const sw = PANEL_W - 30;
    const tekSira = n <= 5;
    const w = tekSira ? Math.min(86, (sw - (n - 1) * 8) / n) : (sw - 4 * 8) / 5;
    const h = tekSira ? ENVANTER_H : (ENVANTER_H - 6) / 2;
    const sutun = Math.min(n, 5);
    const basX = panelX + PANEL_W / 2 - (sutun * w + (sutun - 1) * 8) / 2;
    return { x: basX + (k % 5) * (w + 8), y: B_PANEL_Y + ENVANTER_Y + Math.floor(k / 5) * (h + 6), w, h };
}

// Panelin neon parıltılı çerçevesi (büyük gölge bulanıklığı pahalı): renk başına bir kez çizilip saklanıyor
const panelCercevesiOnbellegi = new Map<string, Canvas>();
function cizPanelCercevesi(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, neon: string, vurgulu: boolean) {
    const pay = 60;
    const anahtar = `${w}|${h}|${neon}|${vurgulu}`;
    let c = panelCercevesiOnbellegi.get(anahtar);
    if (!c) {
        c = createCanvas(w + pay * 2, h + pay * 2);
        const k = c.getContext('2d');
        neonKutu(k, pay, pay, w, h, 22, '#111218', neon, vurgulu ? 45 : 18);
        if (vurgulu) {
            yuvarlakYol(k, pay, pay, w, h, 22);
            k.strokeStyle = neon;
            k.lineWidth = 3;
            k.stroke();
        }
        panelCercevesiOnbellegi.set(anahtar, c);
    }
    ctx.drawImage(c, x - pay, y - pay);
}

// Geçiş evresinde envanterin üstüne çizilenler: önceki turun itemi sahneden yuvasına uçar (iz bırakarak),
// yuvaya oturunca kart nadirlik renginde parlar. Zemin olarak son yuvası boş çizilmiş bir panel bekler.
function cizGecisKatmani(ctx: CanvasRenderingContext2D, d: CizimDurumu, index: 0 | 1) {
    const sahne = d.sahneler?.[index];
    const oyuncu = d.oyuncular[index];
    if (!sahne || sahne.evre !== 'gecis' || !sahne.onceki || !oyuncu) return;
    const x = PANEL_X[index];
    const y = B_PANEL_Y;
    const n = d.kasalar.length;
    const sonIndex = oyuncu.acilanlar.length - 1;
    const r = envanterYuvasi(n, x, sonIndex);
    const ucus = sinirla(sahne.t / 0.5);
    const item = sahne.onceki;

    if (ucus >= 1) {
        ctx.save();
        ctx.shadowColor = item.renk;
        ctx.shadowBlur = 30;
        yuvarlakYol(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 12);
        ctx.strokeStyle = item.renk;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
        cizItemKarti(ctx, item, r.x, r.y, r.w, r.h);
        return;
    }

    const bas = { x: x + PANEL_W / 2, y: y + SAHNE_Y + SAHNE_H * 0.34, b: 128 };
    const son = { x: r.x + r.w / 2, y: r.y + r.h / 2, b: Math.min(r.w, r.h) * 0.8 };
    const konum = (u: number) => {
        const e = yumusakCikis(u);
        // Hafif yay çizen yol: önce biraz yükselip sonra yuvaya iniyor
        return { x: bas.x + (son.x - bas.x) * e, y: bas.y + (son.y - bas.y) * e - Math.sin(e * Math.PI) * 40, b: bas.b + (son.b - bas.b) * e };
    };
    for (const [geri, alfa] of [[0.24, 0.2], [0.12, 0.4]] as const) {
        const p = konum(Math.max(0, ucus - geri));
        ctx.globalAlpha = alfa;
        cizItemGorseli(ctx, item, p.x, p.y, p.b, false);
    }
    ctx.globalAlpha = 1;
    const p = konum(ucus);
    cizItemGorseli(ctx, item, p.x, p.y, p.b, true);
}

function cizBattlePaneli(ctx: CanvasRenderingContext2D, d: CizimDurumu, index: 0 | 1) {
    const oyuncu = d.oyuncular[index]!;
    const x = PANEL_X[index];
    const y = B_PANEL_Y;
    const w = PANEL_W;
    const h = B_PANEL_H;
    const renk = OYUNCU_RENKLERI[index];
    const bitti = d.asama === 'bitti';
    const kazandi = bitti && d.kazanan === index;
    const kaybetti = bitti && d.kazanan !== -1 && d.kazanan !== index;
    const sahne = d.sahneler?.[index];
    const itemGorundu = !!sahne && (sahne.evre === 'son' || (sahne.evre === 'yuksel' && sahne.t > 0.5));
    const nadirAcilis = !bitti && itemGorundu && sahne!.item.seviye >= 3;

    const neon = kazandi ? '#ffd700' : (nadirAcilis ? sahne!.item.renk : renk);
    cizPanelCercevesi(ctx, x, y, w, h, neon, kazandi || nadirAcilis);

    // Başlık: avatar + isim + toplam değer
    cizAvatar(ctx, oyuncu, x + 52, y + 50, 34, renk);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = 'bold 30px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(kisalt(ctx, oyuncu.isim, 160), x + 98, y + 50);
    ctx.textAlign = 'right';
    sigdirFont(ctx, `${sayi(oyuncu.toplam)} DL`, 175, 40, 24);
    ctx.fillStyle = '#ffd700';
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 12;
    ctx.fillText(`${sayi(oyuncu.toplam)} DL`, x + w - 22, y + 50);
    ctx.shadowBlur = 0;

    const sx = x + 15;
    const sw = w - 30;

    if (!bitti && sahne) {
        // Kutu sahnesi
        cizSahne(ctx, sahne, sx, y + SAHNE_Y, sw, SAHNE_H);

        // Çıkan item: "Ad  +Değer DL" tek satır
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const satirY = y + SAHNE_Y + SAHNE_H + 19;
        if (itemGorundu) {
            const ad = sahne.item.ad;
            const deger = `+${sayi(sahne.item.deger)} DL`;
            let boyut = 28;
            const olc = () => {
                ctx.font = `bold ${boyut}px Arial`;
                const a = ctx.measureText(ad + '  ').width;
                ctx.font = `bold ${boyut + 2}px Arial`;
                return a + ctx.measureText(deger).width;
            };
            while (boyut > 16 && olc() > sw - 20) boyut--;
            const toplamW = olc();
            ctx.font = `bold ${boyut}px Arial`;
            const adW = ctx.measureText(ad + '  ').width;
            const basX = x + w / 2 - toplamW / 2;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(ad, basX, satirY);
            ctx.font = `bold ${boyut + 2}px Arial`;
            ctx.fillStyle = sahne.item.renk;
            ctx.shadowColor = sahne.item.renk;
            ctx.shadowBlur = 12;
            ctx.fillText(deger, basX + adW, satirY);
            ctx.shadowBlur = 0;
        } else {
            ctx.textAlign = 'center';
            ctx.font = 'bold 28px Arial';
            ctx.fillStyle = '#3a3d4a';
            ctx.fillText('? ? ?', x + w / 2, satirY);
        }

        // Şu ana kadar açılanlar. Geçiş evresinde son item önce sahneden buraya uçuyor,
        // yerine oturunca kartı kısa bir süre parlıyor.
        const n = d.kasalar.length;
        const gecis = sahne.evre === 'gecis' && !!sahne.onceki;
        const sonIndex = oyuncu.acilanlar.length - 1;
        for (let k = 0; k < n; k++) {
            const r = envanterYuvasi(n, x, k);
            const item = oyuncu.acilanlar[k];
            // Geçişte son yuva boş çizilir; item'in uçuşu ve yerine oturması cizGecisKatmani'nda
            if (!item || (gecis && k === sonIndex)) cizBosYuva(ctx, r.x, r.y, r.w, r.h);
            else cizItemKarti(ctx, item, r.x, r.y, r.w, r.h);
        }
        if (gecis) cizGecisKatmani(ctx, d, index);
    } else {
        // Sonuç: büyük toplam + açılan tüm itemler
        const rx = sx;
        const ry = y + 100;
        const rw = sw;
        const rh = 180;
        ctx.save();
        yuvarlakYol(ctx, rx, ry, rw, rh, 16);
        ctx.fillStyle = '#0a0b0f';
        ctx.fill();
        ctx.clip();
        if (kazandi) cizIsinlar(ctx, rx + rw / 2, ry + rh / 2, rw * 0.6, '#ffd700', 0.45);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        sigdirFont(ctx, `${sayi(oyuncu.toplam)} DL`, rw - 30, 76, 34, '"Arial Black", Arial');
        ctx.fillStyle = kazandi ? '#ffd700' : (kaybetti ? '#6b6f7c' : '#ffffff');
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = kazandi ? 30 : 0;
        ctx.fillText(`${sayi(oyuncu.toplam)} DL`, rx + rw / 2, ry + rh / 2 - 10);
        ctx.shadowBlur = 0;
        ctx.font = 'bold 20px Arial';
        ctx.fillStyle = '#8b8f9c';
        ctx.fillText('TOPLAM DEĞER', rx + rw / 2, ry + rh - 24);
        ctx.restore();

        const satir = Math.ceil(d.kasalar.length / 5);
        const kartW = (sw - 4 * 8) / 5;
        const alanY = y + 294;
        const alanH = h - 294 - 12;
        const kartH = satir === 1 ? alanH : (alanH - 8) / 2;
        const kartY = alanY + (alanH - (satir * kartH + (satir - 1) * 8)) / 2;
        for (let k = 0; k < d.kasalar.length; k++) {
            const item = oyuncu.acilanlar[k];
            if (!item) continue;
            cizItemKarti(ctx, item, sx + (k % 5) * (kartW + 8), kartY + Math.floor(k / 5) * (kartH + 8), kartW, kartH);
        }
    }

    if (kaybetti) {
        yuvarlakYol(ctx, x, y, w, h, 22);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fill();
    }
    if (bitti) {
        const etiket = kazandi ? '🏆 KAZANDI' : (kaybetti ? 'KAYBETTİ' : '🤝 BERABERE');
        cizEtiket(ctx, etiket, x + w / 2, y, kazandi ? '#ffd700' : (kaybetti ? '#ff122a' : '#b3b5c4'), 22);
    }
}

function cizVs(ctx: CanvasRenderingContext2D, cy: number) {
    const cx = GENISLIK / 2;
    ctx.save();
    const g = ctx.createLinearGradient(cx - 40, cy - 40, cx + 40, cy + 40);
    g.addColorStop(0, OYUNCU_RENKLERI[0]);
    g.addColorStop(1, OYUNCU_RENKLERI[1]);
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 25;
    ctx.beginPath();
    ctx.arc(cx, cy, 48, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(cx, cy, 40, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0c10';
    ctx.fill();
    ctx.font = 'bold 34px "Arial Black", Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VS', cx, cy + 1);
    ctx.restore();
}

function cizAltYazi(ctx: CanvasRenderingContext2D, metin: string, renk: string) {
    neonKutu(ctx, 120, 556, 760, 56, 28, 'rgba(0, 0, 0, 0.6)', null);
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = renk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kisalt(ctx, metin, 720), GENISLIK / 2, 585);
}

// Tüm ekranı verilen bağlama çizer (1000x620 mantıksal koordinat)
function ekraniCiz(ctx: CanvasRenderingContext2D, d: CizimDurumu) {
    cizArkaPlan(ctx);
    if (d.asama === 'battle' || d.asama === 'bitti') {
        cizBattleBasligi(ctx, d);
        cizBattlePaneli(ctx, d, 0);
        cizBattlePaneli(ctx, d, 1);
        cizVs(ctx, B_PANEL_Y + B_PANEL_H / 2);
    } else {
        cizUstSerit(ctx, d);
        cizBeklemePaneli(ctx, d, 0);
        cizBeklemePaneli(ctx, d, 1);
        cizVs(ctx, PANEL_Y + PANEL_H / 2);
    }
    cizAltYazi(ctx, d.altYazi, d.asama === 'bitti' ? '#ffd700' : '#c9cbd6');
}

// Sabit ekran (kurulum, lobi, sonuç) -> JPEG
function resimOlustur(d: CizimDurumu): AttachmentBuilder {
    const canvas = createCanvas(GENISLIK, YUKSEKLIK);
    ekraniCiz(canvas.getContext('2d'), d);
    // Her karede farklı isim: Discord eski resmi önbellekten göstermesin
    return new AttachmentBuilder(canvas.toBuffer('image/jpeg', { quality: 0.9 }), { name: `vs_${Date.now()}.jpg` });
}

// Diğer komutlar beklemesin diye uzun işlerin arasında olay döngüsüne nefes aldır
const nefesAl = () => new Promise<void>(resolve => setImmediate(resolve));

// GIF karesinin süresi en fazla ~655 sn olabilir. Son kareye bunu veriyoruz: Discord GIF'leri
// döngüye soktuğu için, kısa olsaydı animasyon başa sarıp envanter "geri gidiyormuş" gibi görünürdü.
const DONGUYU_ENGELLE = 600_000;

interface AnimasyonKaresi {
    d: CizimDurumu;
    gecikme: number;     // ms
    // tam   : her şey çizilir (varsayılan)
    // taban : tam çizilir + sonraki hızlı karelerin zemini olarak saklanır
    // sahne : zemin aynen kopyalanır, sadece iki sandık sahnesi yeniden çizilir
    // gecis : zemin + iki sahne + envantere uçan item
    cizim?: 'tam' | 'taban' | 'sahne' | 'gecis';
}

// Bir turun kareleri. Sonuçlar battle başlamadan belli: burada sadece gösterim hazırlanıyor.
//   geçiş  : önceki turun itemi sahneden envantere uçar, yeni sandık yukarıdan düşer
//   salla  : sandık sağa sola sallanır, alevler büyür
//   patla  : flaş + kapak açılır
//   yuksel : item sandıktan yükselir
//   son    : item sahnede durur, toplam güncellenir (envantere bir sonraki turun başında uçacak)
// Envanter sadece ileri gider; hiçbir karede bir item envanterden çıkmaz.
function turKareleri(
    kasalar: Kasa[],
    tur: number,
    sonuclar: [KasaItemi, KasaItemi][],
    temelOyuncular: [OyuncuGorunumu, OyuncuGorunumu],
    sonucuGoster: number,
    fazlar: [number, number]
): AnimasyonKaresi[] {
    const kasa = kasalar[tur];
    const oyuncu = (o: 0 | 1, envanterTuru: number, toplamTuru: number): OyuncuGorunumu => ({
        ...temelOyuncular[o],
        acilanlar: sonuclar.slice(0, envanterTuru).map(s => s[o]),
        toplam: sonuclar.slice(0, toplamTuru).reduce((t, s) => t + s[o].deger, 0)
    });
    const once: [OyuncuGorunumu, OyuncuGorunumu] = [oyuncu(0, tur, tur), oyuncu(1, tur, tur)];
    const son: [OyuncuGorunumu, OyuncuGorunumu] = [oyuncu(0, tur, tur + 1), oyuncu(1, tur, tur + 1)];
    const oncekiler: [KasaItemi | null, KasaItemi | null] = tur === 0 ? [null, null] : sonuclar[tur - 1];

    const kareler: AnimasyonKaresi[] = [];
    let gecen = 0; // tur başından beri geçen süre (ms)
    const ekle = (evre: KutuSahnesi['evre'], t: number, gecikme: number, ek: Partial<AnimasyonKaresi> = {}) => {
        const kare = gecen / 100;
        const oyuncular = evre === 'son' ? son : once;
        kareler.push({
            gecikme,
            ...ek,
            d: {
                asama: 'battle', kasalar, aktifTur: tur, oyuncular,
                sahneler: [
                    { kasa, item: sonuclar[tur][0], evre, t, kare, faz: fazlar[0], onceki: oncekiler[0] },
                    { kasa, item: sonuclar[tur][1], evre, t, kare, faz: fazlar[1], onceki: oncekiler[1] }
                ],
                altYazi: `Havuz: ${sayi(oyuncular[0].toplam + oyuncular[1].toplam)} DL`
            }
        });
        gecen += gecikme;
    };
    for (let i = 0; i < ZAMANLAMA.gecisKaresi; i++) {
        ekle('gecis', i / (ZAMANLAMA.gecisKaresi - 1), ZAMANLAMA.gecisGecikme, { cizim: i === 0 ? 'taban' : 'gecis' });
    }
    for (let i = 0; i < ZAMANLAMA.sallanmaKaresi; i++) {
        ekle('salla', i / (ZAMANLAMA.sallanmaKaresi - 1), ZAMANLAMA.sallanmaGecikme, { cizim: i === 0 ? 'taban' : 'sahne' });
    }
    for (let i = 0; i < ZAMANLAMA.patlamaKaresi; i++) {
        ekle('patla', i / (ZAMANLAMA.patlamaKaresi - 1), ZAMANLAMA.patlamaGecikme, { cizim: 'sahne' });
    }
    // Item yükselirken ilk yarıda panelde değişen bir şey yok (isim/değer satırı t > 0.5'te çıkıyor)
    for (let i = 1; i <= ZAMANLAMA.yukselmeKaresi; i++) {
        const t = i / ZAMANLAMA.yukselmeKaresi;
        ekle('yuksel', t, ZAMANLAMA.yukselmeGecikme, { cizim: t <= 0.5 ? 'sahne' : 'tam' });
    }
    ekle('son', 1, sonucuGoster);
    return kareler;
}

// Son turdan sonra: son item envantere uçar, ardından sonuç ekranı gelir
function kapanisKareleri(kasalar: Kasa[], sonuclar: [KasaItemi, KasaItemi][], temelOyuncular: [OyuncuGorunumu, OyuncuGorunumu]): AnimasyonKaresi[] {
    const n = kasalar.length;
    const oyuncular = [0, 1].map(o => ({
        ...temelOyuncular[o],
        acilanlar: sonuclar.map(s => s[o]),
        toplam: sonuclar.reduce((t, s) => t + s[o].deger, 0)
    })) as [OyuncuGorunumu, OyuncuGorunumu];
    const kareler: AnimasyonKaresi[] = [];
    for (let i = 0; i < ZAMANLAMA.gecisKaresi; i++) {
        const t = i / (ZAMANLAMA.gecisKaresi - 1);
        kareler.push({
            gecikme: ZAMANLAMA.gecisGecikme,
            cizim: i === 0 ? 'taban' : 'gecis',
            d: {
                asama: 'battle', kasalar, aktifTur: n - 1, oyuncular,
                sahneler: [0, 1].map(o => ({
                    kasa: kasalar[n - 1], item: sonuclar[n - 1][o], evre: 'gecis', t, kare: i * ZAMANLAMA.gecisGecikme / 100, faz: o * 3,
                    onceki: sonuclar[n - 1][o], kapanis: true
                })) as [KutuSahnesi, KutuSahnesi],
                altYazi: `Havuz: ${sayi(oyuncular[0].toplam + oyuncular[1].toplam)} DL`
            }
        });
    }
    return kareler;
}

// Kareler -> GIF. Hızlandırmalar:
//  1) 'sahne'/'gecis' karelerinde ekranın geri kalanı yeniden çizilmez: sadece değişen bölge (iki sandık
//     sahnesi; geçişte envantere kadar) saklanan zeminden geri yüklenip yeniden çizilir ve okunur.
//  2) Bir önceki kareyle aynı kalan pikseller şeffaf yazılır: değişmeyen yerler (arka plan, paneller,
//     envanter) neredeyse yer kaplamaz, dosya küçük kalır.
//  3) Kareler bellekte biriktirilmez, çizildikçe GIF'e yazılır. Bunun için ortak palet önce birkaç
//     örnek kareden (sandık, patlama, sonuç) çıkarılır.
async function gifOlustur(kareler: AnimasyonKaresi[]): Promise<AttachmentBuilder> {
    const W = Math.round(GENISLIK * GIF_OLCEK);
    const H = Math.round(YUKSEKLIK * GIF_OLCEK);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    let taban: ReturnType<typeof ctx.getImageData> | null = null;

    // Hızlı karelerde değişebilen dikdörtgen (ekran koordinatı -> GIF pikseli, dışa yuvarlanmış)
    const bolgeOlustur = (sol: number, sag: number, alt: number) => {
        const x0 = Math.max(0, Math.floor(sol * GIF_OLCEK));
        const x1 = Math.min(W, Math.ceil(sag * GIF_OLCEK));
        const y0 = Math.floor((B_PANEL_Y + SAHNE_Y) * GIF_OLCEK);
        const y1 = Math.min(H, Math.ceil(alt * GIF_OLCEK));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const sahneBolgesi = bolgeOlustur(PANEL_X[0] + 15, PANEL_X[1] + PANEL_W - 15, B_PANEL_Y + SAHNE_Y + SAHNE_H);
    // Geçişte item envantere uçuyor; yuvanın parlaması (shadowBlur 30) için her yönde pay
    const gecisBolgesi = bolgeOlustur(PANEL_X[0] - 60, PANEL_X[1] + PANEL_W + 60, B_PANEL_Y + ENVANTER_Y + ENVANTER_H + 60);

    // Kareyi canvas'a çizer; sadece bir bölge değiştiyse o bölgeyi döner
    const ciz = (k: AnimasyonKaresi): { x: number; y: number; w: number; h: number } | null => {
        if ((k.cizim === 'sahne' || k.cizim === 'gecis') && taban && k.d.sahneler) {
            const b = k.cizim === 'gecis' ? gecisBolgesi : sahneBolgesi;
            ctx.putImageData(taban, 0, 0, b.x, b.y, b.w, b.h);
            ctx.save();
            ctx.beginPath();
            ctx.rect(b.x, b.y, b.w, b.h);
            ctx.clip();
            ctx.scale(GIF_OLCEK, GIF_OLCEK);
            for (const o of [0, 1] as const) {
                cizSahne(ctx, k.d.sahneler[o], PANEL_X[o] + 15, B_PANEL_Y + SAHNE_Y, PANEL_W - 30, SAHNE_H);
                if (k.cizim === 'gecis') cizGecisKatmani(ctx, k.d, o);
            }
            cizVs(ctx, B_PANEL_Y + B_PANEL_H / 2); // VS rozeti sahnelerin kenarına taşıyor, üstte kalsın
            ctx.restore();
            return b;
        }
        ctx.save();
        ctx.scale(GIF_OLCEK, GIF_OLCEK);
        ekraniCiz(ctx, k.d);
        ctx.restore();
        if (k.cizim === 'taban') taban = ctx.getImageData(0, 0, W, H);
        return null;
    };

    // --- 1) Ortak palet (255 renk + 1 şeffaf): her turun sallanma zemini, patlama ve sonuç karelerinden ---
    const ornekMi = (k: AnimasyonKaresi, i: number) => {
        const s = k.d.sahneler?.[0];
        return i === kareler.length - 1 || (k.cizim === 'taban' && s?.evre === 'salla') || s?.evre === 'son' || (s?.evre === 'patla' && s.t === 0.5);
    };
    const ornekSayisi = kareler.filter(ornekMi).length;
    // Toplam ~400 bin örnek piksel yeterli; fazlası paleti iyileştirmeden süreyi uzatıyor
    const adim = Math.max(3, ornekSayisi);
    const ornek = new Uint8ClampedArray(ornekSayisi * Math.ceil(W * H / adim) * 4);
    let o = 0;
    for (let i = 0; i < kareler.length; i++) {
        const k = kareler[i];
        const ornekKare = ornekMi(k, i);
        // Zemin kareleri, sonraki örnek 'sahne' kareleri doğru çizilsin diye her durumda çizilir
        if (!ornekKare && k.cizim !== 'taban') continue;
        ciz(k);
        if (!ornekKare) continue;
        const g = ctx.getImageData(0, 0, W, H).data;
        for (let p = (i * 7) % adim; p < W * H; p += adim) {
            ornek[o++] = g[p * 4]; ornek[o++] = g[p * 4 + 1]; ornek[o++] = g[p * 4 + 2]; ornek[o++] = 255;
        }
        await nefesAl();
    }
    const palet = gifenc.quantize(ornek.subarray(0, o), 255);
    const seffaf = palet.length;
    const tamPalet = [...palet, [0, 0, 0]];
    taban = null;
    await nefesAl();

    // En yakın palet rengi (RGB565 anahtarlı önbellekle; her renk için arama bir kez yapılır)
    const renkOnbellegi = new Int16Array(65536).fill(-1);
    const enYakin = (r: number, g: number, b: number): number => {
        const anahtar = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
        let v = renkOnbellegi[anahtar];
        if (v < 0) {
            let enIyi = Infinity;
            for (let i = 0; i < palet.length; i++) {
                const dr = palet[i][0] - r, dg = palet[i][1] - g, db = palet[i][2] - b;
                const uzaklik = dr * dr + dg * dg + db * db;
                if (uzaklik < enIyi) { enIyi = uzaklik; v = i; }
            }
            renkOnbellegi[anahtar] = v;
        }
        return v;
    };

    // --- 2) Kareleri sırayla çiz ve hemen GIF'e yaz ---
    // Hızlı karelerde bölge dışı hiç değişmez: o pikseller doğrudan şeffaf kalır, karşılaştırılmaz bile.
    const gif = gifenc.GIFEncoder();
    const onceki = new Uint32Array(W * H); // ekranda görünen son kare
    for (let i = 0; i < kareler.length; i++) {
        const bolge = ciz(kareler[i]);
        const b = bolge ?? { x: 0, y: 0, w: W, h: H };
        const rgba = ctx.getImageData(b.x, b.y, b.w, b.h).data;
        const piksel = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2); // RGBA -> tek sayı (little-endian: R en düşük bayt)
        const gecikme = i === kareler.length - 1 ? DONGUYU_ENGELLE : kareler[i].gecikme;
        const indeks = new Uint8Array(W * H);
        if (i === 0) {
            for (let p = 0; p < piksel.length; p++) {
                const c = piksel[p];
                indeks[p] = enYakin(c & 255, (c >> 8) & 255, (c >> 16) & 255);
            }
            gif.writeFrame(indeks, W, H, { palette: tamPalet, delay: gecikme, repeat: -1 });
        } else {
            // Bir önceki kareyle birebir aynı piksel -> şeffaf (önceki kare görünmeye devam eder)
            if (bolge) indeks.fill(seffaf);
            for (let y = 0; y < b.h; y++) {
                const satir = (b.y + y) * W + b.x;
                for (let x = 0; x < b.w; x++) {
                    const c = piksel[y * b.w + x];
                    const p = satir + x;
                    indeks[p] = c === onceki[p] ? seffaf : enYakin(c & 255, (c >> 8) & 255, (c >> 16) & 255);
                }
            }
            gif.writeFrame(indeks, W, H, { delay: gecikme, transparent: true, transparentIndex: seffaf, dispose: 1 });
        }
        for (let y = 0; y < b.h; y++) onceki.set(piksel.subarray(y * b.w, (y + 1) * b.w), (b.y + y) * W + b.x);
        await nefesAl();
    }
    gif.finish();
    return new AttachmentBuilder(Buffer.from(gif.bytes()), { name: `vs_${Date.now()}.gif` });
}

async function avatarYukle(user: User): Promise<Image | null> {
    try {
        const url = user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true });
        // CDN takılırsa battle beklemesin, 3 sn sonra baş harfe düş
        return await Promise.race([
            loadImage(url),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))
        ]);
    } catch {
        return null;
    }
}

// ==================================================
// MESAJ / BİLEŞEN YARDIMCILARI
// ==================================================
// Resim embed yerine doğrudan ek olarak gönderiliyor: Discord embed içindeki resimleri
// küçültüyor, düz ekte aynı görsel belirgin şekilde daha büyük görünüyor.
type Bilesenler = ActionRowBuilder<MessageActionRowComponentBuilder>[];

function mesajHazirla(gorsel: CizimDurumu | AttachmentBuilder, metin: string, components: Bilesenler) {
    const dosya = gorsel instanceof AttachmentBuilder ? gorsel : resimOlustur(gorsel);
    return { content: metin, embeds: [], files: [dosya], components, allowedMentions: { parse: [] } };
}

function iptalMesaji(metin: string) {
    return { content: `### ⚔️ Case Battle\n${metin}`, embeds: [], files: [], components: [], allowedMentions: { parse: [] } };
}

// Ardışık aynı kasaları grupla: "3× 🥇 Altın Kasa → 1× 💎 Elmas Kasa"
function kasaOzeti(kasalar: Kasa[]): string {
    if (kasalar.length === 0) return '*Henüz kasa eklenmedi*';
    const gruplar: { kasa: Kasa; adet: number }[] = [];
    for (const kasa of kasalar) {
        const son = gruplar[gruplar.length - 1];
        if (son && son.kasa === kasa) son.adet++;
        else gruplar.push({ kasa, adet: 1 });
    }
    return gruplar.map(g => `**${g.adet}×** ${g.kasa.emoji} ${g.kasa.ad}`).join(' → ');
}

// "%12.5", "%0.35" ya da çok küçük şanslarda "1/33.875"
function yuzde(kasa: Kasa, seviye: number): string {
    const p = kasa.nadirlikSansi[seviye];
    if (p >= 1) return `%${parseFloat(p.toFixed(1))}`;
    if (p >= 0.01) return `%${parseFloat(p.toFixed(2))}`;
    return `1/${sayi(Math.round(100 / p))}`;
}

function kurulumBilesenleri(kasaSayisi: number): Bilesenler {
    const dolu = kasaSayisi >= MAX_KASA;
    const menu = new StringSelectMenuBuilder()
        .setCustomId('vs_kasa_ekle')
        .setPlaceholder(dolu ? `En fazla ${MAX_KASA} kasa eklenebilir` : '➕ Kasa ekle')
        .setDisabled(dolu)
        .addOptions(KASALAR.map(k => ({
            label: `${k.ad} — ${k.fiyat} DL`,
            value: k.id,
            emoji: k.emoji,
            // Sadece bu kasada çıkabilen nadirlikler, en değerliden başlayarak (Discord sınırı 100 karakter)
            description: [4, 3, 2, 1, 0].filter(n => k.nadirlikSansi[n] > 0).slice(0, 3)
                .map(n => `${NADIRLIKLER[n].ad} ${yuzde(k, n)}`).join(' • ').slice(0, 100)
        })));

    const butonlar = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder().setCustomId('vs_geri_al').setLabel('Son Kasayı Çıkar').setEmoji('↩️').setStyle(ButtonStyle.Secondary).setDisabled(kasaSayisi === 0),
        new ButtonBuilder().setCustomId('vs_temizle').setLabel('Temizle').setEmoji('🗑️').setStyle(ButtonStyle.Secondary).setDisabled(kasaSayisi === 0),
        new ButtonBuilder().setCustomId('vs_yayinla').setLabel('Battle Aç').setEmoji('🚀').setStyle(ButtonStyle.Success).setDisabled(kasaSayisi === 0),
        new ButtonBuilder().setCustomId('vs_iptal').setLabel('İptal').setStyle(ButtonStyle.Danger)
    );

    return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu), butonlar];
}

function lobiBilesenleri(ucret: number): Bilesenler {
    return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder().setCustomId('vs_katil').setLabel(`Katıl (${ucret} DL)`).setEmoji('⚔️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vs_lobi_iptal').setLabel('İptal').setStyle(ButtonStyle.Danger)
    )];
}

function kurulumMetni(kasalar: Kasa[]): string {
    return [
        '## ⚔️ Case Battle — Kurulum',
        'Menüden kasa ekle, hazır olunca **Battle Aç**\'a bas. İki oyuncu da aynı kasaları açar, **toplam değeri yüksek olan her şeyi alır!**',
        `**Kasalar:** ${kasaOzeti(kasalar)}`,
        `**Kasa Sayısı:** ${kasalar.length}/${MAX_KASA}  •  **Giriş Ücreti:** ${toplamFiyat(kasalar)} ${DL}`
    ].join('\n');
}

function lobiMetni(kurucuId: string, kasalar: Kasa[], ucret: number, bitis: number): string {
    return [
        '## ⚔️ Case Battle Açıldı!',
        `<@${kurucuId}> bir battle açtı! Aynı ücreti yatırıp **⚔️ Katıl**'a basan ilk kişi rakibi olur. Toplam değeri yüksek olan **iki tarafın açtığı her şeyi** alır.`,
        `**Kasalar:** ${kasaOzeti(kasalar)}`,
        `**Giriş Ücreti:** ${ucret} ${DL}  •  **Kapanış:** <t:${Math.floor(bitis / 1000)}:R>`
    ].join('\n');
}

// Kurulum ekranında sadece battle'ı açan kişi menüyü kullanabilsin, diğerlerine sessizce uyarı ver
function sadeceKurucu(kurucuId: string) {
    return (i: MessageComponentInteraction) => {
        if (i.user.id === kurucuId) return true;
        i.reply({ content: '❌ Bu menü battle\'ı açan kişiye ait.', ephemeral: true }).catch(() => { });
        return false;
    };
}

async function bilesenBekle(mesaj: Message, sure: number, filtre?: (i: MessageComponentInteraction) => boolean): Promise<MessageComponentInteraction | null> {
    try {
        return await mesaj.awaitMessageComponent({ time: sure, filter: filtre });
    } catch {
        return null; // süre doldu ya da mesaj silindi
    }
}

const bekle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class VsCommand implements Command {
    public name = 'vs';
    public description = 'Case Battle: kasaları seç, rakibini bekle, toplam değeri yüksek olan her şeyi alır!';
    public deferType = CommandDeferType.PUBLIC;

    public options: ApplicationCommandOptionData[] = [
        {
            name: 'kasa',
            description: 'Açılacak kasa (sonra menüden farklı kasalar da ekleyebilirsin)',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: KASALAR.map(k => ({ name: `${k.emoji} ${k.ad} (${k.fiyat} DL)`, value: k.id }))
        },
        {
            name: 'adet',
            description: `Bu kasadan kaç tane açılacak (1-${MAX_KASA})`,
            type: ApplicationCommandOptionType.Integer,
            required: true,
            minValue: 1,
            maxValue: MAX_KASA
        }
    ];

    public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        if (config2.devMode) {
            if (userId !== '1406333693383020727') {
                await interaction.editReply('Bu komut şuanda geliştirme aşamasındadır.');
                return;
            }
        }

        if (!interaction.channel || !interaction.channel.isTextBased()) return;

        try {
            yarimKalanlariIadeEt();
        } catch (err) {
            console.error('[vs] Yarım kalan battle iadeleri yapılamadı:', err);
        }

        if (aktifOynayanlar.has(userId)) {
            await interaction.editReply({ content: '❌ Zaten devam eden bir battle\'ın var! Önce onu bitir.' });
            return;
        }
        const kurucuBeklemesi = beklemedeMi(userId);
        if (kurucuBeklemesi) {
            await beklemeyiBildir(kurucuBeklemesi,
                metin => interaction.editReply({ content: metin }),
                metin => interaction.editReply({ content: metin }));
            return;
        }
        aktifOynayanlar.add(userId);

        // --- PARA TAKİBİ ---
        // Kimden ne kadar alındığı burada tutuluyor. Beklenmeyen bir hata olursa catch bloğu,
        // ödeme henüz yapılmadıysa herkese yatırdığını geri veriyor.
        let kurucuUcreti = 0;
        let rakip: User | null = null;
        let rakipUcreti = 0;
        let odemeYapildi = false;
        let battleSayildi = false;
        let gameMessage: Message | null = null;
        const battleId = interaction.id;

        try {
            const ilkKasa = KASA_MAP.get(interaction.options.getString('kasa', true));
            if (!ilkKasa) {
                await interaction.editReply({ content: '❌ Bu kasa artık yok, komutu tekrar seç.' });
                return;
            }
            const adet = interaction.options.getInteger('adet', true);
            let kasalar: Kasa[] = Array.from({ length: Math.max(1, Math.min(adet, MAX_KASA)) }, () => ilkKasa);

            const kurucu: OyuncuGorunumu = {
                isim: interaction.user.displayName,
                avatar: await avatarYukle(interaction.user),
                acilanlar: [],
                toplam: 0
            };

            const bekleyenEkran = (asama: 'kurulum' | 'lobi'): CizimDurumu => ({
                asama,
                kasalar,
                aktifTur: -1,
                oyuncular: [kurucu, null],
                altYazi: kasalar.length === 0
                    ? 'Menüden en az 1 kasa ekle'
                    : `${kasalar.length} Kasa  •  Giriş Ücreti: ${sayi(toplamFiyat(kasalar))} DL`
            });
            const kurulumEkrani = () => mesajHazirla(bekleyenEkran('kurulum'), kurulumMetni(kasalar), kurulumBilesenleri(kasalar.length));

            // ==================================================
            // 1) KURULUM: kurucu kasaları seçer (para henüz alınmadı)
            // ==================================================
            const mesaj = await interaction.editReply(kurulumEkrani());
            gameMessage = mesaj;

            let yayinlandi = false;
            while (!yayinlandi) {
                const i = await bilesenBekle(mesaj, KURULUM_SURESI, sadeceKurucu(userId));
                if (!i) {
                    await mesaj.edit(iptalMesaji('⌛ Kurulum süresi doldu, battle iptal edildi.')).catch(() => { });
                    return;
                }

                if (i.isStringSelectMenu() && i.customId === 'vs_kasa_ekle') {
                    const kasa = KASA_MAP.get(i.values[0]);
                    if (kasa && kasalar.length < MAX_KASA) kasalar.push(kasa);
                    await i.update(kurulumEkrani());
                } else if (i.customId === 'vs_geri_al') {
                    kasalar.pop();
                    await i.update(kurulumEkrani());
                } else if (i.customId === 'vs_temizle') {
                    kasalar = [];
                    await i.update(kurulumEkrani());
                } else if (i.customId === 'vs_iptal') {
                    await i.update(iptalMesaji('Battle iptal edildi.'));
                    return;
                } else if (i.customId === 'vs_yayinla') {
                    if (kasalar.length === 0) {
                        await i.reply({ content: '❌ En az 1 kasa eklemelisin.', ephemeral: true }).catch(() => { });
                        continue;
                    }
                    const ucret = toplamFiyat(kasalar);
                    // Bakiye kontrolü + kesinti tek adımda (Mines/Tower ile aynı desen)
                    if (!dbManager.removeDL(userId, ucret)) {
                        await i.reply({ content: `❌ Yetersiz bakiye! Giriş ücreti **${ucret}** ${DL}, bakiyen: **${dbManager.getDL(userId)}** ${DL}`, ephemeral: true }).catch(() => { });
                        continue;
                    }
                    kurucuUcreti = ucret;
                    emanetEkle(battleId, userId, ucret);
                    yayinlandi = true;
                    await i.deferUpdate().catch(() => { });
                }
            }

            // ==================================================
            // 2) LOBİ: herkes görebilir, ilk geçerli "Katıl" rakip olur
            // ==================================================
            const ucret = kurucuUcreti;
            const lobiBitis = Date.now() + LOBI_SURESI;
            await mesaj.edit(mesajHazirla(bekleyenEkran('lobi'), lobiMetni(userId, kasalar, ucret, lobiBitis), lobiBilesenleri(ucret)));

            while (!rakip) {
                const kalan = lobiBitis - Date.now();
                // Lobi süresi tıklamalarla uzamasın diye her seferinde kalan süre kadar bekliyoruz
                const i = kalan > 0 ? await bilesenBekle(mesaj, kalan) : null;

                if (!i) {
                    emanetKapat(battleId, userId);
                    dbManager.addDL(userId, kurucuUcreti);
                    kurucuUcreti = 0;
                    await mesaj.edit(iptalMesaji(`⌛ Kimse katılmadı. **${ucret}** ${DL} <@${userId}> kullanıcısına iade edildi.`)).catch(() => { });
                    return;
                }

                if (i.customId === 'vs_lobi_iptal') {
                    if (i.user.id !== userId) {
                        await i.reply({ content: '❌ Battle\'ı sadece açan kişi iptal edebilir.', ephemeral: true }).catch(() => { });
                        continue;
                    }
                    emanetKapat(battleId, userId);
                    dbManager.addDL(userId, kurucuUcreti);
                    kurucuUcreti = 0;
                    await i.update(iptalMesaji(`Battle iptal edildi. **${ucret}** ${DL} iade edildi.`)).catch(() => { });
                    return;
                }

                if (i.customId !== 'vs_katil') continue;

                // Reddetme cevapları battle'ı bozmasın: etkileşim zaman aşımına uğradıysa sessizce geç
                const reddet = (metin: string) => i.reply({ content: metin, ephemeral: true }).catch(() => { });
                if (i.user.bot) {
                    await reddet('❌ Botlar battle\'a katılamaz.');
                    continue;
                }
                if (i.user.id === userId) {
                    await reddet('❌ Kendi battle\'ına katılamazsın.');
                    continue;
                }
                if (aktifOynayanlar.has(i.user.id)) {
                    await reddet('❌ Zaten devam eden bir battle\'ın var.');
                    continue;
                }
                const katilanBeklemesi = beklemedeMi(i.user.id);
                if (katilanBeklemesi) {
                    await beklemeyiBildir(katilanBeklemesi,
                        metin => reddet(metin),
                        metin => i.editReply({ content: metin }));
                    continue;
                }
                if (oynananBattleSayisi >= MAX_ESZAMANLI_BATTLE) {
                    await reddet('⏳ Şu an çok fazla battle oynanıyor, birkaç saniye sonra tekrar dene. Lobi açık kalmaya devam ediyor.');
                    continue;
                }
                if (!dbManager.removeDL(i.user.id, ucret)) {
                    await reddet(`❌ Yetersiz bakiye! Katılmak için **${ucret}** ${DL} gerekiyor, bakiyen: **${dbManager.getDL(i.user.id)}** ${DL}`);
                    continue;
                }

                // Etkileşimler sırayla işlendiği için (await döngüsü) iki kişinin aynı anda
                // katılması mümkün değil: ilk geçerli tıklama burada rakibi kilitliyor.
                rakip = i.user;
                rakipUcreti = ucret;
                aktifOynayanlar.add(rakip.id);
                oynananBattleSayisi++;
                battleSayildi = true;
                emanetEkle(battleId, rakip.id, ucret);
                // Butonları hemen kaldır; ilk turun animasyonu hazırlanırken lobi resmi ekranda kalır
                await i.update({ content: `## ⚔️ <@${userId}> vs <@${rakip.id}>\nRakip bulundu, kasalar hazırlanıyor...`, components: [], allowedMentions: { parse: [] } }).catch(() => { });
            }

            // ==================================================
            // 3) SONUÇLARI HESAPLA + ÖDE
            // ==================================================
            const sonuclar = kasalar.map(k => [itemCek(k), itemCek(k)] as [KasaItemi, KasaItemi]);
            const toplamlar = [0, 1].map(o => sonuclar.reduce((t, s) => t + s[o].deger, 0));
            const havuz = toplamlar[0] + toplamlar[1];
            const kazanan: 0 | 1 | -1 = toplamlar[0] > toplamlar[1] ? 0 : (toplamlar[1] > toplamlar[0] ? 1 : -1);

            // --- ZIRH 4: ÖDEME ANİMASYONDAN ÖNCE ---
            // Sonuç zaten belli; animasyon sadece gösterim. Bot animasyonun ortasında
            // çökse ya da mesaj silinse bile kimse parasını kaybetmez.
            // Emanet kaydı ödemeden hemen önce kapatılıyor: hiçbir durumda iki kere ödenmez.
            emanetKapat(battleId);
            if (kazanan === -1) {
                dbManager.addDL(userId, toplamlar[0]);
                dbManager.addDL(rakip.id, toplamlar[1]);
            } else {
                dbManager.addDL(kazanan === 0 ? userId : rakip.id, havuz);
            }
            odemeYapildi = true;

            // ==================================================
            // 4) ANİMASYON: sonuçlar zaten belli, animasyon sadece onları gösterir. Her tur ayrı bir GIF.
            //    Discord GIF'leri istediği an baştan oynatabiliyor ya da ilk karesini gösterebiliyor
            //    (pencere odaktan çıkıp girince, mesaj kaydırılınca, mobilde). Bu yüzden her GIF'in İLK
            //    karesi o ana kadar açılmış her şeyi gösterir: bir önceki turun sonucu (item sahnede,
            //    öncekiler envanterde) ve sonucu gösterme beklemesi de bu karededir. GIF baştan
            //    oynasa bile envanter hiçbir zaman geri gitmez, açılmış bir item kaybolmaz.
            // ==================================================
            const [rakipAvatar] = await Promise.all([
                avatarYukle(rakip),
                gorselleriHazirla(sonuclar.flat(), kasalar)
            ]);
            const rakipGorunumu: OyuncuGorunumu = { isim: rakip.displayName, avatar: rakipAvatar, acilanlar: [], toplam: 0 };
            const temelOyuncular: [OyuncuGorunumu, OyuncuGorunumu] = [kurucu, rakipGorunumu];
            const rakipId = rakip.id;
            const sonucuGoster = kasalar.length > 5 ? ZAMANLAMA.sonucuGosterKalabalik : ZAMANLAMA.sonucuGoster;
            // İki oyuncunun sandığı aynı anda aynı yöne sallanmasın
            const fazlar = kasalar.map(() => [Math.random() * 6, Math.random() * 6] as [number, number]);

            // Sonuç ekranı: hem son GIF'in son karesi hem de animasyon bitince kalıcı sabit resim
            const oyuncular = [0, 1].map(o => ({
                ...temelOyuncular[o],
                acilanlar: sonuclar.map(s => s[o]),
                toplam: toplamlar[o]
            })) as [OyuncuGorunumu, OyuncuGorunumu];
            const kazananIsim = kazanan === -1 ? '' : oyuncular[kazanan].isim;
            const kazananId = kazanan === 0 ? userId : rakipId;
            const sonucEkrani: CizimDurumu = {
                asama: 'bitti',
                kasalar,
                aktifTur: kasalar.length,
                oyuncular,
                kazanan,
                altYazi: kazanan === -1 ? '🤝 Berabere! Herkes kendi açtığını aldı.' : `🏆 ${kazananIsim} ${sayi(havuz)} DL kazandı!`
            };

            // Her mesaj, düzenleme Discord'a ulaştıktan SONRA en az `ekrandaKal` ms görünür kalır.
            // Sıradaki GIF bu bekleme sırasında hazırlanıyor, böylece çizim süresi araya eklenmiyor.
            let oncekiKareZamani = 0;
            let oncekiKareSuresi = 0;
            const goster = async (gorsel: CizimDurumu | AttachmentBuilder, metin: string, ekrandaKal: number): Promise<boolean> => {
                const icerik = mesajHazirla(gorsel, metin, []);
                await bekle(Math.max(0, oncekiKareSuresi - (Date.now() - oncekiKareZamani)));
                try {
                    await mesaj.edit(icerik);
                } catch {
                    return false; // mesaj silindiyse animasyonu bırak, ödeme zaten yapıldı
                }
                oncekiKareZamani = Date.now();
                oncekiKareSuresi = ekrandaKal;
                return true;
            };

            const n = kasalar.length;
            // tur === n: son GIF (son item envantere uçar, sonuç ekranı gelir)
            for (let tur = 0; tur <= n; tur++) {
                const sonParca = tur === n;
                const kareler: AnimasyonKaresi[] = [];
                if (tur > 0) {
                    const oncekiTur = turKareleri(kasalar, tur - 1, sonuclar, temelOyuncular, sonucuGoster, fazlar[tur - 1]);
                    const oncekiTurunSonucu = oncekiTur[oncekiTur.length - 1];
                    kareler.push({ ...oncekiTurunSonucu, gecikme: sonucuGoster, cizim: 'tam' });
                }
                if (sonParca) {
                    kareler.push(...kapanisKareleri(kasalar, sonuclar, temelOyuncular));
                    kareler.push({ d: sonucEkrani, gecikme: 0 });
                } else {
                    kareler.push(...turKareleri(kasalar, tur, sonuclar, temelOyuncular, sonucuGoster, fazlar[tur]));
                }
                // GIF'in son karesi çok uzun sürer (döngü olmasın); bizim beklememiz ondan öncekilerin toplamı
                // + izleyicide yüklenme payı. Item'in ekranda kalma süresi sıradaki GIF'in ilk karesinde.
                const oynatma = kareler.slice(0, -1).reduce((t, k) => t + k.gecikme, 0)
                    + (sonParca ? 1500 : 0) + ZAMANLAMA.yuklemePayi;
                const durum = sonParca ? 'Sonuç hesaplanıyor...' : `Kasalar açılıyor... (Tur ${tur + 1}/${n})`;
                const metin = `## ⚔️ <@${userId}> vs <@${rakipId}>\n🎲 ${durum}`;
                if (!await goster(await gifOlustur(kareler), metin, oynatma)) break;
            }

            // ==================================================
            // 5) SONUÇ EKRANI (sabit resim: GIF'i görmeyenler ya da sonradan bakanlar için)
            // ==================================================
            const bitisMetni = [
                kazanan === -1 ? '## 🤝 Berabere!' : `## 🏆 <@${kazananId}> kazandı!`,
                `<@${userId}> **${toplamlar[0]}** ${DL}  vs  <@${rakipId}> **${toplamlar[1]}** ${DL}`,
                kazanan === -1
                    ? `**Giriş Ücreti:** ${ucret} ${DL} (kişi başı)  •  Herkes kendi açtığını aldı.`
                    : `**Giriş Ücreti:** ${ucret} ${DL} (kişi başı)  •  **Havuz:** ${havuz} ${DL}  •  <@${kazananId}> **+${havuz}** ${DL} (net ${havuz - ucret >= 0 ? '+' : ''}${havuz - ucret})`
            ].join('\n');

            await goster(sonucEkrani, bitisMetni, 0);
        } catch (err) {
            // Beklenmeyen hata: ödeme yapılmadıysa alınan giriş ücretlerini geri ver
            if (!odemeYapildi) {
                // Emanet kaydı kapatılamaz ama dosyada duruyorsa iadeyi burada YAPMIYORUZ:
                // bot yeniden açılınca otomatik iade edilecek (iki kere ödenmesin).
                // Kayıt hiç yazılamamışsa (dosya hatası) iade doğrudan burada yapılır.
                let buradaIadeEt = true;
                try {
                    emanetKapat(battleId);
                } catch {
                    buradaIadeEt = !emanetleriOku().some(e => e.battle === battleId);
                    if (!buradaIadeEt) console.error(`[vs] ${battleId} emanet kaydı kapatılamadı; iade bot yeniden başlayınca otomatik yapılacak`);
                }
                if (buradaIadeEt) {
                    if (kurucuUcreti > 0) dbManager.addDL(userId, kurucuUcreti);
                    if (rakip && rakipUcreti > 0) dbManager.addDL(rakip.id, rakipUcreti);
                }
                const iadeMetni = rakipUcreti > 0 ? 'Yatırılan DL iki oyuncuya da iade edildi.' : (kurucuUcreti > 0 ? 'Yatırılan DL iade edildi.' : '');
                await gameMessage?.edit(iptalMesaji(`⚠️ Beklenmeyen bir hata oluştu, battle iptal edildi. ${iadeMetni}`)).catch(() => { });
            }
            throw err;
        } finally {
            // --- ZIRH 5: HER DURUMDA KİLİTLERİ AÇ ---
            aktifOynayanlar.delete(userId);
            if (rakip) aktifOynayanlar.delete(rakip.id);
            if (battleSayildi) oynananBattleSayisi--;

            // Bekleme süresi burada, yani maç (animasyon + sonuç ekranı) bittikten sonra başlar
            const simdi = Date.now();
            if (odemeYapildi) {
                beklemeBitisi.set(userId, simdi + MAC_SONRASI_BEKLEME);
                if (rakip) beklemeBitisi.set(rakip.id, simdi + MAC_SONRASI_BEKLEME);
            } else {
                beklemeBitisi.set(userId, simdi + IPTAL_SONRASI_BEKLEME);
            }
            // Süresi dolmuş kayıtları temizle (harita büyümesin)
            for (const [k, bitis] of beklemeBitisi) if (bitis <= simdi) beklemeBitisi.delete(k);
        }
    }
}

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
import { createCanvas, loadImage, Image, CanvasRenderingContext2D } from 'canvas';
import { randomInt } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { Command, CommandDeferType } from '../structers/command';
import { dbManager } from '../db/db';
import config2 from './config.json'

const DL = '<:DL:1381246442089349255>';

// Kasa/item ayarları ve PNG'ler bu klasörde. Bot kök klasöründen çalıştırılıyorsa
// <bot>/assets/vs/ayarlar.json, <bot>/assets/vs/itemler/*.png şeklinde durmalı.
// Değişiklikler bot yeniden başlatılınca geçerli olur.
const VS_KLASORU = path.join(process.cwd(), 'assets', 'vs');

// ==================================================
// NADİRLİK / KASA / ITEM TANIMLARI (ayarlar.json'dan)
// ==================================================
const NADIRLIKLER = [
    { id: 'siradan', ad: 'Sıradan', renk: '#9aa0ab' },
    { id: 'siradisi', ad: 'Sıradışı', renk: '#3ddc84' },
    { id: 'gizemli', ad: 'Gizemli', renk: '#2f9bff' },
    { id: 'destansi', ad: 'Destansı', renk: '#b14cff' },
    { id: 'efsanevi', ad: 'Efsanevi', renk: '#ffb300' }
] as const;

interface KasaItemi {
    ad: string;
    seviye: number;  // NADIRLIKLER içindeki sıra: 0 Sıradan ... 4 Efsanevi
    renk: string;
    deger: number;   // DL karşılığı
    gorsel: string;  // VS_KLASORU'na göre PNG yolu
    resim?: Image | null; // yüklenince dolar, PNG yoksa null (yedek ikon çizilir)
}

interface Kasa {
    id: string;
    ad: string;
    emoji: string;
    fiyat: number;
    renk: string;
    gorsel?: string;
    resim?: Image | null;
    sanslar: number[];   // nadirlik başına şans (yüzdenin 1000 katı, tam sayı)
    toplamSans: number;
    rtp: number;         // ortalama geri dönüş (fiyata oranla)
}

interface AyarDosyasi {
    kasalar: { id: string; ad: string; emoji: string; fiyat: number; renk?: string; gorsel?: string; sanslar: Record<string, number> }[];
    itemler: { ad: string; nadirlik: string; deger: number; gorsel: string }[];
}

function ayarlariYukle(): { kasalar: Kasa[]; havuz: KasaItemi[][] } {
    const dosya = path.join(VS_KLASORU, 'ayarlar.json');
    let ham: AyarDosyasi;
    try {
        ham = JSON.parse(readFileSync(dosya, 'utf-8'));
    } catch (err) {
        throw new Error(`[vs] ${dosya} okunamadı: ${(err as Error).message}`);
    }

    // Havuz: nadirlik başına item listesi. Kasa önce nadirliği seçer, sonra o nadirlikten eşit şansla bir item.
    const havuz: KasaItemi[][] = NADIRLIKLER.map(() => []);
    for (const it of ham.itemler) {
        const seviye = NADIRLIKLER.findIndex(n => n.id === it.nadirlik);
        if (seviye === -1) throw new Error(`[vs] "${it.ad}" bilinmeyen nadirlik: ${it.nadirlik}`);
        if (!(it.deger > 0)) throw new Error(`[vs] "${it.ad}" değeri 0'dan büyük olmalı`);
        havuz[seviye].push({ ad: it.ad, seviye, renk: NADIRLIKLER[seviye].renk, deger: Math.floor(it.deger), gorsel: it.gorsel });
    }

    const kasalar = ham.kasalar.map((k): Kasa => {
        const sanslar = NADIRLIKLER.map(n => Math.round((k.sanslar[n.id] ?? 0) * 1000));
        const toplamSans = sanslar.reduce((t, s) => t + s, 0);
        if (toplamSans <= 0) throw new Error(`[vs] ${k.id} kasasının şansları boş`);
        sanslar.forEach((s, i) => {
            if (s > 0 && havuz[i].length === 0) throw new Error(`[vs] ${k.id} kasası ${NADIRLIKLER[i].ad} çıkarabiliyor ama havuzda ${NADIRLIKLER[i].ad} item yok`);
        });

        // Ortalama kazanç = Σ (nadirlik şansı × o nadirlikteki itemlerin ortalama değeri)
        const ortalama = sanslar.reduce((t, s, i) => s === 0 ? t
            : t + (s / toplamSans) * (havuz[i].reduce((a, it) => a + it.deger, 0) / havuz[i].length), 0);
        return {
            id: k.id, ad: k.ad, emoji: k.emoji, fiyat: k.fiyat, renk: k.renk ?? '#b07a45', gorsel: k.gorsel,
            sanslar, toplamSans, rtp: ortalama / k.fiyat
        };
    });

    // Item değerleri/şanslar değiştirilince kasanın kâra mı zarara mı geçtiği konsoldan görülsün
    for (const k of kasalar) {
        const uyari = k.rtp > 1 ? '  ⚠️ %100 üstü: bu kasa uzun vadede para kaybettirir!' : '';
        console.log(`[vs] ${k.ad} (${k.fiyat} DL) ortalama geri dönüş: %${(k.rtp * 100).toFixed(1)}${uyari}`);
    }
    return { kasalar, havuz };
}

const { kasalar: KASALAR, havuz: HAVUZ } = ayarlariYukle();
const KASA_MAP = new Map(KASALAR.map(k => [k.id, k]));

const MAX_KASA = 10;
const KURULUM_SURESI = 90_000;   // kurucu bu süre boyunca hiçbir şeye basmazsa kurulum iptal
const LOBI_SURESI = 120_000;     // bu sürede rakip katılmazsa battle iptal + iade

// Tur başına iki kare: kutu sallanıyor -> kutu açıldı. Süreler mesaj düzenleme süresini de
// kapsar (düzenleme 400ms sürdüyse sadece kalan kadar beklenir), yani tur ~4 sn.
// Hızlandırmak/yavaşlatmak için sadece bu sayıları değiştir (milisaniye).
function kareSureleri(kasaSayisi: number): { sallanma: number; acilis: number } {
    return kasaSayisi > 5 ? { sallanma: 1300, acilis: 2100 } : { sallanma: 1600, acilis: 2600 };
}

// --- ZIRH 1: AYNI ANDA TEK BATTLE (hem kurucu hem rakip için) ---
const aktifOynayanlar = new Set<string>();

function itemCek(kasa: Kasa): KasaItemi {
    // Tower'daki gibi kriptografik üreteç: sonuç V8'in PRNG'sinden tahmin edilemez.
    let r = randomInt(kasa.toplamSans);
    let seviye = 0;
    while (r >= kasa.sanslar[seviye]) {
        r -= kasa.sanslar[seviye];
        seviye++;
    }
    const liste = HAVUZ[seviye];
    return liste[randomInt(liste.length)];
}

function toplamFiyat(kasalar: Kasa[]): number {
    return kasalar.reduce((t, k) => t + k.fiyat, 0);
}

// ==================================================
// PNG YÜKLEME (önbellekli)
// ==================================================
const gorselOnbellegi = new Map<string, Promise<Image | null>>();

function gorselYukle(dosya: string, uyar: boolean): Promise<Image | null> {
    const tam = path.join(VS_KLASORU, dosya);
    let yukleme = gorselOnbellegi.get(tam);
    if (!yukleme) {
        yukleme = loadImage(tam).catch(() => {
            if (uyar) console.warn(`[vs] Görsel bulunamadı, yedek ikon kullanılacak: ${tam}`);
            return null;
        });
        gorselOnbellegi.set(tam, yukleme);
    }
    return yukleme;
}

// Çizim senkron olduğu için kullanılacak görseller çizimden önce yüklenip nesneye yazılıyor
async function gorselleriHazirla(itemler: KasaItemi[], kasalar: Kasa[]) {
    await Promise.all([
        ...itemler.filter(i => i.resim === undefined).map(async i => { i.resim = await gorselYukle(i.gorsel, true); }),
        ...kasalar.filter(k => k.resim === undefined).map(async k => { k.resim = k.gorsel ? await gorselYukle(k.gorsel, true) : null; })
    ]);
}

// Bot açılırken tüm PNG'leri arka planda ısıt; ilk battle'da bekleme olmasın
void gorselleriHazirla(HAVUZ.flat(), KASALAR);

// ==================================================
// CANVAS ÇİZİM MOTORU
// ==================================================
const GENISLIK = 1000;
const YUKSEKLIK = 620;
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

interface KutuSahnesi {
    durum: 'sallaniyor' | 'acildi';
    kasa: Kasa;
    item: KasaItemi; // 'sallaniyor' durumunda çizilmez
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

function cizArkaPlan(ctx: CanvasRenderingContext2D) {
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
function cizIsinlar(ctx: CanvasRenderingContext2D, cx: number, cy: number, yaricap: number, renk: string, opaklik: number = 1) {
    ctx.save();
    ctx.globalAlpha *= opaklik;
    ctx.translate(cx, cy);
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
    // Yüzey çizgileri
    ctx.beginPath();
    ctx.moveTo(cx - r, kus); ctx.lineTo(cx + r, kus);
    ctx.moveTo(cx - r * 0.55, ust); ctx.lineTo(cx - r * 0.25, kus); ctx.lineTo(cx, cy + r * 0.95);
    ctx.moveTo(cx + r * 0.55, ust); ctx.lineTo(cx + r * 0.25, kus); ctx.lineTo(cx, cy + r * 0.95);
    ctx.moveTo(cx - r * 0.25, kus); ctx.lineTo(cx, ust); ctx.lineTo(cx + r * 0.25, kus);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
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

// Kasa: PNG'si varsa o, yoksa kasanın renginde çizilmiş sandık.
// acik=true iken kapak havaya fırlamış, içinden ışık hüzmesi çıkıyor.
function cizKutu(ctx: CanvasRenderingContext2D, kasa: Kasa, cx: number, cy: number, boyut: number, aci: number, acik: boolean, isikRengi: string) {
    const w = boyut;
    const h = boyut * 0.62;
    const kapakH = boyut * 0.24;
    const govdeUst = cy - h / 2;

    ctx.save();
    // Zemin gölgesi
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + h / 2 + 8, w * 0.55, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    if (acik) {
        // İçeriden yukarı yükselen ışık
        const isik = ctx.createLinearGradient(0, govdeUst, 0, govdeUst - boyut * 1.3);
        isik.addColorStop(0, isikRengi + 'cc');
        isik.addColorStop(1, isikRengi + '00');
        ctx.fillStyle = isik;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.42, govdeUst);
        ctx.lineTo(cx + w * 0.42, govdeUst);
        ctx.lineTo(cx + w * 0.75, govdeUst - boyut * 1.3);
        ctx.lineTo(cx - w * 0.75, govdeUst - boyut * 1.3);
        ctx.closePath();
        ctx.fill();
    }

    ctx.translate(cx, cy);
    ctx.rotate(aci);

    if (kasa.resim) {
        const olcek = Math.min(boyut / kasa.resim.width, boyut / kasa.resim.height);
        const iw = kasa.resim.width * olcek;
        const ih = kasa.resim.height * olcek;
        if (acik) ctx.globalAlpha = 0.85;
        ctx.drawImage(kasa.resim, -iw / 2, -ih / 2, iw, ih);
        ctx.restore();
        return;
    }

    const govde = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    govde.addColorStop(0, renkTon(kasa.renk, 0.15));
    govde.addColorStop(1, renkTon(kasa.renk, -0.45));

    const kapak = ctx.createLinearGradient(0, -kapakH, 0, 0);
    kapak.addColorStop(0, renkTon(kasa.renk, 0.35));
    kapak.addColorStop(1, renkTon(kasa.renk, -0.1));
    const cizKapak = () => {
        yuvarlakYol(ctx, -w / 2 - 6, -kapakH, w + 12, kapakH, 10);
        ctx.fillStyle = kapak;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.stroke();
        ctx.fillStyle = renkTon(kasa.renk, -0.6);
        ctx.fillRect(-w * 0.08, -kapakH, w * 0.16, kapakH);
    };

    if (acik) {
        // Kapak fırlayıp kasanın sol arkasına yaslanmış (gövdenin arkasında kalsın diye önce çiziliyor)
        ctx.save();
        ctx.translate(-w * 0.58, -h * 0.12);
        ctx.rotate(-0.55);
        ctx.translate(0, kapakH / 2);
        cizKapak();
        ctx.restore();
        // Açık ağız (iç kısım)
        ctx.fillStyle = renkTon(kasa.renk, -0.75);
        ctx.beginPath();
        ctx.ellipse(0, -h / 2, w / 2 - 4, 10, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    // Gövde
    yuvarlakYol(ctx, -w / 2, -h / 2, w, h, 10);
    ctx.fillStyle = govde;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Dikey şerit + kilit
    ctx.fillStyle = renkTon(kasa.renk, -0.6);
    ctx.fillRect(-w * 0.08, -h / 2, w * 0.16, h);
    yuvarlakYol(ctx, -w * 0.09, -h / 2 + 4, w * 0.18, h * 0.32, 5);
    ctx.fillStyle = '#ffd34d';
    ctx.fill();
    ctx.fillStyle = '#3a2a00';
    ctx.beginPath();
    ctx.arc(0, -h / 2 + 4 + h * 0.12, w * 0.022, 0, Math.PI * 2);
    ctx.fill();

    if (!acik) {
        // Kapak
        ctx.save();
        ctx.translate(0, -h / 2 + 2);
        cizKapak();
        ctx.restore();
        // Kapak aralığından sızan ışık: "açılmak üzere"
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 25;
        ctx.fillStyle = '#fff6d6';
        ctx.fillRect(-w / 2 + 6, -h / 2 - 1, w - 12, 4);
        ctx.shadowBlur = 0;
    }
    ctx.restore();
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
        const aktif = d.asama === 'battle' && k === d.aktifTur;
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

// Kutu açılma sahnesi (oyuncunun kendi alanı)
function cizSahne(ctx: CanvasRenderingContext2D, sahne: KutuSahnesi, x: number, y: number, w: number, h: number, index: 0 | 1) {
    const cx = x + w / 2;
    const oyuncuRengi = OYUNCU_RENKLERI[index];

    ctx.save();
    yuvarlakYol(ctx, x, y, w, h, 18);
    ctx.fillStyle = '#0a0b0f';
    ctx.fill();
    ctx.clip();

    if (sahne.durum === 'sallaniyor') {
        const kutuY = y + h * 0.63;
        const glow = ctx.createRadialGradient(cx, kutuY, 10, cx, kutuY, w * 0.5);
        glow.addColorStop(0, oyuncuRengi + '55');
        glow.addColorStop(1, oyuncuRengi + '00');
        ctx.fillStyle = glow;
        ctx.fillRect(x, y, w, h);

        // Sallanma çizgileri
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        for (const yon of [-1, 1]) {
            for (let k = 0; k < 3; k++) {
                const r = 128 + k * 20;
                ctx.globalAlpha = 0.8 - k * 0.25;
                ctx.beginPath();
                ctx.arc(cx, kutuY, r, yon === -1 ? Math.PI - 0.35 : -0.35, yon === -1 ? Math.PI + 0.35 : 0.35);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
        ctx.lineCap = 'butt';

        cizKutu(ctx, sahne.kasa, cx, kutuY, 205, index === 0 ? -0.11 : 0.11, false, '#ffffff');
        cizParilti(ctx, cx - 115, kutuY - 100, 12, '#ffffff');
        cizParilti(ctx, cx + 120, kutuY - 70, 9, '#ffffff');
        cizParilti(ctx, cx + 85, kutuY - 125, 6, '#ffffff');

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 24px Arial';
        ctx.fillStyle = '#c9cbd6';
        ctx.fillText('KASA AÇILIYOR...', cx, y + 30);
    } else {
        const item = sahne.item;
        const itemY = y + h * 0.47;
        // Nadirlik yükseldikçe efekt büyüyor: Sıradan sade, Efsanevi tam ışık şöleni
        const guc = [0, 0.3, 0.45, 0.7, 1][item.seviye];
        const glow = ctx.createRadialGradient(cx, itemY, 10, cx, itemY, w * 0.55);
        glow.addColorStop(0, item.renk + (item.seviye >= 3 ? '88' : '44'));
        glow.addColorStop(1, item.renk + '00');
        ctx.fillStyle = glow;
        ctx.fillRect(x, y, w, h);
        if (guc > 0) cizIsinlar(ctx, cx, itemY, w * 0.62, item.renk, guc);

        cizKutu(ctx, sahne.kasa, cx, y + h - 46, 140, 0, true, item.renk);
        cizItemGorseli(ctx, item, cx, itemY, 175, true);

        if (item.seviye >= 3) {
            cizParilti(ctx, cx - 125, itemY - 55, 13, item.renk);
            cizParilti(ctx, cx + 130, itemY - 25, 10, '#ffffff');
            cizParilti(ctx, cx + 100, itemY + 70, 7, item.renk);
            cizParilti(ctx, cx - 105, itemY + 65, 8, '#ffffff');
        }
        cizEtiket(ctx, NADIRLIKLER[item.seviye].ad.toLocaleUpperCase('tr-TR'), cx, y + 30, item.renk, 20);
    }
    ctx.restore();
}

// Kare kart: PNG + değer (+ yeterince büyükse isim)
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

    const isimli = h >= 120;
    const yaziVar = h >= 60;
    const ikon = yaziVar ? Math.min(w * 0.72, h * (isimli ? 0.5 : 0.55)) : Math.min(w, h) * 0.78;
    cizItemGorseli(ctx, item, x + w / 2, y + (yaziVar ? h * 0.38 : h / 2), ikon, false);
    if (!yaziVar) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (isimli) {
        ctx.font = 'bold 15px Arial';
        ctx.fillStyle = '#c9cbd6';
        ctx.fillText(kisalt(ctx, item.ad, w - 8), x + w / 2, y + h * 0.7);
    }
    const metin = `${sayi(item.deger)} DL`;
    sigdirFont(ctx, metin, w - 8, isimli ? 19 : 17, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(metin, x + w / 2, y + h * (isimli ? 0.86 : 0.82));
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
    const nadirAcilis = !bitti && sahne?.durum === 'acildi' && sahne.item.seviye >= 3;

    const neon = kazandi ? '#ffd700' : (nadirAcilis ? sahne!.item.renk : renk);
    neonKutu(ctx, x, y, w, h, 22, '#111218', neon, kazandi || nadirAcilis ? 45 : 18);
    if (kazandi || nadirAcilis) {
        yuvarlakYol(ctx, x, y, w, h, 22);
        ctx.strokeStyle = neon;
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    // Başlık: avatar + isim + toplam değer
    cizAvatar(ctx, oyuncu, x + 52, y + 52, 34, renk);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = 'bold 30px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(kisalt(ctx, oyuncu.isim, 160), x + 98, y + 52);
    ctx.textAlign = 'right';
    sigdirFont(ctx, `${sayi(oyuncu.toplam)} DL`, 175, 40, 24);
    ctx.fillStyle = '#ffd700';
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 12;
    ctx.fillText(`${sayi(oyuncu.toplam)} DL`, x + w - 22, y + 52);
    ctx.shadowBlur = 0;

    const sx = x + 15;
    const sw = w - 30;

    if (!bitti && sahne) {
        // Kutu sahnesi + altında çıkan item bilgisi
        cizSahne(ctx, sahne, sx, y + 102, sw, 282, index);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (sahne.durum === 'acildi') {
            sigdirFont(ctx, sahne.item.ad, sw - 20, 34, 18);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(sahne.item.ad, x + w / 2, y + 410);
            ctx.font = 'bold 38px Arial';
            ctx.fillStyle = sahne.item.renk;
            ctx.shadowColor = sahne.item.renk;
            ctx.shadowBlur = 14;
            ctx.fillText(`+${sayi(sahne.item.deger)} DL`, x + w / 2, y + 448);
            ctx.shadowBlur = 0;
        } else {
            ctx.font = 'bold 34px Arial';
            ctx.fillStyle = '#3a3d4a';
            ctx.fillText('? ? ?', x + w / 2, y + 410);
            ctx.font = 'bold 38px Arial';
            ctx.fillText('? DL', x + w / 2, y + 448);
        }
    } else {
        // Sonuç: büyük toplam + açılan tüm itemler
        const rx = sx;
        const ry = y + 102;
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

function battleCiz(d: CizimDurumu): AttachmentBuilder {
    const canvas = createCanvas(GENISLIK, YUKSEKLIK);
    const ctx = canvas.getContext('2d');
    const battleEkrani = d.asama === 'battle' || d.asama === 'bitti';

    cizArkaPlan(ctx);
    if (battleEkrani) {
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

    // Limbo'daki gibi her karede farklı isim: Discord eski resmi önbellekten göstermesin
    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `vs_${Date.now()}.png` });
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

function mesajHazirla(d: CizimDurumu, metin: string, components: Bilesenler) {
    return { content: metin, embeds: [], files: [battleCiz(d)], components, allowedMentions: { parse: [] } };
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

// "%0.1" gibi: gereksiz sıfırlar olmadan
const yuzde = (kasa: Kasa, seviye: number) => `%${parseFloat((kasa.sanslar[seviye] / kasa.toplamSans * 100).toFixed(2))}`;

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
            description: `Efsanevi ${yuzde(k, 4)} • Destansı ${yuzde(k, 3)} • Gizemli ${yuzde(k, 2)}`
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

        if (aktifOynayanlar.has(userId)) {
            await interaction.editReply({ content: '❌ Zaten devam eden bir battle\'ın var! Önce onu bitir.' });
            return;
        }
        aktifOynayanlar.add(userId);

        // --- ZIRH 2: PARA TAKİBİ ---
        // Kimden ne kadar alındığı burada tutuluyor. Beklenmeyen bir hata olursa catch bloğu,
        // ödeme henüz yapılmadıysa herkese yatırdığını geri veriyor.
        let kurucuUcreti = 0;
        let rakip: User | null = null;
        let rakipUcreti = 0;
        let odemeYapildi = false;

        try {
            const ilkKasa = KASA_MAP.get(interaction.options.getString('kasa', true))!;
            const adet = interaction.options.getInteger('adet', true);
            let kasalar: Kasa[] = Array.from({ length: Math.min(adet, MAX_KASA) }, () => ilkKasa);

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
            const gameMessage = await interaction.editReply(kurulumEkrani());

            let yayinlandi = false;
            while (!yayinlandi) {
                const i = await bilesenBekle(gameMessage, KURULUM_SURESI, sadeceKurucu(userId));
                if (!i) {
                    await gameMessage.edit(iptalMesaji('⌛ Kurulum süresi doldu, battle iptal edildi.')).catch(() => { });
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
                        await i.reply({ content: '❌ En az 1 kasa eklemelisin.', ephemeral: true });
                        continue;
                    }
                    const ucret = toplamFiyat(kasalar);
                    // Bakiye kontrolü + kesinti tek adımda (Mines/Tower ile aynı desen)
                    if (!dbManager.removeDL(userId, ucret)) {
                        await i.reply({ content: `❌ Yetersiz bakiye! Giriş ücreti **${ucret}** ${DL}, bakiyen: **${dbManager.getDL(userId)}** ${DL}`, ephemeral: true });
                        continue;
                    }
                    kurucuUcreti = ucret;
                    yayinlandi = true;
                    await i.deferUpdate();
                }
            }

            // ==================================================
            // 2) LOBİ: herkes görebilir, ilk geçerli "Katıl" rakip olur
            // ==================================================
            const ucret = kurucuUcreti;
            const lobiBitis = Date.now() + LOBI_SURESI;
            await gameMessage.edit(mesajHazirla(bekleyenEkran('lobi'), lobiMetni(userId, kasalar, ucret, lobiBitis), lobiBilesenleri(ucret)));

            while (!rakip) {
                const kalan = lobiBitis - Date.now();
                // Lobi süresi tıklamalarla uzamasın diye her seferinde kalan süre kadar bekliyoruz
                const i = kalan > 0 ? await bilesenBekle(gameMessage, kalan) : null;

                if (!i) {
                    dbManager.addDL(userId, kurucuUcreti);
                    kurucuUcreti = 0;
                    await gameMessage.edit(iptalMesaji(`⌛ Kimse katılmadı. **${ucret}** ${DL} <@${userId}> kullanıcısına iade edildi.`)).catch(() => { });
                    return;
                }

                if (i.customId === 'vs_lobi_iptal') {
                    if (i.user.id !== userId) {
                        await i.reply({ content: '❌ Battle\'ı sadece açan kişi iptal edebilir.', ephemeral: true });
                        continue;
                    }
                    dbManager.addDL(userId, kurucuUcreti);
                    kurucuUcreti = 0;
                    await i.update(iptalMesaji(`Battle iptal edildi. **${ucret}** ${DL} iade edildi.`));
                    return;
                }

                if (i.customId !== 'vs_katil') continue;

                if (i.user.id === userId) {
                    await i.reply({ content: '❌ Kendi battle\'ına katılamazsın.', ephemeral: true });
                    continue;
                }
                if (aktifOynayanlar.has(i.user.id)) {
                    await i.reply({ content: '❌ Zaten devam eden bir battle\'ın var.', ephemeral: true });
                    continue;
                }
                if (!dbManager.removeDL(i.user.id, ucret)) {
                    await i.reply({ content: `❌ Yetersiz bakiye! Katılmak için **${ucret}** ${DL} gerekiyor, bakiyen: **${dbManager.getDL(i.user.id)}** ${DL}`, ephemeral: true });
                    continue;
                }

                // Etkileşimler sırayla işlendiği için (await döngüsü) iki kişinin aynı anda
                // katılması mümkün değil: ilk geçerli tıklama burada rakibi kilitliyor.
                rakip = i.user;
                rakipUcreti = ucret;
                aktifOynayanlar.add(rakip.id);
                await i.update({ components: [] }); // butonları hemen kaldır
            }

            // ==================================================
            // 3) SONUÇLARI HESAPLA + ÖDE
            // ==================================================
            const sonuclar = kasalar.map(k => [itemCek(k), itemCek(k)] as [KasaItemi, KasaItemi]);
            const toplamlar = [0, 1].map(o => sonuclar.reduce((t, s) => t + s[o].deger, 0));
            const havuz = toplamlar[0] + toplamlar[1];
            const kazanan: 0 | 1 | -1 = toplamlar[0] > toplamlar[1] ? 0 : (toplamlar[1] > toplamlar[0] ? 1 : -1);

            // --- ZIRH 3: ÖDEME ANİMASYONDAN ÖNCE ---
            // Sonuç zaten belli; animasyon sadece gösterim. Bot animasyonun ortasında
            // çökse ya da mesaj silinse bile kimse parasını kaybetmez.
            if (kazanan === -1) {
                dbManager.addDL(userId, toplamlar[0]);
                dbManager.addDL(rakip.id, toplamlar[1]);
            } else {
                dbManager.addDL(kazanan === 0 ? userId : rakip.id, havuz);
            }
            odemeYapildi = true;

            // ==================================================
            // 4) ANİMASYON: her turda iki kare (kasa sallanıyor -> item çıktı)
            // ==================================================
            const [rakipAvatar] = await Promise.all([
                avatarYukle(rakip),
                gorselleriHazirla(sonuclar.flat(), kasalar)
            ]);
            const rakipGorunumu: OyuncuGorunumu = { isim: rakip.displayName, avatar: rakipAvatar, acilanlar: [], toplam: 0 };
            const oyuncular: [OyuncuGorunumu, OyuncuGorunumu] = [kurucu, rakipGorunumu];
            const rakipId = rakip.id;
            const sure = kareSureleri(kasalar.length);

            const goster = async (d: CizimDurumu, metin: string): Promise<boolean> => {
                try {
                    await gameMessage.edit(mesajHazirla(d, metin, []));
                    return true;
                } catch {
                    return false; // mesaj silindiyse animasyonu bırak, ödeme zaten yapıldı
                }
            };
            // Mesaj düzenleme süresi de beklemeye sayılır: hedef süre zaten dolduysa hiç beklenmez
            const kalaniBekle = (baslangic: number, ms: number) => bekle(Math.max(0, ms - (Date.now() - baslangic)));

            animasyon:
            for (let tur = 0; tur < kasalar.length; tur++) {
                const kasa = kasalar[tur];
                const metin = `### ⚔️ Tur ${tur + 1}/${kasalar.length} — ${kasa.emoji} ${kasa.ad}\n<@${userId}> **vs** <@${rakipId}>`;
                const ekran = (durum: KutuSahnesi['durum']): CizimDurumu => ({
                    asama: 'battle',
                    kasalar,
                    aktifTur: tur,
                    oyuncular,
                    sahneler: [
                        { durum, kasa, item: sonuclar[tur][0] },
                        { durum, kasa, item: sonuclar[tur][1] }
                    ],
                    altYazi: `Havuz: ${sayi(oyuncular[0].toplam + oyuncular[1].toplam)} DL`
                });

                let t = Date.now();
                if (!await goster(ekran('sallaniyor'), metin)) break animasyon;
                await kalaniBekle(t, sure.sallanma);

                for (const o of [0, 1] as const) {
                    oyuncular[o].acilanlar.push(sonuclar[tur][o]);
                    oyuncular[o].toplam += sonuclar[tur][o].deger;
                }
                t = Date.now();
                if (!await goster(ekran('acildi'), metin)) break animasyon;
                await kalaniBekle(t, sure.acilis);
            }

            // ==================================================
            // 5) SONUÇ EKRANI
            // ==================================================
            // Animasyon yarıda kesildiyse bile son ekran eksiksiz olsun
            for (const o of [0, 1] as const) {
                oyuncular[o].acilanlar = sonuclar.map(s => s[o]);
                oyuncular[o].toplam = toplamlar[o];
            }

            const kazananIsim = kazanan === -1 ? '' : oyuncular[kazanan].isim;
            const kazananId = kazanan === 0 ? userId : rakipId;
            const bitisMetni = [
                kazanan === -1 ? '## 🤝 Berabere!' : `## 🏆 ${kazananIsim} kazandı!`,
                `<@${userId}> **${toplamlar[0]}** ${DL}  vs  <@${rakipId}> **${toplamlar[1]}** ${DL}`,
                kazanan === -1
                    ? `**Giriş Ücreti:** ${ucret} ${DL} (kişi başı)  •  Herkes kendi açtığını aldı.`
                    : `**Giriş Ücreti:** ${ucret} ${DL} (kişi başı)  •  **Havuz:** ${havuz} ${DL}  •  <@${kazananId}> **+${havuz}** ${DL} (net ${havuz - ucret >= 0 ? '+' : ''}${havuz - ucret})`
            ].join('\n');

            await goster({
                asama: 'bitti',
                kasalar,
                aktifTur: kasalar.length,
                oyuncular,
                kazanan,
                altYazi: kazanan === -1 ? '🤝 Berabere! Herkes kendi açtığını aldı.' : `🏆 ${kazananIsim} ${sayi(havuz)} DL kazandı!`
            }, bitisMetni);
        } catch (err) {
            // Beklenmeyen hata: ödeme yapılmadıysa alınan giriş ücretlerini geri ver
            if (!odemeYapildi) {
                if (kurucuUcreti > 0) dbManager.addDL(userId, kurucuUcreti);
                if (rakip && rakipUcreti > 0) dbManager.addDL(rakip.id, rakipUcreti);
            }
            throw err;
        } finally {
            // --- ZIRH 4: HER DURUMDA KİLİTLERİ AÇ ---
            aktifOynayanlar.delete(userId);
            if (rakip) aktifOynayanlar.delete(rakip.id);
        }
    }
}

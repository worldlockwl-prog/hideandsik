import {
    ChatInputCommandInteraction,
    EmbedBuilder,
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
import { Command, CommandDeferType } from '../structers/command';
import { dbManager } from '../db/db';
import config2 from './config.json'

const DL = '<:DL:1381246442089349255>';

// ==================================================
// KASA TANIMLARI
// ==================================================
interface KasaItemi {
    ad: string;
    emoji: string;
    deger: number;   // DL karşılığı
    agirlik: number; // çıkma ağırlığı (kasadaki toplam ağırlığa oranı = çıkma şansı)
    seviye: number;  // 0 Yaygın, 1 Nadir, 2 Epik, 3 Efsanevi, 4 Mitik
    renk: string;
}

interface Kasa {
    id: string;
    ad: string;
    emoji: string;
    fiyat: number;
    itemler: KasaItemi[];
    toplamAgirlik: number;
}

// Nadirlik elle girilmiyor: item değerinin kasa fiyatına oranından otomatik çıkıyor.
// (Örn. fiyatının 6 katı eden item her kasada "Efsanevi" sayılır.)
const NADIRLIKLER = [
    { altSinir: 20, renk: '#ff2e4c' }, // Mitik
    { altSinir: 5, renk: '#ffb300' },  // Efsanevi
    { altSinir: 2, renk: '#b14cff' },  // Epik
    { altSinir: 1, renk: '#2f7bff' },  // Nadir
    { altSinir: 0, renk: '#8b8f9c' }   // Yaygın
];

// [ad, emoji, kasa fiyatının kaç katı, ağırlık]
type ItemSatiri = [string, string, number, number];

function kasaOlustur(id: string, ad: string, emoji: string, fiyat: number, satirlar: ItemSatiri[]): Kasa {
    const itemler = satirlar.map(([itemAdi, itemEmoji, carpan, agirlik]): KasaItemi => {
        const nadirlik = NADIRLIKLER.findIndex(n => carpan >= n.altSinir);
        return {
            ad: itemAdi,
            emoji: itemEmoji,
            deger: Math.max(1, Math.round(fiyat * carpan)),
            agirlik,
            seviye: NADIRLIKLER.length - 1 - nadirlik,
            renk: NADIRLIKLER[nadirlik].renk
        };
    });
    return { id, ad, emoji, fiyat, itemler, toplamAgirlik: itemler.reduce((t, i) => t + i.agirlik, 0) };
}

// Ağırlıklar 10.000 üzerinden. RTP = bir kasanın ortalama geri dönüşü (fiyatına oranla).
// Kasa evi kazancını buradan alır: RTP %95 ise uzun vadede açılan her 100 DL'lik kasadan 5 DL kasaya kalır.
const KASALAR: Kasa[] = [
    // RTP ≈ %95.5
    kasaOlustur('caylak', 'Çaylak Kasası', '📦', 10, [
        ['Yaprak', '🍂', 0.2, 4600],
        ['Mantar', '🍄', 0.5, 2600],
        ['Elma', '🍎', 1, 1500],
        ['Anahtar', '🔑', 2, 850],
        ['Para Kesesi', '💰', 6, 350],
        ['Yüzük', '💍', 15, 85],
        ['Taç', '👑', 50, 15]
    ]),
    // RTP ≈ %96.0
    kasaOlustur('bronz', 'Bronz Kasa', '🥉', 25, [
        ['Cıvata', '🔩', 0.2, 4600],
        ['İngiliz Anahtarı', '🔧', 0.5, 2600],
        ['Çekiç', '🔨', 1, 1500],
        ['Yay', '🏹', 2, 850],
        ['Kalkan', '🛡️', 6, 350],
        ['Hançer', '🗡️', 15, 85],
        ['Ejderha', '🐉', 50, 15]
    ]),
    // Düşük riskli kasa: büyük ödül yok ama nadiren boş çıkar. RTP ≈ %94.6
    kasaOlustur('gumus', 'Gümüş Kasa', '🥈', 50, [
        ['Gümüş Madalya', '🥈', 0.4, 4000],
        ['Kolye', '📿', 0.8, 3000],
        ['Saat', '⌚', 1.2, 1800],
        ['Kristal Küre', '🔮', 2, 900],
        ['Antik Vazo', '🏺', 4, 250],
        ['Kayıp Heykel', '🗿', 10, 50]
    ]),
    // RTP ≈ %95.5
    kasaOlustur('altin', 'Altın Kasa', '🥇', 100, [
        ['Altın Madalya', '🥇', 0.2, 4600],
        ['Altın Kese', '💰', 0.5, 2600],
        ['Parşömen', '📜', 1, 1500],
        ['Kupa', '🏆', 2, 850],
        ['Elmas', '💎', 6, 350],
        ['Kral Tacı', '👑', 15, 85],
        ['Yıldız Taşı', '🌟', 50, 15]
    ]),
    // Yüksek riskli kasa: çoğu zaman boş, ama 100x çıkabilir. RTP ≈ %95.7
    kasaOlustur('elmas', 'Elmas Kasa', '💎', 250, [
        ['Kristal Parçası', '🔹', 0.1, 5470],
        ['Mavi Kristal', '💠', 0.4, 2500],
        ['Elmas', '💎', 1, 1100],
        ['Elmas Yüzük', '💍', 3, 600],
        ['Elmas Taç', '👑', 8, 250],
        ['Ejderha Yumurtası', '🥚', 25, 65],
        ['Galaksi Taşı', '🌌', 100, 15]
    ])
];

const KASA_MAP = new Map(KASALAR.map(k => [k.id, k]));

const MAX_KASA = 10;
const KURULUM_SURESI = 90_000;   // kurucu bu süre boyunca hiçbir şeye basmazsa kurulum iptal
const LOBI_SURESI = 120_000;     // bu sürede rakip katılmazsa battle iptal + iade
const SERIT_UZUNLUGU = 40;       // her turda dönen şeritteki kart sayısı
const KAZANAN_INDEX = 34;        // gerçek sonucun şeritte durduğu yer
const KARE_ARASI = 1000;         // dönme kareleri arası bekleme (Discord edit limiti için ~1sn)
const ACILIS_BEKLEMESI = 1600;   // item açıldıktan sonra bir sonraki tura geçmeden önce

// --- ZIRH 1: AYNI ANDA TEK BATTLE (hem kurucu hem rakip için) ---
const aktifOynayanlar = new Set<string>();

function itemCek(kasa: Kasa): KasaItemi {
    // Tower'daki gibi kriptografik üreteç: sonuç V8'in PRNG'sinden tahmin edilemez.
    let r = randomInt(kasa.toplamAgirlik);
    for (const item of kasa.itemler) {
        if (r < item.agirlik) return item;
        r -= item.agirlik;
    }
    return kasa.itemler[kasa.itemler.length - 1];
}

function toplamFiyat(kasalar: Kasa[]): number {
    return kasalar.reduce((t, k) => t + k.fiyat, 0);
}

// Dönen şerit: gerçek sonuç KAZANAN_INDEX'te, geri kalanı aynı kasadan normal oranlarla çekilmiş dolgu.
function seritOlustur(kasa: Kasa, kazanan: KasaItemi): KasaItemi[] {
    const serit = Array.from({ length: SERIT_UZUNLUGU }, () => itemCek(kasa));
    serit[KAZANAN_INDEX] = kazanan;
    return serit;
}

// Her tur için "dönüyor" kareleri: [şeridin konumu, hareket bulanıklığı (px)].
// Çok kasalı battle'larda Discord'un mesaj düzenleme limitine takılmamak ve
// battle'ı uzatmamak için tur başına tek kareye düşüyoruz.
function donmeKareleri(kasaSayisi: number): [number, number][] {
    return kasaSayisi > 5
        ? [[KAZANAN_INDEX - 9, 55]]
        : [[KAZANAN_INDEX - 20, 70], [KAZANAN_INDEX - 5, 28]];
}

// ==================================================
// CANVAS ÇİZİM MOTORU
// ==================================================
const GENISLIK = 1000;
const YUKSEKLIK = 620;
const PANEL_Y = 125;
const PANEL_W = 450;
const PANEL_H = 420;
const PANEL_X: [number, number] = [25, 525];
const OYUNCU_RENKLERI: [string, string] = ['#2469ff', '#ff122a'];

interface OyuncuGorunumu {
    isim: string;
    avatar: Image | null;
    acilanlar: KasaItemi[];
    toplam: number;
}

interface ReelGorunumu {
    serit: KasaItemi[];
    konum: number;      // ortadaki işaretçinin şeritte denk geldiği index (ondalıklı = iki kartın arası)
    bulaniklik: number; // hareket bulanıklığı (px), 0 = durdu
}

interface CizimDurumu {
    asama: 'kurulum' | 'lobi' | 'battle' | 'bitti';
    kasalar: Kasa[];
    aktifTur: number;
    oyuncular: [OyuncuGorunumu, OyuncuGorunumu | null];
    reeller?: [ReelGorunumu, ReelGorunumu];
    kazanan?: 0 | 1 | -1; // -1 = berabere
    altYazi: string;
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

// 25700 -> "25.700"
const sayi = (n: number) => n.toLocaleString('tr-TR');

function kisalt(ctx: CanvasRenderingContext2D, metin: string, maxGenislik: number): string {
    if (ctx.measureText(metin).width <= maxGenislik) return metin;
    let s = metin;
    while (s.length > 0 && ctx.measureText(s + '…').width > maxGenislik) s = s.slice(0, -1);
    return s + '…';
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

function cizEtiket(ctx: CanvasRenderingContext2D, metin: string, cx: number, cy: number, renk: string) {
    ctx.font = 'bold 18px Arial';
    const w = ctx.measureText(metin).width + 40;
    const h = 36;
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

// Efsanevi/Mitik item açılınca kartın arkasında dönen ışık hüzmeleri
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

function cizItemKarti(ctx: CanvasRenderingContext2D, item: KasaItemi, x: number, y: number, w: number, h: number, vurgulu: boolean, degerGoster: boolean = true) {
    neonKutu(ctx, x, y, w, h, 12, vurgulu ? '#1d1f29' : '#16171d', vurgulu ? item.renk : null, 30);

    // Alttan nadirlik rengiyle parlama
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, item.renk + '00');
    g.addColorStop(1, item.renk + (vurgulu ? '99' : '44'));
    yuvarlakYol(ctx, x, y, w, h, 12);
    ctx.fillStyle = g;
    ctx.fill();

    ctx.fillStyle = item.renk;
    ctx.fillRect(x + 12, y + h - 5, w - 24, 3);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.floor(Math.min(h * 0.4, w * 0.55))}px "Segoe UI Emoji", Arial`;
    ctx.fillText(item.emoji, x + w / 2, y + h * 0.4);

    // Dönerken yazı okunmaz, bulanıklık katmanlarında da çirkin iz bırakıyor
    if (!degerGoster) return;
    const metin = `${sayi(item.deger)} DL`;
    let boyut = Math.max(12, Math.floor(h * 0.15));
    ctx.font = `bold ${boyut}px Arial`;
    while (boyut > 9 && ctx.measureText(metin).width > w - 10) ctx.font = `bold ${--boyut}px Arial`;
    ctx.fillStyle = vurgulu ? '#ffffff' : '#c9cbd6';
    ctx.fillText(metin, x + w / 2, y + h * 0.8);
}

function cizReel(ctx: CanvasRenderingContext2D, reel: ReelGorunumu, x: number, y: number, w: number, h: number, oyuncuRengi: string) {
    const kartW = 112;
    const kartH = h - 36;
    const adim = kartW + 10;
    const merkezX = x + w / 2;
    const kartY = y + 18;
    const durdu = reel.bulaniklik === 0;
    const kazananIndex = Math.round(reel.konum);

    ctx.save();
    yuvarlakYol(ctx, x, y, w, h, 16);
    ctx.fillStyle = '#0a0b0f';
    ctx.fill();
    ctx.clip();

    const seridiCiz = (kayma: number, kazananHaric: boolean) => {
        for (let i = 0; i < reel.serit.length; i++) {
            if (kazananHaric && i === kazananIndex) continue;
            const kx = merkezX + (i - reel.konum) * adim - kartW / 2 + kayma;
            if (kx + kartW < x || kx > x + w) continue;
            cizItemKarti(ctx, reel.serit[i], kx, kartY, kartW, kartH, false, durdu);
        }
    };

    if (durdu) {
        const item = reel.serit[kazananIndex];
        const kx = merkezX + (kazananIndex - reel.konum) * adim - kartW / 2;
        if (item.seviye >= 3) cizIsinlar(ctx, kx + kartW / 2, kartY + kartH / 2, w * 0.55, item.renk);
        ctx.globalAlpha = 0.3;
        seridiCiz(0, true);
        ctx.globalAlpha = 1;
        cizItemKarti(ctx, item, kx, kartY, kartW, kartH, true);
    } else {
        // Hareket bulanıklığı: şeridi geldiği yöne (sağa) kaydırarak saydam katmanlarla tekrar tekrar bas
        const katman = 6;
        for (let k = katman - 1; k >= 0; k--) {
            ctx.globalAlpha = k === 0 ? 0.6 : 0.2;
            seridiCiz((k / (katman - 1)) * reel.bulaniklik, false);
        }
        ctx.globalAlpha = 1;
    }

    // Kenarlarda kararma (derinlik)
    const sol = ctx.createLinearGradient(x, 0, x + 90, 0);
    sol.addColorStop(0, '#0a0b0f');
    sol.addColorStop(1, 'rgba(10, 11, 15, 0)');
    ctx.fillStyle = sol;
    ctx.fillRect(x, y, 90, h);
    const sag = ctx.createLinearGradient(x + w - 90, 0, x + w, 0);
    sag.addColorStop(0, 'rgba(10, 11, 15, 0)');
    sag.addColorStop(1, '#0a0b0f');
    ctx.fillStyle = sag;
    ctx.fillRect(x + w - 90, y, 90, h);
    ctx.restore();

    // Ortadaki işaretçi (üst/alt üçgen + dönerken ince çizgi)
    ctx.save();
    ctx.shadowColor = oyuncuRengi;
    ctx.shadowBlur = 15;
    ctx.fillStyle = oyuncuRengi;
    if (!durdu) ctx.fillRect(merkezX - 1.5, y + 10, 3, h - 20);
    ctx.beginPath();
    ctx.moveTo(merkezX - 11, y);
    ctx.lineTo(merkezX + 11, y);
    ctx.lineTo(merkezX, y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(merkezX - 11, y + h);
    ctx.lineTo(merkezX + 11, y + h);
    ctx.lineTo(merkezX, y + h - 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function cizUstSerit(ctx: CanvasRenderingContext2D, d: CizimDurumu) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px Arial';
    ctx.fillStyle = '#e8e9ee';
    const baslik = d.asama === 'battle'
        ? `CASE BATTLE  •  TUR ${d.aktifTur + 1}/${d.kasalar.length}`
        : 'CASE BATTLE';
    ctx.fillText(baslik, GENISLIK / 2, 24);

    const n = d.kasalar.length;
    const kutuW = 78;
    const kutuH = 60;
    const bosluk = 10;
    const kutuY = 48;

    if (n === 0) {
        yuvarlakYol(ctx, GENISLIK / 2 - 200, kutuY, 400, kutuH, 12);
        ctx.setLineDash([10, 8]);
        ctx.strokeStyle = '#3a3d4a';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 18px Arial';
        ctx.fillStyle = '#6b6f7c';
        ctx.fillText('Menüden kasa ekle', GENISLIK / 2, kutuY + kutuH / 2);
        return;
    }

    const toplamW = n * kutuW + (n - 1) * bosluk;
    for (let k = 0; k < n; k++) {
        const kasa = d.kasalar[k];
        const sx = GENISLIK / 2 - toplamW / 2 + k * (kutuW + bosluk);
        const aktif = d.asama === 'battle' && k === d.aktifTur;
        const acildi = (d.asama === 'battle' && k < d.aktifTur) || d.asama === 'bitti';

        ctx.globalAlpha = acildi ? 0.35 : 1;
        neonKutu(ctx, sx, kutuY, kutuW, kutuH, 12, aktif ? '#1d2a4d' : '#16171d', aktif ? '#ffffff' : null, 18);
        if (aktif) {
            yuvarlakYol(ctx, sx, kutuY, kutuW, kutuH, 12);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.font = '26px "Segoe UI Emoji", Arial';
        ctx.fillText(kasa.emoji, sx + kutuW / 2, kutuY + 24);
        ctx.font = 'bold 13px Arial';
        ctx.fillStyle = '#b3b5c4';
        ctx.fillText(`${sayi(kasa.fiyat)} DL`, sx + kutuW / 2, kutuY + 48);
        ctx.globalAlpha = 1;
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
        cizAvatar(ctx, oyuncu, cx, y + 140, 64, renk);
        ctx.font = 'bold 28px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(kisalt(ctx, oyuncu.isim, PANEL_W - 60), cx, y + 245);
        if (d.asama === 'kurulum') cizEtiket(ctx, 'KASALARI SEÇİYOR', cx, y + 305, '#ffb300');
        else cizEtiket(ctx, 'HAZIR', cx, y + 305, '#12ff5e');
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
    ctx.arc(cx, y + 140, 64, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = 'bold 64px Arial';
    ctx.fillStyle = '#3a3d4a';
    ctx.fillText('?', cx, y + 143);

    ctx.font = 'bold 26px Arial';
    ctx.fillStyle = '#8b8f9c';
    ctx.fillText('RAKİP BEKLENİYOR', cx, y + 245);
    ctx.font = '18px Arial';
    ctx.fillStyle = '#5c606d';
    ctx.fillText(d.asama === 'lobi' ? 'Katılmak için ⚔️ Katıl butonuna bas' : 'Battle henüz açılmadı', cx, y + 285);
}

function cizBattlePaneli(ctx: CanvasRenderingContext2D, d: CizimDurumu, index: 0 | 1) {
    const oyuncu = d.oyuncular[index]!;
    const x = PANEL_X[index];
    const y = PANEL_Y;
    const w = PANEL_W;
    const renk = OYUNCU_RENKLERI[index];
    const bitti = d.asama === 'bitti';
    const kazandi = bitti && d.kazanan === index;
    const kaybetti = bitti && d.kazanan !== -1 && d.kazanan !== index;

    neonKutu(ctx, x, y, w, PANEL_H, 22, '#111218', kazandi ? '#ffd700' : renk, kazandi ? 45 : 18);
    if (kazandi) {
        yuvarlakYol(ctx, x, y, w, PANEL_H, 22);
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    // Başlık: avatar + isim + toplam değer
    cizAvatar(ctx, oyuncu, x + 46, y + 46, 26, renk);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(kisalt(ctx, oyuncu.isim, 190), x + 84, y + 46);

    ctx.textAlign = 'right';
    ctx.font = 'bold 30px Arial';
    ctx.fillStyle = '#ffd700';
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 12;
    ctx.fillText(`${sayi(oyuncu.toplam)} DL`, x + w - 22, y + 46);
    ctx.shadowBlur = 0;

    // Orta alan: dönen şerit ya da (bitince) büyük toplam
    const rx = x + 15;
    const ry = y + 84;
    const rw = w - 30;
    const rh = 168;
    if (!bitti && d.reeller) {
        cizReel(ctx, d.reeller[index], rx, ry, rw, rh, renk);
    } else {
        ctx.save();
        yuvarlakYol(ctx, rx, ry, rw, rh, 16);
        ctx.fillStyle = '#0a0b0f';
        ctx.fill();
        ctx.clip();
        if (kazandi) cizIsinlar(ctx, rx + rw / 2, ry + rh / 2, rw * 0.6, '#ffd700', 0.45);
        ctx.textAlign = 'center';
        ctx.font = 'bold 60px "Arial Black", Arial';
        ctx.fillStyle = kazandi ? '#ffd700' : (kaybetti ? '#6b6f7c' : '#ffffff');
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = kazandi ? 30 : 0;
        ctx.fillText(`${sayi(oyuncu.toplam)} DL`, rx + rw / 2, ry + rh / 2 - 10);
        ctx.shadowBlur = 0;
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#8b8f9c';
        ctx.fillText('TOPLAM DEĞER', rx + rw / 2, ry + rh - 26);
        ctx.restore();
    }

    // Açılan itemler (5'li sıralar). Henüz açılmamış kasalar soluk yer tutucu olarak görünür.
    // Tek sıra varsa kartlar büyüyor ki panelin altı boş kalmasın.
    const satirSayisi = Math.ceil(d.kasalar.length / 5);
    const chipW = (w - 30 - 4 * 8) / 5;
    const chipH = satirSayisi === 1 ? 110 : 64;
    const alanH = PANEL_H - 268 - 15;
    const chipY = y + 268 + (alanH - (satirSayisi * chipH + (satirSayisi - 1) * 8)) / 2;
    for (let k = 0; k < d.kasalar.length; k++) {
        const sx = x + 15 + (k % 5) * (chipW + 8);
        const sy = chipY + Math.floor(k / 5) * (chipH + 8);
        const item = oyuncu.acilanlar[k];
        if (item) {
            cizItemKarti(ctx, item, sx, sy, chipW, chipH, false);
        } else {
            yuvarlakYol(ctx, sx, sy, chipW, chipH, 12);
            ctx.setLineDash([6, 6]);
            ctx.strokeStyle = '#2a2c36';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 0.25;
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ffffff';
            ctx.font = '26px "Segoe UI Emoji", Arial';
            ctx.fillText(d.kasalar[k].emoji, sx + chipW / 2, sy + chipH / 2);
            ctx.globalAlpha = 1;
        }
    }

    if (kaybetti) {
        yuvarlakYol(ctx, x, y, w, PANEL_H, 22);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fill();
    }
    if (bitti) {
        const etiket = kazandi ? '🏆 KAZANDI' : (kaybetti ? 'KAYBETTİ' : '🤝 BERABERE');
        cizEtiket(ctx, etiket, x + w / 2, y, kazandi ? '#ffd700' : (kaybetti ? '#ff122a' : '#b3b5c4'));
    }
}

function cizVs(ctx: CanvasRenderingContext2D) {
    const cx = GENISLIK / 2;
    const cy = PANEL_Y + PANEL_H / 2;
    ctx.save();
    const g = ctx.createLinearGradient(cx - 40, cy - 40, cx + 40, cy + 40);
    g.addColorStop(0, OYUNCU_RENKLERI[0]);
    g.addColorStop(1, OYUNCU_RENKLERI[1]);
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 25;
    ctx.beginPath();
    ctx.arc(cx, cy, 38, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(cx, cy, 31, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0c10';
    ctx.fill();
    ctx.font = 'bold 26px "Arial Black", Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VS', cx, cy + 1);
    ctx.restore();
}

function cizAltYazi(ctx: CanvasRenderingContext2D, metin: string, renk: string) {
    neonKutu(ctx, 150, 560, 700, 46, 23, 'rgba(0, 0, 0, 0.6)', null);
    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = renk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kisalt(ctx, metin, 660), GENISLIK / 2, 584);
}

function battleCiz(d: CizimDurumu): AttachmentBuilder {
    const canvas = createCanvas(GENISLIK, YUKSEKLIK);
    const ctx = canvas.getContext('2d');

    cizArkaPlan(ctx);
    cizUstSerit(ctx, d);
    for (const index of [0, 1] as const) {
        if (d.asama === 'battle' || d.asama === 'bitti') cizBattlePaneli(ctx, d, index);
        else cizBeklemePaneli(ctx, d, index);
    }
    cizVs(ctx);
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
type Bilesenler = ActionRowBuilder<MessageActionRowComponentBuilder>[];

function mesajHazirla(d: CizimDurumu, embed: EmbedBuilder, components: Bilesenler) {
    const resim = battleCiz(d);
    embed.setImage(`attachment://${resim.name}`);
    return { content: '', embeds: [embed], files: [resim], components };
}

function iptalMesaji(metin: string) {
    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('⚔️ Case Battle')
        .setDescription(metin);
    return { content: '', embeds: [embed], files: [], components: [] };
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

function kurulumBilesenleri(kasaSayisi: number): Bilesenler {
    const dolu = kasaSayisi >= MAX_KASA;
    const menu = new StringSelectMenuBuilder()
        .setCustomId('vs_kasa_ekle')
        .setPlaceholder(dolu ? `En fazla ${MAX_KASA} kasa eklenebilir` : '➕ Kasa ekle')
        .setDisabled(dolu)
        .addOptions(KASALAR.map(k => {
            const enIyi = k.itemler[k.itemler.length - 1];
            return {
                label: `${k.ad} — ${k.fiyat} DL`,
                value: k.id,
                emoji: k.emoji,
                description: `En büyük ödül: ${enIyi.ad} (${enIyi.deger} DL)`
            };
        }));

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

function kurulumEmbed(kasalar: Kasa[]): EmbedBuilder {
    return new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('⚔️ Case Battle — Kurulum')
        .setDescription('Menüden kasa ekle, hazır olunca **Battle Aç**\'a bas.\nİki oyuncu da aynı kasaları açar, **toplam değeri yüksek olan her şeyi alır!**')
        .addFields(
            { name: 'Kasalar', value: kasaOzeti(kasalar) },
            { name: 'Kasa Sayısı', value: `${kasalar.length}/${MAX_KASA}`, inline: true },
            { name: 'Giriş Ücreti', value: `${toplamFiyat(kasalar)} ${DL}`, inline: true }
        );
}

function lobiEmbed(kurucuId: string, kasalar: Kasa[], ucret: number, bitis: number): EmbedBuilder {
    return new EmbedBuilder()
        .setColor('#2469ff')
        .setTitle('⚔️ Case Battle Açıldı!')
        .setDescription(`<@${kurucuId}> bir battle açtı! Aynı ücreti yatırıp **⚔️ Katıl**'a basan ilk kişi rakibi olur.\nToplam değeri yüksek olan **iki tarafın açtığı her şeyi** alır.`)
        .addFields(
            { name: 'Kasalar', value: kasaOzeti(kasalar) },
            { name: 'Giriş Ücreti', value: `${ucret} ${DL}`, inline: true },
            { name: 'Kapanış', value: `<t:${Math.floor(bitis / 1000)}:R>`, inline: true }
        );
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
            const kurulumEkrani = () => mesajHazirla(bekleyenEkran('kurulum'), kurulumEmbed(kasalar), kurulumBilesenleri(kasalar.length));

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
                }
            }

            // ==================================================
            // 2) LOBİ: herkes görebilir, ilk geçerli "Katıl" rakip olur
            // ==================================================
            const ucret = kurucuUcreti;
            const lobiBitis = Date.now() + LOBI_SURESI;
            await gameMessage.edit(mesajHazirla(bekleyenEkran('lobi'), lobiEmbed(userId, kasalar, ucret, lobiBitis), lobiBilesenleri(ucret)));

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
            // 4) ANİMASYON
            // ==================================================
            const rakipGorunumu: OyuncuGorunumu = {
                isim: rakip.displayName,
                avatar: await avatarYukle(rakip),
                acilanlar: [],
                toplam: 0
            };
            const oyuncular: [OyuncuGorunumu, OyuncuGorunumu] = [kurucu, rakipGorunumu];
            const rakipId = rakip.id;

            const goster = async (d: CizimDurumu, embed: EmbedBuilder): Promise<boolean> => {
                try {
                    await gameMessage.edit(mesajHazirla(d, embed, []));
                    return true;
                } catch {
                    return false; // mesaj silindiyse animasyonu bırak, ödeme zaten yapıldı
                }
            };

            animasyon:
            for (let tur = 0; tur < kasalar.length; tur++) {
                const kasa = kasalar[tur];
                const seritler = [seritOlustur(kasa, sonuclar[tur][0]), seritOlustur(kasa, sonuclar[tur][1])];
                const turEmbed = () => new EmbedBuilder()
                    .setColor('#2b2d31')
                    .setTitle(`⚔️ Tur ${tur + 1}/${kasalar.length} — ${kasa.emoji} ${kasa.ad}`)
                    .setDescription(`<@${userId}> **vs** <@${rakipId}>`);
                const turEkrani = (konumlar: [number, number], bulaniklik: number): CizimDurumu => ({
                    asama: 'battle',
                    kasalar,
                    aktifTur: tur,
                    oyuncular,
                    reeller: [
                        { serit: seritler[0], konum: konumlar[0], bulaniklik },
                        { serit: seritler[1], konum: konumlar[1], bulaniklik }
                    ],
                    altYazi: `Havuz: ${sayi(oyuncular[0].toplam + oyuncular[1].toplam)} DL`
                });

                for (const [konum, bulaniklik] of donmeKareleri(kasalar.length)) {
                    // İki şerit birebir aynı hizada durmasın diye küçük bir kayma (sadece görsel)
                    if (!await goster(turEkrani([konum + Math.random(), konum + Math.random()], bulaniklik), turEmbed())) break animasyon;
                    await bekle(KARE_ARASI);
                }

                for (const o of [0, 1] as const) {
                    oyuncular[o].acilanlar.push(sonuclar[tur][o]);
                    oyuncular[o].toplam += sonuclar[tur][o].deger;
                }
                // Gerçek çarklardaki gibi kartın tam ortasında değil, kartın içinde rastgele bir yerde dur
                const durus = () => KAZANAN_INDEX + (Math.random() - 0.5) * 0.6;
                if (!await goster(turEkrani([durus(), durus()], 0), turEmbed())) break animasyon;
                await bekle(ACILIS_BEKLEMESI);
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
            const bitisEmbed = new EmbedBuilder()
                .setColor(kazanan === -1 ? '#b3b5c4' : '#ffd700')
                .setTitle(kazanan === -1 ? '🤝 Berabere!' : `🏆 ${kazananIsim} kazandı!`)
                .setDescription(`<@${userId}> **${toplamlar[0]}** ${DL}  vs  <@${rakipId}> **${toplamlar[1]}** ${DL}`)
                .addFields(
                    { name: 'Giriş Ücreti', value: `${ucret} ${DL} (kişi başı)`, inline: true },
                    { name: 'Havuz', value: `${havuz} ${DL}`, inline: true },
                    kazanan === -1
                        ? { name: 'Sonuç', value: 'Herkes kendi açtığını aldı.', inline: true }
                        : { name: 'Kazanç', value: `<@${kazananId}> **+${havuz}** ${DL} (net ${havuz - ucret >= 0 ? '+' : ''}${havuz - ucret})`, inline: true }
                );

            await goster({
                asama: 'bitti',
                kasalar,
                aktifTur: kasalar.length,
                oyuncular,
                kazanan,
                altYazi: kazanan === -1 ? '🤝 Berabere! Herkes kendi açtığını aldı.' : `🏆 ${kazananIsim} ${sayi(havuz)} DL kazandı!`
            }, bitisEmbed);
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

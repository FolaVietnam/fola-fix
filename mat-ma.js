// Mã hoá hai đầu DevDesk (spec §3.1). Dùng chung cho trình duyệt và Core (Node 24, WebCrypto).
// P-256 ECDH (thoả thuận khoá) + ECDSA (chữ ký) · HKDF-SHA256 · AES-256-GCM.
// Trên S3 / Apps Script chỉ còn gói đã mã hoá; sửa 1 byte ⇒ giải mã hoặc kiểm chữ ký thất bại.

const sub = globalThis.crypto.subtle;
const ma = new TextEncoder();
const giai = new TextDecoder();

export const PHIEN_BAN = 1;
export const KHUC = 8 * 1024 * 1024; // tệp đính kèm chia khúc 8 MB

export function b64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function tuB64(s) {
  const t = atob(s);
  const u = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i);
  return u;
}
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const ngauNhien = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const KY = { name: 'ECDSA', hash: 'SHA-256' };

/** Cặp khoá của một bên. Trình duyệt: riêng tư KHÔNG xuất được (extractable=false). */
export async function taoBoKhoa(xuatDuoc = false) {
  const thoaThuan = await sub.generateKey(ECDH, xuatDuoc, ['deriveBits']);
  const ky = await sub.generateKey(ECDSA, xuatDuoc, ['sign', 'verify']);
  return { thoaThuan, ky };
}

export async function congKhai(boKhoa) {
  return {
    ecdh: b64(await sub.exportKey('raw', boKhoa.thoaThuan.publicKey)),
    ecdsa: b64(await sub.exportKey('raw', boKhoa.ky.publicKey)),
  };
}

export async function nhapCongKhai(ck) {
  return {
    ecdh: await sub.importKey('raw', tuB64(ck.ecdh), ECDH, true, []),
    ecdsa: await sub.importKey('raw', tuB64(ck.ecdsa), ECDSA, true, ['verify']),
  };
}

/** Mã thiết bị = 16 byte đầu SHA-256(khoá ký công khai), dạng hex. */
export async function maThietBi(ck) {
  return hex(await sub.digest('SHA-256', tuB64(ck.ecdsa))).slice(0, 32);
}

export async function xuatJwk(boKhoa) {
  return {
    thoaThuan: { rieng: await sub.exportKey('jwk', boKhoa.thoaThuan.privateKey), cong: await sub.exportKey('jwk', boKhoa.thoaThuan.publicKey) },
    ky: { rieng: await sub.exportKey('jwk', boKhoa.ky.privateKey), cong: await sub.exportKey('jwk', boKhoa.ky.publicKey) },
  };
}

export async function nhapJwk(j) {
  return {
    thoaThuan: { privateKey: await sub.importKey('jwk', j.thoaThuan.rieng, ECDH, false, ['deriveBits']), publicKey: await sub.importKey('jwk', j.thoaThuan.cong, ECDH, true, []) },
    ky: { privateKey: await sub.importKey('jwk', j.ky.rieng, ECDSA, false, ['sign']), publicKey: await sub.importKey('jwk', j.ky.cong, ECDSA, true, ['verify']) },
  };
}

async function khoaGoi(rieng, cong, info) {
  const bi = await sub.deriveBits({ name: 'ECDH', public: cong }, rieng, 256);
  const goc = await sub.importKey('raw', bi, 'HKDF', false, ['deriveKey']);
  return sub.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: ma.encode('fola-devdesk-v1'), info: ma.encode(info) }, goc, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const chuoiKy = (g) => `${g.v}|${g.tu}|${g.den}|${g.luc}|${g.id}|${g.epk}|${g.iv}|${g.ct}`;

/**
 * Đóng gói: mã hoá `noiDung` (đối tượng JSON) cho người nhận, ký bằng khoá người gửi.
 * tu/den: mã thiết bị hoặc 'core'.
 */
export async function dongGoi(noiDung, { tu, den, khoaKyRieng, congNhan }) {
  const tam = await sub.generateKey(ECDH, true, ['deriveBits']);
  const g = { v: PHIEN_BAN, tu, den, luc: new Date().toISOString(), id: hex(ngauNhien(16)) };
  g.epk = b64(await sub.exportKey('raw', tam.publicKey));
  const khoa = await khoaGoi(tam.privateKey, congNhan, `${g.tu}|${g.den}|${g.id}`);
  const iv = ngauNhien(12);
  g.iv = b64(iv);
  const aad = ma.encode(`${g.v}|${g.tu}|${g.den}|${g.luc}|${g.id}`);
  g.ct = b64(await sub.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, khoa, ma.encode(JSON.stringify(noiDung))));
  g.ky = b64(await sub.sign(KY, khoaKyRieng, ma.encode(chuoiKy(g))));
  return ma.encode(JSON.stringify(g));
}

/** Đọc phần vỏ (chưa giải mã) để biết ai gửi. */
export function docVo(bytes) {
  const g = JSON.parse(giai.decode(bytes));
  if (g.v !== PHIEN_BAN || !g.tu || !g.den || !g.id || !g.luc) throw new Error('goi sai dinh dang');
  return g;
}

/** Mở gói: kiểm chữ ký (nếu có khoá công khai người gửi) rồi giải mã. Sai ⇒ ném lỗi. */
export async function moGoi(bytes, { khoaThoaThuanRieng, congKyGui }) {
  const g = docVo(bytes);
  if (congKyGui) {
    const dung = await sub.verify(KY, congKyGui, tuB64(g.ky), ma.encode(chuoiKy(g)));
    if (!dung) throw new Error('chu ky sai');
  }
  const tam = await sub.importKey('raw', tuB64(g.epk), ECDH, false, []);
  const khoa = await khoaGoi(khoaThoaThuanRieng, tam, `${g.tu}|${g.den}|${g.id}`);
  const aad = ma.encode(`${g.v}|${g.tu}|${g.den}|${g.luc}|${g.id}`);
  const ro = await sub.decrypt({ name: 'AES-GCM', iv: tuB64(g.iv), additionalData: aad }, khoa, tuB64(g.ct));
  return { vo: g, noiDung: JSON.parse(giai.decode(ro)) };
}

/** Kiểm chữ ký sau khi đã biết khoá người gửi từ chính nội dung (gói đăng nhập). */
export async function kiemKy(bytes, congKyGui) {
  const g = docVo(bytes);
  return sub.verify(KY, congKyGui, tuB64(g.ky), ma.encode(chuoiKy(g)));
}

// ── Tệp đính kèm: khoá riêng mỗi tệp, mã hoá từng khúc ──
export async function taoKhoaTep() {
  const k = ngauNhien(32);
  return { khoa: b64(k), tienTo: b64(ngauNhien(8)) };
}

async function khoaAes(khoaB64, dung) {
  return sub.importKey('raw', tuB64(khoaB64), 'AES-GCM', false, [dung]);
}

function ivKhuc(tienTo, i) {
  const iv = new Uint8Array(12);
  iv.set(tuB64(tienTo), 0);
  new DataView(iv.buffer).setUint32(8, i);
  return iv;
}

export async function maKhuc(khoaTep, i, tong, maTep, du) {
  const k = await khoaAes(khoaTep.khoa, 'encrypt');
  return new Uint8Array(await sub.encrypt({ name: 'AES-GCM', iv: ivKhuc(khoaTep.tienTo, i), additionalData: ma.encode(`${maTep}|${i}|${tong}`) }, k, du));
}

export async function giaiKhuc(khoaTep, i, tong, maTep, du) {
  const k = await khoaAes(khoaTep.khoa, 'decrypt');
  return new Uint8Array(await sub.decrypt({ name: 'AES-GCM', iv: ivKhuc(khoaTep.tienTo, i), additionalData: ma.encode(`${maTep}|${i}|${tong}`) }, k, du));
}

export async function sha256Hex(du) {
  return hex(await sub.digest('SHA-256', du));
}

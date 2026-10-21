// Chế độ từ xa (điện thoại): nói chuyện với máy build qua hộp thư S3 + Apps Script FolaFix (spec §3.1).
// Mọi nội dung mã hoá ngay trên máy này; khoá riêng của thiết bị không xuất ra được, nằm trong IndexedDB.
import { congKhai, dongGoi, hex, KHUC, maKhuc, maThietBi, moGoi, ngauNhien, nhapCongKhai, taoBoKhoa, taoKhoaTep } from './mat-ma.js';

let CH = null;      // cấu hình: { apps_script, core: { ecdh, ecdsa } }
let CORE = null;    // khoá công khai Core đã nhập
let boKhoa = null;  // khoá thiết bị
let tbId = '';
let ck = null;

// ── IndexedDB tối giản ──
const moKho = () => new Promise((ok, hong) => {
  const r = indexedDB.open('fola-devdesk', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => hong(r.error);
});
async function doc(k) {
  const db = await moKho();
  return new Promise((ok, hong) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => hong(r.error); });
}
async function ghi(k, v) {
  const db = await moKho();
  return new Promise((ok, hong) => { const t = db.transaction('kv', 'readwrite'); v === undefined ? t.objectStore('kv').delete(k) : t.objectStore('kv').put(v, k); t.oncomplete = () => ok(); t.onerror = () => hong(t.error); });
}

export async function khoiDong(cauHinh) {
  CH = cauHinh;
  CORE = await nhapCongKhai(CH.core);
  boKhoa = await doc('bo-khoa');
  if (!boKhoa) {
    boKhoa = await taoBoKhoa(false); // khoá riêng KHÔNG xuất được
    await ghi('bo-khoa', boKhoa);
  }
  ck = await congKhai(boKhoa);
  tbId = await maThietBi(ck);
  return { thietBi: tbId, phien: await doc('phien'), dnCho: await doc('dn-cho') };
}

async function appsScript(b) {
  const r = await fetch(CH.apps_script, { method: 'POST', body: JSON.stringify(b) }); // text/plain ⇒ không preflight
  const j = await r.json();
  if (j.loi) throw Object.assign(new Error(j.loi === 'token' ? 'Phiên đăng nhập hết hạn' : 'Máy chủ trung gian lỗi: ' + j.loi), { ma: j.loi });
  return j;
}

const dong = (nd) => dongGoi(nd, { tu: tbId, den: 'core', khoaKyRieng: boKhoa.ky.privateKey, congNhan: CORE.ecdh });
const mo = async (du) => (await moGoi(du, { khoaThoaThuanRieng: boKhoa.thoaThuan.privateKey, congKyGui: CORE.ecdsa })).noiDung;

async function put(url, du) {
  const r = await fetch(url, { method: 'PUT', body: du, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!r.ok) throw new Error('Tải lên thất bại (' + r.status + ')');
}

// ── Đăng nhập ──
export async function dangNhap(ten, ma, huy) {
  const h = await appsScript({ lenh: 'dn-mo' });
  const goi = await dong({ loai: 'dang-nhap', ten, ma, thiet_bi: ck, ten_may: tenMay() });
  await put(h.put, goi);
  await ghi('dn-cho', { get: h.get, luc: Date.now() });
  return choTraLoiDangNhap(huy);
}

/** Chờ máy build trả lời (máy build hỏi hộp thư mỗi 3 giây; thiết bị mới chờ Admin duyệt). */
export async function choTraLoiDangNhap(huy = { dung: false }) {
  const cho = await doc('dn-cho');
  if (!cho) return null;
  const batDau = Date.now();
  for (;;) {
    if (huy.dung) return null;
    if (Date.now() - cho.luc > 86400_000) { await ghi('dn-cho'); throw new Error('Hết thời gian chờ — đăng nhập lại'); }
    const r = await fetch(cho.get + '&_=' + Date.now(), { cache: 'no-store' }).catch(() => null);
    if (r?.ok) {
      const tl = await mo(new Uint8Array(await r.arrayBuffer()));
      if (tl.ket_qua === 'ok') {
        await ghi('dn-cho');
        const phien = { token: tl.token, het: tl.het, nguoi: tl.nguoi };
        await ghi('phien', phien);
        return { ket_qua: 'ok', phien };
      }
      if (tl.ket_qua === 'sai') { await ghi('dn-cho'); return tl; }
      huy.choDuyet?.();
    }
    await new Promise((ok) => setTimeout(ok, Date.now() - batDau < 60_000 ? 2000 : 8000));
  }
}

export async function dangXuat() {
  await ghi('phien');
  await ghi('dn-cho');
  await ghi('trang-thai');
  nhanUrl = null;
}

// ── Gửi phiếu ──
export async function guiPhieu(duLieu, tep, tienDo = () => {}) {
  const phien = await doc('phien');
  const ten = [];
  const soKhuc = tep.map((f) => Math.max(1, Math.ceil(f.size / KHUC)));
  tep.forEach((_, i) => { for (let k = 0; k < soKhuc[i]; k++) ten.push(`${i}-${k}`); });
  ten.push('m');
  const { gid, url } = await appsScript({ lenh: 'gui', token: phien.token, ten });
  const tong = tep.reduce((s, f) => s + f.size, 0) || 1;
  let da = 0;
  const moTa = [];
  for (let i = 0; i < tep.length; i++) {
    const f = tep[i];
    const kt = await taoKhoaTep();
    for (let k = 0; k < soKhuc[i]; k++) {
      const ro = new Uint8Array(await f.slice(k * KHUC, (k + 1) * KHUC).arrayBuffer());
      await put(url[`${i}-${k}`], await maKhuc(kt, k, soKhuc[i], `${tbId}/${gid}/${i}`, ro));
      da += ro.length;
      tienDo(da / tong);
    }
    moTa.push({ ten_goc: f.name, mime: f.type || 'application/octet-stream', byte: f.size, ...kt });
  }
  await put(url.m, await dong({ loai: 'phieu', du_lieu: duLieu, tep: moTa })); // gói chính tải lên CUỐI
  tienDo(1);
  return gid;
}

// ── Nhận trạng thái ──
let nhanUrl = null;
export async function docTrangThai() {
  const phien = await doc('phien');
  if (!phien) return null;
  if (!nhanUrl || nhanUrl.het < Date.now() + 60_000) {
    const n = await appsScript({ lenh: 'nhan', token: phien.token });
    nhanUrl = { url: n.url, het: Math.min(n.het, Date.now() + 11 * 3600_000) };
  }
  const r = await fetch(nhanUrl.url + '&_=' + Date.now(), { cache: 'no-store' });
  if (r.status === 404) return (await doc('trang-thai')) ?? null;
  if (!r.ok) throw new Error('Không đọc được trạng thái (' + r.status + ')');
  const tt = await mo(new Uint8Array(await r.arrayBuffer()));
  if (tt.token_moi?.token && tt.token_moi.het > phien.het) {
    await ghi('phien', { ...phien, token: tt.token_moi.token, het: tt.token_moi.het, nguoi: tt.token_moi.nguoi ?? phien.nguoi });
    nhanUrl = null;
  } else if (phien.het - Date.now() < 3 * 3600_000 && !phien.daXinLamMoi) {
    // Token sắp hết mà chưa có token mới ⇒ xin máy build cấp lại.
    const { url } = await appsScript({ lenh: 'gui', token: phien.token, ten: ['m'] });
    await put(url.m, await dong({ loai: 'lam-moi' }));
    await ghi('phien', { ...phien, daXinLamMoi: true });
  }
  await ghi('trang-thai', tt);
  return tt;
}

function tenMay() {
  const ua = navigator.userAgent;
  const hdh = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Thiết bị';
  const tr = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return `${hdh} ${tr} · ${hex(ngauNhien(2))}`.trim();
}

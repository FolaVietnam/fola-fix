// Fola DevDesk — webapp giai đoạn (a). Không thư viện, không bước build.
const $ = (s, g = document) => g.querySelector(s);
const $$ = (s, g = document) => [...g.querySelectorAll(s)];

const TOI_THIEU = 15;
const DUOI_AM_THANH = /\.(mp3|m4a|ogg|oga|opus|wav|aac|amr|flac)$/i;
const TEN_APP = { capture: 'FolaCapture', booth: 'Fola.Booth', quay: 'Quầy', webapp: 'Webapp', trinh_cai: 'Trình cài', khac: 'Khác' };
const TEN_LOAI = { bug: 'Lỗi', feature: 'Tính năng', hotfix: 'Hotfix' };
const TEN_UT = { 1: 'Khẩn', 2: 'Cao', 3: 'Thường', 4: 'Thấp' };
const TEN_TT = { MOI: 'Mới', DANG_XEM: 'Đang xem', CO_BAN_SUA: 'Có bản sửa', CHO_DUYET: 'Chờ duyệt', DA_DUNG: 'Đã dựng', DA_RA_SOAT: 'Đã ra soát', CHO_KY: 'Chờ ký', DA_PHAT_HANH: 'Đã phát hành', DONG: 'Đóng' };

let tepChon = [];
let gioiHan = null;
let phieuDangXem = null;
let suaId = null;       // đang sửa phiếu nào (CEO 22/10: người gửi sửa 1 lần khi phiếu còn Mới)

// Tại máy build ⇒ gọi thẳng Core. Nơi khác (GitHub Pages / fix.fola.vn) ⇒ đi qua hộp thư S3 đã mã hoá.
const TAI_CHO = ['127.0.0.1', 'localhost'].includes(location.hostname);
let ht = null;          // mô-đun hộp thư (chỉ nạp khi ở xa)
let trangThai = null;   // ảnh chụp trạng thái mới nhất từ máy build
const choKetQua = new Map(); // gid → thời điểm gửi

// ── Chuyển màn ──
function moMan(ten) {
  for (const m of $$('.man')) m.hidden = m.id !== `man-${ten}`;
  for (const t of $$('.tab')) t.toggleAttribute('aria-current', t.dataset.man === ten || (ten === 'ct' && t.dataset.man === 'ds'));
  if (ten === 'ds') taiDanhSach();
  if (ten !== 'ct') phieuDangXem = null;
}
for (const b of $$('[data-man]')) b.addEventListener('click', () => moMan(b.dataset.man));

// ── Nút chọn ──
for (const nhom of $$('.nut-chon')) {
  nhom.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $$('button', nhom)) x.classList.toggle('chon', x === b);
    if (nhom.dataset.ten === 'loai') doiLoai(b.dataset.v);
    xoaLoi(nhom.dataset.ten);
  });
}
const giaTriChon = (ten) => $(`.nut-chon[data-ten="${ten}"] .chon`)?.dataset.v ?? '';

function doiLoai(loai) {
  const tn = loai === 'feature';
  $('.o-loi').hidden = tn;
  $('.o-tinh-nang').hidden = !tn;
}

// ── Lỗi theo ô ──
function datLoi(ten, chu) {
  const p = $(`[data-loi="${ten}"]`);
  if (p) p.textContent = chu || '';
  const o = $(`[name="${ten}"]`);
  o?.classList.toggle('sai', !!chu);
}
function xoaLoi(ten) { datLoi(ten, ''); }
for (const o of $$('input[name], textarea[name]')) o.addEventListener('input', () => xoaLoi(o.name));

function kiemTruocKhiGui() {
  const loi = {};
  const loai = giaTriChon('loai');
  if (!giaTriChon('app_dich')) loi.app_dich = 'Chọn ứng dụng';
  if ($('#tieu_de').value.trim().length < 5) loi.tieu_de = 'Tiêu đề ít nhất 5 ký tự';
  const o = loai === 'feature' ? ['can_gi', 'giup_khach'] : ['dang_lam', 'thay_gi', 'mong_muon'];
  for (const k of o) if ($(`[name="${k}"]`).value.trim().length < TOI_THIEU) loi[k] = 'Mô tả thêm giúp Claude hiểu';
  const mid = $('[name="machine_id"]').value.trim();
  if (mid && !/^[0-9a-fA-F]{8}$/.test(mid)) loi.machine_id = 'Mã máy gồm 8 ký tự 0-9, a-f';
  return loi;
}

// ── Tệp ──
const tha = $('#tha');
const chonTep = $('#chon-tep');
tha.addEventListener('click', () => chonTep.click());
tha.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chonTep.click(); } });
chonTep.addEventListener('change', () => { themTep([...chonTep.files]); chonTep.value = ''; });
for (const ev of ['dragenter', 'dragover']) tha.addEventListener(ev, (e) => { e.preventDefault(); tha.classList.add('dang-tha'); });
for (const ev of ['dragleave', 'drop']) tha.addEventListener(ev, (e) => { e.preventDefault(); tha.classList.remove('dang-tha'); });
tha.addEventListener('drop', (e) => themTep([...e.dataTransfer.files]));
document.addEventListener('paste', (e) => {
  const anh = [...(e.clipboardData?.files ?? [])];
  if (anh.length && !$('#man-gui').hidden) themTep(anh);
});

function loaiTep(f) {
  if (f.type.startsWith('audio/') || DUOI_AM_THANH.test(f.name)) return 'am_thanh';
  if (f.type.startsWith('image/')) return 'anh';
  if (f.type.startsWith('video/')) return 'video';
  if (/\.log$/i.test(f.name)) return 'log';
  return 'tai_lieu';
}

function themTep(ds) {
  const bo = [];
  for (const f of ds) {
    const loai = loaiTep(f);
    if (loai === 'am_thanh') { bo.push(`${f.name}: không nhận ghi âm — gõ mô tả bằng chữ`); continue; }
    const tran = gioiHan?.[loai];
    if (tran && f.size > tran) { bo.push(`${f.name}: quá ${Math.round(tran / 1048576)} MB`); continue; }
    if (tepChon.length >= (gioiHan?.so_tep_moi_phieu ?? 20)) { bo.push(`${f.name}: tối đa ${gioiHan?.so_tep_moi_phieu ?? 20} tệp`); continue; }
    if (tepChon.some((t) => t.name === f.name && t.size === f.size)) continue;
    tepChon.push(f);
  }
  $('#loi-tep').textContent = bo.join(' · ');
  veTep();
}

function veTep() {
  const ul = $('#ds-tep');
  ul.replaceChildren(...tepChon.map((f, i) => {
    const li = document.createElement('li');
    const loai = loaiTep(f);
    if (loai === 'anh') {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      img.onload = () => URL.revokeObjectURL(img.src);
      li.append(img);
    } else {
      const s = document.createElement('span');
      s.className = 'bieu-tuong';
      s.textContent = loai === 'video' ? '▶' : loai === 'log' ? 'LOG' : 'TL';
      li.append(s);
    }
    const ten = document.createElement('span');
    ten.className = 'ten-tep';
    ten.textContent = `${f.name} · ${coTep(f.size)}`;
    const xoa = document.createElement('button');
    xoa.type = 'button';
    xoa.className = 'xoa';
    xoa.setAttribute('aria-label', 'Bỏ tệp');
    xoa.textContent = '×';
    xoa.onclick = () => { tepChon.splice(i, 1); veTep(); };
    li.append(ten, xoa);
    return li;
  }));
}

const coTep = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// ── Gửi ──
$('#f').addEventListener('submit', (e) => {
  e.preventDefault();
  for (const p of $$('[data-loi]')) p.textContent = '';
  const loi = kiemTruocKhiGui();
  if (Object.keys(loi).length) {
    for (const [k, v] of Object.entries(loi)) datLoi(k, v);
    $(`[data-loi="${Object.keys(loi)[0]}"]`)?.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const fd = new FormData();
  fd.append('loai', giaTriChon('loai'));
  fd.append('app_dich', giaTriChon('app_dich'));
  fd.append('uu_tien', giaTriChon('uu_tien') || '3');
  for (const o of $$('#f input[name], #f textarea[name]')) {
    if (o.closest('[hidden]')) continue;
    if (o.value.trim()) fd.append(o.name, o.value.trim());
  }
  for (const f of tepChon) fd.append('tep', f, f.name);
  if (suaId != null) fd.append('sua', String(suaId));

  const nut = $('#nut-gui');
  const td = $('#tien-do');
  nut.disabled = true;
  td.hidden = false;
  td.firstElementChild.style.width = '0%';
  if (!TAI_CHO) return guiQuaHopThu(fd, nut, td);
  const x = new XMLHttpRequest();
  x.open('POST', '/api/phieu');
  x.upload.onprogress = (ev) => { if (ev.lengthComputable) td.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`; };
  x.onloadend = () => {
    nut.disabled = false;
    td.hidden = true;
    let r = {};
    try { r = JSON.parse(x.responseText || '{}'); } catch { /* bỏ */ }
    if (x.status === 201) {
      bao(suaId != null ? `Đã lưu bản sửa ${r.so_phieu}` : `Đã gửi ${r.so_phieu}`);
      lamMoiForm();
      moChiTiet(r.id);
      return;
    }
    if (x.status === 400) {
      if (r.loi?.chung) bao(r.loi.chung, true);
      for (const [k, v] of Object.entries(r.loi ?? {})) datLoi(k, v);
      $('#loi-tep').textContent = (r.loi_tep ?? []).join(' · ');
      return;
    }
    bao('Không gửi được — kiểm tra DevDesk trên máy build', true);
  };
  x.send(fd);
});

async function guiQuaHopThu(fd, nut, td) {
  const duLieu = {};
  for (const [k, v] of fd.entries()) if (k !== 'tep') duLieu[k] = v;
  const tep = [...tepChon];
  // Chẩn đoán (22/10: iPhone gửi phiếu mất ảnh): số tệp trong danh sách / đang hiện / trong FormData — Core ghi nhật ký.
  duLieu.chan_doan = { tep: tep.length, hien: $$('#ds-tep li').length, fd: fd.getAll('tep').length, byte: tep.map((f) => f.size), ua: navigator.userAgent.slice(0, 120) };
  try {
    const gid = await ht.guiPhieu(duLieu, tep, (p) => { td.firstElementChild.style.width = `${p * 100}%`; });
    choKetQua.set(gid, Date.now());
    bao(`${suaId != null ? 'Đã gửi bản sửa' : 'Đã gửi'} · kèm ${tep.length} tệp — chờ máy build nhận`);
    lamMoiForm();
    moMan('ds');
  } catch (err) {
    bao(err.ma === 'token' ? 'Phiên hết hạn — đăng nhập lại' : 'Chưa gửi được — kiểm tra mạng rồi thử lại', true);
    if (err.ma === 'token') { await ht.dangXuat(); hienDangNhap(); }
  } finally {
    nut.disabled = false;
    td.hidden = true;
  }
}

function lamMoiForm() {
  $('#f').reset();
  tepChon = [];
  veTep();
  for (const nhom of $$('.nut-chon')) for (const b of $$('button', nhom)) b.classList.remove('chon');
  $('.nut-chon[data-ten="loai"] [data-v="bug"]').classList.add('chon');
  $('.nut-chon[data-ten="uu_tien"] [data-v="3"]').classList.add('chon');
  doiLoai('bug');
  suaId = null;
  $('#dang-sua').hidden = true;
  $('#nut-gui').textContent = 'Gửi phiếu';
}

/** Mở form điền sẵn phiếu cũ. Tệp cũ giữ nguyên; tệp chọn thêm được thêm vào phiếu. */
function batDauSua(p) {
  lamMoiForm();
  const chon = (ten, v) => { for (const b of $$(`.nut-chon[data-ten="${ten}"] button`)) b.classList.toggle('chon', b.dataset.v === String(v)); };
  chon('loai', p.loai);
  chon('app_dich', p.app_dich);
  chon('uu_tien', p.uu_tien);
  doiLoai(p.loai);
  for (const o of $$('#f input[name], #f textarea[name]')) o.value = p[o.name] ?? '';
  suaId = p.id;
  $('#dang-sua span').textContent = `Đang sửa ${p.so_phieu} — chỉ sửa được 1 lần. ${p.tep.length} tệp cũ giữ nguyên; tệp chọn thêm sẽ được thêm vào.`;
  $('#dang-sua').hidden = false;
  $('#nut-gui').textContent = `Lưu sửa ${p.so_phieu}`;
  moMan('gui');
  scrollTo(0, 0);
}
$('#huy-sua').addEventListener('click', () => { lamMoiForm(); moMan('ds'); });

// ── Danh sách ──
async function taiDanhSach() {
  const ds = TAI_CHO ? await (await fetch('/api/phieu')).json() : (trangThai?.phieu ?? []).map((p) => ({ ...p, so_tep: p.tep.length }));
  const ul = $('#ds-phieu');
  const dangCho = [...choKetQua.keys()].map((gid) => {
    const li = document.createElement('li');
    li.className = 'trong';
    li.textContent = 'Phiếu vừa gửi — chờ máy build nhận…';
    return li;
  });
  if (!ds.length) { ul.replaceChildren(...dangCho); if (!dangCho.length) ul.innerHTML = '<li class="trong">Chưa có phiếu</li>'; return; }
  ul.replaceChildren(...ds.map((p) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="hinh">${p.thu_nho ? `<img loading="lazy" src="/tep/sp/${p.thu_nho}" alt="">` : ''}</div>
      <div class="noi-dung">
        <div class="dong1"><b>${p.so_phieu}</b><span class="nhan ${p.loai}">${TEN_LOAI[p.loai]}</span><span class="nhan tt">${TEN_TT[p.trang_thai] ?? p.trang_thai}</span>${p.uu_tien <= 2 ? `<span class="nhan ut${p.uu_tien}">${TEN_UT[p.uu_tien]}</span>` : ''}</div>
        <div class="tieu-de"></div>
        <div class="phu">${TEN_APP[p.app_dich] ?? p.app_dich} · ${p.so_tep} tệp · ${gio(p.tao_luc)}</div>
      </div>`;
    $('.tieu-de', li).textContent = p.tieu_de;
    const mo = () => moChiTiet(p.id);
    li.onclick = mo;
    li.onkeydown = (e) => { if (e.key === 'Enter') mo(); };
    return li;
  }));
  ul.prepend(...dangCho);
}

const gio = (iso) => new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

// ── Chi tiết ──
async function moChiTiet(id) {
  moMan('ct');
  phieuDangXem = id;
  await veChiTiet(id);
}

async function veChiTiet(id) {
  let p;
  if (TAI_CHO) {
    const r = await fetch(`/api/phieu/${id}`);
    if (!r.ok) return;
    p = await r.json();
  } else {
    p = trangThai?.phieu?.find((x) => x.id === id);
    if (!p) return;
    p = { ...p, tep: p.tep.map((a) => ({ ...a, san_pham: [] })) };
  }
  const ct = $('#ct');
  const dong = (nhan, gt) => (gt ? `<div class="truong"><div class="nhan-o">${nhan}</div><div class="gia-tri"></div></div>` : '');
  ct.innerHTML = `
    <div class="dong1"><b>${p.so_phieu}</b><span class="nhan ${p.loai}">${TEN_LOAI[p.loai]}</span><span class="nhan tt">${TEN_TT[p.trang_thai] ?? p.trang_thai}</span><span class="nhan ut${p.uu_tien}">${TEN_UT[p.uu_tien]}</span></div>
    <h1></h1>
    <div class="phu">${TEN_APP[p.app_dich] ?? p.app_dich} · ${p.nguoi_gui} · ${gio(p.tao_luc)}${p.machine_id ? ` · máy ${p.machine_id}` : ''}${p.ban_dang_chay ? ` · bản ${p.ban_dang_chay}` : ''}</div>
    ${dong('Đang làm gì', p.dang_lam)}${dong('Thấy gì', p.thay_gi)}${dong('Mong muốn gì', p.mong_muon)}
    ${dong('Cần gì', p.can_gi)}${dong('Giúp khách thế nào', p.giup_khach)}
    <div class="tep-ct"></div>`;
  $('h1', ct).textContent = p.tieu_de;
  if (p.ten_tram) $('.phu', ct).append(` · ${p.ten_tram}`);
  const gt = [p.dang_lam, p.thay_gi, p.mong_muon, p.can_gi, p.giup_khach].filter(Boolean);
  $$('.gia-tri', ct).forEach((el, i) => { el.textContent = gt[i]; });

  if (p.sua_lan > 0) $('.phu', ct).append(' · đã sửa');

  const khoi = $('.tep-ct', ct);
  for (const a of p.tep) khoi.append(veTepChiTiet(a));

  const cuaToi = TAI_CHO || p.nguoi_gui === trangThai?.nguoi?.ten_dang_nhap;
  if (cuaToi && p.trang_thai === 'MOI' && !(p.sua_lan > 0)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nut-phu';
    b.textContent = 'Sửa phiếu (được 1 lần)';
    b.onclick = () => batDauSua(p);
    ct.append(b);
  }
}

function veTepChiTiet(a) {
  const d = document.createElement('div');
  d.className = `tep ${a.trang_thai}`;
  const tieuDe = document.createElement('div');
  tieuDe.className = 'tep-dau';
  // Ở xa chưa xem được ảnh/clip (giai đoạn sau) — chỉ hiện tên + trạng thái xử lý.
  tieuDe.innerHTML = TAI_CHO ? `<a target="_blank" href="/tep/goc/${a.id}"></a><span class="phu"> · ${coTep(a.byte)}</span>` : `<b></b><span class="phu"> · ${coTep(a.byte)}</span>`;
  $(TAI_CHO ? 'a' : 'b', tieuDe).textContent = a.ten_goc;
  const tt = { cho: 'Chờ xử lý', dang: 'Đang xử lý…', loi: 'Lỗi xử lý', xong: '' }[a.trang_thai];
  if (tt) tieuDe.insertAdjacentHTML('beforeend', `<span class="nhan tt">${tt}</span>`);
  if (a.ghi_chu) { const g = document.createElement('span'); g.className = 'phu'; g.textContent = ` · ${a.ghi_chu}`; tieuDe.append(g); }
  d.append(tieuDe);

  const sp = (kieu) => a.san_pham.filter((s) => s.kieu === kieu);
  if (a.loai === 'anh' && sp('anh_claude')[0]) {
    d.insertAdjacentHTML('beforeend', `<a target="_blank" href="/tep/sp/${sp('anh_claude')[0].id}"><img class="anh-lon" loading="lazy" src="/tep/sp/${sp('anh_claude')[0].id}" alt=""></a>`);
  }
  if (a.loai === 'video') {
    if (sp('video_xem')[0]) d.insertAdjacentHTML('beforeend', `<video controls muted playsinline preload="metadata" src="/tep/sp/${sp('video_xem')[0].id}"></video>`);
    const k = sp('khung');
    if (k.length) {
      d.insertAdjacentHTML('beforeend', `<div class="khung">${k.map((x) => `<a target="_blank" href="/tep/sp/${x.id}"><img loading="lazy" src="/tep/sp/${x.id}" alt=""></a>`).join('')}</div>`);
    }
  }
  for (const kieu of ['log_trich', 'chu']) {
    for (const x of sp(kieu)) {
      d.insertAdjacentHTML('beforeend', `<a class="nut-phu" target="_blank" href="/tep/sp/${x.id}">${kieu === 'log_trich' ? 'Xem log đã lọc' : 'Xem chữ đã lọc'}</a>`);
    }
  }
  return d;
}

// ── Báo ──
let henBao;
function bao(chu, loi = false) {
  const b = $('#bao');
  b.textContent = chu;
  b.classList.toggle('loi', loi);
  b.hidden = false;
  clearTimeout(henBao);
  henBao = setTimeout(() => { b.hidden = true; }, 3500);
}

// ── Sự kiện trực tiếp ──
function ketNoiSuKien() {
  const es = new EventSource('/api/su-kien');
  es.addEventListener('phieu', (e) => {
    const { id } = JSON.parse(e.data);
    if (phieuDangXem === id) veChiTiet(id);
    else if (!$('#man-ds').hidden) taiDanhSach();
  });
}

// ── Chế độ ở xa: đăng nhập + hỏi trạng thái định kỳ ──
function hienDangNhap(choDuyet = false) {
  for (const m of $$('.man')) m.hidden = m.id !== 'man-dn';
  $('.dau nav').hidden = true;
  $('#dn-form').hidden = choDuyet;
  $('#dn-cho').hidden = !choDuyet;
}

function vaoUngDung(phien) {
  $('.dau nav').hidden = false;
  $('#nguoi').hidden = false;
  $('#nguoi-ten').textContent = phien.nguoi?.ten_hien ?? '';
  moMan('gui');
  void vongTrangThai();
}

let dangHoi = false;
async function vongTrangThai() {
  if (dangHoi) return;
  dangHoi = true;
  for (;;) {
    try {
      const tt = await ht.docTrangThai();
      if (tt) {
        trangThai = tt;
        for (const kq of tt.ket_qua_gui ?? []) {
          if (!choKetQua.has(kq.gid)) continue;
          choKetQua.delete(kq.gid);
          if (kq.so_phieu) bao(kq.da_sua ? `Máy build đã nhận bản sửa ${kq.so_phieu}` : `Máy build đã nhận ${kq.so_phieu}`);
          else bao('Phiếu bị trả lại: ' + [...Object.values(kq.loi ?? {}), ...(kq.loi_tep ?? [])].join(' · '), true);
        }
        if (!$('#man-ds').hidden) taiDanhSach();
        if (phieuDangXem != null) veChiTiet(phieuDangXem);
      }
    } catch (err) {
      if (err.ma === 'token') { await ht.dangXuat(); dangHoi = false; return hienDangNhap(); }
    }
    // Tab ẩn hỏi thưa (60 giây); quay lại tab (vd từ app Ảnh về) thì hỏi ngay.
    await new Promise((ok) => {
      const h = setTimeout(ok, document.hidden ? 60_000 : 3000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(h); ok(); } }, { once: true });
    });
  }
}

$('#dn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ten = $('#dn-ten').value.trim();
  const ma = $('#dn-ma').value.replace(/\D/g, '');
  $('#dn-loi').textContent = '';
  if (!ten || ma.length !== 6) { $('#dn-loi').textContent = 'Nhập tên và mã 6 số'; return; }
  const nut = $('#dn-nut');
  nut.disabled = true;
  try {
    // Thiết bị mới: máy build trả "chờ duyệt" ⇒ chuyển sang màn chờ, vẫn đợi tới khi Admin duyệt.
    const kq = await ht.dangNhap(ten, ma, { dung: false, choDuyet: () => hienDangNhap(true) }).catch((err) => ({ ket_qua: 'sai', ly_do: err.message }));
    if (kq?.ket_qua === 'ok') return vaoUngDung(kq.phien);
    hienDangNhap();
    $('#dn-loi').textContent = kq?.ly_do ?? 'Không đăng nhập được';
  } finally {
    nut.disabled = false;
    $('#dn-ma').value = '';
  }
});

async function batDauOXa() {
  let cauHinh;
  try { cauHinh = (await import('./cau-hinh.js')).default; } catch { cauHinh = null; }
  if (!cauHinh?.apps_script) { hienDangNhap(); $('#dn-form').hidden = true; $('#dn-loi').textContent = 'DevDesk chưa được cấu hình'; return; }
  ht = await import('./hop-thu.js');
  const { phien, dnCho } = await ht.khoiDong(cauHinh);
  if (phien && phien.het > Date.now()) return vaoUngDung(phien);
  if (dnCho) {
    hienDangNhap(true);
    const kq = await ht.choTraLoiDangNhap({ dung: false, choDuyet: () => hienDangNhap(true) }).catch(() => null);
    if (kq?.ket_qua === 'ok') return vaoUngDung(kq.phien);
    hienDangNhap();
    if (kq?.ly_do) $('#dn-loi').textContent = kq.ly_do;
    return;
  }
  hienDangNhap();
}

$('#dang-xuat')?.addEventListener('click', async () => { await ht?.dangXuat(); location.reload(); });
// Gói đăng nhập lạc / gõ nhầm tên ⇒ thoát màn chờ, gửi lại từ đầu (thiết bị giữ nguyên khoá).
$('#dn-lai')?.addEventListener('click', async () => { await ht?.dangXuat(); location.reload(); });

(async () => {
  if (TAI_CHO) {
    try { gioiHan = (await (await fetch('/api/he-thong')).json()).gioi_han; } catch { /* dùng mặc định */ }
    $('#quan-tri').hidden = false;
    ketNoiSuKien();
    return;
  }
  gioiHan = { anh: 20 * 1048576, video: 300 * 1048576, tai_lieu: 30 * 1048576, log: 50 * 1048576, so_tep_moi_phieu: 20 };
  await batDauOXa();
})();

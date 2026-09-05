/* ============================================================
   宗像総合管理システム  共通処理
   BUILD: common.js v20260906A
   ============================================================ */

/* ---------- 最新版をすぐ反映する（Service Worker・ネットワーク優先） ----------
   GitHub Pages はHTMLに no-cache ヘッダーを付けられず、変更後に
   ハード再読み込みが要りがちだった。ネットワーク優先のSWを常駐させ、
   オンライン時は常に最新を取りに行くようにする（普通のリロードで反映）。
------------------------------------------------------------------ */
if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

const STATUS = {
  estimate : '見積',
  ordered  : '受注',
  started  : '着工',
  completed: '完工',
  invoiced : '請求済',
  paid     : '入金済',
  cancelled: '中止'
};

const ROLE_LABEL = { admin:'管理者', manager:'現場監督', member:'作業員' };

/* ---------- 竣工図書の章立て（民間工事の標準）----------
   写真・書類（project_files.doc_category）を、この章に振り分けて
   竣工図書として積み上げる。files.html で分類・handover.html で整理／印刷。
   会社・発注者ごとの追加は、この配列に足すだけで両画面へ反映される。
------------------------------------------------------------ */
const HANDOVER_CHAPTERS = [
  { key:'gaiyou',   label:'工事概要' },
  { key:'plan',     label:'施工計画書' },
  { key:'permit',   label:'届出・許認可' },
  { key:'safety',   label:'安全衛生書類' },
  { key:'quality',  label:'品質・出来形記録' },
  { key:'photo',    label:'工事写真帳' },
  { key:'drawing',  label:'竣工図' },
  { key:'inspect',  label:'検査記録' },
  { key:'warranty', label:'保証書・その他' }
];
function chapterLabel(key){
  const c = HANDOVER_CHAPTERS.find(x => x.key === key);
  return c ? c.label : '';
}
function chapterOptions(sel){
  return HANDOVER_CHAPTERS
    .map(c => `<option value="${c.key}"${c.key === sel ? ' selected' : ''}>${esc(c.label)}</option>`)
    .join('');
}

/* ---------- 竣工図書：資料名の自動タグ（章名・No.・撮影日）----------
   章に分類されると、元のファイル名の拡張子の前へ （章名・No.X・撮影日）を付け、
   後から検索できるようにする。章の移動・並べ替えのたびに古いタグを外して付け直す。
   DB列は増やさず、タグは元ファイル名から機械的に外して基準名を復元する
   （タグには必ず "No.数字" が入るので、既存の "(1)" 等とは取り違えない）。
------------------------------------------------------------------ */
function docNameParts(name){
  const m = /^(.*?)(\.[^.\/\\]+)?$/.exec(name || '');
  return { stem: m[1] || '', ext: m[2] || '' };
}
function stripDocTag(name){
  if (!name) return name || '';
  const { stem, ext } = docNameParts(name);
  return stem.replace(/（[^（）]*No\.\d+[^（）]*）\s*$/, '') + ext;
}
function buildDocName(baseFileName, chapterKey, no, takenOn){
  if (!chapterKey) return baseFileName;                 // 未分類は素のファイル名に戻す
  const { stem, ext } = docNameParts(baseFileName);
  const tag = [chapterLabel(chapterKey), 'No.' + no, takenOn || ''].filter(Boolean).join('・');
  return `${stem}（${tag}）${ext}`;
}
/* 指定した章の中を並び順で採番し、original_name のタグと sort_order を付け直してDB保存する。
   files はページが保持する project_files 配列（その場で書き換える）。戻り値＝更新件数。 */
async function applyChapterNames(files, chapterKey){
  const bySort = (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) ||
                           ((a.taken_on || '') < (b.taken_on || '') ? 1 : -1);
  const arr = files.filter(x => (x.doc_category || '') === chapterKey).sort(bySort);
  const ups = [];
  arr.forEach((x, i) => {
    const no = i + 1, so = (i + 1) * 10;
    const base = stripDocTag(x.original_name || '');
    const nm = chapterKey ? buildDocName(base, chapterKey, no, x.taken_on) : base;
    const patch = {};
    if (chapterKey && (x.sort_order || 0) !== so) patch.sort_order = so;   // 採番は章内のみ（未分類は並び替えない）
    if ((x.original_name || '') !== nm) patch.original_name = nm;          // 未分類は古いタグを外すだけ
    if (Object.keys(patch).length){ ups.push({ id: x.id, patch }); Object.assign(x, patch); }
  });
  if (ups.length) await Promise.all(ups.map(u => sb.from('project_files').update(u.patch).eq('id', u.id)));
  return ups.length;
}

/* ---------- 表示の整形 ---------- */
function fmtMoney(v){
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (isNaN(n)) return '';
  return '¥' + n.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
}

function fmtDate(v){
  if (!v) return '';
  const d = new Date(v + 'T00:00:00');
  if (isNaN(d)) return v;
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

/* ---------- 画面上の通知 ---------- */
function showMsg(el, text, kind){
  if (!el) return;
  el.className = 'msg ' + (kind || '');
  el.textContent = text || '';
  if (text) el.scrollIntoView({ block:'nearest' });
}

/* ---------- 削除の取り消し（元に戻す） ----------
   削除した直後に「元に戻す」ボタン付きの通知を出す。
   undoFn は、控えておいた内容を入れ直す非同期関数。
   これで、削除ボタンのある画面はどこでも復元できる。
------------------------------------------------ */
function showUndo(el, text, undoFn){
  if (!el){ return; }
  el.className = 'msg ok';
  el.innerHTML = `<span>${esc(text)}</span>` +
    `<button type="button" class="undobtn" style="margin-left:12px;font-weight:700;` +
    `text-decoration:underline;background:none;border:none;color:var(--ink-2);cursor:pointer;font-size:13px">` +
    `元に戻す</button>`;
  const btn = el.querySelector('.undobtn');
  let used = false;
  btn.addEventListener('click', async () => {
    if (used) return;
    used = true; btn.disabled = true; btn.textContent = '元に戻しています…';
    try {
      await undoFn();
      el.className = 'msg ok'; el.textContent = '元に戻しました。';
    } catch (e){
      el.className = 'msg err'; el.textContent = '元に戻せませんでした。' + (e.message || '');
    }
  });
  el.scrollIntoView({ block:'nearest' });
}

/* ---------- 事前登録が必要なドロップダウンの空欄アナウンス ----------
   取引先・工程・利用者などのマスタが1件も無いまま選択肢が空の
   セレクトを黙って出すと、登録し忘れなのか本当に無いのか分からない。
   セレクトの直後に注意書きを出し、必要ならページへの導線も添える。
------------------------------------------------------------------ */
function setEmptyNote(selectEl, isEmpty, text, href, linkLabel){
  if (!selectEl) return;
  let note = selectEl.nextElementSibling;
  if (!note || !note.classList || !note.classList.contains('emptynote')){
    note = document.createElement('div');
    note.className = 'emptynote';
    selectEl.insertAdjacentElement('afterend', note);
  }
  note.innerHTML = href
    ? `${esc(text)}　<a href="${esc(href)}">${esc(linkLabel || 'こちらから登録')}</a>`
    : esc(text);
  note.hidden = !isEmpty;
}

/* ---------- ログイン確認 ----------
   ログインしていなければログイン画面へ戻す。
   戻り値: { session, me }  me は app_users の1行
------------------------------------ */
async function requireAuth(){
  const { data:{ session } } = await sb.auth.getSession();
  if (!session){
    const back = location.pathname.split('/').pop() + location.search;
    location.replace('index.html?next=' + encodeURIComponent(back));
    return null;
  }

  let { data:me, error } = await sb
    .from('app_users')
    .select('id, name, role, organization_id, employee_type, department')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();

  if (error){
    alert('利用者情報を読み込めませんでした。\n' + error.message);
    return null;
  }

  // メール確認が必要な設定のときは、招待からの登録直後はまだ紐づいていない。
  // 確認後の初回ログインでここに来るので、覚えておいた招待トークンで紐づけ直す。
  if (!me){
    let pending = null;
    try { pending = localStorage.getItem('pending_invite_token'); } catch (e) {}
    if (pending){
      const { data: ok } = await sb.rpc('claim_invite', { p_token: pending });
      try { localStorage.removeItem('pending_invite_token'); } catch (e) {}
      if (ok){
        ({ data:me, error } = await sb
          .from('app_users')
          .select('id, name, role, organization_id, employee_type, department')
          .eq('auth_user_id', session.user.id)
          .maybeSingle());
      }
    }
  }

  if (!me){
    alert('このアカウントはまだ会社に登録されていません。\n管理者に利用者の追加を依頼してください。');
    await sb.auth.signOut();
    location.replace('index.html');
    return null;
  }
  startPresence();
  return { session, me };
}

/* ---------- ログイン中の人数のための在席打刻 ----------
   画面を開いて操作している間だけ、一定間隔で本人の最終アクセス
   時刻を記録する。画面を見ていない間（タブが背面・スマホ画面オフ）は
   打刻を止めるので、操作をやめて数分たつと自動的に「ログイン中」から外れる。
------------------------------------------------------------------ */
let _presenceTimer = null;
function startPresence(){
  const beat = () => {
    if (document.visibilityState === 'hidden') return;
    sb.rpc('touch_presence').then(() => {}, () => {});
  };
  beat();
  if (_presenceTimer) clearInterval(_presenceTimer);
  _presenceTimer = setInterval(beat, 60000);   // 1分ごと
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat();
  });
}

/* ---------- 見出し帯に利用者を表示 ---------- */
function paintBar(me, orgName){
  const who = document.getElementById('who');
  if (!who) return;
  who.innerHTML = `<b>${esc(ROLE_LABEL[me.role] || me.role)}</b>${esc(orgName || '')}`;
}

async function loadOrgName(orgId){
  const { data } = await sb.from('organizations').select('name').eq('id', orgId).maybeSingle();
  return data ? data.name : '';
}

/* ---------- 画像の縮小 ---------- */
function shrinkImage(file, maxEdge, quality){
  return new Promise(res => {
    if (!file.type || !file.type.startsWith('image/')) return res(null);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const sc = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.round(img.width * sc), h = Math.round(img.height * sc);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(b => { URL.revokeObjectURL(url); res(b ? { blob:b, w:img.width, h:img.height } : null); },
                'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}

/* ---------- PDFの1ページ目を絵にする ----------
   図面がPDFのとき、中身が見えないと意味がないため、
   1ページ目だけを画像に変換して一覧に出す。
   読み込みは必要になったときだけ行う。
------------------------------------------------ */
let _pdfReady = null;
function loadPdfLib(){
  if (_pdfReady) return _pdfReady;
  _pdfReady = new Promise((res, rej) => {
    if (window.pdfjsLib) return res(window.pdfjsLib);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      if (!window.pdfjsLib) return rej(new Error('PDFの読み込みに失敗しました'));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      res(window.pdfjsLib);
    };
    s.onerror = () => rej(new Error('PDFの読み込みに失敗しました'));
    document.head.appendChild(s);
  });
  return _pdfReady;
}

async function pdfThumb(file, maxEdge){
  if (!file || file.type !== 'application/pdf') return null;
  try {
    const lib = await loadPdfLib();
    const buf = await file.arrayBuffer();
    const doc = await lib.getDocument({ data: buf }).promise;
    const page = await doc.getPage(1);
    const v0 = page.getViewport({ scale: 1 });
    const sc = Math.min(3, (maxEdge || 1200) / Math.max(v0.width, v0.height));
    const vp = page.getViewport({ scale: sc });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
  } catch (e){
    console.error('PDFの絵づくりに失敗', e);
    return null;
  }
}

/* ---------- 取り込んだファイルの表示用画像をつくる ----------
   画像なら縮小、PDFなら1ページ目。どちらでもなければ null。
------------------------------------------------------------ */
async function makeThumb(file, maxEdge, quality){
  if (file.type && file.type.startsWith('image/')){
    const r = await shrinkImage(file, maxEdge, quality || 0.75);
    return r ? r.blob : null;
  }
  if (file.type === 'application/pdf') return await pdfThumb(file, maxEdge);
  return null;
}

/* ---------- 写真に記録された位置と撮影日時 ---------- */
function readExifGeo(file){
  return new Promise(res => {
    if (!file || !/jpe?g/i.test(file.type || '')) return res(null);

    const fr = new FileReader();
    fr.onerror = () => res(null);
    fr.onload = () => {
      try { res(parseExif(new DataView(fr.result))); }
      catch (e){ res(null); }
    };
    // 先頭 256KB だけ読めば Exif は足りる
    fr.readAsArrayBuffer(file.slice(0, 262144));
  });
}

function parseExif(dv){
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;   // JPEG か

  // APP1（Exif）の位置を探す
  let off = 2, app1 = -1;
  while (off + 4 < dv.byteLength){
    if (dv.getUint8(off) !== 0xFF) break;
    const marker = dv.getUint8(off + 1);
    const size   = dv.getUint16(off + 2);
    if (marker === 0xE1){
      if (dv.getUint32(off + 4) === 0x45786966){ app1 = off + 10; break; }  // "Exif"
    }
    if (marker === 0xDA) break;                                            // 画像本体
    off += 2 + size;
  }
  if (app1 < 0) return null;

  // TIFF ヘッダ
  const bo = dv.getUint16(app1);
  const le = (bo === 0x4949);                       // 0x4949=リトル / 0x4D4D=ビッグ
  if (!le && bo !== 0x4D4D) return null;
  if (dv.getUint16(app1 + 2, le) !== 42) return null;

  const ifd0 = app1 + dv.getUint32(app1 + 4, le);
  const out = { lat:null, lng:null, at:null };

  const readIfd = (base, want) => {
    const found = {};
    if (base + 2 > dv.byteLength) return found;
    const n = dv.getUint16(base, le);
    for (let i = 0; i < n; i++){
      const e = base + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      const tag = dv.getUint16(e, le);
      if (!want.includes(tag)) continue;
      found[tag] = {
        type : dv.getUint16(e + 2, le),
        count: dv.getUint32(e + 4, le),
        valOf: e + 8
      };
    }
    return found;
  };

  const valueOffset = (ent, unitBytes) => {
    const total = ent.count * unitBytes;
    return total > 4 ? app1 + dv.getUint32(ent.valOf, le) : ent.valOf;
  };

  const ratio = (p) => {
    const a = dv.getUint32(p, le), b = dv.getUint32(p + 4, le);
    return b ? a / b : 0;
  };

  const ascii = (ent) => {
    const p = valueOffset(ent, 1);
    let s = '';
    for (let i = 0; i < ent.count - 1; i++){
      const c = dv.getUint8(p + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  // IFD0 から GPS と Exif への入口を得る
  const top = readIfd(ifd0, [0x8825, 0x8769]);

  // 撮影日時
  if (top[0x8769]){
    const exifBase = app1 + dv.getUint32(top[0x8769].valOf, le);
    const ex = readIfd(exifBase, [0x9003]);           // DateTimeOriginal
    if (ex[0x9003]){
      const s = ascii(ex[0x9003]);                    // "2026:07:23 14:32:10"
      const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
      if (m) out.at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    }
  }

  // GPS
  if (top[0x8825]){
    const gpsBase = app1 + dv.getUint32(top[0x8825].valOf, le);
    const g = readIfd(gpsBase, [0x0001, 0x0002, 0x0003, 0x0004]);

    const dms = (ent) => {
      if (!ent || ent.count < 3) return null;
      const p = valueOffset(ent, 8);
      return ratio(p) + ratio(p + 8) / 60 + ratio(p + 16) / 3600;
    };
    const ref = (ent) => ent ? String.fromCharCode(dv.getUint8(ent.valOf)) : '';

    const la = dms(g[0x0002]), ln = dms(g[0x0004]);
    if (la !== null && ln !== null && (la || ln)){
      out.lat = (ref(g[0x0001]) === 'S') ? -la : la;
      out.lng = (ref(g[0x0003]) === 'W') ? -ln : ln;
    }
  }

  return (out.lat !== null || out.at) ? out : null;
}

/* ---------- 端末から今の位置を取る ---------- */
function currentPosition(timeoutMs){
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => res(null),
      { enableHighAccuracy: true, timeout: timeoutMs || 8000, maximumAge: 30000 }
    );
  });
}

/* ---------- 写真1枚分の位置を決める ----------
   写真に記録されていればそれを使う。
   無ければ端末の位置を使う（現場で撮ってその場で取り込む場合に有効）。
------------------------------------------------ */
async function resolveGeo(file, devicePos){
  const ex = await readExifGeo(file);
  if (ex && ex.lat !== null){
    return { lat: ex.lat, lng: ex.lng, source: 'exif', acc: null, at: ex.at };
  }
  if (devicePos){
    return { lat: devicePos.lat, lng: devicePos.lng, source: 'device',
             acc: devicePos.acc, at: ex ? ex.at : null };
  }
  return { lat: null, lng: null, source: 'none', acc: null, at: ex ? ex.at : null };
}

/* ---------- ログアウト ---------- */
async function signOut(){
  // 「出る」は誤タップでシステムからログアウトしてしまうため、必ず確認する
  if (!confirm('システムからログアウトします。よろしいですか。\n（作業を続けるときは「メニュー」からお戻りください）')) return;
  await sb.auth.signOut();
  location.replace('index.html');
}

/* ---------- メニューへ戻る導線 ----------
   全画面の見出し帯に自動で挿入する。
   新しい画面を作ったときも、common.js を読み込むだけで付く。
   ログイン画面とメニュー自身には付けない。
------------------------------------------ */
(function insertBack(){
  const here = location.pathname.split('/').pop() || 'index.html';
  if (/^(index|mode-select|report-entry|signup)\.html$/.test(here)) return;

  // 作業のために別ページから来たか（メニュー・ログイン・直接アクセスは除く）。
  // 来ていれば「戻る」で元居たページへ、そうでなければ「メニュー」へ。
  let backToPrev = false;
  try {
    if (document.referrer){
      const ref = new URL(document.referrer);
      const rf = ref.pathname.split('/').pop() || '';
      if (ref.origin === location.origin && rf && rf !== here &&
          !/^(index|mode-select|report-entry|signup)\.html$/.test(rf)){
        backToPrev = true;
      }
    }
  } catch (e) {}

  function put(){
    const bar = document.querySelector('.bar');
    if (!bar) return;
    if (bar.querySelector('.backbtn')) return;

    const a = document.createElement('a');
    a.className = 'btn ghost sm barbtn backbtn';
    if (backToPrev){
      a.href = '#';
      a.textContent = '◂ 戻る';
      a.addEventListener('click', e => {
        e.preventDefault();
        if (history.length > 1) history.back(); else location.href = 'mode-select.html';
      });
    } else {
      a.href = 'mode-select.html';
      a.textContent = '◂ メニュー';
    }

    const mark = bar.querySelector('.mark');
    if (mark) mark.after(a); else bar.prepend(a);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', put);
  } else {
    put();
  }
})();

/* Ревизор — тяжёлые библиотеки (pdf.js, jsPDF, шрифт) грузятся лениво, по требованию */
const _libCache = {};
function loadScript(src) {
  if (_libCache[src]) return _libCache[src];
  _libCache[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res();
    s.onerror = () => { delete _libCache[src]; rej(new Error('Не загрузился файл ' + src + '. Проверьте интернет и обновите страницу.')); };
    document.head.appendChild(s);
  });
  return _libCache[src];
}
async function ensurePdfJs() {
  if (!window['pdfjs-dist/build/pdf']) await loadScript('./vendor/pdf.umd.min.js');
  const lib = window['pdfjs-dist/build/pdf'];
  if (lib && lib.GlobalWorkerOptions) {
    if (location.protocol === 'file:') lib.disableWorker = true;
    else lib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.umd.min.js';
  }
  return lib;
}
let _autoTableOk = false;
async function ensureExportLibs(onStep) {
  const step = onStep || (() => {});
  if (!window.jspdf) { step('Загружаю генератор PDF...'); await loadScript('./vendor/jspdf.umd.min.js'); }
  if (!_autoTableOk) { step('Загружаю таблицы...'); await loadScript('./vendor/jspdf.plugin.autotable.min.js'); _autoTableOk = true; }
  if (!window.__PT_FONT_B64) { step('Загружаю шрифт...'); await loadScript('./vendor/font-pt-sans.js'); }
}

const $ = (s) => document.querySelector(s);
const APP_VERSION = '1.36';
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};

let items = LS.get('plr_items', []);
let facts = LS.get('plr_facts', {});
let factColors = LS.get('plr_factColors', {});
const TERM_COLORS = ['c-red', 'c-green', 'c-orange', 'c-blue', 'c-purple', 'c-pink'];
let meta = LS.get('plr_meta', { store: '', title: '' });
let sessions = LS.get('plr_sessions', {});
let recountStart = LS.get('plr_start', null);
function ensureStart() {
  if (!recountStart) { recountStart = new Date().toISOString(); LS.set('plr_start', recountStart); }
}
let torchOn = false, torchStream = null;

// ---------- views / accent ----------
// в значке на айфоне воркер глючит (белый экран) — там работаем без него, напрямую
var _isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
var _isStandalone = false;
try { _isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch (e) {}
if (_isIOS && _isStandalone && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (rs) {
    rs.forEach(function (r) { try { r.unregister(); } catch (e) {} });
  }).catch(function () {});
}
function show(view) {
  $('#view-home').classList.toggle('hidden', view !== 'home');
  $('#view-recount').classList.toggle('hidden', view !== 'recount');
}
function applyAccent(c) {
  document.documentElement.style.setProperty('--accent', c);
  var _mt = document.querySelector('meta[name="theme-color"]'); if (_mt) _mt.setAttribute('content', c);
}
const savedAccent = LS.get('plr_accent', '#7c3aed');
applyAccent(savedAccent);
$('#accentInput').value = savedAccent;
$('#accentInput').addEventListener('input', (e) => {
  applyAccent(e.target.value);
  LS.set('plr_accent', e.target.value);
});

$('#btnGoRecount').onclick = () => { show('recount'); render(); };
$('#btnFastStart').onclick = () => { show('recount'); render(); };
$('#btnBack').onclick = () => show('home');
$('#btnContinue').onclick = () => { show('recount'); render(); };
$('#btnDemo').onclick = () => {
  items = [
    { n: 1, code: '36934', name: 'Пиво Свежее с пивоварни св.фильтр.непастер ж/б 4% 0,45', size: '12*1', price: '74,99', priceVal: 74.99, plan: 15, docsRaw: '15 шт' },
    { n: 2, code: '34444', name: 'Пиво Балтика No2 Лёгкое ж/б 4,2% 0,45', size: '24*1', price: '74,99', priceVal: 74.99, plan: 45, docsRaw: '45 шт' },
    { n: 3, code: '33294', name: 'Пиво La Moustache Blanche светлое 0,45', size: '12*1', price: '84,99', priceVal: 84.99, plan: 21, docsRaw: '21 шт' },
    { n: 4, code: '41423', name: 'Водка Арктик Найт 40% 0,5', size: '6*1', price: '549,99', priceVal: 549.99, plan: 4, docsRaw: '4 шт' },
    { n: 5, code: '34876', name: 'Водка Горное Озеро 40% 0,25', size: '20*1', price: '204,50', priceVal: 204.50, plan: 43, docsRaw: '2 кор 3 шт 43 шт' },
  ];
  facts = {}; factColors = {}; meta = { store: 'ДЕМО', title: 'Демо-набор' };
  recountStart = new Date().toISOString(); LS.set('plr_start', recountStart);
  persist(); show('recount'); render();
};

// ---------- parser ----------
function parseLine(line) {
  const clean = line.replace(/\s+/g, ' ').trim();
  const m = clean.match(/^(\d+)\s+(\d{4,6})\s+(.+)$/);
  if (!m) return null;
  const num = +m[1], code = m[2];
  const rest = m[3];
  let size = '', price = '', priceVal = 0, name = '', docsRaw = '';
  const sizeMatch = rest.match(/(\d+\s*\*\s*\d+)/);
  if (sizeMatch) {
    size = sizeMatch[1].replace(/\s/g, '');
    const si = rest.indexOf(sizeMatch[1]);
    name = rest.slice(0, si).trim();
    const after = rest.slice(si + sizeMatch[1].length).trim();
    const pm = after.match(/(\d+[\.,]\d{1,3})/);
    if (!pm) return null;
    price = pm[1]; priceVal = parseFloat(price.replace(',', '.'));
    docsRaw = after.slice(after.indexOf(pm[1]) + pm[1].length).trim();
  } else {
    const all = [...rest.matchAll(/(\d+[\.,]\d{2})/g)].map(x => x[1]);
    if (!all.length) return null;
    let pv = all.find(c => c.split(/[,.]/)[0].length >= 3) || all[all.length - 1];
    price = pv; priceVal = parseFloat(price.replace(',', '.'));
    const idx = rest.indexOf(price);
    name = rest.slice(0, idx).trim();
    docsRaw = rest.slice(idx + price.length).trim();
  }
  const totals = [...docsRaw.matchAll(/(\d+)\s*шт\.?/gi)].map(x => parseInt(x[1], 10));
  if (!totals.length) return null;
  const plan = totals[totals.length - 1];
  name = name.replace(/\s+/g, ' ').trim();
  if (!name || !(priceVal > 0)) return null;
  return { n: num, code, name, size, price, priceVal, plan, docsRaw };
}

function extractLines(tc) {
  const els = tc.items.map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
  els.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = []; let cur = [], curY = null;
  for (const it of els) {
    if (!it.s || !it.s.trim()) continue;
    if (curY === null || Math.abs(it.y - curY) < 3) { cur.push(it); if (curY === null) curY = it.y; }
    else { cur.sort((a, b) => a.x - b.x); lines.push(cur.map(c => c.s).join(' ')); cur = [it]; curY = it.y; }
  }
  if (cur.length) { cur.sort((a, b) => a.x - b.x); lines.push(cur.map(c => c.s).join(' ')); }
  return lines.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function parsePdf(file) {
  setModalText('Загружаю читалку PDF...');
  const pdfjsLib = await ensurePdfJs();
  setModalText('Читаю PDF...');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    allLines.push(...extractLines(tc));
  }
  const head = allLines.slice(0, 12).join('\n');
  let store = '', title = '';
  const tm = head.match(/По магазину:\s*([^\n]+)/);
  if (tm) store = tm[1].slice(0, 120);
  const tt = allLines[0] || '';
  title = (allLines.slice(0, 3).join(' | ')).slice(0, 200);
  return { items: itemsFromLines(allLines), meta: { store, title: tt }, debugLines: allLines.length };
}

function itemsFromLines(allLines) {
  const out = [];
  for (const ln of allLines) {
    const r = parseLine(ln);
    if (r) out.push(r);
  }
  // dedupe by code keep first, sort by n
  const seen = new Set(); const uniq = [];
  out.sort((a, b) => a.n - b.n);
  for (const r of out) { if (!seen.has(r.code)) { seen.add(r.code); uniq.push(r); } }
  return uniq;
}

// ---------- render ----------
function evalExpr(s) {
  if (s === undefined || s === null) return null;
  let t = String(s).trim().replace(',', '.').replace(/×/g, '*').replace(/х/gi, '*').replace(/=/g, '');
  if (!t) return null;
  if (/^[0-9.\s+\-*/()]+$/.test(t) === false) {
    const n = Number(t);
    return isNaN(n) ? null : n;
  }
  try {
    // safe eval: only numbers and operators (checked above)
    // eslint-disable-next-line no-new-func
    const v = Function('"use strict";return(' + (t || '0') + ')')();
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return Math.round(v * 1000) / 1000;
  } catch (e) { return null; }
}
function factNum(code) {
  const raw = facts[code];
  if (raw === undefined || raw === '' || raw === null) return null;
  return evalExpr(raw);
}
function statusOf(it) {
  const fv = factNum(it.code);
  if (fv === null || isNaN(fv)) return 'none';
  if (fv === it.plan) return 'ok';
  return fv < it.plan ? 'minus' : 'plus';
}
function persist() {
  LS.set('plr_items', items);
  LS.set('plr_facts', facts);
  LS.set('plr_factColors', factColors);
  LS.set('plr_meta', meta);
  LS.set('plr_sessions', sessions);
}
// ---------- разноцветные цифры факта (по желанию) ----------
function parseFactTerms(raw) {
  const out = [];
  const re = /(\d+(?:[.,]\d+)?|[+\-*/()])/g;
  let m;
  while ((m = re.exec(String(raw)))) {
    out.push(/^\d/.test(m[1]) ? { t: 'num', v: m[1] } : { t: 'op', v: m[1] });
  }
  return out;
}
function termsHtml(code, raw) {
  const terms = parseFactTerms(raw);
  if (!terms.some(x => x.t === 'op')) return '';
  let ni = 0;
  return terms.map(tk => {
    if (tk.t === 'num') {
      const cls = ((factColors[code] || [])[ni]) || '';
      const h = `<span class="term ${cls}" data-code="${code}" data-idx="${ni}" title="Нажми — сменить цвет">${escapeHtml(tk.v)}</span>`;
      ni++;
      return h;
    }
    return `<span class="op">${escapeHtml(tk.v)}</span>`;
  }).join('');
}
function cycleTermColor(code, idx) {
  const arr = (factColors[code] || []).slice();
  while (arr.length <= idx) arr.push('');
  const ci = TERM_COLORS.indexOf(arr[idx]);
  arr[idx] = ci === -1 ? TERM_COLORS[0] : (TERM_COLORS[ci + 1] || '');
  factColors[code] = arr;
  persist();
}
function bindTerms(root) {
  root.querySelectorAll('.term').forEach(sp => {
    sp.onclick = (e) => {
      e.stopPropagation();
      cycleTermColor(e.target.dataset.code, +e.target.dataset.idx);
      refreshTerms(e.target.dataset.code);
    };
  });
}
function refreshTerms(code) {
  const raw = (facts[code] === undefined || facts[code] === null) ? '' : facts[code];
  document.querySelectorAll(`[data-terms="${code}"]`).forEach(d => {
    d.innerHTML = termsHtml(code, raw);
    bindTerms(d);
  });
}
function render() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#list'); list.innerHTML = '';
  let shown = items;
  if (q) {
    const toks = q.split(/\s+/).filter(Boolean);
    shown = items.filter(it => {
      const nm = it.name.toLowerCase();
      return toks.every(t => nm.includes(t) || it.code.includes(t));
    });
  }
  // progress (считаем через eval, чтобы 3+4 тоже засчитывалось)
  const t = calcTotal();
  $('#countBadge').textContent = `${t.counted}/${t.total}`;
  const pr = $('#progress');
  if (items.length) {
    pr.classList.remove('hidden');
    const pct = t.total ? Math.round((t.counted / t.total) * 100) : 0;
    $('#progressText').textContent = `Посчитано ${t.counted}/${t.total} • сошлось ${t.matched}`;
    $('#progressSums').textContent = `−${t.shortQ} / +${t.surQ}`;
    $('#progressFill').style.width = pct + '%';
  } else pr.classList.add('hidden');
  $('#metaLine').textContent = meta.store ? `${meta.store}\n${meta.title} • позиций: ${items.length}` : (items.length ? `Позиций: ${items.length}` : '');
  $('#emptyState').classList.toggle('hidden', items.length > 0);
  for (const it of shown) {
    const st = statusOf(it);
    const div = document.createElement('div');
    div.className = 'item ' + (st === 'ok' ? 'ok' : st === 'minus' ? 'minus' : st === 'plus' ? 'plus' : '');
    const fv = (facts[it.code] === undefined || facts[it.code] === null) ? '' : facts[it.code];
    const fvNum = factNum(it.code);
    let diffHtml = '';
    if (fvNum !== null && !isNaN(fvNum)) {
      const d = fvNum - it.plan;
      const sum = d * it.priceVal;
      const showCalc = (String(fv).match(/[+\-*/]/) ? `${escapeHtml(String(fv))} = ${fvNum}: ` : '');
      if (d === 0) diffHtml = `<div class="diff zero">✓ сошлось (${showCalc}${fvNum})</div>`;
      else if (d < 0) diffHtml = `<div class="diff neg">− недостача: ${showCalc}${fvNum} (${d} шт • ${sum.toFixed(2)} ₽)</div>`;
      else diffHtml = `<div class="diff pos">+ излишек: ${showCalc}${fvNum} (+${d} шт • +${sum.toFixed(2)} ₽)</div>`;
    }
    div.innerHTML = `
      <div class="l"><b>Артикул:</b> ${it.code}</div>
      <div class="l"><b>Название:</b> ${escapeHtml(it.name)}</div>
      <div class="l"><b>Размерность:</b> ${escapeHtml(it.size || '—')} &nbsp; <b>Цена:</b> ${escapeHtml(it.price)} ₽</div>
      <div class="l"><b>По документам:</b> ${it.plan} шт</div>
      <div class="l"><b>Фактическое количество:</b></div>
      <div class="finput">
        <input type="text" inputmode="tel" enterkeyhint="done" data-code="${it.code}" value="${escapeHtml(String(fv))}" placeholder="напр. 3+4" autocomplete="off">
        <button class="plus-btn" data-code="${it.code}" title="Добавить плюс">+</button>
      </div>
      <div class="terms" data-terms="${it.code}" title="Нажми на цифру — сменить цвет">${termsHtml(it.code, fv)}</div>
      ${diffHtml}`;
    list.appendChild(div);
  }
  bindTerms(list);
  list.querySelectorAll('input').forEach(inp => {
    // при нажатии курсор сразу в конец — новые цифры дописываются, а не лезут вперёд
    inp.addEventListener('focus', (e) => {
      const el = e.target;
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
    });
    inp.addEventListener('input', (e) => {
      const c = e.target.dataset.code;
      facts[c] = e.target.value;
      if (e.target.value === '') delete facts[c];
      ensureStart();
      persist();
      // live recolor without full rerender (keep focus)
      const card = e.target.closest('.item');
      const it = items.find(x => x.code === c);
      const st = statusOf(it);
      card.classList.remove('ok', 'minus', 'plus');
      if (st === 'ok') card.classList.add('ok');
      if (st === 'minus') card.classList.add('minus');
      if (st === 'plus') card.classList.add('plus');
      // live diff text
      let diffEl = card.querySelector('.diff');
      const fvNum = factNum(c);
      const raw = e.target.value;
      if (fvNum !== null && raw !== '') {
        const d = fvNum - it.plan;
        const sum = d * it.priceVal;
        const showCalc = (String(raw).match(/[+\-*/]/) ? `${raw} = ${fvNum}: ` : '');
        let txt = '', cls = 'diff ';
        if (d === 0) { txt = `✓ сошлось (${showCalc}${fvNum})`; cls += 'zero'; }
        else if (d < 0) { txt = `− недостача: ${showCalc}${fvNum} (${d} шт • ${sum.toFixed(2)} ₽)`; cls += 'neg'; }
        else { txt = `+ излишек: ${showCalc}${fvNum} (+${d} шт • +${sum.toFixed(2)} ₽)`; cls += 'pos'; }
        if (!diffEl) { diffEl = document.createElement('div'); card.appendChild(diffEl); }
        diffEl.className = cls; diffEl.textContent = txt;
      } else if (diffEl) diffEl.remove();
      refreshTerms(c);
      updateProgress();
    });
  });
  list.querySelectorAll('.plus-btn').forEach(btn => {
    btn.onclick = (e) => {
      const c = e.target.dataset.code;
      const card = e.target.closest('.item');
      const inpEl = card.querySelector('input[data-code]');
      let v = (facts[c] === undefined || facts[c] === null) ? '' : facts[c];
      if (v === '') return;
      v = /[+\-*/]$/.test(v) ? v.slice(0, -1) + '+' : v + '+';
      inpEl.value = v;
      inpEl.focus();
      try { inpEl.setSelectionRange(v.length, v.length); } catch (e) {}
      inpEl.dispatchEvent(new Event('input', { bubbles: true }));
    };
  });
}
function updateProgress() {
  const t = calcTotal();
  $('#countBadge').textContent = `${t.counted}/${t.total}`;
  const pr = $('#progress');
  if (!pr || !items.length) return;
  pr.classList.remove('hidden');
  const pct = t.total ? Math.round((t.counted / t.total) * 100) : 0;
  $('#progressText').textContent = `Посчитано ${t.counted}/${t.total} • сошлось ${t.matched}`;
  $('#progressSums').textContent = `−${t.shortQ} / +${t.surQ}`;
  $('#progressFill').style.width = pct + '%';
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('#search').addEventListener('input', render);
$('#btnClearSearch').onclick = () => { $('#search').value = ''; render(); };
// ---------- голосовой поиск ----------
let _recog = null, _listening = false;
$('#btnVoice').onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert2('Голосовой поиск не поддерживается в этом браузере. На iPhone откройте ссылку через Safari, на Android — через Chrome.'); return; }
  if (_listening && _recog) { try { _recog.stop(); } catch (e) {} return; }
  try {
    _recog = new SR();
    _recog.lang = 'ru-RU';
    _recog.interimResults = false;
    _recog.maxAlternatives = 1;
    _recog.onstart = () => { _listening = true; const b = $('#btnVoice'); b.classList.add('listening'); b.textContent = '🔴'; };
    const stopUi = () => { _listening = false; const b = $('#btnVoice'); b.classList.remove('listening'); b.textContent = '🎤'; };
    _recog.onend = stopUi;
    _recog.onerror = (e) => {
      stopUi();
      const err = (e && e.error) || '';
      if (err === 'not-allowed' || err === 'service-not-allowed') alert2('Нет доступа к микрофону. Разрешите микрофон в настройках браузера и открывайте приложение по https-ссылке.');
      else if (err === 'no-speech') alert2('Не расслышал. Нажмите микрофон и произнесите название или код ещё раз.');
      else if (err && err !== 'aborted') alert2('Микрофон недоступен: ' + err);
    };
    _recog.onresult = (ev) => {
      const txt = (ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript) || '';
      $('#search').value = txt.trim();
      render();
    };
    _recog.start();
  } catch (err) { alert2('Не смог включить микрофон: ' + (err && err.message || err)); }
};
$('#btnEmptyLoad').onclick = () => $('#fileInput').click();

// ---------- menu ----------
const menuPop = $('#menuPop');
$('#btnMenu').onclick = (e) => { e.stopPropagation(); menuPop.classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!menuPop.classList.contains('hidden') && !e.target.closest('#menuPop') && !e.target.closest('#btnMenu')) menuPop.classList.add('hidden'); });
menuPop.querySelectorAll('button').forEach(b => b.onclick = () => { menuPop.classList.add('hidden'); onMenu(b.dataset.act); });

async function onMenu(act) {
  if (act === 'load') $('#fileInput').click();
  if (act === 'clear') {
    if (await confirmDlg('Очистить пересчёт?', 'Удалить все введённые факты? Позиции останутся.')) {
      facts = {}; factColors = {}; persist(); render();
    }
  }
  if (act === 'save') {
    const name = await askText('Сохранить сессию', 'Имя сессии', `ЛР ${new Date().toLocaleDateString()}`);
    if (!name) return;
    sessions[name] = { date: new Date().toISOString(), items, facts, factColors, meta };
    persist(); alert2(`Сессия «${name}» сохранена`);
  }
  if (act === 'sessions') showSessions();
  if (act === 'total') showTotal();
  if (act === 'export') exportFlow();
  if (act === 'finish') finishFlow();
}

async function handleSourceFile(f) {
  if (!f) return;
  if (items.length && !(await confirmDlg('Заменить текущие данные пересчёта?', `Загрузить «${f.name}»? Текущие факты будут потеряны, если сессия не сохранена.`))) return;
  try {
    alert2('Читаю PDF...');
    const { items: parsed, meta: m2, debugLines } = await parsePdf(f);
    closeModal();
    if (!parsed.length) {
      alert2(`Не нашёл позиций (строк: ${debugLines}). Попробуйте печать через Microsoft Print to PDF из 1С.`);
      return;
    }
    items = parsed; facts = {}; factColors = {}; meta = m2;
    recountStart = new Date().toISOString(); LS.set('plr_start', recountStart);
    persist(); render();
    alert2(`Загружено позиций: ${parsed.length}`);
  } catch (err) {
    console.error(err); closeModal();
    alert2('Ошибка чтения PDF: ' + (err && err.message ? err.message : err));
  }
}
$('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; handleSourceFile(f); });

// ---------- modals ----------
function showModal(html) {
  $('#modalBack').classList.remove('hidden');
  $('#modalBox').innerHTML = html;
}
function closeModal() { $('#modalBack').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
function setModalText(t) {
  try { const p = document.querySelector('#modalBox p'); if (p) p.textContent = t; } catch (e) {}
}
$('#modalBack').addEventListener('click', (e) => { if (e.target.id === 'modalBack') closeModal(); });
function alert2(text) { showModal(`<h3>Ревизор</h3><p>${escapeHtml(text)}</p><div class="mrow"><button class="btn primary" onclick="document.querySelector('#modalBack').classList.add('hidden')">ОК</button></div>`); }
function confirmDlg(title, text) {
  return new Promise((res) => {
    showModal(`<h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(text)}</p><div class="mrow"><button class="btn ghost" id="mCancel">Отменить</button><button class="btn primary" id="mOk">ОК</button></div>`);
    $('#mCancel').onclick = () => { closeModal(); res(false); };
    $('#mOk').onclick = () => { closeModal(); res(true); };
  });
}
function askText(title, label, defVal = '') {
  return new Promise((res) => {
    showModal(`<h3>${escapeHtml(title)}</h3><label class="muted">${escapeHtml(label)}</label><input id="mInput" value="${escapeHtml(defVal)}"><div class="mrow"><button class="btn ghost" id="mCancel">Отменить</button><button class="btn primary" id="mOk">ОК</button></div>`);
    const inp = $('#mInput'); inp.focus(); inp.select();
    $('#mCancel').onclick = () => { closeModal(); res(null); };
    $('#mOk').onclick = () => { closeModal(); res(inp.value.trim()); };
  });
}

// ---------- итог ----------
function calcTotal() {
  let counted = 0, matched = 0, shortQ = 0, surQ = 0, shortS = 0, surS = 0, planS = 0, factS = 0;
  const rows = items.map(it => {
    const fraw = facts[it.code];
    const entered = !(fraw === undefined || fraw === '' || fraw === null);
    // пустой факт = 0: непосчитанная позиция целиком уходит в недостачу
    const f = entered ? evalExpr(fraw) : 0;
    const valid = (f !== null && !isNaN(f));
    planS += it.plan * it.priceVal;
    // невведённый факт = 0, но тоже считается (уходит в недостачу)
    if (valid) { counted++; factS += f * it.priceVal; }
    const d = valid ? f - it.plan : null;
    if (valid && d === 0) matched++;
    if (d !== null && d < 0) { shortQ += -d; shortS += -d * it.priceVal; }
    if (d !== null && d > 0) { surQ += d; surS += d * it.priceVal; }
    return { ...it, fact: entered ? (valid ? f : fraw) : null, diff: d, sum: d === null ? null : d * it.priceVal };
  });
  return { rows, counted, matched, shortQ, surQ, shortS, surS, planS, factS, total: items.length };
}
function showTotal() {
  const t = calcTotal();
  const net = t.surS - t.shortS;
  const netQty = t.surQ - t.shortQ;
  const netHtml = net < 0
    ? `<b style="color:var(--red)">−${(-net).toFixed(2)} ₽ (${netQty} шт)</b>`
    : net > 0
      ? `<b style="color:var(--blue)">+${net.toFixed(2)} ₽ (+${netQty} шт)</b>`
      : `<b style="color:var(--green)">0 ₽ (сошлось в ноль)</b>`;
  const mism = t.rows.filter(r => r.diff !== null && r.diff !== 0);
  const rowsHtml = t.rows.map(r => `<tr><td>${r.code}</td><td>${escapeHtml(r.name)}</td><td>${r.price}</td><td>${r.plan}</td><td>${r.fact === undefined || r.fact === null ? '—' : r.fact}</td><td>${r.diff === undefined || r.diff === null ? '—' : r.diff}</td><td>${r.sum === null ? '—' : r.sum.toFixed(2)}</td></tr>`).join('');
  showModal(`
    <h3>📊 Итог</h3>
    <div class="sum-grid">
      <div>Позиций<br><b>${t.total}</b></div>
      <div>Посчитано<br><b>${t.counted}</b></div>
      <div>Сошлось<br><b style="color:var(--green)">${t.matched}</b></div>
      <div>Расхождений<br><b>${mism.length}</b></div>
      <div>Недостача<br><b style="color:var(--red)">−${t.shortQ} шт • ${t.shortS.toFixed(2)} ₽</b></div>
      <div>Излишек<br><b style="color:var(--blue)">+${t.surQ} шт • ${t.surS.toFixed(2)} ₽</b></div>
      <div>Итого (разница)<br>${netHtml}</div>
    </div>
    <div class="muted">План сумма: ${t.planS.toFixed(2)} ₽ • Факт сумма: ${t.factS.toFixed(2)} ₽</div>
    <div style="overflow:auto;max-height:40vh;margin-top:10px"><table><tr><th>Код</th><th>Товар</th><th>Цена</th><th>План</th><th>Факт</th><th>+/-</th><th>Сумма</th></tr>${rowsHtml}</table></div>
    <div class="mrow"><button class="btn ghost" id="mClose">Закрыть</button><button class="btn primary" id="mExp">Скачать PDF</button></div>`);
  $('#mClose').onclick = closeModal;
  $('#mExp').onclick = () => { closeModal(); exportFlow(); };
}

function showSessions() {
  const names = Object.keys(sessions);
  showModal(`<h3>🗂 Сессии (на этом телефоне)</h3>
    ${names.length ? '' : '<p class="muted">Пока нет сохранённых сессий.</p>'}
    ${names.map(n => `<div class="session-row"><div><b>${escapeHtml(n)}</b><br><span class="muted">${escapeHtml(sessions[n].date ? sessions[n].date.slice(0, 16) : '')} • ${(sessions[n].items || []).length} поз.</span></div><div><button class="btn ghost sm" data-load="${escapeHtml(n)}">Открыть</button> <button class="btn ghost sm" data-del="${escapeHtml(n)}">✕</button></div></div>`).join('')}
    <div class="mrow"><button class="btn primary" id="mClose">Закрыть</button></div>`);
  $('#mClose').onclick = closeModal;
  document.querySelectorAll('[data-load]').forEach(b => b.onclick = () => {
    const n = b.getAttribute('data-load');
    const s = sessions[n];
    items = s.items; facts = s.facts || {}; factColors = s.factColors || {}; meta = s.meta || {};
    persist(); closeModal(); show('recount'); render();
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    delete sessions[b.getAttribute('data-del')]; persist(); showSessions();
  });
}

// ---------- настоящий PDF (jsPDF, офлайн, кириллица) ----------
function ensurePdfFontFresh(doc) {
  const b64 = window.__PT_FONT_B64 || null;
  if (!b64) throw new Error('Шрифт не загружен');
  try {
    doc.addFileToVFS('PTSans-Regular.ttf', b64);
    doc.addFont('PTSans-Regular.ttf', 'PTSans', 'normal');
  } catch (e) {}
  doc.setFont('PTSans');
}
function pdfSafeName(name, fallback) {
  let s = (name || fallback || 'revizor.pdf').trim();
  if (!/\.pdf$/i.test(s)) s += '.pdf';
  return s.replace(/[\\/:*?"<>|]/g, '_');
}
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} a.remove(); }, 3000);
}
async function sharePdfFile(file, title, text) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title, text });
      return true;
    }
    if (navigator.share && !navigator.canShare) {
      // некоторые браузеры без canShare, пробуем напрямую
      await navigator.share({ files: [file], title, text });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return true; // пользователь закрыл — считаем успехом
    console.warn('share failed', e);
  }
  return false;
}
function showPdfResult({ fileName, blob, file, subject, bodyText }) {
  window._lastPdf = { fileName, blob, file, subject, bodyText };
  const kb = Math.max(1, Math.round(blob.size / 1024));
  showModal(`<h3>PDF готов: ${escapeHtml(fileName)}</h3>
    <p class="muted">Файл PDF создан на этом устройстве (${kb} КБ). Скачивание уже началось. Его можно отправить на почту или в мессенджер.</p>
    <div class="mrow" style="justify-content:stretch;flex-direction:column;gap:8px">
      <button class="btn primary" id="mShare">📤 Поделиться / отправить на почту</button>
      <button class="btn ghost" id="mDl">⬇ Скачать ещё раз</button>
      <button class="btn ghost" id="mMail">✉ Открыть почту (прикрепить файл)</button>
      <button class="btn ghost" id="mClose">Закрыть</button>
    </div>
    <p class="muted">Почта не умеет принимать вложения по кнопке — после «Открыть почту» прикрепите файл через скрепку 📎. Через «Поделиться» можно выбрать Gmail / Почту / Telegram / WhatsApp сразу с файлом.</p>`);
  $('#mClose').onclick = closeModal;
  $('#mDl').onclick = () => downloadBlob(blob, fileName);
  $('#mMail').onclick = () => {
    const s = encodeURIComponent(subject || fileName);
    const b = encodeURIComponent((bodyText || '') + '\n\nФайл "' + fileName + '" уже скачан — прикрепите его к письму через скрепку.');
    location.href = 'mailto:?subject=' + s + '&body=' + b;
  };
  $('#mShare').onclick = async () => {
    const ok = await sharePdfFile(file, fileName, bodyText || '');
    if (!ok) alert2('Этот браузер не отдал файл в «Поделиться». Файл уже скачан — прикрепите его к письму вручную через скрепку.');
  };
}
function buildPdfDoc({ title, subtitleLines, head, body, footLines, opts, headerLeft, headerRight }) {
  const o = Object.assign({ orientation: 'landscape', headFill: [124, 58, 237], headText: 255, zebra: true, titleCenter: false, fontSize: 7, cellPad: 1.2, marginX: 10, topY: 13, gapY: 7, footSize: 8, colW: null, footRight: false }, opts || {});
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: o.orientation, unit: 'mm', format: 'a4' });
  ensurePdfFontFresh(doc);
  const pageW = o.orientation === 'portrait' ? 210 : 297;
  const textW = pageW - o.marginX * 2;
  let y = o.topY;
  doc.setFontSize(o.titleCenter ? 11 : 13);
  if (o.titleCenter) doc.text(String(title || ''), pageW / 2, y, { align: 'center' });
  else doc.text(String(title || 'Пересчёт'), o.marginX, y);
  y += o.gapY;
  doc.setFontSize(9);
  for (const ln of (subtitleLines || [])) {
    const parts = doc.splitTextToSize(String(ln), textW);
    doc.text(parts, o.marginX, y);
    y += parts.length * 4.2;
  }
  if ((headerLeft && headerLeft.length) || (headerRight && headerRight.length)) {
    doc.setFontSize(8);
    const hl = headerLeft || [], hr = headerRight || [];
    const n = Math.max(hl.length, hr.length);
    for (let i = 0; i < n; i++) {
      if (hl[i]) doc.text(String(hl[i]), o.marginX, y);
      if (hr[i]) doc.text(String(hr[i]), pageW - o.marginX, y, { align: 'right' });
      y += 4;
    }
    y += 1;
  }
  const defaultColW = head.length === 8
    ? { 0: { cellWidth: 9 }, 1: { cellWidth: 15 }, 2: { cellWidth: 'auto' }, 3: { cellWidth: 12 }, 4: { cellWidth: 16 }, 5: { cellWidth: 14 }, 6: { cellWidth: 26 }, 7: { cellWidth: 12 } }
    : { 0: { cellWidth: 10 }, 1: { cellWidth: 16 }, 2: { cellWidth: 'auto' }, 3: { cellWidth: 14 }, 4: { cellWidth: 17 }, 5: { cellWidth: 13 }, 6: { cellWidth: 16 }, 7: { cellWidth: 13 }, 8: { cellWidth: 20 } };
  doc.autoTable({
    startY: y + 1,
    head: [head], body,
    styles: { font: 'PTSans', fontSize: o.fontSize, cellPadding: o.cellPad, minCellHeight: 0, lineColor: [0, 0, 0], lineWidth: 0.12, textColor: [0, 0, 0], valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: o.headFill, textColor: o.headText, font: 'PTSans', fontSize: o.fontSize, lineColor: [0, 0, 0], lineWidth: 0.12, minCellHeight: 0 },
    alternateRowStyles: o.zebra ? { fillColor: [245, 243, 255] } : {},
    columnStyles: o.colW || defaultColW,
    margin: { left: o.marginX, right: o.marginX, top: 8 }
  });
  let fy = doc.lastAutoTable.finalY + 4;
  const maxY = (o.orientation === 'portrait' ? 297 : 210) - 10;
  doc.setFontSize(o.footSize);
  for (const fl of (footLines || [])) {
    if (fy > maxY) { doc.addPage(); fy = 13; }
    const parts = doc.splitTextToSize(String(fl), textW);
    if (o.footRight) doc.text(parts, pageW - o.marginX, fy, { align: 'right' });
    else doc.text(parts, o.marginX, fy);
    fy += parts.length * 4;
  }
  return doc;
}

// ---------- общий формат выгрузки (как «Скачать PDF») ----------
function buildExportPdf(t, group, who, dateStr) {
  if (!window.jspdf) throw new Error('jsPDF не загрузился. Откройте через http:// или проверьте vendor/');
  const head = ['№', 'Код', 'Товар', 'Разм.', 'Цена', 'План', 'Факт', '+/-', 'Сумма, ₽'];
  const body = t.rows.map((r, i) => [
    String(i + 1), String(r.code), String(r.name), String(r.size || ''),
    String(r.price), String(r.plan),
    r.fact == null ? '' : String(r.fact),
    r.diff == null ? '' : String(r.diff),
    r.sum == null ? '' : r.sum.toFixed(2)
  ]);
  const net = t.surS - t.shortS;
  return buildPdfDoc({
    title: `Пересчёт — ${group || 'ЛР'} (${dateStr})`,
    subtitleLines: [
      `Магазин: ${meta.store || ''}   Кто считал: ${who || ''}`,
      `Источник: ${meta.title || ''}`,
      `Позиций: ${t.total}, посчитано: ${t.counted}, сошлось: ${t.matched}. Недостача: -${t.shortQ} шт (${t.shortS.toFixed(2)} Р). Излишек: +${t.surQ} шт (${t.surS.toFixed(2)} Р). Итого (разница): ${(net >= 0 ? '+' : '-') + Math.abs(net).toFixed(2)} Р.`
    ],
    head, body,
    footLines: [`Подпись: ________________ / ${who || ''} /`]
  });
}

// ---------- export (настоящий PDF-файл) ----------
async function exportFlow() {
  if (!items.length) { alert2('Нет данных для выгрузки. Сначала загрузите PDF.'); return; }
  const fileName = await askText('Введите имя файла', 'Имя файла', 'Revizor.pdf');
  if (fileName === null) return;
  const group = await askText('Введите название группы', 'Группа (например: Водка)', '');
  if (group === null) return;
  const who = await askText('Кто считал?', 'ФИО / должность', '');
  if (who === null) return;
  const t = calcTotal();
  const dateStr = new Date().toLocaleString('ru-RU');
  const safeName = pdfSafeName(fileName, 'Revizor.pdf');
  document.title = safeName.replace(/\.pdf$/i, '');
  alert2('Формирую PDF...');
  try {
    await ensureExportLibs(setModalText);
    setModalText('Собираю PDF...');
    const { doc } = buildActPdf(t, group, who);
    const blob = doc.output('blob');
    const file = new File([blob], safeName, { type: 'application/pdf' });
    closeModal();
    downloadBlob(blob, safeName);
    showPdfResult({
      fileName: safeName, blob, file,
      subject: `Пересчёт ${group || 'ЛР'} — ${dateStr}`,
      bodyText: `Пересчёт ${group || 'ЛР'} от ${dateStr}. Позиций: ${t.total}, недостача ${t.shortQ} шт, излишек ${t.surQ} шт. Файл PDF во вложении.`
    });
  } catch (err) {
    console.error(err); closeModal();
    alert2('Не смог создать PDF: ' + (err && err.message || err));
  }
}

// ---------- акт как на фото (общий формат обеих кнопок) ----------
function buildActPdf(t, group, who) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtT = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const t1 = recountStart ? fmtT(new Date(recountStart)) : fmtT(now);
  const t2 = fmtT(now);
  const d1 = recountStart ? new Date(recountStart).toLocaleDateString('ru-RU') : now.toLocaleDateString('ru-RU');
  const d2 = now.toLocaleDateString('ru-RU');
  const netFin = t.surS - t.shortS;
  const netFinStr = (netFin < 0 ? '-' : '+') + Math.abs(netFin).toFixed(2) + ' Р';
  // как на фото: 8 колонок, Факт — сырой ввод (5+3, 6+10), Разн. — только количество, пусто если сошлось
  const head = ['№', 'Артикул', 'Название', 'Ед.', 'Цена', 'Остаток', 'Факт', 'Разн.'];
  const body = t.rows.map((r) => {
      const raw = (facts[r.code] === undefined || facts[r.code] === null) ? '' : facts[r.code];
    let diffStr = '';
    if (r.diff !== null && r.diff !== 0) diffStr = r.diff > 0 ? '+' + r.diff : String(r.diff);
    return [String(r.n), String(r.code), String(r.name), String(r.size || ''), String(r.price).replace(',', '.'), String(r.plan), String(raw), diffStr];
  });
  const doc = buildPdfDoc({
    title: `${group || 'ЛР'}`,
    subtitleLines: [],
    head, body,
    headerLeft: [
      `Недостача: -${t.shortS.toFixed(2)} руб.`,
      `Излишек: +${t.surS.toFixed(2)} руб.`,
      `Разница: ${(netFin < 0 ? '-' : '+') + Math.abs(netFin).toFixed(2)} руб.`
    ],
    headerRight: [
      `Считал: ${who || ''}`,
      `Начало: ${d1} ${t1}`,
      `Конец: ${d2} ${t2}`
    ],
    footLines: [],
    opts: { orientation: 'portrait', headFill: [255, 255, 255], headText: [0, 0, 0], zebra: false, titleCenter: true, fontSize: 6.5, cellPad: 0.8, marginX: 6, topY: 10, gapY: 4, footSize: 7, footRight: true, colW: { 0: { cellWidth: 8 }, 1: { cellWidth: 14 }, 2: { cellWidth: 'auto' }, 3: { cellWidth: 11 }, 4: { cellWidth: 15 }, 5: { cellWidth: 12 }, 6: { cellWidth: 24 }, 7: { cellWidth: 11 } } }
  });
  return { doc, dateStr, t1, t2, netFinStr };
}

// ---------- завершить: акт как на фото (второй формат) ----------
async function finishFlow() {
  if (!items.length) { alert2('Нет данных для выгрузки. Сначала загрузите PDF.'); return; }
  const t = calcTotal();
  const enteredCount = Object.keys(facts).filter(k => facts[k] !== '').length;
  if (!enteredCount) {
    if (!(await confirmDlg('Ничего не посчитано', 'Ни один факт не введён. Всё равно сформировать акт?'))) return;
  }
  const lastGroup = LS.get('plr_group', 'Пиво');
  const lastWho = LS.get('plr_who', '');
  const fileName = await askText('Введите имя файла', 'Имя файла', 'Акт_пересчета.pdf');
  if (fileName === null) return;
  const group = await askText('Введите название группы', 'Группа (например: Пиво)', lastGroup || 'Пиво');
  if (group === null) return;
  const who = await askText('Кто считал?', 'ФИО / должность', lastWho || '');
  if (who === null) return;
  LS.set('plr_group', group); LS.set('plr_who', who);
  const safeName = pdfSafeName(fileName, 'Акт_пересчета.pdf');
  document.title = safeName.replace(/\.pdf$/i, '');
  alert2('Формирую акт PDF...');
  try {
    await ensureExportLibs(setModalText);
    setModalText('Собираю PDF...');
    const { doc, dateStr, t1, t2, netFinStr } = buildActPdf(t, group, who);
    const blob = doc.output('blob');
    const file = new File([blob], safeName, { type: 'application/pdf' });
    closeModal();
    downloadBlob(blob, safeName);
    showPdfResult({
      fileName: safeName, blob, file,
      subject: `Акт пересчёта ${group || 'ЛР'} — ${dateStr}`,
      bodyText: `Акт пересчёта ${group || 'ЛР'} от ${dateStr} (с ${t1} по ${t2}). Считал: ${who || ''}. Итог: ${netFinStr}. Файл PDF во вложении.`
    });
  } catch (err) {
    console.error(err); closeModal();
    alert2('Не смог создать PDF: ' + (err && err.message || err));
  }
}

// ---------- фонарик ----------
$('#btnTorch').onclick = async () => {
  try {
    if (torchOn && torchStream) {
      torchStream.getTracks().forEach(t => t.stop());
      torchStream = null; torchOn = false;
      $('#btnTorch').textContent = '🔦';
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const track = stream.getVideoTracks()[0];
    const ok = await track.applyConstraints({ advanced: [{ torch: true }] }).then(() => true).catch(() => false);
    if (!ok) { stream.getTracks().forEach(t => t.stop()); alert2('Фонарик не поддерживается в этом браузере (на iPhone Safari torch недоступен — включите вручную).'); return; }
    torchStream = stream; torchOn = true;
    $('#torchVideo').srcObject = stream;
    $('#btnTorch').textContent = '🔦 выкл';
  } catch (e) {
    alert2('Нет доступа к камере/фонарику: ' + (e && e.message ? e.message : e));
  }
};

// init
const verEl = document.getElementById('appVer');
if (verEl) verEl.textContent = 'v' + APP_VERSION;
show(items.length ? 'recount' : 'home');
if (items.length) render();

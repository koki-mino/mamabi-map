// ====== 診断（環境チェック） ======
async function renderDiag() {
  const rows = [];
  rows.push(`URL: ${location.href}`);
  rows.push(`isSecureContext: ${window.isSecureContext}`);
  rows.push(`geolocation in navigator: ${'geolocation' in navigator}`);
  try {
    if (navigator.permissions?.query) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      rows.push(`permissions.query('geolocation'): ${st.state}`);
    } else {
      rows.push(`permissions.query: (unsupported)`);
    }
  } catch (e) {
    rows.push('permissions.query error: ' + e.message);
  }
  rows.push(`Leaflet loaded: ${!!window.L}`);
  document.getElementById('diag').textContent = rows.join('\n');
}

// ====== ユーティリティ ======
const rad = d => d * Math.PI / 180;
const haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureGeoReady() {
  if (!('geolocation' in navigator)) throw new Error('この端末/ブラウザは位置情報に対応していません');
  const isLocalhost = ['localhost','127.0.0.1','::1'].includes(location.hostname);
  if (!window.isSecureContext && !isLocalhost) throw new Error('HTTPS（またはlocalhost）で開いてください');
  try {
    if (navigator.permissions?.query) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      if (st.state === 'denied') throw new Error('ブラウザで位置情報がブロックされています（サイト設定で許可）');
    }
  } catch { /* noop */ }
}

// ====== 状態 ======
let SPOTS = [];                      // data/spots.json を読み込む
let currentSpotId = null;
let map, markers = {};
const $ = sel => document.querySelector(sel);

// 永続化
const LS_KEY = 'ashikaga_manabi_mvp_v2';
const loadState = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || { stamps:{} }; } catch { return { stamps:{} }; } };
const saveState = (st) => localStorage.setItem(LS_KEY, JSON.stringify(st));
let appState = loadState();

// ====== 地図 ======
function initMap() {
  const center = [36.34015, 139.44970]; // 足利中心付近
  map = L.map('map').setView(center, 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // 初期表示直後のレイアウト修正（追加）
  setTimeout(() => map.invalidateSize(), 0);

  SPOTS.forEach(s => {
    const m = L.marker([s.lat, s.lng]).addTo(map).bindPopup(`<b>${s.name}</b><br/>半径${s.radius_m}m`);
    m.on('click', () => selectSpot(s.id));
    markers[s.id] = m;
  });
}

// ====== タブ切替 ======
function switchTab(key) {
  const secIds = ['sec-map','sec-stamps','sec-help'];
  const tabs = ['tab-map','tab-stamps','tab-help'];
  secIds.forEach((id,i)=>{
    const el = $('#'+id), btn = $('#'+tabs[i]), on = (i===key);
    el.classList.toggle('hidden', !on);
    btn.classList.toggle('bg-gray-900', on);
    btn.classList.toggle('text-white', on);
    btn.classList.toggle('hover:bg-gray-200', !on);
  });
  // マップタブを表示した直後にサイズ再計算（追加）
  if (key === 0 && map) setTimeout(() => map.invalidateSize(), 0);
  if (key === 1) renderStamps();
}

// ====== スポット一覧 ======
function renderSpotList() {
  const list = $('#spot-list'); list.innerHTML = '';
  SPOTS.forEach(s => {
    const unlocked = !!appState.stamps[s.id]; // ※スタンプ獲得済み = 解錠済み表示
    const row = document.createElement('button');
    row.className = 'w-full text-left px-3 py-2 rounded-xl border hover:bg-gray-50 flex items-center justify-between';
    row.innerHTML = `
      <div>
        <div class="font-medium">${s.name}</div>
        <div class="text-xs text-gray-500">${s.themes.join('・')}｜半径${s.radius_m}m</div>
      </div>
      <div class="text-xs px-2 py-1 rounded ${unlocked? 'bg-emerald-100 text-emerald-700':'bg-gray-100 text-gray-600'}">
        ${unlocked? '解錠済' : '未解錠'}
      </div>`;
    row.addEventListener('click', ()=>{
      selectSpot(s.id);
      if (map) map.setView([s.lat,s.lng], 17);
    });
    list.appendChild(row);
  });
}

function selectSpot(id) {
  currentSpotId = id;
  const s = SPOTS.find(x=>x.id===id);
  $('#spot-title').textContent = s.name;
  $('#spot-themes').textContent = s.themes.join('・');
  $('#spot-radius').textContent = s.radius_m;
  $('#spot-desc').textContent = s.long;
  $('#spot-caution span').textContent = s.caution;

  // パネルの解錠ステータスは現在の訪問で更新
  const stamped = !!appState.stamps[id];
  setUnlockStatus(stamped ? '解錠済' : '未解錠');

  // スタンプ獲得（=合格）前はクイズ開始を許可しない
  $('#btn-quiz').disabled = !stamped;

  $('#spot-panel').classList.remove('hidden');
  $('#quiz-panel').classList.add('hidden');

  // パネルを表示した際にも一応補正
  if (map) setTimeout(()=>map.invalidateSize(), 0);
}

function setUnlockStatus(label) {
  const el = $('#unlock-status');
  el.textContent = label;
  el.className = 'mt-1 inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm ' +
    (label==='解錠済' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-700');
}

// ====== 測位（複数サンプル） ======
async function samplePositions(n=3, interval=1200) {
  const once = (timeout=10000) => new Promise((resolve, reject) => {
    let done = false; let watchId = null;
    const timer = setTimeout(() => { if (!done) { done = true; if (watchId!==null) navigator.geolocation.clearWatch(watchId); reject(new Error('timeout')); } }, timeout+2000);
    const opts = { enableHighAccuracy: true, maximumAge: 10000, timeout };
    const finish = (p) => { if (!done) { done = true; clearTimeout(timer); if (watchId!==null) navigator.geolocation.clearWatch(watchId); resolve(p); } };
    watchId = navigator.geolocation.watchPosition(finish, ()=>{}, opts);
    navigator.geolocation.getCurrentPosition(finish, ()=>{}, opts);
  });

  const samples = []; const log = [];
  for (let i=0;i<n;i++) {
    try {
      const p = await once(10000);
      const { latitude:lat, longitude:lng, accuracy } = p.coords; const t = p.timestamp;
      samples.push({ lat, lng, accuracy, t });
      log.push(`#${i+1}: lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}, acc~${Math.round(accuracy)}m`);
    } catch (e) {
      log.push(`#${i+1}: 測位エラー (${e.message})`);
    }
    if (i < n-1) await sleep(interval);
  }
  return { samples, log: log.join('\n') };
}

function avgPosition(samples) {
  if (!samples.length) return null;
  const good = samples.filter(s=>s.accuracy<=50);
  const base = (good.length? good : samples);
  const lat = base.reduce((a,b)=>a+b.lat,0)/base.length;
  const lng = base.reduce((a,b)=>a+b.lng,0)/base.length;
  let avgSpeed = null;
  if (samples.length>=2) {
    const a = samples[samples.length-2], b = samples[samples.length-1];
    const d = haversine(a.lat,a.lng,b.lat,b.lng); const dt = Math.max(1,(b.t-a.t)/1000); avgSpeed = d/dt;
  }
  const acc = Math.round(samples.reduce((a,b)=>a+b.accuracy,0)/samples.length);
  return { lat, lng, accuracy: acc, avgSpeed };
}

async function tryUnlock() {
  if (!currentSpotId) return;
  const s = SPOTS.find(x=>x.id===currentSpotId);
  const logEl = $('#loc-log');
  logEl.textContent = '環境チェック中…';

  try { await ensureGeoReady(); }
  catch (e) {
    alert(e.message + '\n\n対処: (1) HTTPSで開く / (2) サイト設定で位置情報を許可 / (3) 端末の位置情報をON');
    logEl.textContent = 'NG: ' + e.message; return;
  }

  logEl.textContent = '測位中…（屋外で数秒お待ちください）';

  try {
    const { samples, log } = await samplePositions(3, 1200);
    logEl.textContent = log;
    if (!samples.length) { alert('位置情報が取得できませんでした。屋外や窓際で再試行してください。'); return; }
    const p = avgPosition(samples);
    const dist = haversine(p.lat, p.lng, s.lat, s.lng);
    const speedOk = (p.avgSpeed===null) ? true : (p.avgSpeed <= 2.0);
    const accOk = p.accuracy <= 100;
    const within = dist <= s.radius_m;
    const msg = `\n平均位置: lat=${p.lat.toFixed(6)}, lng=${p.lng.toFixed(6)}\n推定精度≈${p.accuracy}m, 移動速度≈${p.avgSpeed? p.avgSpeed.toFixed(2):'-'}m/s\n距離=${Math.round(dist)}m / 閾値=${s.radius_m}m`;
    logEl.textContent += '\n' + msg;

    if (within && speedOk && accOk) {
      // ★ 変更点：ここではスタンプを付与しない（クイズ合格時に付与）
      setUnlockStatus('解錠済');
      // クイズを解放
      $('#btn-quiz').disabled = false;
      alert('解錠しました！クイズに挑戦できます。');
    } else {
      let reason = [];
      if (!within) reason.push('距離が遠い');
      if (!speedOk) reason.push('速度が速い');
      if (!accOk) reason.push('精度が低い');
      alert('解錠条件を満たしていません。' + (reason.length? `（${reason.join('・')}）` : ''));
    }
  } catch (e) {
    alert('測位に失敗しました。端末の位置情報設定を確認し、屋外で再試行してください。');
    logEl.textContent += '\nERR: ' + e.message;
  }
}

// ====== クイズ ======
function startQuiz() {
  const s = SPOTS.find(x=>x.id===currentSpotId);
  let idx = 0, score = 0;
  $('#quiz-panel').classList.remove('hidden');

  const renderQ = () => {
    const q = s.quiz[idx];
    const el = document.createElement('div');
    el.className = 'bg-gray-50 rounded-xl p-4';
    el.innerHTML = `
      <div class="text-sm text-gray-600">${s.name} ／ Q${idx+1}/3</div>
      <div class="mt-1 text-lg font-semibold">${q.q}</div>
      <div class="mt-3 grid gap-2">
        ${q.choices.map((c,i)=>`<button data-i="${i}" class="ans px-3 py-2 rounded-lg border hover:bg-white text-left">${c}</button>`).join('')}
      </div>`;
    const body = $('#quiz-body'); body.innerHTML = ''; body.appendChild(el);

    body.querySelectorAll('.ans').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        const i = Number(ev.currentTarget.getAttribute('data-i'));
        const correct = i === q.ans; if (correct) score++;
        const note = document.createElement('div');
        note.className = 'mt-3 text-sm rounded-lg ' + (correct? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800');
        note.textContent = (correct? '正解！ ' : '不正解 ') + '— ' + q.exp;
        body.appendChild(note);
        const next = document.createElement('button');
        next.className = 'mt-3 px-4 py-2 rounded-lg bg-indigo-600 text-white';
        next.textContent = (idx<2)? '次へ' : '結果を見る';
        next.addEventListener('click', ()=>{ if (idx<2) { idx++; renderQ(); } else { showResult(); } });
        body.appendChild(next);
        body.querySelectorAll('.ans').forEach(b=>b.disabled = true);
      });
    });
  };

  const showResult = () => {
    const pass = score >= 2;
    $('#quiz-body').innerHTML = `
      <div class="text-center p-6">
        <div class="text-2xl font-bold ${pass?'text-emerald-600':'text-rose-600'}">${pass?'合格！':'もう一歩'}</div>
        <div class="mt-1 text-gray-700">スコア：${score} / 3</div>
        <div class="mt-2 text-gray-600">${pass? 'スタンプを獲得しました。' : 'もう一度挑戦してみよう！'}</div>
        <div class="mt-4 flex gap-2 justify-center">
          <button id="btn-again" class="px-4 py-2 rounded-lg border">もう一度</button>
          <button id="btn-close" class="px-4 py-2 rounded-lg bg-gray-900 text-white">閉じる</button>
        </div>
      </div>`;

    // ★ 変更点：クイズ合格時にスタンプ付与
    if (pass && !appState.stamps[s.id]) {
      appState.stamps[s.id] = { at: Date.now() };
      saveState(appState);
      renderSpotList();            // リストの「解錠済」表示を反映
      setUnlockStatus('解錠済');   // パネル側も明示
      $('#btn-quiz').disabled = false;
    }

    $('#btn-again').addEventListener('click', ()=>{ idx=0; score=0; renderQ(); });
    $('#btn-close').addEventListener('click', ()=>{ $('#quiz-panel').classList.add('hidden'); });
  };

  renderQ();
}

// ====== スタンプ帳 ======
function renderStamps() {
  const grid = $('#stamp-grid'); grid.innerHTML = '';
  const keys = Object.keys(appState.stamps);
  $('#stamp-count').textContent = keys.length;
  $('#badge-label').textContent =
    keys.length>=20? 'まち案内人' :
    keys.length>=10? '足利博士' :
    keys.length>=3 ? 'はじめの一歩' : 'なし';

  SPOTS.forEach(s => {
    const got = !!appState.stamps[s.id];
    const card = document.createElement('div');
    card.className = 'rounded-xl border p-3 ' + (got? 'bg-emerald-50 border-emerald-200' : 'bg-white');
    card.innerHTML = `<div class="font-medium">${s.name}</div><div class="text-xs text-gray-500">${s.themes.join('・')}</div>`;
    grid.appendChild(card);
  });
}

// ====== 初期化 ======
async function boot() {
  await renderDiag();

  // In-app ブラウザ注意を軽く
  (() => {
    const ua = navigator.userAgent.toLowerCase();
    if (/line|instagram|fbav|fb_iab|tiktok/.test(ua)) {
      document.getElementById('diag').textContent += '\n⚠ アプリ内ブラウザでは位置情報が拒否されることがあります。右上のメニューから「ブラウザで開く」を選んでください。';
    }
  })();

  // データ読み込み
  SPOTS = await fetch('./data/spots.json').then(r => r.json());

  // UIイベント
  document.getElementById('tab-map').addEventListener('click', ()=>switchTab(0));
  document.getElementById('tab-stamps').addEventListener('click', ()=>switchTab(1));
  document.getElementById('tab-help').addEventListener('click', ()=>switchTab(2));
  document.getElementById('btn-here').addEventListener('click', tryUnlock);
  document.getElementById('btn-quiz').addEventListener('click', startQuiz);
  document.getElementById('btn-quit-quiz').addEventListener('click', ()=>$('#quiz-panel').classList.add('hidden'));

  // 地図 & リスト
  initMap();
  renderSpotList();
  switchTab(0);
}
boot();

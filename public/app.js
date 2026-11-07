'use strict';
/* ============================================================
   Onde — lecteur de musique (fichiers locaux + YouTube + Spotify)
   ============================================================ */

// ---------- utilitaires ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, cls = '') => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const native = () => window.pywebview && window.pywebview.api;
const imgProxy = u => '/api/img?u=' + encodeURIComponent(u);
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const MEDIA_RE = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba|mp4|m4v|webm|mkv|mov)$/i;
const VIDEO_RE = /\.(mp4|m4v|webm|mkv|mov)$/i;

function fmt(s) {
  if (!isFinite(s) || s <= 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}
function fmtLong(s) {
  const m = Math.round(s / 60);
  if (m < 1) return '';
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------- état ----------
const DEF_SETTINGS = {
  volume: 0.8, muted: false, shuffle: false, repeat: 'off', layout: 'grid', sort: 'added',
  ytDownload: 'mp3',   // liens YouTube ajoutés : 'mp3' | 'mp4' | 'off' (streaming)
  spMode: 'yt',        // titres Spotify : 'yt' (en entier via YouTube) | 'spotify' (lecteur Spotify)
  spDownload: false,   // télécharger aussi les titres Spotify
  closeToTray: true,   // fermer la fenêtre = la musique continue (icône près de l'heure)
  discord: true,       // afficher "Écoute Onde" sur ton profil Discord
  mic: false,          // envoyer la musique dans un micro virtuel (VB-Cable)
  micOut: '',          // nom du périphérique de sortie du câble virtuel
  micVoice: true,      // mélanger ta vraie voix avec la musique
  micIn: '',           // nom de ton vrai micro ('' = micro par défaut)
  micVol: 0.6,         // volume de la musique dans le micro
};
const S = { items: [], playlists: [], settings: { ...DEF_SETTINGS }, last: null };
let view = 'home';
let query = '';
const byId = id => S.items.find(i => i.id === id);

let saveTimer, loaded = false;
function save() {
  if (!loaded) return; // jamais écraser la bibliothèque avant de l'avoir chargée
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 200);
}
function flushSave(beacon = false) {
  clearTimeout(saveTimer);
  if (!loaded) return;
  // tout est gardé : page ouverte, panneaux, file d'attente, position dans le son…
  S.settings.view = view;
  S.settings.immersive = document.body.classList.contains('immersive');
  S.settings.nowHidden = document.body.classList.contains('now-hidden');
  S.queue = { ids: P.queue.slice(0, 2000), base: P.base.slice(0, 2000), idx: P.idx };
  if (P.cur && P.eng) S.last = { id: P.cur.id, t: P.eng.time() || (S.last && S.last.t) || 0 };
  S.rev = Math.max(Date.now(), (S.rev || 0) + 1); // le serveur refuse toute version plus ancienne
  const body = JSON.stringify(S);
  if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/library', new Blob([body], { type: 'application/json' }));
  else fetch('/api/library', { method: 'PUT', body, keepalive: body.length < 60000 }).catch(() => {});
}
// sauvegarde finale quand tu fermes la fenêtre
addEventListener('pagehide', () => flushSave(true));
addEventListener('beforeunload', () => flushSave(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

const SRC = {
  local: { label: 'Fichier', icon: 'music', cls: 'loc' },
  video: { label: 'Vidéo', icon: 'video', cls: 'vid' },
  youtube: { label: 'YouTube', icon: 'youtube', cls: 'yt' },
  spotify: { label: 'Spotify', icon: 'spotify', cls: 'sp' },
};
const srcOf = it => it.type === 'local' ? (it.kind === 'video' ? SRC.video : SRC.local) : SRC[it.type];
// Les titres Spotify sont joués en entier via la même chanson trouvée sur YouTube
// (le lecteur Spotify intégré ne donne que 30 s sans compte connecté).
const viaYT = it => !!it && it.type === 'spotify' && /^spotify:track:/.test(it.spUri || '')
  && (it.spNative === false || (it.spNative !== true && S.settings.spMode !== 'spotify'));
const canDownload = it => !!it && ((it.type === 'youtube' && !!it.ytId) || (it.type === 'spotify' && it.spType === 'track'));
const plCover = p => (p.cover ? { cover: p.cover, title: p.name } : byId(p.items[0]) || { title: p.name });

const VIEWS = {
  home: { name: 'Accueil', icon: 'home' },
  community: { name: 'Communauté', icon: 'users' },
  all: { name: 'Bibliothèque', icon: 'library', filter: () => true },
  fav: { name: 'Favoris', icon: 'heart', filter: i => i.fav, art: 'fav', hue: 330 },
  local: { name: 'Mes sons', icon: 'music', filter: i => i.type === 'local' && i.kind !== 'video' },
  video: { name: 'Vidéos', icon: 'video', filter: i => i.type === 'local' && i.kind === 'video', art: 'vid', cls: 'vid', hue: 210 },
  youtube: { name: 'YouTube', icon: 'youtube', filter: i => i.type === 'youtube', art: 'yt', cls: 'yt', hue: 355 },
  spotify: { name: 'Spotify', icon: 'spotify', filter: i => i.type === 'spotify', art: 'sp', cls: 'sp', hue: 145 },
};

// ---------- pochettes ----------
function coverHTML(it, extra = '') {
  let inner;
  if (it && it.cover) {
    inner = `<img src="${esc(it.cover)}" ${it.coverFb ? `data-fb="${esc(it.coverFb)}"` : ''} alt="" loading="lazy" draggable="false">`;
  } else {
    const h = hash((it && it.title) || 'onde') % 360;
    inner = `<div class="gen" style="--g1:${h};--g2:${(h + 70) % 360}">${ic(it && it.kind === 'video' ? 'video' : 'music')}</div>`;
  }
  return `<div class="cover">${inner}${extra}</div>`;
}
document.addEventListener('error', e => {
  const t = e.target;
  if (t.tagName !== 'IMG') return;
  if (t.dataset.fb) { t.src = t.dataset.fb; delete t.dataset.fb; }
  else if (t.closest('.cover')) t.style.visibility = 'hidden';
}, true);

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function colorHue(src) {
  return new Promise(res => {
    if (!src) return res(null);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        let sx = 0, sy = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
          const wt = s * s * (l > 0.15 && l < 0.85 ? 1 : 0.1);
          sx += Math.cos(h * 2 * Math.PI) * wt; sy += Math.sin(h * 2 * Math.PI) * wt; w += wt;
        }
        if (w < 3) return res(null);
        let hue = Math.atan2(sy, sx) / (2 * Math.PI) * 360;
        if (hue < 0) hue += 360;
        res(Math.round(hue));
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = src;
  });
}
async function hueFor(it) {
  let h = await colorHue(it.cover);
  if (h == null && it.coverFb) h = await colorHue(it.coverFb);
  return h;
}
let curHue = 262;
function setHue(h) {
  curHue = h;
  document.documentElement.style.setProperty('--h', h);
}
async function applyHue(it) {
  if (!it) return setHue(262);
  if (it.hue == null && it.cover) { it.hue = await hueFor(it); save(); }
  if (P.cur !== it) return;
  setHue(it.hue != null ? it.hue : hash(it.title || '') % 360);
}

// ---------- vues ----------
function sortList(list, mode = S.settings.sort) {
  const l = list.slice();
  const cmp = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }),
    artist: (a, b) => (a.artist || '~').localeCompare(b.artist || '~', 'fr', { sensitivity: 'base' }) || a.title.localeCompare(b.title, 'fr'),
    plays: (a, b) => (b.plays || 0) - (a.plays || 0),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0),
  }[mode];
  return cmp ? l.sort(cmp) : l;
}
function currentPlaylist() { return view.startsWith('pl:') ? S.playlists.find(p => 'pl:' + p.id === view) : null; }
function viewItems() {
  let list;
  const pl = currentPlaylist();
  if (pl) list = pl.items.map(byId).filter(Boolean);
  else list = S.items.filter((VIEWS[view] && VIEWS[view].filter) || (() => true));
  if (query) {
    const q = norm(query).trim().split(/\s+/);
    list = list.filter(i => { const t = norm(`${i.title} ${i.artist} ${i.album || ''}`); return q.every(w => t.includes(w)); });
  }
  if (!(pl && S.settings.sort === 'added')) list = sortList(list);
  return list;
}
function setView(v) {
  view = v;
  if (v === 'home') { query = ''; $('#search').value = ''; }
  closeMenu();
  renderNav();
  renderMain();
  $('#content').scrollTop = 0;
  if (matchMedia('(max-width:1280px)').matches) document.body.classList.remove('now-open');
  if (v === 'community') loadFeed();
  save();
}

// ---------- rendu ----------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNav(); renderMain(); renderQueue(); });
}

function renderNav() {
  $('#nav').innerHTML = Object.entries(VIEWS).map(([k, v]) => {
    const n = v.filter ? S.items.filter(v.filter).length : null;
    return `<button class="nav-item ${view === k ? 'active' : ''}" data-view="${k}" title="${v.name}">${ic(v.icon, v.cls || '')}<span>${v.name}</span>${n != null ? `<span class="count">${n}</span>` : ''}</button>`;
  }).join('');
  $('#playlists').innerHTML = S.playlists.length
    ? S.playlists.map(p => {
      return `<button class="pl-item ${view === 'pl:' + p.id ? 'active' : ''}" data-view="pl:${p.id}" title="${esc(p.name)}">
        <div class="pl-cover">${coverHTML(plCover(p))}</div>
        <span class="pl-name">${esc(p.name)}<span class="pl-sub">${plural(p.items.length, 'son')}</span></span></button>`;
    }).join('')
    : `<div class="pl-empty">Aucune playlist pour l'instant</div>`;
}

function cardHTML(it) {
  const s = srcOf(it), cur = P.cur && P.cur.id === it.id;
  const badge = it.type !== 'local' || it.kind === 'video' ? `<span class="badge ${s.cls}">${ic(s.icon)}${s.label}</span>` : '';
  const eq = cur ? '<span class="eq"><i></i><i></i><i></i></span>' : '';
  const btn = `<button class="card-play" data-act="play-item" title="Lire">${ic(cur && P.playing ? 'pause' : 'play')}</button>`;
  const dl = DL.has(it.id) ? `<span class="dl-badge" title="Téléchargement">${ic('download')}<span class="dl-pct">${dlPct(it.id)}</span></span>` : '';
  return `<div class="card ${cur ? 'current' : ''}" data-id="${it.id}">${coverHTML(it, badge + eq + dl + btn)}
    <div class="card-title" title="${esc(it.title)}">${esc(it.title)}</div>
    <div class="card-sub">${esc(it.artist || s.label)}</div></div>`;
}
function rowHTML(it, n) {
  const s = srcOf(it), cur = P.cur && P.cur.id === it.id;
  return `<div class="row ${cur ? 'current' : ''}" data-id="${it.id}">
    <div class="num">${cur ? '<span class="eq"><i></i><i></i><i></i></span>' : `<em class="n">${n}</em>`}${ic(cur && P.playing ? 'pause' : 'play')}</div>
    <div class="row-main">${coverHTML(it)}<div class="row-text"><div class="row-title">${esc(it.title)}</div><div class="row-artist">${esc(it.artist || '—')}</div></div></div>
    <div class="row-src">${DL.has(it.id) ? `<span class="dl">${ic('download')}<span class="dl-pct">${dlPct(it.id)}</span></span>` : ic(s.icon, s.cls) + s.label}</div>
    <div class="row-dur">${it.duration ? fmt(it.duration) : '—'}</div>
    <div class="row-acts">
      <button class="icon-btn sm heart ${it.fav ? 'on' : ''}" data-act="fav" title="Favori">${ic('heart')}</button>
      <button class="icon-btn sm" data-act="more" title="Plus">${ic('more')}</button>
    </div></div>`;
}
function listHTML(list) {
  if (S.settings.layout === 'list') {
    return `<div class="rows"><div class="row-head"><div style="text-align:center">#</div><div>Titre</div><div class="h-src">Source</div><div style="text-align:right">${ic('clock')}</div><div></div></div>
      ${list.map((it, i) => rowHTML(it, i + 1)).join('')}</div>`;
  }
  return `<div class="grid">${list.map(cardHTML).join('')}</div>`;
}

function emptyHTML() {
  return `<div class="empty">
    <div class="empty-art">${ic('music')}</div>
    <h2>Ta bibliothèque est vide</h2>
    <p>Glisse tes MP3 / MP4 n'importe où dans la fenêtre, ou colle un lien YouTube ou Spotify avec <b>Ctrl + V</b>.</p>
    <div class="btns">
      <button class="btn white" data-act="add-files">${ic('upload')}Ajouter des fichiers</button>
      <button class="btn" data-act="add-folder">${ic('folder')}Importer un dossier</button>
      <button class="btn primary" data-act="add-link">${ic('link')}Ajouter un lien</button>
    </div></div>`;
}

function homeHTML() {
  if (!S.items.length) return emptyHTML();
  const h = new Date().getHours();
  const greet = h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
  const tileDefs = [
    { v: 'fav', bg: 'linear-gradient(135deg,#ff4fa3,#7c5cff)', icon: 'heart' },
    { v: 'local', bg: 'var(--grad)', icon: 'music' },
    { v: 'youtube', bg: 'linear-gradient(135deg,#ff3d4f,#ff8a3d)', icon: 'youtube' },
    { v: 'spotify', bg: 'linear-gradient(135deg,#1ed760,#0f8f8a)', icon: 'spotify' },
    { v: 'video', bg: 'linear-gradient(135deg,#4fb3ff,#7c5cff)', icon: 'video' },
  ];
  const tiles = tileDefs.map(t => ({ ...t, n: S.items.filter(VIEWS[t.v].filter).length })).filter(t => t.n > 0)
    .map(t => `<button class="tile" data-view="${t.v}"><div class="tile-art" style="background:${t.bg}">${ic(t.icon)}</div><div>${VIEWS[t.v].name}<small>${plural(t.n, 'élément')}</small></div></button>`)
    .concat(S.playlists.slice(0, 6).map(p => `<button class="tile" data-view="pl:${p.id}"><div class="tile-art" style="position:relative">${coverHTML(plCover(p))}</div><div>${esc(p.name)}<small>Playlist · ${plural(p.items.length, 'son')}</small></div></button>`))
    .join('');

  const recent = sortList(S.items, 'added').slice(0, 12);
  const listened = S.items.filter(i => i.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 6);
  const top = S.items.filter(i => i.plays > 1).sort((a, b) => b.plays - a.plays).slice(0, 6);
  const sec = (title, list, more) => list.length ? `<section class="section"><div class="section-title"><h2>${title}</h2>${more ? `<button class="link-btn" data-view="${more}">Tout voir</button>` : ''}</div><div class="grid">${list.map(cardHTML).join('')}</div></section>` : '';
  return `<h1 class="greet">${greet} <span>✦</span></h1>
    <div class="tiles">${tiles}</div>
    ${sec('Écoutés récemment', listened)}
    ${sec('Ajoutés récemment', recent, 'all')}
    ${sec('Tes plus écoutés', top)}`;
}

function heroHTML(list) {
  const pl = currentPlaylist();
  const total = list.reduce((s, i) => s + (i.duration || 0), 0);
  const sub = `${plural(list.length, 'élément')}${total ? ' · ' + fmtLong(total) : ''}`;
  let art, eyebrow, title, hue;
  if (query) {
    art = `<div class="hero-art">${ic('search')}</div>`; eyebrow = 'Recherche'; title = `« ${esc(query)} »`; hue = curHue;
  } else if (pl) {
    const first = byId(pl.items[0]);
    art = `<div class="hero-art" style="position:relative">${pl.cover || first ? coverHTML(plCover(pl)) : ic('queue')}</div>`;
    eyebrow = 'Playlist'; title = esc(pl.name); hue = first && first.hue != null ? first.hue : hash(pl.name) % 360;
  } else {
    const v = VIEWS[view];
    art = `<div class="hero-art ${v.art || ''}">${ic(v.icon)}</div>`; eyebrow = 'Collection'; title = v.name; hue = v.hue != null ? v.hue : 262;
  }
  return `<div class="hero" style="--vh:${hue}">${art}<div class="hero-text"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><div class="hero-sub">${sub}</div></div></div>`;
}
function toolbarHTML(list) {
  const pl = currentPlaylist();
  const sorts = [['added', pl ? 'Ordre de la playlist' : 'Ajout récent'], ['title', 'Titre'], ['artist', 'Artiste'], ['plays', 'Plus écoutés'], ['duration', 'Durée']];
  return `<div class="toolbar">
    ${list.length ? `<button class="big-play" data-act="play-view" title="Tout lire">${ic('play')}</button>
    <button class="btn" data-act="shuffle-view">${ic('shuffle')}Aléatoire</button>` : ''}
    ${pl ? `<button class="icon-btn" data-act="pl-rename" title="Renommer">${ic('edit')}</button><button class="icon-btn" data-act="pl-delete" title="Supprimer la playlist">${ic('trash')}</button>` : ''}
    ${list.length ? `<button class="btn" data-act="share-view" title="Partager ces sons dans la Communauté">${ic('share')}Partager</button>` : ''}
    ${list.some(i => canDownload(i) && !DL.has(i.id)) ? `<button class="btn" data-act="dl-view" title="Télécharger tous les liens YouTube / Spotify de cette page">${ic('download')}Tout télécharger</button>` : ''}
    <span class="spacer"></span>
    <select class="select" id="sortSel">${sorts.map(([k, l]) => `<option value="${k}" ${S.settings.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="seg"><button data-act="layout-grid" class="${S.settings.layout === 'grid' ? 'on' : ''}" title="Grille">${ic('grid')}</button><button data-act="layout-list" class="${S.settings.layout === 'list' ? 'on' : ''}" title="Liste">${ic('list')}</button></div>
  </div>`;
}

function renderMain() {
  const c = $('#content');
  const st = c.scrollTop;
  if (view === 'community') {
    c.innerHTML = communityHTML();
  } else if (view === 'home' && !query) {
    c.innerHTML = homeHTML();
  } else {
    const list = viewItems();
    const pl = currentPlaylist();
    let body;
    if (list.length) body = listHTML(list);
    else if (query) body = `<div class="note">Aucun résultat.</div>`;
    else if (pl) body = `<div class="note">Playlist vide. Clic droit sur un son → <b>Ajouter à une playlist</b>.</div>`;
    else if (!S.items.length) body = emptyHTML();
    else body = `<div class="note">Rien ici pour l'instant.</div>`;
    c.innerHTML = heroHTML(list) + toolbarHTML(list) + body;
  }
  c.scrollTop = st;
}

function renderQueue() {
  const el = $('#upnext');
  const next = P.queue.slice(P.idx + 1, P.idx + 61).map((id, k) => ({ it: byId(id), qi: P.idx + 1 + k })).filter(x => x.it);
  el.innerHTML = next.length
    ? next.map(({ it, qi }) => `<div class="q-item" data-id="${it.id}" data-qi="${qi}">${coverHTML(it)}<div class="row-text"><div class="row-title">${esc(it.title)}</div><div class="row-artist">${esc(it.artist || srcOf(it).label)}</div></div><button class="icon-btn sm" data-act="q-remove" title="Retirer">${ic('x')}</button></div>`).join('')
    : `<div class="q-empty">${P.cur ? 'Rien après ce son.' : 'La file d\'attente est vide.'}</div>`;
}

function renderNowInfo() {
  const it = P.cur;
  $('#nowTitle').textContent = it ? it.title : 'Rien en lecture';
  $('#nowArtist').textContent = it ? (it.artist || srcOf(it).label) : 'Ajoute des sons pour commencer';
  $('#barTitle').textContent = it ? it.title : '—';
  $('#barArtist').textContent = it ? (it.artist || srcOf(it).label) : '';
  $('#barCover').innerHTML = it ? coverHTML(it) : '';
  $('#stageCover').innerHTML = coverHTML(it || { title: 'Onde' });
  for (const b of [$('#nowFav'), $('#barFav')]) { b.classList.toggle('on', !!(it && it.fav)); b.style.visibility = it ? '' : 'hidden'; }
  const pill = $('#srcPill');
  if (it) { const s = srcOf(it); pill.className = `src-pill show ${s.cls}`; pill.innerHTML = ic(s.icon) + s.label + (viaYT(it) ? ' · via YouTube' : ''); } else pill.className = 'src-pill';
  document.title = it ? `${it.title} · Onde` : 'Onde';
  $('#now').style.setProperty('--cover-url', it && it.cover ? `url("${it.cover.replace(/"/g, '%22')}")` : 'none');
  $('#seek').disabled = !it;
}
function renderBarState() {
  $('#btnShuffle').classList.toggle('on', S.settings.shuffle);
  const r = $('#btnRepeat');
  r.classList.toggle('on', S.settings.repeat !== 'off');
  $('use', r).setAttribute('href', S.settings.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  r.title = { off: 'Répéter : non', all: 'Répéter : tout', one: 'Répéter : ce son' }[S.settings.repeat] + ' (R)';
}

// ---------- moteurs de lecture ----------
const media = $('#media');
// chaîne audio des fichiers locaux : source → booster (gain) → limiteur → visualiseur → sortie
let actx, analyser, freq, booster, musicOut;
function ensureAudioCtx() {
  if (!actx) {
    try {
      actx = new AudioContext();
      const src = actx.createMediaElementSource(media);
      booster = actx.createGain();
      const limiter = actx.createDynamicsCompressor(); // évite que ça sature trop fort quand on booste
      limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = 0.003; limiter.release.value = 0.2;
      analyser = actx.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.82;
      src.connect(booster); booster.connect(limiter); limiter.connect(analyser); analyser.connect(actx.destination);
      musicOut = limiter; // point de départ pour envoyer la musique dans le micro
      freq = new Uint8Array(analyser.frequencyBinCount);
      applyVolume();
    } catch { /* pas de visualiseur ni de boost, pas grave */ }
  }
  if (actx && actx.state === 'suspended') actx.resume();
}

// ---------- musique dans le micro ----------
// La musique (et ta voix si tu veux) part dans un câble audio virtuel (VB-Cable).
// Dans Discord, tu choisis "CABLE Output" comme micro : tes potes entendent ta voix + la musique.
const MIC = { dest: null, musicGain: null, voiceSrc: null, voiceStream: null, out: null, on: false, error: '' };
const CABLE_RE = /cable input|vb-audio|voicemeeter (aux )?input|virtual/i;

async function listAudioDevices() {
  let devs = await navigator.mediaDevices.enumerateDevices();
  if (!devs.some(d => d.label)) { // sans autorisation micro, Windows cache les noms
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch { }
    devs = await navigator.mediaDevices.enumerateDevices();
  }
  const outputs = devs.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const inputs = devs.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && !/cable output|voicemeeter out/i.test(d.label));
  return { outputs, inputs };
}
function stopMic() {
  try { MIC.out && MIC.out.pause(); } catch { }
  try { MIC.musicGain && MIC.musicGain.disconnect(); } catch { }
  try { MIC.voiceSrc && MIC.voiceSrc.disconnect(); } catch { }
  if (MIC.voiceStream) MIC.voiceStream.getTracks().forEach(t => t.stop());
  Object.assign(MIC, { dest: null, musicGain: null, voiceSrc: null, voiceStream: null, out: null, on: false });
}
async function startMic(quiet = false) {
  stopMic();
  const st = S.settings;
  if (!st.mic) return;
  MIC.error = '';
  try {
    ensureAudioCtx();
    if (!actx || !musicOut) throw new Error('audio indisponible');
    const { outputs, inputs } = await listAudioDevices();
    const out = outputs.find(d => d.label === st.micOut) || outputs.find(d => CABLE_RE.test(d.label));
    if (!out) throw new Error('câble virtuel introuvable : installe VB-Cable (Paramètres)');
    MIC.dest = actx.createMediaStreamDestination();
    MIC.musicGain = actx.createGain();
    MIC.musicGain.gain.value = st.micVol;
    musicOut.connect(MIC.musicGain);
    MIC.musicGain.connect(MIC.dest);
    if (st.micVoice) {
      const inp = inputs.find(d => d.label === st.micIn);
      MIC.voiceStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: inp ? { exact: inp.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      MIC.voiceSrc = actx.createMediaStreamSource(MIC.voiceStream);
      MIC.voiceSrc.connect(MIC.dest); // ta voix va dans le câble, pas dans ton casque
    }
    MIC.out = new Audio();
    MIC.out.srcObject = MIC.dest.stream;
    await MIC.out.setSinkId(out.deviceId);
    await MIC.out.play();
    MIC.on = true;
    if (!quiet) toast(`Musique envoyée dans le micro (${out.label})`);
  } catch (e) {
    stopMic();
    MIC.error = e.message || String(e);
    if (!quiet || /introuvable/.test(MIC.error)) toast('Musique dans le micro : ' + MIC.error, 'err');
  }
}
function setMicVolume(v) {
  S.settings.micVol = v;
  if (MIC.musicGain) MIC.musicGain.gain.setTargetAtTime(v, actx.currentTime, 0.05);
  save();
}
navigator.mediaDevices && navigator.mediaDevices.addEventListener('devicechange', () => { if (S.settings.mic && !MIC.on) startMic(true); });

const Local = {
  async load(it, autoplay, startAt) {
    media.src = '/media/' + encodeURIComponent(it.file);
    if (startAt) media.addEventListener('loadedmetadata', () => { media.currentTime = startAt; }, { once: true });
    if (autoplay) { ensureAudioCtx(); await media.play().catch(e => { if (e.name !== 'AbortError') throw e; }); }
  },
  play() { ensureAudioCtx(); media.play().catch(() => {}); },
  pause() { media.pause(); },
  toggle() { media.paused ? this.play() : this.pause(); },
  seek(t) { media.currentTime = t; },
  time: () => media.currentTime || 0,
  duration: () => (isFinite(media.duration) ? media.duration : 0),
  setVolume(v) { // v va de 0 à 3 (300 %) : au-delà de 1, c'est le booster qui prend le relais
    media.volume = Math.min(1, v);
    if (booster) booster.gain.setTargetAtTime(Math.max(1, v), actx.currentTime, 0.05);
  },
  stop() { media.pause(); media.removeAttribute('src'); media.load(); },
};
media.addEventListener('play', () => setPlaying(true));
media.addEventListener('pause', () => setPlaying(false));
media.addEventListener('ended', onEnded);
media.addEventListener('error', () => {
  if (!media.getAttribute('src') || !P.cur || P.cur.type !== 'local') return;
  toast(`Impossible de lire « ${P.cur.title} » (format non supporté ?)`, 'err');
});
media.addEventListener('loadedmetadata', () => {
  const it = P.cur;
  if (!it || it.type !== 'local') return;
  if (!it.duration && isFinite(media.duration)) { it.duration = media.duration; save(); }
  const isVid = media.videoWidth > 0;
  if ((it.kind === 'video') !== isVid) { it.kind = isVid ? 'video' : 'audio'; setStage(it); save(); scheduleRender(); }
});

// YouTube (API IFrame officielle)
let ytApiPromise;
function loadYTApi() {
  if (!ytApiPromise) ytApiPromise = new Promise((ok, ko) => {
    window.onYouTubeIframeAPIReady = ok;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApiPromise = null; ko(new Error('pas de connexion à YouTube')); };
    document.head.append(s);
  });
  return ytApiPromise;
}
const YTE = {
  player: null, ready: null,
  async ensure() {
    await loadYTApi();
    if (!this.ready) this.ready = new Promise(ok => {
      this.player = new YT.Player('yt-host', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, iv_load_policy: 3, modestbranding: 1, origin: location.origin },
        events: { onReady: ok, onStateChange: e => this.onState(e.data), onError: e => this.onError(e.data) },
      });
    });
    await this.ready;
    this.setVolume(S.settings.muted ? 0 : S.settings.volume);
  },
  async load(it, autoplay, startAt) {
    await this.ensure();
    let vid = it.ytId;
    if (it.type === 'spotify') {
      vid = await ytMatch(it);
      if (P.cur !== it) return;
      if (!vid) { // rien trouvé : on se rabat sur le lecteur Spotify
        it.spNative = true; save();
        toast('Introuvable sur YouTube : extrait Spotify à la place.', 'err');
        return load(it, autoplay);
      }
    }
    if (vid) {
      const o = { videoId: vid, startSeconds: startAt || 0 };
      autoplay ? this.player.loadVideoById(o) : this.player.cueVideoById(o);
    } else {
      const o = { list: it.ytList, listType: 'playlist' };
      autoplay ? this.player.loadPlaylist(o) : this.player.cuePlaylist(o);
    }
  },
  onState(s) {
    if (P.eng !== this) return;
    if (s === 1) setPlaying(true);
    else if (s === 2 || s === 0) setPlaying(false);
    if (s === 0) {
      if (P.cur && P.cur.ytList) {
        const pl = this.player.getPlaylist(), i = this.player.getPlaylistIndex();
        if (pl && i < pl.length - 1) return; // YouTube passe tout seul à la suivante
      }
      onEnded();
    }
  },
  onError(code) {
    if (P.eng !== this) return;
    const it = P.cur;
    if (it && it.type === 'spotify' && it.ytCands) { // version bloquée : on essaie la suivante
      it.ytPick = (it.ytPick || 0) + 1;
      if (it.ytPick < it.ytCands.length) { save(); return this.load(it, true); }
      it.ytPick = 0; it.spNative = true; save();
      toast('Aucune version YouTube lisible : extrait Spotify à la place.', 'err');
      return load(it, true);
    }
    const msg = code === 101 || code === 150 || code === 153
      ? "Cette vidéo YouTube refuse d'être lue en dehors de YouTube."
      : code === 100 ? 'Vidéo YouTube introuvable (supprimée ou privée).' : 'Erreur de lecture YouTube.';
    toast(msg, 'err');
    setTimeout(() => next(true), 1500);
  },
  innerNext() {
    if (!(P.cur && P.cur.ytList && this.player)) return false;
    const pl = this.player.getPlaylist(), i = this.player.getPlaylistIndex();
    if (pl && i < pl.length - 1) { this.player.nextVideo(); return true; }
    return false;
  },
  innerPrev() {
    if (!(P.cur && P.cur.ytList && this.player)) return false;
    if (this.player.getPlaylistIndex() > 0) { this.player.previousVideo(); return true; }
    return false;
  },
  play() { this.player && this.player.playVideo(); },
  pause() { this.player && this.player.pauseVideo(); },
  toggle() { if (!this.player) return; this.player.getPlayerState() === 1 ? this.pause() : this.play(); },
  seek(t) { this.player && this.player.seekTo(t, true); },
  time() { return (this.player && this.player.getCurrentTime && this.player.getCurrentTime()) || 0; },
  duration() { return (this.player && this.player.getDuration && this.player.getDuration()) || 0; },
  setVolume(v) { if (this.player && this.player.setVolume) { this.player.setVolume(Math.round(Math.min(1, v) * 100)); v === 0 ? this.player.mute() : this.player.unMute(); } },
  stop() { if (this.player && this.player.stopVideo) this.player.stopVideo(); },
};

// Spotify (API IFrame officielle)
let spApiPromise;
function loadSpApi() {
  if (!spApiPromise) spApiPromise = new Promise((ok, ko) => {
    window.onSpotifyIframeApiReady = ok;
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.onerror = () => { spApiPromise = null; ko(new Error('pas de connexion à Spotify')); };
    document.head.append(s);
  });
  return spApiPromise;
}
const SPE = {
  ctl: null, paused: true, pos: 0, dur: 0, at: 0, started: false, lastPos: 0, wantPlay: false, endedFired: false,
  async load(it, autoplay) {
    const API = await loadSpApi();
    this.paused = true; this.pos = 0; this.dur = it.duration || 0; this.started = false; this.lastPos = 0; this.endedFired = false;
    this.wantPlay = autoplay;
    if (!this.ctl) {
      await new Promise(ok => API.createController($('#sp-host'), { uri: it.spUri, width: '100%', height: '100%' }, ctl => {
        this.ctl = ctl;
        ctl.addListener('ready', () => { if (this.wantPlay) ctl.play(); });
        ctl.addListener('playback_update', e => this.onUpdate(e.data));
        ok();
      }));
    } else {
      this.ctl.loadUri(it.spUri);
    }
    clearTimeout(this.kick);
    this.kick = setTimeout(() => { if (this.wantPlay && this.paused && P.eng === this) this.ctl.play(); }, 1500);
  },
  onUpdate(d) {
    if (P.eng !== this) return;
    this.paused = d.isPaused; this.pos = d.position / 1000; this.dur = d.duration / 1000; this.at = performance.now();
    if (!d.isPaused) { this.started = true; this.wantPlay = false; }
    setPlaying(!d.isPaused);
    const single = P.cur && /^spotify:(track|episode):/.test(P.cur.spUri);
    const atEnd = d.duration > 0 && (d.position >= d.duration - 800 || (d.position === 0 && this.lastPos > d.duration - 3000));
    if (single && this.started && d.isPaused && atEnd && !this.endedFired) { this.endedFired = true; onEnded(); }
    this.lastPos = d.position;
  },
  play() { if (!this.ctl) return; this.started ? this.ctl.resume() : this.ctl.play(); },
  pause() { this.ctl && this.ctl.pause(); },
  toggle() { this.ctl && this.ctl.togglePlay(); },
  seek(t) { if (this.ctl) { this.ctl.seek(t); this.endedFired = false; } },
  time() { const t = this.paused ? this.pos : this.pos + (performance.now() - this.at) / 1000; return Math.min(t, this.dur || t); },
  duration() { return this.dur; },
  setVolume() { /* le lecteur Spotify intégré ne permet pas de régler le volume */ },
  stop() { clearTimeout(this.kick); this.wantPlay = false; this.ctl && this.ctl.pause(); },
};

const ENGINES = { local: Local, youtube: YTE, spotify: SPE };
const engineFor = it => (viaYT(it) ? YTE : ENGINES[it.type]);

async function ytMatch(it) {
  if (!it.ytCands) {
    try {
      const q = `${(it.artist || '').split(',')[0]} ${it.title}`.trim();
      const r = await fetch('/api/yt-search?q=' + encodeURIComponent(q));
      it.ytCands = r.ok ? await r.json() : [];
    } catch { return null; } // pas de réseau : on réessaiera la prochaine fois
    it.ytPick = 0; save();
  }
  return it.ytCands[it.ytPick || 0] || null;
}

// ---------- lecteur ----------
const P = { queue: [], base: [], idx: -1, cur: null, eng: null, playing: false };

function setStage(it) {
  $('#stage').dataset.engine = !it ? 'none' : it.type === 'local' ? (it.kind === 'video' ? 'local-video' : 'local-audio') : viaYT(it) ? 'youtube' : it.type;
}
function setPlaying(b) {
  if (P.playing === b) return;
  P.playing = b;
  document.body.classList.toggle('playing', b);
  $('#btnPlay use').setAttribute('href', b ? '#i-pause' : '#i-play');
  $$('.card.current .card-play use, .row.current .num use').forEach(u => u.setAttribute('href', b ? '#i-pause' : '#i-play'));
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = b ? 'playing' : 'paused';
  updatePresence();
}

// ---------- Discord Rich Presence ----------
let presenceTimer, lastPresence = '';
function updatePresence() { clearTimeout(presenceTimer); presenceTimer = setTimeout(sendPresence, 700); }
const pad2 = s => { s = String(s || '').trim(); return (s.length < 2 ? (s + ' ·').trim().padEnd(2, '·') : s).slice(0, 128); };
// Discord n'affiche que des images en ligne : on prend la pochette du son si elle est déjà en ligne
// (YouTube, Spotify), sinon on cherche la pochette officielle (iTunes / Deezer) et on la retient.
function discordImage(it) {
  if (it.spType === 'track' && it.cover && it.cover.startsWith('/api/img?u=')) return decodeURIComponent(it.cover.slice(11));
  if (it.ytId && it.type === 'youtube') return `https://i.ytimg.com/vi/${it.ytId}/hqdefault.jpg`;
  if (it.pubCover !== undefined) return it.pubCover || (it.ytId ? `https://i.ytimg.com/vi/${it.ytId}/hqdefault.jpg` : '');
  if (!it._artFetching) {
    it._artFetching = true;
    fetch('/api/artwork?' + artQuery(it)).then(r => r.json()).then(j => {
      it.pubCover = (j.src === 'youtube' ? j.fb : j.url) || ''; save();
      if (P.cur === it) { lastPresence = ''; updatePresence(); }
    }).catch(() => {}).finally(() => { delete it._artFetching; });
  }
  return it.ytId ? `https://i.ytimg.com/vi/${it.ytId}/hqdefault.jpg` : '';
}
function sendPresence() {
  const it = P.cur;
  let act = null;
  if (S.settings.discord && it && P.playing && P.eng) {
    const t = P.eng.time(), d = P.eng.duration() || it.duration || 0;
    const img = discordImage(it);
    act = {
      type: 2, // "Écoute"
      details: pad2(it.title),
      state: pad2(it.artist || srcOf(it).label),
      instance: false,
    };
    if (img) act.assets = { large_image: img, large_text: pad2(it.album || it.title) };
    if (d > 0) {
      const start = Math.round((Date.now() - t * 1000) / 1000) * 1000;
      act.timestamps = { start, end: start + Math.round(d * 1000) };
    }
    if (it.url && /^https:\/\/(www\.youtube\.com|open\.spotify\.com)\//.test(it.url)) {
      act.buttons = [{ label: it.url.includes('spotify') ? 'Écouter sur Spotify' : 'Écouter sur YouTube', url: it.url }];
    }
  }
  const key = JSON.stringify(act);
  if (key === lastPresence) return;
  lastPresence = key;
  fetch('/api/discord', { method: 'POST', body: JSON.stringify({ activity: act }) }).catch(() => {});
}
setInterval(() => { if (P.playing) updatePresence(); }, 30000);

async function load(it, autoplay = true, startAt = 0) {
  if (!it) return;
  const eng = engineFor(it);
  if (P.eng && P.eng !== eng) P.eng.stop();
  P.cur = it; P.eng = eng;
  setPlaying(false);
  setStage(it);
  renderNowInfo();
  applyVolume();
  updatePresence();
  if (autoplay) { it.plays = (it.plays || 0) + 1; it.lastPlayed = Date.now(); }
  S.last = { id: it.id, t: startAt };
  save();
  scheduleRender();
  applyHue(it);
  updateMediaSession(it);
  try { await eng.load(it, autoplay, startAt); }
  catch (e) { if (P.cur === it) toast(`Lecture impossible : ${e.message || e}`, 'err'); }
}

function playList(list, start = 0) {
  const ids = list.filter(Boolean).map(i => i.id);
  if (!ids.length) return;
  P.base = ids.slice();
  if (S.settings.shuffle) {
    const first = ids.splice(start, 1)[0];
    P.queue = [first, ...shuffleArr(ids)];
    P.idx = 0;
  } else { P.queue = ids; P.idx = start; }
  load(byId(P.queue[P.idx]), true);
}
function contextList() {
  return view === 'home' && !query ? sortList(S.items, 'added') : viewItems();
}
function playItem(id) {
  if (P.cur && P.cur.id === id) return toggle();
  const list = contextList();
  let i = list.findIndex(x => x.id === id);
  if (i < 0) { list.unshift(byId(id)); i = 0; }
  playList(list, i);
}
function toggle() {
  if (!P.cur) { const l = contextList(); if (l.length) playList(l, S.settings.shuffle ? Math.floor(Math.random() * l.length) : 0); return; }
  P.eng.toggle();
}
function onEnded() {
  if (S.settings.repeat === 'one' && P.eng) { P.eng.seek(0); P.eng.play(); if (P.eng === SPE) SPE.ctl.play(); return; }
  next(true);
}
function next(auto = false) {
  if (!P.queue.length) return;
  if (!auto && P.eng && P.eng.innerNext && P.eng.innerNext()) return;
  let i = P.idx + 1;
  if (i >= P.queue.length) {
    if (S.settings.repeat === 'all' || !auto) i = 0;
    else { setPlaying(false); return; }
  }
  P.idx = i;
  const it = byId(P.queue[i]);
  if (!it) { P.queue.splice(i, 1); P.idx = i - 1; return next(auto); }
  load(it, true);
}
function prev() {
  if (P.eng && P.eng.time() > 3) { P.eng.seek(0); return; }
  if (P.eng && P.eng.innerPrev && P.eng.innerPrev()) return;
  if (!P.queue.length) return;
  let i = P.idx - 1;
  if (i < 0) i = S.settings.repeat === 'all' ? P.queue.length - 1 : 0;
  P.idx = i;
  load(byId(P.queue[i]), true);
}
function seekBy(d) { if (P.eng) { P.eng.seek(Math.max(0, P.eng.time() + d)); updatePresence(); } }

function setShuffle(on) {
  S.settings.shuffle = on; save();
  if (P.cur && P.queue.length) {
    if (on) { const rest = P.queue.filter((_, i) => i !== P.idx); P.queue = [P.cur.id, ...shuffleArr(rest)]; P.idx = 0; }
    else { P.queue = P.base.slice(); P.idx = Math.max(0, P.queue.indexOf(P.cur.id)); }
  }
  renderBarState(); renderQueue();
  toast(on ? 'Lecture aléatoire activée' : 'Lecture aléatoire désactivée');
}
function cycleRepeat() {
  S.settings.repeat = { off: 'all', all: 'one', one: 'off' }[S.settings.repeat] || 'off';
  save(); renderBarState();
  toast({ off: 'Répétition désactivée', all: 'Répéter toute la file', one: 'Répéter ce son' }[S.settings.repeat]);
}
function playNext(id) {
  if (!P.cur) return playList([byId(id)], 0);
  P.queue.splice(P.idx + 1, 0, id);
  P.base.splice(P.base.indexOf(P.cur.id) + 1, 0, id);
  renderQueue(); toast('Sera lu juste après');
}
function addToQueue(id) {
  if (!P.cur) return playList([byId(id)], 0);
  P.queue.push(id); P.base.push(id);
  renderQueue(); toast("Ajouté à la file d'attente");
}

// volume réel = volume général × volume propre au son (réglable pour chaque musique)
const trackGain = it => (it && typeof it.gain === 'number' ? it.gain : 1);
function applyVolume() {
  const v = S.settings.muted ? 0 : Math.min(3, S.settings.volume * trackGain(P.cur));
  Local.setVolume(v); YTE.setVolume(v);
  const r = $('#vol'); r.value = Math.round(S.settings.volume * 100); setP(r);
  const tv = $('#trackVol'), g = trackGain(P.cur);
  tv.value = Math.round(g * 100); setP(tv); tv.disabled = !P.cur;
  tv.classList.toggle('boost', g > 1.001);
  $('#trackVolPct').textContent = Math.round(g * 100) + '%';
  $('#trackVolReset').style.visibility = P.cur && Math.abs(g - 1) > 0.001 ? '' : 'hidden';
  const boost = v > 1.001;
  r.classList.toggle('boost', boost);
  const pct = $('#volPct');
  pct.textContent = Math.round(S.settings.volume * 100) + '%';
  pct.classList.toggle('boost', boost);
  const capped = boost && P.cur && P.cur.type !== 'local'; // YouTube / Spotify : 100 % max
  pct.classList.toggle('capped', !!capped);
  pct.title = capped ? 'Le boost au-delà de 100 % marche sur tes fichiers, pas sur YouTube / Spotify' : 'Volume';
  $('#btnMute use').setAttribute('href', v === 0 ? '#i-mute' : '#i-vol');
}
function setP(r) { r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min)) * 100 + '%'); }

let seeking = false;
const seekEl = $('#seek');
seekEl.addEventListener('input', () => {
  seeking = true; setP(seekEl);
  const d = P.eng ? P.eng.duration() : 0;
  $('#tCur').textContent = fmt((seekEl.value / 1000) * d);
});
seekEl.addEventListener('change', () => {
  const d = P.eng ? P.eng.duration() : 0;
  if (P.eng && d) P.eng.seek((seekEl.value / 1000) * d);
  seeking = false;
  updatePresence();
});
function setTrackGain(it, g) {
  if (!it) return;
  g = Math.max(0, Math.min(3, g));
  if (Math.abs(g - 1) < 0.06) g = 1; // petit cran à 100 %
  if (g === 1) delete it.gain; else it.gain = g;
  if (P.cur === it) applyVolume();
  save();
}
$('#trackVol').addEventListener('input', e => {
  setTrackGain(P.cur, e.target.value / 100);
  if (P.cur && P.cur.type !== 'local' && trackGain(P.cur) > 1 && !boostWarned) {
    boostWarned = true;
    toast('Au-delà de 100 %, le boost marche sur tes fichiers MP3/MP4, pas sur YouTube / Spotify.');
  }
});
$('#trackVolReset').addEventListener('click', () => setTrackGain(P.cur, 1));

async function trackVolumeDialog(id) {
  const it = byId(id); if (!it) return;
  const start = trackGain(it);
  dlg.innerHTML = `<form method="dialog"><h3>Volume de ce son</h3><p>${esc(it.title)}</p>
    <div class="track-vol big"><input type="range" class="range vol" min="0" max="300" step="5" value="${Math.round(start * 100)}"><span class="tv-pct">${Math.round(start * 100)}%</span></div>
    <div class="dlg-actions"><button class="btn" type="button" data-reset>100 %</button><button class="btn" type="button" data-close>Annuler</button><button class="btn primary" type="submit">OK</button></div></form>`;
  const r = $('input', dlg), pct = $('.tv-pct', dlg);
  const show = () => { setP(r); r.classList.toggle('boost', r.value > 100); pct.textContent = r.value + '%'; };
  let ok = false;
  r.oninput = () => { setTrackGain(it, r.value / 100); r.value = Math.round(trackGain(it) * 100); show(); }; // on entend le changement tout de suite
  $('[data-reset]', dlg).onclick = () => { r.value = 100; r.oninput(); };
  $('[data-close]', dlg).onclick = () => dlg.close();
  $('form', dlg).onsubmit = e => { e.preventDefault(); ok = true; dlg.close(); };
  dlg.onclose = () => { if (!ok) setTrackGain(it, start); else if (P.cur !== it) toast(`Volume de « ${it.title} » : ${Math.round(trackGain(it) * 100)} %`); };
  show();
  dlg.showModal();
}

let boostWarned = false;
$('#vol').addEventListener('input', e => {
  let v = e.target.value / 100;
  if (Math.abs(v - 1) < 0.06) v = 1; // petit cran à 100 %
  S.settings.volume = v; S.settings.muted = false;
  applyVolume(); save();
  if (v > 1 && P.cur && P.cur.type !== 'local' && !boostWarned) {
    boostWarned = true;
    toast('Le boost au-delà de 100 % marche sur tes fichiers MP3/MP4, pas sur YouTube / Spotify.');
  }
});

setInterval(() => {
  if (!P.eng || !P.cur || seeking) return;
  const t = P.eng.time(), d = P.eng.duration() || P.cur.duration || 0;
  $('#tCur').textContent = fmt(t);
  $('#tDur').textContent = fmt(d);
  seekEl.value = d ? Math.round((t / d) * 1000) : 0;
  setP(seekEl);
  if (S.last) S.last.t = t;
  const keepDur = P.cur.type === 'spotify' && P.cur.duration; // durée Spotify officielle déjà connue
  if (P.cur.type !== 'local' && !P.cur.ytList && !keepDur && d && Math.abs((P.cur.duration || 0) - d) > 1) { P.cur.duration = d; save(); }
}, 250);
setInterval(() => { if (P.playing) save(); }, 5000); // position dans le son

// ---------- visualiseur ----------
const viz = $('#viz'), vctx = viz.getContext('2d');
function drawViz() {
  requestAnimationFrame(drawViz);
  if ($('#stage').dataset.engine !== 'local-audio' || document.hidden) return;
  const r = viz.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (!W || !H) return;
  if (viz.width !== W || viz.height !== H) { viz.width = W; viz.height = H; }
  vctx.clearRect(0, 0, W, H);
  const shade = vctx.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,.6)');
  vctx.shadowBlur = 0; vctx.fillStyle = shade; vctx.fillRect(0, 0, W, H);
  if (!analyser) return;
  analyser.getByteFrequencyData(freq);
  const bars = 44, gap = 3 * dpr, pad = 14 * dpr;
  const bw = (W - pad * 2 - gap * (bars - 1)) / bars;
  const g = vctx.createLinearGradient(0, H, 0, 0);
  g.addColorStop(0, `hsla(${curHue},92%,68%,.95)`); g.addColorStop(1, `hsla(${curHue + 48},92%,72%,.7)`);
  vctx.fillStyle = g; vctx.shadowColor = `hsla(${curHue},92%,60%,.9)`; vctx.shadowBlur = 18 * dpr;
  for (let i = 0; i < bars; i++) {
    const k = Math.floor(Math.pow(i / bars, 1.5) * freq.length * 0.8);
    const v = freq[k] / 255;
    const bh = Math.max(3 * dpr, v * v * (H - pad) * 0.95);
    const x = pad + i * (bw + gap);
    vctx.beginPath();
    if (vctx.roundRect) vctx.roundRect(x, H - pad - bh, bw, bh, bw / 2); else vctx.rect(x, H - pad - bh, bw, bh);
    vctx.fill();
  }
}
requestAnimationFrame(drawViz);

// ---------- media session (touches multimédia du clavier) ----------
function updateMediaSession(it) {
  if (!('mediaSession' in navigator)) return;
  const art = it.cover ? [{ src: it.cover.startsWith('data:') ? it.cover : location.origin + it.cover, sizes: '512x512' }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({ title: it.title, artist: it.artist || '', album: it.album || 'Onde', artwork: art });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = { play: () => P.eng && P.eng.play(), pause: () => P.eng && P.eng.pause(), nexttrack: () => next(), previoustrack: () => prev(), seekto: e => P.eng && P.eng.seek(e.seekTime) };
  for (const [k, f] of Object.entries(h)) { try { ms.setActionHandler(k, f); } catch { } }
}

// ---------- import de fichiers locaux ----------
function nameToMeta(name) {
  let s = name.replace(/\.[^.]+$/, '').replace(/\s*\[[\w-]{11}\]$/, '').replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^\d{1,3}\s*[-.)]\s*/, '');
  const m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: s || name };
}
function addLocalItem(file, size, original) {
  if (S.items.some(i => i.type === 'local' && i.file === file)) return null;
  const { title, artist } = nameToMeta(original || file);
  const it = { id: uid(), type: 'local', file, size, original: original || file, title, artist, kind: VIDEO_RE.test(file) ? 'video' : 'audio', addedAt: Date.now() };
  S.items.push(it);
  enqueueProbe(it);
  scheduleRender(); save();
  return it;
}

async function importNative(kind) {
  const api = native();
  if (!api) { if (kind === 'files') $('#pickFiles').click(); else toast("L'import de dossier marche dans l'app Onde.", 'err'); return; }
  const t = toast('Choisis tes fichiers…', 'upload', true);
  try {
    const res = kind === 'folder' ? await api.pick_folder() : await api.pick_files();
    t.close();
    const added = (res || []).map(f => addLocalItem(f.file, f.size, f.original)).filter(Boolean);
    if (added.length) toast(`${plural(added.length, 'son')} ajouté${added.length > 1 ? 's' : ''} ✦`);
  } catch (e) { t.close(); toast('Import impossible : ' + (e.message || e), 'err'); }
}

function xhrUpload(f, onp) {
  return new Promise((ok, ko) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload');
    x.setRequestHeader('X-Filename', encodeURIComponent(f.name));
    x.upload.onprogress = e => e.lengthComputable && onp(e.loaded / e.total);
    x.onload = () => (x.status === 200 ? ok(JSON.parse(x.responseText)) : ko(new Error(x.status)));
    x.onerror = ko;
    x.send(f);
  });
}
async function uploadFiles(fileList) {
  const files = [...fileList].filter(f => MEDIA_RE.test(f.name));
  if (!files.length) return toast('Aucun fichier audio ou vidéo reconnu.', 'err');
  const t = toast(`Import de ${plural(files.length, 'fichier')}…`, 'upload', true, true);
  let done = 0, added = 0, dupes = 0;
  for (const f of files) {
    if (S.items.some(i => i.type === 'local' && i.original === f.name && i.size === f.size)) { dupes++; done++; continue; }
    t.text(`Import : ${f.name}`);
    try {
      const r = await xhrUpload(f, p => t.progress((done + p) / files.length));
      if (addLocalItem(r.file, r.size, f.name)) added++;
    } catch { toast(`Échec de l'import : ${f.name}`, 'err'); }
    done++; t.progress(done / files.length);
  }
  t.close();
  if (added) toast(`${plural(added, 'son')} ajouté${added > 1 ? 's' : ''} ✦`);
  if (dupes) toast(`${plural(dupes, 'fichier')} déjà dans ta bibliothèque`);
}

// lecture des tags ID3 (titre, artiste, album, pochette) des MP3
const ss = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const latin = new TextDecoder('latin1');
function id3Text(d) {
  const enc = d[0], data = d.subarray(1);
  let s;
  if (enc === 0) s = latin.decode(data);
  else if (enc === 1) s = new TextDecoder(data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-16le').decode(data);
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(data);
  else s = new TextDecoder('utf-8').decode(data);
  return s.replace(/^﻿/, '').split('\0')[0].trim();
}
function skipStr(d, i, enc) {
  if (enc === 1 || enc === 2) { while (i + 1 < d.length && !(d[i] === 0 && d[i + 1] === 0)) i += 2; return i + 2; }
  while (i < d.length && d[i] !== 0) i++;
  return i + 1;
}
function parseID3(b) {
  const ver = b[3], flags = b[5];
  if (flags & 0x80 && ver < 4) { // désynchronisation
    const out = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9]];
    for (let i = 10; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0) i++; }
    b = Uint8Array.from(out);
  }
  const end = Math.min(10 + ss(b, 6), b.length);
  let p = 10;
  if (flags & 0x40) p += ver === 4 ? ss(b, 10) : u32(b, 10) + 4;
  const tags = {};
  while (p + 10 <= end) {
    let id, size, hdr;
    if (ver === 2) { id = latin.decode(b.subarray(p, p + 3)); size = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]; hdr = 6; }
    else { id = latin.decode(b.subarray(p, p + 4)); size = ver === 4 ? ss(b, p + 4) : u32(b, p + 4); hdr = 10; }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || size <= 0 || p + hdr + size > end) break;
    const d = b.subarray(p + hdr, p + hdr + size);
    try {
      if (id === 'TIT2' || id === 'TT2') tags.title = id3Text(d);
      else if (id === 'TPE1' || id === 'TP1') tags.artist = id3Text(d);
      else if (id === 'TALB' || id === 'TAL') tags.album = id3Text(d);
      else if ((id === 'APIC' || id === 'PIC') && !tags.pic) {
        const enc = d[0];
        let i, mime;
        if (id === 'APIC') { i = 1; while (d[i] !== 0 && i < d.length) i++; mime = latin.decode(d.subarray(1, i)) || 'image/jpeg'; i++; }
        else { mime = /png/i.test(latin.decode(d.subarray(1, 4))) ? 'image/png' : 'image/jpeg'; i = 4; }
        i++; // type d'image
        i = skipStr(d, i, enc);
        tags.pic = { mime: mime.includes('/') ? mime : 'image/' + mime.toLowerCase(), data: d.slice(i) };
      }
    } catch { }
    p += hdr + size;
  }
  return tags;
}
async function readID3(url) {
  const head = new Uint8Array(await (await fetch(url, { headers: { Range: 'bytes=0-9' } })).arrayBuffer());
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
  const size = ss(head, 6) + 10;
  if (size > 20e6) return null;
  const buf = new Uint8Array(await (await fetch(url, { headers: { Range: `bytes=0-${size - 1}` } })).arrayBuffer());
  return parseID3(buf);
}
async function shrinkImage(blob, max = 512) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  } catch { return null; }
}

const probeQ = [];
let probing = false;
function enqueueProbe(it) { probeQ.push(it); runProbe(); }
async function runProbe() {
  if (probing) return;
  probing = true;
  while (probeQ.length) {
    const it = probeQ.shift();
    if (!byId(it.id)) continue;
    try { await probe(it); } catch { }
    it.probed = true;
    if (!it.cover) enqueueArt(it); // pas de pochette dans le fichier : on en cherche une
    save(); scheduleRender();
    if (P.cur === it) { renderNowInfo(); applyHue(it); }
  }
  probing = false;
}
async function probe(it) {
  const url = '/media/' + encodeURIComponent(it.file);
  if (/\.mp3$/i.test(it.file)) {
    const tags = await readID3(url).catch(() => null);
    if (tags) {
      if (tags.title) it.title = tags.title;
      if (tags.artist) it.artist = tags.artist;
      if (tags.album) it.album = tags.album;
      if (tags.pic) it.cover = await shrinkImage(new Blob([tags.pic.data], { type: tags.pic.mime })) || it.cover;
    }
  }
  await new Promise(res => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata';
    const done = () => { clearTimeout(to); v.removeAttribute('src'); v.load(); res(); };
    const to = setTimeout(done, 15000);
    v.onloadedmetadata = () => {
      it.duration = isFinite(v.duration) ? v.duration : 0;
      if (v.videoWidth > 0) {
        it.kind = 'video';
        if (!it.cover) {
          v.onseeked = () => {
            setTimeout(() => {
              try {
                const c = document.createElement('canvas');
                c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth);
                c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                it.cover = c.toDataURL('image/jpeg', 0.82);
              } catch { }
              done();
            }, 120);
          };
          v.currentTime = Math.min(it.duration * 0.2, 45) || 1;
          return;
        }
      } else it.kind = 'audio';
      done();
    };
    v.onerror = done;
    v.src = url;
  });
  if (it.cover) it.hue = await colorHue(it.cover);
}

// ---------- liens YouTube / Spotify ----------
function parseLink(raw) {
  let s = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!s) return null;
  let m = s.match(/^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]+)/);
  if (m) return { type: 'spotify', spType: m[1], spId: m[2], url: `https://open.spotify.com/${m[1]}/${m[2]}` };
  if (!/^https?:\/\//i.test(s)) {
    if (!/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|open\.spotify\.com)\//i.test(s)) return null;
    s = 'https://' + s;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be' || host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    let id = host === 'youtu.be' ? u.pathname.slice(1).split('/')[0] : u.searchParams.get('v');
    if (!id) id = (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1];
    const list = u.searchParams.get('list');
    if (id && /^[\w-]{11}$/.test(id)) return { type: 'youtube', ytId: id, url: `https://www.youtube.com/watch?v=${id}` };
    if (list) return { type: 'youtube', ytList: list, url: `https://www.youtube.com/playlist?list=${list}` };
    return null;
  }
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    m = u.pathname.match(/\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/);
    if (m) return { type: 'spotify', spType: m[1], spId: m[2], url: `https://open.spotify.com/${m[1]}/${m[2]}` };
  }
  return null;
}
function cleanYT(t = '', author = '') {
  let s = t.replace(/\s*[([【][^)\]】]*(official|officiel|clip|lyrics?|paroles|audio|video|vidéo|visuali[sz]er|\bhd\b|4k|\bmv\b|m\/v)[^)\]】]*[)\]】]/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  let artist = author.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const m = s.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (m) { artist = m[1].trim(); s = m[2].trim(); }
  return { title: s || t, artist };
}
const SP_KIND = { track: 'Titre', album: 'Album', playlist: 'Playlist', episode: 'Podcast', show: 'Podcast', artist: 'Artiste' };

function addLinks(text) {
  const parts = String(text).split(/[\s,;]+/).filter(Boolean);
  let added = 0, dupes = 0, bad = 0, firstNew = null;
  let imports = 0;
  for (const raw of parts) {
    const p = parseLink(raw);
    if (!p) { bad++; continue; }
    if (p.type === 'spotify' && (p.spType === 'playlist' || p.spType === 'album')) { importSpotify(p.spType, p.spId); imports++; continue; }
    if (S.items.some(i => i.url === p.url)) { dupes++; continue; }
    const it = { id: uid(), ...p, addedAt: Date.now(), artist: '', kind: p.type === 'youtube' ? 'video' : 'audio' };
    if (p.type === 'youtube') {
      it.title = p.ytList ? 'Playlist YouTube' : 'Vidéo YouTube';
      if (p.ytId) { it.cover = imgProxy(`https://i.ytimg.com/vi/${p.ytId}/maxresdefault.jpg`); it.coverFb = imgProxy(`https://i.ytimg.com/vi/${p.ytId}/hqdefault.jpg`); }
    } else {
      it.title = 'Spotify · ' + SP_KIND[p.spType];
      it.spUri = `spotify:${p.spType}:${p.spId}`;
    }
    S.items.push(it); added++;
    firstNew = firstNew || it;
    fetchMeta(it).then(() => {
      if (it.type === 'youtube' && it.ytId && S.settings.ytDownload !== 'off') enqueueDownload(it, S.settings.ytDownload);
      if (it.type === 'spotify' && it.spType === 'track' && S.settings.spDownload) enqueueDownload(it, dlFormat());
    });
  }
  save(); scheduleRender();
  if (added) toast(`${plural(added, 'lien')} ajouté${added > 1 ? 's' : ''} ✦`);
  if (dupes) toast(`${plural(dupes, 'lien')} déjà dans ta bibliothèque`);
  if (bad && !added && !dupes && !imports) toast("Je n'ai pas reconnu ce lien (YouTube ou Spotify uniquement).", 'err');
  return added + imports;
}

// Import d'une playlist / d'un album Spotify : chaque titre devient un son de ta bibliothèque
// et une playlist Onde du même nom est créée (ou mise à jour si tu l'as déjà importée).
async function importSpotify(kind, sid) {
  const t = toast(kind === 'album' ? "Import de l'album Spotify…" : 'Import de la playlist Spotify…', 'upload', true);
  try {
    const r = await fetch(`/api/spotify-list?kind=${kind}&id=${encodeURIComponent(sid)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'erreur ' + r.status);
    if (!d.tracks.length) throw new Error('aucun titre trouvé');
    const now = Date.now(), ids = [];
    let fresh = 0;
    d.tracks.forEach((tr, n) => {
      const [, type, id] = tr.uri.split(':');
      const url = `https://open.spotify.com/${type}/${id}`;
      let it = S.items.find(i => i.url === url);
      if (!it) {
        it = { id: uid(), type: 'spotify', spType: type, spId: id, spUri: tr.uri, url, title: tr.title, artist: tr.artist, duration: tr.duration, kind: 'audio', addedAt: now - n };
        if (kind === 'album' && d.cover) it.cover = imgProxy(d.cover);
        S.items.push(it); fresh++;
        if (!it.cover) coverQ.push(it);
        if (S.settings.spDownload && type === 'track') enqueueDownload(it, dlFormat());
      }
      if (!ids.includes(it.id)) ids.push(it.id);
    });
    const src = `${kind}:${sid}`;
    let pl = S.playlists.find(p => p.spSource === src);
    if (pl) pl.items = ids;
    else { pl = { id: uid(), name: d.name, items: ids, createdAt: now, spSource: src }; S.playlists.push(pl); }
    if (d.cover) pl.cover = imgProxy(d.cover);
    save(); t.close();
    toast(`« ${d.name} » importée : ${plural(ids.length, 'titre')}${fresh < ids.length ? ` (${fresh} nouveaux)` : ''} ✦`);
    setView('pl:' + pl.id);
    runCoverQ();
  } catch (e) {
    t.close();
    toast('Import Spotify impossible : ' + (e.message || e), 'err');
  }
}

// ---------- téléchargement en MP3 / MP4 ----------
// Le son téléchargé remplace le lien à la même place : favoris, playlists et écoutes sont gardés.
const DL = new Map();        // id → { p: progression 0..1 }
const dlQueue = [];
let dlWorkers = 0;
const dlFormat = () => (S.settings.ytDownload === 'mp4' ? 'mp4' : 'mp3');
const dlPct = id => Math.round(((DL.get(id) || {}).p || 0) * 100) + '%';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function enqueueDownload(it, fmt) {
  if (!canDownload(it) || DL.has(it.id)) return false;
  DL.set(it.id, { p: 0 });
  dlQueue.push({ it, fmt });
  scheduleRender();
  while (dlWorkers < 2 && dlQueue.length) { dlWorkers++; dlWorker(); }
  return true;
}
async function dlWorker() {
  while (dlQueue.length) {
    const { it, fmt } = dlQueue.shift();
    await downloadItem(it, fmt);
    DL.delete(it.id);
    scheduleRender();
  }
  dlWorkers--;
}
async function downloadItem(it, fmt) {
  if (!byId(it.id) || !canDownload(it)) return;
  let url, name;
  const artist = (it.artist || '').split(',')[0].trim();
  if (it.type === 'spotify') {
    const vid = await ytMatch(it);
    if (!vid) return toast(`Introuvable sur YouTube : ${it.title}`, 'err');
    url = `https://www.youtube.com/watch?v=${vid}`;
  } else url = `https://www.youtube.com/watch?v=${it.ytId}`;
  name = `${artist ? artist + ' - ' : ''}${it.title}`;
  try {
    const r = await fetch('/api/download', { method: 'POST', body: JSON.stringify({ url, format: fmt, name }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    for (;;) {
      await sleep(900);
      const s = await (await fetch('/api/download?id=' + j.id)).json();
      if (s.status === 'done') { becomeLocal(it, s.file, s.size, fmt); return; }
      if (s.status === 'error') throw new Error(s.error);
      const d = DL.get(it.id); if (d) d.p = s.progress || 0;
      $$(`[data-id="${it.id}"] .dl-pct`).forEach(e => { e.textContent = dlPct(it.id); });
    }
  } catch (e) {
    toast(`Téléchargement raté : ${it.title} (${e.message || e})`, 'err');
  }
}
function becomeLocal(it, file, size, fmt, silent = false) {
  if (!byId(it.id)) return; // supprimé entre-temps : le fichier sera repris au prochain lancement
  const playingIt = P.cur === it;
  const was = it.type;
  const vid = ytIdOfFile(file);
  Object.assign(it, { type: 'local', file, size, original: file, kind: fmt === 'mp4' ? 'video' : 'audio', from: was, probed: false });
  if (vid && !it.ytId) it.ytId = vid;
  if (was === 'spotify') it.spNative = undefined;
  enqueueProbe(it);
  save(); scheduleRender();
  if (!silent) toast(`« ${it.title} » téléchargé en ${fmt.toUpperCase()} ✦`);
  if (playingIt && !P.playing) load(it, false); // si ça joue déjà en streaming, on ne coupe pas
}

// ---------- réparation de la bibliothèque ----------
const ytIdOfFile = f => (String(f || '').match(/\[([\w-]{11})\]\.[^.]+$/) || [])[1] || null;
function repairLibrary() {
  let changed = false;
  // 1) doublons "lien YouTube" + "fichier téléchargé du même lien" → on fusionne en gardant le lien (favori, playlists…)
  for (const yt of S.items.filter(i => i.type === 'youtube' && i.ytId)) {
    const dup = S.items.find(i => i.type === 'local' && ytIdOfFile(i.file) === yt.ytId);
    if (!dup) continue;
    yt.fav = yt.fav || dup.fav;
    yt.plays = (yt.plays || 0) + (dup.plays || 0);
    if (dup.gain != null && yt.gain == null) yt.gain = dup.gain;
    S.playlists.forEach(p => { p.items = [...new Set(p.items.map(x => (x === dup.id ? yt.id : x)))]; });
    if (P.cur === dup) P.cur = yt;
    S.items = S.items.filter(i => i !== dup);
    becomeLocal(yt, dup.file, dup.size, /\.mp4$/i.test(dup.file) ? 'mp4' : 'mp3', true);
    changed = true;
  }
  // 2) fichiers téléchargés retrouvés sans infos (titre "… [id]", pas de pochette) → on reprend les infos YouTube
  for (const it of S.items.filter(i => i.type === 'local')) {
    const vid = ytIdOfFile(it.file);
    if (!vid) continue;
    if (!it.ytId) { it.ytId = vid; changed = true; }
    if (!it.url) { it.url = `https://www.youtube.com/watch?v=${vid}`; changed = true; }
    if (!it.ytInfo && (it.title.includes(`[${vid}]`) || it.title.includes(`[${vid.replace(/_/g, ' ')}]`) || !it.cover)) ytInfoFor(it);
  }
  if (changed) { save(); scheduleRender(); }
}
async function ytInfoFor(it) {
  it.ytInfo = true;
  if (!it.cover) {
    it.cover = imgProxy(`https://i.ytimg.com/vi/${it.ytId}/maxresdefault.jpg`);
    it.coverFb = imgProxy(`https://i.ytimg.com/vi/${it.ytId}/hqdefault.jpg`);
  }
  try {
    const m = await (await fetch('/api/meta?url=' + encodeURIComponent(it.url))).json();
    if (m.title) { const c = cleanYT(m.title, m.author); it.title = c.title; it.artist = c.artist; }
    it.hue = await hueFor(it);
  } catch { it.ytInfo = false; } // hors ligne : on réessaiera
  save(); scheduleRender();
  if (P.cur === it) { renderNowInfo(); applyHue(it); }
}
function downloadAll(list, fmt) {
  const n = list.filter(i => enqueueDownload(i, fmt)).length;
  toast(n ? `${plural(n, 'téléchargement')} en ${fmt.toUpperCase()} lancé${n > 1 ? 's' : ''}` : 'Rien à télécharger ici.');
}

// ---------- paramètres ----------
function openSettings() {
  const st = S.settings;
  const nYT = S.items.filter(i => i.type === 'youtube' && i.ytId).length;
  const nSP = S.items.filter(i => i.type === 'spotify' && i.spType === 'track').length;
  const radio = (name, val, icon, title, sub) => `<label><input type="radio" name="${name}" value="${val}" ${st[name] === val ? 'checked' : ''}><span><b>${ic(icon)}${title}</b><small>${sub}</small></span></label>`;
  dlg.classList.add('wide');
  dlg.innerHTML = `<form method="dialog">
    <h3>Paramètres</h3>
    <div class="set-group">
      <div class="set-title">Général</div>
      <label class="switch-row"><span>Continuer la musique quand je ferme la fenêtre<small>Onde reste près de l'heure (en bas à droite). Clic droit sur l'icône › Quitter pour fermer pour de bon.</small></span><input type="checkbox" class="switch" name="closeToTray" ${st.closeToTray ? 'checked' : ''}></label>
    </div>
    <div class="set-group">
      <div class="set-title">Liens YouTube</div>
      <div class="set-desc">Ce qui se passe quand tu ajoutes un lien YouTube. Les fichiers vont dans Musique › Onde › sons.</div>
      <div class="choice">
        ${radio('ytDownload', 'mp3', 'music', 'MP3', 'Télécharge le son')}
        ${radio('ytDownload', 'mp4', 'video', 'MP4', 'Télécharge la vidéo (1080p max)')}
        ${radio('ytDownload', 'off', 'youtube', 'Streaming', 'Lit depuis YouTube, rien n\'est téléchargé')}
      </div>
      ${nYT ? `<button class="btn" type="button" data-dl-all="youtube" style="margin-top:12px">${ic('download')}Télécharger mes ${plural(nYT, 'lien')} YouTube maintenant</button>` : ''}
    </div>
    <div class="set-group">
      <div class="set-title">Titres Spotify</div>
      <div class="set-desc">Sans compte Spotify connecté, le lecteur Spotify ne joue que 30 secondes.</div>
      <div class="choice">
        ${radio('spMode', 'yt', 'youtube', 'En entier', 'Joue la même chanson trouvée sur YouTube')}
        ${radio('spMode', 'spotify', 'spotify', 'Lecteur Spotify', 'Extrait de 30 s, sauf si tu es connecté')}
      </div>
      <label class="switch-row"><span>Télécharger aussi les titres Spotify<small>Dans le format choisi pour YouTube (MP3 si « Streaming »)</small></span><input type="checkbox" class="switch" name="spDownload" ${st.spDownload ? 'checked' : ''}></label>
      ${nSP ? `<button class="btn" type="button" data-dl-all="spotify" style="margin-top:12px">${ic('download')}Télécharger mes ${plural(nSP, 'titre')} Spotify maintenant</button>` : ''}
    </div>
    <div class="set-group">
      <div class="set-title">Discord</div>
      <div class="set-desc">Affiche « Écoute Onde » sur ton profil avec le titre, l'artiste, la pochette et la progression. L'application Discord doit être ouverte.</div>
      <label class="switch-row"><span>Afficher ce que j'écoute sur Discord<small id="discordState">…</small></span><input type="checkbox" class="switch" name="discord" ${st.discord ? 'checked' : ''}></label>
    </div>
    <div class="set-group">
      <div class="set-title">Musique dans le micro</div>
      <div class="set-desc">Tes potes entendent ta musique en vocal (Discord, jeux…). Il faut le câble audio virtuel gratuit <b>VB-Cable</b>, puis choisir <b>« CABLE Output »</b> comme micro dans Discord. Marche avec tes fichiers et les liens téléchargés, pas avec YouTube / Spotify en streaming.</div>
      <label class="switch-row"><span>Envoyer la musique dans le micro<small id="micState">${MIC.on ? 'Actif ✓' : MIC.error ? esc(MIC.error) : 'Désactivé'}</small></span><input type="checkbox" class="switch" name="mic" ${st.mic ? 'checked' : ''}></label>
      <div class="mic-opts" ${st.mic ? '' : 'hidden'}>
        <label class="field"><span>Câble virtuel (sortie)</span><select class="select" name="micOut"><option value="">Chargement…</option></select></label>
        <label class="switch-row"><span>Mélanger ma voix avec la musique<small>Sinon, seule la musique passe dans le micro</small></span><input type="checkbox" class="switch" name="micVoice" ${st.micVoice ? 'checked' : ''}></label>
        <label class="field" style="margin-top:12px"><span>Mon vrai micro</span><select class="select" name="micIn"><option value="">Micro par défaut de Windows</option></select></label>
        <div class="field"><span>Volume de la musique dans le micro</span><div class="track-vol"><input type="range" class="range" name="micVol" min="0" max="150" step="5" value="${Math.round(st.micVol * 100)}"><span class="tv-pct" id="micVolPct">${Math.round(st.micVol * 100)}%</span></div></div>
        <div class="set-desc">Dans Discord › Voix et vidéo : désactive <b>Suppression du bruit (Krisp)</b> et <b>Annulation de l'écho</b>, sinon la musique est coupée.</div>
      </div>
      <button class="btn" type="button" data-vbcable>${ic('download')}Télécharger VB-Cable (site officiel)</button>
    </div>
    <div class="dlg-actions"><button class="btn" type="button" data-close>Fermer</button><button class="btn primary" type="submit">Enregistrer</button></div>
  </form>`;
  const form = $('form', dlg);
  const micKey = () => JSON.stringify([st.mic, st.micOut, st.micVoice, st.micIn]);
  const before = micKey();
  const read = () => {
    const f = new FormData(form);
    st.ytDownload = f.get('ytDownload'); st.spMode = f.get('spMode'); st.spDownload = f.get('spDownload') === 'on';
    st.closeToTray = f.get('closeToTray') === 'on';
    const dc = f.get('discord') === 'on';
    if (dc !== st.discord) { st.discord = dc; lastPresence = ''; updatePresence(); }
    st.mic = f.get('mic') === 'on'; st.micVoice = f.get('micVoice') === 'on';
    st.micOut = f.get('micOut') || st.micOut; st.micIn = f.get('micIn') || '';
    save(); renderNowInfo(); scheduleRender();
    if (micKey() !== before) { if (st.mic) startMic(); else { stopMic(); toast('Musique dans le micro désactivée'); } }
  };

  // état Discord
  fetch('/api/discord').then(r => r.json()).then(s => {
    const el = $('#discordState', dlg); if (!el) return;
    el.textContent = !st.discord ? 'Désactivé' : s.connected ? 'Connecté à Discord ✓' : (s.error || 'En attente de Discord…');
  }).catch(() => {});

  // périphériques audio (chargés seulement si l'option micro est activée)
  const fillDevices = async () => {
    const { outputs, inputs } = await listAudioDevices();
    const outSel = $('[name="micOut"]', dlg), inSel = $('[name="micIn"]', dlg);
    const cable = outputs.find(d => d.label === st.micOut) || outputs.find(d => CABLE_RE.test(d.label));
    outSel.innerHTML = outputs.length
      ? outputs.map(d => `<option value="${esc(d.label)}" ${cable && d.label === cable.label ? 'selected' : ''}>${esc(d.label || 'Sortie audio')}</option>`).join('')
      : '<option value="">Aucune sortie trouvée</option>';
    if (!cable) $('#micState', dlg).textContent = 'VB-Cable pas trouvé : installe-le puis redémarre le PC';
    inSel.innerHTML = '<option value="">Micro par défaut de Windows</option>' + inputs.map(d => `<option value="${esc(d.label)}" ${d.label === st.micIn ? 'selected' : ''}>${esc(d.label || 'Micro')}</option>`).join('');
  };
  if (st.mic) fillDevices();
  $('[name="mic"]', dlg).onchange = e => { $('.mic-opts', dlg).hidden = !e.target.checked; if (e.target.checked) fillDevices(); };
  const mv = $('[name="micVol"]', dlg);
  setP(mv);
  mv.oninput = () => { setP(mv); $('#micVolPct', dlg).textContent = mv.value + '%'; setMicVolume(mv.value / 100); };
  $('[data-vbcable]', dlg).onclick = () => native() ? native().open_external('https://vb-audio.com/Cable/') : toast('Va sur vb-audio.com/Cable');
  form.onsubmit = e => { e.preventDefault(); read(); dlg.close(); toast('Paramètres enregistrés'); };
  $('[data-close]', dlg).onclick = () => dlg.close();
  $$('[data-dl-all]', dlg).forEach(b => b.onclick = () => {
    read();
    const t = b.dataset.dlAll;
    downloadAll(S.items.filter(i => t === 'youtube' ? i.type === 'youtube' && i.ytId : i.type === 'spotify' && i.spType === 'track'), dlFormat());
    dlg.close();
  });
  dlg.onclose = () => dlg.classList.remove('wide');
  dlg.showModal();
}

// ---------- une pochette pour chaque son ----------
// Son venu de YouTube → sa miniature. Sinon → pochette officielle (iTunes / Deezer) d'après titre + artiste.
const artQ = [];
let artBusy = false;
const ART_V = 2; // version de la recherche : les sons restés sans pochette sont recherchés à nouveau
function needsArt(it) { return it && !it.cover && it.artTried !== ART_V; }
const artQuery = it => `title=${encodeURIComponent(it.title || '')}&artist=${encodeURIComponent((it.artist || '').split(',')[0])}`;
function enqueueArt(it) {
  if (!needsArt(it)) return;
  if (it.ytId) { // instantané
    it.cover = imgProxy(`https://i.ytimg.com/vi/${it.ytId}/maxresdefault.jpg`);
    it.coverFb = imgProxy(`https://i.ytimg.com/vi/${it.ytId}/hqdefault.jpg`);
    save(); scheduleRender();
    return;
  }
  if (!artQ.includes(it)) artQ.push(it);
  runArtQ();
}
async function runArtQ() {
  if (artBusy) return;
  artBusy = true;
  while (artQ.length) {
    const it = artQ.shift();
    if (!byId(it.id) || it.cover) continue;
    try {
      const j = await (await fetch('/api/artwork?' + artQuery(it))).json();
      it.artTried = ART_V; // on ne recherche qu'une fois (change le titre pour relancer)
      if (j.url) {
        it.cover = imgProxy(j.url); it.pubCover = j.fb && j.src === 'youtube' ? j.fb : j.url;
        if (j.fb) it.coverFb = imgProxy(j.fb);
        it.hue = await colorHue(it.cover);
        scheduleRender();
        if (P.cur === it) { renderNowInfo(); applyHue(it); }
      }
      save();
    } catch { break; } // pas de réseau : on réessaiera au prochain lancement
  }
  artBusy = false;
}

// pochettes des titres importés, récupérées en arrière-plan
const coverQ = [];
let coverBusy = false;
async function runCoverQ() {
  if (coverBusy) return;
  coverBusy = true;
  const worker = async () => {
    while (coverQ.length) {
      const it = coverQ.shift();
      if (!byId(it.id) || it.cover) continue;
      try {
        const m = await (await fetch('/api/meta?light=1&url=' + encodeURIComponent(it.url))).json();
        if (m.thumbnail) { it.cover = imgProxy(m.thumbnail); scheduleRender(); if (P.cur === it) { renderNowInfo(); applyHue(it); } }
      } catch { }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  coverBusy = false;
  save();
}
async function fetchMeta(it) {
  try {
    const r = await fetch('/api/meta?url=' + encodeURIComponent(it.url));
    if (!r.ok) throw new Error();
    const m = await r.json();
    if (it.type === 'youtube') {
      const c = cleanYT(m.title, m.author);
      it.title = c.title; it.artist = c.artist;
      if (it.ytList) { it.artist = (m.author ? m.author + ' · ' : '') + 'Playlist'; if (m.thumbnail) it.cover = imgProxy(m.thumbnail); }
    } else {
      it.title = m.title || it.title;
      it.artist = m.author && !/^(playlist|spotify)$/i.test(m.author) ? m.author : SP_KIND[it.spType];
      if (m.thumbnail) it.cover = imgProxy(m.thumbnail);
    }
    it.hue = await hueFor(it);
  } catch { /* hors ligne : on garde le titre par défaut */ }
  save(); scheduleRender();
  if (P.cur === it) { renderNowInfo(); applyHue(it); }
}

// ---------- playlists, favoris, suppression ----------
function toggleFav(id) {
  const it = byId(id); if (!it) return;
  it.fav = !it.fav; save(); scheduleRender();
  if (P.cur === it) renderNowInfo();
}
async function newPlaylist(withId) {
  const v = await dialog({ title: 'Nouvelle playlist', fields: [{ name: 'name', label: 'Nom', ph: 'Ma playlist', value: '' }], ok: 'Créer' });
  if (!v || !v.name.trim()) return;
  const p = { id: uid(), name: v.name.trim(), items: withId ? [withId] : [], createdAt: Date.now() };
  S.playlists.push(p); save();
  if (withId) { scheduleRender(); toast(`Ajouté à « ${p.name} »`); } else setView('pl:' + p.id);
}
function addToPlaylist(pid, id) {
  const p = S.playlists.find(x => x.id === pid); if (!p) return;
  if (p.items.includes(id)) return toast(`Déjà dans « ${p.name} »`);
  p.items.push(id); save(); scheduleRender(); toast(`Ajouté à « ${p.name} »`);
}
async function editItem(id) {
  const it = byId(id); if (!it) return;
  const v = await dialog({ title: 'Modifier', fields: [{ name: 'title', label: 'Titre', value: it.title }, { name: 'artist', label: 'Artiste', value: it.artist }], ok: 'Enregistrer' });
  if (!v) return;
  it.title = v.title.trim() || it.title; it.artist = v.artist.trim();
  delete it.pubCover; // on recherchera la bonne pochette pour Discord
  if (it.artTried) { // la pochette venait d'une recherche : on la refait avec le nouveau titre
    delete it.artTried;
    if (/mzstatic|dzcdn|ytimg/.test(it.cover || '') && !(it.ytId && (it.cover || '').includes(it.ytId))) { delete it.cover; delete it.coverFb; }
    enqueueArt(it);
  }
  save(); scheduleRender(); if (P.cur === it) renderNowInfo();
}
async function deleteItem(id) {
  const it = byId(id); if (!it) return;
  const local = it.type === 'local';
  const ok = await dialog({
    title: local ? 'Supprimer ce son ?' : 'Retirer ce lien ?',
    text: local ? `« ${esc(it.title)} » sera supprimé de ta bibliothèque et du dossier Onde (ton fichier d'origine n'est pas touché).` : `« ${esc(it.title)} » sera retiré de ta bibliothèque.`,
    ok: local ? 'Supprimer' : 'Retirer', danger: true,
  });
  if (!ok) return;
  if (local) await fetch('/api/files/' + encodeURIComponent(it.file), { method: 'DELETE' }).catch(() => {});
  removeItems([id]);
}
function removeItems(ids) {
  const set = new Set(ids);
  S.items = S.items.filter(i => !set.has(i.id));
  S.playlists.forEach(p => { p.items = p.items.filter(x => !set.has(x)); });
  if (P.cur && set.has(P.cur.id)) {
    P.eng && P.eng.stop(); P.cur = null; P.eng = null; setPlaying(false); setStage(null); renderNowInfo(); setHue(262);
    $('#tCur').textContent = '0:00'; $('#tDur').textContent = '0:00'; seekEl.value = 0; setP(seekEl);
  }
  const curId = P.cur && P.cur.id;
  P.queue = P.queue.filter(x => !set.has(x)); P.base = P.base.filter(x => !set.has(x));
  P.idx = curId ? P.queue.indexOf(curId) : -1;
  save(); scheduleRender();
}

// ---------- menu contextuel ----------
const menu = $('#menu');
function openMenu(id, x, y) {
  const it = byId(id); if (!it) return;
  const pl = currentPlaylist();
  const ext = it.type === 'youtube' ? 'Ouvrir sur YouTube' : it.type === 'spotify' ? 'Ouvrir dans Spotify' : null;
  menu.dataset.id = id;
  menu.innerHTML = `
    <button data-act="m-next">${ic('listplus')}Lire ensuite</button>
    <button data-act="m-queue">${ic('queue')}Ajouter à la file d'attente</button>
    <button data-act="fav">${ic('heart')}${it.fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}</button>
    <hr><div class="menu-label">Ajouter à une playlist</div>
    ${S.playlists.map(p => `<button data-act="m-addpl" data-pl="${p.id}">${ic('music')}${esc(p.name)}</button>`).join('')}
    <button data-act="m-newpl">${ic('plus')}Nouvelle playlist…</button>
    ${pl ? `<button data-act="m-rmpl">${ic('x')}Retirer de « ${esc(pl.name)} »</button>` : ''}
    <hr>
    ${it.type === 'spotify' && (it.spType === 'playlist' || it.spType === 'album') ? `<button data-act="m-import">${ic('listplus')}Importer tous les titres</button>` : ''}
    ${canDownload(it) && !DL.has(it.id) ? `<hr><button data-act="m-dl" data-fmt="mp3">${ic('download')}Télécharger en MP3</button><button data-act="m-dl" data-fmt="mp4">${ic('download')}Télécharger en MP4</button><hr>` : ''}
    ${it.type === 'spotify' && it.spType === 'track' ? (viaYT(it)
      ? `<button data-act="m-altyt">${ic('youtube')}Mauvaise version ? Essayer une autre</button><button data-act="m-spnative">${ic('spotify')}Utiliser le lecteur Spotify</button>`
      : `<button data-act="m-spnative">${ic('youtube')}Lire en entier via YouTube</button>`) : ''}
    <button data-act="m-share">${ic('share')}Partager dans la Communauté</button>
    <button data-act="m-vol">${ic('vol')}Volume de ce son (${Math.round(trackGain(it) * 100)} %)</button>
    <button data-act="m-edit">${ic('edit')}Modifier titre / artiste</button>
    ${ext ? `<button data-act="m-open">${ic(it.type)}${ext}</button>` : ''}
    <button data-act="m-delete" class="danger">${ic('trash')}${it.type === 'local' ? 'Supprimer le son' : 'Retirer de la bibliothèque'}</button>`;
  menu.classList.add('open');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  menu.style.top = Math.max(10, Math.min(y, innerHeight - r.height - 10)) + 'px';
}
function closeMenu() { menu.classList.remove('open'); }

// ---------- boîtes de dialogue & notifications ----------
const dlg = $('#dlg');
function dialog({ title, text = '', fields = [], ok = 'OK', danger = false, hint = '' }) {
  return new Promise(res => {
    dlg.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${hint}
      ${fields.map(f => `<label class="field"><span>${esc(f.label)}</span>${f.area
        ? `<textarea name="${f.name}" rows="${f.rows || 4}" placeholder="${esc(f.ph || '')}" spellcheck="false">${esc(f.value || '')}</textarea>`
        : `<input name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.ph || '')}" spellcheck="false" autocomplete="off">`}</label>`).join('')}
      <div class="dlg-actions"><button class="btn" type="button" data-close>Annuler</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(ok)}</button></div></form>`;
    const form = $('form', dlg);
    let done = false;
    const finish = v => { if (done) return; done = true; dlg.close(); res(v); };
    $('[data-close]', dlg).onclick = () => finish(null);
    form.onsubmit = e => { e.preventDefault(); finish(fields.length ? Object.fromEntries(new FormData(form)) : true); };
    form.onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) form.requestSubmit(); };
    dlg.onclose = () => finish(null);
    dlg.showModal();
    setTimeout(() => { const f = $('input,textarea', dlg); if (f) { f.focus(); f.select && f.select(); } }, 30);
  });
}
function toast(msg, type = 'ok', sticky = false, progress = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' err' : '');
  el.innerHTML = `${ic(type === 'err' ? 'x' : type === 'upload' ? 'upload' : 'sparkle')}<span>${esc(msg)}</span>${progress ? '<div class="tbar"><i></i></div>' : ''}`;
  $('#toasts').append(el);
  const toasts = $$('.toast'); if (toasts.length > 4) toasts[0].remove();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  if (!sticky) setTimeout(close, type === 'err' ? 4500 : 2600);
  return { close, progress: p => { const i = $('.tbar i', el); if (i) i.style.width = Math.round(p * 100) + '%'; }, text: t => { $('span', el).textContent = t; } };
}

async function askLink() {
  const hint = `<div class="hint"><span>${ic('youtube')}Vidéos, Shorts, playlists</span><span>${ic('spotify')}Titres, podcasts</span><span>${ic('listplus')}Playlists et albums Spotify importés titre par titre</span></div>`;
  const v = await dialog({
    title: 'Ajouter des liens', text: 'Colle un ou plusieurs liens (un par ligne).', hint,
    fields: [{ name: 'links', label: 'Liens', area: true, rows: 4, ph: 'https://youtu.be/…\nhttps://open.spotify.com/track/…' }], ok: 'Ajouter',
  });
  if (v && v.links.trim()) addLinks(v.links);
}

// ---------- panneaux ----------
const wide = () => matchMedia('(min-width:1281px)').matches;
function toggleNowPanel() {
  if (wide()) document.body.classList.toggle('now-hidden');
  else document.body.classList.toggle('now-open');
  save();
}
function toggleImmersive(force) {
  const on = document.body.classList.toggle('immersive', force);
  $$('[data-act="immersive"] use').forEach(u => u.setAttribute('href', on ? '#i-shrink' : '#i-expand'));
  save();
}

// ---------- actions ----------
async function act(name, id, el, e) {
  switch (name) {
    case 'play-item': return playItem(id);
    case 'fav': return toggleFav(id);
    case 'fav-current': return P.cur && toggleFav(P.cur.id);
    case 'more': { const r = el.getBoundingClientRect(); return openMenu(id, r.right - 230, r.bottom + 6); }
    case 'play-view': { const l = viewItems(); return playList(l, S.settings.shuffle ? Math.floor(Math.random() * l.length) : 0); }
    case 'shuffle-view': { const l = viewItems(); if (!S.settings.shuffle) { S.settings.shuffle = true; renderBarState(); save(); } return playList(l, Math.floor(Math.random() * l.length)); }
    case 'layout-grid': S.settings.layout = 'grid'; save(); return renderMain();
    case 'layout-list': S.settings.layout = 'list'; save(); return renderMain();
    case 'add-files': return importNative('files');
    case 'add-folder': return importNative('folder');
    case 'add-link': return askLink();
    case 'new-playlist': return newPlaylist();
    case 'reveal': return native() ? native().reveal() : toast("Disponible dans l'app Onde.", 'err');
    case 'spotify-login':
      if (!native()) return toast("Disponible dans l'app Onde.", 'err');
      toast('Connecte-toi puis ferme la fenêtre : les sons Spotify passeront en version complète.');
      return native().spotify_login();
    case 'toggle': return toggle();
    case 'prev': return prev();
    case 'next': return next();
    case 'shuffle': return setShuffle(!S.settings.shuffle);
    case 'repeat': return cycleRepeat();
    case 'mute': S.settings.muted = !S.settings.muted; applyVolume(); return save();
    case 'immersive': return toggleImmersive();
    case 'toggle-now': return toggleNowPanel();
    case 'clear-queue':
      if (P.cur) { P.queue = [P.cur.id]; P.base = [P.cur.id]; P.idx = 0; } else { P.queue = []; P.base = []; P.idx = -1; }
      return renderQueue();
    case 'q-remove': {
      const qi = +el.closest('[data-qi]').dataset.qi;
      const [rm] = P.queue.splice(qi, 1);
      const bi = P.base.lastIndexOf(rm); if (bi >= 0 && rm !== (P.cur && P.cur.id)) P.base.splice(bi, 1);
      return renderQueue();
    }
    case 'pl-rename': {
      const p = currentPlaylist(); if (!p) return;
      const v = await dialog({ title: 'Renommer la playlist', fields: [{ name: 'name', label: 'Nom', value: p.name }], ok: 'Renommer' });
      if (v && v.name.trim()) { p.name = v.name.trim(); save(); renderNav(); renderMain(); }
      return;
    }
    case 'pl-delete': {
      const p = currentPlaylist(); if (!p) return;
      const ok = await dialog({ title: 'Supprimer la playlist ?', text: `« ${esc(p.name)} » sera supprimée. Les sons restent dans ta bibliothèque.`, ok: 'Supprimer', danger: true });
      if (ok) { S.playlists = S.playlists.filter(x => x !== p); save(); setView('home'); }
      return;
    }
    case 'm-next': closeMenu(); return playNext(id);
    case 'm-queue': closeMenu(); return addToQueue(id);
    case 'm-addpl': closeMenu(); return addToPlaylist(el.dataset.pl, id);
    case 'm-newpl': closeMenu(); return newPlaylist(id);
    case 'm-rmpl': {
      closeMenu();
      const p = currentPlaylist(); if (!p) return;
      p.items = p.items.filter(x => x !== id); save(); return scheduleRender();
    }
    case 'm-import': { closeMenu(); const it = byId(id); return it && importSpotify(it.spType, it.spId); }
    case 'm-altyt': {
      closeMenu(); const it = byId(id); if (!it) return;
      if (it.ytCands && it.ytCands.length > 1) { it.ytPick = ((it.ytPick || 0) + 1) % it.ytCands.length; save(); }
      else return toast('Pas d\'autre version trouvée.', 'err');
      toast(`Version ${it.ytPick + 1} sur ${it.ytCands.length}`);
      return P.cur === it ? load(it, true) : playItem(id);
    }
    case 'm-dl': { closeMenu(); const it = byId(id); if (it && enqueueDownload(it, el.dataset.fmt)) toast(`Téléchargement en ${el.dataset.fmt.toUpperCase()}…`); return; }
    case 'dl-view': return downloadAll(viewItems(), dlFormat());
    case 'settings': return openSettings();
    case 'm-spnative': {
      closeMenu(); const it = byId(id); if (!it) return;
      it.spNative = viaYT(it); save();
      toast(it.spNative ? 'Lecteur Spotify (30 s sans connexion Spotify)' : 'Lecture en entier via YouTube');
      if (P.cur === it) load(it, true);
      return;
    }
    case 'm-vol': closeMenu(); return trackVolumeDialog(id);
    case 'm-share': { closeMenu(); const it = byId(id); return it && shareItems([it], it.title); }
    case 'share-view': { const pl = currentPlaylist(); return shareItems(viewItems(), pl ? pl.name : (VIEWS[view] || {}).name || 'Ma sélection'); }
    case 'share-pick': return sharePick();
    case 'feed-refresh': return loadFeed(true);
    case 'account': return openAccount();
    case 'do-update': return doUpdate();
    case 'post-play': case 'post-add': case 'post-del': {
      const pid = el.closest('[data-post]').dataset.post;
      const p = (FEED || []).find(x => String(x.id) === pid);
      if (!p) return;
      if (name === 'post-del') return deletePost(p);
      const pl = importPost(p);
      if (name === 'post-play') return playList(pl.items.map(byId), 0);
      return toast(`« ${p.title} » ajoutée à tes playlists ✦`);
    }
    case 'm-edit': closeMenu(); return editItem(id);
    case 'm-open': { closeMenu(); const it = byId(id); if (it && native()) native().open_external(it.url); return; }
    case 'm-delete': closeMenu(); return deleteItem(id);
  }
}

document.addEventListener('click', e => {
  if (!menu.contains(e.target)) closeMenu();
  if (e.target.closest('dialog')) return;
  const v = e.target.closest('[data-view]');
  if (v) return setView(v.dataset.view);
  const a = e.target.closest('[data-act]');
  const host = e.target.closest('[data-id]');
  const id = host && host.dataset.id;
  if (a) { act(a.dataset.act, id, a, e); if (menu.contains(a) && a.dataset.act === 'fav') closeMenu(); return; }
  if (!host) return;
  if (host.classList.contains('q-item')) { P.idx = +host.dataset.qi; return load(byId(P.queue[P.idx]), true); }
  if (host.classList.contains('card') || host.classList.contains('row')) playItem(id);
});
$('#barCover').addEventListener('click', () => P.cur && toggleImmersive());
document.addEventListener('contextmenu', e => {
  if (e.target.closest('input, textarea')) return;
  e.preventDefault();
  const host = e.target.closest('.card, .row, .q-item');
  if (host) openMenu(host.dataset.id, e.clientX, e.clientY);
});
document.addEventListener('change', e => {
  if (e.target.id === 'sortSel') { S.settings.sort = e.target.value; save(); renderMain(); }
});
$('#content').addEventListener('scroll', closeMenu);
$('#pickFiles').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });

// recherche
$('#search').addEventListener('input', e => {
  query = e.target.value.trim();
  if (query && view === 'home') view = 'all';
  renderNav(); renderMain();
});

// clavier
addEventListener('keydown', e => {
  const t = e.target;
  const typing = (t.tagName === 'INPUT' && t.type !== 'range') || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || dlg.open;
  if (e.key === 'Escape') {
    closeMenu();
    if (document.body.classList.contains('immersive')) toggleImmersive(false);
    if (t.id === 'search') t.blur();
    return;
  }
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const keys = {
    ' ': toggle,
    ArrowRight: () => (e.shiftKey ? next() : seekBy(5)),
    ArrowLeft: () => (e.shiftKey ? prev() : seekBy(-5)),
    ArrowUp: () => { S.settings.volume = Math.min(3, S.settings.volume + 0.05); S.settings.muted = false; applyVolume(); save(); },
    ArrowDown: () => { S.settings.volume = Math.max(0, S.settings.volume - 0.05); applyVolume(); save(); },
    m: () => act('mute'), f: () => toggleImmersive(), s: () => setShuffle(!S.settings.shuffle), r: cycleRepeat,
    '/': () => $('#search').focus(),
  };
  if (keys[k]) { e.preventDefault(); keys[k](); }
});

// glisser-déposer
let dragDepth = 0;
const droppable = e => { const ty = [...(e.dataTransfer ? e.dataTransfer.types : [])]; return ty.includes('Files') || ty.includes('text/uri-list') || ty.includes('text/plain'); };
addEventListener('dragenter', e => { if (!droppable(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
addEventListener('dragover', e => { if (droppable(e)) e.preventDefault(); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const dt = e.dataTransfer;
  if (dt.files && dt.files.length) return uploadFiles(dt.files);
  const txt = dt.getData('text/uri-list') || dt.getData('text/plain');
  if (txt) addLinks(txt);
});

// coller un lien (Ctrl+V) n'importe où
document.addEventListener('paste', e => {
  if (e.target.closest('input, textarea')) return;
  const files = e.clipboardData.files;
  if (files && files.length) { e.preventDefault(); return uploadFiles(files); }
  const txt = e.clipboardData.getData('text');
  if (txt && txt.split(/\s+/).some(parseLink)) { e.preventDefault(); addLinks(txt); }
});

// ---------- compte (GitHub pour poster, Discord pour le profil) ----------
let ACC = { github: null, discord: null, version: '', repo: '' };
async function refreshAccount() {
  try { ACC = await (await fetch('/api/account')).json(); } catch { }
  renderProfileChip();
}
function renderProfileChip() {
  const c = $('#profileChip');
  const name = (ACC.discord && ACC.discord.name) || (ACC.github && ACC.github.login);
  const av = (ACC.discord && ACC.discord.avatar) || (ACC.github && ACC.github.avatar);
  c.innerHTML = name ? `<img src="${esc(av || '')}" alt=""><span>${esc(name)}</span>` : `${ic('user')}<span>Se connecter</span>`;
}
function openAccount() {
  const row = (key, icon, title, who, desc) => `<div class="acc-row">${ic(icon)}<div><b>${title}</b><small>${who ? 'Connecté : ' + esc(who) : desc}</small></div>
    ${who ? `<button class="btn" type="button" data-out="${key}">Déconnecter</button>` : `<button class="btn primary" type="button" data-in="${key}">Se connecter</button>`}</div>`;
  dlg.innerHTML = `<form method="dialog"><h3>Mon compte</h3>
    <p>Sert pour la Communauté. Tes sons et réglages restent sur ton PC.</p>
    ${row('discord', 'discord', 'Discord', ACC.discord && ACC.discord.name, 'Ton pseudo et ton avatar sur tes posts')}
    ${row('github', 'github', 'GitHub', ACC.github && ACC.github.login, 'Nécessaire pour poster (compte gratuit)')}
    <div class="set-desc" style="margin-top:14px">Onde ${esc(ACC.version || '')} · <a href="#" data-repo>page du projet</a></div>
    <div class="dlg-actions"><button class="btn" type="button" data-close>Fermer</button></div></form>`;
  $('[data-close]', dlg).onclick = () => dlg.close();
  $('[data-repo]', dlg).onclick = e => { e.preventDefault(); native() && native().open_external(`https://github.com/${ACC.repo}`); };
  $$('[data-in]', dlg).forEach(b => b.onclick = () => { dlg.close(); b.dataset.in === 'discord' ? loginDiscord() : loginGitHub(); });
  $$('[data-out]', dlg).forEach(b => b.onclick = async () => {
    await fetch('/api/account/logout', { method: 'POST', body: JSON.stringify({ which: b.dataset.out }) });
    await refreshAccount(); openAccount();
  });
  dlg.onclose = null;
  dlg.showModal();
}
async function loginDiscord() {
  if (!native()) return toast("Disponible dans l'app Onde.", 'err');
  const r = await native().discord_login();
  if (r && r.error) return toast('Discord : ' + r.error, 'err');
  toast('Connecte-toi dans la fenêtre Discord…');
  for (let i = 0; i < 160; i++) {
    await sleep(1500);
    await refreshAccount();
    if (ACC.discord) { toast(`Connecté à Discord : ${ACC.discord.name} ✓`); if (view === 'community') renderMain(); return true; }
  }
  return false;
}
async function loginGitHub() {
  let s;
  try {
    const r = await fetch('/api/gh/start', { method: 'POST' });
    s = await r.json();
    if (!r.ok || !s.user_code) throw new Error(s.error || 'GitHub ne répond pas');
  } catch (e) { toast('GitHub : ' + (e.message || e), 'err'); return false; }
  try { await navigator.clipboard.writeText(s.user_code); } catch { }
  dlg.innerHTML = `<form method="dialog"><h3>Connexion GitHub</h3>
    <p>Dans la fenêtre GitHub, connecte-toi puis colle ce code (il est déjà copié) et autorise <b>Onde Music App</b>.</p>
    <div class="device-code">${esc(s.user_code)}</div>
    <p class="set-desc" style="text-align:center">En attente de GitHub…</p>
    <div class="dlg-actions"><button class="btn" type="button" data-open>Rouvrir GitHub</button><button class="btn" type="button" data-close>Annuler</button></div></form>`;
  let stop = false;
  const open = () => (native() ? native().open_login(s.url, 'Connexion GitHub') : window.open(s.url));
  $('[data-open]', dlg).onclick = open;
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.onclose = () => { stop = true; };
  dlg.showModal();
  open();
  let wait = (s.interval || 5) * 1000;
  while (!stop) {
    await sleep(wait);
    if (stop) break;
    let p;
    try { p = await (await fetch('/api/gh/poll', { method: 'POST' })).json(); } catch { continue; }
    if (p.done) {
      ACC = { ...ACC, github: p.github, discord: p.discord };
      renderProfileChip(); dlg.close();
      toast(`Connecté à GitHub : ${p.github.login} ✓`);
      return true;
    }
    if (p.slow) wait += 5000;
    if (p.error) { dlg.close(); toast('GitHub : ' + p.error, 'err'); return false; }
  }
  return false;
}

// ---------- Communauté ----------
let FEED = null, feedLoading = false, feedError = '', feedAt = 0;
const coverUrl = u => (/^https:\/\/(i\.ytimg\.com|i\.scdn\.co|[\w.-]+\.mzstatic\.com|[\w.-]+\.dzcdn\.net)\//.test(u || '') ? imgProxy(u) : u);
async function loadFeed(force = false) {
  if (feedLoading || (!force && FEED && Date.now() - feedAt < 45000)) return;
  feedLoading = true;
  if (view === 'community') renderMain();
  try {
    const r = await fetch('/api/community' + (force ? '?force=1' : ''));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    FEED = Array.isArray(j) ? j : []; feedError = ''; feedAt = Date.now();
  } catch (e) { feedError = e.message || 'erreur'; }
  feedLoading = false;
  if (view === 'community') renderMain();
}
function timeAgo(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `il y a ${Math.floor(s / 86400)} j`;
  return new Date(d).toLocaleDateString('fr-FR');
}
function postHTML(p) {
  const who = (p.discord && p.discord.name) || p.author;
  const av = (p.discord && p.discord.avatar) || p.avatar || '';
  const mine = ACC.github && ACC.github.login === p.author;
  const tracks = p.tracks || [];
  const art = tracks.slice(0, 4).map(t => {
    if (t.cover) return `<img src="${esc(coverUrl(t.cover))}" alt="" loading="lazy">`;
    const h = hash(t.title || '') % 360;
    return `<div class="gen" style="--g1:${h};--g2:${(h + 70) % 360}">${ic('music')}</div>`;
  }).join('');
  const have = S.playlists.some(x => x.postSource === p.id);
  return `<article class="post" data-post="${esc(p.id)}">
    <div class="post-art n${Math.min(4, tracks.length)}">${art}</div>
    <div class="post-body">
      <div class="post-head">${av ? `<img class="post-av" src="${esc(av)}" alt="">` : ''}<b>${esc(who)}</b><span>· ${timeAgo(p.date)}</span>${p.discord ? `<span class="post-gh" title="Compte GitHub : ${esc(p.author)}">${ic('github')}</span>` : ''}</div>
      <h3>${esc(p.title)}</h3>
      ${p.text ? `<p>${esc(p.text)}</p>` : ''}
      <div class="post-tracks">${tracks.slice(0, 5).map(t => `<span>${esc(t.title)}${t.artist ? ` <i>· ${esc(t.artist)}</i>` : ''}</span>`).join('')}${tracks.length > 5 ? `<span class="more">+ ${tracks.length - 5} autres</span>` : ''}</div>
      <div class="post-acts">
        <button class="btn primary" data-act="post-play">${ic('play')}Écouter</button>
        <button class="btn" data-act="post-add">${ic(have ? 'refresh' : 'plus')}${have ? 'Mettre à jour ma copie' : 'Ajouter à ma bibliothèque'}</button>
        ${mine ? `<button class="icon-btn" data-act="post-del" title="Supprimer mon post">${ic('trash')}</button>` : ''}
      </div>
    </div></article>`;
}
function communityHTML() {
  const me = ACC.github ? `Connecté en tant que <b>${esc((ACC.discord && ACC.discord.name) || ACC.github.login)}</b>` : `<a href="#" data-act="account">Connecte-toi</a> pour poster`;
  let body;
  if (feedLoading && !FEED) body = `<div class="note">Chargement de la Communauté…</div>`;
  else if (feedError && !FEED) body = `<div class="note">Impossible de charger la Communauté (${esc(feedError)}).<br><button class="btn" data-act="feed-refresh" style="margin-top:12px">${ic('refresh')}Réessayer</button></div>`;
  else if (!FEED || !FEED.length) body = `<div class="empty"><div class="empty-art">${ic('users')}</div><h2>Personne n'a encore posté</h2><p>Sois le premier : partage une playlist ou tes sons du moment.</p><div class="btns"><button class="btn primary" data-act="share-pick">${ic('share')}Partager une playlist</button></div></div>`;
  else body = `<div class="feed">${FEED.map(postHTML).join('')}</div>`;
  return `<div class="hero" style="--vh:200"><div class="hero-art comm">${ic('users')}</div><div class="hero-text"><div class="eyebrow">En ligne</div><h1>Communauté</h1><div class="hero-sub">Les playlists partagées par tout le monde · ${me}</div></div></div>
    <div class="toolbar"><button class="btn primary" data-act="share-pick">${ic('share')}Partager une playlist</button>
    <button class="icon-btn" data-act="feed-refresh" title="Actualiser">${ic('refresh')}</button><span class="spacer"></span>
    <span class="set-desc" style="margin:0">On partage des liens YouTube / Spotify, jamais tes fichiers.</span></div>${body}`;
}
function importPost(p) {
  const ids = [];
  for (const t of p.tracks || []) {
    const pl = parseLink(t.url);
    if (!pl) continue;
    let it = S.items.find(i => i.url === pl.url);
    if (!it) {
      it = { id: uid(), ...pl, title: t.title || 'Son', artist: t.artist || '', kind: pl.type === 'youtube' ? 'video' : 'audio', addedAt: Date.now() - ids.length, duration: t.duration || 0 };
      if (pl.type === 'spotify') it.spUri = `spotify:${pl.spType}:${pl.spId}`;
      if (t.cover) it.cover = coverUrl(t.cover);
      else if (pl.ytId) { it.cover = imgProxy(`https://i.ytimg.com/vi/${pl.ytId}/maxresdefault.jpg`); it.coverFb = imgProxy(`https://i.ytimg.com/vi/${pl.ytId}/hqdefault.jpg`); }
      S.items.push(it);
      if (pl.type === 'youtube' && pl.ytId && S.settings.ytDownload !== 'off') enqueueDownload(it, S.settings.ytDownload);
      if (pl.type === 'spotify' && pl.spType === 'track' && S.settings.spDownload) enqueueDownload(it, dlFormat());
    }
    if (!ids.includes(it.id)) ids.push(it.id);
  }
  let plst = S.playlists.find(x => x.postSource === p.id);
  if (plst) plst.items = ids;
  else { plst = { id: uid(), name: p.title, items: ids, createdAt: Date.now(), postSource: p.id }; S.playlists.push(plst); }
  const c = (p.tracks || []).find(t => t.cover);
  if (c) plst.cover = coverUrl(c.cover);
  save(); scheduleRender();
  return plst;
}
async function shareItems(items, defTitle) {
  items = items.filter(Boolean);
  if (!items.length) return toast('Rien à partager ici.', 'err');
  if (!ACC.github) {
    toast('Connecte-toi à GitHub pour poster (une seule fois).');
    if (!(await loginGitHub())) return;
  }
  const v = await dialog({
    title: 'Partager dans la Communauté',
    text: `${plural(Math.min(items.length, 100), 'son')} partagé${items.length > 1 ? 's' : ''} sous forme de liens YouTube / Spotify (jamais tes fichiers).`,
    fields: [{ name: 'title', label: 'Titre', value: defTitle }, { name: 'text', label: 'Message (optionnel)', area: true, rows: 3, ph: 'Mes sons du moment…' }],
    ok: 'Publier',
  });
  if (!v || !v.title.trim()) return;
  const t = toast('Préparation du post…', 'upload', true, true);
  const tracks = [];
  const list = items.slice(0, 100);
  for (const [n, it] of list.entries()) {
    let url = null;
    if (it.type === 'spotify' && it.spType === 'track') url = it.url;
    else if (it.ytId) url = `https://www.youtube.com/watch?v=${it.ytId}`;
    else if (it.url && parseLink(it.url)) url = it.url;
    else { // fichier perso : on partage le même son trouvé sur YouTube
      try {
        const ids = await (await fetch('/api/yt-search?q=' + encodeURIComponent(`${(it.artist || '').split(',')[0]} ${it.title}`.trim()))).json();
        if (ids[0]) url = `https://www.youtube.com/watch?v=${ids[0]}`;
      } catch { }
    }
    t.progress((n + 1) / list.length);
    if (!url) continue;
    let img = it.pubCover || '';
    if (!img && (it.cover || '').startsWith('/api/img?u=')) img = decodeURIComponent(it.cover.slice(11));
    if (!img && it.ytId) img = `https://i.ytimg.com/vi/${it.ytId}/hqdefault.jpg`;
    tracks.push({ url, title: String(it.title).slice(0, 120), artist: String(it.artist || '').slice(0, 120), cover: /^https:\/\//.test(img) ? img : '', duration: Math.round(it.duration || 0) });
  }
  if (!tracks.length) { t.close(); return toast('Aucun son partageable.', 'err'); }
  try {
    const r = await fetch('/api/community', { method: 'POST', body: JSON.stringify({ kind: 'post', payload: { title: v.title.trim().slice(0, 80), text: (v.text || '').trim().slice(0, 300), tracks } }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    t.close();
    toast('Publié ✦ Visible par tout le monde dans environ 1 minute.');
    setTimeout(() => loadFeed(true), 75000);
  } catch (e) { t.close(); toast('Publication impossible : ' + (e.message || e), 'err'); }
}
function sharePick() {
  const opts = S.playlists.map(p => ({ key: 'pl:' + p.id, name: p.name, n: p.items.length }));
  const fav = S.items.filter(i => i.fav).length;
  if (fav) opts.unshift({ key: 'fav', name: 'Mes favoris', n: fav });
  if (!opts.length) return toast("Crée d'abord une playlist (ou mets des sons en favori).", 'err');
  dlg.innerHTML = `<form method="dialog"><h3>Quelle playlist partager ?</h3><div class="pick-list">
    ${opts.map(o => `<button type="button" class="pick" data-k="${esc(o.key)}"><b>${esc(o.name)}</b><small>${plural(o.n, 'son')}</small></button>`).join('')}</div>
    <div class="dlg-actions"><button class="btn" type="button" data-close>Annuler</button></div></form>`;
  $('[data-close]', dlg).onclick = () => dlg.close();
  $$('.pick', dlg).forEach(b => b.onclick = () => {
    dlg.close();
    const k = b.dataset.k;
    if (k === 'fav') return shareItems(S.items.filter(i => i.fav), 'Mes favoris');
    const p = S.playlists.find(x => 'pl:' + x.id === k);
    if (p) shareItems(p.items.map(byId), p.name);
  });
  dlg.onclose = null;
  dlg.showModal();
}
async function deletePost(p) {
  const ok = await dialog({ title: 'Supprimer ton post ?', text: `« ${esc(p.title)} » disparaîtra de la Communauté d'ici une minute.`, ok: 'Supprimer', danger: true });
  if (!ok) return;
  try {
    const r = await fetch('/api/community', { method: 'POST', body: JSON.stringify({ kind: 'delete', payload: { id: p.id, title: p.title } }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    FEED = FEED.filter(x => x !== p); renderMain();
    toast('Post supprimé');
  } catch (e) { toast('Suppression impossible : ' + (e.message || e), 'err'); }
}

// ---------- mises à jour ----------
async function checkUpdate() {
  try {
    const u = await (await fetch('/api/update')).json();
    if (!u.available) return;
    const b = $('#updateBanner');
    b.hidden = false;
    b.innerHTML = `${ic('sparkle')}<span><b>Onde ${esc(u.latest)}</b> est disponible (tu as la ${esc(u.current)}).</span><button class="btn primary" data-act="do-update">${ic('download')}Mettre à jour</button>`;
  } catch { }
}
async function doUpdate() {
  flushSave();
  const t = toast('Téléchargement de la mise à jour…', 'upload', true);
  try {
    const r = await fetch('/api/update', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error);
    t.text("L'installeur va s'ouvrir, Onde se ferme…");
  } catch (e) { t.close(); toast('Mise à jour impossible : ' + (e.message || e), 'err'); }
}

// ---------- démarrage ----------
async function init() {
  try {
    const d = await (await fetch('/api/library')).json();
    S.items = Array.isArray(d.items) ? d.items : [];
    S.playlists = Array.isArray(d.playlists) ? d.playlists : [];
    S.settings = { ...DEF_SETTINGS, ...(d.settings || {}) };
    S.last = d.last || null;
    S.rev = d.rev || 0;
    loaded = true;
  } catch {
    toast('Impossible de lire ta bibliothèque : rien ne sera enregistré pour ne rien écraser. Relance Onde.', 'err');
  }
  // on rouvre la page où tu étais
  const v = S.settings.view;
  if (v && (VIEWS[v] || (v.startsWith('pl:') && S.playlists.some(p => 'pl:' + p.id === v)))) view = v;

  // synchro avec le dossier des sons (tu peux aussi y déposer des fichiers à la main)
  try {
    const files = await (await fetch('/api/files')).json();
    const names = new Set(files.map(f => f.file));
    const gone = S.items.filter(i => i.type === 'local' && !names.has(i.file)).map(i => i.id);
    if (gone.length) removeItems(gone);
    for (const f of files) {
      if (S.items.some(i => i.type === 'local' && i.file === f.file)) continue;
      // un MP3/MP4 téléchargé alors que l'app était fermée : on le rattache à son lien d'origine
      const vid = ytIdOfFile(f.file);
      const owner = vid && S.items.find(i => (i.type === 'youtube' && i.ytId === vid) || (i.type === 'spotify' && i.ytCands && i.ytCands[i.ytPick || 0] === vid));
      if (owner) becomeLocal(owner, f.file, f.size, /\.mp4$/i.test(f.file) ? 'mp4' : 'mp3', true);
      else addLocalItem(f.file, f.size, f.file);
    }
    repairLibrary();
  } catch { }
  S.items.filter(i => i.type === 'local' && !i.probed && !probeQ.includes(i)).forEach(enqueueProbe);
  S.items.filter(i => (i.type !== 'local' || i.probed) && !i.ytInfo).forEach(enqueueArt); // sons encore sans pochette
  S.items.filter(i => i.type === 'spotify' && !i.cover && !coverQ.includes(i)).forEach(i => coverQ.push(i));
  runCoverQ();

  applyVolume();
  renderBarState();
  renderNowInfo();
  renderNav(); renderMain(); renderQueue();

  // une seule fois après la mise à jour : tous les liens YouTube déjà ajoutés passent en MP3
  if (loaded && !S.settings.ytMigrated) {
    S.settings.ytMigrated = true;
    const old = S.items.filter(i => i.type === 'youtube' && i.ytId);
    if (old.length) downloadAll(old, 'mp3');
    save();
  }

  if (S.settings.mic) startMic(true);
  refreshAccount();
  checkUpdate();
  if (view === 'community') loadFeed();

  // reprend là où tu t'étais arrêté (sans lancer la lecture)
  if (S.settings.nowHidden) document.body.classList.add('now-hidden');
  if (S.settings.immersive) toggleImmersive(true);
  const last = S.last && byId(S.last.id);
  if (last) {
    const q = S.queue || {};
    const ok = Array.isArray(q.ids) && q.ids.filter(byId).includes(last.id);
    if (ok) { // ta file d'attente telle que tu l'avais laissée
      P.queue = q.ids.filter(byId);
      P.base = (Array.isArray(q.base) ? q.base : q.ids).filter(byId);
      P.idx = P.queue.indexOf(last.id);
    } else {
      const ids = sortList(S.items, 'added').map(i => i.id);
      P.base = ids.slice(); P.queue = ids; P.idx = ids.indexOf(last.id);
    }
    load(last, false, viaYT(last) || last.type === 'local' || last.type === 'youtube' ? S.last.t || 0 : 0);
  }
}
init();

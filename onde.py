"""Onde — lecteur de musique de bureau.

Fenêtre native (WebView2 de Windows via pywebview), pas de navigateur, pas d'Electron.
Tes sons sont copiés dans  Musique/Onde/sons  et ta bibliothèque est dans  Musique/Onde/bibliotheque.json
"""
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import webview

# dans le .exe (sans console) il n'y a pas de sortie texte : yt-dlp en a besoin
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w', encoding='utf-8')

# pas de fenêtre noire qui clignote quand yt-dlp / ffmpeg / node tournent en arrière-plan
if os.name == 'nt':
    _Popen = subprocess.Popen

    class _QuietPopen(_Popen):
        def __init__(self, *a, **kw):
            kw.setdefault('creationflags', 0x08000000)  # CREATE_NO_WINDOW
            super().__init__(*a, **kw)
    subprocess.Popen = _QuietPopen

APP_NAME = 'Onde'
HERE = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
PUB = HERE / 'public'
DATA_DIR = Path.home() / 'Music' / APP_NAME
MUSIC = DATA_DIR / 'sons'
LIBRARY = DATA_DIR / 'bibliotheque.json'
WEB_PROFILE = DATA_DIR / '.profil'  # cookies (connexion Spotify), cache…
MUSIC.mkdir(parents=True, exist_ok=True)

MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.weba': 'audio/webm',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
}
MEDIA_EXT = {'.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.weba', '.mp4', '.m4v', '.webm', '.mkv', '.mov'}
IMG_HOSTS = ('i.ytimg.com', 'img.youtube.com', 'i.scdn.co', 'mosaic.scdn.co', 'seeded-session-images.scdn.co')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'


def unique_name(name: str) -> str:
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', Path(name).name).strip() or 'son'
    stem, ext = os.path.splitext(base)
    cand, i = base, 2
    while (MUSIC / cand).exists():
        cand = f'{stem} ({i}){ext}'
        i += 1
    return cand


def safe_media(name: str):
    base = Path(urllib.parse.unquote(name)).name
    if not base or base.startswith('.'):
        return None
    p = (MUSIC / base).resolve()
    return p if p.parent == MUSIC.resolve() else None


def youtube_search(q: str) -> list:
    """Les premières vidéos YouTube pour une recherche (sert à jouer les titres Spotify en entier)."""
    url = 'https://www.youtube.com/results?hl=fr&search_query=' + urllib.parse.quote(q)
    html = fetch(url, timeout=15, headers={'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
                                           'Cookie': 'CONSENT=YES+cb; SOCS=CAI'})[0].decode('utf-8', 'ignore')
    ids = []
    for vid in re.findall(r'"videoRenderer":\{"videoId":"([\w-]{11})"', html):
        if vid not in ids:
            ids.append(vid)
    return ids[:6]


def fetch(url: str, timeout=10, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get('Content-Type', '')


def spotify_list(kind: str, sid: str) -> dict:
    """Liste des titres d'une playlist / d'un album Spotify (lue depuis la page du lecteur intégré)."""
    if kind not in ('playlist', 'album') or not re.fullmatch(r'[A-Za-z0-9]+', sid or ''):
        raise ValueError('lien de playlist ou d\'album invalide')
    html = fetch(f'https://open.spotify.com/embed/{kind}/{sid}', timeout=20)[0].decode('utf-8', 'ignore')
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise ValueError('playlist introuvable (privée ?)')
    ent = json.loads(m.group(1))['props']['pageProps']['state']['data']['entity']
    covers = (ent.get('coverArt') or {}).get('sources') or []
    tracks = []
    for t in ent.get('trackList') or []:
        uri = t.get('uri', '')
        if not uri.startswith('spotify:track:') and not uri.startswith('spotify:episode:'):
            continue
        tracks.append({
            'uri': uri,
            'title': t.get('title', ''),
            'artist': (t.get('subtitle') or '').replace(' ', ' '),
            'duration': (t.get('duration') or 0) / 1000,
        })
    return {'name': ent.get('name') or ent.get('title') or 'Playlist Spotify',
            'author': (ent.get('subtitle') or '').replace(' ', ' '),
            'cover': covers[0]['url'] if covers else '', 'kind': kind, 'tracks': tracks}


def link_meta(u: str, light=False) -> dict:
    host = urllib.parse.urlparse(u).hostname or ''
    if host.endswith('youtube.com') or host.endswith('youtu.be'):
        body, _ = fetch('https://www.youtube.com/oembed?format=json&url=' + urllib.parse.quote(u, safe=''))
        j = json.loads(body)
        return {'title': j.get('title', ''), 'author': j.get('author_name', ''), 'thumbnail': j.get('thumbnail_url', '')}
    if host.endswith('spotify.com'):
        body, _ = fetch('https://open.spotify.com/oembed?url=' + urllib.parse.quote(u, safe=''))
        j = json.loads(body)
        out = {'title': j.get('title', ''), 'author': '', 'thumbnail': j.get('thumbnail_url', '')}
        if light:
            return out
        try:  # l'artiste n'est pas dans l'oEmbed : on le lit dans la page publique
            html = fetch(u)[0].decode('utf-8', 'ignore')
            m = re.search(r'name="music:musician_description" content="([^"]+)"', html)
            if not m:
                m = re.search(r'property="og:description" content="([^"]+)"', html)
            if m:
                import html as h
                a = h.unescape(m.group(1))
                if 'musician' not in m.group(0):
                    a = a.split(' · ')[0]
                    if a.lower().startswith('listen to'):
                        a = ''
                out['author'] = a[:120]
        except Exception:
            pass
        return out
    raise ValueError('lien non supporté')


# ---- Discord Rich Presence ("Écoute Onde" sur ton profil) ----
DISCORD_CLIENT_ID = '1554822795551309887'


class DiscordRPC:
    """Parle à l'application Discord ouverte sur le PC via son tuyau local (IPC). Aucun mot de passe."""

    def __init__(self, client_id):
        self.cid = client_id
        self.pipe = None
        self.pending = None      # dernière activité demandée (None = rien afficher)
        self.sent = '__rien__'
        self.connected = False
        self.error = ''
        self.wake = threading.Event()
        threading.Thread(target=self._loop, daemon=True).start()

    def update(self, activity):
        self.pending = activity
        self.wake.set()

    def _write(self, op, data):
        b = json.dumps(data).encode('utf-8')
        self.pipe.write(struct.pack('<II', op, len(b)) + b)
        self.pipe.flush()

    def _read(self):
        op, n = struct.unpack('<II', self.pipe.read(8))
        return op, json.loads(self.pipe.read(n))

    def _close(self):
        try:
            if self.pipe:
                self.pipe.close()
        except Exception:
            pass
        self.pipe, self.connected, self.sent = None, False, '__rien__'

    def _connect(self):
        for i in range(10):
            try:
                self.pipe = open(rf'\\.\pipe\discord-ipc-{i}', 'r+b', buffering=0)
            except OSError:
                continue
            try:
                self._write(0, {'v': 1, 'client_id': self.cid})
                _, resp = self._read()
                if resp.get('evt') == 'READY':
                    self.connected, self.error = True, ''
                    return True
                self.error = (resp.get('data') or {}).get('message', 'refusé par Discord')
            except Exception as e:
                self.error = str(e)
            self._close()
        if not self.error:
            self.error = "Discord n'est pas ouvert"
        return False

    def _loop(self):
        while True:
            self.wake.wait(20)
            self.wake.clear()
            act = self.pending
            key = json.dumps(act, sort_keys=True)
            try:
                if not self.pipe:
                    if act is None and self.sent == '__rien__':
                        continue
                    if not self._connect():
                        continue
                if key == self.sent:
                    continue
                self._write(1, {'cmd': 'SET_ACTIVITY', 'args': {'pid': os.getpid(), 'activity': act}, 'nonce': os.urandom(8).hex()})
                _, resp = self._read()
                if resp.get('evt') == 'ERROR':
                    self.error = (resp.get('data') or {}).get('message', 'erreur Discord')
                else:
                    self.error = ''
                self.sent = key
            except Exception:
                self._close()  # Discord fermé ou redémarré : on se reconnectera tout seul


RPC = DiscordRPC(DISCORD_CLIENT_ID)


JUNK = r'official|officiel|clip|lyrics?|paroles|audio|video|vidéo|visuali[sz]er|\bmv\b|m/v|\bhd\b|4k|hq|映像|ノンクレジット|full|ver\.?|version|remaster(ed)?'


def clean_title(s: str) -> str:
    s = re.sub(r'\s*\[[\w-]{11}\]$', '', s or '')                                   # [id YouTube]
    s = re.sub(r'\.(mp3|mp4|m4a|flac|wav|ogg|opus|webm)$', '', s, flags=re.I)
    s = re.sub(rf'[(\[【（][^)\]】）]*({JUNK})[^)\]】）]*[)\]】）]', ' ', s, flags=re.I)   # (Official Video)…
    s = re.sub(r'(?i)\b(official (music )?video|clip officiel|lyric video|audio officiel)\b', ' ', s)
    s = re.sub(r'(?i)\s+(ft\.?|feat\.?)\s.*$', '', s)
    s = s.replace('_', ' ')
    return re.sub(r'\s{2,}', ' ', s).strip(' -|·')


def _itunes(q, country):
    body, _ = fetch(f'https://itunes.apple.com/search?media=music&entity=song&limit=1&country={country}&term=' + urllib.parse.quote(q))
    res = json.loads(body).get('results') or []
    if res and res[0].get('artworkUrl100'):
        u = res[0]['artworkUrl100'].replace('100x100bb', '600x600bb')
        return {'url': u, 'fb': res[0]['artworkUrl100'], 'src': 'itunes'}


def _deezer(q):
    body, _ = fetch('https://api.deezer.com/search?limit=1&q=' + urllib.parse.quote(q))
    data = json.loads(body).get('data') or []
    if data:
        al = data[0].get('album') or {}
        if al.get('cover_xl'):
            return {'url': al['cover_xl'], 'fb': al.get('cover_medium') or al['cover_xl'], 'src': 'deezer'}


def _youtube_thumb(q):
    ids = youtube_search(q)
    if ids:
        return {'url': f'https://i.ytimg.com/vi/{ids[0]}/maxresdefault.jpg',
                'fb': f'https://i.ytimg.com/vi/{ids[0]}/mqdefault.jpg', 'src': 'youtube'}


def public_artwork(title: str, artist: str = '') -> dict:
    """Trouve une pochette pour n'importe quel son : iTunes → iTunes Japon → Deezer → miniature YouTube."""
    t = clean_title(title)
    a = (artist or '').split(',')[0].strip()
    if not t:
        return {}
    queries = [f'{a} {t}'.strip(), t] if a else [t]
    queries = list(dict.fromkeys(q for q in queries if q))
    cjk = re.search(r'[぀-ヿ一-鿿가-힯]', t + a)
    tries = []
    for q in queries:
        tries += [lambda q=q: _itunes(q, 'jp' if cjk else 'us')]
        tries += [lambda q=q: _itunes(q, 'fr' if not cjk else 'us')]
        tries += [lambda q=q: _deezer(q)]
    tries += [lambda: _youtube_thumb(f'{a} {t}'.strip())]   # filet de sécurité : trouve presque toujours
    for attempt in tries:
        try:
            r = attempt()
            if r:
                return r
        except Exception:
            continue
    return {}


# ---- comptes (GitHub pour poster, Discord pour le profil), Communauté, mises à jour ----
REPO = 'nayzen-bot/onde'
GH_CLIENT_ID = 'Iv23liKSo932IfuHLASb'          # GitHub App "Onde Music App" (public, pas un secret)
APP_VERSION = (PUB / 'version.txt').read_text().strip() if (PUB / 'version.txt').exists() else '0.0.0-dev'
ACCOUNT = DATA_DIR / '.compte.json'              # jetons gardés ici, jamais dans la bibliothèque
DEVICE = {}
FEED_CACHE = {'at': 0, 'data': None}


def account() -> dict:
    try:
        return json.loads(ACCOUNT.read_text('utf-8'))
    except Exception:
        return {}


def save_account(a: dict):
    ACCOUNT.write_text(json.dumps(a), 'utf-8')


def public_account() -> dict:
    a = account()
    gh, dc = a.get('github'), a.get('discord')
    return {'github': gh and {'login': gh['login'], 'avatar': gh.get('avatar')},
            'discord': dc and {k: dc.get(k) for k in ('id', 'name', 'username', 'avatar')}}


def http_json(url, method='GET', data=None, headers=None, form=False, timeout=15):
    h = {'User-Agent': 'Onde', 'Accept': 'application/json', **(headers or {})}
    body = None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            h['Content-Type'] = 'application/x-www-form-urlencoded'
        else:
            body = json.dumps(data).encode()
            h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in (b'{', b'[') else raw.decode('utf-8', 'ignore'))
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'message': raw.decode('utf-8', 'ignore')[:200]}


def gh_api(path, method='GET', data=None, token=None, raw=False):
    h = {'Accept': 'application/vnd.github.raw+json' if raw else 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    tok = token or (account().get('github') or {}).get('token')
    if tok:
        h['Authorization'] = f'Bearer {tok}'
    return http_json('https://api.github.com' + path, method, data, h)


def close_windows(title_part):
    for w in list(webview.windows)[1:]:
        try:
            if title_part in (w.title or ''):
                w.destroy()
        except Exception:
            pass


def gh_login_start():
    st, r = http_json('https://github.com/login/device/code', 'POST', {'client_id': GH_CLIENT_ID}, form=True)
    if st != 200 or 'device_code' not in r:
        raise RuntimeError(r.get('error_description') or r.get('message') or 'GitHub refuse la connexion')
    DEVICE['code'] = r['device_code']
    return {'user_code': r['user_code'], 'url': r['verification_uri'], 'interval': r.get('interval', 5)}


def gh_login_poll():
    if not DEVICE.get('code'):
        return {'error': 'aucune connexion en cours'}
    st, r = http_json('https://github.com/login/oauth/access_token', 'POST',
                      {'client_id': GH_CLIENT_ID, 'device_code': DEVICE['code'],
                       'grant_type': 'urn:ietf:params:oauth:grant-type:device_code'}, form=True)
    if 'access_token' in r:
        tok = r['access_token']
        st, me = gh_api('/user', token=tok)
        if st != 200:
            return {'error': 'profil GitHub illisible'}
        a = account()
        a['github'] = {'token': tok, 'login': me['login'], 'avatar': me.get('avatar_url')}
        save_account(a)
        DEVICE.clear()
        close_windows('GitHub')
        return {'done': True, **public_account()}
    err = r.get('error')
    if err in ('authorization_pending', 'slow_down'):
        return {'pending': True, 'slow': err == 'slow_down'}
    DEVICE.clear()
    return {'error': {'expired_token': 'code expiré, recommence', 'access_denied': 'connexion refusée'}.get(err, err or 'erreur')}


def discord_save_token(token):
    st, me = http_json('https://discord.com/api/v10/users/@me', headers={'Authorization': f'Bearer {token}'})
    if st != 200:
        raise RuntimeError('Discord a refusé la connexion')
    av = me.get('avatar')
    avatar = (f"https://cdn.discordapp.com/avatars/{me['id']}/{av}.png?size=128" if av
              else f"https://cdn.discordapp.com/embed/avatars/{(int(me['id']) >> 22) % 6}.png")
    a = account()
    a['discord'] = {'id': me['id'], 'username': me.get('username'), 'name': me.get('global_name') or me.get('username'), 'avatar': avatar}
    save_account(a)
    threading.Timer(1.2, lambda: close_windows('Discord')).start()


def community_feed(force=False):
    import time
    if not force and FEED_CACHE['data'] is not None and time.time() - FEED_CACHE['at'] < 45:
        return FEED_CACHE['data']
    st, r = gh_api(f'/repos/{REPO}/contents/community/posts.json', raw=True)
    if st == 200:
        data = r if isinstance(r, list) else json.loads(r)
    elif st == 404:
        data = []
    else:  # limite de l'API atteinte : on passe par la copie publique
        try:
            data = json.loads(fetch(f'https://raw.githubusercontent.com/{REPO}/main/community/posts.json')[0])
        except Exception:
            if FEED_CACHE['data'] is not None:
                return FEED_CACHE['data']
            raise RuntimeError('Communauté indisponible pour le moment')
    FEED_CACHE.update(at=time.time(), data=data)
    return data


def community_issue(kind, payload):
    if not (account().get('github') or {}).get('token'):
        raise PermissionError('connecte-toi à GitHub pour poster')
    dc = account().get('discord')
    if dc:
        payload['discord'] = {'name': dc.get('name'), 'avatar': dc.get('avatar')}
    title = f"[{'post' if kind == 'post' else 'suppression'}] {str(payload.get('title') or payload.get('id'))[:80]}"
    body = f'<!-- onde-{kind} -->\nEnvoyé depuis Onde {APP_VERSION}.\n\n```json\n{json.dumps(payload, ensure_ascii=False, indent=1)}\n```'
    st, r = gh_api(f'/repos/{REPO}/issues', 'POST', {'title': title, 'body': body})
    if st == 201:
        FEED_CACHE['at'] = 0
        return {'ok': True, 'number': r.get('number')}
    if st in (403, 404):
        raise RuntimeError("la Communauté n'accepte pas encore de posts (appli GitHub pas installée sur le dépôt)")
    raise RuntimeError(r.get('message') or f'erreur GitHub {st}')


def ver_tuple(v):
    return tuple(int(x) for x in re.findall(r'\d+', v.split('-')[0])[:3]) or (0,)


def check_update():
    st, r = gh_api(f'/repos/{REPO}/releases/latest')
    if st != 200:
        return {'current': APP_VERSION, 'available': False}
    latest = (r.get('tag_name') or '').lstrip('v')
    asset = next((a for a in r.get('assets', []) if a.get('name', '').lower().endswith('.exe')), None)
    newer = asset is not None and APP_VERSION != '0.0.0-dev' and ver_tuple(latest) > ver_tuple(APP_VERSION)
    return {'current': APP_VERSION, 'latest': latest, 'available': newer,
            'url': asset and asset['browser_download_url'], 'page': r.get('html_url'), 'notes': (r.get('body') or '')[:600]}


def install_update():
    info = check_update()
    if not info.get('available'):
        raise RuntimeError('pas de nouvelle version')
    import tempfile
    dest = Path(tempfile.gettempdir()) / 'Onde-Setup.exe'
    req = urllib.request.Request(info['url'], headers={'User-Agent': 'Onde'})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, 'wb') as f:
        shutil.copyfileobj(r, f)
    subprocess.Popen([str(dest)], creationflags=0)  # l'installeur ferme Onde et le met à jour
    threading.Timer(1.5, quit_app).start()
    return {'ok': True}


DISCORD_CALLBACK_PAGE = '''<!doctype html><meta charset="utf-8"><title>Connexion Discord</title>
<body style="background:#0b0b12;color:#fff;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div id="m">Connexion en cours…</div>
<script>
const p = new URLSearchParams(location.hash.slice(1));
const t = p.get('access_token');
if (!t) document.getElementById('m').textContent = 'Connexion annulée. Tu peux fermer cette fenêtre.';
else fetch('/api/discord-login', {method: 'POST', body: JSON.stringify({token: t})})
  .then(r => r.json()).then(j => { document.getElementById('m').textContent = j.ok ? 'Connecté à Discord ✓' : ('Erreur : ' + j.error); });
history.replaceState(null, '', '/auth/discord');
</script>'''


# ---- téléchargement YouTube en MP3 / MP4 (yt-dlp + ffmpeg intégré) ----
TOOLS = DATA_DIR / '.outils'
JOBS = {}
JOBS_LOCK = threading.Lock()
DL_SLOTS = threading.Semaphore(2)  # 2 téléchargements en même temps max


def ffmpeg_dir() -> str:
    """yt-dlp veut un exécutable nommé ffmpeg.exe : on copie celui fourni par imageio-ffmpeg."""
    import imageio_ffmpeg
    src = Path(imageio_ffmpeg.get_ffmpeg_exe())
    dst = TOOLS / 'ffmpeg.exe'
    if not dst.exists() or dst.stat().st_size != src.stat().st_size:
        TOOLS.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return str(TOOLS)


def find_download(vid: str, ext: str):
    end = f'[{vid}].{ext}'
    hits = [f for f in MUSIC.iterdir() if f.name.endswith(end)]
    return max(hits, key=lambda f: f.stat().st_mtime) if hits else None


def run_download(job: dict, url: str, fmt: str, name: str):
    import yt_dlp
    with DL_SLOTS:
        job['status'] = 'running'
        try:
            vid = re.search(r'(?:v=|youtu\.be/|shorts/)([\w-]{11})', url)
            vid = vid.group(1) if vid else None
            done = vid and find_download(vid, fmt)
            if not done:
                def hook(d):
                    if d.get('status') == 'downloading':
                        total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                        if total:  # en MP4 il y a 2 fichiers (image + son) : on compte la moitié chacun
                            part = d.get('downloaded_bytes', 0) / total
                            job['progress'] = min(0.95, part if fmt == 'mp3' else (job.get('_base', 0) + part / 2))
                    elif d.get('status') == 'finished' and fmt == 'mp4':
                        job['_base'] = min(0.5, job.get('_base', 0) + 0.5)

                stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name).strip(' .')[:120].replace('%', '%%') if name else '%(title).120B'
                opts = {
                    'outtmpl': str(MUSIC / f'{stem} [%(id)s].%(ext)s'),
                    'ffmpeg_location': ffmpeg_dir(),
                    'noplaylist': True, 'quiet': True, 'no_warnings': True, 'noprogress': True,
                    'windowsfilenames': True, 'progress_hooks': [hook],
                    'js_runtimes': {'deno': {}, 'node': {}},  # nécessaire à YouTube (node est déjà sur ton PC)
                }
                if fmt == 'mp3':
                    opts['format'] = 'bestaudio/best'
                    opts['postprocessors'] = [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}]
                else:
                    opts['format'] = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/b'
                    opts['merge_output_format'] = 'mp4'
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                vid = info.get('id') or vid
                done = find_download(vid, fmt)
                if not done:
                    raise RuntimeError('fichier introuvable après le téléchargement')
            job.update(status='done', progress=1, file=done.name, size=done.stat().st_size)
        except Exception as e:
            msg = re.sub(r'\x1b\[[0-9;]*m', '', str(e)).replace('ERROR: ', '')
            job.update(status='error', error=msg[:300])


def start_download(url: str, fmt: str, name: str) -> str:
    if fmt not in ('mp3', 'mp4'):
        raise ValueError('format inconnu')
    host = urllib.parse.urlparse(url).hostname or ''
    if not (host.endswith('youtube.com') or host.endswith('youtu.be')):
        raise ValueError('seuls les liens YouTube peuvent être téléchargés')
    jid = os.urandom(6).hex()
    job = {'id': jid, 'status': 'queued', 'progress': 0}
    with JOBS_LOCK:
        JOBS[jid] = job
    threading.Thread(target=run_download, args=(job, url, fmt, name), daemon=True).start()
    return jid


SAVE_LOCK = threading.Lock()
LAST_REV = [0]
try:
    LAST_REV[0] = json.loads(LIBRARY.read_bytes()).get('rev') or 0
except Exception:
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = 'Onde'

    def log_message(self, *a):
        pass

    def _send(self, code, body=b'', ctype='application/json'):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _body(self, limit=30_000_000) -> bytes:
        n = int(self.headers.get('Content-Length') or 0)
        if n > limit:
            raise ValueError('trop gros')
        return self.rfile.read(n)

    def _file(self, path: Path):
        if not path or not path.is_file():
            return self._send(404, {'error': 'introuvable'})
        size = path.stat().st_size
        ctype = MIME.get(path.suffix.lower(), 'application/octet-stream')
        rng = re.match(r'bytes=(\d*)-(\d*)', self.headers.get('Range', ''))
        start, end = 0, size - 1
        if rng:
            a, b = rng.group(1), rng.group(2)
            if a == '' and b:
                start = max(0, size - int(b))
            else:
                start = int(a or 0)
                if b:
                    end = min(int(b), size - 1)
            if start >= size or start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        length = end - start + 1
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        if self.command == 'HEAD':
            return
        with open(path, 'rb') as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(256 * 1024, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def _route(self):
        url = urllib.parse.urlparse(self.path)
        p = urllib.parse.unquote(url.path)
        q = urllib.parse.parse_qs(url.query)
        m = self.command

        if p == '/api/library' and m == 'GET':
            data = b'{}'
            for f in (LIBRARY, LIBRARY.with_suffix('.json.bak')):  # si le fichier est abîmé, on prend la copie
                try:
                    if f.exists():
                        json.loads(f.read_bytes())
                        data = f.read_bytes()
                        break
                except ValueError:
                    continue
            return self._send(200, data)
        if p == '/api/library' and m in ('PUT', 'POST'):
            body = self._body()
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get('items'), list):
                return self._send(400, {'error': 'bibliothèque invalide'})
            with SAVE_LOCK:  # une seule écriture à la fois
                rev = data.get('rev') or 0
                if rev and rev < LAST_REV[0]:
                    return self._send(200, {'ok': True, 'ignored': 'ancienne version'})  # n'écrase jamais du plus récent
                LAST_REV[0] = rev
                if LIBRARY.exists():  # copie de secours de la version précédente (si elle est saine)
                    try:
                        json.loads(LIBRARY.read_bytes())
                        shutil.copy2(LIBRARY, LIBRARY.with_suffix('.json.bak'))
                    except ValueError:
                        pass
                tmp = LIBRARY.with_name(f'bibliotheque.{os.getpid()}.{threading.get_ident()}.tmp')
                tmp.write_bytes(body)
                os.replace(tmp, LIBRARY)
            return self._send(200, {'ok': True})
        if p == '/api/focus' and m == 'POST':  # un 2e lancement d'Onde ramène cette fenêtre devant
            try:
                w = webview.windows[0]
                w.restore()
                w.show()
                w.on_top = True
                w.on_top = False
            except Exception:
                pass
            return self._send(200, {'ok': True})
        if p == '/api/files' and m == 'GET':
            files = [{'file': f.name, 'size': f.stat().st_size} for f in MUSIC.iterdir()
                     if f.is_file() and f.suffix.lower() in MEDIA_EXT]
            return self._send(200, files)
        if p == '/api/upload' and m == 'POST':
            name = unique_name(urllib.parse.unquote(self.headers.get('X-Filename', 'son')))
            if Path(name).suffix.lower() not in MEDIA_EXT:
                return self._send(400, {'error': 'format non supporté'})
            n = int(self.headers.get('Content-Length') or 0)
            dest = MUSIC / name
            try:
                with open(dest, 'wb') as f:
                    left = n
                    while left > 0:
                        chunk = self.rfile.read(min(1024 * 1024, left))
                        if not chunk:
                            raise ConnectionError('envoi interrompu')
                        f.write(chunk)
                        left -= len(chunk)
            except Exception:
                dest.unlink(missing_ok=True)
                raise
            return self._send(200, {'file': name, 'size': dest.stat().st_size})
        if p.startswith('/api/files/') and m == 'DELETE':
            f = safe_media(p[len('/api/files/'):])
            if f and f.exists():
                f.unlink()
            return self._send(200, {'ok': True})
        if p == '/api/meta':
            return self._send(200, link_meta(q.get('url', [''])[0], light='light' in q))
        if p == '/auth/discord':
            return self._send(200, DISCORD_CALLBACK_PAGE.encode(), 'text/html; charset=utf-8')
        if p == '/api/discord-login' and m == 'POST':
            try:
                discord_save_token(json.loads(self._body(10_000)).get('token', ''))
                return self._send(200, {'ok': True})
            except Exception as e:
                return self._send(200, {'ok': False, 'error': str(e)})
        if p == '/api/account' and m == 'GET':
            return self._send(200, {**public_account(), 'version': APP_VERSION, 'repo': REPO})
        if p == '/api/account/logout' and m == 'POST':
            which = json.loads(self._body(1000) or b'{}').get('which')
            a = account()
            a.pop(which, None)
            save_account(a)
            return self._send(200, public_account())
        if p == '/api/gh/start' and m == 'POST':
            return self._send(200, gh_login_start())
        if p == '/api/gh/poll' and m == 'POST':
            return self._send(200, gh_login_poll())
        if p == '/api/community' and m == 'GET':
            return self._send(200, community_feed('force' in q))
        if p == '/api/community' and m == 'POST':
            d = json.loads(self._body(500_000) or b'{}')
            try:
                return self._send(200, community_issue(d.get('kind', 'post'), d.get('payload') or {}))
            except Exception as e:
                return self._send(400, {'error': str(e)})
        if p == '/api/update' and m == 'GET':
            return self._send(200, check_update())
        if p == '/api/update' and m == 'POST':
            return self._send(200, install_update())
        if p == '/api/discord' and m == 'POST':
            d = json.loads(self._body(100_000) or b'{}')
            act = d.get('activity')
            RPC.update(act if isinstance(act, dict) else None)
            return self._send(200, {'connected': RPC.connected, 'error': RPC.error})
        if p == '/api/artwork':
            title = q.get('title', q.get('q', ['']))[0]
            return self._send(200, public_artwork(title, q.get('artist', [''])[0]))
        if p == '/api/discord' and m == 'GET':
            return self._send(200, {'connected': RPC.connected, 'error': RPC.error})
        if p == '/api/download' and m == 'POST':
            d = json.loads(self._body(100_000) or b'{}')
            return self._send(200, {'id': start_download(d.get('url', ''), d.get('format', 'mp3'), d.get('name', ''))})
        if p == '/api/download' and m == 'GET':
            job = JOBS.get(q.get('id', [''])[0])
            if not job:
                return self._send(404, {'error': 'téléchargement inconnu'})
            return self._send(200, {k: v for k, v in job.items() if not k.startswith('_')})
        if p == '/api/yt-search':
            return self._send(200, youtube_search(q.get('q', [''])[0]))
        if p == '/api/spotify-list':
            return self._send(200, spotify_list(q.get('kind', [''])[0], q.get('id', [''])[0]))
        if p == '/api/img':
            u = q.get('u', [''])[0]
            host = urllib.parse.urlparse(u).hostname or ''
            ok_host = host in IMG_HOSTS or host.endswith(('.spotifycdn.com', '.mzstatic.com', '.dzcdn.net'))
            if not u.startswith('https://') or not ok_host:
                return self._send(403, {'error': 'hôte refusé'})
            try:
                body, ctype = fetch(u)
            except Exception:
                return self._send(404, {'error': 'image introuvable'})
            self.send_response(200)
            self.send_header('Content-Type', ctype or 'image/jpeg')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'public, max-age=604800')
            self.end_headers()
            return self.wfile.write(body)
        if p.startswith('/media/'):
            return self._file(safe_media(p[len('/media/'):]))

        target = (PUB / ('index.html' if p == '/' else p.lstrip('/'))).resolve()
        if PUB.resolve() not in target.parents and target != PUB.resolve():
            return self._send(403, {'error': 'non'})
        return self._file(target)

    def _safe(self):
        try:
            self._route()
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:
            try:
                self._send(500, {'error': str(e)})
            except Exception:
                pass

    do_GET = do_PUT = do_POST = do_DELETE = do_HEAD = _safe


class Api:
    """Fonctions natives appelées depuis l'interface (window.pywebview.api)."""

    def _dialog(self, kind, **kw):
        FD = getattr(webview, 'FileDialog', None)
        const = getattr(FD, kind) if FD else getattr(webview, {'OPEN': 'OPEN_DIALOG', 'FOLDER': 'FOLDER_DIALOG'}[kind])
        return webview.windows[0].create_file_dialog(const, **kw) or []

    def _import(self, paths):
        out = []
        for src in paths:
            src = Path(src)
            if src.suffix.lower() not in MEDIA_EXT or not src.is_file():
                continue
            name = unique_name(src.name)
            shutil.copy2(src, MUSIC / name)
            out.append({'file': name, 'size': src.stat().st_size, 'original': src.name})
        return out

    def pick_files(self):
        exts = ';'.join('*' + e for e in sorted(MEDIA_EXT))
        paths = self._dialog('OPEN', allow_multiple=True, file_types=(f'Sons et vidéos ({exts})', 'Tous les fichiers (*.*)'))
        return self._import(paths)

    def pick_folder(self):
        folders = self._dialog('FOLDER')
        if not folders:
            return []
        files = sorted(p for p in Path(folders[0]).rglob('*') if p.suffix.lower() in MEDIA_EXT)
        return self._import(files)

    def reveal(self):
        subprocess.Popen(['explorer.exe', str(MUSIC)])

    def open_external(self, url):
        if url.startswith('https://'):
            webbrowser.open(url)

    def open_login(self, url, title='Connexion GitHub'):
        if url.startswith('https://github.com/'):
            webview.create_window(title, url, width=520, height=760, background_color='#0d1117')

    def discord_login(self):
        port = int(PORT_FILE.read_text()) if PORT_FILE.exists() else 0
        if port != 4747:
            return {'error': 'le port 4747 est pris par un autre programme, ferme-le puis relance Onde'}
        url = ('https://discord.com/oauth2/authorize?' + urllib.parse.urlencode({
            'client_id': DISCORD_CLIENT_ID, 'response_type': 'token', 'scope': 'identify',
            'redirect_uri': 'http://127.0.0.1:4747/auth/discord', 'prompt': 'consent'}))
        webview.create_window('Connexion Discord', url, width=520, height=800, background_color='#313338')
        return {'ok': True}

    def spotify_login(self):
        webview.create_window('Connexion à Spotify', 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F',
                              width=520, height=760, background_color='#000000')


def free_port(preferred=4747):
    for port in (preferred, 0):
        s = socket.socket()
        try:
            s.bind(('127.0.0.1', port))
            return s.getsockname()[1]
        except OSError:
            continue
        finally:
            s.close()


# ---- lecture en arrière-plan : fermer la fenêtre ne coupe pas la musique ----
QUITTING = False
TRAY = None


def setting(key, default=None):
    try:
        return json.loads(LIBRARY.read_bytes()).get('settings', {}).get(key, default)
    except Exception:
        return default


def js(code):
    try:
        webview.windows[0].evaluate_js(code)
    except Exception:
        pass


def show_window(*_):
    try:
        w = webview.windows[0]
        w.show()
        w.restore()
    except Exception:
        pass


def quit_app(*_):
    global QUITTING
    QUITTING = True
    js('flushSave && flushSave()')  # dernière sauvegarde
    try:
        if TRAY:
            TRAY.stop()
    except Exception:
        pass
    import time
    time.sleep(0.4)
    for w in list(webview.windows):
        try:
            w.destroy()
        except Exception:
            pass


def start_tray():
    global TRAY
    try:
        import pystray
        from PIL import Image
        img = Image.open(PUB / 'icon.png')
        menu = pystray.Menu(
            pystray.MenuItem('Ouvrir Onde', show_window, default=True),
            pystray.MenuItem('Lecture / Pause', lambda: js('toggle()')),
            pystray.MenuItem('Suivant', lambda: js('next()')),
            pystray.MenuItem('Précédent', lambda: js('prev()')),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Quitter Onde', quit_app),
        )
        TRAY = pystray.Icon('Onde', img, 'Onde', menu)
        TRAY.run_detached()
    except Exception:
        TRAY = None


_told_tray = [False]


def on_closing():
    """Fermer la fenêtre = la cacher (la musique continue), sauf si désactivé dans les Paramètres."""
    if QUITTING or TRAY is None or setting('closeToTray', True) is False:
        js('flushSave && flushSave()')
        return True
    threading.Thread(target=lambda: webview.windows[0].hide(), daemon=True).start()
    if not _told_tray[0]:
        _told_tray[0] = True
        try:
            TRAY.notify('La musique continue. Clic sur l\'icône Onde (à côté de l\'heure) pour rouvrir, clic droit › Quitter pour fermer.', 'Onde tourne en arrière-plan')
        except Exception:
            pass
    return False


PORT_FILE = DATA_DIR / '.port'


def single_instance():
    """Un seul Onde à la fois : sinon deux fenêtres écrasent la bibliothèque l'une de l'autre."""
    if os.name != 'nt':
        return None
    import ctypes
    k32 = ctypes.windll.kernel32
    handle = k32.CreateMutexW(None, False, 'Local\\OndeMusicPlayer')
    if k32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS : Onde est déjà ouvert
        try:
            port = int(PORT_FILE.read_text())
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/api/focus', data=b'', method='POST'), timeout=3)
        except Exception:
            pass
        sys.exit(0)
    return handle


def main():
    _lock = single_instance()  # garder la référence tant que l'app tourne
    port = free_port()
    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    PORT_FILE.write_text(str(port))

    # autorise la lecture auto dans les lecteurs YouTube / Spotify intégrés
    os.environ.setdefault('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '--autoplay-policy=no-user-gesture-required')
    win = webview.create_window(APP_NAME, f'http://127.0.0.1:{port}/', js_api=Api(), width=1440, height=900,
                                min_size=(980, 640), background_color='#07070b', text_select=False)
    win.events.closing += on_closing
    WEB_PROFILE.mkdir(parents=True, exist_ok=True)
    webview.start(start_tray, private_mode=False, storage_path=str(WEB_PROFILE))
    try:
        if TRAY:
            TRAY.stop()
    except Exception:
        pass
    os._exit(0)  # ferme aussi les téléchargements en cours proprement


if __name__ == '__main__':
    main()

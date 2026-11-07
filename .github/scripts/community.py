"""Vérifie un post (ou une suppression) envoyé depuis Onde et met à jour community/posts.json."""
import json
import os
import re
from datetime import datetime, timedelta, timezone

POSTS = 'community/posts.json'
BANNED = 'community/banned.json'
URL_RE = re.compile(r'^https://(www\.youtube\.com/watch\?v=[\w-]{11}|open\.spotify\.com/(track|episode)/[A-Za-z0-9]{10,40})$')
COVER_RE = re.compile(r'^https://(i\.ytimg\.com|i\.scdn\.co|[\w.-]+\.mzstatic\.com|[\w.-]+\.dzcdn\.net)/[^\s"\'<>]{1,300}$')
DISCORD_AV_RE = re.compile(r'^https://cdn\.discordapp\.com/(avatars|embed/avatars)/[\w/.?=-]{1,200}$')


def output(**kw):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
        for k, v in kw.items():
            f.write(f'{k}<<__FIN__\n{v}\n__FIN__\n')


def text(v, n):
    return re.sub(r'[\x00-\x1f​-‏‪-‮]', ' ', str(v or '')).strip()[:n]


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def main():
    ev = load(os.environ['GITHUB_EVENT_PATH'], {})
    issue, user = ev['issue'], ev['issue']['user']
    login, owner = user['login'], ev['repository']['owner']['login']
    body = issue.get('body') or ''
    posts = load(POSTS, [])
    banned = set(load(BANNED, []))

    if login in banned:
        return output(changed='false', message='Ce compte ne peut plus poster dans la Communauté.')
    m = re.search(r'```json\s*(\{.*\})\s*```', body, re.S)
    if not m:
        return output(changed='false', message='Post illisible (envoie-le depuis l\'app Onde).')
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return output(changed='false', message='Post illisible.')

    if '<!-- onde-delete -->' in body:
        pid = data.get('id')
        keep = [p for p in posts if not (p.get('id') == pid and (p.get('author') == login or login == owner))]
        if len(keep) == len(posts):
            return output(changed='false', message='Rien à supprimer (post introuvable ou pas à toi).')
        with open(POSTS, 'w', encoding='utf-8') as f:
            json.dump(keep, f, ensure_ascii=False, indent=1)
        return output(changed='true', message='Post supprimé ✓')

    # anti-spam : 5 posts par heure et par personne
    now = datetime.now(timezone.utc)
    recent = [p for p in posts if p.get('author') == login and
              now - datetime.fromisoformat(p['date'].replace('Z', '+00:00')) < timedelta(hours=1)]
    if len(recent) >= 5 and login != owner:
        return output(changed='false', message='Trop de posts d\'un coup : réessaie dans une heure.')

    tracks = []
    for t in (data.get('tracks') or [])[:100]:
        url = str(t.get('url') or '')
        if not URL_RE.match(url):
            continue
        cover = str(t.get('cover') or '')
        tracks.append({
            'url': url,
            'title': text(t.get('title'), 120) or 'Son',
            'artist': text(t.get('artist'), 120),
            'cover': cover if COVER_RE.match(cover) else '',
            'duration': max(0, min(int(t.get('duration') or 0), 36000)),
        })
    title = text(data.get('title'), 80)
    if not title or not tracks:
        return output(changed='false', message='Post refusé : il faut un titre et au moins un lien YouTube / Spotify.')

    post = {
        'id': issue['number'], 'author': login, 'avatar': user.get('avatar_url', ''),
        'date': issue['created_at'], 'title': title, 'text': text(data.get('text'), 300), 'tracks': tracks,
    }
    dc = data.get('discord') or {}
    if dc.get('name'):
        post['discord'] = {'name': text(dc['name'], 40),
                           'avatar': dc['avatar'] if DISCORD_AV_RE.match(str(dc.get('avatar') or '')) else ''}
    posts = [p for p in posts if p.get('id') != post['id']]
    posts.insert(0, post)
    with open(POSTS, 'w', encoding='utf-8') as f:
        json.dump(posts[:500], f, ensure_ascii=False, indent=1)
    output(changed='true', message=f'Publié dans la Communauté ✓ ({len(tracks)} son{"s" if len(tracks) > 1 else ""})')


main()

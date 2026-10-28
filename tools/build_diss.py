#!/usr/bin/env python3
"""Scarica dal DISS INGV (versione 3.3.1) geometrie e schede informative delle
sorgenti sismogeniche e le salva nella cartella diss/ della webapp, così l'app
le mostra senza interrogare ogni volta i server INGV.

Uscite:
  diss/diss.json          geometrie + parametri di tutte le sorgenti (compatto)
  diss/info/<ID>.json     scheda completa di ogni sorgente
  diss/pict/<P>.jpg       immagini delle schede, ridimensionate

Fonti: WFS https://services.seismofaults.eu/DISS331/wfs e i file dati del
DISS Mapper https://diss.ingv.it/mapper/data/ . Licenza dei dati: CC BY 4.0,
DISS Working Group, INGV.
"""
import concurrent.futures as cf
import csv
import io
import json
import os
import re
import sys
import time
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'diss')
WFS = ('https://services.seismofaults.eu/DISS331/wfs?service=WFS&version=2.0.0'
       '&request=GetFeature&outputFormat=application/json&typeNames=DISS331:')
MAP = 'https://diss.ingv.it/mapper/'
UA = {'User-Agent': 'ITalquake-diss-sync/1.0 (+https://github.com/oncloudmypage-01/ITalquake)'}
MAX_PICT_MB = 150   # oltre questa soglia le immagini restano collegate online


def get(url, binary=False, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                if r.status != 200:
                    raise IOError('HTTP %s' % r.status)
                data = r.read()
                return data if binary else data.decode('cp1252', errors='replace')
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                print('  ! errore', url, e, file=sys.stderr)
                return None
            time.sleep(2 * (k + 1))


def rnd(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 4), round(coords[1], 4)]
    return [rnd(c) for c in coords]


def outer(geom):
    """Anello esterno (o anelli, per i MultiPolygon) in [lat,lon] arrotondati."""
    t, c = geom['type'], geom['coordinates']
    if t == 'Polygon':
        rings = [c[0]]
    elif t == 'MultiPolygon':
        rings = [p[0] for p in c]
    elif t == 'LineString':
        rings = [c]
    elif t == 'MultiLineString':
        rings = c
    else:
        return []
    return [[[round(p[1], 4), round(p[0], 4)] for p in r] for r in rings]


def wfs(layer):
    txt = get(WFS + layer)
    if not txt:
        return []
    return json.loads(txt).get('features', [])


def mid_rows(name):
    txt = get(MAP + 'data/' + name)
    if not txt or txt.lstrip().startswith('<'):
        return {}
    rows = {}
    for r in csv.reader(io.StringIO(txt)):
        if r and r[0]:
            rows[r[0].strip()] = r
    return rows


def parse_com(txt):
    """Divide il testo del commento nelle sezioni **TITOLO**."""
    if not txt or txt.lstrip().startswith('<'):
        return {}
    out, cur, buf = {}, 'COMMENTS', []
    for line in txt.splitlines():
        m = re.match(r'^\s*\*\*(.+?)\*\*\s*$', line)
        if m:
            if ''.join(buf).strip():
                out[cur] = '\n'.join(p.strip() for p in '\n'.join(buf).split('\n') if p.strip())
            cur, buf = m.group(1).strip().upper(), []
        else:
            buf.append(line)
    if ''.join(buf).strip():
        out[cur] = '\n'.join(p.strip() for p in '\n'.join(buf).split('\n') if p.strip())
    return out


CSS_EVID = ['Profondità minima', 'Profondità massima', 'Direzione (strike)', 'Inclinazione (dip)',
            'Rake', 'Tasso di scorrimento', 'Magnitudo massima']
ISS_EVID = ['Lunghezza', 'Larghezza', 'Profondità minima', 'Profondità massima', 'Direzione (strike)',
            'Inclinazione (dip)', 'Rake', 'Spostamento medio', 'Tasso di scorrimento', 'Ultimo terremoto',
            'Tempo trascorso', 'Altre informazioni', 'Intervallo di ricorrenza', 'Magnitudo massima',
            'Localizzazione']


def main():
    os.makedirs(os.path.join(OUT, 'info'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'pict'), exist_ok=True)

    print('WFS…')
    layers = {k: wfs(v) for k, v in {'cs': 'csspln331', 'top': 'csstop331', 'is': 'iss331',
                                      'ds': 'dss331', 'sd': 'subdzon331'}.items()}
    for k, v in layers.items():
        print(' ', k, len(v))
    if not layers['cs']:
        sys.exit('WFS non disponibile: interrompo senza toccare i dati esistenti')

    tops = {}
    for f in layers['top']:
        tops.setdefault(f['properties']['idsource'], []).extend(outer(f['geometry']))

    skip = {'id', 'fid', 'linktoinfo', 'idsource', 'sourcename'}
    compact = {'version': 'DISS 3.3.1', 'source': 'DISS Working Group (2025), INGV — CC BY 4.0',
               'generated': time.strftime('%Y-%m-%d'), 'cs': [], 'is': [], 'ds': [], 'sd': []}
    ids = []
    for k in ('cs', 'is', 'ds', 'sd'):
        for f in layers[k]:
            p = f['properties']
            sid = p['idsource']
            item = {'id': sid, 'n': p.get('sourcename', ''),
                    'p': {a: b for a, b in p.items() if a not in skip and b not in (None, '')},
                    'g': outer(f['geometry'])}
            if k == 'cs' and sid in tops:
                item['t'] = tops[sid]
            compact[k].append(item)
            ids.append((k, sid))
    with open(os.path.join(OUT, 'diss.json'), 'w', encoding='utf-8') as fh:
        json.dump(compact, fh, ensure_ascii=False, separators=(',', ':'))
    print('diss.json', os.path.getsize(os.path.join(OUT, 'diss.json')) // 1024, 'KB')

    print('Tabelle del Mapper…')
    css_mid = mid_rows('CSSTOP4web.MID')
    iss_mid = mid_rows('ISS4web.MID')
    comp = {}
    txt = get(MAP + 'data/ContComp4web.txt') or ''
    for r in csv.reader(io.StringIO(txt)):
        if len(r) >= 4:
            comp[r[0]] = {'compilers': r[1], 'contributors': r[2], 'affiliations': r[3]}
    refs = {}
    txt = get(MAP + 'data/AssignReferences4web.txt') or ''
    for r in csv.reader(io.StringIO(txt)):
        if len(r) >= 5:
            refs.setdefault(r[0], []).append({'a': r[1], 'y': r[2], 't': r[3], 'j': r[4]})
    titles = {}
    txt = get(MAP + 'data/MainTable.txt') or ''
    for line in txt.splitlines():
        c = line.split('\t')
        if len(c) >= 2:
            titles[c[0]] = {'t': c[1].strip(), 'c': c[2].strip() if len(c) > 3 else ''}
    links = {}
    txt = get(MAP + 'data/LinkTable.txt') or ''
    for line in txt.splitlines():
        c = line.split('\t')
        if len(c) >= 2:
            links.setdefault(c[1].strip(), []).append(c[0].strip())
    related = {}
    txt = get(MAP + 'data/Assign_ISS.txt') or ''
    for r in csv.reader(io.StringIO(txt)):
        if len(r) >= 3 and r[0] != 'IDISS':
            iss, cs, sd = r[0], r[1], r[2]
            parent = cs or sd
            if parent:
                related.setdefault(iss, []).append(parent)
                related.setdefault(parent, []).append(iss)

    print('Commenti per sorgente…')

    def com(sid):
        return sid, parse_com(get(MAP + 'data/com/%sCOM.txt' % sid))
    with cf.ThreadPoolExecutor(8) as ex:
        coms = dict(ex.map(com, [s for _, s in ids]))

    pict_ids = set()
    for k, sid in ids:
        evid = []
        if k == 'cs' and sid in css_mid:
            texts = css_mid[sid][23:30]
            evid = [[CSS_EVID[i], t] for i, t in enumerate(texts) if t.strip()]
        elif k == 'is' and sid in iss_mid:
            texts = iss_mid[sid][45:60]
            evid = [[ISS_EVID[i], t] for i, t in enumerate(texts) if i < len(ISS_EVID) and t.strip()]
        pics = [{'id': pid, **titles.get(pid, {'t': '', 'c': ''})} for pid in links.get(sid, [])]
        pict_ids.update(p['id'] for p in pics)
        info = {'id': sid, 'type': k, 'sections': coms.get(sid, {}), 'evidence': evid,
                'authors': comp.get(sid, {}), 'related': sorted(set(related.get(sid, []))),
                'pictures': pics, 'references': refs.get(sid, []),
                'link': 'https://diss.ingv.it/mapper?source=' + sid}
        with open(os.path.join(OUT, 'info', sid + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(info, fh, ensure_ascii=False, separators=(',', ':'))
    print('schede', len(ids), 'immagini', len(pict_ids))

    print('Immagini…')
    try:
        from PIL import Image
    except ImportError:
        Image = None

    def pict(pid):
        dest = os.path.join(OUT, 'pict', pid + '.jpg')
        if os.path.exists(dest):
            return pid, os.path.getsize(dest)
        raw = get(MAP + 'data/pict/%s.jpg' % pid, binary=True)
        if not raw:
            return pid, 0
        try:
            if Image:
                im = Image.open(io.BytesIO(raw)).convert('RGB')
                im.thumbnail((1100, 1100))
                im.save(dest, 'JPEG', quality=72, optimize=True, progressive=True)
            else:
                open(dest, 'wb').write(raw)
        except Exception as e:  # noqa: BLE001
            print('  ! immagine', pid, e, file=sys.stderr)
            return pid, 0
        return pid, os.path.getsize(dest)
    with cf.ThreadPoolExecutor(8) as ex:
        sizes = dict(ex.map(pict, sorted(pict_ids)))
    tot = sum(sizes.values()) / 1e6
    print('immagini salvate', sum(1 for v in sizes.values() if v), 'totale %.1f MB' % tot)
    if tot > MAX_PICT_MB:
        print('troppo pesanti: le rimuovo e uso i collegamenti online')
        for pid in sizes:
            p = os.path.join(OUT, 'pict', pid + '.jpg')
            if os.path.exists(p):
                os.remove(p)
    with open(os.path.join(OUT, 'meta.json'), 'w', encoding='utf-8') as fh:
        json.dump({'version': 'DISS 3.3.1', 'generated': time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()),
                   'sources': len(ids), 'pictures_local': tot <= MAX_PICT_MB,
                   'pict_online_base': MAP + 'data/pict/'}, fh, ensure_ascii=False)


if __name__ == '__main__':
    main()

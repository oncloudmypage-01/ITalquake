import re, sys, urllib.request, ssl, html
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
URLS = sys.argv[1:]
UA = {'User-Agent':'Mozilla/5.0 (ITalquake probe)'}
for u in URLS:
    print('='*20, u)
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25, context=ctx)
        b = r.read(); t = b.decode('utf-8','replace')
        print('STATUS', r.status, r.headers.get('Content-Type'), len(b), 'ACAO', r.headers.get('Access-Control-Allow-Origin'), 'XFO', r.headers.get('X-Frame-Options'), 'LM', r.headers.get('Last-Modified'))
        if 'image' in (r.headers.get('Content-Type') or ''): continue
        ti = re.search(r'<title[^>]*>(.*?)</title>', t, re.S|re.I)
        print('TITLE', ti and ti.group(1).strip()[:150])
        for m in re.findall(r'<(?:img|iframe|embed|source)[^>]+(?:src|data-src)=["\']([^"\']+)', t, re.I)[:80]:
            print('SRC', m)
        for m in re.findall(r'href=["\']([^"\']+)', t, re.I):
            if re.search(r'(?i)sism|drum|heli|stazion|segnal|png|gif|jpg', m): print('HREF', m)
        txt = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', t, flags=re.S|re.I)
        txt = html.unescape(re.sub(r'<[^>]+>', ' ', txt)); txt = re.sub(r'\s+', ' ', txt)
        for kw in ['©','copyright','Copyright','licenz','Licenz','Creative','CC BY','riprodu','Riprodu','consentit','autorizz','vietat','Vietat','uso ','utilizz','fonte','Fonte','divulgativ','aggiorn','Aggiorn','gestit','Gestit','stazion','Stazion']:
            for m in re.finditer(re.escape(kw), txt):
                print('KW', kw, '::', txt[max(0,m.start()-160):m.start()+200]); break
        print('TEXT', txt[:2500])
    except Exception as e:
        print('ERR', repr(e))

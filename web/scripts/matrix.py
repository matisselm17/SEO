"""
Capture de tous les écrans et états, aux trois largeurs et dans les deux thèmes,
puis planches de contrôle (une par écran) dans web/.captures/planches/.
Usage : python3 scripts/matrix.py [filtre]
"""
import os, sys
from playwright.sync_api import sync_playwright
from PIL import Image

BASE = "http://localhost:5173"
OUT = os.path.join(os.path.dirname(__file__), "..", ".captures")
SHEETS = os.path.join(OUT, "planches")
os.makedirs(SHEETS, exist_ok=True)

# nom, chemin, scénario, actions
SCREENS = [
    ("01-accueil", "/", "vide", []),
    ("02-accueil-erreur", "/", "vide", ["type:#root input=mon site", "click:button[type=submit]"]),
    ("03-accueil-injoignable", "/", "vide", ["type:#root input=site-injoignable.fr", "click:button[type=submit]", "wait:1800"]),
    ("04-ajout-puis-analyse", "/", "vide", ["type:#root input=www.ma-boutique.fr", "click:button[type=submit]", "wait:4500"]),
    ("05-vue-ensemble", "/sites/site_8fk2", "complet", []),
    ("06-vue-ensemble-analyse", "/sites/site_8fk2", "analyse-figee", ["wait:1500"]),
    ("07-vue-ensemble-sans-gsc", "/sites/site_8fk2", "sans-gsc", []),
    ("08-chargement", "/sites/site_8fk2", "lent", []),
    ("09-erreur", "/sites/site_8fk2", "erreurs", ["wait:1500"]),
    ("10-audit", "/sites/site_8fk2/audit", "complet", []),
    ("11-audit-detail", "/sites/site_8fk2/audit/meta_description", "complet", ["wait:800"]),
    ("12-pages", "/sites/site_orlx/pages", "complet", ["wait:600"]),
    ("13-page-detail", "/sites/site_8fk2/pages/pg_2", "complet", ["wait:800"]),
    ("14-trafic", "/sites/site_8fk2/trafic", "complet", []),
    ("15-trafic-vide", "/sites/site_8fk2/trafic", "sans-gsc", []),
    ("16-concurrents", "/sites/site_8fk2/concurrents", "complet", []),
    ("17-concurrents-non-configure", "/sites/site_8fk2/concurrents", "sans-config", []),
    ("18-concurrents-pas-releve", "/sites/site_orlx/concurrents", "complet", []),
    ("19-recommandations", "/sites/site_8fk2/recommandations", "complet", []),
    ("20-assistant", "/sites/site_8fk2/assistant", "complet", ["click:.chip", "wait:5000"]),
    ("21-assistant-vide", "/sites/site_8fk2/assistant", "sans-gsc", []),
    ("22-assistant-non-configure", "/sites/site_8fk2/assistant", "sans-config", []),
    ("23-parametres", "/sites/site_8fk2/parametres", "complet", []),
    ("24-parametres-non-configure", "/sites/site_8fk2/parametres", "sans-config", []),
    ("25-menu", "/sites/site_8fk2", "complet", ["menu"]),
    ("26-selecteur-site", "/sites/site_8fk2", "complet", ["switcher"]),
]
WIDTHS = [1440, 834, 390]
THEMES = ["light", "dark"]
MAXH = 2600

flt = sys.argv[1] if len(sys.argv) > 1 else ""
errors = []
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for name, path, demo, acts in SCREENS:
        if flt and flt not in name:
            continue
        shots = {}
        for theme in THEMES:
            for w in WIDTHS:
                h = 900 if w > 800 else (1112 if w > 500 else 844)
                ctx = b.new_context(viewport={"width": w, "height": h})
                ctx.add_init_script(f"localStorage.setItem('theme','{theme}'); sessionStorage.setItem('demo-scenario','{demo}');")
                page = ctx.new_page()
                page.on("console", lambda m, n=name, w=w, t=theme: m.type in ("error", "warning") and errors.append(f"{n} [{w}/{t}] {m.type}: {m.text}"))
                page.on("pageerror", lambda e, n=name, w=w, t=theme: errors.append(f"{n} [{w}/{t}] pageerror: {e}"))
                page.goto(f"{BASE}{path}?demo={demo}", wait_until="load")
                page.wait_for_timeout(900 if demo != "lent" else 700)
                for a in acts:
                    if a.startswith("wait:"):
                        page.wait_for_timeout(int(a[5:]))
                    elif a.startswith("type:"):
                        sel, txt = a[5:].split("=", 1); page.fill(sel, txt)
                    elif a.startswith("click:"):
                        loc = page.locator(a[6:]).first
                        if loc.count() and loc.is_visible(): loc.click(); page.wait_for_timeout(400)
                    elif a == "menu":
                        btn = page.locator(".topbar .icon-btn, .sidebar__rail-toggle .icon-btn").locator("visible=true").first
                        if w < 1100 and btn.is_visible(): btn.click(); page.wait_for_timeout(450)
                    elif a == "switcher":
                        if w < 1100:
                            page.locator(".topbar .icon-btn, .sidebar__rail-toggle .icon-btn").locator("visible=true").first.click(); page.wait_for_timeout(400)
                            page.locator(".drawer .switcher__button").click()
                        else:
                            page.locator(".sidebar .switcher__button").click()
                        page.wait_for_timeout(300)
                page.wait_for_timeout(250)
                f = os.path.join(OUT, f"{name}-{w}-{theme}.png")
                full = page.evaluate("document.documentElement.scrollHeight") <= MAXH
                if full:
                    page.screenshot(path=f, full_page=True)
                else:
                    page.screenshot(path=f, clip={"x": 0, "y": 0, "width": w, "height": MAXH}, full_page=True)
                shots[(w, theme)] = f
                ctx.close()
        # Planche : ligne 1 = 1440 clair/sombre ; ligne 2 = 834 et 390 clair/sombre
        ims = {k: Image.open(v) for k, v in shots.items()}
        scale = 0.5
        row1 = [ims[(1440, "light")], ims[(1440, "dark")]]
        row2 = [ims[(834, "light")], ims[(834, "dark")], ims[(390, "light")], ims[(390, "dark")]]
        def rs(im): return im.resize((int(im.width * scale), int(im.height * scale)))
        row1 = [rs(i) for i in row1]; row2 = [rs(i) for i in row2]
        W = max(sum(i.width for i in row1) + 20, sum(i.width for i in row2) + 40)
        H = max(i.height for i in row1) + max(i.height for i in row2) + 30
        sheet = Image.new("RGB", (W, H), (128, 128, 128))
        x = 0
        for i in row1: sheet.paste(i, (x, 0)); x += i.width + 20
        y = max(i.height for i in row1) + 30; x = 0
        for i in row2: sheet.paste(i, (x, y)); x += i.width + 13
        sheet.save(os.path.join(SHEETS, f"{name}.png"))
        print("ok", name)
    b.close()
print("\n".join(errors) if errors else "Aucune erreur de console.")

"""
Captures d'écran de l'interface en mode démonstration (développement).
Usage : python3 scripts/capture.py <nom> <chemin> [--demo scenario] [--widths 1440,834,390] [--themes light,dark]
        [--wait ms] [--click selector] [--full] [--out dossier] [--type selector=texte]
Écrit dans web/.captures/<nom>-<largeur>-<thème>.png et affiche les erreurs de console.
"""
import argparse, os, sys
from playwright.sync_api import sync_playwright

p = argparse.ArgumentParser()
p.add_argument("name"); p.add_argument("path")
p.add_argument("--demo", default="complet")
p.add_argument("--widths", default="1440,834,390")
p.add_argument("--themes", default="light,dark")
p.add_argument("--wait", type=int, default=900)
p.add_argument("--click", action="append", default=[])
p.add_argument("--type", action="append", default=[])
p.add_argument("--full", action="store_true")
p.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", ".captures"))
p.add_argument("--base", default="http://localhost:5173")
p.add_argument("--reduced", action="store_true")
a = p.parse_args()
os.makedirs(a.out, exist_ok=True)
errors = []
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for theme in a.themes.split(","):
        for w in [int(x) for x in a.widths.split(",")]:
            h = 900 if w > 800 else (1112 if w > 500 else 844)
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, reduced_motion="reduce" if a.reduced else "no-preference")
            ctx.add_init_script(f"localStorage.setItem('theme','{theme}'); sessionStorage.setItem('demo-scenario','{a.demo}');")
            page = ctx.new_page()
            page.on("console", lambda m, w=w, t=theme: m.type in ("error", "warning") and errors.append(f"[{w}/{t}] {m.type}: {m.text}"))
            page.on("pageerror", lambda e, w=w, t=theme: errors.append(f"[{w}/{t}] pageerror: {e}"))
            sep = "&" if "?" in a.path else "?"
            page.goto(f"{a.base}{a.path}{sep}demo={a.demo}", wait_until="networkidle" if a.demo != "analyse" else "load")
            page.wait_for_timeout(a.wait)
            for spec in a.type:
                sel, txt = spec.split("=", 1)
                page.fill(sel, txt)
            for sel in a.click:
                if sel.startswith("wait:"):
                    page.wait_for_timeout(int(sel[5:])); continue
                if sel.startswith("press:"):
                    page.keyboard.press(sel[6:]); continue
                if sel.startswith("type:"):
                    k, txt = sel[5:].split("=", 1)
                    page.fill(k, txt); continue
                if sel.startswith("scroll:"):
                    page.mouse.wheel(0, int(sel[7:])); page.wait_for_timeout(300); continue
                if sel.startswith("hover:"):
                    page.locator(sel[6:]).first.hover(); continue
                loc = page.locator(sel).first
                if loc.is_visible():
                    loc.click()
                page.wait_for_timeout(500)
            page.wait_for_timeout(300)
            f = os.path.join(a.out, f"{a.name}-{w}-{theme}.png")
            page.screenshot(path=f, full_page=a.full)
            print(f)
            ctx.close()
    b.close()
for e in errors:
    print("CONSOLE", e)

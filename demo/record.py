"""Record the demo scenes from the running app with Playwright.

Usage: python3 demo/record.py [scene ...]   (default: all scenes)
Writes demo/out/<scene>.webm and demo/out/<scene>.json (markers in seconds from the start of the recording).
Needs the backend on :8787 and the frontend on :5173.
"""
import json
import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5173/"
OUT = Path(__file__).parent / "out"
SAMPLES = Path(__file__).parent.parent / "data" / "samples"
VIEW = {"width": 1920, "height": 1080}
VIDEO = {"width": 1920, "height": 1080}

# Headless recordings have no mouse pointer; draw one. Inside an open modal dialog the pointer has to live in the
# dialog, because dialogs sit in the browser's top layer above any z-index.
ZOOM_CSS = """
html { zoom: 1.2; }
dialog.modal { max-height: calc(100vh / 1.2 - 40px); }
dialog.drawer { height: calc(100vh / 1.2); max-height: calc(100vh / 1.2); }
"""

CURSOR_JS = """
(() => {
  const make = () => {
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', margin: '-11px 0 0 -11px',
      borderRadius: '50%', border: '2px solid #fff', background: 'rgba(255,255,255,.15)', boxShadow: '0 2px 10px rgba(0,0,0,.6)',
      pointerEvents: 'none', zIndex: '2147483647', transform: 'translate(-100px,-100px)' });
    return c;
  };
  let c = null;
  const place = (x, y) => {
    if (!c) c = make();
    const host = document.querySelector('dialog[open]') || document.body;
    if (c.parentNode !== host) host.appendChild(c);
    // The page is zoomed; the pointer element lives inside it, so undo the zoom on its position.
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    c.style.transform = `translate(${x / z}px,${y / z}px)`;
  };
  document.addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
  document.addEventListener('mousedown', () => c && (c.style.background = 'rgba(110,121,222,.7)'), true);
  document.addEventListener('mouseup', () => c && (c.style.background = 'rgba(255,255,255,.15)'), true);
})();
"""


class Scene:
    def __init__(self, page):
        self.page = page
        self.t0 = time.time()
        self.markers = {}
        self.x, self.y = 800, 450

    def mark(self, name):
        self.markers[name] = round(time.time() - self.t0, 2)

    def pause(self, s):
        self.page.wait_for_timeout(int(s * 1000))

    def move(self, x, y, steps=30):
        self.page.mouse.move(x, y, steps=steps)
        self.x, self.y = x, y

    def move_to(self, locator, steps=30, dx=0.5, dy=0.5):
        locator.scroll_into_view_if_needed()
        box = locator.bounding_box()
        self.move(box["x"] + box["width"] * dx, box["y"] + box["height"] * dy, steps)

    def click(self, locator, steps=30, dx=0.5, dy=0.5):
        self.move_to(locator, steps, dx, dy)
        self.pause(0.25)
        self.page.mouse.down()
        self.page.mouse.up()

    def scroll_to(self, selector, offset=-80, wait=1.2):
        self.page.evaluate(
            "([s, o]) => { const el = document.querySelector(s); window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + o, behavior: 'smooth' }); }",
            [selector, offset],
        )
        self.pause(wait)


def overview(s: Scene):
    p = s.page
    p.wait_for_selector(".takeaways li")
    s.mark("loaded")
    s.move(820, 300, 1)
    s.pause(2.5)
    s.scroll_to("#overview", -70, 1.6)
    s.mark("chart")
    s.move_to(p.locator(".overview-time .peak-label"), 40)
    s.pause(2.5)
    s.scroll_to(".insights", -70, 1.6)
    s.mark("takeaways")
    for li in p.locator(".takeaways li").all()[:3]:
        s.move_to(li, 25, 0.3)
        s.pause(1.6)
    s.mark("end")


def investigate(s: Scene):
    p = s.page
    p.wait_for_selector(".chip")
    s.move(820, 300, 1)
    s.pause(1.0)
    s.mark("ask")
    s.click(p.locator(".chip").nth(0), 35)
    p.wait_for_selector("#role-panel .view h2")
    s.mark("answer")
    s.pause(1.2)
    s.scroll_to("#results", -70, 1.4)
    s.move_to(p.locator("#role-panel .view h2"), 30, 0.2)
    s.pause(3.0)
    findings = p.locator(".finding")
    for i in range(min(3, findings.count())):
        s.move_to(findings.nth(i), 25, 0.35)
        s.pause(2.0)
    s.mark("unknowns")
    s.move_to(p.locator(".unknowns"), 30)
    s.pause(2.5)
    s.mark("evidence")
    chip = p.locator(".finding .fact-chip").nth(1)
    s.click(chip, 30)
    p.wait_for_selector("dialog.drawer[open] .log-table")
    s.pause(1.5)
    s.move_to(p.locator("dialog.drawer[open] .log-table"), 30, 0.5, 0.3)
    s.pause(2.5)
    s.move_to(p.locator("dialog.drawer[open] pre.sql"), 30, 0.3, 0.3)
    s.pause(2.5)
    p.keyboard.press("Escape")
    s.pause(0.8)
    s.mark("teamlead")
    s.scroll_to("#results", -70, 1.0)
    s.click(p.get_by_role("tab", name="Team lead"), 30)
    s.pause(1.0)
    s.move_to(p.locator("#evidence .panel-head"), 40)
    s.pause(2.0)
    s.move_to(p.locator("#role-panel .finding").first, 30, 0.35)
    s.pause(2.5)
    inferred = p.locator("#role-panel .status.inferred")
    if inferred.count():
        s.mark("inferred")
        s.move_to(inferred.first, 30)
        s.pause(3.0)
    s.mark("manager")
    s.click(p.get_by_role("tab", name="Manager"), 30)
    s.pause(1.5)
    s.move_to(p.locator("#role-panel .view h2"), 30, 0.2)
    s.pause(2.0)
    table = p.locator("#role-panel .table-wrap")
    if table.count():
        s.move_to(table.first, 35, 0.3, 0.4)
        s.pause(2.5)
        s.move_to(p.locator("#role-panel .formula"), 30, 0.2)
        s.pause(2.5)
    s.mark("end")


def unknown(s: Scene):
    p = s.page
    p.wait_for_selector(".chip")
    s.move(820, 300, 1)
    s.pause(0.8)
    s.mark("ask")
    s.click(p.locator(".chip").nth(3), 35)
    p.wait_for_selector("#role-panel .view h2")
    s.click(p.get_by_role("tab", name="Manager"), 25)
    s.pause(1.0)
    s.mark("answer")
    s.move_to(p.locator("#role-panel .view h2"), 30, 0.2)
    s.pause(2.5)
    s.move_to(p.locator("#role-panel .unknowns"), 30)
    s.pause(3.0)
    s.mark("end")


def insights(s: Scene):
    p = s.page
    p.wait_for_selector(".takeaways li")
    s.scroll_to("#overview", -70, 1.2)
    s.mark("start")
    x = p.evaluate("() => fetch('/api/datasets/bgl/overview').then(r => r.json()).then(d => d.charts[0].x)")
    i0, i1 = x.index("2005-11-15"), x.index("2005-11-21")
    box = p.locator(".overview-time svg[role=img]").bounding_box()
    sx = lambda i: box["x"] + box["width"] * (48 + (1200 - 56) / len(x) * (i + 0.5)) / 1200
    yy = box["y"] + box["height"] * 0.62
    s.move(sx(i0), yy, 40)
    s.pause(0.6)
    s.mark("drag")
    p.mouse.down()
    p.mouse.move(sx(i1), yy, steps=40)
    p.mouse.up()
    p.wait_for_selector(".changed .mover")
    s.pause(1.0)
    s.scroll_to(".insights", -70, 1.5)
    s.mark("kpis")
    s.move_to(p.locator(".kpi").nth(1), 30)
    s.pause(2.5)
    s.mark("takeaways")
    for i in (3, 4):
        s.move_to(p.locator(".takeaways li").nth(i), 25, 0.3)
        s.pause(2.2)
    s.scroll_to(".changed", -90, 1.4)
    s.mark("changed")
    s.move_to(p.locator(".mover").first, 30, 0.3)
    s.pause(1.5)
    new = p.locator(".mover", has=p.locator(".pill:not(.quiet)"))
    target = new.first if new.count() else p.locator(".mover").first
    s.click(target, 30)
    p.wait_for_selector("#drill .log-table")
    s.mark("drill")
    s.pause(1.5)
    s.move_to(p.locator("#drill .panel-head"), 30, 0.3)
    s.pause(2.5)
    s.mark("end")


def upload(s: Scene):
    p = s.page
    p.wait_for_selector(".chip")
    s.move(820, 300, 1)
    s.pause(0.8)
    s.mark("open")
    s.click(p.get_by_role("button", name="Upload your own logs"), 35)
    p.wait_for_selector("dialog.modal[open]")
    s.pause(1.0)
    p.set_input_files("dialog.modal input[type=file]", str(SAMPLES / "OpenSSH_2k.log"))
    s.move_to(p.locator("dialog.modal .dropzone"), 30)
    s.pause(1.5)
    s.move_to(p.locator("dialog.modal .privacy"), 25, 0.3)
    s.pause(2.0)
    s.mark("detect")
    s.click(p.get_by_role("button", name="Recognise format"), 30)
    p.wait_for_selector("dialog.modal .log-table", timeout=90000)
    s.mark("detected")
    s.pause(1.0)
    s.move_to(p.locator("dialog.modal dl.kv"), 30, 0.4, 0.4)
    s.pause(3.0)
    s.move_to(p.locator("dialog.modal .log-table"), 30, 0.5, 0.35)
    s.pause(3.0)
    s.mark("load")
    s.click(p.locator("dialog.modal .btn-primary"), 30)
    p.wait_for_selector("dialog.modal", state="hidden", timeout=120000)
    p.wait_for_function("document.querySelector('#overview-title')?.innerText.includes('OpenSSH')", timeout=30000)
    p.wait_for_selector(".takeaways li")
    s.mark("loaded")
    s.pause(2.0)
    s.move_to(p.locator(".overview-time"), 30, 0.5, 0.4)
    s.pause(2.0)
    s.scroll_to(".insights", -70, 1.4)
    s.move_to(p.locator(".takeaways li").nth(1), 30, 0.3)
    s.pause(3.0)
    s.scroll_to(".overview-patterns", -90, 1.4)
    s.mark("patterns")
    s.click(p.locator(".pattern-link").first, 30)
    p.wait_for_selector("#drill .log-table")
    s.pause(2.5)
    s.scroll_to(".ask", -70, 1.4)
    s.mark("ask")
    s.click(p.locator(".chip").first, 35)
    p.wait_for_selector("#role-panel .view h2", timeout=150000)
    s.mark("first_view")
    s.pause(1.5)
    p.wait_for_function("!document.querySelector('.btn-primary[type=submit]').disabled", timeout=150000)
    s.mark("all_views")
    s.move_to(p.locator("#role-panel .view h2"), 30, 0.2)
    s.pause(2.5)
    s.move_to(p.locator("#role-panel .finding").first, 30, 0.35)
    s.pause(2.5)
    s.scroll_to("#trace", -70, 1.6)
    s.mark("trace")
    s.move_to(p.locator(".pipeline .calls"), 40, 0.5, 0.3)
    s.pause(3.5)
    s.mark("end")


SCENES = {"overview": overview, "investigate": investigate, "unknown": unknown, "insights": insights, "upload": upload}


def record(name):
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / f"_{name}"
    shutil.rmtree(tmp, ignore_errors=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport=VIEW, record_video_dir=str(tmp), record_video_size=VIDEO)
        ctx.add_init_script(CURSOR_JS)
        page = ctx.new_page()
        s = Scene(page)
        page.goto(URL)
        # Lay out like a 1600 px window but render at full 1080p, so text is large and sharp in the video.
        # Zoom also scales 100vh, so the full-height dialogs would overflow the frame; size them for the zoom.
        page.add_style_tag(content=ZOOM_CSS)
        SCENES[name](s)
        video = page.video.path()
        ctx.close()
        browser.close()
    Path(video).rename(OUT / f"{name}.webm")
    shutil.rmtree(tmp, ignore_errors=True)
    (OUT / f"{name}.json").write_text(json.dumps(s.markers, indent=1))
    print(name, s.markers)


if __name__ == "__main__":
    for n in sys.argv[1:] or list(SCENES):
        record(n)

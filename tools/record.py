"""Screen-record the three demo scenes for real (no faking): Xvfb + Chromium (kiosk) + ffmpeg x11grab.
usage: python3 tools/record.py   (server must be running on :8787; writes video/scene_*.mp4 + screenshots)"""
import asyncio, os, subprocess, time, signal
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "video")
DISPLAY = ":99"
SCENES = [
    ("scene_a_make_reel", "Alexa, make a one-minute reel of Saturday's trip, upbeat and warm.", 4),
    ("scene_b_shorter_title", "Make it shorter and put the title at the start.", 4),
    ("scene_c_play_on_tv", "Play it on the TV.", 14),
]

def grab(path):
    return subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30", "-video_size", "1920x1080",
                             "-i", DISPLAY + ".0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", path],
                            stdin=subprocess.PIPE)

def stop(p):
    p.stdin.write(b"q"); p.stdin.flush(); p.wait(timeout=60)

async def main():
    os.makedirs(OUT, exist_ok=True)
    xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"])
    time.sleep(1.5)
    os.environ["DISPLAY"] = DISPLAY
    try:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context("/tmp/kimo-alexa-chrome", executable_path="/usr/bin/chromium", headless=False,
                                        no_viewport=True, ignore_default_args=["--enable-automation"],
                                        args=["--no-sandbox", "--kiosk", "--window-size=1920,1080", "--window-position=0,0",
                                              "--autoplay-policy=no-user-gesture-required", "--disable-infobars", "--noerrdialogs", "--hide-scrollbars"])
            b = ctx
            pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await pg.goto("http://127.0.0.1:8787/")
            await pg.wait_for_function("window.__ready", timeout=30000)
            await asyncio.sleep(1.5)
            for i, (name, utter, tail) in enumerate(SCENES):
                rec = grab(os.path.join(OUT, name + ".mp4"))
                await asyncio.sleep(3)  # breathing room
                t0 = time.time()
                reply = await pg.evaluate(f"window.say({utter!r})")
                print(name, "->", reply, f"({time.time() - t0:.0f}s)", flush=True)
                if name.startswith("scene_c"):
                    await asyncio.sleep(4); await pg.screenshot(path=os.path.join(OUT, "screenshot_3_tv_playing.png"))
                await asyncio.sleep(tail)
                if name.startswith("scene_a"): await pg.screenshot(path=os.path.join(OUT, "screenshot_1_reel_ready.png"))
                if name.startswith("scene_b"): await pg.screenshot(path=os.path.join(OUT, "screenshot_2_same_project_edit.png"))
                stop(rec)
            await b.close()
    finally:
        xvfb.send_signal(signal.SIGTERM)

asyncio.run(main())

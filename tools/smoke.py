import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox","--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width":1920,"height":1080})
        pg.on("console", lambda m: print("console:", m.text))
        await pg.goto("http://127.0.0.1:8787/"); await pg.wait_for_function("window.__ready", timeout=20000)
        for i,u in enumerate(sys.argv[1:]):
            r = await pg.evaluate(f"window.say({u!r})"); print("REPLY:", r, flush=True)
            await asyncio.sleep(3); await pg.screenshot(path=f"/tmp/kt/smoke{i}.png")
        await b.close()
asyncio.run(main())

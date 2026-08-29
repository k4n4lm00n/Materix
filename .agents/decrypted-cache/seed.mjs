// Phase 1: seed fixture — register a fresh user on the local Synapse, create
// an ENCRYPTED room, send messages, and wait for the write-side decrypted
// cache to fill. Persistent profile so later runs are true cold starts.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire("/home/user/.npm/_npx/9833c18b2d85bc59/node_modules/");
const { chromium } = require("playwright-core");

const EXE =
  "/home/user/.cache/ms-playwright/chromium_headless_shell-1237/chrome-headless-shell-linux64/chrome-headless-shell";
const URL = "http://localhost:5299";
const OUT = "/home/user/worktrees/materix-issue4/.agents/decrypted-cache";
const PROFILE = process.env.PROFILE ?? "/tmp/materix-cache-profile";
const USER = process.env.MXUSER ?? "cachetest1";
const N = 24;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EXE,
  headless: true,
  viewport: { width: 1100, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("dialog", (d) => d.accept());
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console]", m.text().slice(0, 200));
});
await page.goto(URL, { waitUntil: "networkidle" });

// Onboarding: server -> register.
await page.waitForSelector("#server", { timeout: 20000 });
await page.fill("#server", "http://localhost:8008");
await page.click("button.btn.primary");
await page.waitForSelector(".auth-mode-switch", { timeout: 30000 });
await page.click('.auth-mode-tab:has-text("Create account")');
await page.fill("#reg-username", USER);
await page.fill("#reg-password", "cachetest-pass-123");
await page.fill("#reg-confirm", "cachetest-pass-123");
await page.click("form button.btn.primary");
await page.waitForSelector(".rooms-pane", { timeout: 60000 });
console.log("registered + logged in");

// Create an encrypted group room.
await page.click('[aria-label="New chat"]');
await page.click('[role="tab"]:has-text("Group"), button:has-text("Group")');
await page.fill("#group-name", "Cache Test E2EE");
const enc = await page.getAttribute('[aria-checked][role="switch"], [aria-checked]', "aria-checked");
console.log("encrypted toggle:", enc);
await page.click('button:has-text("Create group")');
await page.waitForSelector(".composer textarea", { timeout: 30000 });
console.log("room open");

// Send N messages.
for (let i = 1; i <= N; i++) {
  const msg = `cachemsg-${String(i).padStart(3, "0")}`;
  await page.fill(".composer textarea", msg);
  await page.press(".composer textarea", "Enter");
  await page.waitForTimeout(120);
}
// Wait until all echoes rendered.
await page.waitForFunction(
  (n) => document.querySelectorAll("[data-event-id]").length >= n,
  N,
  { timeout: 60000 },
);
await page.waitForTimeout(3000);

// Inspect: room encryption + decrypted-cache rows.
const state = await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  const cacheDb = dbs.map((d) => d.name).find((n) => n && n.startsWith("materix-decrypted-"));
  let rows = [];
  if (cacheDb) {
    rows = await new Promise((resolve) => {
      const req = indexedDB.open(cacheDb);
      req.onsuccess = () => {
        const db = req.result;
        const all = db.transaction("events").objectStore("events").getAll();
        all.onsuccess = () => {
          resolve(all.result.map((r) => ({ eventId: r.eventId, roomId: r.roomId, type: r.type, body: r.content?.body })));
          db.close();
        };
        all.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    });
  }
  const domIds = [...document.querySelectorAll("[data-event-id]")].map((el) => ({
    eventId: el.getAttribute("data-event-id"),
    text: el.querySelector(".bubble")?.textContent?.slice(0, 60) ?? "",
  }));
  return { allDbs: dbs.map((d) => d.name), cacheDb, rowCount: rows.length, rows, domIds };
});
console.log("dbs:", state.allDbs);
console.log("cacheDb:", state.cacheDb, "rows:", state.rowCount);
console.log("sample rows:", JSON.stringify(state.rows.slice(0, 3)));
writeFileSync(`${OUT}/seed-state.json`, JSON.stringify(state, null, 2));
await page.screenshot({ path: `${OUT}/seed.png` });
await ctx.close();
console.log("SEED DONE");

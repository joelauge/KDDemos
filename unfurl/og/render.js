// Renders the unfurl images from card.html. Run: NODE_PATH=$(npm root -g) node render.js
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const jobs = [['search', 1200, 630, 'og-search.png'], ['result', 1200, 630, 'og-result.png'], ['icon', 180, 180, 'og-icon.png']];
  for (const [v, w, h, out] of jobs) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto('file://' + path.join(__dirname, 'card.html') + '?v=' + v);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(__dirname, '..', out) });
    await p.close();
  }
  await b.close();
})();

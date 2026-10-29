/* Run with a locally installed Playwright. App runtime remains dependency-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(__dirname, '..');
const output = path.join(root, 'artifacts');
const url = pathToFileURL(path.join(root, 'index.html')).href;
const results = [], errors = [], warnings = [], external = [];
let browser;
async function check(name, run) {
  const start = Date.now();
  await run();
  results.push({ name, passed: true, ms: Date.now() - start });
  console.log('PASS ' + name);
}
async function until(page, fn) { await page.waitForFunction(fn, null, {timeout: 6000}); }
async function enterPair(page, a, b) {
  await page.locator('#inA').fill(a);
  await page.locator('#lockA').click();
  await page.locator('#inB').fill(b);
  await page.locator('#lockB').click();
  await page.locator('#go').click();
  await until(page, () => document.querySelector('#countdown').hidden);
}
async function screenshot(page, name) {
  await page.waitForTimeout(850);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}

(async () => {
  fs.mkdirSync(output, {recursive: true});
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: {width: 1440, height: 1050}, acceptDownloads: true });
  const page = await context.newPage();
  // Install before navigation so the app's interval belongs to this clock.
  // Installing after navigation leaves existing native timers uncontrolled.
  await page.clock.install({time:new Date()});
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); else if (message.type() === 'warning') warnings.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
  await check('Standalone file opens without remote dependencies', async () => {
    await page.goto(url);
    assert.match(await page.title(), /同词相遇/);
    assert.equal(await page.locator('#inA').getAttribute('type'), 'password');
    assert.equal(await page.locator('#go').isDisabled(), true);
    await screenshot(page, 'after-desktop');
  });
  await check('Responsive layouts at 320, 390, 768, 1024 and 1440px', async () => {
    for (const width of [320,390,768,1024,1440]) {
      await page.setViewportSize({width, height: width < 500 ? 844 : 1050});
      await page.waitForTimeout(900);
      const dimensions = await page.evaluate(() => {
        const arena = document.querySelector('#arena').getBoundingClientRect();
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('.mind-card')].map(node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; }), arena: {left:arena.left,right:arena.right,top:arena.top,bottom:arena.bottom} };
      });
      assert.ok(dimensions.scrollWidth <= width, 'horizontal overflow at ' + width);
      for (const card of dimensions.cards) {
        assert.ok(card.left >= dimensions.arena.left - 1 && card.right <= dimensions.arena.right + 1, 'word card clipped at ' + width + ': ' + JSON.stringify(dimensions));
      }
      if (width === 390) await screenshot(page, 'after-mobile');
      if (width === 768) await screenshot(page, 'after-tablet');
    }
  });
  await check('Rules and empty records use keyboard-accessible native dialogs', async () => {
    await page.locator('#rulesBtn').click();
    assert.equal(await page.locator('#modal').evaluate(node => node.open), true);
    assert.match(await page.locator('#modalBody').innerText(), /30 秒/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modal').evaluate(node => node.open), false);
    assert.equal(await page.locator('#rulesBtn').evaluate(node => node === document.activeElement), true);
    await page.locator('#recordsBtn').click();
    assert.match(await page.locator('#modalBody').innerText(), /第一次相遇/);
    await page.locator('#closeModal').click();
  });
  await check('Inspiration shuffle, stable daily inspiration and sound controls work', async () => {
    const before = await page.locator('.inspiration-words').innerText();
    await page.locator('#shuffleBtn').click();
    assert.notEqual(await page.locator('.inspiration-words').innerText(), before);
    await page.locator('#dailyBtn').click();
    const daily = await page.locator('.inspiration-words').innerText();
    await page.locator('#shuffleBtn').click();
    await page.locator('#dailyBtn').click();
    assert.equal(await page.locator('.inspiration-words').innerText(), daily);
    await page.locator('#soundBtn').click();
    assert.equal(await page.locator('#soundBtn').getAttribute('aria-pressed'), 'true');
    await page.locator('#soundBtn').click();
  });
  await check('Invalid input and IME Enter cannot accidentally lock a word', async () => {
    await page.locator('#inA').fill('。。。');
    await page.locator('#lockA').click();
    assert.match(await page.locator('#hint').innerText(), /不能只有标点/);
    assert.equal(await page.locator('#inA').isDisabled(), false);
    await page.locator('#inA').fill('森林');
    await page.locator('#inA').dispatchEvent('keydown', {key:'Enter',isComposing:true});
    assert.equal(await page.locator('#inA').isDisabled(), false);
  });
  await check('Private lock/unlock works and refresh never saves unrevealed words', async () => {
    await page.locator('#inA').press('Enter');
    assert.equal(await page.locator('#inA').isDisabled(), true);
    assert.equal(await page.locator('#go').isDisabled(), true);
    await page.locator('#lockA').click();
    assert.equal(await page.locator('#inA').isDisabled(), false);
    await page.locator('#inA').fill('未揭晓秘密');
    await page.locator('#lockA').click();
    const saved = await page.evaluate(() => localStorage.getItem('tcxy.session.v2'));
    assert.ok(!saved.includes('未揭晓秘密'));
    await page.reload();
    assert.equal(await page.locator('#inA').inputValue(), '');
    assert.equal(await page.locator('#inA').isDisabled(), false);
  });
  await check('A full mismatched round reveals together and persists its trajectory', async () => {
    await enterPair(page,'森林','海洋');
    assert.equal(await page.locator('#wordA').innerText(),'森林');
    assert.equal(await page.locator('#wordB').innerText(),'海洋');
    assert.match(await page.locator('#goLabel').innerText(),/下一轮/);
    await page.locator('#historyToggle').click();
    assert.equal(await page.locator('.history-row').count(),1);
    await screenshot(page,'round-revealed');
    await page.reload();
    assert.equal(await page.locator('#wordA').innerText(),'森林');
    await page.locator('#go').click();
    assert.equal(await page.locator('#roundNum').innerText(),'02');
    assert.equal(await page.locator('#inA').inputValue(),'');
  });
  await check('Exact normalized match finishes once with grade, record and achievement', async () => {
    await enterPair(page,'自 然。','自然');
    assert.equal(await page.locator('#resultControls').isVisible(),true);
    assert.equal(await page.locator('#resultGrade').innerText(),'S');
    assert.match(await page.locator('#resultHeadline').innerText(),/2 轮/);
    assert.equal(await page.locator('#statTotal').innerText(),'1');
    assert.equal(await page.locator('#statBest').innerText(),'2');
    assert.match(await page.locator('#badgeFast').getAttribute('class'),/unlocked/);
    await screenshot(page,'match-result');
    await page.setViewportSize({width:390,height:844});
    await screenshot(page,'match-mobile');
    await page.setViewportSize({width:1440,height:1050});
  });
  await check('Result exports a real PNG and copy has a usable fallback', async () => {
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#downloadBtn').click();
    const download=await downloadPromise;
    const filename=path.join(output,'exported-meeting-card.png');
    await download.saveAs(filename);
    const png=fs.readFileSync(filename);
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),1080);
    assert.equal(png.readUInt32BE(20),1350);
    await page.locator('#copyBtn').click();
    await page.waitForTimeout(200);
    if(await page.locator('#modal').evaluate(node=>node.open)) {
      assert.match(await page.locator('.share-fallback').inputValue(),/2 轮/);
      await page.locator('#closeModal').click();
    } else assert.match(await page.locator('#toast').innerText(),/已复制/);
  });
  await check('Records replay real history and survive a browser refresh', async () => {
    await page.locator('#recordsBtn').click();
    assert.equal(await page.locator('.record-entry').count(),1);
    await page.locator('.record-entry summary').click();
    assert.equal(await page.locator('.record-entry .history-row').count(),2);
    await screenshot(page,'records-dialog');
    await page.keyboard.press('Escape');
    await page.reload();
    assert.equal(await page.locator('#statTotal').innerText(),'1');
    assert.equal(await page.locator('#statBest').innerText(),'2');
  });
  await check('Mode change asks before discarding an active round', async () => {
    await page.locator('#inA').fill('需要保留');
    await page.locator('[data-mode="timed"]').click();
    assert.equal(await page.locator('#modal').evaluate(node=>node.open),true);
    await page.getByRole('button',{name:'继续当前局',exact:true}).click();
    assert.equal(await page.locator('#inA').inputValue(),'需要保留');
    await page.locator('[data-mode="timed"]').click();
    await page.getByRole('button',{name:'开始新一局',exact:true}).click();
    await until(page,()=>document.querySelector('[data-mode="timed"]').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#statBest').innerText(),'—');
  });
  await check('Timed mode uses a real deadline, including while a dialog is open', async () => {
    await page.locator('#inA').fill('秘密词');
    await page.locator('#lockA').click();
    await page.locator('#rulesBtn').click();
    await page.clock.fastForward(30100);
    await page.locator('#closeModal').click();
    assert.match(await page.locator('#hint').innerText(),/时间/);
    assert.equal(await page.locator('#inA').inputValue(),'');
    assert.equal(await page.locator('#wordA').innerText(),'山川');
    assert.equal(await page.locator('#statTotal').innerText(),'1');
    await page.locator('#go').click();
    assert.equal(await page.locator('#roundNum').innerText(),'02');
    assert.match(await page.locator('#timerText').innerText(),/输入后开始/);
    await screenshot(page,'timed-challenge');
    await page.clock.resume();
  });
  await check('Themes, longer words and reduced motion remain playable', async () => {
    await page.locator('#themeSelect').selectOption('space');
    await page.getByRole('button',{name:'开始新一局',exact:true}).click();
    await until(page,()=>document.querySelector('#themeSelect').value==='space');
    await page.emulateMedia({reducedMotion:'reduce'});
    await enterPair(page,'星际旅行的终点站','银河系漫游的起点');
    assert.equal(await page.locator('#wordA').innerText(),'星际旅行的终点站');
    await page.setViewportSize({width:320,height:844});
    await screenshot(page,'long-words-mobile');
    assert.equal(await page.locator('.mind-card').first().evaluate(node=>getComputedStyle(node).animationName),'none');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  });
  await check('No runtime console errors, warnings, or external requests', async () => {
    assert.deepEqual(errors,[]);
    assert.deepEqual(warnings,[]);
    assert.deepEqual(external,[]);
  });
  await context.close();
  await check('Blocked browser storage still permits a complete game', async () => {
    const isolated=await browser.newContext({reducedMotion:'reduce'});
    await isolated.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError');}});});
    const p=await isolated.newPage();p.on('pageerror',error=>errors.push(error.message));
    await p.goto(url);
    await enterPair(p,'月亮','月亮');
    assert.equal(await p.locator('#resultGrade').innerText(),'SSS');
    assert.equal(await p.locator('#statTotal').innerText(),'1');
    assert.deepEqual(errors,[]);
    await isolated.close();
  });
  await check('Legacy best survives; corrupt sessions and records cannot break the page', async () => {
    const isolated=await browser.newContext({reducedMotion:'reduce'});
    await isolated.addInitScript(()=>{
      localStorage.setItem('tcxy.best','3');
      localStorage.setItem('tcxy.session.v2','{"round":-1,"history":[]}');
      localStorage.setItem('tcxy.records.v2',JSON.stringify([{id:'bad',word:'伪记录',rounds:1,mode:'classic',theme:'toString',date:Date.now(),history:[{round:1,a:'甲',b:'乙'}]}]));
    });
    const p=await isolated.newPage();p.on('pageerror',error=>errors.push(error.message));
    await p.goto(url);
    assert.equal(await p.locator('#statBest').innerText(),'3');
    assert.equal(await p.locator('#statTotal').innerText(),'0');
    assert.equal(await p.locator('#roundNum').innerText(),'01');
    await p.locator('#recordsBtn').click();
    assert.match(await p.locator('#modalBody').innerText(),/旧版/);
    await p.locator('#closeModal').click();
    assert.deepEqual(errors,[]);
    await isolated.close();
  });
  await check('Player words render as text and every visible control has an accessible name', async () => {
    const isolated=await browser.newContext({reducedMotion:'reduce'});
    const p=await isolated.newPage();p.on('pageerror',error=>errors.push(error.message));
    await p.goto(url);
    await enterPair(p,'<b>月</b>','<b>月</b>');
    assert.equal(await p.locator('#meetWord').innerText(),'<b>月</b>');
    assert.equal(await p.locator('#meetWord b').count(),0);
    const unnamed=await p.evaluate(()=>[...document.querySelectorAll('button,input,select')].filter(node=>node.getClientRects().length&&!node.disabled).filter(node=>!node.getAttribute('aria-label')&&!node.getAttribute('aria-labelledby')&&!node.textContent.trim()&&!(node.labels&&node.labels.length)).map(node=>node.id));
    assert.deepEqual(unnamed,[]);
    fs.writeFileSync(path.join(output,'accessibility-tree.txt'),await p.locator('body').ariaSnapshot());
    assert.deepEqual(errors,[]);
    await isolated.close();
  });
  await check('Timed wins retain an independent best score and the selected mode after reload', async () => {
    const isolated=await browser.newContext({reducedMotion:'reduce'});
    await isolated.addInitScript(()=>{if(localStorage.getItem('tcxy.best')===null)localStorage.setItem('tcxy.best','7');});
    const p=await isolated.newPage();p.on('pageerror',error=>errors.push(error.message));
    await p.goto(url);
    await p.locator('[data-mode="timed"]').click();
    await enterPair(p,'银河','银河');
    assert.equal(await p.locator('#statBest').innerText(),'1');
    const scores=await p.evaluate(()=>({classic:localStorage.getItem('tcxy.best'),timed:localStorage.getItem('tcxy.best.timed')}));
    assert.deepEqual(scores,{classic:'7',timed:'1'});
    await p.reload();
    assert.equal(await p.locator('[data-mode="timed"]').getAttribute('aria-pressed'),'true');
    assert.equal(await p.locator('#statBest').innerText(),'1');
    await p.locator('[data-mode="classic"]').click();
    assert.equal(await p.locator('#statBest').innerText(),'7');
    assert.deepEqual(errors,[]);
    await isolated.close();
  });
  const report={passed:true,browser:'Microsoft Edge / Playwright',entry:'file:// index.html',checks:results,errors,warnings,externalRequests:external};
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:results.length,errors:errors.length,warnings:warnings.length}));
})().catch(error=>{console.error(error);fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify({passed:false,checks:results,error:error.message,errors,warnings},null,2));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});

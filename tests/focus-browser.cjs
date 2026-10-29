const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.join(__dirname,'..','artifacts');
const url=pathToFileURL(path.join(__dirname,'..','index.html')).href;
const results=[],errors=[];let browser;
async function check(name,run){await run();results.push(name);console.log('PASS '+name);}
(async()=>{
  fs.mkdirSync(output,{recursive:true});browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await check('Landing explains three steps and does not expose playable inputs',async()=>{
    await page.goto(url);assert.equal(await page.locator('#landingView').isVisible(),true);assert.equal(await page.locator('#inA').isVisible(),false);
    assert.equal(await page.locator('#startLocalBtn').isVisible(),true);assert.equal(await page.locator('.quick-guide li').count(),3);
    assert.equal(await page.locator('#backToLobby').isVisible(),false);await page.screenshot({path:path.join(output,'landing-desktop.png'),fullPage:true});
  });
  await check('Start creates an uncluttered game view with a current-step guide',async()=>{
    await page.locator('[data-mode="timed"]').click();await page.locator('#themeSelect').selectOption('space');await page.locator('#startLocalBtn').click();
    assert.equal(await page.locator('#landingView').isVisible(),false);assert.equal(await page.locator('.sidebar').isVisible(),false);assert.equal(await page.locator('.page-footer').isVisible(),false);
    assert.equal(await page.locator('#inA').isVisible(),true);assert.equal(await page.locator('#backToLobby').isVisible(),true);
    assert.match(await page.locator('#focusSession').innerText(),/限时心跳/);assert.equal(await page.locator('#playProgress [aria-current="step"]').getAttribute('data-step'),'0');
    await page.screenshot({path:path.join(output,'focused-game-desktop.png'),fullPage:true});
  });
  await check('Game steps follow locking and refreshing keeps focus without saving private words',async()=>{
    await page.locator('#inA').fill('私密星光');await page.locator('#lockA').click();assert.equal(await page.locator('#playProgress [aria-current="step"]').getAttribute('data-step'),'1');
    await page.reload();assert.equal(await page.locator('#inA').isVisible(),true);assert.equal(await page.locator('#inA').inputValue(),'');assert.equal(await page.locator('#landingView').isVisible(),false);
  });
  await check('Returning asks before ending an unfinished game and cancel keeps the draft',async()=>{
    await page.locator('#inA').fill('保留这个词');await page.locator('#backToLobby').click();await page.getByRole('button',{name:'继续当前局',exact:true}).click();
    assert.equal(await page.locator('#inA').inputValue(),'保留这个词');await page.locator('#backToLobby').click();await page.getByRole('button',{name:'结束并返回',exact:true}).click();
    await page.waitForFunction(()=>document.body.dataset.view==='home');assert.equal(await page.locator('#landingView').isVisible(),true);assert.equal(await page.locator('#inA').isVisible(),false);
  });
  await check('Landing and focused play fit 320, 390, 768 and 1440 pixels',async()=>{
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:width<500?844:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'landing overflow '+width);
      if(width===390)await page.screenshot({path:path.join(output,'landing-mobile.png'),fullPage:true});
      await page.locator('#startLocalBtn').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'game overflow '+width);
      const bounds=await page.evaluate(()=>({arena:document.querySelector('#arena').getBoundingClientRect().toJSON(),cards:[...document.querySelectorAll('.mind-card')].map(card=>card.getBoundingClientRect().toJSON())}));
      for(const card of bounds.cards)assert.ok(card.left>=bounds.arena.left-1&&card.right<=bounds.arena.right+1,'card overflow '+width);
      if(width===390)await page.screenshot({path:path.join(output,'focused-game-mobile.png'),fullPage:true});
      await page.locator('#backToLobby').click();await page.waitForFunction(()=>document.body.dataset.view==='home');
    }
  });
  await check('A complete match stays in focused results and rematch is immediately playable',async()=>{
    await page.locator('[data-mode="classic"]').click();await page.locator('#startLocalBtn').click();
    await page.locator('#inA').fill('星空');await page.locator('#lockA').click();await page.locator('#inB').fill('星空');await page.locator('#lockB').click();
    assert.equal(await page.locator('#playProgress [aria-current="step"]').getAttribute('data-step'),'2');await page.locator('#go').click();await page.locator('#resultControls').waitFor();
    assert.equal(await page.locator('#landingView').isVisible(),false);assert.equal(await page.locator('#resultGrade').innerText(),'SSS');
    await page.locator('#againBtn').click();assert.equal(await page.locator('#inA').isVisible(),true);assert.equal(await page.locator('#roundNum').innerText(),'01');assert.deepEqual(errors,[]);
  });
  fs.writeFileSync(path.join(output,'focused-view-report.json'),JSON.stringify({results,errors},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});

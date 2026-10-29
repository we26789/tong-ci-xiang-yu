const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createApp}=require('../server.cjs');
const file=pathToFileURL(path.join(__dirname,'..','index.html')).href;
const output=path.join(__dirname,'..','artifacts');
const results=[],errors=[];let browser,app;
async function check(name,run){await run();results.push(name);console.log('PASS '+name);}
async function compose(page,selector,text){await page.locator(selector).focus();const cdp=await page.context().newCDPSession(page);await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});return cdp;}
async function commit(cdp,text){await cdp.send('Input.insertText',{text});await cdp.detach();}
(async()=>{
  fs.mkdirSync(output,{recursive:true});browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(file);await page.locator('#startLocalBtn').click();
  await check('Word fields permit IME text entry while masking unrevealed words',async()=>{
    for(const selector of ['#inA','#inB']){
      assert.equal(await page.locator(selector).getAttribute('type'),'text','Password fields disable the Windows IME');
      const style=await page.locator(selector).evaluate(n=>({mask:getComputedStyle(n).webkitTextSecurity,color:getComputedStyle(n).color}));
      assert.ok(style.mask==='disc'||style.color==='rgba(0, 0, 0, 0)','The visible draft must stay masked');
    }
  });
  await check('Long Pinyin composition survives another local player locking and commits Chinese',async()=>{
    const draft='zhongguorenmingongheguo',cdp=await compose(page,'#inA',draft);
    assert.equal(await page.locator('#inA').inputValue(),draft,'Preedit Pinyin must not be capped at ten letters');
    await page.locator('#inA').dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});
    assert.equal(await page.locator('#inA').isDisabled(),false);
    // A peer update invokes the same render path as input and locking, without ending this composition.
    await page.locator('#inB').evaluate(n=>{n.value='中国';n.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'中国'}));});
    await page.locator('#lockB').dispatchEvent('click');
    assert.equal(await page.locator('#inA').inputValue(),draft);
    await commit(cdp,'中国');assert.equal(await page.locator('#inA').inputValue(),'中国');
    assert.equal(await page.locator('#inA').isDisabled(),false,'Accepting a candidate must not lock it');
    await page.screenshot({path:path.join(output,'ime-masked-draft.png'),fullPage:true});
    await page.locator('#lockA').click();await page.locator('#go').click();await page.locator('#resultControls').waitFor();
    assert.equal(await page.locator('#meetWord').innerText(),'中国');await page.screenshot({path:path.join(output,'ime-chinese-result.png'),fullPage:true});
  });
  await check('Committed input is limited by characters after composition, including emoji',async()=>{
    await page.locator('#againBtn').click();await page.locator('#inA').fill('一二三四五六七八九十多');
    assert.equal(await page.locator('#inA').inputValue(),'一二三四五六七八九十');
    await page.locator('#inA').fill('🌙'.repeat(10));assert.equal(await page.locator('#countA').innerText(),'10 / 10');
  });
  await check('Fallback masking still accepts Chinese when native text masking is unavailable',async()=>{
    const fallback=await browser.newContext();await fallback.addInitScript(()=>{const supports=CSS.supports.bind(CSS);CSS.supports=(...args)=>String(args[0]).includes('text-security')?false:supports(...args);});
    const p=await fallback.newPage();await p.goto(file);await p.locator('#startLocalBtn').click();
    const cdp=await compose(p,'#inA','zhongwen');await commit(cdp,'中文');
    assert.equal(await p.locator('#inA').inputValue(),'中文');
    assert.equal(await p.locator('#inA').evaluate(n=>getComputedStyle(n).color),'rgba(0, 0, 0, 0)');
    assert.equal(await p.locator('#maskA').innerText(),'••');await fallback.close();
  });
  await check('Timed expiry during composition clears the unfinished word',async()=>{
    const p=await context.newPage();await p.clock.install();await p.goto(file);await p.locator('[data-mode="timed"]').click();await p.locator('#startLocalBtn').click();
    const cdp=await compose(p,'#inA','weixuanwandezhongwen');await p.clock.fastForward(30100);
    assert.match(await p.locator('#hint').innerText(),/时间到/);assert.equal(await p.locator('#inA').inputValue(),'');
    assert.equal(await p.locator('#wordA').innerText(),'山川');await cdp.detach();await p.close();
  });
  await check('Live room updates preserve Pinyin and both players reveal the committed Chinese',async()=>{
    app=createApp({getNetworkAddresses:()=>[]});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
    const a=await browser.newContext(),b=await browser.newContext(),host=await a.newPage(),guest=await b.newPage();
    for(const p of [host,guest])p.on('pageerror',e=>errors.push(e.message));
    await host.goto(base);await host.locator('#createRoomBtn').click();await host.locator('#inviteDialogLink').waitFor();const link=await host.locator('#inviteDialogLink').inputValue();await host.locator('#closeModal').click();
    await guest.goto(link);await guest.locator('#confirmJoinBtn').click();await host.locator('#inA').waitFor();await host.waitForFunction(()=>!document.querySelector('#inA').disabled);
    const draft='zirandeguangmang',cdp=await compose(host,'#inA',draft);
    await guest.locator('#inB').fill('自然');await guest.locator('#lockB').click();await host.waitForFunction(()=>document.querySelector('#statusB').textContent.includes('已锁定'));
    assert.equal(await host.locator('#inA').inputValue(),draft);assert.equal(await host.locator('#inA').isDisabled(),false);
    await commit(cdp,'自然');await host.locator('#lockA').click();await host.locator('#go').click();await host.locator('#resultControls').waitFor();await guest.locator('#resultControls').waitFor();
    assert.equal(await host.locator('#meetWord').innerText(),'自然');assert.equal(await guest.locator('#meetWord').innerText(),'自然');
    assert.deepEqual(errors,[]);await a.close();await b.close();
  });
  fs.writeFileSync(path.join(output,'ime-browser-report.json'),JSON.stringify({results,errors},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(app)await app.close();});

'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const gameUrl=process.env.PUBLIC_GAME_URL,pagesUrl=process.env.PUBLIC_PAGES_URL;
if(!gameUrl||!pagesUrl)throw new Error('Set PUBLIC_GAME_URL and PUBLIC_PAGES_URL to the deployed HTTPS sites');
for(const url of [gameUrl,pagesUrl])assert.equal(new URL(url).protocol,'https:');
const apiUrl=route=>new URL(route.replace(/^\//,''),gameUrl).href;
const output=path.join(__dirname,'..','artifacts');
fs.mkdirSync(output,{recursive:true});
const results=[],errors=[];
let browser,host,code;
async function check(name,run){await run();results.push({name,passed:true});console.log('PASS '+name);}
async function ready(page){await page.waitForFunction(()=>!document.querySelector('#createRoomBtn').disabled);}
async function lock(page,word){await page.locator('#wordInput').fill(word);await page.locator('#lockBtn').click();await page.waitForFunction(()=>document.querySelector('#wordInput').readOnly);}
async function reveal(host,guest,phase){await host.locator('#goBtn').click();for(const page of [host,guest])await page.waitForFunction(value=>document.body.dataset.phase===value,phase);}

(async()=>{
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const a=await browser.newContext({viewport:{width:1440,height:1050},permissions:['clipboard-read','clipboard-write']}),b=await browser.newContext({viewport:{width:390,height:844}}),p=await browser.newContext();
  const response=await a.request.get(apiUrl('/api/info'));
  assert.equal(response.status(),200,'Identify the separate game service before creating public test rooms');
  const info=await response.json();assert.equal(info.online,true);
  assert.equal(new URL(info.baseUrl).origin,new URL(gameUrl).origin);
  assert.equal(new URL(info.baseUrl).pathname.replace(/\/$/,''),new URL(gameUrl).pathname.replace(/\/$/,''));
  host=await a.newPage();const guest=await b.newPage(),pages=await p.newPage();
  for(const page of [host,guest,pages])page.on('pageerror',error=>errors.push(error.message));
  await check('Published Pages automatically enters the real online welcome',async()=>{
    const requests=[];pages.on('request',r=>requests.push(r.url()));
    await pages.goto(pagesUrl);await pages.waitForURL(gameUrl);await ready(pages);
    assert.equal(await pages.locator('#welcomeView').isVisible(),true);
    assert.equal(await pages.getByRole('button',{name:/同屏/}).count(),0);
    assert.match(await pages.locator('#ourStory').innerText(),/we26789/);
    assert.ok(!requests.some(url=>new URL(url).origin===new URL(pagesUrl).origin&&new URL(url).pathname.includes('/api/')));
    await pages.screenshot({path:path.join(output,'public-pages.png'),fullPage:true});
  });
  await check('Public room exposes a copyable code and correct HTTPS game-path link',async()=>{
    const pageResponse=await host.goto(gameUrl);assert.equal(pageResponse.status(),200);
    assert.ok((pageResponse.headers()['content-security-policy']||'').includes("script-src 'self'"));
    await ready(host);await host.locator('#createRoomBtn').click();await host.locator('#lobbyView').waitFor();
    code=await host.locator('#roomCode').innerText();const link=new URL(await host.locator('#roomLink').inputValue());
    assert.equal(link.origin,new URL(gameUrl).origin);assert.equal(link.pathname,new URL(gameUrl).pathname);assert.equal(link.searchParams.get('room'),code);assert.equal(link.protocol,'https:');
    await host.locator('#copyCodeBtn').click();assert.equal(await host.evaluate(()=>navigator.clipboard.readText()),code);
    await host.locator('#copyLinkBtn').click();assert.equal(await host.evaluate(()=>navigator.clipboard.readText()),link.href);
    await host.reload();await host.locator('#lobbyView').waitFor();assert.match(await host.locator('#invitationState').innerText(),/已邀请/);
    await host.screenshot({path:path.join(output,'public-invitation.png'),fullPage:true});
  });
  await check('Pages preserves invitation and acceptance starts both private sessions',async()=>{
    const invitation=new URL(pagesUrl);invitation.searchParams.set('room',code);
    await guest.goto(invitation.href);await guest.waitForURL(gameUrl+'?room='+code);await guest.locator('#confirmJoinBtn').waitFor();
    assert.equal((await b.cookies()).some(c=>c.name==='tcxy_session'),false);
    await guest.locator('#confirmJoinBtn').click();await guest.locator('#gameView').waitFor();await host.locator('#gameView').waitFor();
    assert.match(await host.locator('#playerNameA').innerText(),/你/);assert.match(await guest.locator('#playerNameB').innerText(),/你/);
    const cookie=(await a.cookies()).find(item=>item.name==='tcxy_session');assert.ok(cookie.secure&&cookie.httpOnly);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.path,new URL(gameUrl).pathname);
    assert.equal(await host.locator('#welcomeView').isVisible(),false);assert.equal(await host.locator('#wordInput').getAttribute('type'),'text');
  });
  await check('Public Chinese composition stays visible only to its author',async()=>{
    await host.locator('#wordInput').focus();const ime=await a.newCDPSession(host),text='senlinzhongwen';
    await ime.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});assert.equal(await host.locator('#wordInput').inputValue(),text);
    await host.locator('#wordInput').dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});assert.equal(await host.locator('#wordInput').evaluate(n=>n.readOnly),false);
    await ime.send('Input.insertText',{text:'森林'});await ime.detach();await host.locator('#lockBtn').click();
    await guest.waitForFunction(()=>document.querySelector('#statusA').textContent.includes('已锁定'));
    assert.equal(await host.locator('#wordInput').inputValue(),'森林');assert.equal(await host.locator('#wordInput').evaluate(n=>getComputedStyle(n).webkitTextSecurity),'none');
    assert.ok(!(await guest.locator('body').innerText()).includes('森林'));
    const state=await b.request.get(apiUrl('/api/rooms/'+code));assert.equal(state.status(),200);assert.ok(!(await state.text()).includes('森林'));
    await host.reload();await host.locator('#gameView').waitFor();assert.equal(await host.locator('#wordInput').inputValue(),'森林');assert.equal(await host.locator('#wordInput').evaluate(n=>n.readOnly),true);
  });
  await check('Both devices reveal, advance together and finish a real two-round match',async()=>{
    await lock(guest,'海洋');assert.equal(await host.locator('#wordInput').isVisible(),true);
    await reveal(host,guest,'next');assert.equal(await host.locator('#wordA').innerText(),'森林');assert.equal(await guest.locator('#wordB').innerText(),'海洋');
    await host.locator('#goBtn').click();assert.equal(await guest.locator('#roundNum').innerText(),'01');await guest.locator('#goBtn').click();
    for(const page of [host,guest])await page.waitForFunction(()=>document.querySelector('#roundNum').textContent==='02');
    await lock(host,'自然');await lock(guest,'自 然。');await reveal(host,guest,'done');
    assert.equal(await host.locator('#meetWord').innerText(),'自然');assert.equal(await guest.locator('#resultRounds').innerText(),'2');assert.equal(await host.locator('#resultGrade').innerText(),'S');
    await host.screenshot({path:path.join(output,'public-online.png'),fullPage:true});await guest.screenshot({path:path.join(output,'public-online-mobile.png'),fullPage:true});
  });
  await check('Public result exports a real PNG and complete text without private invitation data',async()=>{
    await host.locator('#copyBtn').click();const text=await host.evaluate(()=>navigator.clipboard.readText());assert.match(text,/森林 ↔ 海洋/);assert.ok(text.includes(gameUrl));assert.ok(!text.includes('room='));
    const download=host.waitForEvent('download');await host.locator('#downloadBtn').click();await(await download).saveAs(path.join(output,'public-shared-result.png'));
    const bytes=fs.readFileSync(path.join(output,'public-shared-result.png'));assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),1080);assert.equal(bytes.readUInt32BE(20),1440);
    await host.evaluate(()=>Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false}));await host.locator('#shareResultBtn').click();await host.waitForFunction(()=>document.querySelector('.share-preview')?.naturalWidth===1080);await host.keyboard.press('Escape');
  });
  await check('Rematch needs both players and leaving closes both sessions cleanly',async()=>{
    await host.locator('#againBtn').click();assert.equal(await guest.locator('#resultView').isVisible(),true);await guest.locator('#againBtn').click();await host.locator('#gameView').waitFor();await guest.locator('#gameView').waitFor();
    assert.equal(await host.locator('#roundNum').innerText(),'01');assert.equal(await host.evaluate(()=>JSON.parse(localStorage.getItem('tcxy.records.v2')).length),1);
    await host.locator('#leaveRoomBtn').click();await host.locator('#modalActions').getByRole('button',{name:'离开房间',exact:true}).click();await host.locator('#welcomeView').waitFor();await guest.locator('#welcomeView').waitFor();code=null;
    await host.locator('#recordsBtn').click();assert.equal(await host.locator('.record-entry').count(),1);assert.deepEqual(errors,[]);
  });
  fs.writeFileSync(path.join(output,'public-browser-report.json'),JSON.stringify({gameUrl,pagesUrl,results,errors},null,2));console.log(JSON.stringify({passed:results.length,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(host&&code)try{await host.evaluate(async url=>{await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({type:'leave'})});},apiUrl('/api/rooms/'+code+'/actions'));}catch(_){}
  if(browser)await browser.close();
});

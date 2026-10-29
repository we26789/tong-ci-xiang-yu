const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const gameUrl=process.env.PUBLIC_GAME_URL,pagesUrl=process.env.PUBLIC_PAGES_URL;
if(!gameUrl||!pagesUrl)throw new Error('Set PUBLIC_GAME_URL and PUBLIC_PAGES_URL to the deployed HTTPS sites');
for(const url of [gameUrl,pagesUrl])assert.equal(new URL(url).protocol,'https:');
const apiUrl=route=>new URL(route.replace(/^\//,''),gameUrl).href;
const output=path.join(__dirname,'..','artifacts');fs.mkdirSync(output,{recursive:true});
const results=[],errors=[];let browser,host,code;
async function check(name,run){await run();results.push({name,passed:true});console.log('PASS '+name);}
async function until(page,fn){await page.waitForFunction(fn,null,{timeout:20000});}

(async()=>{
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const a=await browser.newContext({viewport:{width:1440,height:1050}}),b=await browser.newContext({viewport:{width:390,height:844}});
  const serviceResponse=await a.request.get(apiUrl('/api/info'));
  assert.equal(serviceResponse.status(),200,'Verify the separate game service before any public writes');
  const serviceInfo=await serviceResponse.json();
  assert.equal(serviceInfo.online,true,'The target must identify itself as the game room service');
  assert.equal(new URL(serviceInfo.baseUrl).origin,new URL(gameUrl).origin);
  host=await a.newPage();const guest=await b.newPage(),pages=await (await browser.newContext()).newPage();
  for(const page of [host,guest,pages])page.on('pageerror',error=>errors.push(error.message));
  await check('Published Pages plays a full same-screen game without requesting room APIs',async()=>{
    const apiRequests=[];pages.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))apiRequests.push(request.url());});
    const response=await pages.goto(pagesUrl);assert.equal(response.status(),200);
    await until(pages,()=>document.querySelector('#connectionHint').textContent.includes('进入联机版'));
    await pages.locator('#inA').fill('星空');await pages.locator('#lockA').click();await pages.locator('#inB').fill('星空');await pages.locator('#lockB').click();await pages.locator('#go').click();
    await until(pages,()=>document.querySelector('#resultControls').hidden===false);
    assert.equal(await pages.locator('#statTotal').innerText(),'1');assert.equal(apiRequests.length,0);
    await pages.screenshot({path:path.join(output,'public-pages.png'),fullPage:true});
  });
  await check('Pages offers an explicit working HTTPS online entry',async()=>{
    await pages.locator('#inviteBtn').click();await pages.locator('#modalActions').getByRole('button',{name:'进入联机版',exact:true}).click();
    await pages.waitForURL(gameUrl+'**');
    await until(pages,()=>document.querySelector('#connectionHint').textContent.includes('支持好友联机'));
  });
  await check('Public invitation joins two independent sessions with secure private seats',async()=>{
    const response=await host.goto(gameUrl);assert.equal(response.status(),200);
    assert.ok((response.headers()['content-security-policy']||'').includes("script-src 'self'"));
    await until(host,()=>document.querySelector('#connectionHint').textContent.includes('支持好友联机'));
    await host.locator('#createRoomBtn').click();await host.locator('#inviteDialogLink').waitFor();
    code=await host.locator('#roomCode').innerText();const link=await host.locator('#inviteDialogLink').inputValue();
    assert.equal(new URL(link).origin,new URL(gameUrl).origin);assert.equal(new URL(link).protocol,'https:');assert.equal(new URL(link).pathname,new URL(gameUrl).pathname);
    await host.locator('#closeModal').click();await guest.goto(link);await guest.locator('#confirmJoinBtn').click();
    await until(guest,()=>!document.querySelector('#inB').disabled);await until(host,()=>!document.querySelector('#inA').disabled);
    const cookie=(await a.cookies()).find(item=>item.name==='tcxy_session');assert.ok(cookie.secure&&cookie.httpOnly);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.path,new URL(gameUrl).pathname);
    await host.locator('#inA').fill('公网星雾');await host.locator('#lockA').click();
    await until(guest,()=>document.querySelector('#statusA').textContent.includes('已锁定'));
    const state=await b.request.get(apiUrl('/api/rooms/'+code));assert.equal(state.status(),200);assert.ok(!(await state.text()).includes('公网星雾'));
  });
  await check('Public refresh restores the seat and both browsers reveal the same win',async()=>{
    await host.reload();await until(host,()=>document.querySelector('#roomDetails').hidden===false);
    assert.equal(await host.locator('#inA').inputValue(),'公网星雾');
    await guest.locator('#inB').fill('公网星雾');await guest.locator('#lockB').click();
    await until(host,()=>!document.querySelector('#go').disabled);await host.locator('#go').click();
    await until(host,()=>document.querySelector('#resultControls').hidden===false);await until(guest,()=>document.querySelector('#resultControls').hidden===false);
    assert.equal(await host.locator('#resultGrade').innerText(),'SSS');assert.equal(await guest.locator('#statTotal').innerText(),'1');
    await host.screenshot({path:path.join(output,'public-online.png'),fullPage:true});await guest.screenshot({path:path.join(output,'public-online-mobile.png'),fullPage:true});
  });
  await check('Leaving the public room closes both sessions and no script errors occur',async()=>{
    await host.locator('#leaveRoomBtn').click();await host.getByRole('button',{name:'退出房间',exact:true}).click();
    await until(guest,()=>document.querySelector('#roomDetails').hidden===true);
    code=null;assert.deepEqual(errors,[]);
  });
  fs.writeFileSync(path.join(output,'public-browser-report.json'),JSON.stringify({gameUrl,pagesUrl,results,errors},null,2));
  console.log(JSON.stringify({passed:results.length,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(host&&code)try{await host.evaluate(async input=>{await fetch(input.url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({type:'leave'})});},{url:apiUrl('/api/rooms/'+code+'/actions')});}catch(_){}
  if(browser)await browser.close();
});

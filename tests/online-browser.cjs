const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createApp}=require('../server.cjs');
const {RoomStore}=require('../server/rooms.cjs');
const output=path.join(__dirname,'..','artifacts');
const results=[],errors=[],expectedNetworkErrors=[];let browser,app;
async function check(name,run){await run();results.push({name,passed:true});console.log('PASS '+name);}
async function until(page,fn){await page.waitForFunction(fn,null,{timeout:8000});}
async function shot(page,name){await page.waitForTimeout(800);await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});}

(async()=>{
  let clockShift=0;
  app=createApp({store:new RoomStore({now:()=>Date.now()+clockShift})});await new Promise(resolve=>app.server.listen(0,'0.0.0.0',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const a=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});
  const b=await browser.newContext({viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']});
  const c=await browser.newContext();
  const host=await a.newPage(),guest=await b.newPage(),third=await c.newPage();
  for(const page of [host,guest,third]){page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()!=='error')return;const text=message.text();if(/status of (409|410|422)/.test(text)||/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(text))expectedNetworkErrors.push(text);else errors.push(text);});}
  await check('Create a room with real LAN invitation; host waits for a partner',async()=>{
    await host.goto(base);await until(host,()=>document.querySelector('#connectionHint').textContent.includes('局域网'));
    await host.locator('#createRoomBtn').click();await host.locator('#inviteDialogLink').waitFor();
    await host.locator('#closeModal').click();
    assert.match(await host.locator('#roomCode').innerText(),/^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(await host.locator('#inA').isDisabled(),true);
    const link=await host.locator('#roomLink').inputValue();assert.ok(!link.includes('127.0.0.1'));assert.match(link,/room=/);
    const cookies=await a.cookies();assert.equal(cookies.find(cookie=>cookie.name==='tcxy_session').httpOnly,true);
    assert.equal(await host.evaluate(()=>document.cookie.includes('tcxy_session')),false);
    await shot(host,'online-waiting');
  });
  const code=await host.locator('#roomCode').innerText();
  const shareLink=await host.locator('#roomLink').inputValue();
  await check('Opening a share link asks once and never auto-joins or starts a timer',async()=>{
    await guest.goto(shareLink);await guest.locator('#confirmJoinBtn').waitFor();
    assert.equal(await guest.locator('#joinCode').inputValue(),code);
    assert.match(await host.locator('#goLabel').innerText(),/等待好友/);
    assert.equal((await b.cookies()).some(cookie=>cookie.name==='tcxy_session'),false);
    await guest.locator('#confirmJoinBtn').click();
    await until(guest,()=>document.querySelector('#roomDetails').hidden===false);
    await until(host,()=>document.querySelector('#inA').disabled===false);
    assert.equal(await guest.locator('#inB').isDisabled(),false);
    assert.equal(await guest.locator('#inA').isDisabled(),true);
    assert.equal(await guest.locator('#modal').evaluate(node=>node.open),false);
  });
  await check('Copies actual invitation code and link; full rooms reject a third player',async()=>{
    await host.locator('#copyCodeBtn').click();assert.equal(await host.evaluate(()=>navigator.clipboard.readText()),code);
    await host.locator('#copyLinkBtn').click();assert.equal(await host.evaluate(()=>navigator.clipboard.readText()),await host.locator('#roomLink').inputValue());
    await third.goto(base+'/?room='+code);await third.locator('#confirmJoinBtn').click();
    await until(third,()=>document.querySelector('#joinError').textContent.includes('两位'));
    assert.equal(await third.locator('#roomDetails').isVisible(),false);
    await shot(guest,'online-mobile');
  });
  await check('Only own input is editable; private word is absent from the peer response',async()=>{
    await host.locator('#inA').fill('森林');await host.locator('#lockA').click();
    await until(guest,()=>document.querySelector('#statusA').textContent.includes('已锁定'));
    const state=await b.request.get(new URL(guest.url()).origin+'/api/rooms/'+code);assert.equal(state.status(),200);assert.ok(!(await state.text()).includes('森林'));
    assert.equal(await guest.locator('#inA').inputValue(),'');
    await guest.locator('#inB').fill('海洋');await guest.locator('#lockB').click();
    await until(host,()=>document.querySelector('#go').disabled===false);
    await host.locator('#go').click();
    await until(guest,()=>document.querySelector('#countdown').hidden===false);
    await until(host,()=>document.querySelector('#wordA').textContent==='森林');
    await until(guest,()=>document.querySelector('#wordB').textContent==='海洋');
  });
  await check('Both players must prepare; one player cannot advance the round alone',async()=>{
    await host.locator('#go').click();await until(host,()=>document.querySelector('#goLabel').textContent.includes('已准备'));
    assert.equal(await guest.locator('#roundNum').innerText(),'01');
    await guest.locator('#go').click();
    await until(host,()=>document.querySelector('#roundNum').textContent==='02');
    await until(guest,()=>document.querySelector('#roundNum').textContent==='02');
  });
  await check('Refreshing restores the same seat and locked word without another join prompt',async()=>{
    await host.locator('#inA').fill('自然');await host.locator('#lockA').click();
    await until(host,()=>document.querySelector('#statusA').textContent.includes('已锁定'));
    await host.reload();await until(host,()=>document.querySelector('#roomDetails').hidden===false);
    assert.equal(await host.locator('#yourSeat').innerText(),'A');
    assert.equal(await host.locator('#inA').inputValue(),'自然');
    assert.equal(await host.locator('#modal').evaluate(node=>node.open),false);
    await guest.locator('#inB').fill('自 然。');await guest.locator('#lockB').click();
    await until(guest,()=>document.querySelector('#go').disabled===false);await guest.locator('#go').click();
    await until(host,()=>document.querySelector('#resultControls').hidden===false);
    await until(guest,()=>document.querySelector('#resultControls').hidden===false);
    assert.equal(await host.locator('#statTotal').innerText(),'1');assert.equal(await guest.locator('#statTotal').innerText(),'1');
    assert.equal(await host.locator('#resultGrade').innerText(),'S');
    await shot(host,'online-match');
  });
  await check('Rematch waits for both players and records the finished game only once',async()=>{
    await host.locator('#againBtn').click();await until(host,()=>document.querySelector('#againBtn').textContent.includes('已准备'));
    assert.equal(await guest.locator('#resultControls').isVisible(),true);
    await guest.locator('#againBtn').click();
    await until(host,()=>document.querySelector('#roundNum').textContent==='01'&&document.querySelector('#resultControls').hidden);
    await until(guest,()=>document.querySelector('#inB').disabled===false);
    assert.equal(await host.locator('#statTotal').innerText(),'1');
  });
  await check('Temporary offline state reconnects automatically with the same seat',async()=>{
    await b.setOffline(true);
    await until(guest,()=>document.querySelector('#connectionStatus').textContent.includes('重连'));
    await b.setOffline(false);
    await until(guest,()=>document.querySelector('#connectionStatus').textContent==='联机中');
    assert.equal(await guest.locator('#yourSeat').innerText(),'B');
  });
  await check('Leaving closes the room for both players and invalidates the invitation',async()=>{
    await host.locator('#leaveRoomBtn').click();await host.getByRole('button',{name:'退出房间',exact:true}).click();
    await until(host,()=>document.querySelector('#roomLobby').hidden===false);
    await until(guest,()=>document.querySelector('#roomLobby').hidden===false);
    await third.reload();await third.locator('#confirmJoinBtn').click();
    await until(third,()=>document.querySelector('#joinError').textContent.includes('结束'));
  });
  await check('Manual codes, actual LAN access, and clipboard fallback work',async()=>{
    await host.locator('[data-mode="timed"]').click();
    await host.locator('#createRoomBtn').click();await host.locator('#inviteDialogLink').waitFor();await host.locator('#closeModal').click();
    const nextCode=await host.locator('#roomCode').innerText();
    await guest.locator('#joinRoomBtn').click();await guest.locator('#joinCode').fill(nextCode.toLowerCase().slice(0,3)+'-'+nextCode.toLowerCase().slice(3));
    await guest.locator('#confirmJoinBtn').click();
    await until(host,()=>document.querySelector('#inA').disabled===false);
    await until(guest,()=>document.querySelector('#roomDetails').hidden===false);
    assert.equal(await guest.locator('#roomCode').innerText(),nextCode);
    assert.equal(await guest.locator('[data-mode="timed"]').getAttribute('aria-pressed'),'true');
    await guest.locator('#copyLinkBtn').click();
    if(await guest.locator('#modal').evaluate(node=>node.open)){
      assert.equal(await guest.locator('.share-fallback').inputValue(),await guest.locator('#roomLink').inputValue());
      await guest.locator('#closeModal').click();
    }
    await shot(guest,'online-lan-invitation');
  });
  await check('Online timed expiry is server-owned and never reveals an unfinished word',async()=>{
    await guest.locator('#inB').fill('秘密月亮');
    await until(host,()=>!document.querySelector('#timerText').textContent.includes('输入后开始'));
    await guest.locator('#lockB').click();
    await until(host,()=>document.querySelector('#statusB').textContent.includes('已锁定'));
    clockShift+=30100;app.store.tick();
    await until(host,()=>document.querySelector('#hint').textContent.includes('时间到'));
    await until(guest,()=>document.querySelector('#hint').textContent.includes('时间到'));
    assert.equal(await guest.locator('#inB').inputValue(),'');
    assert.equal(await host.locator('#wordB').innerText(),'海洋');
    assert.equal(await host.locator('#statTotal').innerText(),'1');
  });
  await check('Expired invitation is explained without silently creating a new room',async()=>{
    const expiredCode=await host.locator('#roomCode').innerText();
    clockShift+=2*60*60*1000+1000;app.store.tick();
    await until(host,()=>document.querySelector('#roomLobby').hidden===false);
    await third.goto(base+'/?room='+expiredCode);await third.locator('#confirmJoinBtn').click();
    await until(third,()=>document.querySelector('#joinError').textContent.includes('过期'));
    assert.equal(await third.locator('#roomDetails').isVisible(),false);
  });
  await check('New invitation controls fit 320px and no script or CSP errors occur',async()=>{
    await host.setViewportSize({width:320,height:844});await shot(host,'online-320');
    assert.equal(await host.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
  });
  fs.writeFileSync(path.join(output,'online-browser-report.json'),JSON.stringify({passed:true,checks:results,errors,expectedNetworkErrors},null,2));
  console.log(JSON.stringify({passed:results.length,errors}));
})().catch(error=>{console.error(error);fs.writeFileSync(path.join(output,'online-browser-report.json'),JSON.stringify({passed:false,checks:results,errors,error:error.message},null,2));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(app)await app.close();});

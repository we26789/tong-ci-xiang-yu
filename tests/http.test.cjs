const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createApp} = require('../server.cjs');

test('HTTP room lifecycle, secure seats, idempotency, privacy and input protection',async t=>{
  const app=createApp();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;
  async function call(route,{body,cookie,key=crypto.randomUUID(),origin=base,contentType='application/json'}={}){
    const headers={};if(cookie)headers.Cookie=cookie;
    if(body!==undefined){headers.Origin=origin;headers['Content-Type']=contentType;headers['Idempotency-Key']=key;}
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,headers:response.headers,data:await response.json()};
  }
  assert.equal((await call('/api/info')).data.online,true);
  const blocked=await call('/api/rooms',{body:{mode:'classic',theme:'free'},origin:'https://attacker.invalid'});
  assert.equal(blocked.status,403);
  assert.equal((await call('/api/rooms',{body:{},contentType:'text/plain'})).status,415);
  assert.equal((await call('/api/rooms',{body:{payload:'x'.repeat(5000)}})).status,413);
  const intent=crypto.randomUUID();
  const host=await call('/api/rooms',{body:{mode:'classic',theme:'free'},key:intent});
  assert.equal(host.status,201);
  const setCookie=host.headers.get('set-cookie');
  assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
  const cookieA=setCookie.split(';')[0],code=host.data.room.code;
  assert.ok(!JSON.stringify(host.data).includes(cookieA.split('=')[1]));
  assert.equal(new URL(host.data.room.shareUrl).searchParams.get('room'),code);
  const replay=await call('/api/rooms',{body:{mode:'classic',theme:'free'},key:intent});
  assert.equal(replay.data.room.code,code);
  assert.equal((await call('/api/rooms',{body:{mode:'timed',theme:'free'},key:intent})).status,409);
  assert.equal((await call('/api/rooms/'+code)).status,401);
  const guest=await call('/api/rooms/'+code+'/members',{body:{}});
  assert.equal(guest.status,201);
  const cookieB=guest.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/rooms/'+code+'/members',{body:{}})).data.error.code,'ROOM_FULL');
  const view=(await call('/api/rooms/'+code,{cookie:cookieA})).data.room;
  const command={type:'lock',gameId:view.game.id,round:1,word:'私密森林'};
  const lockKey=crypto.randomUUID();
  assert.equal((await call('/api/rooms/'+code+'/actions',{body:command,cookie:cookieA,key:lockKey})).status,200);
  assert.equal((await call('/api/rooms/'+code+'/actions',{body:command,cookie:cookieA,key:lockKey})).status,200);
  assert.equal((await call('/api/rooms/'+code+'/actions',{body:{...command,word:'偷改'},cookie:cookieA,key:lockKey})).status,409);
  const other=(await call('/api/rooms/'+code,{cookie:cookieB})).data.room;
  assert.equal(JSON.stringify(other).includes('私密森林'),false);
  assert.equal((await call('/api/session',{cookie:cookieA})).data.room.seat,0);
  assert.equal((await call('/api/rooms/'+code+'/actions',{body:{type:'leave'},cookie:cookieA})).status,200);
  assert.equal((await call('/api/rooms/'+code+'/members',{body:{}})).status,410);
  assert.equal((await call('/api/rooms/'+code,{cookie:cookieB})).data.room.status,'closed');
});

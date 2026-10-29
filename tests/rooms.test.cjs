const {test} = require('node:test');
const assert = require('node:assert/strict');
const {RoomStore} = require('../server/rooms.cjs');

function setup(options={}) {
  let now=100000;
  const store=new RoomStore({...options,now:()=>now});
  const host=store.create({mode:'classic',theme:'free'});
  const guest=store.join(host.code);
  const send=(member,type,extra={})=>store.action(member.code,member.token,{type,gameId:store.view(member.code,member.token).game.id,round:store.view(member.code,member.token).game.round,...extra});
  return {store,host,guest,send,advance(ms){now+=ms;store.tick();}};
}

test('codes are six readable random characters; one room has only two seats',()=>{
  const {store,host}=setup();
  assert.match(host.code,/^[A-HJ-NP-Z2-9]{6}$/);
  assert.throws(()=>store.join(host.code),error=>error.code==='ROOM_FULL');
  assert.throws(()=>store.view(host.code,'invalid-token'),error=>error.code==='UNAUTHORIZED');
});

test('each member sees only their own locked word; room code is not authentication',()=>{
  const {store,host,guest,send}=setup();
  send(host,'lock',{word:'不能偷看的秘密'});
  assert.equal(store.view(host.code,host.token).self.word,'不能偷看的秘密');
  const other=store.view(guest.code,guest.token);
  assert.equal(other.self.word,'');
  assert.equal(JSON.stringify(other).includes('不能偷看'),false);
  assert.equal(other.players[0].locked,true);
  assert.equal(JSON.stringify(other).includes(host.token),false);
});

test('reveal is server-timed and no word leaks during the countdown',()=>{
  const {store,host,guest,send,advance}=setup();
  assert.throws(()=>send(host,'reveal'),error=>error.code==='NOT_READY');
  send(host,'lock',{word:'森林'});send(guest,'lock',{word:'海洋'});
  send(host,'reveal');
  assert.equal(store.view(host.code,host.token).game.phase,'countdown');
  assert.equal(JSON.stringify(store.view(guest.code,guest.token)).includes('森林'),false);
  advance(1800);
  assert.equal(store.view(host.code,host.token).game.phase,'next');
  assert.equal(store.view(guest.code,guest.token).game.history[0].a,'森林');
  send(host,'next');
  assert.equal(store.view(host.code,host.token).game.round,1);
  send(guest,'next');
  assert.equal(store.view(host.code,host.token).game.round,2);
});

test('matching words finish once and both players agree to rematch',()=>{
  const {store,host,guest,send,advance}=setup();
  send(host,'lock',{word:'月 亮。'});send(guest,'lock',{word:'月亮'});send(guest,'reveal');advance(1800);
  const id=store.view(host.code,host.token).game.id;
  assert.equal(store.view(host.code,host.token).game.phase,'done');
  send(host,'rematch');assert.equal(store.view(host.code,host.token).game.id,id);
  send(guest,'rematch');assert.notEqual(store.view(host.code,host.token).game.id,id);
});

test('stale-round writes and editing an already locked word are rejected',()=>{
  const {store,host,send}=setup();
  assert.throws(()=>send(host,'lock',{word:'。。。'}),error=>error.code==='INVALID_WORD');
  assert.throws(()=>send(host,'lock',{word:'一二三四五六七八九十一'}),error=>error.code==='INVALID_WORD');
  send(host,'lock',{word:'星星'});
  assert.throws(()=>send(host,'lock',{word:'月亮'}),error=>error.code==='LOCKED');
  assert.throws(()=>send(host,'unlock',{round:3}),error=>error.code==='STALE_ROUND');
});

test('timed expiry clears all private words without recording a win',()=>{
  const {store,host,guest,send,advance}=setup({defaultMode:'timed'});
  // New setup for timed mode, since a room's mode is fixed at creation.
  const timed=store.create({mode:'timed',theme:'space'}), other=store.join(timed.code);
  const view=store.view(timed.code,timed.token);
  store.action(timed.code,timed.token,{type:'timer',gameId:view.game.id,round:1});
  store.action(timed.code,timed.token,{type:'lock',gameId:view.game.id,round:1,word:'秘密'});
  advance(30000);
  const state=store.view(timed.code,other.token);
  assert.equal(state.game.phase,'timeout');
  assert.equal(JSON.stringify(state).includes('秘密'),false);
  assert.equal(state.game.history[0].timeout,true);
});

test('waiting room cannot start play; leaving closes it and invalidates joining',()=>{
  const store=new RoomStore();const host=store.create({mode:'classic',theme:'free'});
  const view=store.view(host.code,host.token);
  assert.throws(()=>store.action(host.code,host.token,{type:'lock',gameId:view.game.id,round:1,word:'月亮'}),error=>error.code==='WAITING_FOR_PARTNER');
  store.action(host.code,host.token,{type:'leave',gameId:view.game.id,round:1});
  assert.throws(()=>store.join(host.code),error=>error.code==='ROOM_CLOSED');
});

test('expired rooms reject joins and expire even without game traffic',()=>{
  const {store,host,advance}=setup({ttlMs:1000});
  advance(1001);
  assert.throws(()=>store.join(host.code),error=>error.code==='ROOM_EXPIRED');
  assert.equal(store.view(host.code,host.token).status,'closed');
});

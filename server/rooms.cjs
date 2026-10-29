const {EventEmitter} = require('node:events');
const crypto = require('node:crypto');
const core = require('./core.cjs');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const THEMES = ['free','nature','food','daily','space','romance'];
class RoomError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new RoomError(code, message, status); };

class RoomStore extends EventEmitter {
  constructor({now = Date.now, ttlMs = 2 * 60 * 60 * 1000, maxRooms = 100} = {}) {
    super();
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxRooms = maxRooms;
    this.rooms = new Map();
    this.sessions = new Map();
  }
  options(input) {
    if (!input || !['classic','timed'].includes(input.mode) || !THEMES.includes(input.theme)) {
      fail('INVALID_SETTINGS','请选择有效的游戏模式和主题。',422);
    }
    return {mode: input.mode, theme: input.theme};
  }
  changed(room) { room.revision++; this.emit('change',room.code); }
  activeMembership(token) {
    const membership = this.sessions.get(token);
    if (!membership) return null;
    const room = this.rooms.get(membership.code);
    if (room) this.tickRoom(room);
    return room && room.status !== 'closed' ? membership : null;
  }
  create(input, existingToken) {
    const settings = this.options(input);
    if (this.activeMembership(existingToken)) fail('ALREADY_IN_ROOM','你已经在一个房间里，请先返回或退出。');
    this.tick();
    if (this.rooms.size >= this.maxRooms*3 || [...this.rooms.values()].filter(room => room.status !== 'closed').length >= this.maxRooms) {
      fail('SERVER_FULL','当前房间较多，请稍后再试。',503);
    }
    let code;
    do { code = Array.from({length:6},() => ALPHABET[crypto.randomInt(ALPHABET.length)]).join(''); } while (this.rooms.has(code));
    const room = {code, revision:1, status:'waiting', createdAt:this.now(), expiresAt:this.now()+this.ttlMs,
      game:core.createGame(settings), members:[null,null], nextReady:[false,false], rematchReady:[false,false],
      revealAt:null, closedAt:null, closedReason:null};
    this.rooms.set(code,room);
    const token = this.addMember(room,0);
    return {code,token};
  }
  addMember(room, side) {
    const token = crypto.randomBytes(32).toString('base64url');
    room.members[side] = {token,lastSeen:this.now(),connected:true};
    this.sessions.set(token,{code:room.code,side});
    this.changed(room);
    return token;
  }
  get(code) {
    if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{6}$/.test(code)) fail('INVALID_CODE','邀请码应为 6 位字母或数字。',422);
    const room = this.rooms.get(code);
    if (!room) fail('ROOM_NOT_FOUND','没有找到这个房间，请检查邀请码。',404);
    this.tickRoom(room);
    return room;
  }
  assertOpen(room) {
    if (room.status === 'closed') fail(room.closedReason === 'expired' ? 'ROOM_EXPIRED' : 'ROOM_CLOSED',
      room.closedReason === 'expired' ? '这个房间已过期，请让好友重新邀请。' : '房间已结束，请创建新的邀请。',410);
  }
  join(code, existingToken) {
    const room = this.get(code);
    this.assertOpen(room);
    if (this.activeMembership(existingToken)) fail('ALREADY_IN_ROOM','你已经在房间中，刷新可恢复原来的席位。');
    if (room.members[1]) fail('ROOM_FULL','这个房间已经有两位玩家啦。');
    const token = this.addMember(room,1);
    room.status = 'playing';
    this.changed(room);
    return {code,token};
  }
  authorize(code, token) {
    const membership = this.sessions.get(token);
    if (!membership || membership.code !== code) fail('UNAUTHORIZED','你的席位已失效，请重新加入房间。',401);
    const room = this.get(code);
    const member = room.members[membership.side];
    if (!member || member.token !== token) fail('UNAUTHORIZED','你的席位已失效，请重新加入房间。',401);
    return {room,side:membership.side,member};
  }
  touch(code, token) {
    const {room,member} = this.authorize(code,token);
    member.lastSeen = this.now();
    if (!member.connected && room.status !== 'closed') { member.connected = true; this.changed(room); }
  }
  session(token) {
    const membership = this.sessions.get(token);
    return membership ? this.view(membership.code,token) : null;
  }
  view(code, token) {
    const {room,side} = this.authorize(code,token);
    const game = room.game;
    return {
      code:room.code, revision:room.revision, seat:side, status:room.status, expiresAt:room.expiresAt,
      closedReason:room.closedReason, serverNow:this.now(),
      players:room.members.map((member,i) => ({joined:!!member, connected:!!member?.connected,
        locked:room.status !== 'closed' && game.locked[i], nextReady:room.nextReady[i], rematchReady:room.rematchReady[i]})),
      self:{word:room.status === 'closed' ? '' : game.words[side], locked:room.status !== 'closed' && game.locked[side]},
      game:{id:game.id,mode:game.mode,theme:game.theme,round:game.round,phase:game.phase,
        history:game.history.map(row=>({...row})), deadline:game.deadline, remainingMs:game.remainingMs, revealAt:room.revealAt}
    };
  }
  action(code, token, input) {
    const {room,side} = this.authorize(code,token);
    if (input?.type === 'leave') {
      if (room.status !== 'closed') this.closeRoom(room,'player_left');
      return this.view(code,token);
    }
    this.assertOpen(room);
    if (room.status !== 'playing') fail('WAITING_FOR_PARTNER','等好友加入后，就可以开始这一局。');
    const game = room.game;
    if (!input || input.gameId !== game.id || input.round !== game.round) fail('STALE_ROUND','回合已更新，正在同步最新进度。');
    switch (input.type) {
      case 'timer':
        if (game.phase !== 'input') break;
        core.startTimer(game,this.now());
        break;
      case 'lock':
        if (game.phase !== 'input') fail('ROUND_CLOSED','本轮已经结束，请等待下一轮。');
        if (game.locked[side]) fail('LOCKED','词语已锁定，先解锁才能修改。');
        if (typeof input.word !== 'string' || Array.from(input.word).length > 10 || !core.normalize(input.word)) fail('INVALID_WORD','请输入 10 个字以内的词，不能只有标点或空格。',422);
        core.setWord(game,side,input.word);
        core.toggleLock(game,side);
        core.startTimer(game,this.now());
        break;
      case 'unlock':
        if (game.phase !== 'input') fail('ROUND_CLOSED','倒数或揭晓后不能再修改。');
        if (game.locked[side]) core.toggleLock(game,side);
        break;
      case 'reveal':
        if (game.phase === 'countdown' || game.phase === 'next' || game.phase === 'done') break;
        if (game.phase !== 'input' || !game.locked.every(Boolean)) fail('NOT_READY','两位都锁词后才能揭晓。');
        core.beginReveal(game);
        room.revealAt = this.now()+1800;
        break;
      case 'next':
        if (!['next','timeout'].includes(game.phase)) fail('ROUND_CLOSED','先完成当前回合。');
        room.nextReady[side] = true;
        if (room.nextReady.every(Boolean)) { core.nextRound(game); room.nextReady = [false,false]; }
        break;
      case 'rematch':
        if (game.phase !== 'done') fail('ROUND_CLOSED','先完成这一局，才能再来一局。');
        room.rematchReady[side] = true;
        if (room.rematchReady.every(Boolean)) {
          room.game = core.createGame({mode:game.mode,theme:game.theme});
          room.rematchReady = [false,false];
          room.nextReady = [false,false];
          room.revealAt = null;
        }
        break;
      default: fail('INVALID_ACTION','不支持的游戏操作。',422);
    }
    this.changed(room);
    return this.view(code,token);
  }
  closeRoom(room, reason) {
    room.status = 'closed'; room.closedReason = reason; room.closedAt = this.now();
    room.game.words = ['','']; room.game.locked = [false,false]; room.game.deadline = null; room.revealAt = null;
    this.changed(room);
  }
  tickRoom(room) {
    if (room.status === 'closed') return;
    if (this.now() >= room.expiresAt) { this.closeRoom(room,'expired'); return; }
    if (room.status === 'playing') {
      if (room.game.phase === 'countdown' && this.now() >= room.revealAt) {
        core.resolveRound(room.game); room.revealAt = null; this.changed(room);
      } else if (core.tick(room.game,this.now())) this.changed(room);
    }
    for (const member of room.members) {
      if (member && member.connected && this.now()-member.lastSeen > 35000) { member.connected = false; this.changed(room); }
    }
  }
  tick() {
    for (const room of this.rooms.values()) {
      this.tickRoom(room);
      if (room.closedAt !== null && this.now()-room.closedAt > 15*60*1000) {
        for (const member of room.members) if (member) this.sessions.delete(member.token);
        this.rooms.delete(room.code);
      }
    }
  }
}
module.exports = {RoomStore,RoomError};

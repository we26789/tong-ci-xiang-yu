const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const {RoomStore,RoomError} = require('./server/rooms.cjs');

function localHostname(host) {
  return ['localhost','127.0.0.1','[::1]'].includes(host) || net.isIP(host) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

function networkAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name,addresses]) => (addresses||[])
    .filter(item=>item.family==='IPv4'&&!item.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))
    .map(item=>({name,address:item.address})))
    .sort((a,b)=>Number(/virtual|vethernet|docker|wsl/i.test(a.name))-Number(/virtual|vethernet|docker|wsl/i.test(b.name)));
}
function createApp({publicUrl = process.env.PUBLIC_URL || '', store = new RoomStore(), limit = 120, getNetworkAddresses = networkAddresses, trustProxy = process.env.TRUST_PROXY || ''} = {}) {
  let published = null;
  if (publicUrl) {
    published = new URL(publicUrl);
    if (!['http:','https:'].includes(published.protocol)||published.username||published.password||published.search||published.hash||published.pathname!=='/') throw new Error('PUBLIC_URL must be a root HTTP(S) URL without credentials, query or fragment');
    if (published.protocol!=='https:'&&!localHostname(published.hostname)) throw new Error('Use HTTPS for a public PUBLIC_URL');
  }
  const intents=new Map(), rates=new Map();
  const allowedHosts=new Set(['127.0.0.1','localhost','[::1]',os.hostname().toLowerCase()]);
  if(published)allowedHosts.add(published.hostname.toLowerCase());
  let waiters=0;
  const waitsPerSeat=new Map();
  const pendingWaits=new Set();
  store.setMaxListeners(0);
  function clientAddress(req) {
    const peer=req.socket.remoteAddress||'',forwarded=req.headers['x-real-ip'];
    if(trustProxy==='loopback'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof forwarded==='string'&&net.isIP(forwarded))return forwarded;
    return peer;
  }
  const cookieToken=req=>{const match=(req.headers.cookie||'').match(/(?:^|;\s*)tcxy_session=([a-zA-Z0-9_-]{43})(?:;|$)/);return match?match[1]:'';};
  const cookie=value=>'tcxy_session='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+(value?'7200':'0')+(published?.protocol==='https:'?'; Secure':'');
  function security(res,scriptHashes='') {
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' "+scriptHashes+"; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if(published?.protocol==='https:')res.setHeader('Strict-Transport-Security','max-age=15552000');
  }
  function json(res,status,body) { if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body)); }
  function requestUrl(req) {
    let url;try{url=new URL(req.url,'http://'+req.headers.host);}catch(_){throw new RoomError('INVALID_REQUEST','请求地址不正确。',400);}
    if(!allowedHosts.has(url.hostname.toLowerCase())&&!getNetworkAddresses().some(item=>item.address===url.hostname))throw new RoomError('INVALID_HOST','请使用服务提供的访问地址。',403);
    return url;
  }
  function sharing(req) {
    const url=requestUrl(req),port=server.address().port;
    const addresses=getNetworkAddresses();
    let base=published?.origin;
    if(!base)base=['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&addresses.length?'http://'+addresses[0].address+':'+port:url.origin;
    const host=new URL(base).hostname;
    return {baseUrl:base,shareScope:['localhost','127.0.0.1','[::1]'].includes(host)?'local':localHostname(host)?'lan':'public'};
  }
  function decorate(req,view) { if(!view)return null;const info=sharing(req);return {...view,shareScope:info.shareScope,shareUrl:info.baseUrl+'/?room='+view.code}; }
  function throttle(req,kind) {
    const key=(clientAddress(req)||'unknown')+':'+kind,now=Date.now();
    let value=rates.get(key);if(!value||now-value.start>=60000){
      if(rates.size>=5000){for(const[k,v]of rates)if(now-v.start>=60000)rates.delete(k);if(rates.size>=5000)throw new RoomError('SERVER_BUSY','服务繁忙，请稍后重试。',503);}
      value={start:now,count:0};rates.set(key,value);
    }
    value.count++;
    if(value.count>(kind==='join'?30:kind==='create'?12:limit))throw new RoomError('RATE_LIMITED','操作有些频繁，请稍后重试。',429);
    if(rates.size>5000)for(const [key,value]of rates)if(now-value.start>60000)rates.delete(key);
  }
  async function body(req) {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new RoomError('JSON_REQUIRED','请使用 JSON 请求。',415);
    if(Number(req.headers['content-length'])>4096){req.resume();throw new RoomError('BODY_TOO_LARGE','请求内容过长。',413);}
    let length=0;const chunks=[];
    for await(const chunk of req){length+=chunk.length;if(length>4096)throw new RoomError('BODY_TOO_LARGE','请求内容过长。',413);chunks.push(chunk);}
    try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}
    catch(_){throw new RoomError('INVALID_JSON','请求内容不正确。',400);}
  }
  function intent(req,input,scope,run) {
    const key=req.headers['idempotency-key'];
    if(typeof key!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw new RoomError('INTENT_REQUIRED','缺少有效的操作编号，请刷新后重试。',400);
    const id=scope+':'+key,hash=crypto.createHash('sha256').update(req.method+' '+req.url+' '+JSON.stringify(input)).digest('hex');
    const cached=intents.get(id);
    if(cached){if(cached.hash!==hash)throw new RoomError('INTENT_CONFLICT','同一操作编号不能提交不同内容。',409);return cached.value;}
    if(intents.size>=10000)throw new RoomError('SERVER_BUSY','服务繁忙，请稍后重试。',503);
    const value=run();intents.set(id,{hash,value,date:Date.now()});return value;
  }
  function waitForRoom(req,res,code,token,after) {
    const view=store.view(code,token);
    if(view.revision!==after||view.status==='closed')return Promise.resolve(view);
    if(waiters>=400)throw new RoomError('SERVER_BUSY','连接较多，正在重试。',503);
    if((waitsPerSeat.get(token)||0)>=2)throw new RoomError('MULTIPLE_WINDOWS','房间已在多个窗口打开，请关闭多余窗口。',409);
    return new Promise(resolve=>{
      waiters++;waitsPerSeat.set(token,(waitsPerSeat.get(token)||0)+1);let timer,settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);store.off('change',changed);res.off('close',finish);pendingWaits.delete(finish);waiters--;const count=(waitsPerSeat.get(token)||1)-1;if(count)waitsPerSeat.set(token,count);else waitsPerSeat.delete(token);try{resolve(res.destroyed?null:store.view(code,token));}catch(_){resolve(null);}};
      const changed=changedCode=>{if(changedCode===code)finish();};
      pendingWaits.add(finish);store.on('change',changed);res.on('close',finish);timer=setTimeout(finish,20000);
      // Recheck after subscribing so a revision cannot be missed.
      if(store.view(code,token).revision!==after)finish();
    });
  }
  const server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},async(req,res)=>{
    security(res);
    try{
      const url=requestUrl(req),route=url.pathname,token=cookieToken(req);
      if(req.method==='GET'&&(route==='/'||route==='/index.html')){
        const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
        const hashes=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match=>"'sha256-"+crypto.createHash('sha256').update(match[1]).digest('base64')+"'").join(' ');
        security(res,hashes);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;
      }
      if(req.method==='GET'&&route==='/favicon.ico'){res.writeHead(204);res.end();return;}
      if(req.method==='GET'&&route==='/api/info'){json(res,200,{online:true,ttlSeconds:Math.round(store.ttlMs/1000),...sharing(req)});return;}
      if(req.method==='GET'&&route==='/api/session'){
        const membership=store.sessions.get(token);if(membership)store.touch(membership.code,token);
        json(res,200,{room:decorate(req,store.session(token))});return;
      }
      const roomRoute=route.match(/^\/api\/rooms\/([A-Za-z0-9]{1,16})(?:\/(members|actions))?$/);
      if(req.method==='GET'&&roomRoute&&!roomRoute[2]){
        const code=roomRoute[1].toUpperCase();store.touch(code,token);
        const after=Number(url.searchParams.get('after')||0);
        if(!Number.isInteger(after)||after<0)throw new RoomError('INVALID_REVISION','无效的同步版本。',422);
        const view=url.searchParams.get('wait')==='1'?await waitForRoom(req,res,code,token,after):store.view(code,token);
        if(view)json(res,200,{room:decorate(req,view)});return;
      }
      if(req.method!=='POST')throw new RoomError('NOT_FOUND','没有这个页面或接口。',404);
      const origin=req.headers.origin;
      if(origin&&origin!==url.origin&&origin!==published?.origin)throw new RoomError('ORIGIN_REJECTED','不允许从其他站点执行房间操作。',403);
      if(req.headers['sec-fetch-site']==='cross-site')throw new RoomError('ORIGIN_REJECTED','请从游戏页面操作。',403);
      const input=await body(req);
      if(route==='/api/rooms'){
        throttle(req,'create');
        const member=intent(req,input,clientAddress(req)+':create',()=>store.create(input,token));
        res.setHeader('Set-Cookie',cookie(member.token));json(res,201,{room:decorate(req,store.view(member.code,member.token))});return;
      }
      if(roomRoute&&roomRoute[2]==='members'){
        throttle(req,'join');const code=roomRoute[1].toUpperCase();
        const member=intent(req,input,clientAddress(req)+':join',()=>store.join(code,token));
        res.setHeader('Set-Cookie',cookie(member.token));json(res,201,{room:decorate(req,store.view(member.code,member.token))});return;
      }
      if(roomRoute&&roomRoute[2]==='actions'){
        throttle(req,'action');const code=roomRoute[1].toUpperCase();store.authorize(code,token);
        intent(req,input,token,()=>{store.action(code,token,input);return true;});
        if(input.type==='leave')res.setHeader('Set-Cookie',cookie(''));
        json(res,200,{room:decorate(req,store.view(code,token))});return;
      }
      throw new RoomError('NOT_FOUND','没有这个接口。',404);
    }catch(error){
      if(error instanceof RoomError)json(res,error.status,{error:{code:error.code,message:error.message}});
      else{console.error('Request failed:',error.name);json(res,500,{error:{code:'SERVER_ERROR',message:'服务暂时遇到问题，请稍后重试。'}});}
    }
  });
  const ticker=setInterval(()=>{
    store.tick();const now=Date.now();
    for(const[key,value]of intents)if(now-value.date>2*60*60*1000)intents.delete(key);
  },100);ticker.unref();
  return {server,store,async close(){clearInterval(ticker);for(const finish of pendingWaits)finish();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(require.main===module){
  const app=createApp();const port=Number(process.env.PORT||4173),host=process.env.HOST||'0.0.0.0';
  app.server.listen(port,host,()=>{console.log('同词相遇已启动：http://127.0.0.1:'+app.server.address().port);for(const item of networkAddresses())console.log('局域网：http://'+item.address+':'+app.server.address().port);});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{app.close().then(()=>process.exit(0));});
}
module.exports={createApp,networkAddresses};

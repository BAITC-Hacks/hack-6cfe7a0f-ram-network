import {createServer as httpServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createAssistant,validateMessage,AssistantError,DEFAULT_MODEL} from './engine.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const publicFiles=new Set(['index.html','Firebird.html','styles.css','ux.css','community.css','bento.css','app.js','matcher.js','catalog.js','ux.js','community-data.js','community.js','bento.js','assistant.js', 'assistant-local.js','assistant.css','ai-config.json','translations.js','i18n.js']);
const mime={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8'};
['accounts.js','accounts.css','account-translations.js','theme.css','theme.js','guest-store.js','demo-translations.js'].forEach(file=>publicFiles.add(file));
export function createServer({apiKey=process.env.OPENAI_API_KEY||'',model=process.env.FIREBIRD_AI_MODEL||DEFAULT_MODEL,allowedOrigins=(process.env.ALLOWED_ORIGINS||'https://imfrqte.github.io').split(',').map(s=>s.trim()).filter(Boolean),assistant=createAssistant({apiKey,model}),dailyLimit=Number(process.env.AI_DAILY_LIMIT||100),trustProxy=process.env.TRUST_PROXY==='1',now=Date.now}={}){
  if(!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>100000)throw Error('Invalid AI_DAILY_LIMIT');
  if(allowedOrigins.some(value=>{try{const u=new URL(value);return u.origin!==value||!['https:','http:'].includes(u.protocol);}catch{return true;}}))throw Error('ALLOWED_ORIGINS must contain exact origins');
  const sessions=new Map(),rates=new Map();let active=0,day='',spent=0;
  const ttl=60*60*1000,windowMs=10*60*1000;
  function clean(){const at=now();for(const [id,s] of sessions)if(!s.busy&&s.expires<=at)sessions.delete(id);for(const [id,r] of rates)if(at-r.at>windowMs)rates.delete(id);}
  const server=httpServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const send=(status,body)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(!pathname.startsWith('/api/')){
      if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'method_not_allowed'});
      const name=pathname==='/'?'index.html':pathname.slice(1);
      if(!publicFiles.has(name))return send(404,{error:'not_found'});
      try{const bytes=await readFile(resolve(root,name));res.writeHead(200,{'Content-Type':mime[name.split('.').pop()],'Cache-Control':name==='ai-config.json'?'no-store':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);}catch{send(404,{error:'not_found'});}return;
    }
    const origin=req.headers.origin;
    if(origin&&!allowedOrigins.includes(origin))return send(403,{error:'origin_forbidden'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});res.end();return;}
    if(pathname==='/api/assistant/status'&&req.method==='GET')return send(200,{configured:assistant.configured,model:assistant.configured?assistant.model:null});
    if(pathname!=='/api/assistant/message')return send(404,{error:'not_found'});
    if(req.method!=='POST')return send(405,{error:'method_not_allowed'});
    if(!origin)return send(403,{error:'origin_forbidden'});
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return send(415,{error:'invalid_message'});
    let session,acquired=false;const abort=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)abort.abort();});
    try{
      clean();
      const address=trustProxy?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim():req.socket.remoteAddress;
      let rate=rates.get(address);if(!rate){if(rates.size>=5000)throw new AssistantError('busy',503);rate={at:now(),count:0};rates.set(address,rate);}
      if(++rate.count>12){res.setHeader('Retry-After','600');throw new AssistantError('rate_limit',429);}
      let size=0;const parts=[];
      for await(const part of req){size+=part.length;if(size>16384)throw new AssistantError('invalid_message',413);parts.push(part);}
      let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AssistantError('invalid_message');}
      const request=validateMessage(body);
      if(!assistant.configured)throw new AssistantError('not_configured',503);
      let sessionId=request.sessionId;
      if(sessionId){session=sessions.get(sessionId);if(!session)throw new AssistantError('session_expired',409);}
      else{if(sessions.size>=500)throw new AssistantError('busy',503);sessionId=randomBytes(32).toString('base64url');session={history:[],expires:now()+ttl,busy:false};sessions.set(sessionId,session);}
      if(session.busy)throw new AssistantError('busy',409);
      if(active>=3)throw new AssistantError('busy',503);
      const currentDay=new Date(now()).toISOString().slice(0,10);if(day!==currentDay){day=currentDay;spent=0;}
      if(spent>=dailyLimit)throw new AssistantError('daily_limit',429);
      active++;spent++;acquired=true;session.busy=true;
      const result=await assistant.answer({...request,history:session.history,signal:abort.signal});
      if(abort.signal.aborted)return;
      // Only successful turns enter memory. The browser cannot inject assistant/system history.
      session.history.push({role:'user',content:request.message},{role:'assistant',content:result.answer+(result.proposal?'\n[Suggested parameters; applying requires the user button: '+JSON.stringify(result.proposal.query)+']':'')});
      session.history=session.history.slice(-24);
      while(session.history.length>2&&session.history.reduce((n,item)=>n+item.content.length,0)>48000)session.history.splice(0,2);
      session.expires=now()+ttl;
      send(200,{...result,sessionId});
    }catch(error){send(error instanceof AssistantError?error.status:500,{error:error instanceof AssistantError?error.code:'server_error'});}
    finally{if(acquired){active--;session.busy=false;}}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{process.loadEnvFile(resolve(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const port=Number(process.env.PORT||4175),host=process.env.HOST||'127.0.0.1';
  createServer().listen(port,host,()=>console.log(`Firebird assistant server: http://${host}:${port}`));
}

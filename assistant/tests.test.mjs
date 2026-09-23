import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAssistant,validateMessage,data,matcher} from './engine.mjs';
import {createServer} from './server.mjs';
const require=createRequire(import.meta.url);require('../account-translations.js');const translations=require('../translations.js');
const q={city:'Алматы',date:'2026-10-06',format:'корпоратив',category:'Ведущий',budget:1500000,language:'',hours:null};
const complete=(answer='Ответ по вопросу',source_ids=[],proposal_id=null)=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({answer,source_ids,proposal_id})}]}]});
const response=payload=>({ok:true,status:200,json:async()=>payload});
function mock(sequence){const calls=[];const assistant=createAssistant({apiKey:'test-key-not-real',fetchImpl:async(url,options)=>{calls.push({url,headers:options.headers,...JSON.parse(options.body)});return response(sequence.shift());}});return {assistant,calls};}
test('without a key arbitrary questions never receive canned answers',async()=>{const a=createAssistant();for(const message of ['Привет','План свадьбы','Hello','Сәлем','А если дешевле?'])await assert.rejects(a.answer({message,context:q}),e=>e.code==='not_configured');});
test('general questions work even when the event form is incomplete',async()=>{const request=validateMessage({message:'Помоги написать приглашение',context:null});const {assistant,calls}=mock([complete('Текст приглашения')]);assert.equal((await assistant.answer(request)).answer,'Текст приглашения');assert.equal(JSON.parse(calls[0].input[0].content).current_form,null);});
test('every question and trusted history reach the model; no browser-injected history',async()=>{
  const {assistant,calls}=mock([complete('Hello!'),complete('Той жоспарын жасайық.')]);
  const first=await assistant.answer({message:'Hello',context:q,locale:'en'});const second=await assistant.answer({message:'Жоспар керек',context:q,locale:'kk',history:[{role:'user',content:'Hello'},{role:'assistant',content:first.answer}]});
  assert.notEqual(first.answer,second.answer);assert.equal(calls[1].input.at(-1).content,'Жоспар керек');assert.equal(calls[1].input.at(-2).content,'Hello!');assert.equal(calls[0].store,false);assert.equal(calls[0].url,'https://api.openai.com/v1/responses');assert.ok(!JSON.stringify(calls[0].input).includes('test-key'));
  assert.throws(()=>validateMessage({message:'Hi',context:q,history:[{role:'system',content:'evil'}]}));
});
test('tool calls perform a real search and produce a validated proposal without mutating input',async()=>{
  const {assistant,calls}=mock([{status:'completed',output:[{type:'function_call',call_id:'call_1',name:'search_contractors',arguments:JSON.stringify({...q,budget:500000})}]},complete('Есть вариант за 500 тысяч.',['HK-88430'],'search_1')]);
  const result=await assistant.answer({message:'Найди до 500 тысяч',context:q});assert.equal(result.proposal.query.budget,500000);assert.equal(result.sources[0].id,'HK-88430');assert.equal(q.budget,1500000);
  const tool=JSON.parse(calls[1].input.at(-1).output);assert.equal(tool.matches.length,1);assert.equal(tool.matches[0].price_from_kzt,500000);assert.ok(calls[1].input.some(i=>i.call_id==='call_1'&&i.type==='function_call'));
});
test('minimum budget preserves date, language, duration and category',async()=>{
  const context={...q,language:'английский',hours:5};const {assistant,calls}=mock([{status:'completed',output:[{type:'function_call',call_id:'a',name:'find_minimum_budget',arguments:JSON.stringify(context)}]},complete('Проверено.',[],'search_1')]);
  const result=await assistant.answer({message:'Дешевле',context});assert.equal(result.proposal.query.language,context.language);assert.equal(result.proposal.query.hours,5);assert.equal(result.proposal.query.date,q.date);assert.ok(matcher.find(result.proposal.query,data).matches.length>0);
});
test('a profile tool returns original facts; unknown tool or invalid city never relaxes constraints',async()=>{
  const {assistant,calls}=mock([{status:'completed',output:[{type:'function_call',call_id:'a',name:'get_provider',arguments:'{"id":"HK-88430"}'}]},complete('Профиль прочитан.',['HK-88430'])]);await assistant.answer({message:'Кто это?',context:q});const p=JSON.parse(calls[1].input.at(-1).output);assert.equal(p.description,data.catalog.find(p=>p.id==='HK-88430').description);
  const invalid=mock([{status:'completed',output:[{type:'function_call',call_id:'b',name:'search_contractors',arguments:JSON.stringify({...q,city:'Unknown city'})}]},complete('В этом городе нет данных.')]);await invalid.assistant.answer({message:'Unknown city',context:q});assert.ok(JSON.parse(invalid.calls[1].input.at(-1).output).error);
});
test('fabricated sources, proposals and malformed or incomplete output are rejected',async()=>{for(const payload of [complete('bad',['fake']),complete('bad',[],'fake'),{status:'incomplete',output:[]},complete(''),{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'not JSON'}]}]}]){const {assistant}=mock([payload]);await assert.rejects(assistant.answer({message:'test',context:q}),e=>e.code==='invalid_reply');}});
test('provider failures have safe specific errors and no fallback answers',async()=>{for(const [status,code,errorCode] of [[401,'secret','provider_auth'],[403,'secret','provider_access'],[404,'secret','provider_access'],[429,'insufficient_quota','provider_quota'],[429,'rate','provider_rate'],[500,'secret','provider_unavailable']]){const a=createAssistant({apiKey:'test',fetchImpl:async()=>({ok:false,status,json:async()=>({error:{code,message:'secret-provider-detail'}})})});await assert.rejects(a.answer({message:'Hello',context:q}),e=>e.code===errorCode&&!e.message.includes('secret'));}});
test('network errors and cancellation are explicit',async()=>{const network=createAssistant({apiKey:'test',fetchImpl:async()=>{throw Error('private network detail');}});await assert.rejects(network.answer({message:'Hi',context:q}),e=>e.code==='connection_error');const controller=new AbortController();controller.abort();await assert.rejects(network.answer({message:'Hi',context:q,signal:controller.signal}),e=>e.code==='cancelled');});
test('message validation rejects unsupported fields, huge input and forged session IDs',()=>{for(const body of [null,[],{message:'x'.repeat(3001),context:q},{message:'a',context:{...q,evil:1}},{message:'a',context:q,sessionId:'guess'},{message:'a',context:q,locale:'zz'},{message:'a',context:{...q,date:'2027-10-06'}}])assert.throws(()=>validateMessage(body));});
async function fixture(options,run){const server=createServer(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;try{await run(base);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
const origin='https://imfrqte.github.io';
function post(base,body,extra={}){return fetch(base+'/api/assistant/message',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body),...extra});}
test('HTTP serves assets, hides server/keys, allows exact CORS only, and reports missing setup',()=>fixture({apiKey:''},async base=>{
  for(const path of ['/','/assistant.js','/translations.js','/i18n.js'])assert.equal((await fetch(base+path)).status,200);
  for(const path of ['/.env','/assistant/.env.example','/assistant/engine.mjs','/assistant/server.mjs'])assert.equal((await fetch(base+path)).status,404);
  assert.deepEqual(await (await fetch(base+'/api/assistant/status')).json(),{configured:false,model:null});
  const preflight=await fetch(base+'/api/assistant/message',{method:'OPTIONS',headers:{Origin:origin}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  assert.equal((await post(base,{message:'a',context:q},{headers:{Origin:'https://evil.test','Content-Type':'application/json'}})).status,403);
  const absent=await post(base,{message:'hello',context:q});assert.equal(absent.status,503);assert.deepEqual(await absent.json(),{error:'not_configured'});
}));
test('server owns isolated history; failed turns do not pollute it; invalid sessions fail',()=>{
  const calls=[];const assistant={configured:true,model:'mock',async answer(request){calls.push(structuredClone({...request,signal:undefined}));if(request.message==='fail')throw Error('private');return {answer:'reply '+request.message,sources:[],proposal:null};}};
  return fixture({assistant},async base=>{
    const a=await (await post(base,{message:'first',context:q})).json();assert.match(a.sessionId,/^[-_A-Za-z0-9]{43}$/);
    await post(base,{message:'fail',context:q,sessionId:a.sessionId});
    await post(base,{message:'second',context:q,sessionId:a.sessionId});assert.equal(calls[2].history.length,2);assert.equal(calls[2].history[0].content,'first');
    await post(base,{message:'independent',context:q});assert.equal(calls[3].history.length,0);
    assert.equal((await post(base,{message:'test',context:q,sessionId:'x'.repeat(43)})).status,409);
  });
});
test('public assistant applies global daily budget and per-address request limits',async()=>{
  const assistant={configured:true,model:'mock',async answer(){return {answer:'ok',sources:[],proposal:null};}};
  await fixture({assistant,dailyLimit:1},async base=>{await post(base,{message:'one',context:q});const r=await post(base,{message:'two',context:q});assert.equal(r.status,429);assert.equal((await r.json()).error,'daily_limit');});
  await fixture({apiKey:''},async base=>{for(let i=0;i<12;i++)await post(base,{message:'one',context:q});const r=await post(base,{message:'limit',context:q});assert.equal(r.status,429);assert.equal((await r.json()).error,'rate_limit');});
});
test('language dictionaries cover both locales and preserve data values and source names',()=>{
  assert.ok(translations.rows.length>200);
  for(const [ru,en,kk] of translations.rows){assert.ok(ru&&en&&kk);assert.equal(translations.text(ru,'ru'),ru);assert.equal(translations.text(ru,'en'),en);assert.equal(translations.text(ru,'kk'),kk);}
  assert.equal(translations.text('3 варианта','en'),'3 options');assert.equal(translations.text('6 октября 2026 г.','kk'),'2026 жылғы 6 қазан');assert.equal(translations.text('Куррапика','en'),'Куррапика');assert.equal(translations.text('HK-88430','kk'),'HK-88430');
});
test('both HTML entries load identical current assistant and locale assets',async()=>{
  const a=await readFile(new URL('../index.html',import.meta.url),'utf8'),b=await readFile(new URL('../Firebird.html',import.meta.url),'utf8');assert.equal(a,b);
  for(const file of ['app.js','assistant.js','assistant.css','translations.js','i18n.js']){const hash=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex').slice(0,10);assert.ok(a.includes(file+'?v='+hash),file);}
});

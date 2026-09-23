(function(){
  'use strict';
  const data=window.FirebirdData,matcher=window.FirebirdMatcher;
  const $=id=>document.getElementById(id),form=$('brief-form'),dialog=$('details-dialog');
  const money=value=>new Intl.NumberFormat('ru-RU').format(value)+' ₸';
  const dateText=value=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(value+'T12:00:00'));
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cap=s=>s[0].toUpperCase()+s.slice(1);
  const plural=n=>n===1?'1 вариант':n===0?'0 вариантов':`${n} варианта`;
  let currentResult;
  const examples={
    dense:{city:'Алматы',date:'2026-10-06',format:'корпоратив',category:'Ведущий',budget:1500000,language:'',hours:null},
    rare:{city:'Алматы',date:'2026-10-04',format:'свадьба',category:'Флорист',budget:500000,language:'',hours:8},
    empty:{city:'Алматы',date:'2026-12-26',format:'корпоратив',category:'Ведущий',budget:100000,language:'',hours:null},
    absent:{city:'Астана',date:'2026-11-14',format:'свадьба',category:'Декоратор',budget:3000000,language:'',hours:null},
    venue:{city:'Алматы',date:'2026-11-14',format:'свадьба',category:'Банкетный зал',budget:6000000,language:'',hours:6}
  };
  function fillOptions(id,values,optional=false){$(id).innerHTML=(optional?'<option value="">Любой</option>':'')+values.map(v=>`<option value="${esc(v)}">${esc(cap(v))}</option>`).join('');}
  fillOptions('city',data.cities);fillOptions('format',data.formats);fillOptions('category',data.categories);fillOptions('language',data.languages,true);
  $('catalog-count').textContent=data.catalog.length;
  function setForm(q){for(const key of ['city','date','format','category','budget','language','hours'])$(key).value=q[key]??'';}
  function readQuery(){return {city:$('city').value,date:$('date').value,format:$('format').value,category:$('category').value,budget:$('budget').value===''?NaN:Number($('budget').value),language:$('language').value,hours:$('hours').value===''?null:Number($('hours').value)};}
  function syncPresets(){document.querySelectorAll('[data-budget]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.budget)===Number($('budget').value))));}
  function markChanged(){syncPresets();$('change-hint').hidden=false;$('results').classList.add('is-stale');$('results-title').textContent='Подборка по предыдущему запросу';}
  function provenance(p){return `<span class="source-tag ${p.synthetic?'synthetic':''}">${p.synthetic?'Синтетический · организаторы':'Анонимизированный профиль'}</span>${p.city_imputed?'<span class="data-warning">Город заполнен при подготовке</span>':''}${p.price_imputed?'<span class="data-warning">Цена заполнена при подготовке</span>':''}`;}
  function countReason(result){
    if(result.poolSize===0)return `В городе «${result.query.city}» нет профилей категории «${result.query.category}».`;
    const parts=Object.entries(result.counts).filter(([,n])=>n>0).map(([key,n])=>`${matcher.labels[key]}: ${n}`);
    return `В городе и категории — ${result.poolSize}, прошли все условия — ${result.totalMatches}. ${result.totalMatches<3?'Меньше трёх, потому что '+(result.excluded.length?'остальные не проходят условия.':'в городе мало профилей этой категории.'):result.totalMatches>3?'Показаны первые три по правилам ранжирования.':''}${parts.length?' Причины исключения: '+parts.join('; ')+'. Причины могут пересекаться.':''}`;
  }
  function emptyMarkup(r){
    if(r.outcome==='no_category')return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌕</span><h3>В этом городе такой категории нет</h3><p>В каталоге нет профилей «${esc(r.query.category)}» для города «${esc(r.query.city)}». Изменение даты или бюджета здесь не поможет.</p><p>Выберите другой город или категорию.</p></div>`;
    const c=r.counts,hints=[];
    if(c.busy)hints.push(`На ${esc(dateText(r.query.date))} заняты ${c.busy} из ${r.poolSize} профилей. Можно проверить другую дату.`);
    if(r.minimumPrice!==null)hints.push(`При остальных выбранных условиях начальная цена доступных вариантов — от <strong>${money(r.minimumPrice)}</strong>. Это не окончательная смета.`);
    else if(c.budget)hints.push('Часть начальных цен выше бюджета. Одного повышения бюджета может быть недостаточно: проверьте остальные причины ниже.');
    if(c.format)hints.push('Некоторые профили не берут выбранный формат.');
    if(c.language)hints.push('Не у всех профилей есть выбранный язык работы.');
    if(c.hours)hints.push('У части профилей лимит присутствия меньше длительности мероприятия.');
    if(c.priceUnknown)hints.push('Для части профилей не указана начальная цена.');
    return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌕</span><h3>Кандидаты есть, но условия не совпали</h3><p>В городе найдено ${r.poolSize} профилей этой категории. Ни один не прошёл все ограничения.</p><ul>${hints.map(h=>`<li>${h}</li>`).join('')}</ul></div>`;
  }
  function render(result){
    const delta=matcher.calendarChange(currentResult,result);currentResult=result;
    const q=result.query,n=result.matches.length;
    $('results-title').textContent=result.outcome==='matched'?'Подобрали для вашего события':result.outcome==='no_category'?'В городе нет этой категории':'Никто не прошёл условия';
    $('result-count').textContent=plural(n);
    $('query-summary').textContent=`${q.city} · ${dateText(q.date)} · ${cap(q.format)} · ${q.category} · до ${money(q.budget)}${q.language?' · '+q.language:''}${q.hours!==null?' · '+q.hours+' ч':''}`;
    $('calendar-change').textContent=delta;$('calendar-change').hidden=!delta;
    $('results').innerHTML=n?result.matches.map((m,i)=>{
      const p=m.provider,initials=p.anon_name.split(' ').slice(0,2).map(x=>x[0]).join('');
      const conditions=[`Формат: ${q.format}`,`Начальная цена в бюджете`];
      if(q.language)conditions.push(`Язык: ${q.language}`);
      if(q.hours!==null)conditions.push(p.max_hours===null?'Без лимита присутствия':`${p.max_hours} ч при запросе ${q.hours} ч`);
      return `<article class="contractor ${i===0?'best':''}" aria-labelledby="name-${esc(p.id)}"><div class="card-kicker"><span>ВАРИАНТ 0${i+1}</span><span class="available"><span aria-hidden="true">●</span> Не занят по календарю</span></div><div class="card-top"><div class="avatar tone${i}" aria-hidden="true">${esc(initials)}</div><div class="card-identity"><h3 id="name-${esc(p.id)}">${esc(p.anon_name)}</h3><p class="card-subtitle">${esc(q.category)} <span>·</span> ${esc(p.city)}</p></div><div class="price"><small>Начальная стоимость</small><strong><span>от</span> ${money(p.price_from_kzt)}</strong><small>за мероприятие</small></div></div><div class="fit-reasons">${conditions.map(c=>`<span><b aria-hidden="true">✓</b> ${esc(c)}</span>`).join('')}</div><div class="evidence-box"><h4><span aria-hidden="true">✳</span> Почему в подборке</h4><blockquote>«${esc(m.evidence.excerpt)}${m.evidence.clipped?'…':''}»</blockquote><span class="evidence-source">Из описания подрядчика · ${esc(p.id)}</span></div><div class="provenance">${provenance(p)}</div><div class="card-bottom"><p class="price-note">Итоговую стоимость нужно уточнить.<br><span>${esc(dateText(q.date))} · календарь датасета</span></p><button type="button" class="details-button" data-provider="${esc(p.id)}" aria-label="Подробнее: ${esc(p.anon_name)}">Смотреть профиль <span aria-hidden="true">↗</span></button></div></article>`;
    }).join(''):emptyMarkup(result);
    $('exclusion-note').textContent=countReason(result);
    $('excluded-details').hidden=result.excluded.length===0;
    $('excluded-list').innerHTML=result.excluded.map(p=>`<li><strong>${esc(p.name)}</strong> <span class="source-id">${esc(p.id)}</span>: ${p.reasons.map(key=>esc(matcher.labels[key])).join('; ')}.</li>`).join('');
    $('results-status').textContent=$('results-title').textContent+'. '+plural(n)+'.';
    $('results').classList.remove('is-stale');$('change-hint').hidden=true;$('form-error').hidden=true;syncPresets();
    document.dispatchEvent(new CustomEvent('firebird:results',{detail:result}));
  }
  function run(query){const result=matcher.find(query,data);render(result);return result;}
  form.addEventListener('submit',event=>{event.preventDefault();try{run(readQuery());}catch(error){$('form-error').textContent=error.message;$('form-error').hidden=false;}});
  form.addEventListener('input',markChanged);form.addEventListener('change',markChanged);
  document.querySelectorAll('[data-budget]').forEach(button=>button.addEventListener('click',()=>{$('budget').value=button.dataset.budget;markChanged();}));
  document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>{const q=examples[button.dataset.example];setForm(q);run(q);document.querySelector('.demo-queries').open=false;document.querySelector('.optional-fields').open=Boolean(q.language||q.hours);}));
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-provider]');if(!button)return;
    const provider=data.catalog.find(item=>item.id===button.dataset.provider);if(!provider)return;
    const m=currentResult.matches.find(item=>item.provider.id===provider.id)||{provider,score:matcher.evidence(provider,currentResult.query,data).terms.length,explanation:'Профиль открыт из избранного. Он может не соответствовать последнему запросу. Проверьте условия и календарь в сравнении избранных.'};
    const p=m.provider,q=currentResult.query;
    $('dialog-content').innerHTML=`<h2 id="dialog-title">${esc(p.anon_name)}</h2><p>${esc(p.city)} · ${esc(p.categories.join(', '))}</p><div class="provenance">${provenance(p)}</div><div class="dialog-price">от ${money(p.price_from_kzt)}</div><p class="price-note">Цена за мероприятие, не почасовая. Итоговая смета неизвестна.</p><h3>Совпадение с запросом</h3><p>${esc(m.explanation)}</p><h3>Данные профиля</h3><dl class="facts"><dt>Форматы</dt><dd>${esc(p.event_formats.join(', '))}</dd><dt>Языки</dt><dd>${esc(p.languages.join(', '))}</dd><dt>Лимит присутствия</dt><dd>${p.max_hours===null?'Не привязан к присутствию':p.max_hours+' ч'}</dd><dt>На выбранную дату</dt><dd>${esc(dateText(q.date))} не входит в busy_dates</dd><dt>Место в подборке</dt><dd>Тематических признаков описания: ${m.score}; затем учитываем заполненные при подготовке поля, цену и ID</dd></dl><h3>Описание из датасета</h3><p class="original-description">${esc(p.description)}</p><p class="source-note">Источник: ${esc(data.source.filename)}, запись ${esc(p.id)}. Календарь только 23.09–31.12.2026. Описания — сведения из предоставленного датасета, не независимая проверка.</p>`;
    // The calendar statement must also be correct for saved profiles outside the results.
    const facts=$('dialog-content').querySelectorAll('.facts dd');
    facts[3].textContent=`${dateText(q.date)}: ${p.busy_dates.includes(q.date)?'занят по календарю датасета':'не занят по календарю датасета'}`;
    if(!currentResult.matches.some(item=>item.provider.id===p.id))facts[4].textContent='Не входит в текущую тройку рекомендаций. Проверьте соответствие запросу в сравнении избранных.';
    document.dispatchEvent(new CustomEvent('firebird:profile',{detail:{provider:p}}));
    dialog.showModal();
    if(button.hasAttribute('data-focus-reviews'))$('profile-reviews')?.focus();
  });
  $('close-dialog').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  document.querySelector('a[href="#method"]').addEventListener('click',()=>{$('method').open=true;});
  window.FirebirdApp={readQuery,applyQuery(input){const q=matcher.validate(input,data);setForm(q);document.querySelector('.optional-fields').open=Boolean(q.language||q.hours);return run(q);}};
  document.addEventListener('firebird:profile',()=>{document.querySelectorAll('.original-description').forEach(p=>{p.lang='ru';const note=document.createElement('p');note.className='original-language-note';note.textContent='Оригинал описания — на русском';p.before(note);});});
  setForm(examples.dense);run(examples.dense);
  if(document.modelContext?.registerTool){
    const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
    const schema={type:'object',properties:{city:{type:'string',enum:data.cities},date:{type:'string',description:'YYYY-MM-DD, от 2026-09-23 до 2026-12-31'},format:{type:'string',enum:data.formats},category:{type:'string',enum:data.categories},budget:{type:'integer',minimum:0,maximum:1000000000},language:{type:'string',enum:['',...data.languages]},hours:{type:['number','null'],exclusiveMinimum:0,maximum:24}},required:['city','date','format','category','budget'],additionalProperties:false};
    try{Promise.resolve(document.modelContext.registerTool({name:'configure_contractor_search',title:'Подобрать подрядчиков',description:'Обновляет форму и подборку по 66 профилям датасета HackAlem. Возвращает до трёх рекомендаций с причинами. Не создаёт бронь.',inputSchema:schema,annotations:{readOnlyHint:false,untrustedContentHint:true},execute(input){const query=matcher.validate(input,data);const result=matcher.find(query,data);setForm(query);render(result);return {outcome:result.outcome,totalMatches:result.totalMatches,matches:result.matches.map(m=>({id:m.provider.id,name:m.provider.anon_name,price_from_kzt:m.provider.price_from_kzt,synthetic:m.provider.synthetic,explanation:m.explanation})),excluded:result.counts};}},{signal:lifecycle.signal})).catch(()=>{});}catch(error){/* Optional API; the form remains available. */}
  }
})();

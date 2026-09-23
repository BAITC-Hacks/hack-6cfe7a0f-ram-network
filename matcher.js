(function(root){
  'use strict';
  const stems={
    'свадьба':['свад','невест','молодож','брак','love story'],
    'той':['той','казах','национ','традиц'],
    'корпоратив':['корпоратив','бизнес','делов','бренд','компан','тимбил'],
    'конференция':['конферен','форум','презентац','спикер','делов'],
    'юбилей':['юбиле','торжеств','семейн','поколен'],
    'день рождения':['день рожден','дня рожден','именин','детск','частн','семейн']
  };
  const labels={busy:'занят на выбранную дату',format:'не берёт этот формат',budget:'начальная цена выше бюджета',language:'нет выбранного языка',hours:'не хватает часов на площадке',priceUnknown:'цена не указана'};
  const money=n=>new Intl.NumberFormat('ru-RU').format(n)+' ₸';
  const dateText=s=>s.split('-').reverse().join('.');
  const normalize=s=>String(s).replace(/\s+/g,' ').trim();
  const lower=s=>normalize(s).toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
  const hits=(text,format)=>stems[format].filter(term=>lower(text).includes(term));
  const serviceTerms=['флорист','цветоч','букет','композиц','сценар','юмор','импровизац','веден','съем','кадр','репертуар','состав','вокал','саксофон','контрабас','декор','монтаж','сценограф','вместим','парков','кейтеринг','оснащен','регистр','церемон','печать','печат','тираж','персонализ','минимальн'];
  function isDate(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const date=new Date(value+'T12:00:00Z');
    return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
  }
  function validate(input,data){
    if(!input||typeof input!=='object')throw new Error('Заполните параметры мероприятия.');
    if(!data.cities.includes(input.city))throw new Error('Выберите город из каталога.');
    if(!data.categories.includes(input.category))throw new Error('Выберите категорию из каталога.');
    if(!data.formats.includes(input.format))throw new Error('Выберите формат мероприятия.');
    if(!isDate(input.date))throw new Error('Укажите корректную дату мероприятия.');
    if(input.date<data.calendarFrom||input.date>data.calendarThrough)throw new Error('Календарь доступен только с 23.09.2026 по 31.12.2026. За пределами этого окна занятость неизвестна.');
    if(typeof input.budget!=='number'||!Number.isInteger(input.budget)||input.budget<0||input.budget>1000000000)throw new Error('Введите целый бюджет от 0 до 1 000 000 000 ₸.');
    const language=input.language??'',hours=input.hours??null;
    if(language!==''&&!data.languages.includes(language))throw new Error('Выберите язык из списка или «Любой».');
    if(hours!==null&&(typeof hours!=='number'||!Number.isFinite(hours)||hours<=0||hours>24))throw new Error('Длительность должна быть больше 0 и не больше 24 часов.');
    return {city:input.city,date:input.date,format:input.format,category:input.category,budget:input.budget,language,hours};
  }
  function failures(p,q){
    const out=[];
    if(p.busy_dates.includes(q.date))out.push('busy');
    if(!p.event_formats.includes(q.format))out.push('format');
    if(!Number.isFinite(p.price_from_kzt)||p.price_from_kzt<0)out.push('priceUnknown');
    else if(p.price_from_kzt>q.budget)out.push('budget');
    if(q.language&&!p.languages.includes(q.language))out.push('language');
    // null means an attendance limit is not applicable, NOT missing availability.
    if(q.hours!==null&&p.max_hours!==null&&p.max_hours<q.hours)out.push('hours');
    return out;
  }
  const cache=new WeakMap();
  function corpusStats(data){
    if(cache.has(data))return cache.get(data);
    const counts=new Map();
    for(const p of data.catalog){for(const word of new Set(lower(p.description).match(/[а-яa-z]{4,}/g)||[]))counts.set(word,(counts.get(word)||0)+1);}
    cache.set(data,counts);return counts;
  }
  function evidence(p,q,data){
    const text=normalize(p.description),stats=corpusStats(data),nameWords=new Set(lower(p.anon_name).split(' '));
    const pieces=text.match(/[^.!?]+[.!?]?/g)||[text];
    const candidates=pieces.map((raw,index)=>{
      const sentence=raw.trim();
      const words=[...new Set(lower(sentence).match(/[а-яa-z]{4,}/g)||[])].filter(w=>!nameWords.has(w));
      const distinctive=words.length?words.reduce((sum,w)=>sum+Math.log((data.catalog.length+1)/((stats.get(w)||0)+1)),0)/Math.sqrt(words.length):0;
      const serviceScore=serviceTerms.filter(term=>lower(sentence).includes(term)).length*4;
      const clientListPenalty=/среди.*клиент|сотрудничали|среди.*партн/i.test(sentence)?14:0;
      const lengthPenalty=Math.max(0,sentence.length-260)/12;
      return {sentence,index,score:hits(sentence,q.format).length*8+serviceScore+distinctive-clientListPenalty-lengthPenalty-(sentence.length<40?12:0)-(/меня зовут|всем привет|приветствую/i.test(sentence)?15:0)};
    }).filter(x=>x.sentence.length>0).sort((a,b)=>b.score-a.score||a.index-b.index);
    let excerpt=candidates[0]?.sentence||text;
    let clipped=false;
    if(excerpt.length>260){let cut=excerpt.lastIndexOf(' ',260);if(cut<100)cut=260;excerpt=excerpt.slice(0,cut);clipped=true;}
    return {excerpt,clipped,terms:hits(text,q.format),sourceField:'description'};
  }
  function explain(p,q,proof){
    const optional=[];
    if(q.language)optional.push(`язык — ${q.language}`);
    if(q.hours!==null)optional.push(p.max_hours===null?'работа не привязана к присутствию':`лимит ${p.max_hours} ч покрывает ваши ${q.hours} ч`);
    const conditions=`На ${dateText(q.date)} свободен по календарю, берёт формат «${q.format}»; цена от ${money(p.price_from_kzt)} при бюджете ${money(q.budget)}${optional.length?'; '+optional.join(', '):''}.`;
    return conditions+' В описании: «'+proof.excerpt+(proof.clipped?'…':'')+'»';
  }
  function find(input,data){
    const q=validate(input,data);
    const pool=data.catalog.filter(p=>p.city===q.city&&p.categories.includes(q.category));
    const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,0]));
    const excluded=[],eligible=[];
    for(const p of pool){
      const reasons=failures(p,q);
      if(reasons.length){reasons.forEach(key=>counts[key]++);excluded.push({id:p.id,name:p.anon_name,reasons});continue;}
      const proof=evidence(p,q,data);
      eligible.push({provider:p,evidence:proof,score:proof.terms.length,explanation:explain(p,q,proof)});
    }
    eligible.sort((a,b)=>b.score-a.score||Number(a.provider.price_imputed)-Number(b.provider.price_imputed)||Number(a.provider.city_imputed)-Number(b.provider.city_imputed)||a.provider.price_from_kzt-b.provider.price_from_kzt||(a.provider.id<b.provider.id?-1:a.provider.id>b.provider.id?1:0));
    const budgetOnly=pool.filter(p=>{const errors=failures(p,q);return errors.length===1&&errors[0]==='budget';});
    return {query:q,outcome:pool.length===0?'no_category':eligible.length===0?'no_matches':'matched',matches:eligible.slice(0,3),totalMatches:eligible.length,poolSize:pool.length,counts,excluded,minimumPrice:budgetOnly.length?Math.min(...budgetOnly.map(p=>p.price_from_kzt)):null};
  }
  function calendarChange(previous,current){
    if(!previous||previous.query.date===current.query.date)return '';
    const a=previous.query,b=current.query;
    if(['city','format','category','budget','language','hours'].some(k=>a[k]!==b[k]))return '';
    const newlyBusy=previous.matches.filter(m=>m.provider.busy_dates.includes(b.date)).map(m=>m.provider.anon_name);
    const newlyFree=current.matches.filter(m=>m.provider.busy_dates.includes(a.date)).map(m=>m.provider.anon_name);
    const parts=[];
    if(newlyBusy.length)parts.push(`На ${dateText(b.date)} заняты: ${newlyBusy.join(', ')}`);
    if(newlyFree.length)parts.push(`Теперь свободны: ${newlyFree.join(', ')}`);
    return parts.length?'Выдача изменилась из-за календаря. '+parts.join('. ')+'.':'Дата изменена: занятость проверена заново, порядок оставшихся кандидатов сохранён по тем же правилам.';
  }
  const api={find,validate,isDate,failures,evidence,calendarChange,labels,normalize};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.FirebirdMatcher=api;
})(globalThis);

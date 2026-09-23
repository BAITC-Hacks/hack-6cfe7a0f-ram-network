(function(){
  'use strict';
  const $=id=>document.getElementById(id),t=s=>window.FirebirdI18n?.text(s)||s;
  const dialog=document.createElement('dialog');dialog.id='ai-dialog';dialog.setAttribute('aria-labelledby','ai-title');
  dialog.innerHTML=`<header class="ai-header"><div><span class="ai-kicker">FIREBIRD ASSISTANT</span><h2 id="ai-title">Помощник для вашего события</h2></div><button type="button" id="ai-close" aria-label="Закрыть помощника">×</button></header><div class="ai-connection"><span id="ai-status" role="status">Проверяем подключение…</span><button type="button" id="ai-refresh">Проверить снова</button></div><p class="ai-context" id="ai-context"></p><div id="ai-messages" role="log" aria-live="polite" aria-relevant="additions" aria-label="История диалога"></div><div id="ai-suggestions"><button type="button" data-ai-prompt="Сравни варианты из текущей подборки. Чем они отличаются?">Сравнить варианты</button><button type="button" data-ai-prompt="Можно ли найти дешевле, сохранив остальные условия?">Найти дешевле</button><button type="button" data-ai-prompt="Помоги составить план подготовки к мероприятию из формы.">План мероприятия</button></div><p id="ai-error" class="ai-error" role="alert" hidden></p><form id="ai-form"><label for="ai-input">Ваш вопрос</label><textarea id="ai-input" rows="3" maxlength="3000" placeholder="Например: а если бюджет 500 тысяч?" disabled></textarea><div class="ai-form-actions"><button type="button" id="ai-clear">Новый диалог</button><button type="button" id="ai-stop" hidden>Остановить</button><button type="submit" id="ai-send" disabled>Отправить</button></div></form><p class="ai-privacy">Локальный помощник по каталогу. Вопросы не отправляются на сервер.</p>`;
  document.body.append(dialog);
  const intro=document.createElement('p');intro.className='ai-intro';intro.textContent='Опишите задачу своими словами. Помощник учтёт параметры формы, поможет сравнить варианты и составить план.';$('ai-messages').before(intro);
  const launcher=document.createElement('button');launcher.id='ai-launcher';launcher.type='button';launcher.setAttribute('aria-controls','ai-dialog');launcher.setAttribute('aria-haspopup','dialog');launcher.innerHTML='<span aria-hidden="true">✳</span> ИИ-помощник';document.body.append(launcher);
  let configured=false,busy=false;
  const localCopy={ru:{status:'Работает в браузере · без API-ключей',launcher:'Помощник',privacy:'Локальный подбор по правилам, не нейросеть. Вопросы не отправляются на сервер. История хранится только до обновления страницы. Помощник поддерживает запросы по каталогу, а не произвольные темы.',intro:'Сравню варианты из формы, найду дешевле или предложу план. Попробуйте: «бюджет 500 тысяч» или «в Астане 14.11.2026». Новые условия применяются только по вашей кнопке.',unavailable:'Локальный помощник не загрузился. Обновите страницу.'},kk:{status:'Браузерде жұмыс істейді · API кілті қажет емес',launcher:'Көмекші',privacy:'Нейрожелі емес, ережелерге негізделген жергілікті көмекші. Сұрақтар серверге жіберілмейді; тарих бет жаңартылғанша сақталады. Тек каталог бойынша сұрақтарды қолдайды.',intro:'Формадағы нұсқаларды салыстырамын, арзанырақ нұсқаны немесе жоспар ұсынамын. «Бюджет 500 мың» деп жазыңыз. Жаңа шарттар тек батырманы басқанда қолданылады.',unavailable:'Жергілікті көмекші жүктелмеді. Бетті жаңартыңыз.'},en:{status:'Runs in your browser · no API keys',launcher:'Assistant',privacy:'A local rule-based catalog helper, not a neural network. Questions are not sent to a server. History lasts until you reload the page. Supports catalog questions, not arbitrary topics.',intro:'Compare the options in your form, find cheaper ones or get a plan. Try “budget 500k” or “Astana on 2026-11-14”. New conditions are applied only when you press Apply.',unavailable:'The local assistant did not load. Reload the page.'}};
  const copy=()=>localCopy[window.FirebirdI18n?.locale||'ru']||localCopy.ru;
  for(const node of [intro,launcher,$('ai-status'),dialog.querySelector('.ai-privacy')])node.setAttribute('data-i18n-skip','');
  $('ai-refresh').remove();$('ai-stop').remove();
  function error(){ $('ai-error').textContent=t('Введите вопрос длиной до 3000 символов.');$('ai-error').hidden=false; }
  function sync(){
    configured=Boolean(window.FirebirdLocalAssistant&&window.FirebirdApp&&window.FirebirdData&&window.FirebirdMatcher);
    $('ai-input').disabled=!configured||busy;$('ai-send').disabled=!configured||busy;$('ai-clear').disabled=busy;
    document.querySelectorAll('[data-ai-prompt]').forEach(b=>b.disabled=!configured||busy);
    $('ai-input').placeholder=t('Например: а если бюджет 500 тысяч?');
    $('ai-status').textContent=configured?copy().status:copy().unavailable;
    intro.textContent=copy().intro;dialog.querySelector('.ai-privacy').textContent=copy().privacy;
    launcher.textContent='✳ '+copy().launcher;dialog.classList.toggle('ai-offline',!configured);
  }
  function context(){
    const q=window.FirebirdApp.readQuery();
    $('ai-context').textContent=`${q.city} · ${q.category} · ${q.date} · ${Number.isFinite(q.budget)?q.budget.toLocaleString('ru-RU'):'—'} ₸`;
    return q;
  }
  function bubble(role,text){const article=document.createElement('article');article.className='ai-message ai-'+role;const label=document.createElement('strong');label.textContent=t(role==='user'?'Вы':'Firebird');const content=document.createElement('div');content.className='ai-message-text';content.textContent=text;article.append(label,content);$('ai-messages').append(article);while($('ai-messages').children.length>50)$('ai-messages').firstElementChild.remove();article.scrollIntoView({block:'nearest'});return article;}
  function showResult(result){
    const article=bubble('assistant',result.answer);
    if(Array.isArray(result.sources)&&result.sources.length){const list=document.createElement('div');list.className='ai-sources';
      for(const source of result.sources.slice(0,3)){if(!window.FirebirdData.catalog.some(p=>p.id===source.id))continue;const button=document.createElement('button');button.type='button';button.dataset.provider=source.id;button.textContent=source.name+' · '+t('от')+' '+Number(source.price_from_kzt).toLocaleString()+' ₸';button.addEventListener('click',()=>dialog.close());list.append(button);}article.append(list);}
    if(result.proposal){
      try{const q=window.FirebirdMatcher.validate(result.proposal.query,window.FirebirdData);const block=document.createElement('div');block.className='ai-proposal';
        const summary=document.createElement('p');summary.textContent=[q.city,q.category,q.format,q.date,q.budget.toLocaleString()+' ₸',q.language,q.hours===null?'':q.hours+' '+t('ч')].filter(Boolean).map(t).join(' · ');
        const button=document.createElement('button');button.type='button';button.textContent=t('Применить параметры');button.addEventListener('click',()=>{window.FirebirdApp.applyQuery(q);button.disabled=true;button.textContent=t('Применено');context();});block.append(summary,button);article.append(block);
      }catch{/* An invalid proposal cannot mutate the form. */}
    }
    article.scrollIntoView({block:'nearest'});
  }
  function send(){
    const message=$('ai-input').value.trim();if(!message||busy||!configured)return;
    if(message.length>3000){error('invalid_message');return;}
    busy=true;sync();$('ai-error').hidden=true;
    try{
      const result=window.FirebirdLocalAssistant.reply({message,context:context(),locale:window.FirebirdI18n?.locale||'ru'},window.FirebirdData,window.FirebirdMatcher);
      if(typeof result.answer!=='string')throw Error('invalid_reply');
      bubble('user',message);showResult(result);$('ai-input').value='';
    }catch{$('ai-error').textContent=t('Проверьте параметры мероприятия в форме перед отправкой.');$('ai-error').hidden=false;}
    finally{busy=false;sync();if(dialog.open&&configured)$('ai-input').focus();}
  }
  launcher.addEventListener('click',()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());context();sync();dialog.showModal();$('ai-input').focus();});
  $('ai-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>launcher.focus());
  $('ai-form').addEventListener('submit',e=>{e.preventDefault();send();});
  $('ai-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}});
  $('ai-clear').addEventListener('click',()=>{$('ai-messages').replaceChildren();$('ai-error').hidden=true;$('ai-input').focus();});
  document.querySelectorAll('[data-ai-prompt]').forEach(b=>b.addEventListener('click',()=>{$('ai-input').value=t(b.dataset.aiPrompt);send();}));
  document.addEventListener('firebird:results',()=>context());document.addEventListener('firebird:locale',()=>{context();sync();});
  sync();
})();

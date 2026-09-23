(function(){
  'use strict';
  const key='firebird:locale:v1',supported=['ru','kk','en'];
  let locale='ru',saved=null;try{saved=localStorage.getItem(key);}catch{}
  const requested=new URL(location.href).searchParams.get('lang');locale=supported.includes(requested)?requested:supported.includes(saved)?saved:'ru';
  const memories=new WeakMap();const skip='script,style,textarea,.original-description,blockquote,.review-card>p,.review-author h4,.card-identity h3,.ai-message-text,.account-order-wishes,.account-summary,[data-i18n-skip]';
  // Apply only rendered text/labels. Form values, record IDs and user-authored content stay intact.
  function translateNode(node){
    if(!node.parentElement||node.parentElement.closest(skip))return;
    const old=memories.get(node),current=node.nodeValue;
    const source=old&&current===old.rendered?old.source:current;
    const rendered=window.FirebirdTranslations.text(source,locale);
    memories.set(node,{source,rendered});if(current!==rendered)node.nodeValue=rendered;
  }
  const attributes=new WeakMap();
  function translateElement(element){
    if(element.matches('script,style,[data-i18n-skip]'))return;
    let memory=attributes.get(element);if(!memory){memory={};attributes.set(element,memory);}
    for(const attr of ['aria-label','title','placeholder']){const current=element.getAttribute(attr);if(current===null)continue;const old=memory[attr],source=old&&old.rendered===current?old.source:current;const rendered=window.FirebirdTranslations.text(source,locale);memory[attr]={source,rendered};if(current!==rendered)element.setAttribute(attr,rendered);}
  }
  let pending=false;
  function refresh(){
    observer.disconnect();
    document.documentElement.lang=locale;document.title=locale==='en'?'Firebird — find event contractors':locale==='kk'?'Firebird — мердігерлерді іріктеу':'Firebird — подбор подрядчиков';
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())translateNode(node);
    document.querySelectorAll('[aria-label],[title],[placeholder]').forEach(translateElement);
    document.querySelectorAll('.locale-switch button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.locale===locale)));
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','title','placeholder']});pending=false;
  }
  const observer=new MutationObserver(()=>{if(!pending){pending=true;queueMicrotask(refresh);}});
  const controls=document.createElement('div');controls.className='locale-switch';controls.setAttribute('role','group');controls.setAttribute('aria-label','Язык интерфейса');
  controls.innerHTML='<button type="button" data-locale="ru" lang="ru">RU</button><button type="button" data-locale="kk" lang="kk">KZ</button><button type="button" data-locale="en" lang="en">EN</button>';document.querySelector('.topbar').append(controls);
  function setLocale(next){if(!supported.includes(next))return;locale=next;try{localStorage.setItem(key,locale);const url=new URL(location.href);url.searchParams.set('lang',locale);history.replaceState(null,'',url);}catch{}document.dispatchEvent(new CustomEvent('firebird:locale',{detail:{locale}}));refresh();}
  controls.addEventListener('click',e=>{const button=e.target.closest('[data-locale]');if(button)setLocale(button.dataset.locale);});
  window.FirebirdI18n={get locale(){return locale;},text:source=>window.FirebirdTranslations.text(source,locale),setLocale,refresh};
  refresh();
})();

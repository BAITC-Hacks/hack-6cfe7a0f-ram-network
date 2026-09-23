/* Bento interactions. Motion is optional and never controls the search outcome. */
(function() {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.FirebirdData, community = window.FirebirdCommunity;
  const esc = community.escapeHTML;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionKey = 'firebird:motion:v1';
  let userMotion = true;
  try { userMotion = localStorage.getItem(motionKey) !== 'off'; } catch (_) {}
  let motion = userMotion && !reducedMotion.matches;
  const animations = new Set();
  document.querySelector('.topbar').insertAdjacentHTML('beforeend','<button type="button" id="motion-toggle" class="motion-toggle" aria-pressed="true" aria-label="Анимации включены"><span aria-hidden="true">◌</span><span class="motion-label">Анимации</span><span id="motion-state">Вкл</span></button>');
  function animate(element, frames, options = {}) {
    if (!motion || !element?.animate) return;
    const animation = element.animate(frames, {duration:500,easing:'cubic-bezier(.22,1,.36,1)',...options});
    animations.add(animation);
    animation.finished.catch(()=>{}).finally(()=>animations.delete(animation));
  }
  function refreshMotion() {
    motion = userMotion && !reducedMotion.matches;
    document.documentElement.classList.toggle('motion-off', !motion);
    $('motion-toggle').setAttribute('aria-pressed',String(motion));
    $('motion-toggle').setAttribute('aria-label',motion?'Выключить анимации':'Включить анимации');
    $('motion-toggle').disabled = reducedMotion.matches;
    $('motion-toggle').title = reducedMotion.matches ? 'Анимации отключены системной настройкой уменьшенного движения' : 'Плавные появления и декоративная анимация';
    $('motion-state').textContent = motion?'Вкл':'Выкл';
    if (!motion) { animations.forEach(a=>a.cancel()); resetTilts(); }
    updateCanvasLoop();
  }
  $('motion-toggle').addEventListener('click',()=>{
    userMotion=!userMotion;
    try { localStorage.setItem(motionKey,userMotion?'on':'off'); } catch (_) {}
    refreshMotion();
  });
  reducedMotion.addEventListener('change',refreshMotion);
  $('bento-profile-count').textContent = data.catalog.length;
  $('bento-category-count').textContent = data.categories.length;
  $('hero-avatar-stack').innerHTML = ['HK-88430','HK-44733','HK-75012'].map(community.avatar).join('');

  function renderPreview(result) {
    const q=result.query,date=new Date(q.date+'T12:00:00');
    $('hero-day').textContent=String(date.getDate()).padStart(2,'0');
    // Use the genitive month after the separately displayed day.
    $('hero-month').textContent=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(date).replace(/^\d+\s*/,'').replace(' г.','');
    $('hero-weekday').textContent=new Intl.DateTimeFormat('ru-RU',{weekday:'long'}).format(date);
    $('previous-date').disabled=q.date<=data.calendarFrom;
    $('next-date').disabled=q.date>=data.calendarThrough;
    $('hero-team-caption').textContent=`${q.city} · ${q.category} · ${q.date.split('-').slice(1).reverse().join('.')}`;
    $('hero-team').innerHTML=result.matches.length ? result.matches.map(m=>`<button type="button" class="hero-person" data-provider="${esc(m.provider.id)}" aria-label="Открыть профиль: ${esc(m.provider.anon_name)}">${community.avatar(m.provider.id)}<span>${esc(m.provider.anon_name)}<small>${esc(q.category)}</small></span><b aria-hidden="true">↗</b></button>`).join('') : '<p class="hero-empty">В этом запросе пока нет совпадений. Попробуйте другую дату или измените условия в форме ниже.</p>';
    animate($('hero-team'),[{opacity:.3,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:380});
  }
  function readQuery() {return {city:$('city').value,date:$('date').value,format:$('format').value,category:$('category').value,budget:Number($('budget').value),language:$('language').value,hours:$('hours').value===''?null:Number($('hours').value)};}
  let lastQuery = window.FirebirdMatcher.validate(readQuery(),data);
  function stepDate(direction) {
    // The mini calendar belongs to the last successful search, not a half-edited form.
    const date=new Date(lastQuery.date+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+direction);
    const next=date.toISOString().slice(0,10);
    if(next<data.calendarFrom||next>data.calendarThrough) return;
    // Preserve current draft fields; require their validity before submitting a new date.
    $('date').value=next;
    $('date').dispatchEvent(new Event('input',{bubbles:true}));
    $('brief-form').requestSubmit();
  }
  $('previous-date').addEventListener('click',()=>stepDate(-1));
  $('next-date').addEventListener('click',()=>stepDate(1));
  document.querySelectorAll('[data-scenario]').forEach(button=>button.addEventListener('click',()=>{
    document.querySelector(`[data-example="${button.dataset.scenario}"]`).click();
    $('selection').focus({preventScroll:true});
    $('selection').scrollIntoView({block:'start',behavior:motion?'smooth':'instant'});
  }));
  const revealed = new WeakSet();
  const revealObserver = new IntersectionObserver(entries=>entries.forEach(entry=>{
    if (!entry.isIntersecting) return;
    revealObserver.unobserve(entry.target);
    if(revealed.has(entry.target))return;
    revealed.add(entry.target);
    animate(entry.target,[{opacity:.35,transform:'translateY(18px)'},{opacity:1,transform:'translateY(0)'}],{duration:650,delay:Number(entry.target.dataset.revealDelay||0)});
  }),{threshold:.08});
  function observeCards() {
    document.querySelectorAll('.contractor').forEach((card,i)=>{
      card.dataset.revealDelay=String((i%3)*65);
      if(!revealed.has(card))revealObserver.observe(card);
    });
  }
  document.querySelectorAll('.bento-tile,.brief-panel,.workspace-intro').forEach((tile,i)=>{tile.dataset.revealDelay=String(Math.min(i,3)*65);revealObserver.observe(tile);});
  document.addEventListener('firebird:results',event=>{lastQuery=event.detail.query;renderPreview(event.detail);observeCards();});
  document.addEventListener('firebird:favorites',observeCards);
  document.addEventListener('firebird:profile',()=>animate($('dialog-content'),[{opacity:.35,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:300}));
  document.querySelectorAll('[role="tab"]').forEach(tab=>tab.addEventListener('click',()=>{
    const panel=$(tab.getAttribute('aria-controls'));
    animate(panel,[{opacity:.4,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:300});
  }));

  const tiltCards=[...document.querySelectorAll('.hero-people,.hero-stat')];
  const finePointer=window.matchMedia('(hover:hover) and (pointer:fine)');
  let tiltFrame=0,tiltTarget=null,tiltX=0,tiltY=0;
  function resetTilts(){cancelAnimationFrame(tiltFrame);tiltFrame=0;tiltCards.forEach(card=>card.style.removeProperty('transform'));}
  tiltCards.forEach(card=>{
    card.addEventListener('pointermove',event=>{
      if(!motion||!finePointer.matches||event.pointerType==='touch')return;
      const r=card.getBoundingClientRect();
      tiltX=(event.clientX-r.left)/r.width-.5;tiltY=(event.clientY-r.top)/r.height-.5;tiltTarget=card;
      if(!tiltFrame)tiltFrame=requestAnimationFrame(()=>{tiltFrame=0;tiltTarget.style.transform=`perspective(900px) rotateX(${-tiltY*3}deg) rotateY(${tiltX*3}deg)`;});
    });
    card.addEventListener('pointerleave',resetTilts);
  });

  const canvas=$('bento-orbit'),ctx=canvas.getContext('2d');
  let canvasFrame=0,canvasVisible=false,canvasWidth=230,canvasHeight=230,start=0;
  function drawOrbit(time=0) {
    if(!ctx)return;
    const t=motion?(time-start)/1000:0,cx=canvasWidth/2,cy=canvasHeight/2;
    ctx.clearRect(0,0,canvasWidth,canvasHeight);
    ctx.strokeStyle='#dce6ca';ctx.lineWidth=1;
    for(let ring=0;ring<3;ring++){
      const radius=37+ring*27;
      ctx.beginPath();ctx.ellipse(cx,cy,radius,radius*.72,-.35,0,Math.PI*2);ctx.stroke();
      const angle=t*(.2-ring*.035)+ring*2;
      const x=Math.cos(angle)*radius,y=Math.sin(angle)*radius*.72;
      ctx.beginPath();ctx.arc(cx+x*Math.cos(-.35)-y*Math.sin(-.35),cy+x*Math.sin(-.35)+y*Math.cos(-.35),ring===1?7:4,0,Math.PI*2);ctx.fillStyle=ring===1?'#a48bcc':'#acc57e';ctx.fill();
    }
    ctx.fillStyle='#dce6ca';ctx.beginPath();ctx.arc(cx,cy,4,0,Math.PI*2);ctx.fill();
  }
  function tick(time){if(!start)start=time;drawOrbit(time);canvasFrame=requestAnimationFrame(tick);}
  function updateCanvasLoop(){
    cancelAnimationFrame(canvasFrame);canvasFrame=0;
    if(ctx&&motion&&canvasVisible&&!document.hidden)canvasFrame=requestAnimationFrame(tick);
    else drawOrbit();
  }
  new ResizeObserver(()=>{
    const r=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
    canvasWidth=r.width;canvasHeight=r.height;canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);
    ctx?.setTransform(dpr,0,0,dpr,0,0);drawOrbit();
  }).observe(canvas);
  new IntersectionObserver(entries=>{canvasVisible=entries[0].isIntersecting;updateCanvasLoop();}).observe(canvas);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)resetTilts();updateCanvasLoop();});
  let progressFrame=0;
  function updateProgress(){progressFrame=0;const max=document.documentElement.scrollHeight-innerHeight;$('reading-progress-fill').style.transform=`scaleX(${max>0?Math.min(1,Math.max(0,scrollY/max)):0})`;}
  window.addEventListener('scroll',()=>{if(!progressFrame)progressFrame=requestAnimationFrame(updateProgress);},{passive:true});
  window.addEventListener('resize',updateProgress,{passive:true});
  window.addEventListener('pagehide',()=>{cancelAnimationFrame(canvasFrame);cancelAnimationFrame(progressFrame);resetTilts();animations.forEach(a=>a.cancel());});
  window.addEventListener('pageshow',updateCanvasLoop);
  refreshMotion();renderPreview(window.FirebirdMatcher.find(lastQuery,data));observeCards();updateProgress();
})();

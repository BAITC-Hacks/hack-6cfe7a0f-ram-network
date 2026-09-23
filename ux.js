/* Progressive UX: local preferences, shortlist, comparison and mobile navigation. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.FirebirdData;
  const matcher = window.FirebirdMatcher;
  const form = $('brief-form');
  const fields = ['city', 'date', 'format', 'category', 'budget', 'language', 'hours'];
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value === null ? 'Не указана' : new Intl.NumberFormat('ru-RU').format(value) + ' ₸';
  const key = 'firebird:preferences:v1';
  let saved = [];
  let toastTimer;
  let storageAvailable = true;
  let restoring = true;
  const readQuery = () => ({city:$('city').value,date:$('date').value,format:$('format').value,category:$('category').value,budget:Number($('budget').value),language:$('language').value,hours:$('hours').value === '' ? null : Number($('hours').value)});
  const defaults = readQuery();
  let lastQuery = defaults;

  form.insertAdjacentHTML('afterend', '<div class="draft-row"><span id="draft-status">Параметры сохраняются в этом браузере</span><button type="button" id="reset-brief">Сбросить</button></div>');
  $('query-summary').insertAdjacentHTML('afterend', '<div class="selection-tools"><p><span aria-hidden="true">♡</span> Сохраните до трёх вариантов и сравните детали</p></div>');
  document.body.insertAdjacentHTML('beforeend', '<div id="ux-toast" class="ux-toast" role="status" aria-live="polite" hidden></div><nav class="mobile-dock" aria-label="Быстрая навигация"><a href="#workspace"><span aria-hidden="true">☷</span> Параметры</a><a href="#selection"><span aria-hidden="true">↗</span> Результаты</a><button type="button" id="mobile-shortlist"><span aria-hidden="true">♡</span> Избранное <span id="mobile-count">0</span></button></nav><dialog id="shortlist-dialog" aria-labelledby="shortlist-title"><div class="dialog-header"><div><p class="eyebrow">ВАШ КОРОТКИЙ СПИСОК</p><h2 id="shortlist-title">Сравнить избранное</h2></div><button type="button" class="icon-button" id="close-shortlist" aria-label="Закрыть избранное">×</button></div><p class="comparison-note">Сохранённые профили могут быть из разных запросов. Сравнение учитывает последний выполненный подбор. Цены «от» — за мероприятие, не итоговая смета.</p><div id="shortlist-content"></div></dialog>');
  const shortlistDialog = $('shortlist-dialog');
  const selection = $('selection');
  const searchPanel = document.createElement('div');
  searchPanel.id = 'search-panel';
  searchPanel.setAttribute('role', 'tabpanel');
  searchPanel.setAttribute('aria-labelledby', 'search-tab');
  while (selection.firstChild) searchPanel.append(selection.firstChild);
  selection.append(searchPanel);
  selection.insertAdjacentHTML('afterbegin', '<div class="catalog-tabs" role="tablist" aria-label="Каталог подрядчиков"><button type="button" role="tab" id="search-tab" aria-controls="search-panel" aria-selected="true">Подборка</button><button type="button" role="tab" id="favorites-tab" aria-controls="favorites-panel" aria-selected="false" tabindex="-1">Избранные подрядчики <span id="favorites-count">0</span></button></div>');
  selection.insertAdjacentHTML('beforeend', '<section id="favorites-panel" role="tabpanel" aria-labelledby="favorites-tab" hidden><div class="favorites-heading"><div><p class="eyebrow">ВАША КОМАНДА</p><h2>Избранные подрядчики</h2></div><button type="button" class="shortlist-open" id="compare-favorites">Сравнить</button></div><p class="comparison-note">До трёх сохранённых профилей. При изменении запроса проверьте их условия в сравнении.</p><div id="favorites-list"></div></section>');
  document.querySelector('.topnav').insertAdjacentHTML('beforeend', '<a href="#favorites-panel" id="favorites-nav">Избранные подрядчики</a>');
  function activateTab(favorites, focus = false) {
    $('search-panel').hidden = favorites;
    $('favorites-panel').hidden = !favorites;
    selection.setAttribute('aria-labelledby', favorites ? 'favorites-tab' : 'results-title');
    for (const [id, active] of [['search-tab', !favorites], ['favorites-tab', favorites]]) {
      $(id).setAttribute('aria-selected', String(active));
      $(id).tabIndex = active ? 0 : -1;
      if (active && focus) $(id).focus();
    }
  }
  function showFavorites() { activateTab(true, true); selection.scrollIntoView({block:'start'}); }
  $('search-tab').addEventListener('click', () => activateTab(false));
  $('favorites-tab').addEventListener('click', () => activateTab(true));
  $('favorites-nav').addEventListener('click', event => { event.preventDefault(); showFavorites(); });
  selection.querySelector('[role="tablist"]').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    activateTab(event.key === 'End' || (event.key !== 'Home' && $('favorites-panel').hidden), true);
  });
  document.querySelectorAll('a[href="#selection"],a[href="#workspace"],a[href="#method"]').forEach(link => link.addEventListener('click', () => activateTab(false)));
  function renderFavorites() {
    $('favorites-count').textContent = saved.length;
    $('compare-favorites').hidden = !saved.length;
    $('favorites-list').innerHTML = saved.length ? saved.map(id => {
      const p = data.catalog.find(item => item.id === id);
      return `<article class="contractor favorite-card" aria-labelledby="favorite-${esc(p.id)}"><div class="card-top"><div class="avatar" data-avatar="${esc(p.id)}" aria-hidden="true">${esc(p.anon_name[0])}</div><div class="card-identity"><h3 id="favorite-${esc(p.id)}">${esc(p.anon_name)}</h3><p class="card-subtitle">${esc(p.categories.join(', '))} · ${esc(p.city)}</p></div><div class="price"><small>Начальная стоимость</small><strong>от ${money(p.price_from_kzt)}</strong></div></div><p class="favorite-context">Сохранённый профиль. Актуальные условия — в сравнении.</p><div class="card-bottom"><button type="button" class="save-button" data-save="${esc(p.id)}"></button><button type="button" class="details-button" data-provider="${esc(p.id)}">Смотреть профиль <span aria-hidden="true">↗</span></button></div></article>`;
    }).join('') : '<div class="shortlist-empty"><span aria-hidden="true">♡</span><h3>Соберите свою команду</h3><p>Сохраните понравившихся подрядчиков из подборки. Они останутся здесь после перезагрузки страницы.</p><button type="button" class="details-button" id="find-favorites">Найти подрядчиков ↗</button></div>';
    updateButtons();
    document.dispatchEvent(new CustomEvent('firebird:favorites'));
  }
  $('favorites-list').addEventListener('click', event => {
    const save = event.target.closest('[data-save]');
    if (save) {
      const index = saved.indexOf(save.dataset.save);
      toggleSaved(save.dataset.save);
      const remaining = $('favorites-list').querySelectorAll('[data-save]');
      (remaining[Math.min(index, remaining.length - 1)] || $('find-favorites')).focus();
    }
    if (event.target.closest('#find-favorites')) activateTab(false, true);
  });

  function notify(message) {
    clearTimeout(toastTimer);
    $('ux-toast').textContent = message;
    $('ux-toast').hidden = false;
    toastTimer = setTimeout(() => { $('ux-toast').hidden = true; }, 4200);
  }
  function persist() {
    try {
      localStorage.setItem(key, JSON.stringify({query:lastQuery, saved}));
      $('draft-status').textContent = 'Последний подбор сохранён в этом браузере';
      storageAvailable = true;
    } catch (_) {
      storageAvailable = false;
      $('draft-status').textContent = 'Сохранение недоступно. Данные останутся до закрытия страницы';
    }
  }
  function updateButtons() {
    $('mobile-count').textContent = saved.length;
    document.querySelectorAll('[data-save]').forEach(button => {
      const active = saved.includes(button.dataset.save);
      const p = data.catalog.find(item => item.id === button.dataset.save);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${active ? 'Убрать из избранного' : 'В избранное'}: ${p.anon_name}`);
      button.innerHTML = `<span aria-hidden="true">${active ? '♥' : '♡'}</span> ${active ? 'Сохранён' : 'Сохранить'}`;
    });
  }
  function decorateCards() {
    document.querySelectorAll('#results .contractor').forEach(card => {
      const profile = card.querySelector('[data-provider]');
      if (!profile || card.querySelector('[data-save]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'save-button';
      button.dataset.save = profile.dataset.provider;
      card.querySelector('.card-bottom').insertBefore(button, profile);
    });
    const empty = document.querySelector('#results .empty-state');
    if (empty && !empty.querySelector('.edit-query')) {
      empty.insertAdjacentHTML('beforeend', '<button type="button" class="details-button edit-query">Изменить параметры <span aria-hidden="true">↗</span></button>');
    }
    updateButtons();
  }
  function renderComparison() {
    if (!saved.length) {
      $('shortlist-content').innerHTML = '<div class="shortlist-empty"><span aria-hidden="true">♡</span><h3>Здесь будет ваша команда</h3><p>Нажмите «Сохранить» в карточке подрядчика. Здесь удобно сравнить цену, языки и длительность работы.</p><button type="button" class="details-button" id="back-to-selection">К подборке ↗</button></div>';
      return;
    }
    const profiles = saved.map(id => data.catalog.find(p => p.id === id));
    function suitability(p) {
      const reasons = [];
      if (p.city !== lastQuery.city) reasons.push('Другой город');
      if (!p.categories.includes(lastQuery.category)) reasons.push('Другая категория');
      if (p.busy_dates.includes(lastQuery.date)) reasons.push('Занят на выбранную дату');
      if (!p.event_formats.includes(lastQuery.format)) reasons.push('Не берёт этот формат');
      if (p.price_from_kzt === null) reasons.push('Цена неизвестна');
      else if (p.price_from_kzt > lastQuery.budget) reasons.push('Выше бюджета');
      if (lastQuery.language && !p.languages.includes(lastQuery.language)) reasons.push('Нет выбранного языка');
      if (lastQuery.hours !== null && p.max_hours !== null && p.max_hours < lastQuery.hours) reasons.push('Недостаточно часов');
      return reasons.length ? reasons.join(' · ') : 'Подходит по условиям каталога';
    }
    const rows = [
      ['По последнему запросу', suitability],
      ['Город', p => p.city], ['Категории', p => p.categories.join(', ')],
      ['Стоимость от', p => money(p.price_from_kzt)],
      ['Языки', p => p.languages.join(', ')],
      ['Длительность', p => p.max_hours === null ? 'Без привязки к присутствию' : `До ${p.max_hours} ч`],
      ['Форматы', p => p.event_formats.join(', ')],
      ['Особенности данных', p => [p.synthetic ? 'Синтетический профиль' : 'Анонимизированный профиль', p.city_imputed && 'Город заполнен при подготовке', p.price_imputed && 'Цена заполнена при подготовке'].filter(Boolean).join(' · ')]
    ];
    $('shortlist-content').innerHTML = `<p class="comparison-query">${esc(lastQuery.city)} · ${esc(lastQuery.date.split('-').reverse().join('.'))} · ${esc(lastQuery.category)} · ${esc(lastQuery.format)} · до ${money(lastQuery.budget)}${lastQuery.language ? ' · ' + esc(lastQuery.language) : ''}${lastQuery.hours !== null ? ' · ' + lastQuery.hours + ' ч' : ''}</p><p class="comparison-scroll-hint">На узком экране таблицу можно прокрутить вбок.</p><div class="comparison-scroll" tabindex="0" role="region" aria-label="Таблица сравнения подрядчиков"><table class="comparison-table"><caption class="sr-only">Сравнение сохранённых подрядчиков</caption><thead><tr><th scope="col">Параметр</th>${profiles.map(p => `<th scope="col">${esc(p.anon_name)}<small>${esc(p.id)}</small><button type="button" data-remove="${esc(p.id)}" aria-label="Убрать из избранного: ${esc(p.anon_name)}">Убрать</button></th>`).join('')}</tr></thead><tbody>${rows.map(([label, value]) => `<tr><th scope="row">${label}</th>${profiles.map(p => `<td>${esc(value(p))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function toggleSaved(id) {
    if (saved.includes(id)) saved = saved.filter(item => item !== id);
    else {
      if (saved.length >= 3) { notify('В избранном уже три профиля. Уберите один в сравнении, чтобы добавить новый.'); return; }
      saved.push(id);
    }
    persist(); updateButtons(); renderFavorites();
    notify(`В избранном: ${saved.length} из 3.${storageAvailable ? '' : ' Сохранено только на этой странице.'}`);
  }
  $('results').addEventListener('click', event => {
    const save = event.target.closest('[data-save]');
    if (save) toggleSaved(save.dataset.save);
    if (event.target.closest('.edit-query')) { $('city').focus(); $('workspace').scrollIntoView({block:'start'}); }
  });
  function openShortlist() { renderComparison(); shortlistDialog.showModal(); }
  $('mobile-shortlist').addEventListener('click', showFavorites);
  $('compare-favorites').addEventListener('click', openShortlist);
  $('close-shortlist').addEventListener('click', () => shortlistDialog.close());
  shortlistDialog.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const previousIndex = saved.indexOf(remove.dataset.remove);
      toggleSaved(remove.dataset.remove); renderComparison();
      const buttons = shortlistDialog.querySelectorAll('[data-remove]');
      (buttons[Math.min(previousIndex, buttons.length - 1)] || $('back-to-selection')).focus();
    }
    if (event.target.closest('#back-to-selection')) { shortlistDialog.close(); activateTab(false, true); }
    if (event.target === shortlistDialog) {
      const r = shortlistDialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) shortlistDialog.close();
    }
  });
  document.addEventListener('firebird:results', event => {
    lastQuery = event.detail.query;
    activateTab(false);
    persist(); decorateCards();
  });
  form.addEventListener('submit', () => {
    if (!restoring && $('form-error').hidden && window.matchMedia('(max-width:700px)').matches) $('selection').focus();
  });
  form.addEventListener('input', () => { $('draft-status').textContent = 'Обновите подборку, чтобы сохранить изменения'; });
  document.querySelectorAll('[data-budget]').forEach(button => button.addEventListener('click', () => { $('draft-status').textContent = 'Обновите подборку, чтобы сохранить изменения'; }));
  $('reset-brief').addEventListener('click', () => {
    fields.forEach(field => { $(field).value = defaults[field] ?? ''; });
    document.querySelector('.optional-fields').open = false;
    form.requestSubmit();
    notify('Параметры сброшены. Избранное сохранено.');
  });
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    if (stored && typeof stored === 'object') {
      if (Array.isArray(stored.saved)) saved = [...new Set(stored.saved)].filter(id => data.catalog.some(p => p.id === id)).slice(0,3);
      if (stored.query) {
        try {
          const query = matcher.validate(stored.query, data);
          // Match the native half-hour control as well as the matcher validation.
          if (query.hours !== null && (query.hours < .5 || query.hours % .5 !== 0)) throw new Error('Invalid hours');
          fields.forEach(field => { $(field).value = query[field] ?? ''; });
          document.querySelector('.optional-fields').open = Boolean(query.language || query.hours);
          form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
          $('draft-status').textContent = 'Восстановлен последний подбор в этом браузере';
        } catch (_) { /* Ignore outdated or malformed preferences. */ }
      }
    }
  } catch (_) { /* Storage can be blocked; the app remains fully usable. */ }
  decorateCards();
  renderFavorites();
  restoring = false;
})();

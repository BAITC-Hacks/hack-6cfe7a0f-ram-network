(function() {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.FirebirdData, ui = window.FirebirdCommunity, esc = ui.escapeHTML;
  const storageKey = 'firebird:reviews:v1';
  let own = Object.create(null);
  let activeProvider;
  let canPersist = true;
  const formatDate = value => new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(value+'T12:00:00'));
  const dateToday = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
    for (const p of data.catalog) {
      if (!Array.isArray(stored?.[p.id])) continue;
      own[p.id] = stored[p.id].slice(0,20).flatMap(r => {try{return [ui.validateReview(r)];}catch(_){return [];}});
    }
  } catch (_) { /* A blocked or corrupt local store must not break the catalogue. */ }
  function stars(value) { return `<span class="review-stars" role="img" aria-label="${value} из 5 звёзд"><span aria-hidden="true">${'★'.repeat(value)}${'☆'.repeat(5-value)}</span></span>`; }
  function decorateCards() {
    document.querySelectorAll('.contractor').forEach(card => {
      const providerButton = card.querySelector('[data-provider]');
      if (!providerButton) return;
      const id = providerButton.dataset.provider;
      const avatar = card.querySelector('.avatar');
      if (avatar) { avatar.innerHTML = ui.avatar(id); avatar.classList.add('portrait-avatar'); avatar.title = 'Иллюстративная аватарка'; }
      if (!card.querySelector('.rating-preview')) {
        card.querySelector('.card-top').insertAdjacentHTML('afterend', `<button type="button" class="rating-preview" data-provider="${esc(id)}" data-focus-reviews><span class="rating-mini" aria-hidden="true">★</span> <strong>4,5 / 5</strong><span>2 демо-отзыва</span><span aria-hidden="true">↗</span></button>`);
      }
    });
  }
  function reviewMarkup(r, index, removable) {
    const fullName = `${r.firstName} ${r.lastName}`;
    return `<article class="review-card"><header><div class="review-avatar" aria-hidden="true">${ui.avatar(fullName)}</div><div class="review-author"><h4>${esc(fullName)}</h4><time datetime="${r.date}">${esc(formatDate(r.date))}</time></div>${stars(r.rating)}</header><p>${esc(r.text)}</p><div class="review-meta"><span class="review-label">${r.demo?'Демонстрационный отзыв':'Ваш отзыв · только в этом браузере'}</span>${removable?`<button type="button" class="remove-review" data-remove-review="${index}" aria-label="Удалить свой отзыв от ${esc(formatDate(r.date))}">Удалить</button>`:''}</div></article>`;
  }
  function renderReviewList() {
    const entries = own[activeProvider.id] || [];
    $('own-reviews').innerHTML = entries.length ? `<h4 class="own-reviews-title">Ваши отзывы в этом браузере (${entries.length})</h4>${entries.map((r,i)=>reviewMarkup(r,i,true)).join('')}` : '';
    $('demo-reviews').innerHTML = ui.demoReviews(activeProvider.id).map((r,i)=>reviewMarkup(r,i,false)).join('');
  }
  function persistReviews() {
    try { localStorage.setItem(storageKey, JSON.stringify(own)); canPersist=true; }
    catch (_) { canPersist=false; }
  }
  document.addEventListener('firebird:profile', event => {
    activeProvider = event.detail.provider;
    $('dialog-title').insertAdjacentHTML('beforebegin', `<div class="profile-portrait" aria-hidden="true">${ui.avatar(activeProvider.id)}</div>`);
    $('dialog-content').insertAdjacentHTML('beforeend', `<section class="profile-reviews" id="profile-reviews" tabindex="-1" aria-labelledby="reviews-title"><div class="reviews-heading"><div><p class="eyebrow">ВПЕЧАТЛЕНИЯ О СОТРУДНИЧЕСТВЕ</p><h3 id="reviews-title">Отзывы</h3></div><div class="rating-summary"><span aria-hidden="true">★</span><strong>4,5</strong><span>/ 5<small>2 демо-отзыва</small></span></div></div><p class="reviews-disclaimer">Примеры для демонстрации интерфейса: имена, аватарки и отзывы вымышлены. Это не реальные рекомендации и не основание для ранжирования.</p><div id="own-reviews"></div><div id="demo-reviews"></div><details class="write-review"><summary>Оставить свой отзыв <span aria-hidden="true">＋</span></summary><p class="review-privacy">Отзыв виден только вам в этом браузере и не публикуется для других посетителей. Аватарка создаётся автоматически.</p><form id="review-form"><div class="review-name-fields"><div><label for="review-first-name">Имя</label><input id="review-first-name" name="firstName" autocomplete="given-name" maxlength="40" required></div><div><label for="review-last-name">Фамилия</label><input id="review-last-name" name="lastName" autocomplete="family-name" maxlength="40" required></div></div><fieldset class="rating-input"><legend>Ваша оценка</legend><div>${[1,2,3,4,5].map(n=>`<label class="rating-option"><input type="radio" name="rating" value="${n}" required aria-label="${n} из 5 звёзд"><span aria-hidden="true">★</span></label>`).join('')}</div><output id="rating-description">Выберите от 1 до 5 звёзд</output></fieldset><label for="review-text">Текст отзыва</label><textarea id="review-text" name="text" rows="4" minlength="10" maxlength="1200" required placeholder="Что понравилось и что можно улучшить?" aria-describedby="review-counter"></textarea><small id="review-counter">0 / 1200 · минимум 10 символов</small><p id="review-error" class="form-error" role="alert" hidden></p><button type="submit" class="primary-button">Сохранить отзыв в этом браузере <span aria-hidden="true">↗</span></button></form></details><p id="review-status" class="review-status" role="status" aria-live="polite"></p></section>`);
    renderReviewList();
    $('review-form').addEventListener('input', event => {
      $('review-error').hidden=true;
      $('review-counter').textContent=`${$('review-text').value.length} / 1200 · минимум 10 символов`;
      if (event.target.name === 'rating') {
        const rating=Number(event.target.value);
        $('rating-description').textContent=`${rating} из 5 звёзд`;
        document.querySelectorAll('.rating-option').forEach((label,i)=>label.classList.toggle('selected',i<rating));
      }
    });
    $('review-form').addEventListener('submit', event => {
      event.preventDefault();
      try {
        const review=ui.validateReview({firstName:$('review-first-name').value,lastName:$('review-last-name').value,rating:Number(new FormData(event.target).get('rating')),text:$('review-text').value,date:dateToday()});
        const reviews=own[activeProvider.id] || [];
        if (reviews.length >= 20) throw new Error('Сохранено 20 отзывов для этого профиля. Удалите один, чтобы добавить новый.');
        own[activeProvider.id]=[review,...reviews];
        persistReviews();renderReviewList();
        event.target.reset();
        $('review-counter').textContent='0 / 1200 · минимум 10 символов';
        $('rating-description').textContent='Выберите от 1 до 5 звёзд';
        document.querySelectorAll('.rating-option').forEach(label=>label.classList.remove('selected'));
        $('review-status').textContent=canPersist?'Отзыв сохранён только в этом браузере.':'Хранилище недоступно. Отзыв останется только до закрытия этой страницы.';
      } catch(error) { $('review-error').textContent=error.message;$('review-error').hidden=false; }
    });
    $('own-reviews').addEventListener('click', event => {
      const button=event.target.closest('[data-remove-review]');
      if (!button) return;
      own[activeProvider.id].splice(Number(button.dataset.removeReview),1);
      persistReviews();renderReviewList();
      $('review-status').textContent=canPersist?'Локальный отзыв удалён.':'Отзыв удалён на этой странице. Не удалось обновить хранилище браузера.';
      $('profile-reviews').focus();
    });
  });
  document.addEventListener('firebird:results', decorateCards);
  document.addEventListener('firebird:favorites', decorateCards);
  decorateCards();
})();

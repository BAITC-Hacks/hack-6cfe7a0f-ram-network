/* Illustrative identities and clearly labelled demo reviews; not dataset evidence. */
(function(root) {
  'use strict';
  const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const hash = value => Array.from(String(value)).reduce((n,c) => (n * 31 + c.codePointAt(0)) >>> 0, 7);
  function avatar(seed) {
    const n = hash(seed), bg = ['#e2eadc','#f8dfcc','#dce6ed','#e9dff0','#f2e7c7'][n%5];
    const skin = ['#edb995','#c98d68','#f4d0ae','#ae7554'][(n>>>3)%4];
    const shirt = ['#3d6a58','#c86743','#536d91','#836787'][(n>>>5)%4];
    const hair = ['#342e2b','#644330','#262d32','#916544'][(n>>>7)%4];
    const long = n%2 === 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" aria-hidden="true" focusable="false"><rect width="80" height="80" rx="20" fill="${bg}"/><circle cx="65" cy="14" r="18" fill="#fff" opacity=".35"/>${long?`<path d="M19 36C17 5 64 4 62 36L66 61H15Z" fill="${hair}"/>`:''}<path d="M9 80c0-19 13-29 31-29s31 10 31 29" fill="${shirt}"/><path d="M33 45h14v13c-2 8-12 8-14 0" fill="${skin}"/><ellipse cx="40" cy="33" rx="18" ry="22" fill="${skin}"/><path d="M21 33C13 7 59 3 59 29c-9-1-15-7-18-12-5 10-12 12-20 16" fill="${hair}"/><path d="M30 35h2m16 0h2" stroke="#372a26" stroke-width="2.8" stroke-linecap="round"/><path d="M36 44q4 4 8 0" fill="none" stroke="#8d4d42" stroke-width="2" stroke-linecap="round"/>${n%3===0?'<g fill="none" stroke="#453e39" stroke-width="1.5"><rect x="25" y="30" width="13" height="10" rx="4"/><rect x="42" y="30" width="13" height="10" rx="4"/><path d="M38 33h4"/></g>':''}<path d="m29 59 11 9 11-9" fill="none" stroke="#fff" opacity=".5" stroke-width="2"/></svg>`;
  }
  const authors = [['Алия','Серикова'],['Данияр','Омаров'],['Мария','Ким'],['Арман','Садыков'],['Анна','Морозова'],['Амина','Нурланова']];
  const texts = [
    'Понравилось, что детали обсудили заранее. Было легко согласовать пожелания и план подготовки.',
    'Общение было спокойным и понятным. На вопросы отвечали подробно, договорённости не терялись.',
    'Хорошее впечатление от подготовки: всё по делу, с вниманием к нашим пожеланиям.',
    'В целом остались довольны. Хотелось бы чуть быстрее получать ответы на уточнения.',
    'Помогли разобраться с деталями и подобрать подходящий вариант. Особенно понравилось внимание к мелочам.',
    'Удобно обсуждать организационные вопросы. Несколько деталей пришлось уточнить повторно, но всё решили.'
  ];
  function demoReviews(id) {
    const seed = hash(id);
    return [0,1].map(i => {
      const index = (seed+i*3)%authors.length;
      return {id:`demo-${id}-${i}`,firstName:authors[index][0],lastName:authors[index][1],rating:i===0?5:4,text:texts[(seed+i)%texts.length],date:`2026-09-${String(10+(seed+i*5)%12).padStart(2,'0')}`,demo:true};
    });
  }
  function validateReview(review) {
    if (!review || typeof review !== 'object') throw new Error('Заполните отзыв.');
    const firstName = String(review.firstName ?? '').trim(), lastName = String(review.lastName ?? '').trim();
    const namePattern = /^[\p{L}\p{M}][\p{L}\p{M}\s'’-]{0,39}$/u;
    if (!namePattern.test(firstName) || !namePattern.test(lastName)) throw new Error('Укажите имя и фамилию: до 40 символов, без цифр и специальных знаков.');
    if (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) throw new Error('Выберите оценку от 1 до 5 звёзд.');
    const text = String(review.text ?? '').trim();
    if (text.length < 10 || text.length > 1200) throw new Error('Напишите отзыв длиной от 10 до 1200 символов.');
    const date = review.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата отзыва.');
    const parsed = new Date(date+'T12:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) throw new Error('Некорректная дата отзыва.');
    return {firstName,lastName,rating:review.rating,text,date,demo:false};
  }
  const api = {avatar,demoReviews,validateReview,escapeHTML};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FirebirdCommunity = api;
})(globalThis);

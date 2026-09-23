'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const assistant = require('./assistant-local.js');
const data = require('./catalog.js');
const matcher = require('./matcher.js');

const context = Object.freeze({city: 'Алматы', category: 'Ведущий', format: 'корпоратив', date: '2026-10-06', budget: 2000000, language: 'русский', hours: 4});
const ask = (message, extra = {}, catalog = data) => assistant.reply({message, context, locale: 'ru', ...extra}, catalog, matcher);
const fixture = prices => ({...data, catalog: prices.map((price, i) => ({id: 'fixture-' + i, anon_name: 'Provider ' + i, city: 'Алматы', categories: ['Ведущий'], event_formats: ['корпоратив'], languages: ['русский'], max_hours: 5, busy_dates: [], price_from_kzt: price, description: 'Ведущий для корпоративных мероприятий.'}))});

test('pure deterministic API does not mutate frozen context or request', () => {
  const request = Object.freeze({message: 'бюджет 500 тыс', context, locale: 'ru'});
  assert.deepEqual(assistant.reply(request, data, matcher), assistant.reply(request, data, matcher));
  assert.equal(context.budget, 2000000);
  assert.deepEqual(Object.keys(assistant.reply(request, data, matcher)).sort(), ['answer', 'proposal', 'sources']);
});
test('runs as browser script with networking APIs unavailable', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  const source = fs.readFileSync(require.resolve('./assistant-local.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(/);
  vm.runInContext(source, sandbox);
  assert.match(sandbox.FirebirdLocalAssistant.reply({message: 'help', locale: 'en'}, data, matcher).answer, /without an API or server/);
});
test('RU / KZ / KK / EN greetings disclose bounded local capabilities', () => {
  for (const [message, locale, fragment] of [['привет', 'ru', 'не нейросеть'], ['сәлем', 'kk', 'нейрожелі емеспін'], ['көмек', 'kz', 'нейрожелі емеспін'], ['hello', 'en', 'not a neural network']]) {
    const response = ask(message, {locale});
    assert.ok(response.answer.includes(fragment)); assert.equal(response.proposal, null);
  }
});
test('unknown requests do not hallucinate or change filters', () => {
  for (const message of ['какая погода?', 'Какая погода завтра?', 'напиши код игры', 'what is the capital of France?', 'бүгін ауа райы қандай?']) {
    const response = ask(message);
    assert.match(response.answer, /произвольные вопросы/); assert.equal(response.proposal, null); assert.deepEqual(response.sources, []);
  }
});
test('exact existing comparison prompt uses only matcher top three', () => {
  const response = ask('Сравни варианты из текущей подборки. Чем они отличаются?');
  const matches = matcher.find(context, data).matches;
  assert.deepEqual(response.sources.map(s => s.id), matches.map(m => m.provider.id));
  assert.ok(response.sources.length <= 3);
  for (const source of response.sources) {
    const p = data.catalog.find(p => p.id === source.id);
    assert.equal(source.name, p.anon_name); assert.equal(source.price_from_kzt, p.price_from_kzt);
  }
  assert.match(response.answer, /демонстрационный каталог/);
});
test('comparison and plan work in all locales', () => {
  for (const [compare, plan, locale] of [['Compare current matches', 'Prepare an event plan', 'en'], ['Нұсқаларды салыстыр', 'Іс-шара жоспарын жаса', 'kk']]) {
    assert.ok(ask(compare, {locale}).sources.length);
    assert.match(ask(plan, {locale}).answer, /1\./);
  }
});
test('exact translated quick-action prompts work in Kazakh and English', () => {
  for (const [locale, compare, cheaper, plan] of [
    ['kk', 'Қазіргі іріктеудегі нұсқаларды салыстыр. Олардың айырмашылығы қандай?', 'Басқа талаптарды өзгертпей, арзанырақ нұсқа табуға бола ма?', 'Формадағы іс-шараға дайындық жоспарын құруға көмектес.'],
    ['en', 'Compare the options in the current selection. How do they differ?', 'Can you find a cheaper option without changing the other requirements?', 'Help me prepare a plan for the event in the form.']
  ]) {
    assert.ok(ask(compare, {locale}).sources.length);
    assert.equal(ask(cheaper, {locale}, fixture([500000])).proposal.query.budget, 500000);
    assert.match(ask(plan, {locale}).answer, /1\./);
  }
});
test('exact preparation prompt uses form without inventing vendors or timings', () => {
  const response = ask('Помоги составить план подготовки к мероприятию из формы.');
  assert.ok(response.answer.includes(context.date));
  assert.match(response.answer, /выбранной категории/);
  assert.equal(response.proposal, null); assert.deepEqual(response.sources, []);
});
test('exact cheaper prompt changes only budget with all constraints intact', () => {
  const response = ask('Можно ли найти дешевле, сохранив остальные условия?', {}, fixture([900000, 300000, 800000]));
  assert.equal(response.proposal.query.budget, 300000);
  assert.deepEqual({...response.proposal.query, budget: context.budget}, context);
  assert.deepEqual(response.sources.map(s => s.price_from_kzt), [300000]);
});
test('cheaper respects hours, language, date, format, city and category', () => {
  const catalog = fixture([50000, 60000, 70000, 80000, 90000, 100000, 600000]);
  catalog.catalog[0].max_hours = 2;
  catalog.catalog[1].languages = ['английский'];
  catalog.catalog[2].busy_dates = [context.date];
  catalog.catalog[3].event_formats = ['свадьба'];
  catalog.catalog[4].city = 'Астана';
  catalog.catalog[5].categories = ['Фотограф'];
  assert.equal(ask('найди дешевле', {}, catalog).proposal.query.budget, 600000);
});
test('cheaper never proposes above or equal to current budget or budget-only minimum', () => {
  for (const prices of [[2000000], [3000000], []]) {
    const response = ask('найти дешевле', {}, fixture(prices));
    assert.equal(response.proposal, null); assert.deepEqual(response.sources, []);
    assert.match(response.answer, /Повышать бюджет/);
  }
});
test('cheaper plus altered constraints requires clarification', () => {
  assert.equal(ask('дешевле в Астане').proposal, null);
  assert.match(ask('дешевле в Астане').answer, /Уточните/);
});
test('negations, alternatives and ambiguous ranges do not mutate filters', () => {
  for (const message of ['не Алматы бюджет 500 тыс', 'без ведущего', 'Алматы или Астана', 'not Almaty', 'Алматы емес', 'бюджет от 500 до 600', 'бюджет 500 тыс или 600 тыс', 'бюджет 500k-600k']) {
    const response = ask(message); assert.equal(response.proposal, null, message); assert.deepEqual(response.sources, [], message);
  }
});
test('budget comma decimals, spaces, RU/KZ/EN suffixes', () => {
  for (const [message, value] of [['бюджет 500 тыс', 500000], ['1,5 млн ₸', 1500000], ['budget 500k', 500000], ['budget 1.5 million KZT', 1500000], ['бюджет 500 мың', 500000], ['бюджет 500 000', 500000], ['budget 750000', 750000], ['500k', 500000]]) {
    assert.equal(ask(message).proposal?.query.budget, value, message);
  }
});
test('invalid, negative, fractional, excessive and competing budgets are rejected', () => {
  for (const message of ['бюджет -500 тыс', 'budget 0.5 KZT', 'бюджет 1000000001', '500 тыс 600 тыс', 'budget 100 and 500k', 'бюджет 3m', 'бюджет 500,000', 'бюджет 500-600', 'Алматы бюджет миллион']) {
    if (message === 'бюджет 3m') {assert.equal(ask(message).proposal.query.budget, 3000000); continue;}
    assert.equal(ask(message).proposal, null, message);
  }
});
test('date without year uses the valid form year, never the wall clock', () => {
  const yearData = {...data, calendarFrom: '2030-01-01', calendarThrough: '2030-12-31'};
  for (const message of ['дата 2026-10-07', 'дата 07.10.2026']) {
    const q = ask(message).proposal.query;
    assert.equal(q.date, '2026-10-07'); assert.deepEqual({...q, date: context.date}, context);
  }
  assert.equal(ask('дата 07.10').proposal.query.date, '2026-10-07');
  assert.equal(ask('дата 07.10', {context: {...context, date: '2030-10-06'}}, yearData).proposal.query.date, '2030-10-07');
  assert.equal(ask('Almaty photographer wedding budget 500k date 07.10', {context: null}).proposal, null);
});
test('invalid calendar dates and unsupported date text never use the old date', () => {
  for (const message of ['дата 2026-02-30', '31.11.2026', 'дата 2026-13-06', 'дата 06.10.26', 'дата завтра', 'date tomorrow', 'күні ертең', 'дата 1.10.2026']) {
    const response = ask(message); assert.equal(response.proposal, null, message); assert.match(response.answer, /Укажите существующую дату/, message);
  }
});
test('outside catalog date reports actual bounds without fake availability', () => {
  const response = ask('дата 2027-01-01');
  assert.equal(response.proposal, null);
  assert.ok(response.answer.includes(data.calendarFrom)); assert.ok(response.answer.includes(data.calendarThrough));
});
test('multiple dates clarify rather than silently selecting one', () => {
  assert.equal(ask('2026-10-06 2026-10-07').proposal, null);
});
test('grounded city/category/format aliases can build a complete proposal', () => {
  const response = ask('Almaty photographer wedding date 2026-10-06 budget 500k', {context: null, locale: 'en'});
  assert.deepEqual(response.proposal.query, {city: 'Алматы', category: 'Фотограф', format: 'свадьба', date: '2026-10-06', budget: 500000, language: '', hours: null});
  assert.equal(ask('Қарағанды фотограф үйлену тойы 2026-10-06 бюджет 500 мың').proposal.query.city, 'Караганда');
});
test('longer category alias wins over overlapping generic host', () => {
  assert.equal(ask('ceremony host').proposal.query.category, 'Ведущий церемонии');
});
test('new Kazakhstan city with no candidates is honest and does not change city', () => {
  const response = ask('город Шымкент');
  assert.equal(response.proposal.query.city, 'Шымкент'); assert.deepEqual(response.sources, []);
  assert.match(response.answer, /нет подрядчиков этой категории/);
});
test('unknown explicit city, format, category are not silently ignored', () => {
  for (const message of ['город Москва бюджет 500 тыс', 'city London budget 500k', 'формат дискотека бюджет 500 тыс', 'category magician budget 500k', 'Moscow budget 500k', 'Москва, фотограф, бюджет 500 тыс']) {
    assert.equal(ask(message).proposal, null, message);
  }
});
test('language and duration constraints validate and preserve other values', () => {
  assert.equal(ask('English 6 hours').proposal.query.language, 'английский');
  assert.equal(ask('English 6 hours').proposal.query.hours, 6);
  assert.equal(ask('30 часов').proposal, null);
});
test('HTML is untrusted plain text only and cannot execute or become code', () => {
  const catalog = fixture([500000]);
  catalog.catalog[0].anon_name = '<img src=x onerror=alert(1)>';
  const response = ask('compare', {}, catalog);
  assert.equal(response.sources[0].name, '<img src=x onerror=alert(1)>');
  assert.equal(typeof response.answer, 'string');
  assert.equal(ask('<script>alert(1)</script>').proposal, null);
});
test('missing form fields are not invented and length is bounded', () => {
  assert.equal(ask('compare', {context: null}).proposal, null);
  assert.match(ask('compare', {context: null}).answer, /Сначала заполните/);
  assert.equal(ask('x'.repeat(3001)).proposal, null);
  assert.ok(ask('x'.repeat(3001)).answer.length < 1000);
});

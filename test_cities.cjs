'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const data = require('./catalog.js');
const matcher = require('./matcher.js');
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Russian city labels checked against official government sources:
// https://www.gov.kz/article/22320
// https://www.gov.kz/memleket/entities/aqmola-selinograd/press/news/details/366585?lang=ru
const expectedCities = [
  'Алматы', 'Астана', 'Шымкент', 'Караганда', 'Актобе', 'Тараз', 'Павлодар',
  'Усть-Каменогорск', 'Семей', 'Атырау', 'Костанай', 'Кызылорда', 'Уральск',
  'Петропавловск', 'Кокшетау', 'Туркестан', 'Талдыкорган', 'Актау',
  'Жезказган', 'Конаев', 'Зарубежье'
];
assert.deepEqual(data.cities, expectedCities);
assert.equal(data.cities.length, 21);
assert.equal(new Set(data.cities).size, 21, 'city names are unique');
assert.equal(data.catalog.length, 66, 'no fabricated providers were added');

// Baselines recorded BEFORE the cities-only edit. Every original profile,
// including its descriptions, prices, dates and provenance, must be unchanged.
assert.equal(sha(data.catalog), '7d631004be8b1c70f3ad5cc18c9efefc4f801a0056743ffed71710f1dc6256fe');
const otherMetadata = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'cities' && key !== 'catalog'));
assert.equal(sha(otherMetadata), '5c7bb9d1eac92c1bdbc98444212da488fa68d09e2fa552e0638117d1718d7d45');

const base = { city: 'Алматы', date: '2026-10-06', format: 'корпоратив', category: 'Ведущий', budget: 1500000 };
const oldCities = ['Алматы', 'Астана', 'Зарубежье'];
const originalData = { ...data, cities: oldCities };
const existingResults = {
  'Алматы': { total: 7, ids: ['HK-88430', 'HK-44733', 'HK-75012'], hash: '7d876f208c926a3c5280491bdab6698cb310df32041f7bc2a6dcbb43e682f52b' },
  'Астана': { total: 3, ids: ['HK-80581', 'HK-58385', 'HK-97041'], hash: '66529947a840e0b69e42327149035f7693ce06c557230f488c5e8d1ad17cd559' }
};
for (const [city, expected] of Object.entries(existingResults)) {
  const result = matcher.find({ ...base, city }, data);
  assert.equal(result.outcome, 'matched');
  assert.equal(result.totalMatches, expected.total);
  assert.deepEqual(result.matches.map(item => item.provider.id), expected.ids);
  assert.equal(sha(result), expected.hash, `${city}: explanations and order unchanged`);
}

let existingChecks = 0;
for (const city of oldCities) for (const category of data.categories) for (const format of data.formats) {
  for (const date of [data.calendarFrom, '2026-10-06', '2026-11-14', data.calendarThrough]) {
    const query = { ...base, city, category, format, date };
    assert.deepEqual(matcher.find(query, data), matcher.find(query, originalData));
    existingChecks++;
  }
}

let emptyChecks = 0;
for (const city of expectedCities.filter(value => !oldCities.includes(value))) {
  assert.equal(data.catalog.filter(provider => provider.city === city).length, 0);
  for (const category of data.categories) {
    const result = matcher.find({ ...base, city, category }, data);
    assert.equal(result.outcome, 'no_category', `${city}: honest empty state`);
    assert.equal(result.totalMatches, 0);
    assert.deepEqual(result.matches, []);
    emptyChecks++;
  }
}
assert.throws(() => matcher.find({ ...base, city: 'Город вне списка' }, data), /Выберите город/);
console.log(`PASS: 21 locations, unchanged 66 profiles and metadata; ${existingChecks} original search regressions; ${emptyChecks} honest empty-city searches.`);

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('./guest-store.js');
const catalog = require('./catalog.js');

const KEY = 'firebird:demo-orders:v1';
const data = {
  calendarFrom: '2026-09-23', calendarThrough: '2026-12-31',
  catalog: [{ id: 'provider-1', busy_dates: ['2026-10-02'] }, { id: 'provider-2', busy_dates: [] }]
};
function storage(seed) {
  const values = new Map(seed == null ? [] : [[KEY, seed]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
function fixture(extra = {}) {
  let count = 0;
  return createStore({ storage: storage(), data, now: () => new Date(2026, 8, 23, 12), createId: () => `local-draft-${++count}`, ...extra });
}
function request(extra = {}) {
  return { providerId: 'provider-1', date: '2026-10-01', budget: 100000, wishes: '  Живая музыка  ', ...extra };
}
const code = value => error => error.code === value;

test('persists only a local draft, reloads exact fields and returns independent copies', () => {
  const disk = storage();
  const store = fixture({ storage: disk });
  assert.equal(store.persistent, true);
  const saved = store.save(request());
  assert.equal(saved.status, 'draft');
  assert.equal(saved.wishes, 'Живая музыка');
  assert.ok(Number.isFinite(Date.parse(saved.createdAt)));
  const reloaded = fixture({ storage: disk });
  assert.deepEqual(reloaded.list(), [saved]);
  saved.wishes = 'changed return';
  reloaded.list()[0].budget = -1;
  assert.equal(reloaded.list()[0].wishes, 'Живая музыка');
  assert.equal(reloaded.list()[0].budget, 100000);
  assert.equal(disk.values.size, 1);
  assert.equal(JSON.parse(disk.getItem(KEY))[0].status, 'draft');
});

test('validates real dates, today, known calendar boundaries and busy dates', () => {
  const store = fixture();
  for (const date of ['2026-09-22', '2027-01-01', '2026-11-31', '2026-02-29', '2026-9-23', '', null]) {
    assert.throws(() => store.save(request({ date })), code('invalid_date'));
  }
  assert.throws(() => store.save(request({ date: '2026-10-02' })), code('busy_date'));
  assert.equal(store.save(request({ date: '2026-09-23' })).date, '2026-09-23');
  assert.equal(store.save(request({ date: '2026-12-31' })).date, '2026-12-31');
  const later = fixture({ now: () => new Date(2026, 9, 15, 12) });
  assert.throws(() => later.save(request()), code('invalid_date'));
});

test('uses existing catalog providers and availability without inventing catalog records', () => {
  const store = fixture({ data: catalog });
  const provider = catalog.catalog[0];
  const freeDate = ['2026-09-23', '2026-09-24', '2026-09-26'].find(date => !provider.busy_dates.includes(date));
  assert.equal(store.save(request({ providerId: provider.id, date: freeDate })).providerId, provider.id);
  assert.throws(() => store.save(request({ providerId: 'missing' })), code('invalid_provider'));
  assert.throws(() => store.save(request({ providerId: provider.id, date: provider.busy_dates[0] })), code('busy_date'));
});

test('rejects invalid budgets and bounded wishes without coercing unsafe input', () => {
  const store = fixture();
  for (const budget of [0, -1, 1.5, 1000000001, NaN, Infinity, '1000', null, true]) {
    assert.throws(() => store.save(request({ budget })), code('invalid_budget'));
  }
  assert.equal(store.save(request({ budget: 1 })).budget, 1);
  assert.equal(store.save(request({ budget: 1000000000 })).budget, 1000000000);
  assert.equal(store.save(request({ wishes: 'я'.repeat(2000) })).wishes.length, 2000);
  assert.equal(store.save(request({ wishes: '   ' + 'я'.repeat(2000) + '   ' })).wishes.length, 2000);
  assert.throws(() => store.save(request({ wishes: 'я'.repeat(2001) })), code('wishes_too_long'));
  assert.throws(() => store.save(request({ wishes: {} })), code('invalid_request'));
  assert.equal(store.save(request({ wishes: null })).wishes, '');
});

test('double clicks reuse active drafts; editing preserves identity and cancellation is explicit', () => {
  let clock = new Date(2026, 8, 23, 12);
  const store = fixture({ now: () => clock });
  const saved = store.save(request());
  assert.deepEqual(store.save(request({ wishes: 'Живая музыка' })), saved);
  assert.equal(store.list().length, 1);
  clock = new Date(2026, 8, 24, 12);
  const edited = store.save(request({ id: saved.id, budget: 250000 }));
  assert.equal(edited.id, saved.id);
  assert.equal(edited.createdAt, saved.createdAt);
  assert.ok(edited.updatedAt > saved.updatedAt);
  assert.equal(store.list().length, 1);
  const cancelled = store.cancel(saved.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(store.cancel(saved.id), cancelled);
  assert.throws(() => store.save(request({ id: saved.id })), code('cancelled'));
  assert.throws(() => store.save(request({ id: 'unknown' })), code('not_found'));
  assert.throws(() => store.cancel('unknown'), code('not_found'));
  assert.notEqual(store.save(request({ budget: 250000 })).id, saved.id);
  assert.equal(store.list().length, 2);
});

test('old drafts remain readable after their date, but cannot be saved with an expired date', () => {
  const disk = storage();
  const first = fixture({ storage: disk });
  const saved = first.save(request());
  const later = fixture({ storage: disk, now: () => new Date(2026, 10, 1, 12) });
  assert.equal(later.list()[0].id, saved.id);
  assert.throws(() => later.save(request({ id: saved.id })), code('invalid_date'));
  assert.equal(later.cancel(saved.id).status, 'cancelled');
});

test('corrupt or oversized storage cannot break creating new drafts', () => {
  for (const value of ['{broken', '{"orders":[]}', 'null', 'x'.repeat(128 * 1024 + 1), '[null,42,"str"]']) {
    const disk = storage(value);
    const store = fixture({ storage: disk });
    assert.deepEqual(store.list(), []);
    assert.equal(store.save(request()).status, 'draft');
    assert.equal(store.persistent, true);
  }
});

test('drops tampered records including extra fields, invalid fields, timestamps and duplicate IDs', () => {
  const seed = fixture().save(request());
  const changes = [
    { id: '<script>alert(1)</script>' }, { providerId: 'made-up' }, { date: '2026-10-02' },
    { date: '2027-01-01' }, { budget: '100000' }, { budget: 0 }, { wishes: 'x'.repeat(2001) },
    { wishes: ' untrimmed ' }, { wishes: {} }, { status: 'confirmed' },
    { createdAt: 'not a timestamp' }, { updatedAt: '2000-01-01T00:00:00.000Z' },
    { token: 'should never be retained' }
  ];
  for (const change of changes) {
    const store = fixture({ storage: storage(JSON.stringify([{ ...seed, ...change }])) });
    assert.deepEqual(store.list(), [], JSON.stringify(change));
  }
  const validOnly = fixture({ storage: storage(JSON.stringify([seed, { ...seed }])) });
  assert.deepEqual(validOnly.list(), [seed]);
});

test('blocked reads and missing storage fall back to memory', () => {
  for (const disk of [null, {}, { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('no'); } }]) {
    const store = fixture({ storage: disk });
    assert.equal(store.persistent, false);
    const record = store.save(request());
    assert.equal(store.list()[0].id, record.id);
    assert.equal(store.cancel(record.id).status, 'cancelled');
  }
});

test('quota failure preserves existing drafts and the exact latest edit in memory', () => {
  const disk = storage();
  const store = fixture({ storage: disk });
  const record = store.save(request());
  disk.setItem = () => { throw new Error('QuotaExceededError'); };
  const edit = store.save(request({ id: record.id, budget: 300000 }));
  assert.equal(store.persistent, false);
  assert.deepEqual(store.list(), [edit]);
  assert.equal(store.save(request({ wishes: 'new' })).status, 'draft');
  assert.equal(store.list().length, 2);
  assert.equal(store.cancel(record.id).status, 'cancelled');
});

test('caps at 30 records while allowing duplicate reuse, editing and cancellation', () => {
  const store = fixture();
  for (let budget = 1; budget <= 30; budget++) store.save(request({ budget }));
  assert.equal(store.list().length, 30);
  assert.equal(store.save(request({ budget: 30 })).budget, 30);
  assert.throws(() => store.save(request({ budget: 31 })), code('limit'));
  const record = store.list()[0];
  assert.equal(store.save(request({ id: record.id, budget: 500 })).budget, 500);
  store.cancel(record.id);
  assert.throws(() => store.save(request({ budget: 31 })), code('limit'));
});

test('opaque IDs remain unique and a broken custom generator fails without overwriting drafts', () => {
  const store = fixture({ createId: () => 'same-local-draft-id' });
  const first = store.save(request());
  assert.throws(() => store.save(request({ budget: 999 })), code('invalid_request'));
  assert.deepEqual(store.list(), [first]);
  const generated = createStore({ storage: null, data, now: () => new Date(2026, 8, 23, 12) });
  const ids = new Set(Array.from({ length: 30 }, (_, budget) => generated.save(request({ budget: budget + 1 })).id));
  assert.equal(ids.size, 30);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{12,96}$/);
});

test('removing an own demo record persists deletion and frees capacity', () => {
  const disk = storage();
  const store = fixture({ storage: disk });
  for (let budget = 1; budget <= 30; budget++) store.save(request({ budget }));
  const record = store.list()[0];
  assert.deepEqual(store.remove(record.id), record);
  assert.equal(store.list().length, 29);
  assert.equal(fixture({ storage: disk }).list().length, 29);
  assert.throws(() => store.remove(record.id), code('not_found'));
  assert.equal(store.save(request({ budget: 1000 })).status, 'draft');
  assert.equal(store.list().length, 30);
});

test('editing two drafts to identical values preserves both identities across reload', () => {
  const disk = storage();
  const store = fixture({ storage: disk });
  const first = store.save(request());
  const second = store.save(request({ budget: 500000 }));
  store.save(request({ id: second.id }));
  assert.deepEqual(new Set(fixture({ storage: disk }).list().map(record => record.id)), new Set([first.id, second.id]));
});

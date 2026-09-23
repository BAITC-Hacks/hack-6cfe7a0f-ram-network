(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FirebirdGuestStore = api;
})(globalThis, function (root) {
  'use strict';

  const KEY = 'firebird:demo-orders:v1';
  const MAX_RECORDS = 30;
  const MAX_SERIALIZED = 128 * 1024;
  const FIELDS = ['id', 'providerId', 'date', 'budget', 'wishes', 'status', 'createdAt', 'updatedAt'];
  const messages = {
    invalid_provider: 'Выберите подрядчика из каталога.',
    invalid_date: 'Выберите сегодняшнюю или будущую дату в пределах календаря каталога.',
    busy_date: 'Подрядчик занят в эту дату. Выберите другую дату.',
    invalid_budget: 'Укажите бюджет целым числом от 1 до 1 000 000 000 ₸.',
    wishes_too_long: 'Пожелания должны содержать не более 2 000 символов.',
    limit: 'В демо можно сохранить не более 30 заявок.',
    not_found: 'Демо-заявка не найдена.',
    cancelled: 'Отменённую демо-заявку нельзя изменить.',
    invalid_request: 'Проверьте данные демо-заявки.'
  };

  function fail(code) {
    const error = new Error(messages[code] || messages.invalid_request);
    error.code = code;
    throw error;
  }

  function isDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function iso(value) {
    return typeof value === 'string' && value.length === 24 &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }

  function localDay(value) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  function opaqueId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      return Array.from(root.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    }
    // IDs identify local drafts only: they never authenticate or authorize a server request.
    return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2).padEnd(11, '0')).join('');
  }

  function sameRequest(a, b) {
    return a.providerId === b.providerId && a.date === b.date && a.budget === b.budget && a.wishes === b.wishes;
  }

  function createStore(options) {
    options = options || {};
    const data = options.data || {};
    const providers = new Map((Array.isArray(data.catalog) ? data.catalog : []).map(provider => [provider.id, provider]));
    const clock = typeof options.now === 'function' ? options.now : () => new Date();
    const newId = typeof options.createId === 'function' ? options.createId : opaqueId;
    let storage = null;
    let durable = false;
    let records = [];

    function currentTime() {
      const value = new Date(clock());
      if (!Number.isFinite(value.getTime())) fail('invalid_request');
      return value;
    }

    function validate(input, allowPast) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request');
      const provider = typeof input.providerId === 'string' && providers.get(input.providerId);
      if (!provider) fail('invalid_provider');
      if (!isDate(input.date) || !isDate(data.calendarFrom) || !isDate(data.calendarThrough) ||
          input.date < data.calendarFrom || input.date > data.calendarThrough ||
          (!allowPast && input.date < localDay(currentTime()))) fail('invalid_date');
      if (Array.isArray(provider.busy_dates) && provider.busy_dates.includes(input.date)) fail('busy_date');
      if (!Number.isSafeInteger(input.budget) || input.budget < 1 || input.budget > 1000000000) fail('invalid_budget');
      if (input.wishes != null && typeof input.wishes !== 'string') fail('invalid_request');
      // Bound raw input too, before trimming exceptionally large pasted/stored values.
      if (typeof input.wishes === 'string' && input.wishes.length > MAX_SERIALIZED) fail('wishes_too_long');
      const wishes = (input.wishes || '').trim();
      if (wishes.length > 2000) fail('wishes_too_long');
      return { providerId: input.providerId, date: input.date, budget: input.budget, wishes };
    }

    function decode(raw) {
      if (typeof raw !== 'string' || raw.length > MAX_SERIALIZED) return [];
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { return []; }
      if (!Array.isArray(parsed)) return [];
      const valid = [];
      const ids = new Set();
      // Never iterate an unbounded payload, even if most entries are invalid.
      for (const item of parsed.slice(0, MAX_RECORDS)) {
        try {
          if (!item || typeof item !== 'object' || Array.isArray(item) ||
              Object.keys(item).length !== FIELDS.length || !FIELDS.every(key => Object.prototype.hasOwnProperty.call(item, key)) ||
              typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{12,96}$/.test(item.id) || ids.has(item.id) ||
              !['draft', 'cancelled'].includes(item.status) || !iso(item.createdAt) || !iso(item.updatedAt) ||
              item.updatedAt < item.createdAt || typeof item.wishes !== 'string') continue;
          // Past drafts remain visible as history. Saving an edit still requires a current date.
          const fields = validate(item, true);
          if (fields.wishes !== item.wishes) continue;
          valid.push({ id: item.id, ...fields, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt });
          ids.add(item.id);
        } catch (_) { /* Ignore corrupt or outdated records without breaking the demo. */ }
      }
      return valid;
    }

    function persist() {
      if (!storage) { durable = false; return; }
      try {
        storage.setItem(KEY, JSON.stringify(records));
        durable = true;
      } catch (_) {
        // Keep the exact in-memory state so a quota/privacy error cannot lose this session's work.
        durable = false;
        storage = null;
      }
    }

    try {
      storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : root.localStorage;
      if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
        records = decode(storage.getItem(KEY));
        persist();
      } else storage = null;
    } catch (_) { storage = null; durable = false; }

    return {
      get persistent() { return durable; },
      list() {
        return records.slice().reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => ({ ...record }));
      },
      save(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request');
        let existing;
        if (Object.prototype.hasOwnProperty.call(input, 'id') && input.id != null) {
          existing = records.find(record => record.id === input.id);
          if (!existing) fail('not_found');
          if (existing.status === 'cancelled') fail('cancelled');
        }
        const fields = validate(input, false);
        if (existing) {
          if (sameRequest(existing, fields)) return { ...existing };
          Object.assign(existing, fields, { updatedAt: new Date(Math.max(currentTime().getTime(), Date.parse(existing.updatedAt))).toISOString() });
          persist();
          return { ...existing };
        }
        const duplicate = records.find(record => record.status === 'draft' && sameRequest(record, fields));
        if (duplicate) return { ...duplicate };
        if (records.length >= MAX_RECORDS) fail('limit');
        let id;
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = newId();
          if (typeof candidate === 'string' && /^[A-Za-z0-9_-]{12,96}$/.test(candidate) && !records.some(record => record.id === candidate)) {
            id = candidate;
            break;
          }
        }
        if (!id) fail('invalid_request');
        const timestamp = currentTime().toISOString();
        const record = { id, ...fields, status: 'draft', createdAt: timestamp, updatedAt: timestamp };
        records.push(record);
        persist();
        return { ...record };
      },
      cancel(id) {
        const record = records.find(item => item.id === id);
        if (!record) fail('not_found');
        if (record.status === 'cancelled') return { ...record };
        record.status = 'cancelled';
        record.updatedAt = new Date(Math.max(currentTime().getTime(), Date.parse(record.updatedAt))).toISOString();
        persist();
        return { ...record };
      },
      remove(id) {
        const index = records.findIndex(record => record.id === id);
        if (index === -1) fail('not_found');
        const removed = records.splice(index, 1)[0];
        persist();
        return { ...removed };
      }
    };
  }

  return { createStore };
});

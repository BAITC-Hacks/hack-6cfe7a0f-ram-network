/* Apply the saved theme before styles paint, then connect the accessible toggle. */
(function () {
  'use strict';
  const key = 'firebird:theme:v1';
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => value === 'light' || value === 'dark';
  let preference = null;
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch (_) { /* Theme switching still works when storage is unavailable. */ }

  function applyTheme() {
    const theme = preference || (systemTheme.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const label = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    button.querySelector('.theme-toggle-label').textContent = label;
    button.setAttribute('aria-label', 'Включить ' + (theme === 'dark' ? 'светлую' : 'тёмную') + ' тему');
    button.title = label;
  }

  applyTheme();
  document.addEventListener('DOMContentLoaded', function () {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    applyTheme();
    button.hidden = false;
    button.addEventListener('click', function () {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch (_) {}
      applyTheme();
    });
  });
  systemTheme.addEventListener('change', function () {
    if (!preference) applyTheme();
  });
  window.addEventListener('storage', function (event) {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : null;
    applyTheme();
  });
}());

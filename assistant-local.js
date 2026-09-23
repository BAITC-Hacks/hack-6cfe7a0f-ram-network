(function (root) {
  'use strict';

  // Deliberately bounded, deterministic catalog assistant. No model, network,
  // credentials, storage or automatic form changes are involved.
  const copy = {
    ru: {
      help: 'Я локальный помощник по каталогу, не нейросеть. Работаю в браузере без API и сервера. Могу сравнить текущую подборку, найти дешевле, подготовить план или предложить параметры: «Алматы, фотограф, свадьба, бюджет 500 тыс, дата 2026-10-06». Изменения применяются только по вашей кнопке.',
      unknown: 'Я могу помочь только с каталогом и подготовкой мероприятия: сравнить варианты, найти дешевле, составить план или изменить параметры подбора. Я не отвечаю на произвольные вопросы и не оформляю бронирование.',
      clarify: 'Уточните один вариант без отрицаний и альтернатив: город, категорию, формат, точную дату или бюджет. Я не изменил параметры.',
      invalidBudget: 'Укажите один целый бюджет от 0 до 1 000 000 000 ₸, например «бюджет 500 тыс» или «1,5 млн ₸». Параметры не изменены.',
      invalidDate: 'Укажите существующую дату в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ. Параметры не изменены.',
      calendar: 'Занятость в каталоге доступна только в интервале',
      calendarEnd: 'За его пределами я не могу проверить подбор. Параметры не изменены.',
      context: 'Сначала заполните корректные город, категорию, формат, дату и бюджет в форме. Я не подменяю отсутствующие условия.',
      compare: 'Сравнение текущей подборки по данным каталога:',
      proposal: 'Предлагаю параметры ниже. Нажмите «Применить параметры», если они подходят.',
      noCategory: 'В каталоге нет подрядчиков этой категории в выбранном городе. Другой город автоматически не подставляю.',
      noMatches: 'По всем указанным условиям совпадений нет. Я не ослабляю ограничения автоматически.',
      noCheaper: 'Более дешёвого варианта с сохранением города, категории, формата, даты, языка и длительности в каталоге нет. Повышать бюджет вместо снижения не предлагаю.',
      cheaper: 'Минимальная начальная цена при сохранении всех остальных условий:',
      found: 'Подходящих вариантов в каталоге:',
      from: 'от', languages: 'языки', hours: 'лимит присутствия', hour: 'ч', noHours: 'не привязано к присутствию', estimate: 'расчётная цена',
      caveat: 'Это демонстрационный каталог: цены начальные, календарь не подтверждает реальную доступность. Итоговую стоимость и дату уточните у подрядчика.',
      plan: 'Черновой план по параметрам формы',
      steps: ['Уточните число гостей, площадку и пожелания.', 'Сравните портфолио и запросите полную смету у выбранных подрядчиков.', 'Подтвердите дату, язык и объём услуг непосредственно с исполнителем.', 'Согласуйте тайминг, оборудование, условия оплаты и отмены.', 'Перед мероприятием сверьте контакты и окончательный план.'],
      planBudget: 'Бюджет формы относится к выбранной категории, а не автоматически ко всему мероприятию.'
    },
    kk: {
      help: 'Мен каталогтың жергілікті көмекшісімін, нейрожелі емеспін. API мен серверсіз браузерде жұмыс істеймін. Нұсқаларды салыстырамын, арзанырақ нұсқаны іздеймін, жоспар құрамын немесе шарттарды ұсынамын: «Алматы, фотограф, үйлену тойы, бюджет 500 мың, 2026-10-06». Өзгерісті тек өзіңіз қолданасыз.',
      unknown: 'Тек каталог пен іс-шара дайындығына көмектесемін: салыстыру, арзанырақ нұсқа, жоспар немесе іздеу шарттары. Кез келген сұраққа жауап бере алмаймын және бронь жасамаймын.',
      clarify: 'Терістеу не баламасыз бір нұсқаны нақтылаңыз: қала, санат, формат, нақты күн немесе бюджет. Шарттар өзгермеді.',
      invalidBudget: '0 мен 1 000 000 000 ₸ аралығындағы бір бүтін бюджетті жазыңыз: «бюджет 500 мың» немесе «1,5 млн ₸». Шарттар өзгермеді.',
      invalidDate: 'Бар күнді ЖЖЖЖ-АА-КК немесе КК.АА.ЖЖЖЖ форматында жазыңыз. Шарттар өзгермеді.',
      calendar: 'Каталог күнтізбесі тек мына аралықта қолжетімді:',
      calendarEnd: 'Одан тыс күнді тексере алмаймын. Шарттар өзгермеді.',
      context: 'Алдымен формада қаланы, санатты, форматты, күнді және бюджетті дұрыс толтырыңыз. Жетіспейтін шарттарды өзім таңдамаймын.',
      compare: 'Каталог деректері бойынша ағымдағы нұсқаларды салыстыру:',
      proposal: 'Төмендегі шарттарды ұсынамын. Сәйкес келсе, «Параметрлерді қолдану» түймесін басыңыз.',
      noCategory: 'Таңдалған қалада осы санаттағы мердігерлер каталогта жоқ. Қаланы автоматты түрде өзгертпеймін.',
      noMatches: 'Барлық шартқа сай нұсқа жоқ. Шектеулерді автоматты түрде әлсіретпеймін.',
      noCheaper: 'Қаланы, санатты, форматты, күнді, тілді және ұзақтықты сақтайтын арзанырақ нұсқа каталогта жоқ. Бюджетті көтеруді ұсынбаймын.',
      cheaper: 'Қалған шарттарды сақтағандағы ең төмен бастапқы баға:',
      found: 'Каталогтағы сәйкес нұсқалар:',
      from: 'бастап', languages: 'тілдер', hours: 'қатысу шегі', hour: 'сағ', noHours: 'қатысу уақытына байланысты емес', estimate: 'есептік баға',
      caveat: 'Бұл демонстрациялық каталог: бағалар бастапқы, күнтізбе нақты қолжетімділікті растамайды. Соңғы баға мен күнді мердігерден нақтылаңыз.',
      plan: 'Форма шарттары бойынша бастапқы жоспар',
      steps: ['Қонақ санын, орынды және тілектерді нақтылаңыз.', 'Портфолиоларды салыстырып, толық смета сұраңыз.', 'Күнді, тілді және қызмет көлемін орындаушымен растаңыз.', 'Кестені, жабдықты, төлем мен бас тарту шарттарын келісіңіз.', 'Іс-шара алдында байланыстарды және соңғы жоспарды тексеріңіз.'],
      planBudget: 'Формадағы бюджет бүкіл іс-шараға емес, таңдалған санатқа қатысты.'
    },
    en: {
      help: 'I am a local catalog assistant, not a neural network. I work in your browser without an API or server. I can compare current matches, find cheaper options, draft a plan, or propose filters: “Almaty, photographer, wedding, budget 500k, date 2026-10-06”. Only you can apply changes.',
      unknown: 'I can only help with this catalog and event preparation: comparisons, cheaper options, a plan, or search filters. I cannot answer arbitrary questions or make bookings.',
      clarify: 'Please specify one option without negations or alternatives: city, category, format, exact date or budget. No filters were changed.',
      invalidBudget: 'Enter one whole budget from 0 to 1,000,000,000 KZT, for example “budget 500k” or “1.5 million KZT”. No filters were changed.',
      invalidDate: 'Enter a real date as YYYY-MM-DD or DD.MM.YYYY. No filters were changed.',
      calendar: 'The catalog calendar only covers',
      calendarEnd: 'I cannot check matches outside this interval. No filters were changed.',
      context: 'First fill in a valid city, category, format, date and budget in the form. I do not guess missing conditions.',
      compare: 'Current matches compared using catalog data:',
      proposal: 'Here are proposed filters. Use “Apply parameters” if they are suitable.',
      noCategory: 'The catalog has no providers in this category and city. I do not automatically substitute a different city.',
      noMatches: 'No options meet every condition. I do not relax filters automatically.',
      noCheaper: 'There is no cheaper catalog option preserving the city, category, format, date, language and duration. I will not suggest a higher budget instead.',
      cheaper: 'Lowest starting price with every other condition preserved:',
      found: 'Matching catalog options:',
      from: 'from', languages: 'languages', hours: 'attendance limit', hour: 'h', noHours: 'not attendance-based', estimate: 'estimated price',
      caveat: 'This is a demonstration catalog: prices are starting prices and its calendar does not confirm real availability. Confirm the final price and date with the provider.',
      plan: 'Draft plan using the form filters',
      steps: ['Confirm guest count, venue and wishes.', 'Compare portfolios and request full quotes from shortlisted providers.', 'Confirm date, language and service scope directly with the provider.', 'Agree the timeline, equipment, payment and cancellation terms.', 'Before the event, check contacts and the final schedule.'],
      planBudget: 'The form budget applies to the selected category, not automatically to the entire event.'
    }
  };

  const aliases = {
    city: {
      'Алматы': ['almaty', 'алмате'], 'Астана': ['astana', 'астане'], 'Шымкент': ['shymkent', 'шымкенте'],
      'Караганда': ['karaganda', 'қарағанды', 'караганде'], 'Актобе': ['aktobe', 'ақтөбе'], 'Тараз': ['taraz', 'таразе'],
      'Павлодар': ['pavlodar', 'павлодаре'], 'Усть-Каменогорск': ['ust-kamenogorsk', 'өскемен', 'усть-каменогорске'],
      'Семей': ['semey', 'семее'], 'Атырау': ['atyrau'], 'Костанай': ['kostanay', 'қостанай', 'костанае'],
      'Кызылорда': ['kyzylorda', 'қызылорда', 'кызылорде'], 'Уральск': ['oral', 'орал', 'уральске'],
      'Петропавловск': ['petropavlovsk', 'петропавл', 'петропавловске'], 'Кокшетау': ['kokshetau', 'көкшетау'],
      'Туркестан': ['turkistan', 'түркістан', 'туркестане'], 'Талдыкорган': ['taldykorgan', 'талдықорған', 'талдыкоргане'],
      'Актау': ['aktau', 'ақтау'], 'Жезказган': ['zhezkazgan', 'жезқазған', 'жезказгане'],
      'Конаев': ['konaev', 'қонаев', 'конаеве'], 'Зарубежье': ['abroad']
    },
    category: {
      'Ведущий': ['ведущего', 'ведущие', 'host', 'жүргізуші'], 'Ведущий церемонии': ['ведущего церемонии', 'ceremony host', 'рәсім жүргізушісі'],
      'Фотограф': ['фотографа', 'photographer'], 'Видеограф': ['видеографа', 'videographer'],
      'Флорист': ['флориста', 'florist'], 'Декоратор': ['декоратора', 'decorator'],
      'Банкетный зал': ['банкетного зала', 'banquet hall', 'банкет залы'], 'Отель': ['отеля', 'hotel', 'қонақүй'],
      'Ресторан': ['ресторана', 'restaurant', 'мейрамхана'], 'Лайв-бэнд': ['live band', 'музыкальная группа'],
      'Инструменталист': ['инструменталиста', 'instrumentalist'], 'Национальный ансамбль': ['national ensemble', 'ұлттық ансамбль'],
      'Танцевальный коллектив': ['dance group', 'би тобы'], 'Загородная площадка': ['country venue'],
      'Шоу-программа': ['show program'], 'Фото и видеобудки': ['photo booth'], 'Подарки и сувениры': ['gifts and souvenirs']
    },
    format: {
      'свадьба': ['свадьбу', 'свадьбы', 'wedding', 'үйлену тойы'], 'той': ['тойға'],
      'корпоратив': ['корпоратива', 'corporate', 'корпоративке'], 'конференция': ['конференцию', 'конференции', 'conference'],
      'юбилей': ['юбилея', 'anniversary', 'мерейтой'], 'день рождения': ['дня рождения', 'birthday', 'туған күн']
    },
    language: {'русский': ['русском', 'russian', 'орысша'], 'казахский': ['казахском', 'kazakh', 'қазақша'], 'английский': ['английском', 'english', 'ағылшынша']}
  };

  const normalize = value => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const token = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function terms(text, values, mapping) {
    const hits = [];
    for (const value of values) {
      for (const alias of [value, ...(mapping[value] || [])]) {
        const expression = new RegExp('(^|[^\\p{L}\\p{N}])(' + token(normalize(alias)) + ')(?=$|[^\\p{L}\\p{N}])', 'gu');
        for (const match of text.matchAll(expression)) hits.push({value, start: match.index + match[1].length, end: match.index + match[0].length});
      }
    }
    // “Ceremony host” and “үйлену тойы” must not become two alternatives.
    return [...new Set(hits.filter(hit => !hits.some(other => other.start <= hit.start && other.end >= hit.end && other.end - other.start > hit.end - hit.start)).map(hit => hit.value))];
  }

  function parse(text, data, contextYear) {
    const change = {};
    // This exact quick-action phrase preserves constraints; it excludes nothing.
    text = text.replace(/without changing the other requirements/gu, 'preserving all requirements');
    // Negations and ranges need a person to disambiguate; never guess exclusions.
    if (/(^|[^\p{L}])(не|нет|кроме|без|или|либо|not|no|without|except|or|емес|жоқ|немесе)(?=$|[^\p{L}])/u.test(text)) return {error: 'clarify'};
    for (const [field, values] of Object.entries({city: data.cities, category: data.categories, format: data.formats, language: data.languages})) {
      const found = terms(text, values, aliases[field]);
      if (found.length > 1) return {error: 'clarify'};
      if (found.length) change[field] = found[0];
    }
    if (/(?:от|from)\s*\d[^a-zа-я]*(?:до|to)\s*\d/u.test(text)) return {error: 'clarify'};
    const dates = [...text.matchAll(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{2}\.\d{2}(?:\.\d{2,4})?)\b/g)]
      .filter(match => !/^\s*(?:тыс|мың|млн|миллион|million|thousand|[km]\b|₸|тенге|kzt)/u.test(text.slice(match.index + match[0].length)))
      .map(match => match[0]);
    if (dates.length > 1) return {error: 'clarify'};
    if (dates.length) {
      const raw = dates[0];
      if (raw.includes('-')) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return {error: 'invalidDate'};
        change.date = raw;
      } else {
        const [day, month, year = contextYear] = raw.split('.');
        if (!year || year.length !== 4) return {error: 'invalidDate'};
        change.date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    } else if (/(?:\bdate\b|дат[ауые]|күні|ертең|завтра|tomorrow|следующ|next week)/u.test(text)) return {error: 'invalidDate'};
    // Remove dates before monetary parsing, so a date can never become a price.
    const monetary = dates.reduce((value, date) => value.replace(date, ' '), text);
    if (/\d\s*[-–—]\s*\d/u.test(monetary)) return {error: 'invalidBudget'};
    const amount = '([+-]?\\d+(?:[ \\u00a0]\\d{3})*(?:[.,]\\d+)?)';
    const unit = '(тыс(?:яч[аиу]?)?\\.?|мың|млн\\.?|миллион(?:а|ов)?|million|thousand|[km]|₸|тенге|kzt)';
    const amounts = [...monetary.matchAll(new RegExp(amount + '\\s*' + unit + '(?=$|[^\\p{L}])', 'gu'))];
    const budgets = [...monetary.matchAll(new RegExp('(?:бюджет(?:ом|а|ке)?|budget)\\s*[:=]?\\s*(?:до|up to)?\\s*' + amount, 'gu'))];
    if (amounts.length > 1 || budgets.length > 1) return {error: 'invalidBudget'};
    const amountMatch = amounts[0], budgetMatch = budgets[0];
    if (amountMatch && budgetMatch && amountMatch[1] !== budgetMatch[1]) return {error: 'invalidBudget'};
    if (amountMatch || budgetMatch) {
      const raw = (amountMatch || budgetMatch)[1];
      // Commas such as 500,000 are ambiguous across locales; require spaces for grouping.
      if (/[.,]\d{3,}$/u.test(raw)) return {error: 'invalidBudget'};
      const suffix = amountMatch ? amountMatch[2] : '';
      const multiplier = /^(?:млн|миллион|million|m)/u.test(suffix) ? 1000000 : /^(?:тыс|мың|thousand|k$)/u.test(suffix) ? 1000 : 1;
      change.budget = Number(raw.replace(/[ \u00a0]/g, '').replace(',', '.')) * multiplier;
      if (!Number.isInteger(change.budget) || change.budget < 0 || change.budget > 1000000000) return {error: 'invalidBudget'};
    } else if (/бюджет|budget/u.test(monetary)) return {error: 'invalidBudget'};
    const hours = [...monetary.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:час(?:а|ов)?|hours?|сағат)(?=$|[^\p{L}])/gu)];
    if (hours.length > 1) return {error: 'clarify'};
    if (hours.length) change.hours = Number(hours[0][1].replace(',', '.'));
    // Named but unrecognized changed fields must not silently retain old values.
    if (/(?:город|city|қала)\s*[:=]?\s+[\p{L}]/u.test(text) && !change.city) return {error: 'clarify'};
    if (/(?:категори[яю]|category|санат)\s*[:=]?\s+[\p{L}]/u.test(text) && !change.category) return {error: 'clarify'};
    if (/(?:формат|format)\s*[:=]?\s+[\p{L}]/u.test(text) && !change.format) return {error: 'clarify'};
    // Explicit common non-catalog locations must not be swallowed beside a valid price.
    if (/(^|[^\p{L}])(?:москв[аыеу]|moscow|лондон[ае]?|london|санкт-петербург[ае]?|saint petersburg|дубай|dubai|ташкент[ае]?|tashkent)(?=$|[^\p{L}])/u.test(text)) return {error: 'clarify'};
    return {change};
  }

  function reply(request, data, matcher) {
    const locale = request?.locale === 'en' ? 'en' : ['kk', 'kz'].includes(request?.locale) ? 'kk' : 'ru';
    const words = copy[locale];
    const result = (answer, providers = [], query = null) => ({answer, sources: providers.slice(0, 3).map(p => ({id: p.id, name: p.anon_name, price_from_kzt: p.price_from_kzt})), proposal: query ? {query} : null});
    const money = value => Number(value).toLocaleString(locale === 'kk' ? 'kk-KZ' : locale === 'en' ? 'en-US' : 'ru-RU') + ' ₸';
    const text = normalize(request?.message);
    if (!text || text.length > 3000) return result(words.help);
    if (/^(?:привет|здравствуй(?:те)?|помощь|что умеешь|сәлем(?:етсіз бе)?|көмек|hello|hi|help|what can you do)[!?. ]*$/u.test(text)) return result(words.help);
    if (/погод|weather|ауа рай|новост|\bnews\b|жаңалық/u.test(text)) return result(words.unknown);
    if (!data || !matcher) return result(words.context);
    const contextYear = matcher.isDate(request?.context?.date) ? request.context.date.slice(0, 4) : null;
    const parsed = parse(text, data, contextYear);
    if (parsed.error) return result(words[parsed.error]);
    const changed = Object.keys(parsed.change).length > 0;
    const candidate = {...request.context, ...parsed.change};
    if (candidate.date && !matcher.isDate(candidate.date)) return result(words.invalidDate);
    if (candidate.date && (candidate.date < data.calendarFrom || candidate.date > data.calendarThrough)) return result(`${words.calendar} ${data.calendarFrom} — ${data.calendarThrough}. ${words.calendarEnd}`);
    let query;
    try {query = matcher.validate(candidate, data);} catch {return result(words.context);}
    const comparison = /сравн|отлича|compare|comparis|салыстыр/u.test(text);
    const cheaper = /дешев|дешёв|подешев|сэконом|cheaper|less expensive|арзан/u.test(text);
    const plan = /план|подготов|plan|prepare|жоспар|дайындық/u.test(text);
    const search = /подбер|подбор|найди|найти|find|search|ізде|таңда/u.test(text);
    const found = matcher.find(query, data);
    const providers = found.matches.map(match => match.provider);
    const empty = found.outcome === 'no_category' ? words.noCategory : words.noMatches;
    const detail = p => `${p.anon_name} — ${words.from} ${money(p.price_from_kzt)}${p.price_imputed ? ' (' + words.estimate + ')' : ''}; ${words.languages}: ${p.languages.join(', ')}; ${words.hours}: ${p.max_hours === null ? words.noHours : p.max_hours + ' ' + words.hour}.`;
    if (cheaper) {
      if (changed) return result(words.clarify);
      const eligible = data.catalog.filter(p => p.city === query.city && p.categories.includes(query.category) && matcher.failures(p, query).length === 0 && p.price_from_kzt < query.budget);
      if (!eligible.length) return result(`${words.noCheaper}\n\n${words.caveat}`);
      const budget = Math.min(...eligible.map(p => p.price_from_kzt));
      const proposed = matcher.validate({...query, budget}, data);
      const lowerMatches = matcher.find(proposed, data).matches.map(match => match.provider);
      return result(`${words.cheaper} ${money(budget)}.\n${lowerMatches.map(detail).join('\n')}\n\n${words.proposal}\n${words.caveat}`, lowerMatches, proposed);
    }
    if (plan && !changed) return result(`${words.plan}: ${query.city}, ${query.format}, ${query.date}; ${query.category} — ${money(query.budget)}.\n\n${words.steps.map((step, i) => (i + 1) + '. ' + step).join('\n')}\n\n${words.planBudget}\n${words.caveat}`);
    if (changed) return result(`${words.proposal}\n${found.outcome === 'matched' ? words.found + ' ' + found.totalMatches + '.\n' + providers.map(detail).join('\n') : empty}\n\n${words.caveat}`, providers, query);
    if (comparison || search) return result(`${providers.length ? words.compare + '\n' + providers.map(detail).join('\n') : empty}\n\n${words.caveat}`, providers);
    return result(words.unknown);
  }
  const api = Object.freeze({reply});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FirebirdLocalAssistant = api;
})(globalThis);

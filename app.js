/* ============================================================
   Huna Arabic flashcards — app logic
   WORDS_DATA:   [ [id, vol, chapter, dialogue|null, arabic, russian], ... ]
   CHAPTERS_DATA:[ [vol, [ [chapter, title, wordCount, [[dialogue,count],...]], ... ]], ... ]
   both provided by words-data.js
   ============================================================ */

(function(){
  "use strict";

  // ---------- Telegram WebApp integration ----------
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#00264b'); } catch(e){}
    try { tg.setBackgroundColor('#00264b'); } catch(e){}
    try { tg.disableVerticalSwipes(); } catch(e){}
  }
  function haptic(kind){
    if (!tg || !tg.HapticFeedback) return;
    if (kind === 'light') tg.HapticFeedback.impactOccurred('light');
    else if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
    else if (kind === 'warning') tg.HapticFeedback.notificationOccurred('warning');
  }

  // ---------- Storage: Telegram CloudStorage, mirrored to localStorage ----------
  // Every write also goes to localStorage so a transient CloudStorage failure
  // (rate limits, temporary errors) never silently loses progress. Reads prefer
  // CloudStorage but fall back to the local mirror per-key if a value is missing.
  const Storage = {
    // CloudStorage needs Bot API 6.9+; outside Telegram (or in very old
    // clients) its methods throw, so fall back to localStorage only
    useCloud: !!(tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9')),

    getItem(key){
      return new Promise((resolve) => {
        if (this.useCloud) {
          tg.CloudStorage.getItem(key, (err, value) => {
            if (err || !value) {
              let local = null;
              try { local = localStorage.getItem(key); } catch(e){}
              resolve(local);
            } else {
              resolve(value);
            }
          });
        } else {
          resolve(localStorage.getItem(key));
        }
      });
    },
    setItem(key, value){
      try { localStorage.setItem(key, value); } catch(e){}
      return new Promise((resolve) => {
        if (this.useCloud) {
          tg.CloudStorage.setItem(key, value, (err) => {
            if (err) console.warn('CloudStorage.setItem failed, kept local copy:', key, err);
            resolve(true);
          });
        } else {
          resolve(true);
        }
      });
    },
    removeItem(key){
      try { localStorage.removeItem(key); } catch(e){}
      return new Promise((resolve) => {
        if (this.useCloud) {
          tg.CloudStorage.removeItem(key, () => resolve(true));
        } else {
          resolve(true);
        }
      });
    },
    getKeys(){
      return new Promise((resolve) => {
        let localKeys = [];
        try { localKeys = Object.keys(localStorage); } catch(e){}
        if (this.useCloud) {
          tg.CloudStorage.getKeys((err, keys) => {
            const cloudKeys = (!err && keys) ? keys : [];
            resolve(Array.from(new Set([...cloudKeys, ...localKeys])));
          });
        } else {
          resolve(localKeys);
        }
      });
    },
    getItems(keys){
      return new Promise((resolve) => {
        if (keys.length === 0) return resolve({});
        const fillFromLocal = (out) => {
          keys.forEach(k => {
            if (out[k] === undefined || out[k] === null || out[k] === '') {
              let local = null;
              try { local = localStorage.getItem(k); } catch(e){}
              if (local !== null) out[k] = local;
            }
          });
          return out;
        };
        if (this.useCloud) {
          const chunks = [];
          for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i+100));
          const out = {};
          let done = 0;
          chunks.forEach(chunk => {
            tg.CloudStorage.getItems(chunk, (err, values) => {
              if (!err && values) Object.assign(out, values);
              done++;
              if (done === chunks.length) resolve(fillFromLocal(out));
            });
          });
        } else {
          const out = {};
          keys.forEach(k => { const v = localStorage.getItem(k); if (v !== null) out[k] = v; });
          resolve(out);
        }
      });
    },
    clearAll(){
      return this.getKeys().then(keys => {
        const relevant = keys.filter(k => k.startsWith('p_') || k === 'daily' || k === 'streak' || k === 'settings');
        return Promise.all(relevant.map(k => this.removeItem(k)));
      });
    }
  };

  // ---------- Word & chapter data ----------
  const WORDS = WORDS_DATA.map(w => ({ id:w[0], vol:w[1], ch:w[2], dlg:w[3], ar:w[4], ru:w[5], ctx:w[6]||null }));
  const TOTAL_VOL1 = WORDS.filter(w=>w.vol===1).length;
  const TOTAL_VOL2 = WORDS.filter(w=>w.vol===2).length;

  // A learnable unit is a (word, direction) pair — "fwd" = Arabic shown, Russian
  // recalled (as before); "rev" = Russian shown, Arabic recalled. Each has its
  // own independent progress record, like Anki's "and reversed card" note type.
  function cardKey(wordId, dir){ return dir === 'rev' ? `${wordId}r` : `${wordId}f`; }

  function findChapterEntry(vol, ch){
    const volEntry = CHAPTERS_DATA.find(e => e[0] === vol);
    if (!volEntry) return null;
    return volEntry[1].find(e => e[0] === ch) || null;
  }
  function chapterTitle(vol, ch){
    const e = findChapterEntry(vol, ch);
    return e ? e[1] : '';
  }

  const WORD_BY_ID = new Map(WORDS.map(w => [w.id, w]));
  function parseCardKey(key){
    return { word: WORD_BY_ID.get(parseInt(key, 10)), dir: key.endsWith('r') ? 'rev' : 'fwd' };
  }

  // ---------- Days ----------
  // Like Anki, a "day" starts at 4:00 local time, not at midnight UTC: a
  // review due "tomorrow" is due from tomorrow 4:00, whatever time of day it
  // was answered, and a late-night session still counts as the same day.
  const DAY_MS = 86400000;
  const ROLLOVER_HOUR = 4;
  function dayNumber(ms){
    const d = new Date(ms - ROLLOVER_HOUR * 3600000);
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
  }
  function dayStartMs(day){
    const d = new Date(day * DAY_MS);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ROLLOVER_HOUR).getTime();
  }
  const dayKey = (day) => new Date(day * DAY_MS).toISOString().slice(0,10);
  const today = () => dayNumber(Date.now());
  const todayStr = () => dayKey(today());

  function pluralRu(n, one, few, many){
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if ([2,3,4].includes(mod10) && ![12,13,14].includes(mod100)) return few;
    return many;
  }
  const pluralWords = (n) => pluralRu(n, 'слово', 'слова', 'слов');

  // ---------- App state ----------
  // progress[cardKey] = {
  //   learning, relearn (lapsed review card going through relearning steps),
  //   step, r(eps after graduating), i(nterval days), ef, due(ms), dueDay (review cards),
  //   lapses, leech }
  let progress = {};
  let settings = { dailyLimit: 15, selection: [], reverseEnabled: true }; // selection: [{vol,ch,dlg|null}]
  let dailyMeta = { date: todayStr(), introduced: 0 };
  let streak = { lastDate: null, count: 0 };

  let session = null; // see startSessionQueues()

  // ---------- Load / persist ----------
  async function loadAll(){
    const keys = await Storage.getKeys();
    const progKeys = keys.filter(k => k.startsWith('p_'));
    const misc = await Storage.getItems(['daily','streak','settings']);
    const progVals = await Storage.getItems(progKeys);

    progress = {};
    for (const k in progVals) {
      try { progress[k.slice(2)] = migrateCard(JSON.parse(progVals[k])); } catch(e){}
    }
    if (misc.daily) { try { dailyMeta = JSON.parse(misc.daily); } catch(e){} }
    if (misc.streak) { try { streak = JSON.parse(misc.streak); } catch(e){} }
    if (misc.settings) {
      try {
        const parsed = JSON.parse(misc.settings);
        settings = Object.assign({ dailyLimit:15, selection:[], reverseEnabled:true }, parsed);
        if (!Array.isArray(settings.selection)) settings.selection = [];
      } catch(e){}
    }
    rollDailyMeta();
  }
  // the app may stay open across the 4:00 day boundary
  function rollDailyMeta(){
    if (dailyMeta.date !== todayStr()) dailyMeta = { date: todayStr(), introduced: 0 };
  }

  function saveCardProgress(key){ return Storage.setItem('p_'+key, JSON.stringify(progress[key])); }
  function saveDaily(){ return Storage.setItem('daily', JSON.stringify(dailyMeta)); }
  function saveStreak(){ return Storage.setItem('streak', JSON.stringify(streak)); }
  function saveSettings(){ return Storage.setItem('settings', JSON.stringify(settings)); }

  // ---------- SRS logic ----------
  // Anki's scheduler (SM-2, as in Anki's v3 scheduler with default deck options).
  //
  // New card -> learning steps (minutes) -> graduates into day-based review.
  //  - Again  -> back to the first step
  //  - Hard   -> first step: halfway between steps 1 and 2; later steps: repeat the step
  //  - Good   -> next step; after the last step graduates with a 1-day interval
  //  - Easy   -> graduates immediately with a 4-day interval
  //
  // Review card (interval in days, ease factor starting at 250%):
  //  - Again  -> lapse: ease −20%, goes through relearning steps, then comes
  //              back with a shortened interval
  //  - Hard   -> interval × 1.2, ease −15%
  //  - Good   -> interval × ease (plus half the days it was overdue)
  //  - Easy   -> interval × ease × 1.3 (plus all overdue days), ease +15%
  // Intervals get a small random "fuzz" so words learned together don't
  // keep coming back on the same day forever.
  const LEARNING_STEPS_MIN = [1, 10];
  const RELEARNING_STEPS_MIN = [10];
  const GRADUATING_IVL = 1;
  const EASY_IVL = 4;
  const START_EASE = 2.5;
  const MIN_EASE = 1.3;
  const HARD_MULT = 1.2;
  const EASY_BONUS = 1.3;
  const LAPSE_IVL_MULT = 0;   // "New interval" after a lapse (Anki default 0 → minimum interval)
  const MIN_IVL = 1;
  const MAX_IVL = 36500;
  const LEECH_LAPSES = 8;
  const LEARN_AHEAD_MIN = 20; // learning cards due within this window may be shown early
  const MATURE_IVL = 21;

  function migrateCard(p){
    // older versions stored review due as "answer time + N×24h" and used 4 learning steps
    if (!p.learning) {
      if (typeof p.dueDay !== 'number') p.dueDay = dayNumber(p.due);
      p.i = Math.max(MIN_IVL, Math.round(p.i || MIN_IVL));
      p.due = dayStartMs(p.dueDay);
    } else {
      if (typeof p.relearn !== 'boolean') p.relearn = (p.r || 0) > 0;
      const steps = p.relearn ? RELEARNING_STEPS_MIN : LEARNING_STEPS_MIN;
      p.step = Math.min(p.step || 0, steps.length - 1);
    }
    if (typeof p.ef !== 'number') p.ef = START_EASE;
    if (typeof p.lapses !== 'number') p.lapses = 0;
    return p;
  }

  function isDue(id, now = Date.now()){
    const p = progress[id];
    if (!p) return false;
    return p.due <= now;
  }
  function cardState(id){
    const p = progress[id];
    if (!p) return 'new';
    if (p.learning) return 'learning';
    if (p.i >= MATURE_IVL) return 'mastered';
    return 'review';
  }

  // deterministic per card+rep, so the interval shown on a button is exactly
  // what that button will schedule
  function fuzzRandom(id, reps){
    let h = 2166136261;
    const s = id + ':' + reps;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }
  // Anki's fuzz: ±15% of the part of the interval between 2.5 and 7 days,
  // ±10% of the part between 7 and 20, ±5% beyond that, plus one day
  function fuzzInterval(ivl, id, reps){
    if (ivl < 2.5) return Math.round(ivl);
    let delta = 1;
    [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]].forEach(([from, to, factor]) => {
      delta += factor * Math.max(0, Math.min(ivl, to) - from);
    });
    const lo = Math.max(2, Math.round(ivl - delta));
    const hi = Math.max(lo, Math.round(ivl + delta));
    return lo + Math.floor(fuzzRandom(id, reps) * (hi - lo + 1));
  }
  const clampIvl = (d) => Math.min(MAX_IVL, Math.max(MIN_IVL, Math.round(d)));

  function toReview(p, ivl, now){
    p.learning = false;
    p.relearn = false;
    p.step = 0;
    p.i = clampIvl(ivl);
    p.dueDay = dayNumber(now) + p.i;
    p.due = dayStartMs(p.dueDay);
  }
  function toStep(p, step, minutes, now){
    p.learning = true;
    p.step = step;
    p.due = now + Math.round(minutes * 60000);
    delete p.dueDay;
  }

  // Pure: returns the card as it would be after answering `grade`
  // (0 Again, 1 Hard, 2 Good, 3 Easy), without touching stored progress.
  function scheduleCard(id, grade, now = Date.now()){
    const p = progress[id]
      ? JSON.parse(JSON.stringify(progress[id]))
      : { learning:true, relearn:false, step:0, r:0, i:0, ef:START_EASE, due:now, lapses:0 };

    if (p.learning) {
      const steps = p.relearn ? RELEARNING_STEPS_MIN : LEARNING_STEPS_MIN;
      const step = Math.min(p.step, steps.length - 1);
      // a relearning card graduates back to the (shortened) interval it lapsed to
      const graduateIvl = p.relearn ? p.i : GRADUATING_IVL;
      if (grade === 0) {
        toStep(p, 0, steps[0], now);
      } else if (grade === 1) {
        let mins = steps[step];
        if (step === 0) mins = steps.length > 1 ? (steps[0] + steps[1]) / 2 : Math.min(steps[0] * 1.5, steps[0] + 1440);
        toStep(p, step, mins, now);
      } else if (grade === 2) {
        if (step + 1 < steps.length) toStep(p, step + 1, steps[step + 1], now);
        else { p.r += 1; toReview(p, graduateIvl, now); }
      } else {
        p.r += 1;
        toReview(p, p.relearn ? graduateIvl + 1 : EASY_IVL, now);
      }
      return p;
    }

    // ---- review card ----
    const ivl = p.i;
    const daysLate = Math.max(0, dayNumber(now) - p.dueDay);
    if (grade === 0) {
      p.lapses += 1;
      p.ef = Math.max(MIN_EASE, p.ef - 0.2);
      p.i = clampIvl(ivl * LAPSE_IVL_MULT);
      p.relearn = true;
      if (p.lapses >= LEECH_LAPSES) p.leech = true;
      toStep(p, 0, RELEARNING_STEPS_MIN[0], now);
      return p;
    }
    // fuzz each option, then keep Hard < Good < Easy by at least a day
    const seed = p.r + 1;
    const hard = clampIvl(fuzzInterval(Math.max(ivl + 1, ivl * HARD_MULT), id, seed));
    const good = clampIvl(Math.max(hard + 1, fuzzInterval((ivl + daysLate / 2) * p.ef, id, seed)));
    const easy = clampIvl(Math.max(good + 1, fuzzInterval((ivl + daysLate) * p.ef * EASY_BONUS, id, seed)));
    let next;
    if (grade === 1) { next = hard; p.ef = Math.max(MIN_EASE, p.ef - 0.15); }
    else if (grade === 2) { next = good; }
    else { next = easy; p.ef += 0.15; }
    p.r += 1;
    toReview(p, next, now);
    return p;
  }

  function gradeCard(id, grade){
    const p = scheduleCard(id, grade);
    progress[id] = p;
    saveCardProgress(id);
    return p;
  }

  // "<1 мин", "6 мин", "3 ч", "4 дн", "2 мес", "1,5 г" — like the labels above Anki's buttons
  function formatInterval(p, now = Date.now()){
    if (p.learning) {
      const mins = Math.max(0, (p.due - now) / 60000);
      if (mins < 1) return '<1 мин';
      if (mins < 60) return `${Math.round(mins)} мин`;
      if (mins < 1440) return `${Math.round(mins / 60)} ч`;
      return `${Math.round(mins / 1440)} дн`;
    }
    const d = p.i;
    if (d < 30) return `${d} дн`;
    if (d < 365) return `${(d / 30).toFixed(d < 300 ? 1 : 0).replace('.0','').replace('.',',')} мес`;
    return `${(d / 365).toFixed(1).replace('.0','').replace('.',',')} г`;
  }

  // ---------- Selection filter (chapters / dialogues) ----------
  function matchesSelection(w){
    if (settings.selection.length === 0) return true;
    return settings.selection.some(sel => {
      if (sel.vol !== w.vol || sel.ch !== w.ch) return false;
      if (sel.dlg == null) return true;
      return sel.dlg === w.dlg;
    });
  }
  function pool(list){ return list.filter(matchesSelection); }

  // A reverse ("rev") card only becomes available once its forward
  // counterpart has graduated out of learning — recognizing a word reliably
  // comes before being asked to produce it from memory.
  function reverseUnlocked(w){
    const fwd = progress[cardKey(w.id,'fwd')];
    return !!fwd && !fwd.learning;
  }

  // Today's cards, split into Anki's three queues. A word's two directions
  // are siblings: if both would be reviewed today (or the forward side is
  // being relearned), the reverse side is buried until tomorrow so one
  // doesn't give away the answer to the other.
  function learningKeys(){
    const keys = [];
    pool(WORDS).forEach(w => {
      const f = cardKey(w.id,'fwd'), r = cardKey(w.id,'rev');
      if (progress[f] && progress[f].learning) keys.push(f);
      if (settings.reverseEnabled && progress[r] && progress[r].learning) keys.push(r);
    });
    return keys;
  }
  function dueReviewKeys(now = Date.now()){
    const keys = [];
    pool(WORDS).forEach(w => {
      const f = cardKey(w.id,'fwd'), r = cardKey(w.id,'rev');
      const pf = progress[f], pr = progress[r];
      const fwdDue = pf && !pf.learning && pf.due <= now;
      if (fwdDue) keys.push(f);
      if (settings.reverseEnabled && pr && !pr.learning && pr.due <= now && !fwdDue && !(pf && pf.learning)) keys.push(r);
    });
    return keys;
  }
  function newForwardWords(){
    return pool(WORDS).filter(w => !progress[cardKey(w.id,'fwd')]);
  }
  function newReverseWords(){
    if (!settings.reverseEnabled) return [];
    return pool(WORDS).filter(w => reverseUnlocked(w) && !progress[cardKey(w.id,'rev')]);
  }
  // the daily new-word limit paces *new vocabulary* only. Reverse cards
  // unlocked from words already learned aren't new vocabulary — they're
  // available uncapped, alongside everything else.
  function newKeysForToday(){
    const quota = Math.max(0, settings.dailyLimit - dailyMeta.introduced);
    return newForwardWords().slice(0, quota).map(w => cardKey(w.id,'fwd'))
      .concat(newReverseWords().map(w => cardKey(w.id,'rev')));
  }
  function learningDueSoon(now = Date.now()){
    const limit = now + LEARN_AHEAD_MIN * 60000;
    return learningKeys().filter(k => progress[k].due <= limit);
  }

  function selectionSummaryText(){
    if (settings.selection.length === 0) return 'Все главы';
    if (settings.selection.length === 1) {
      const s = settings.selection[0];
      if (s.dlg == null) return `Глава ${s.ch}: ${chapterTitle(s.vol, s.ch)}`;
      return `Глава ${s.ch}, Диалог ${s.dlg}`;
    }
    return `${settings.selection.length} ${pluralRu(settings.selection.length,'раздел','раздела','разделов')} выбрано`;
  }

  function shuffle(arr){
    const a = arr.slice();
    for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  }

  // ---------- Session ----------
  // Like Anki, the next card is chosen live rather than from a fixed list:
  //  1. a learning card whose step is up ("Забыл" a minute ago -> back now)
  //  2. otherwise reviews and new words, new ones spread evenly among reviews
  //  3. when those run out, learning cards due within LEARN_AHEAD_MIN are
  //     shown early, so the session ends once every word has been learned
  function startSessionQueues(){
    return {
      reviewQ: shuffle(dueReviewKeys()),
      newQ: newKeysForToday(),
      newDebt: 0,
      recent: [],
      current: null,
      answered: 0,
      stats: { new:0, reviewed:0, again:0 },
      lastAction: null,
    };
  }

  function earliest(keys, avoidKey){
    const sorted = keys.slice().sort((a,b) => progress[a].due - progress[b].due);
    return sorted.find(k => k !== avoidKey) || sorted[0] || null;
  }

  function takeReview(){
    while (session.reviewQ.length) {
      const k = session.reviewQ.shift();
      const p = progress[k];
      if (!p || p.learning || p.due > Date.now()) continue;
      // sibling lapsed during this session -> bury the reverse side
      if (k.endsWith('r')) { const pf = progress[k.slice(0,-1)+'f']; if (pf && pf.learning) continue; }
      return k;
    }
    return null;
  }
  // keeps a word's two sides apart: a new reverse card waits until a few
  // other cards have passed since its forward side was answered
  const SIBLING_GAP = 5;
  const siblingKey = (k) => k.slice(0,-1) + (k.endsWith('r') ? 'f' : 'r');
  function takeNew(allowRecentSibling){
    session.newQ = session.newQ.filter(k => !progress[k]);
    let i = session.newQ.findIndex(k => !session.recent.includes(siblingKey(k)));
    if (i < 0 && allowRecentSibling && session.newQ.length) i = 0;
    return i < 0 ? null : session.newQ.splice(i, 1)[0];
  }

  function pickNext(avoidKey){
    const now = Date.now();
    const learnNow = learningKeys().filter(k => progress[k].due <= now);
    const l = earliest(learnNow, avoidKey);
    if (l && (l !== avoidKey || (!session.reviewQ.length && !session.newQ.length))) return { key:l, kind:'learn' };

    // spread new cards evenly among reviews
    const total = session.reviewQ.length + session.newQ.length;
    if (total) {
      const debt = session.newDebt + session.newQ.length / total;
      const preferNew = debt >= 1 || !session.reviewQ.length;
      let k = preferNew ? takeNew(false) : takeReview();
      let kind = preferNew ? 'new' : 'review';
      if (!k) { k = preferNew ? takeReview() : takeNew(false); kind = preferNew ? 'review' : 'new'; }
      if (k) {
        session.newDebt = kind === 'new' ? Math.max(0, debt - 1) : debt;
        return { key:k, kind };
      }
    }

    const ahead = earliest(learningDueSoon(now), avoidKey);
    if (ahead && ahead !== avoidKey) return { key:ahead, kind:'learn' };
    // last resort: a reverse card right after its forward side, or the same learning card again
    const k = takeNew(true);
    if (k) return { key:k, kind:'new' };
    return ahead ? { key:ahead, kind:'learn' } : null;
  }

  function sessionCounts(){
    // the current card is included in its own count, as in Anki
    const c = session.current;
    return {
      new: session.newQ.filter(k => !progress[k]).length + (c && c.kind === 'new' ? 1 : 0),
      learn: learningDueSoon().length,
      review: session.reviewQ.length + (c && c.kind === 'review' ? 1 : 0),
    };
  }

  // ---------- Screens ----------
  const screens = {
    home: document.getElementById('screen-home'),
    study: document.getElementById('screen-study'),
    done: document.getElementById('screen-done'),
    stats: document.getElementById('screen-stats'),
    chapters: document.getElementById('screen-chapters'),
  };
  const BACK_ENABLED_SCREENS = ['study','stats','chapters'];

  let currentScreenName = 'home';
  function showScreen(name){
    currentScreenName = name;
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
    document.querySelectorAll('.back-btn-inpage').forEach(b => b.classList.add('hidden'));
    if (BACK_ENABLED_SCREENS.includes(name)) {
      if (tg && tg.BackButton) tg.BackButton.show();
      else screens[name].querySelectorAll('.back-btn-inpage').forEach(b => b.classList.remove('hidden'));
    } else if (tg && tg.BackButton) {
      tg.BackButton.hide();
    }
  }
  if (tg && tg.BackButton) tg.BackButton.onClick(() => goHome());
  document.querySelectorAll('[data-back]').forEach(btn => btn.addEventListener('click', goHome));

  function goHome(){ renderHome(); showScreen('home'); }

  // ---------- Render: Home ----------
  function renderHome(){
    rollDailyMeta();
    const due = dueReviewKeys().length + learningDueSoon().length;
    const freshForwardCount = newForwardWords().length;
    const freshAvailable = newKeysForToday().length;
    const sessionSize = due + freshAvailable;

    document.getElementById('due-count').textContent = sessionSize;
    const learnedCount = pool(WORDS).filter(w => progress[cardKey(w.id,'fwd')]).length;
    document.getElementById('stat-learned').textContent = learnedCount;
    document.getElementById('stat-total').textContent = pool(WORDS).length;
    document.getElementById('stat-streak').textContent = streak.count || 0;

    let label;
    if (sessionSize === 0) {
      const later = learningKeys();
      if (later.length) {
        const mins = Math.max(1, Math.ceil((progress[earliest(later)].due - Date.now()) / 60000));
        label = `ещё ${later.length} ${pluralWords(later.length)} на изучении — вернутся через ${mins} мин`;
      } else {
        label = freshForwardCount > 0 ? 'дневной лимит новых слов исчерпан' : 'на сегодня всё повторено 🎉';
      }
    }
    else if (due === 0) label = 'новых слов готово к изучению';
    else if (freshAvailable === 0) label = 'слов к повторению сегодня';
    else label = 'слов к повторению и изучению';
    document.getElementById('hero-label').textContent = label;
    document.getElementById('btn-start').classList.toggle('hidden', sessionSize === 0);

    document.getElementById('section-summary').textContent = selectionSummaryText();
  }

  // ---------- Render: Chapters / sections screen ----------
  function renderChaptersScreen(){
    document.getElementById('check-all').classList.toggle('checked', settings.selection.length === 0);

    const container = document.getElementById('chapters-list');
    container.innerHTML = '';

    CHAPTERS_DATA.forEach(([vol, chapters]) => {
      const label = document.createElement('div');
      label.className = 'vol-group-label';
      label.textContent = vol === 1 ? 'Том I' : 'Том II';
      container.appendChild(label);

      chapters.forEach(([ch, title, count, dialogues]) => {
        const chapterSelected = settings.selection.some(s => s.vol===vol && s.ch===ch && s.dlg==null);

        const block = document.createElement('div');
        block.className = 'chapter-block';

        const row = document.createElement('div');
        row.className = 'chapter-row';
        row.innerHTML =
          `<span class="check-circle check-square${chapterSelected?' checked':''}"></span>` +
          `<div class="chapter-row-text">` +
            `<div class="chapter-row-title">Глава ${ch}. ${title}</div>` +
            `<div class="chapter-row-count">${count} ${pluralWords(count)}</div>` +
          `</div>`;
        row.addEventListener('click', () => toggleChapter(vol, ch));
        block.appendChild(row);

        dialogues.forEach(([dlg, dcount]) => {
          const dSelected = chapterSelected || settings.selection.some(s => s.vol===vol && s.ch===ch && s.dlg===dlg);
          const dRow = document.createElement('div');
          dRow.className = 'dialogue-row';
          dRow.innerHTML =
            `<span class="check-circle${dSelected?' checked':''}"></span>` +
            `<span class="dialogue-row-text">Диалог ${dlg}</span>` +
            `<span class="dialogue-row-count">${dcount}</span>`;
          dRow.addEventListener('click', (e) => { e.stopPropagation(); toggleDialogue(vol, ch, dlg); });
          block.appendChild(dRow);
        });

        container.appendChild(block);
      });
    });
  }

  function toggleChapter(vol, ch){
    const idx = settings.selection.findIndex(s => s.vol===vol && s.ch===ch && s.dlg==null);
    if (idx >= 0) {
      settings.selection.splice(idx,1);
    } else {
      settings.selection = settings.selection.filter(s => !(s.vol===vol && s.ch===ch));
      settings.selection.push({ vol, ch, dlg:null });
    }
    saveSettings();
    renderChaptersScreen();
    renderHome();
  }

  function toggleDialogue(vol, ch, dlg){
    const chapterIdx = settings.selection.findIndex(s => s.vol===vol && s.ch===ch && s.dlg==null);
    if (chapterIdx >= 0) {
      // whole chapter was selected — split into individual dialogues, minus the one just unchecked
      settings.selection.splice(chapterIdx,1);
      const entry = findChapterEntry(vol, ch);
      if (entry) entry[3].forEach(([d]) => { if (d !== dlg) settings.selection.push({ vol, ch, dlg:d }); });
    } else {
      const idx = settings.selection.findIndex(s => s.vol===vol && s.ch===ch && s.dlg===dlg);
      if (idx >= 0) settings.selection.splice(idx,1);
      else settings.selection.push({ vol, ch, dlg });
    }
    saveSettings();
    renderChaptersScreen();
    renderHome();
  }

  // ---------- Render: Study ----------
  function escapeHtml(s){
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function setWordDisplay(el, text, isArabic){
    el.textContent = text;
    el.classList.toggle('is-arabic', isArabic);
  }

  function renderContext(w){
    const ctxEl = document.getElementById('card-context');
    if (w.ctx) {
      const [sentence, start, end] = w.ctx;
      ctxEl.innerHTML = escapeHtml(sentence.slice(0,start)) + '<mark>' + escapeHtml(sentence.slice(start,end)) + '</mark>' + escapeHtml(sentence.slice(end));
      ctxEl.classList.remove('hidden');
    } else {
      ctxEl.innerHTML = '';
      ctxEl.classList.add('hidden');
    }
  }

  function renderStudyTopbar(){
    const c = sessionCounts();
    const kind = session.current && session.current.kind;
    [['new','count-new'], ['learn','count-learn'], ['review','count-review']].forEach(([k, id]) => {
      const el = document.getElementById(id);
      el.textContent = c[k];
      el.classList.toggle('active', kind === k);
    });
    const remaining = c.new + c.learn + c.review;
    document.getElementById('study-progress-fill').style.width =
      Math.round(100 * session.answered / Math.max(1, session.answered + remaining)) + '%';
  }

  function renderCurrentCard(){
    const { key } = session.current;
    const { word:w, dir } = parseCardKey(key);
    const p = progress[key];

    document.getElementById('card-vol-kicker').textContent =
      `Том ${w.vol===2?'II':'I'} · Глава ${w.ch}` + (p && p.leech ? ' · трудное слово' : '');

    const frontText = dir === 'rev' ? w.ru : w.ar;
    const answerText = dir === 'rev' ? w.ar : w.ru;

    setWordDisplay(document.getElementById('card-front-word'), frontText, dir !== 'rev');
    setWordDisplay(document.getElementById('card-back-prompt'), frontText, dir !== 'rev');
    setWordDisplay(document.getElementById('card-back-answer'), answerText, dir === 'rev');

    document.getElementById('tap-hint').textContent =
      dir === 'rev' ? 'Нажмите, чтобы увидеть слово на арабском' : 'Нажмите, чтобы посмотреть перевод';

    renderContext(w);

    document.getElementById('card-back').classList.add('hidden');
    document.querySelector('.card-front').classList.remove('hidden');
    document.getElementById('grade-row').classList.add('hidden');

    renderStudyTopbar();
  }

  function flipCard(){
    if (!document.getElementById('card-back').classList.contains('hidden')) return;
    // show on each button when the word will come back, as Anki does
    const now = Date.now();
    document.querySelectorAll('.grade-btn').forEach(btn => {
      const next = scheduleCard(session.current.key, parseInt(btn.dataset.grade,10), now);
      btn.querySelector('.grade-ivl').textContent = formatInterval(next, now);
    });
    document.querySelector('.card-front').classList.add('hidden');
    document.getElementById('card-back').classList.remove('hidden');
    document.getElementById('grade-row').classList.remove('hidden');
    haptic('light');
  }

  function bumpStreak(){
    const t = todayStr();
    if (streak.lastDate === t) return;
    streak.count = (streak.lastDate === dayKey(today() - 1)) ? (streak.count||0) + 1 : 1;
    streak.lastDate = t;
    saveStreak();
  }

  async function onGrade(grade){
    const { key } = session.current;
    const { word:w, dir } = parseCardKey(key);
    const wasNew = !progress[key];
    // only forward cards count against the daily new-word pace — reverse
    // cards are practice on already-learned words, not new vocabulary
    const countsAgainstQuota = wasNew && dir === 'fwd';

    // snapshot everything needed to fully undo this grade
    session.lastAction = {
      cardKey: key,
      prevProgress: progress[key] ? JSON.parse(JSON.stringify(progress[key])) : null,
      countsAgainstQuota,
      prevStreak: Object.assign({}, streak),
      session: JSON.stringify({
        reviewQ: session.reviewQ, newQ: session.newQ, newDebt: session.newDebt, recent: session.recent,
        current: session.current, answered: session.answered, stats: session.stats,
      }),
    };

    if (countsAgainstQuota) {
      dailyMeta.introduced += 1;
      saveDaily();
    }

    const before = progress[key];
    const result = gradeCard(key, grade);
    session.answered += 1;
    session.recent = session.recent.concat(key).slice(-SIBLING_GAP);
    session.stats.reviewed += 1;
    if (wasNew) session.stats.new += 1;
    if (grade === 0) { session.stats.again += 1; haptic('warning'); }
    else haptic('success');
    bumpStreak();

    // the forward side just graduated -> its reverse card becomes available
    const graduated = dir === 'fwd' && (!before || before.learning) && !result.learning;
    const revKey = cardKey(w.id, 'rev');
    if (graduated && settings.reverseEnabled && !progress[revKey] && !session.newQ.includes(revKey)) {
      session.newQ.push(revKey);
    }

    updateUndoButton();
    session.current = pickNext(key);
    if (!session.current) await finishSession();
    else renderCurrentCard();
  }

  function undoLastGrade(){
    const action = session && session.lastAction;
    if (!action) return;

    if (action.prevProgress) {
      progress[action.cardKey] = action.prevProgress;
      saveCardProgress(action.cardKey);
    } else {
      delete progress[action.cardKey];
      Storage.removeItem('p_' + action.cardKey);
    }

    if (action.countsAgainstQuota) {
      dailyMeta.introduced = Math.max(0, dailyMeta.introduced - 1);
      saveDaily();
    }
    streak = action.prevStreak;
    saveStreak();

    Object.assign(session, JSON.parse(action.session));
    session.lastAction = null;
    updateUndoButton();
    showScreen('study');
    renderCurrentCard();
    haptic('light');
  }

  function updateUndoButton(){
    const show = !!(session && session.lastAction);
    document.querySelectorAll('.js-undo').forEach(b => b.classList.toggle('hidden', !show));
  }

  async function finishSession(){
    document.getElementById('done-sub').textContent =
      `Вы повторили ${session.stats.reviewed} ${pluralWords(session.stats.reviewed)}`;
    document.getElementById('done-new').textContent = session.stats.new;
    document.getElementById('done-reviewed').textContent = session.stats.reviewed;
    document.getElementById('done-again').textContent = session.stats.again;

    showScreen('done');
  }

  function startSession(){
    rollDailyMeta();
    session = startSessionQueues();
    session.current = pickNext(null);
    if (!session.current) { renderHome(); return; }
    showScreen('study');
    renderCurrentCard();
    updateUndoButton();
  }

  // ---------- Render: Stats ----------
  function renderStats(){
    let nNew=0, nLearning=0, nReview=0, nMastered=0;
    WORDS.forEach(w => {
      const s = cardState(cardKey(w.id,'fwd'));
      if (s==='new') nNew++;
      else if (s==='learning') nLearning++;
      else if (s==='mastered') nMastered++;
      else nReview++;
    });
    document.getElementById('s-new').textContent = nNew;
    document.getElementById('s-learning').textContent = nLearning;
    document.getElementById('s-review').textContent = nReview;
    document.getElementById('s-mastered').textContent = nMastered;

    let rLocked=0, rNew=0, rLearning=0, rReview=0, rMastered=0;
    WORDS.forEach(w => {
      if (!reverseUnlocked(w)) { rLocked++; return; }
      const s = cardState(cardKey(w.id,'rev'));
      if (s==='new') rNew++;
      else if (s==='learning') rLearning++;
      else if (s==='mastered') rMastered++;
      else rReview++;
    });
    document.getElementById('s-rev-locked').textContent = rLocked;
    document.getElementById('s-rev-new').textContent = rNew;
    document.getElementById('s-rev-learning').textContent = rLearning;
    document.getElementById('s-rev-review').textContent = rReview;
    document.getElementById('s-rev-mastered').textContent = rMastered;

    const v1Learned = WORDS.filter(w=>w.vol===1 && progress[cardKey(w.id,'fwd')]).length;
    const v2Learned = WORDS.filter(w=>w.vol===2 && progress[cardKey(w.id,'fwd')]).length;
    document.getElementById('s-vol1').textContent = `${v1Learned} / ${TOTAL_VOL1}`;
    document.getElementById('s-vol2').textContent = `${v2Learned} / ${TOTAL_VOL2}`;

    document.getElementById('daily-limit').value = String(settings.dailyLimit);
    document.getElementById('toggle-reverse').checked = settings.reverseEnabled;
  }

  // ---------- Event wiring ----------
  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-stats').addEventListener('click', () => { renderStats(); showScreen('stats'); });
  document.getElementById('btn-done-home').addEventListener('click', goHome);
  document.getElementById('flashcard').addEventListener('click', flipCard);
  document.querySelectorAll('.js-undo').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); undoLastGrade(); }));

  document.getElementById('btn-sections').addEventListener('click', () => { renderChaptersScreen(); showScreen('chapters'); });
  document.getElementById('btn-all-chapters').addEventListener('click', () => {
    settings.selection = [];
    saveSettings();
    renderChaptersScreen();
    renderHome();
  });

  document.querySelectorAll('.grade-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onGrade(parseInt(btn.dataset.grade,10));
    });
  });

  document.getElementById('daily-limit').addEventListener('change', (e) => {
    settings.dailyLimit = parseInt(e.target.value, 10);
    saveSettings();
  });

  document.getElementById('toggle-reverse').addEventListener('change', (e) => {
    settings.reverseEnabled = e.target.checked;
    saveSettings();
    renderHome();
  });

  // ---------- Support link ----------
  // Set this to your bot's @username (without the @) once you've deployed
  // the relay in api/bot-webhook.js — see README.md for setup steps.
  const SUPPORT_BOT_USERNAME = 'huna_arabic_appbot';

  document.getElementById('btn-support').addEventListener('click', () => {
    const url = `https://t.me/${SUPPORT_BOT_USERNAME}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  });

  document.getElementById('btn-reset').addEventListener('click', async () => {
    const ok = window.confirm('Весь прогресс изучения будет удалён без возможности восстановления. Продолжить?');
    if (!ok) return;
    await Storage.clearAll();
    progress = {};
    dailyMeta = { date: todayStr(), introduced: 0 };
    streak = { lastDate:null, count:0 };
    settings = { dailyLimit:15, selection:[], reverseEnabled:true };
    renderStats();
    renderHome();
  });

  // ---------- Boot ----------
  (async function init(){
    await loadAll();
    renderHome();
    showScreen('home');
  })();

  // Telegram's WebView can freeze the page while the Mini App is backgrounded
  // and occasionally repaints only a stale layer when it resumes. Force a
  // fresh render of whatever screen is active so the person never has to
  // manually reload the app to see live content again.
  function refreshCurrentScreen(){
    if (currentScreenName === 'home') renderHome();
    else if (currentScreenName === 'stats') renderStats();
    else if (currentScreenName === 'chapters') renderChaptersScreen();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshCurrentScreen();
  });
  window.addEventListener('pageshow', refreshCurrentScreen);
  if (tg && tg.onEvent) {
    tg.onEvent('activated', refreshCurrentScreen);
  }

})();

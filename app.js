/* ============================================================
   Huna Arabic flashcards — app logic
   WORDS_DATA is provided by words-data.js as:
     [ [id, vol, arabicWithTashkeel, russianTranslation], ... ]
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

  // ---------- Storage abstraction: Telegram CloudStorage w/ localStorage fallback ----------
  const Storage = {
    useCloud: !!(tg && tg.CloudStorage),

    getItem(key){
      return new Promise((resolve) => {
        if (this.useCloud) {
          tg.CloudStorage.getItem(key, (err, value) => resolve(err ? null : (value || null)));
        } else {
          resolve(localStorage.getItem(key));
        }
      });
    },
    setItem(key, value){
      return new Promise((resolve) => {
        if (this.useCloud) {
          tg.CloudStorage.setItem(key, value, () => resolve(true));
        } else {
          localStorage.setItem(key, value);
          resolve(true);
        }
      });
    },
    removeItem(key){
      return new Promise((resolve) => {
        if (this.useCloud) {
          tg.CloudStorage.removeItem(key, () => resolve(true));
        } else {
          localStorage.removeItem(key);
          resolve(true);
        }
      });
    },
    getKeys(){
      return new Promise((resolve) => {
        if (this.useCloud) {
          tg.CloudStorage.getKeys((err, keys) => resolve(err ? [] : (keys || [])));
        } else {
          resolve(Object.keys(localStorage));
        }
      });
    },
    getItems(keys){
      return new Promise((resolve) => {
        if (keys.length === 0) return resolve({});
        if (this.useCloud) {
          // CloudStorage.getItems has a practical batch limit; chunk to be safe.
          const chunks = [];
          for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i+100));
          const out = {};
          let done = 0;
          chunks.forEach(chunk => {
            tg.CloudStorage.getItems(chunk, (err, values) => {
              if (!err && values) Object.assign(out, values);
              done++;
              if (done === chunks.length) resolve(out);
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

  // ---------- Word data ----------
  const WORDS = WORDS_DATA.map(w => ({ id:w[0], vol:w[1], ar:w[2], ru:w[3] }));
  const WORDS_BY_ID = {}; WORDS.forEach(w => WORDS_BY_ID[w.id] = w);
  const TOTAL_VOL1 = WORDS.filter(w=>w.vol===1).length;
  const TOTAL_VOL2 = WORDS.filter(w=>w.vol===2).length;

  const DAY_MS = 86400000;
  const todayStr = () => new Date().toISOString().slice(0,10);

  // ---------- App state ----------
  let progress = {};      // id -> {r(eps), i(nterval days), ef, due(ms), lapses}
  let settings = { dailyLimit: 15, volFilter: 'all' };
  let dailyMeta = { date: todayStr(), introduced: 0 };
  let streak = { lastDate: null, count: 0 };

  let session = null; // {queue:[{word, isNew}], idx, flipped, stats:{new,reviewed,again}}

  // ---------- Load / persist ----------
  async function loadAll(){
    const keys = await Storage.getKeys();
    const progKeys = keys.filter(k => k.startsWith('p_'));
    const misc = await Storage.getItems(['daily','streak','settings']);
    const progVals = await Storage.getItems(progKeys);

    progress = {};
    for (const k in progVals) {
      try { progress[k.slice(2)] = JSON.parse(progVals[k]); } catch(e){}
    }
    if (misc.daily) { try { dailyMeta = JSON.parse(misc.daily); } catch(e){} }
    if (misc.streak) { try { streak = JSON.parse(misc.streak); } catch(e){} }
    if (misc.settings) { try { settings = Object.assign(settings, JSON.parse(misc.settings)); } catch(e){} }

    if (dailyMeta.date !== todayStr()) dailyMeta = { date: todayStr(), introduced: 0 };
  }

  function saveCardProgress(id){
    return Storage.setItem('p_'+id, JSON.stringify(progress[id]));
  }
  function saveDaily(){ return Storage.setItem('daily', JSON.stringify(dailyMeta)); }
  function saveStreak(){ return Storage.setItem('streak', JSON.stringify(streak)); }
  function saveSettings(){ return Storage.setItem('settings', JSON.stringify(settings)); }

  // ---------- SRS logic (simplified SM-2 / Anki-style) ----------
  function isDue(id){
    const p = progress[id];
    if (!p) return false;
    return p.due <= Date.now();
  }
  function cardState(id){
    const p = progress[id];
    if (!p) return 'new';
    if (p.r === 0) return 'learning';
    if (p.i >= 21) return 'mastered';
    return 'review';
  }

  function gradeCard(id, grade){
    // grade: 0 Again, 1 Hard, 2 Good, 3 Easy
    let p = progress[id];
    if (!p) p = { r:0, i:0, ef:2.5, due:Date.now(), lapses:0 };

    if (grade === 0) {
      p.lapses += 1;
      p.r = 0;
      p.i = 0;
      p.due = Date.now() + 10*60*1000; // resurface within ~10 min (same session, via requeue)
    } else {
      if (p.r === 0) {
        p.i = grade === 1 ? 1 : (grade === 2 ? 1 : 4);
      } else {
        if (grade === 1) { p.i = Math.max(1, p.i * 1.2); p.ef = Math.max(1.3, p.ef - 0.15); }
        else if (grade === 2) { p.i = Math.max(1, p.i * p.ef); }
        else { p.i = Math.max(1, p.i * p.ef * 1.3); p.ef = Math.min(2.8, p.ef + 0.15); }
      }
      p.r += 1;
      p.due = Date.now() + p.i * DAY_MS;
    }
    progress[id] = p;
    saveCardProgress(id);
    return p;
  }

  // ---------- Pools ----------
  function poolByVolFilter(list){
    if (settings.volFilter === 'all') return list;
    const v = parseInt(settings.volFilter,10);
    return list.filter(w => w.vol === v);
  }
  function dueWords(){
    return poolByVolFilter(WORDS).filter(w => isDue(w.id));
  }
  function newWords(){
    return poolByVolFilter(WORDS).filter(w => !progress[w.id]);
  }

  function shuffle(arr){
    const a = arr.slice();
    for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  }

  function buildSessionQueue(){
    const due = shuffle(dueWords());
    const remainingNewQuota = Math.max(0, settings.dailyLimit - dailyMeta.introduced);
    const fresh = newWords().slice(0, remainingNewQuota);

    const queue = due.map(w => ({ word:w, isNew:false }));
    // interleave new cards roughly every 3rd slot
    fresh.forEach((w, i) => {
      const pos = Math.min(queue.length, (i+1)*3 + i);
      queue.splice(pos, 0, { word:w, isNew:true });
    });
    return queue;
  }

  // ---------- Screens ----------
  const screens = {
    home: document.getElementById('screen-home'),
    study: document.getElementById('screen-study'),
    done: document.getElementById('screen-done'),
    stats: document.getElementById('screen-stats'),
  };
  function showScreen(name){
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
    document.querySelectorAll('.back-btn-inpage').forEach(b => b.classList.add('hidden'));
    if (name === 'study' || name === 'stats') {
      if (tg && tg.BackButton) {
        tg.BackButton.show();
      } else {
        screens[name].querySelectorAll('.back-btn-inpage').forEach(b => b.classList.remove('hidden'));
      }
    } else if (tg && tg.BackButton) {
      tg.BackButton.hide();
    }
  }
  if (tg && tg.BackButton) {
    tg.BackButton.onClick(() => goHome());
  }
  document.querySelectorAll('[data-back]').forEach(btn => btn.addEventListener('click', goHome));

  function goHome(){
    renderHome();
    showScreen('home');
  }

  // ---------- Render: Home ----------
  function renderHome(){
    const due = dueWords().length;
    const remainingQuota = Math.max(0, settings.dailyLimit - dailyMeta.introduced);
    const freshAvailable = Math.min(newWords().length, remainingQuota);
    const sessionSize = due + freshAvailable;

    document.getElementById('due-count').textContent = sessionSize;
    const learnedCount = poolByVolFilter(WORDS).filter(w => progress[w.id]).length;
    document.getElementById('stat-learned').textContent = learnedCount;
    document.getElementById('stat-total').textContent = poolByVolFilter(WORDS).length;
    document.getElementById('stat-streak').textContent = streak.count || 0;

    let label;
    if (sessionSize === 0) {
      label = newWords().length > 0
        ? 'дневной лимит новых слов исчерпан'
        : 'на сегодня всё повторено 🎉';
    }
    else if (due === 0) label = 'новых слов готово к изучению';
    else if (freshAvailable === 0) label = 'слов к повторению сегодня';
    else label = 'слов к повторению и изучению';
    document.getElementById('hero-label').textContent = label;

    document.getElementById('btn-start').classList.toggle('hidden', sessionSize === 0);

    document.querySelectorAll('.vol-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.vol === settings.volFilter);
    });
  }

  // ---------- Render: Study ----------
  function renderCurrentCard(){
    const item = session.queue[session.idx];
    const w = item.word;
    document.getElementById('card-vol-kicker').textContent = w.vol === 2 ? 'Том II' : 'Том I';
    document.getElementById('card-arabic').textContent = w.ar;
    document.getElementById('card-arabic-2').textContent = w.ar;
    document.getElementById('card-translation').textContent = w.ru;

    document.getElementById('card-back').classList.add('hidden');
    document.querySelector('.card-front').classList.remove('hidden');
    document.getElementById('grade-row').classList.add('hidden');
    session.flipped = false;

    document.getElementById('study-idx').textContent = session.idx + 1;
    document.getElementById('study-total').textContent = session.queue.length;
    document.getElementById('study-progress-fill').style.width =
      Math.round(100 * session.idx / session.queue.length) + '%';
  }

  function flipCard(){
    if (session.flipped) return;
    session.flipped = true;
    document.querySelector('.card-front').classList.add('hidden');
    document.getElementById('card-back').classList.remove('hidden');
    document.getElementById('grade-row').classList.remove('hidden');
    haptic('light');
  }

  async function onGrade(grade){
    const item = session.queue[session.idx];
    const w = item.word;
    const wasNew = item.isNew;

    if (wasNew && !progress[w.id]) {
      dailyMeta.introduced += 1;
      saveDaily();
    }

    const result = gradeCard(w.id, grade);
    session.stats.reviewed += 1;
    if (wasNew) session.stats.new += 1;
    if (grade === 0) {
      session.stats.again += 1;
      haptic('warning');
      // requeue this card later in the session
      session.queue.push({ word:w, isNew:false });
    } else {
      haptic('success');
    }

    session.idx += 1;
    if (session.idx >= session.queue.length) {
      await finishSession();
    } else {
      renderCurrentCard();
    }
  }

  async function finishSession(){
    // update streak
    const today = todayStr();
    if (streak.lastDate !== today) {
      const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0,10);
      streak.count = (streak.lastDate === yesterday) ? (streak.count||0) + 1 : 1;
      streak.lastDate = today;
      await saveStreak();
    }

    document.getElementById('done-sub').textContent =
      `Вы повторили ${session.stats.reviewed} ${pluralWords(session.stats.reviewed)}`;
    document.getElementById('done-new').textContent = session.stats.new;
    document.getElementById('done-reviewed').textContent = session.stats.reviewed;
    document.getElementById('done-again').textContent = session.stats.again;

    showScreen('done');
  }

  function pluralWords(n){
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'слово';
    if ([2,3,4].includes(mod10) && ![12,13,14].includes(mod100)) return 'слова';
    return 'слов';
  }

  function startSession(){
    const queue = buildSessionQueue();
    if (queue.length === 0) {
      renderHome();
      return;
    }
    session = { queue, idx:0, flipped:false, stats:{ new:0, reviewed:0, again:0 } };
    showScreen('study');
    renderCurrentCard();
  }

  // ---------- Render: Stats ----------
  function renderStats(){
    let nNew=0, nLearning=0, nReview=0, nMastered=0;
    WORDS.forEach(w => {
      const s = cardState(w.id);
      if (s==='new') nNew++;
      else if (s==='learning') nLearning++;
      else if (s==='mastered') nMastered++;
      else nReview++;
    });
    document.getElementById('s-new').textContent = nNew;
    document.getElementById('s-learning').textContent = nLearning;
    document.getElementById('s-review').textContent = nReview;
    document.getElementById('s-mastered').textContent = nMastered;

    const v1Learned = WORDS.filter(w=>w.vol===1 && progress[w.id]).length;
    const v2Learned = WORDS.filter(w=>w.vol===2 && progress[w.id]).length;
    document.getElementById('s-vol1').textContent = `${v1Learned} / ${TOTAL_VOL1}`;
    document.getElementById('s-vol2').textContent = `${v2Learned} / ${TOTAL_VOL2}`;

    document.getElementById('daily-limit').value = String(settings.dailyLimit);
  }

  // ---------- Event wiring ----------
  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-stats').addEventListener('click', () => { renderStats(); showScreen('stats'); });
  document.getElementById('btn-done-home').addEventListener('click', goHome);
  document.getElementById('flashcard').addEventListener('click', flipCard);

  document.querySelectorAll('.grade-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onGrade(parseInt(btn.dataset.grade,10));
    });
  });

  document.querySelectorAll('.vol-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      settings.volFilter = chip.dataset.vol;
      saveSettings();
      renderHome();
    });
  });

  document.getElementById('daily-limit').addEventListener('change', (e) => {
    settings.dailyLimit = parseInt(e.target.value, 10);
    saveSettings();
  });

  document.getElementById('btn-reset').addEventListener('click', async () => {
    const ok = window.confirm('Весь прогресс изучения будет удалён без возможности восстановления. Продолжить?');
    if (!ok) return;
    await Storage.clearAll();
    progress = {};
    dailyMeta = { date: todayStr(), introduced: 0 };
    streak = { lastDate:null, count:0 };
    settings = { dailyLimit:15, volFilter:'all' };
    renderStats();
    renderHome();
  });

  // ---------- Boot ----------
  (async function init(){
    await loadAll();
    renderHome();
    showScreen('home');
  })();

})();

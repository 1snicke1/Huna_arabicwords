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
    useCloud: !!(tg && tg.CloudStorage),

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
  const WORDS = WORDS_DATA.map(w => ({ id:w[0], vol:w[1], ch:w[2], dlg:w[3], ar:w[4], ru:w[5] }));
  const TOTAL_VOL1 = WORDS.filter(w=>w.vol===1).length;
  const TOTAL_VOL2 = WORDS.filter(w=>w.vol===2).length;

  function findChapterEntry(vol, ch){
    const volEntry = CHAPTERS_DATA.find(e => e[0] === vol);
    if (!volEntry) return null;
    return volEntry[1].find(e => e[0] === ch) || null;
  }
  function chapterTitle(vol, ch){
    const e = findChapterEntry(vol, ch);
    return e ? e[1] : '';
  }

  const DAY_MS = 86400000;
  const todayStr = () => new Date().toISOString().slice(0,10);

  function pluralRu(n, one, few, many){
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if ([2,3,4].includes(mod10) && ![12,13,14].includes(mod100)) return few;
    return many;
  }
  const pluralWords = (n) => pluralRu(n, 'слово', 'слова', 'слов');

  // ---------- App state ----------
  // progress[id] = { learning, step, r(eps after graduating), i(nterval days), ef, due(ms), lapses }
  let progress = {};
  let settings = { dailyLimit: 15, selection: [] }; // selection: [{vol,ch,dlg|null}]
  let dailyMeta = { date: todayStr(), introduced: 0 };
  let streak = { lastDate: null, count: 0 };

  let session = null; // {queue:[{word,isNew}], idx, stats:{new,reviewed,again}}

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
    if (misc.settings) {
      try {
        const parsed = JSON.parse(misc.settings);
        settings = Object.assign({ dailyLimit:15, selection:[] }, parsed);
        if (!Array.isArray(settings.selection)) settings.selection = [];
      } catch(e){}
    }
    if (dailyMeta.date !== todayStr()) dailyMeta = { date: todayStr(), introduced: 0 };
  }

  function saveCardProgress(id){ return Storage.setItem('p_'+id, JSON.stringify(progress[id])); }
  function saveDaily(){ return Storage.setItem('daily', JSON.stringify(dailyMeta)); }
  function saveStreak(){ return Storage.setItem('streak', JSON.stringify(streak)); }
  function saveSettings(){ return Storage.setItem('settings', JSON.stringify(settings)); }

  // ---------- SRS logic ----------
  // Learning steps (minutes) a card must pass through after being new or after a lapse,
  // before it graduates into the long-term interval schedule. This guarantees a forgotten
  // word gets reinforced at least twice — once soon, once a few hours later — rather than
  // graduating to a multi-day gap after a single lucky guess.
  const LEARNING_STEPS_MIN = [10, 180]; // 10 minutes, then 3 hours

  function isDue(id){
    const p = progress[id];
    if (!p) return false;
    return p.due <= Date.now();
  }
  function cardState(id){
    const p = progress[id];
    if (!p) return 'new';
    if (p.learning) return 'learning';
    if (p.i >= 21) return 'mastered';
    return 'review';
  }

  function gradeCard(id, grade){
    // grade: 0 Again, 1 Hard, 2 Good, 3 Easy
    let p = progress[id];
    if (!p) p = { learning:true, step:0, r:0, i:0, ef:2.5, due:Date.now(), lapses:0 };

    if (grade === 0) {
      p.lapses += 1;
      p.learning = true;
      p.step = 0;
      p.due = Date.now() + LEARNING_STEPS_MIN[0]*60000;
    } else if (grade === 3 && p.learning) {
      // Easy skips remaining learning steps and graduates immediately
      p.learning = false;
      p.i = p.i > 0 ? Math.max(4, p.i * p.ef * 1.3) : 4;
      p.ef = Math.min(2.8, p.ef + 0.15);
      p.r += 1;
      p.due = Date.now() + p.i * DAY_MS;
    } else if (p.learning) {
      const nextStep = p.step + 1;
      if (nextStep < LEARNING_STEPS_MIN.length) {
        p.step = nextStep;
        p.due = Date.now() + LEARNING_STEPS_MIN[nextStep] * 60000;
        if (grade === 1) p.ef = Math.max(1.3, p.ef - 0.1);
      } else {
        p.learning = false;
        p.i = 1;
        p.r += 1;
        p.due = Date.now() + p.i * DAY_MS;
      }
    } else {
      if (grade === 1) { p.i = Math.max(1, p.i * 1.2); p.ef = Math.max(1.3, p.ef - 0.15); }
      else if (grade === 2) { p.i = Math.max(1, p.i * p.ef); }
      else { p.i = Math.max(1, p.i * p.ef * 1.3); p.ef = Math.min(2.8, p.ef + 0.15); }
      p.r += 1;
      p.due = Date.now() + p.i * DAY_MS;
    }

    progress[id] = p;
    saveCardProgress(id);
    return p;
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
  function dueWords(){ return pool(WORDS).filter(w => isDue(w.id)); }
  function newWords(){ return pool(WORDS).filter(w => !progress[w.id]); }

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

  function buildSessionQueue(){
    const due = shuffle(dueWords());
    const remainingNewQuota = Math.max(0, settings.dailyLimit - dailyMeta.introduced);
    const fresh = newWords().slice(0, remainingNewQuota);

    const queue = due.map(w => ({ word:w, isNew:false }));
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
    chapters: document.getElementById('screen-chapters'),
  };
  const BACK_ENABLED_SCREENS = ['study','stats','chapters'];

  function showScreen(name){
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
    const due = dueWords().length;
    const remainingQuota = Math.max(0, settings.dailyLimit - dailyMeta.introduced);
    const freshAvailable = Math.min(newWords().length, remainingQuota);
    const sessionSize = due + freshAvailable;

    document.getElementById('due-count').textContent = sessionSize;
    const learnedCount = pool(WORDS).filter(w => progress[w.id]).length;
    document.getElementById('stat-learned').textContent = learnedCount;
    document.getElementById('stat-total').textContent = pool(WORDS).length;
    document.getElementById('stat-streak').textContent = streak.count || 0;

    let label;
    if (sessionSize === 0) {
      label = newWords().length > 0 ? 'дневной лимит новых слов исчерпан' : 'на сегодня всё повторено 🎉';
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
  function renderCurrentCard(){
    const item = session.queue[session.idx];
    const w = item.word;
    document.getElementById('card-vol-kicker').textContent = `Том ${w.vol===2?'II':'I'} · Глава ${w.ch}`;
    document.getElementById('card-arabic').textContent = w.ar;
    document.getElementById('card-arabic-2').textContent = w.ar;
    document.getElementById('card-translation').textContent = w.ru;

    document.getElementById('card-back').classList.add('hidden');
    document.querySelector('.card-front').classList.remove('hidden');
    document.getElementById('grade-row').classList.add('hidden');

    document.getElementById('study-idx').textContent = session.idx + 1;
    document.getElementById('study-total').textContent = session.queue.length;
    document.getElementById('study-progress-fill').style.width =
      Math.round(100 * session.idx / session.queue.length) + '%';
  }

  function flipCard(){
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
    if (grade === 0) { session.stats.again += 1; haptic('warning'); }
    else haptic('success');

    // if the card is due again soon (short learning step), resurface it later in
    // THIS session rather than only relying on a future session
    if (result.due - Date.now() < 30*60*1000) {
      const insertPos = Math.min(session.queue.length, session.idx + 4 + Math.floor(Math.random()*4));
      session.queue.splice(insertPos, 0, { word:w, isNew:false });
    }

    session.idx += 1;
    if (session.idx >= session.queue.length) await finishSession();
    else renderCurrentCard();
  }

  async function finishSession(){
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

  function startSession(){
    const queue = buildSessionQueue();
    if (queue.length === 0) { renderHome(); return; }
    session = { queue, idx:0, stats:{ new:0, reviewed:0, again:0 } };
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

  document.getElementById('btn-reset').addEventListener('click', async () => {
    const ok = window.confirm('Весь прогресс изучения будет удалён без возможности восстановления. Продолжить?');
    if (!ok) return;
    await Storage.clearAll();
    progress = {};
    dailyMeta = { date: todayStr(), introduced: 0 };
    streak = { lastDate:null, count:0 };
    settings = { dailyLimit:15, selection:[] };
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

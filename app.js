/* =========================================================
   AuditCheck — client-side gap analysis
   ========================================================= */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    filesA: [],   // [{name, size, pages, words, text}]
    fileB:  null, // {name, size, pages, words, text}
    items:  [],   // [{id, text, keywords, status, score, evidence}]
    allItems: [], // unfiltered copy for filter/search
    startTime: 0,
  };

  // ------------------------------------------------------------------
  // Stopword set — small English list adequate for comparison
  // ------------------------------------------------------------------
  const STOPWORDS = new Set((
    'a an and are as at be been being but by can could did do does doing ' +
    'down each for from further had has have having he her here hers him ' +
    'himself his how i if in into is it its itself just me might more most ' +
    'must my myself no nor not now of off on once only or other our ours ' +
    'out over own same shall she should so some such than that the their ' +
    'theirs them themselves then there these they this those through to too ' +
    'under until up very was we were what when where which while who whom ' +
    'why will with would you your yours yourself yourselves also any may ' +
    'upon within without among across per via like such etc about above ' +
    'before after between both few many much one two three'
  ).split(/\s+/));

  // Words that signal policy / control / requirement content — used to
  // prioritize which sentences become checklist items.
  const SIGNAL = new Set((
    'shall must should required require requires policy procedure ' +
    'control standard guideline ensure ensures maintain maintains ' +
    'document documents documented review reviewed approve approved ' +
    'monitor monitored encrypt encrypted restrict restricted audit ' +
    'audited comply compliance access authentication authorization ' +
    'backup recovery logging incident response vendor training ' +
    'classification retention privacy security risk assessment ' +
    'change management rollback disaster continuity mfa key rotation'
  ).split(/\s+/));

  // ------------------------------------------------------------------
  // View switching
  // ------------------------------------------------------------------
  const views = {
    upload:     document.getElementById('view-upload'),
    processing: document.getElementById('view-processing'),
    dashboard:  document.getElementById('view-dashboard'),
  };
  function showView(name) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[name].classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ------------------------------------------------------------------
  // File reading (txt, md, pdf)
  // ------------------------------------------------------------------
  async function readFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return await readPdf(file);
    return await readText(file);
  }

  function readText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const text = String(r.result || '');
        resolve({ text, pages: Math.max(1, Math.ceil(text.length / 2500)) });
      };
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  async function readPdf(file) {
    if (!window.pdfjsLib) {
      throw new Error('PDF library not loaded');
    }
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map(it => it.str).join(' ') + '\n\n';
    }
    return { text: out, pages: pdf.numPages };
  }

  // ------------------------------------------------------------------
  // Upload UI wiring
  // ------------------------------------------------------------------
  function prettyBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function wordCount(s) {
    return (s.match(/[a-zA-Z][a-zA-Z'-]*/g) || []).length;
  }
  function fileBadge(name) {
    const ext = (name.split('.').pop() || '').toUpperCase();
    return ext.slice(0, 4);
  }

  function renderFilesA() {
    const ul = document.getElementById('filesA');
    ul.innerHTML = '';
    state.filesA.forEach((f, idx) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="file-badge">${fileBadge(f.name)}</span>
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-meta">${prettyBytes(f.size)} · ${f.pages} pg</span>
        <button class="file-remove" aria-label="remove">×</button>`;
      li.querySelector('.file-remove').addEventListener('click', () => {
        state.filesA.splice(idx, 1);
        renderFilesA(); updateStatus();
      });
      ul.appendChild(li);
    });

    const totalPages = state.filesA.reduce((s, f) => s + f.pages, 0);
    const totalWords = state.filesA.reduce((s, f) => s + f.words, 0);
    const totalSize  = state.filesA.reduce((s, f) => s + f.size, 0);
    document.getElementById('countA').textContent =
      state.filesA.length + (state.filesA.length === 1 ? ' FILE' : ' FILES');
    document.getElementById('statusA').textContent = state.filesA.length ? 'READY' : 'EMPTY';
    document.getElementById('footA').textContent =
      `${state.filesA.length} FILES · ${totalPages} PAGES`;
    document.getElementById('footAWords').textContent =
      `~${totalWords.toLocaleString()} WORDS · ${prettyBytes(totalSize)} TOTAL`;
  }

  function renderFileB() {
    const ul = document.getElementById('filesB');
    ul.innerHTML = '';
    if (state.fileB) {
      const f = state.fileB;
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="file-badge">${fileBadge(f.name)}</span>
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-meta">${prettyBytes(f.size)} · ${f.pages} pg · ~${f.words.toLocaleString()} words</span>
        <button class="file-remove" aria-label="remove">×</button>`;
      li.querySelector('.file-remove').addEventListener('click', () => {
        state.fileB = null; renderFileB(); updateStatus();
      });
      ul.appendChild(li);
    }
    document.getElementById('statusB').textContent = state.fileB ? 'UPLOADED' : 'EMPTY';
    document.getElementById('footB').textContent  = state.fileB ? 'READY FOR COMPARISON' : 'AWAITING FILE';
    document.getElementById('footBMeta').textContent = state.fileB ? '1 FILE' : '0 FILES';
  }

  function updateStatus() {
    const ready = state.filesA.length > 0 && !!state.fileB;
    document.getElementById('runBtn').disabled = !ready;
  }

  async function ingestFilesIntoA(fileList) {
    for (const file of fileList) {
      try {
        const { text, pages } = await readFile(file);
        state.filesA.push({
          name: file.name, size: file.size,
          pages, words: wordCount(text), text
        });
      } catch (err) {
        alert(`Could not read ${file.name}: ${err.message}`);
      }
    }
    renderFilesA(); updateStatus();
  }

  async function ingestFileIntoB(file) {
    try {
      const { text, pages } = await readFile(file);
      state.fileB = {
        name: file.name, size: file.size,
        pages, words: wordCount(text), text
      };
    } catch (err) {
      alert(`Could not read ${file.name}: ${err.message}`);
    }
    renderFileB(); updateStatus();
  }

  // Input wiring
  document.getElementById('inputA').addEventListener('change', e => {
    ingestFilesIntoA(Array.from(e.target.files));
    e.target.value = '';
  });
  document.getElementById('inputB').addEventListener('change', e => {
    const files = Array.from(e.target.files);
    if (files[0]) ingestFileIntoB(files[0]);
    e.target.value = '';
  });

  // Paste fallback
  document.getElementById('usePasteA').addEventListener('click', () => {
    const ta = document.getElementById('pasteA');
    const text = ta.value.trim();
    if (!text) return;
    state.filesA.push({
      name: `pasted-text-${state.filesA.length + 1}.txt`,
      size: text.length,
      pages: Math.max(1, Math.ceil(text.length / 2500)),
      words: wordCount(text),
      text
    });
    ta.value = '';
    renderFilesA(); updateStatus();
  });
  document.getElementById('usePasteB').addEventListener('click', () => {
    const ta = document.getElementById('pasteB');
    const text = ta.value.trim();
    if (!text) return;
    state.fileB = {
      name: 'pasted-target.txt',
      size: text.length,
      pages: Math.max(1, Math.ceil(text.length / 2500)),
      words: wordCount(text),
      text
    };
    ta.value = '';
    renderFileB(); updateStatus();
  });

  // Drag & drop on dropzones
  [
    { zone: document.querySelector('#panelA .dropzone'), handler: ingestFilesIntoA },
    { zone: document.querySelector('#panelB .dropzone'), handler: fs => ingestFileIntoB(fs[0]) },
  ].forEach(({ zone, handler }) => {
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); zone.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag');
    }));
    zone.addEventListener('drop', e => {
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) handler(files);
    });
  });

  // ------------------------------------------------------------------
  // NLP helpers
  // ------------------------------------------------------------------
  function normalize(s) {
    return s.toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function tokenize(s) {
    return (normalize(s).match(/[a-z][a-z'-]*/g) || []);
  }
  function stem(w) {
    // Very light stemmer: strip common suffixes so "encrypt" ≈ "encrypted"
    return w
      .replace(/(ing|ed|ly|ies|ied|es|s)$/g, '')
      .replace(/ion$/, '');
  }
  function keywordsOf(s) {
    const set = new Set();
    for (const t of tokenize(s)) {
      if (t.length < 3) continue;
      if (STOPWORDS.has(t)) continue;
      set.add(stem(t));
    }
    return set;
  }

  // Sentence split — handles ., !, ?, semicolons, newlines, and bullets
  function splitSentences(text) {
    const cleaned = text
      .replace(/\r/g, '')
      .replace(/\n\s*[\u2022•●·\-\*]\s+/g, '\n') // bullets -> newlines
      .replace(/\n{2,}/g, '\n');
    const parts = [];
    cleaned.split(/\n+/).forEach(line => {
      line.split(/(?<=[.!?;])\s+(?=[A-Z(])/).forEach(p => {
        const s = p.trim();
        if (s) parts.push(s);
      });
    });
    return parts;
  }

  // Pick key points from Doc A text — sentences that look like
  // requirements / controls / policy statements.
  function extractKeyPoints(text) {
    const sents = splitSentences(text);
    const out = [];
    const seen = new Set();
    for (let s of sents) {
      s = s.replace(/\s+/g, ' ').trim();
      if (s.length < 20 || s.length > 400) continue;
      const tokens = tokenize(s);
      if (tokens.length < 5) continue;

      const contentWords = tokens.filter(t => !STOPWORDS.has(t) && t.length >= 3);
      if (contentWords.length < 3) continue;

      // Prefer sentences that contain "signal" words — policy verbs etc.
      const hasSignal = tokens.some(t => SIGNAL.has(t) || SIGNAL.has(stem(t)));
      // Still keep others, but with a weight penalty
      const weight = hasSignal ? 1.0 : 0.5;

      const key = contentWords.slice(0, 8).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ text: s, weight });
    }
    // If nothing passed signal filter, relax and keep weight-0.5 items.
    // Cap at a sensible number.
    return out.slice(0, 300);
  }

  // Score a single key point against Doc B
  function scoreItem(itemKeywords, bSentences, bFullKeywordSet) {
    if (itemKeywords.size === 0) {
      return { score: 0, evidence: '' };
    }
    // Coverage across whole B
    let globalHits = 0;
    for (const k of itemKeywords) if (bFullKeywordSet.has(k)) globalHits++;
    const globalCov = globalHits / itemKeywords.size;

    // Best single B sentence
    let best = { score: 0, text: '' };
    for (const b of bSentences) {
      let hits = 0;
      for (const k of itemKeywords) if (b.kw.has(k)) hits++;
      const s = hits / itemKeywords.size;
      if (s > best.score) best = { score: s, text: b.text };
    }

    // Combine: 60% global coverage, 40% best-sentence concentration.
    // Global coverage ensures a single word can't dominate; best sentence
    // rewards topical concentration (a paragraph clearly about this point).
    const score = 0.6 * globalCov + 0.4 * best.score;
    return { score, evidence: best.score > 0 ? best.text : '' };
  }

  // ------------------------------------------------------------------
  // Pipeline with animated steps
  // ------------------------------------------------------------------
  function markStep(n, status) { // status: active | done
    const li = document.querySelector(`.pipeline li[data-step="${n}"]`);
    if (!li) return;
    li.classList.remove('active', 'done');
    if (status) li.classList.add(status);
  }
  function setStepStat(n, text) {
    const el = document.querySelector(`[data-stat-for="${n}"]`);
    if (el) el.textContent = text;
  }
  function setProgress(completed, total) {
    const pct = Math.round(100 * completed / total);
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progStepLabel').textContent =
      `${completed} of ${total} steps complete`;
  }
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  let elapsedTimer = null;
  function startElapsed() {
    state.startTime = Date.now();
    stopElapsed();
    elapsedTimer = setInterval(() => {
      document.getElementById('progElapsed').textContent =
        fmtElapsed(Date.now() - state.startTime);
    }, 200);
  }
  function stopElapsed() { if (elapsedTimer) clearInterval(elapsedTimer); }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function runPipeline() {
    showView('processing');
    startElapsed();

    // reset steps
    for (let i = 1; i <= 6; i++) { markStep(i, null); setStepStat(i, 'pending'); }
    setProgress(0, 6);

    // STEP 1 — text extraction (already done via upload, just format)
    markStep(1, 'active'); setStepStat(1, 'reading…'); await sleep(180);
    const docAText = state.filesA.map(f => f.text).join('\n\n');
    const docBText = state.fileB.text;
    setStepStat(1, `A: ${wordCount(docAText).toLocaleString()}w · B: ${wordCount(docBText).toLocaleString()}w`);
    markStep(1, 'done'); setProgress(1, 6);

    // STEP 2 — sentence splitting
    markStep(2, 'active'); setStepStat(2, 'tokenizing…'); await sleep(200);
    const aSents = splitSentences(docAText);
    const bSentsRaw = splitSentences(docBText);
    setStepStat(2, `A: ${aSents.length} · B: ${bSentsRaw.length}`);
    markStep(2, 'done'); setProgress(2, 6);

    // STEP 3 — key-point extraction
    markStep(3, 'active'); setStepStat(3, 'filtering…'); await sleep(220);
    const keyPoints = extractKeyPoints(docAText);
    setStepStat(3, `${keyPoints.length} points`);
    markStep(3, 'done'); setProgress(3, 6);

    // STEP 4 — build B keyword index
    markStep(4, 'active'); setStepStat(4, 'indexing…'); await sleep(200);
    const bSents = bSentsRaw
      .filter(s => s.length >= 15)
      .map(text => ({ text, kw: keywordsOf(text) }));
    const bFullKw = new Set();
    for (const b of bSents) for (const k of b.kw) bFullKw.add(k);
    setStepStat(4, `${bFullKw.size} unique terms`);
    markStep(4, 'done'); setProgress(4, 6);

    // STEP 5 — score every item
    markStep(5, 'active'); setStepStat(5, 'scoring…'); await sleep(150);
    const items = [];
    for (let i = 0; i < keyPoints.length; i++) {
      const kp = keyPoints[i];
      const kw = keywordsOf(kp.text);
      const { score, evidence } = scoreItem(kw, bSents, bFullKw);
      items.push({
        id: i + 1,
        text: kp.text,
        weight: kp.weight,
        keywords: [...kw],
        score,
        evidence,
        status: classify(score)
      });
      // Yield to UI every so often so bar can animate
      if (i % 40 === 0) await sleep(0);
    }
    setStepStat(5, `${items.length} scored`);
    markStep(5, 'done'); setProgress(5, 6);

    // STEP 6 — classify + render
    markStep(6, 'active'); setStepStat(6, 'rendering…'); await sleep(220);
    state.items = items;
    state.allItems = items.slice();
    renderDashboard();
    setStepStat(6, `${items.length} rendered`);
    markStep(6, 'done'); setProgress(6, 6);

    stopElapsed();
    await sleep(350);
    showView('dashboard');
  }

  function classify(score) {
    if (score >= 0.70) return 'matched';
    if (score >= 0.45) return 'partial';
    return 'missing';
  }

  // ------------------------------------------------------------------
  // Dashboard render
  // ------------------------------------------------------------------
  function renderDashboard() {
    const items = state.items;
    const total   = items.length;
    const matched = items.filter(i => i.status === 'matched').length;
    const partial = items.filter(i => i.status === 'partial').length;
    const missing = items.filter(i => i.status === 'missing').length;
    const coverage = total === 0 ? 0
      : Math.round(100 * (matched + 0.5 * partial) / total);

    // Title + id
    const now = new Date();
    const id = Math.random().toString(16).slice(2, 8).toUpperCase();
    document.getElementById('auditId').textContent =
      `AUDIT · #${id} · COMPLETED ${now.toLocaleString()}`;
    const srcName = state.filesA.length === 1
      ? state.filesA[0].name
      : `${state.filesA.length} source files`;
    document.getElementById('auditTitle').innerHTML =
      `${escapeHtml(srcName)} <em>vs</em> ${escapeHtml(state.fileB.name)}`;

    // KPIs
    document.getElementById('kpiTotal').textContent    = total;
    document.getElementById('kpiTotalFoot').textContent =
      `${total} checklist points extracted`;
    document.getElementById('kpiMatched').textContent  = matched;
    document.getElementById('kpiPartial').textContent  = partial;
    document.getElementById('kpiMissing').textContent  = missing;
    document.getElementById('kpiCoverage').textContent = coverage + '%';

    // Missing list — top 5 by weight then score ascending
    const missList = items
      .filter(i => i.status === 'missing')
      .sort((a, b) => (b.weight - a.weight) || (a.score - b.score))
      .slice(0, 5);
    const ml = document.getElementById('missingList');
    ml.innerHTML = '';
    if (missList.length === 0) {
      const li = document.createElement('li');
      li.style.borderLeftColor = 'var(--match)';
      li.innerHTML = `<div class="miss-title">No missing points</div>
        <div class="miss-kw">Document B covers all extracted checklist items.</div>`;
      ml.appendChild(li);
    } else {
      missList.forEach(it => {
        const li = document.createElement('li');
        li.innerHTML = `
          <div class="miss-title">${escapeHtml(truncate(it.text, 140))}</div>
          <div class="miss-kw">${escapeHtml(it.keywords.slice(0, 6).join(' · '))}</div>
          <div class="miss-score">score ${it.score.toFixed(2)}</div>`;
        ml.appendChild(li);
      });
    }

    // Status bars
    const maxCount = Math.max(matched, partial, missing, 1);
    document.getElementById('statusBars').innerHTML = `
      ${barRow('MATCHED', matched, maxCount, 'match')}
      ${barRow('PARTIAL', partial, maxCount, 'partial')}
      ${barRow('MISSING', missing, maxCount, 'miss')}
    `;

    // Checklist table
    renderTable();
  }

  function barRow(label, count, max, cls) {
    const pct = max === 0 ? 0 : Math.round(100 * count / max);
    const color = cls === 'match' ? 'var(--match)'
                : cls === 'partial' ? 'var(--partial)'
                : 'var(--miss)';
    return `<div class="sb-row">
      <div class="sb-label">${label}</div>
      <div class="sb-track"><div class="sb-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="sb-count">${count}</div>
    </div>`;
  }

  function renderTable() {
    const body = document.getElementById('checkBody');
    const q = (document.getElementById('search').value || '').trim().toLowerCase();
    const filter = document.querySelector('.pill.active').getAttribute('data-filter');

    // Sort: missing first, then partial, then matched. Within each, lower score first.
    const severity = { missing: 0, partial: 1, matched: 2 };
    const sorted = state.items.slice().sort((a, b) =>
      (severity[a.status] - severity[b.status]) || (a.score - b.score)
    );
    const filtered = sorted.filter(it => {
      if (filter !== 'all' && it.status !== filter) return false;
      if (q && !it.text.toLowerCase().includes(q) &&
              !(it.evidence || '').toLowerCase().includes(q)) return false;
      return true;
    });

    document.getElementById('itemCount').textContent = filtered.length;

    if (filtered.length === 0) {
      body.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--ink-soft)">No items match your filter.</td></tr>`;
      return;
    }

    body.innerHTML = filtered.map(it => {
      const evidence = it.evidence
        ? `<div class="evidence">“${escapeHtml(truncate(it.evidence, 180))}”</div>`
        : `<div class="evidence empty">— no supporting text in B —</div>`;
      return `<tr>
        <td class="num">${it.id.toString().padStart(3, '0')}</td>
        <td>${escapeHtml(it.text)}</td>
        <td><span class="badge ${it.status}">${it.status}</span></td>
        <td>${evidence}</td>
        <td class="score">${it.score.toFixed(2)}</td>
      </tr>`;
    }).join('');
  }

  // ------------------------------------------------------------------
  // Filter pills + search
  // ------------------------------------------------------------------
  document.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      renderTable();
    });
  });
  document.getElementById('search').addEventListener('input', renderTable);

  // ------------------------------------------------------------------
  // Dashboard action buttons
  // ------------------------------------------------------------------
  document.getElementById('btnRerun').addEventListener('click', runPipeline);
  document.getElementById('btnNew').addEventListener('click', () => {
    state.filesA = [];
    state.fileB = null;
    state.items = [];
    state.allItems = [];
    renderFilesA(); renderFileB(); updateStatus();
    showView('upload');
  });
  document.getElementById('btnExport').addEventListener('click', () => {
    const payload = {
      generated: new Date().toISOString(),
      sources: state.filesA.map(f => ({ name: f.name, words: f.words })),
      target: state.fileB ? { name: state.fileB.name, words: state.fileB.words } : null,
      items: state.items.map(i => ({
        id: i.id, status: i.status, score: +i.score.toFixed(3),
        text: i.text, evidence: i.evidence, keywords: i.keywords
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'auditcheck-report.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  // Run button
  document.getElementById('runBtn').addEventListener('click', runPipeline);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function truncate(s, n) {
    if (s.length <= n) return s;
    return s.slice(0, n - 1).trim() + '…';
  }

  // ------------------------------------------------------------------
  // Initial render
  // ------------------------------------------------------------------
  renderFilesA(); renderFileB(); updateStatus();
})();

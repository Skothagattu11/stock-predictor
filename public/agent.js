'use strict';
// Agent composer — turns a description into a reviewable list of changes.
// Nothing here writes: it posts to /parse, renders rows, and posts the rows the
// manager approved to /execute.

(function () {
  const $ = (id) => document.getElementById(id);
  const token = () => localStorage.getItem('wm_token') || '';

  let current = { proposalId: null, rows: [] };
  let lastInput = null;     // kept so a clarification answer can resend it

  function status(msg, busy) {
    $('agentStatus').textContent = msg || '';
    $('agentSendBtn').disabled = Boolean(busy);
  }

  async function post(path, body) {
    const res = await fetch(`/api/manager/agent/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ error: 'Bad response' }));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  let attached = null;    // data URL of the downscaled image

  const MAX_EDGE = 1568;  // beyond this the model gains nothing and you pay for it
  const MAX_FILE_BYTES = 25 * 1024 * 1024; // guard a huge/accidental file before it ever hits the canvas

  function downscale(file) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_FILE_BYTES) {
        reject(new Error('That image is too large (25MB max) — try a smaller screenshot.'));
        return;
      }
      const img = new Image();
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file'));
      reader.onload = () => { img.src = reader.result; };
      img.onerror = () => reject(new Error('That does not look like an image'));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      reader.readAsDataURL(file);
    });
  }

  window.agentAttach = async (el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (!file) return;
    try {
      attached = await downscale(file);
      document.getElementById('agentThumb').src = attached;
      document.getElementById('agentAttach').hidden = false;
      status('Screenshot attached — add a note if you like, then Send.');
    } catch (err) { status(err.message); }
  };

  window.agentClearAttach = () => {
    attached = null;
    document.getElementById('agentAttach').hidden = true;
  };

  let recorder = null;
  let chunks = [];
  let recordedAudio = null;   // data URL
  let activeStream = null;    // the getUserMedia stream for the live mic session, so any exit path can release it
  let micBusy = false;        // true from the getUserMedia prompt through onstop — blocks a re-entrant tap from starting a second recorder

  const MAX_RECORD_MS = 120000;   // a 2-minute cap; past that it is a document, not a note

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('Could not read the recording'));
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  }

  // Stops the mic stream (if any) and resets recording state/UI. Called from
  // every exit path — normal stop, the 2-minute cap, a recorder error, a
  // failed getUserMedia/MediaRecorder call, and page unload — so a stream
  // never outlives its session and leaks the browser's mic indicator.
  function releaseMic() {
    if (activeStream) activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
    micBusy = false;
    const btn = document.getElementById('agentMic');
    if (btn) { btn.classList.remove('recording'); btn.disabled = false; }
  }

  window.addEventListener('pagehide', releaseMic);

  window.agentMic = async () => {
    const btn = document.getElementById('agentMic');

    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }

    // Blocks a second tap while the permission prompt is in flight, or in the
    // brief window between calling stop() and onstop actually firing —
    // otherwise a fast double-tap could spin up two recorders on one stream.
    if (micBusy) return;

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      status('This browser cannot record audio — type the note instead.');
      return;
    }

    micBusy = true;
    btn.disabled = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      releaseMic();
      status('Microphone permission denied — type the note instead.');
      return;
    }
    activeStream = stream;
    btn.disabled = false;

    chunks = [];
    try {
      recorder = new MediaRecorder(stream);
    } catch (_) {
      releaseMic();
      status('Could not start recording — type the note instead.');
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const finishedRecorder = recorder;
      releaseMic();
      try {
        recordedAudio = await blobToDataUrl(new Blob(chunks, { type: finishedRecorder.mimeType || 'audio/webm' }));
        status('Recorded — press Send.');
      } catch (err) { status(err.message); }
    };
    recorder.onerror = () => {
      releaseMic();
      status('Recording failed — type the note instead.');
    };

    recorder.start();
    btn.classList.add('recording');
    status('Recording… tap the mic again to stop.');
    setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, MAX_RECORD_MS);
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const VERB = {
    createClient: 'Create client', updateClient: 'Update client', deleteClient: 'Delete client',
    createPortfolio: 'Create portfolio',
    addPosition: 'Add position', updatePosition: 'Update position',
    sellPosition: 'Sell position', deletePosition: 'Remove position',
  };

  function rowHtml(row, i) {
    const cls = !row.valid ? 'bad' : row.confidence < 0.6 ? 'warn' : '';
    const fields = Object.entries(row.fields || {})
      .filter(([k]) => k !== '_candidates')
      .map(([k, v]) => `<label>${esc(k)}
        <input data-row="${i}" data-field="${esc(k)}" value="${esc(v)}" oninput="agentEdit(this)" /></label>`)
      .join('');

    const candidates = row.fields && row.fields._candidates
      ? `<label>which record
           <select data-row="${i}" data-target="clientId" onchange="agentPick(this)">
             <option value="">choose…</option>
             ${String(row.fields._candidates).split(',').map((id) =>
               `<option value="${esc(id.trim())}">${esc(id.trim())}</option>`).join('')}
           </select></label>`
      : '';

    return `<div class="agent-row ${cls}">
      <input type="checkbox" data-check="${i}" ${row.valid ? 'checked' : ''} onchange="agentCount()" />
      <div class="agent-row-body">
        <div class="agent-op">${esc(VERB[row.op] || row.op)}</div>
        <div class="agent-src">${esc(row.source || row.reasoning || '')}</div>
        ${row.problems && row.problems.length ? `<div class="agent-problem">${esc(row.problems.join(' '))}</div>` : ''}
        <div class="agent-fields">${fields}${candidates}</div>
      </div>
    </div>`;
  }

  function render(out) {
    current = { proposalId: out.proposalId, rows: out.actions || [] };
    $('agentSummary').textContent = out.plan && out.plan.summary ? out.plan.summary : 'Proposed changes';
    $('agentRows').innerHTML = current.rows.map(rowHtml).join('') ||
      '<div class="agent-row"><div class="agent-row-body">Nothing actionable found in that.</div></div>';
    $('agentDrawer').hidden = false;
    agentCount();

    const clar = out.plan && out.plan.clarification;
    $('agentClarify').hidden = !clar;
    $('agentClarify').textContent = clar || '';
    if (out.plan && out.plan.transcript) status(`Heard: “${out.plan.transcript}”`);
  }

  window.agentEdit = (el) => {
    const row = current.rows[Number(el.dataset.row)];
    if (row) row.fields[el.dataset.field] = el.value;
  };

  window.agentPick = (el) => {
    const row = current.rows[Number(el.dataset.row)];
    if (!row) return;
    row.target = { ...row.target, [el.dataset.target]: el.value };
    row.valid = Boolean(el.value);
  };

  window.agentCount = () => {
    const n = document.querySelectorAll('#agentRows input[data-check]:checked').length;
    $('agentCount').textContent = `${n} selected`;
    $('agentRunBtn').disabled = n === 0;
  };

  window.agentApproveAll = (on) => {
    document.querySelectorAll('#agentRows input[data-check]').forEach((c) => { c.checked = on; });
    agentCount();
  };

  window.agentClose = () => {
    $('agentDrawer').hidden = true;
    // Closing also dismisses any pending clarification and drops the resend
    // context — otherwise the composer would keep treating whatever the
    // manager types next as an answer to a proposal they just dismissed,
    // silently merging it onto stale, unrelated input on the next Send.
    $('agentClarify').hidden = true;
    lastInput = null;
  };

  window.agentSend = async () => {
    const text = $('agentText').value.trim();
    const clarifying = !$('agentClarify').hidden;
    if (!text && !attached && !recordedAudio && !clarifying) return;

    // A clarification answer resends the original input with the reply appended,
    // so the manager never retypes and media is never re-uploaded.
    const body = clarifying && lastInput
      ? { ...lastInput, text: `${lastInput.text || ''}\n${text}`.trim() }
      : { text, image: attached, audio: recordedAudio, context: (window.agentContext ? window.agentContext() : {}) };

    status('Reading…', true);
    try {
      const out = await post('parse', body);
      lastInput = body;
      $('agentText').value = '';
      agentClearAttach();
      recordedAudio = null;
      render(out);
      status('');
    } catch (err) {
      status(err.message);       // input is left in the box on purpose
      $('agentSendBtn').disabled = false;
    }
  };

  window.agentExecute = async () => {
    const picked = [...document.querySelectorAll('#agentRows input[data-check]:checked')]
      .map((c) => current.rows[Number(c.dataset.check)]);
    if (!picked.length) return;

    $('agentRunBtn').disabled = true;
    status('Applying…', true);
    try {
      const out = await post('execute', { proposalId: current.proposalId, rows: picked });
      const ok = out.results.filter((r) => r.ok).length;
      const bad = out.results.filter((r) => !r.ok);

      $('agentRows').innerHTML = out.results.map((r) =>
        `<div class="agent-row ${r.ok ? '' : 'bad'}"><div class="agent-row-body">
           <div class="agent-op">${r.ok ? '✓' : '✕'} ${esc(VERB[r.op] || r.op)}</div>
           ${r.ok ? '' : `<div class="agent-problem">${esc(r.error)}</div>`}
         </div></div>`).join('');

      status(`${ok} applied${bad.length ? `, ${bad.length} failed` : ''}`);
      $('agentRunBtn').disabled = true;
      if (window.refreshAfterAgent) await window.refreshAfterAgent();
    } catch (err) {
      status(err.message);
      $('agentRunBtn').disabled = false;
    }
  };

  // True when focus sits in some other text-entry element (an <input>,
  // <textarea>, or contenteditable) that isn't the composer's own #agentText
  // — pasting an image there should behave like the ordinary paste that
  // element expects, not silently attach to the composer sitting behind it.
  function focusElsewhere() {
    const el = document.activeElement;
    if (!el || el.id === 'agentText') return false;
    const tag = (el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(el.isContentEditable);
  }

  // Ctrl+V a screenshot straight into the composer. Guarded against open
  // modals (client/portfolio/position/sell) and against any other text entry
  // (e.g. #clientSearch) having focus, so pasting into a field elsewhere on
  // the page can't silently attach an image to the agent composer sitting
  // behind it.
  document.addEventListener('paste', (e) => {
    if (document.querySelector('.modal-bg.open')) return;
    if (focusElsewhere()) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    downscale(file).then((url) => {
      attached = url;
      document.getElementById('agentThumb').src = url;
      document.getElementById('agentAttach').hidden = false;
      status('Screenshot pasted — press Send.');
    }).catch((err) => status(err.message));
  });
})();

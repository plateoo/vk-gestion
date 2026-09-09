// =====================================================================
// review.js — file « À contrôler » : document d'origine à gauche,
// champs extraits à droite, modifiables.
//
// Règle centrale : le taux de TVA est un champ à part entière, visible et
// modifiable. Il n'est jamais déduit en silence. S'il ne correspond pas au
// rapport TVA / HTVA lu sur le document, il passe en rouge et la
// validation est bloquée tant que Marie n'a pas tranché.
// =====================================================================
import { supabase } from './supabase.js';
import { getSuppliers, suppliersCache } from './suppliers.js';
import { invalidateInvoices } from './invoices.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage, confirmDialog,
  todayISO, notifyDataChange, ICONS, LEGAL_RATES, vatMismatch, longDate
} from './ui.js';
import { isManager } from './auth.js';

let queue = [];          // factures en attente de contrôle
let current = null;      // facture ouverte
let signedUrl = null;    // lien signé du document affiché
let confirmed = new Set(); // champs douteux explicitement confirmés par l'utilisateur

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
export async function loadReviewQueue() {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, supplier:suppliers(id, name, vat_number, needs_review)')
    .eq('review_status', 'a_controler')
    .order('created_at', { ascending: false });
  if (error) throw error;
  queue = (data || []).map((r) => ({ ...r, supplier_name: r.supplier?.name || '—', meta: parseNotes(r.extraction_notes) }));
  // Les extractions en échec passent devant : ce sont elles qui demandent le plus de travail.
  queue.sort((a, b) => (b.meta.failed ? 1 : 0) - (a.meta.failed ? 1 : 0));
  return queue;
}

function parseNotes(raw) {
  try {
    const n = JSON.parse(raw || '{}');
    return {
      notes: n.notes || null,
      failed: n.notes === 'échec extraction',
      source: n.source || null,
      alerts: Array.isArray(n.alerts) ? n.alerts : [],
      uncertain: Array.isArray(n.champs_incertains) ? n.champs_incertains : [],
      comment: n.commentaire || null,
      brut: n.brut || {}
    };
  } catch {
    return { notes: null, failed: false, source: null, alerts: [], uncertain: [], comment: null, brut: {} };
  }
}

export function reviewCount() { return queue.length; }

// ---------------------------------------------------------------------
// Rendu de la liste
// ---------------------------------------------------------------------
export async function renderReview() {
  const list = $('#review-list');
  list.innerHTML = '<div class="muted small" style="padding:12px">Chargement…</div>';
  try {
    await Promise.all([loadReviewQueue(), getSuppliers()]);
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="empty"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  updateBadge();
  renderCatchup();

  if (!queue.length) {
    list.innerHTML = `<div class="empty">${ICONS.empty}<p>Rien à contrôler</p></div>`;
    $('#review-detail').innerHTML = `<div class="empty"><p>Les factures arrivées par e-mail apparaîtront ici.</p></div>`;
    return;
  }

  list.innerHTML = queue.map((i) => {
    const problems = i.meta.failed ? 'échec extraction'
      : (i.meta.alerts.length ? i.meta.alerts[0] : (i.meta.uncertain.length ? 'champs incertains' : ''));
    return `
    <button type="button" class="review-item ${current?.id === i.id ? 'active' : ''}" data-review="${i.id}">
      <span class="ri-supplier">${escapeHtml(i.supplier_name)}</span>
      <span class="ri-num">${escapeHtml(i.invoice_number)}</span>
      <span class="ri-amount num">${fmtEUR(i.amount_tvac)}</span>
      ${problems ? `<span class="ri-flag">${escapeHtml(problems)}</span>` : ''}
    </button>`;
  }).join('');

  if (!current || !queue.some((i) => i.id === current.id)) current = queue[0];
  renderDetail();
}

/**
 * Avancement du rattrapage. Power Automate remonte au plus 20 messages par
 * exécution : un lot plus petit que ce plafond signifie que le dossier
 * Outlook est vidé. C'est le seul signal fiable de fin, l'application ne
 * voit pas la boîte mail.
 */
async function renderCatchup() {
  const box = $('#catchup');
  if (!box) return;
  try {
    const { data, error } = await supabase.rpc('catchup_progress', { p_limit: 20 });
    if (error) throw error;
    const p = typeof data === 'string' ? JSON.parse(data) : data;
    if (!p || !p.total_messages) { box.hidden = true; return; }

    const traites = Number(p.traites) + Number(p.ignores);
    const total = Number(p.total_messages);
    const pct = total ? Math.round((traites / total) * 100) : 0;
    const dernier = p.dernier_lot || {};
    box.hidden = false;
    box.innerHTML = `
      <div class="catchup-head">
        <strong>${p.termine ? 'Rattrapage terminé' : 'Rattrapage en cours'}</strong>
        <span class="muted small">${traites} message${traites > 1 ? 's' : ''} traité${traites > 1 ? 's' : ''} sur ${total}</span>
      </div>
      <div class="progress-track"><div class="progress-bar ${pct >= 100 ? 'full' : ''}" style="width:${pct}%"></div></div>
      <div class="catchup-detail">
        ${[
          Number(p.en_quarantaine) ? `${p.en_quarantaine} en quarantaine` : '',
          Number(p.en_attente) ? `${p.en_attente} en cours` : '',
          Number(p.en_erreur) ? `<span class="txt-red">${p.en_erreur} en erreur</span>` : '',
          `${p.lots} lot${Number(p.lots) > 1 ? 's' : ''} reçu${Number(p.lots) > 1 ? 's' : ''}`,
          dernier.messages != null ? `dernier lot : ${dernier.messages} message${dernier.messages > 1 ? 's' : ''}` : ''
        ].filter(Boolean).join(' <span class="sep">·</span> ')}
      </div>
      ${p.termine ? '' : '<p class="field-hint">Le prochain lot arrive au cycle suivant de Power Automate.</p>'}`;
  } catch (err) {
    console.warn('avancement du rattrapage indisponible', err);
    box.hidden = true;
  }
}

function updateBadge(n = queue.length) {
  // deux emplacements : barre latérale en desktop, onglets bas en mobile
  ['#review-badge', '#review-badge-m'].forEach((sel) => {
    const b = $(sel);
    if (!b) return;
    b.textContent = n;
    b.hidden = n === 0;
  });
}

// ---------------------------------------------------------------------
// Rendu du détail : document à gauche, champs à droite
// ---------------------------------------------------------------------
async function renderDetail() {
  const box = $('#review-detail');
  if (!current) { box.innerHTML = ''; return; }
  const i = current;
  const m = i.meta;
  confirmed = new Set();

  const rateOptions = LEGAL_RATES
    .map((r) => `<option value="${r}" ${Number(i.vat_rate) === r ? 'selected' : ''}>${(r * 100).toFixed(0)} %</option>`)
    .join('');
  const nonStandard = !LEGAL_RATES.includes(Number(i.vat_rate));

  box.innerHTML = `
    ${m.comment ? `<div class="review-banner">${ICONS.dash}<span>${escapeHtml(m.comment)}</span></div>` : ''}
    ${m.failed ? `<div class="review-banner danger">${ICONS.dash}<span>L'extraction automatique a échoué. Les champs sont à saisir à la main.</span></div>` : ''}

    <div class="review-split">
      <div class="review-doc">
        <div class="review-doc-bar">
          <span class="muted small">Document d'origine</span>
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm" id="rv-print">Imprimer</button>
          <button type="button" class="btn btn-sm" id="rv-open">Ouvrir</button>
        </div>
        <div id="rv-viewer" class="review-viewer"><div class="muted small" style="padding:16px">Chargement du document…</div></div>
      </div>

      <form class="review-fields" id="rv-form">
        <!-- Le numéro Smart n'est pas sur la facture : il est attribué à
             l'encodage. C'est le geste central de Marie, donc il vient en
             premier et reçoit le focus à l'ouverture. -->
        <div class="field smart-field">
          <label for="rv-smart">Référence Smart</label>
          <input id="rv-smart" data-f="smart_ref" type="text" autocomplete="off"
                 placeholder="numéro attribué lors de l'encodage dans Smart"
                 value="${escapeHtml(i.smart_ref || '')}">
          <p class="field-hint" id="rv-smart-hint">Renseigner cette référence coche « Encodé Smart » automatiquement.</p>
        </div>

        <div class="field">
          <label for="rv-supplier">Fournisseur</label>
          <select id="rv-supplier" data-f="supplier_id"></select>
          ${i.supplier?.needs_review ? '<p class="field-hint warn">Fiche créée automatiquement, à vérifier.</p>' : ''}
        </div>

        <div class="grid2">
          <div class="field">
            <label for="rv-number">N° facture</label>
            <input id="rv-number" data-f="invoice_number" type="text" value="${escapeHtml(i.invoice_number)}">
          </div>
          <div class="field">
            <label for="rv-date">Date facture</label>
            <input id="rv-date" data-f="invoice_date" type="date" value="${i.invoice_date || ''}">
            <!-- Le navigateur affiche la date selon SA langue : un navigateur en
                 anglais montre 09/05/2026 pour le 5 septembre. On la réécrit en
                 toutes lettres pour lever toute ambiguïté. -->
            <p class="field-hint" id="rv-date-text"></p>
          </div>
          <div class="field">
            <label for="rv-due">Échéance</label>
            <input id="rv-due" data-f="due_date" type="date" value="${i.due_date || ''}">
            <p class="field-hint" id="rv-due-text"></p>
          </div>
          <div class="field">
            <label for="rv-htva">Montant HTVA (€)</label>
            <input id="rv-htva" data-f="amount_htva" type="number" step="0.01" value="${Number(i.amount_htva)}">
          </div>
        </div>

        <!-- Le taux de TVA : champ à part entière, jamais déduit en silence -->
        <fieldset class="vat-block" id="rv-vat-block">
          <legend>Taux de TVA</legend>
          <div class="vat-row">
            <select id="rv-rate" data-f="vat_rate">
              ${rateOptions}
              <option value="autre" ${nonStandard ? 'selected' : ''}>Autre…</option>
            </select>
            <input id="rv-rate-custom" type="number" step="0.01" min="0" max="100"
                   value="${nonStandard ? (Number(i.vat_rate) * 100).toFixed(2) : ''}"
                   placeholder="%" ${nonStandard ? '' : 'hidden'}>
            <div class="vat-computed">
              <span>TVA calculée <strong id="rv-tva-calc">—</strong></span>
              <span>Total TVAC <strong id="rv-tvac-calc">—</strong></span>
            </div>
          </div>
          <p class="vat-read">Lu sur le document : TVA <strong id="rv-tva-read">—</strong></p>
          <p class="vat-verdict" id="rv-vat-verdict"></p>
        </fieldset>

        <div class="grid2">
          <div class="field">
            <label for="rv-type">Type de dépense</label>
            <input id="rv-type" data-f="expense_type" type="text" value="${escapeHtml(i.expense_type || '')}">
          </div>
          <div class="field">
            <label for="rv-stock">Entrée en stock</label>
            <input id="rv-stock" data-f="stock_in" type="date" value="${i.stock_in || ''}">
          </div>
        </div>

        <div class="field">
          <label for="rv-notes">Remarques</label>
          <textarea id="rv-notes" data-f="notes" rows="2">${escapeHtml(i.notes || '')}</textarea>
        </div>

        ${m.uncertain.length ? `
          <div class="uncertain-box">
            <p>Champs signalés incertains par l'extraction. Confirme chacun après contrôle sur le document :</p>
            ${m.uncertain.map((f) => `
              <label class="check"><input type="checkbox" data-confirm="${escapeHtml(f)}"> ${escapeHtml(f)}</label>`).join('')}
          </div>` : ''}

        <div class="review-actions">
          <button type="button" class="btn btn-danger" id="rv-reject">Rejeter</button>
          <span class="spacer"></span>
          <button type="button" class="btn" id="rv-retry"
            ${(i.extraction_attempts ?? 0) >= 3 ? 'disabled title="3 tentatives déjà utilisées"' : ''}>
            Relancer l'extraction (${3 - (i.extraction_attempts ?? 0)})
          </button>
          <button type="button" class="btn btn-primary" id="rv-validate">Valider</button>
        </div>
        <p class="block-reason" id="rv-block-reason" hidden></p>
      </form>
    </div>`;

  fillSupplierSelect(i.supplier_id);
  wireDetail();
  refreshVat();
  loadDocument(i.file_path);
  // Marie enchaîne les factures au clavier : le curseur l'attend dans le
  // champ qu'elle remplit en premier.
  setTimeout(() => { const f = $('#rv-smart'); if (f) { f.focus(); f.select(); } }, 60);
}

function fillSupplierSelect(selected) {
  const sel = $('#rv-supplier');
  sel.innerHTML = suppliersCache()
    .filter((s) => !s.archived)
    .map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${escapeHtml(s.name)}${s.needs_review ? ' (à vérifier)' : ''}</option>`)
    .join('');
}

// ---------------------------------------------------------------------
// Document d'origine
// ---------------------------------------------------------------------
async function loadDocument(path) {
  const viewer = $('#rv-viewer');
  signedUrl = null;
  if (!path) { viewer.innerHTML = '<div class="empty"><p>Aucun document joint.</p></div>'; return; }
  try {
    const { data, error } = await supabase.storage.from('factures').createSignedUrl(path, 3600);
    if (error) throw error;
    signedUrl = data.signedUrl;
    // <object> plutôt que <iframe> : si le navigateur ne sait pas afficher un
    // PDF en ligne (Safari mobile, visualiseur désactivé), le contenu de repli
    // s'affiche au lieu d'un rectangle gris inexpliqué.
    viewer.innerHTML = /\.xml$/i.test(path)
      ? `<pre class="xml-view" id="rv-xml">Chargement…</pre>`
      : `<object data="${signedUrl}#zoom=page-width" type="application/pdf" title="Document d'origine">
           <div class="empty">
             <p>Ton navigateur n'affiche pas les PDF directement.</p>
             <a class="btn btn-primary" href="${signedUrl}" target="_blank" rel="noopener">Ouvrir le document</a>
           </div>
         </object>`;
    if (/\.xml$/i.test(path)) {
      const txt = await (await fetch(signedUrl)).text();
      $('#rv-xml').textContent = txt.slice(0, 20000);
    }
  } catch (err) {
    console.error(err);
    viewer.innerHTML = `<div class="empty"><p>${escapeHtml(errorMessage(err, 'Document illisible.'))}</p></div>`;
  }
}

// ---------------------------------------------------------------------
// Le contrôle de TVA, visible et bloquant
// ---------------------------------------------------------------------
function currentRate() {
  const sel = $('#rv-rate');
  if (sel.value === 'autre') {
    const pct = Number($('#rv-rate-custom').value);
    return Number.isFinite(pct) ? pct / 100 : NaN;
  }
  return Number(sel.value);
}

/** Réécrit les dates en toutes lettres, indépendamment de la langue du navigateur */
function spellDates() {
  const pairs = [['#rv-date', '#rv-date-text'], ['#rv-due', '#rv-due-text']];
  for (const [input, out] of pairs) {
    const el = $(out);
    if (!el) continue;
    el.textContent = longDate($(input)?.value);
  }
}

function refreshVat() {
  const htva = Number($('#rv-htva').value) || 0;
  const rate = currentRate();
  const readTva = Number(current?.meta?.brut?.montant_tva);
  const calcTva = Number.isFinite(rate) ? Math.round(htva * rate * 100) / 100 : NaN;

  $('#rv-tva-calc').textContent = Number.isFinite(calcTva) ? fmtEUR(calcTva) : '—';
  $('#rv-tvac-calc').textContent = Number.isFinite(calcTva) ? fmtEUR(htva + calcTva) : '—';
  $('#rv-tva-read').textContent = Number.isFinite(readTva) ? fmtEUR(readTva) : 'non lu';

  spellDates();

  const verdict = $('#rv-vat-verdict');
  const block = $('#rv-vat-block');
  block.classList.remove('is-warn', 'is-danger', 'is-ok');

  const mismatch = vatMismatch(htva, readTva, rate);
  if (!Number.isFinite(rate)) {
    block.classList.add('is-danger');
    verdict.textContent = 'Taux de TVA manquant.';
  } else if (mismatch === 'unknown') {
    block.classList.add('is-warn');
    verdict.textContent = 'Aucun montant de TVA lu sur le document : le taux ne peut pas être recoupé, vérifie-le à l\'œil.';
  } else if (mismatch) {
    block.classList.add('is-danger');
    verdict.textContent = `Le taux choisi donne ${fmtEUR(calcTva)} de TVA, alors que le document indique ${fmtEUR(readTva)}. Corrige le taux ou le montant HTVA avant de valider.`;
  } else {
    block.classList.add('is-ok');
    verdict.textContent = 'Le taux correspond au montant de TVA lu sur le document.';
  }
  refreshValidateState();
}

function blockingReason() {
  const htva = Number($('#rv-htva').value);
  const rate = currentRate();
  if (!$('#rv-supplier').value) return 'Choisis un fournisseur.';
  if (!$('#rv-number').value.trim()) return 'Le numéro de facture est obligatoire.';
  if (!$('#rv-date').value) return 'La date de facture est obligatoire.';
  if (!Number.isFinite(rate)) return 'Le taux de TVA doit être renseigné.';
  const mismatch = vatMismatch(htva, Number(current?.meta?.brut?.montant_tva), rate);
  if (mismatch === true) return 'Le taux de TVA ne correspond pas au montant lu sur le document.';
  const pending = (current?.meta?.uncertain || []).filter((f) => !confirmed.has(f));
  if (pending.length) return `Confirme les champs incertains : ${pending.join(', ')}.`;
  return null;
}

function refreshValidateState() {
  const reason = blockingReason();
  const btn = $('#rv-validate');
  const note = $('#rv-block-reason');
  btn.disabled = !!reason;
  note.hidden = !reason;
  note.textContent = reason || '';
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------
function wireDetail() {
  $('#rv-form').addEventListener('input', refreshVat);
  $('#rv-rate').addEventListener('change', () => {
    $('#rv-rate-custom').hidden = $('#rv-rate').value !== 'autre';
    refreshVat();
  });
  $$('#rv-form [data-confirm]').forEach((c) => c.addEventListener('change', (e) => {
    if (e.target.checked) confirmed.add(e.target.dataset.confirm);
    else confirmed.delete(e.target.dataset.confirm);
    refreshValidateState();
  }));

  $('#rv-open').addEventListener('click', () => signedUrl && window.open(signedUrl, '_blank', 'noopener'));
  $('#rv-print').addEventListener('click', printCurrent);
  $('#rv-validate').addEventListener('click', validateCurrent);
  $('#rv-reject').addEventListener('click', rejectCurrent);
  $('#rv-retry').addEventListener('click', retryExtraction);
}

/** Ouvre le document dans une fenêtre et lance l'impression */
function printCurrent() {
  if (!signedUrl) { toast('Aucun document à imprimer.', 'error'); return; }
  const w = window.open(signedUrl, '_blank', 'noopener');
  if (!w) { toast('Le navigateur a bloqué la fenêtre d\'impression.', 'error'); return; }
  w.addEventListener('load', () => { try { w.print(); } catch { /* le visualiseur gère */ } });
}

async function validateCurrent() {
  const reason = blockingReason();
  if (reason) { toast(reason, 'error'); return; }

  const rate = currentRate();
  const patch = {
    smart_ref: $('#rv-smart').value.trim() || null,
    supplier_id: $('#rv-supplier').value,
    invoice_number: $('#rv-number').value.trim(),
    invoice_date: $('#rv-date').value,
    due_date: $('#rv-due').value || null,
    amount_htva: Number($('#rv-htva').value) || 0,
    vat_rate: rate,
    expense_type: $('#rv-type').value.trim() || null,
    stock_in: $('#rv-stock').value || null,
    notes: $('#rv-notes').value.trim() || null,
    review_status: 'valide'
  };

  const btn = $('#rv-validate');
  btn.disabled = true;
  try {
    const { error } = await supabase.from('invoices').update(patch).eq('id', current.id);
    if (error) throw error;
    await rememberSender(patch.supplier_id, current.sender_email);
    // La facture rejoint la liste normale : son cache doit repartir de la base.
    invalidateInvoices();
    toast(`Facture ${patch.invoice_number} validée.`);
    current = null;
    await renderReview();
    notifyDataChange();
  } catch (err) {
    // Le doublon de référence est un cas prévu et traité : inutile de
    // déverser l'erreur Postgres brute dans la console.
    if (!/invoices_smart_ref_key/.test(err.message || '')) console.error(err);
    if (/invoices_smart_ref_key/.test(err.message || '')) {
      const hint = $('#rv-smart-hint');
      hint.textContent = `La référence Smart ${patch.smart_ref} est déjà utilisée par une autre facture.`;
      hint.className = 'field-hint danger';
      $('#rv-smart').focus();
      toast(`Référence Smart ${patch.smart_ref} déjà utilisée.`, 'error');
    } else {
      toast(errorMessage(err, 'Validation impossible.'), 'error');
    }
    btn.disabled = false;
  }
}

/**
 * Mémorise l'adresse de l'expéditeur sur le fournisseur retenu :
 * la reconnaissance automatique s'améliore à chaque validation.
 */
async function rememberSender(supplierId, email) {
  if (!supplierId || !email) return;
  try {
    const { data } = await supabase.from('suppliers').select('known_emails').eq('id', supplierId).single();
    const list = data?.known_emails || [];
    if (list.includes(email)) return;
    await supabase.from('suppliers').update({ known_emails: [...list, email] }).eq('id', supplierId);
  } catch (err) {
    console.warn('mémorisation de l\'expéditeur impossible', err);
  }
}

async function rejectCurrent() {
  const ok = await confirmDialog(
    `Rejeter cette facture ? Elle sera supprimée de la file. Le document d'origine reste dans le coffre.`,
    'Rejeter');
  if (!ok) return;
  try {
    const { error } = await supabase.from('invoices').delete().eq('id', current.id);
    if (error) throw error;
    invalidateInvoices();
    toast('Facture rejetée.');
    current = null;
    await renderReview();
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Rejet impossible.'), 'error');
  }
}

async function retryExtraction() {
  if (!isManager()) { toast('Seul le gérant peut relancer une extraction.', 'error'); return; }
  toast('Relance demandée, le résultat arrive dans quelques secondes.');
  try {
    const { data: q } = await supabase.from('inbound_queue')
      .select('id').eq('message_id', current.message_id).maybeSingle();
    if (!q) { toast('Message d\'origine introuvable dans la file.', 'error'); return; }
    const { error } = await supabase.functions.invoke('replay-inbound', { body: { ids: [q.id] } });
    if (error) throw error;
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Relance impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initReview() {
  $('#review-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-review]');
    if (!b) return;
    current = queue.find((i) => i.id === b.dataset.review) || null;
    renderReview();
  });
  window.addEventListener('vk:data', () => { if (!$('#tab-review').hidden) renderReview(); });
}

/** Compteur de la pastille, rafraîchi sans ouvrir l'onglet */
export async function refreshReviewBadge() {
  try {
    const { count } = await supabase.from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('review_status', 'a_controler');
    updateBadge(count ?? 0);
  } catch { /* silencieux : ce n'est qu'un compteur */ }
}

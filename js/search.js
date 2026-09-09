// =====================================================================
// search.js — recherche globale, accessible depuis tous les écrans.
//
// Interroge la base et non le cache : une facture est trouvée même si
// l'écran affiche un autre mois. Ouverte par la loupe du bandeau ou la
// touche « / ».
// =====================================================================
import { supabase } from './supabase.js';
import { renderSupplierDetail } from './suppliers.js';
import { setInvoiceFilters } from './invoices.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage,
  openModal, closeModal, statusLabel, statusClass, ICONS
} from './ui.js';

let timer = null;
let lastQuery = '';
let goToTab = () => {};

export function openSearch(prefill = '') {
  openModal('modal-search');
  const input = $('#search-input');
  input.value = prefill;
  input.focus();
  input.select();
  if (prefill.trim().length >= 2) run(prefill);
  else $('#search-results').innerHTML = hint();
}

const hint = () => `
  <div class="search-hint">
    <p>Cherche dans les numéros de facture, les références Smart et libres,
       les noms de fournisseur, les numéros de TVA, les montants et les remarques.</p>
    <p class="muted small">Deux caractères minimum.</p>
  </div>`;

async function run(q) {
  const box = $('#search-results');
  if (q.trim().length < 2) { box.innerHTML = hint(); return; }
  lastQuery = q;
  box.innerHTML = '<div class="muted small" style="padding:14px">Recherche…</div>';
  try {
    const { data, error } = await supabase.rpc('global_search', { p_q: q, p_limit: 12 });
    if (error) throw error;
    if (q !== lastQuery) return;            // une frappe plus récente a pris la main
    const r = typeof data === 'string' ? JSON.parse(data) : data;
    render(r, q);
  } catch (err) {
    console.error(err);
    box.innerHTML = `<div class="search-hint"><p>${escapeHtml(errorMessage(err, 'Recherche impossible.'))}</p></div>`;
  }
}

function render(r, q) {
  const box = $('#search-results');
  const factures = r?.factures || [];
  const fournisseurs = r?.fournisseurs || [];

  if (!factures.length && !fournisseurs.length) {
    box.innerHTML = `<div class="search-hint"><p>Aucun résultat pour « ${escapeHtml(q)} ».</p></div>`;
    return;
  }

  box.innerHTML = `
    ${fournisseurs.length ? `
      <div class="search-group">
        <h3>Fournisseurs <span class="muted">${fournisseurs.length}</span></h3>
        ${fournisseurs.map((s) => `
          <button type="button" class="search-hit" data-supplier="${s.id}">
            <span class="hit-main">${escapeHtml(s.name)}
              ${s.needs_review ? '<span class="tag">à valider</span>' : ''}</span>
            <span class="hit-meta">${s.factures} facture${Number(s.factures) > 1 ? 's' : ''}
              <span class="sep">·</span> ${fmtEUR(s.total)} facturé
              ${Number(s.reste_du) > 0 ? `<span class="sep">·</span> <span class="txt-red">${fmtEUR(s.reste_du)} dû</span>` : ''}
              ${s.vat_number ? `<span class="sep">·</span> ${escapeHtml(s.vat_number)}` : ''}</span>
          </button>`).join('')}
      </div>` : ''}

    ${factures.length ? `
      <div class="search-group">
        <h3>Factures <span class="muted">${factures.length}</span></h3>
        ${factures.map((f) => `
          <button type="button" class="search-hit" data-invoice="${escapeHtml(f.invoice_number)}"
                  data-review="${f.review_status === 'a_controler' ? '1' : ''}">
            <span class="hit-main">${escapeHtml(f.invoice_number)}
              <span class="muted">— ${escapeHtml(f.supplier_name)}</span></span>
            <span class="hit-meta">${fmtDate(f.invoice_date)}
              <span class="sep">·</span> ${fmtEUR(f.amount_tvac)}
              ${f.smart_ref ? `<span class="sep">·</span> Smart ${escapeHtml(f.smart_ref)}` : ''}
              ${(f.external_refs || []).length ? `<span class="sep">·</span> ${f.external_refs.map(escapeHtml).join(', ')}` : ''}
              <span class="sep">·</span> <span class="badge ${statusClass(f.payment_status)}">${escapeHtml(statusLabel(f.payment_status))}</span>
              ${f.review_status === 'a_controler' ? '<span class="tag">à contrôler</span>' : ''}</span>
          </button>`).join('')}
      </div>` : ''}`;
}

// ---------------------------------------------------------------------
// Ouverture d'un résultat
// ---------------------------------------------------------------------
function openHit(el) {
  const supplier = el.dataset.supplier;
  const invoice = el.dataset.invoice;
  closeModal('modal-search');

  if (supplier) {
    goToTab('suppliers');
    renderSupplierDetail(supplier);
    return;
  }
  if (invoice) {
    // Une facture encore à contrôler vit dans l'autre écran
    if (el.dataset.review) { goToTab('review'); return; }
    goToTab('invoices');
    setInvoiceFilters({ q: invoice, period: 'all', supplier: '', status: '', smart: '', winauditor: '', stock: '' });
  }
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initSearch(showTab) {
  goToTab = showTab || (() => {});

  $('#btn-search').addEventListener('click', () => openSearch());
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value;
    timer = setTimeout(() => run(q), 220);
  });
  $('#search-results').addEventListener('click', (e) => {
    const hit = e.target.closest('.search-hit');
    if (hit) openHit(hit);
  });
  // Entrée ouvre le premier résultat
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = $('#search-results .search-hit');
    if (first) openHit(first);
  });
}

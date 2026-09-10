// =====================================================================
// invoices.js — CRUD factures, filtres, tableau, modale de saisie
// =====================================================================
import { supabase } from './supabase.js';
import { getSuppliers, suppliersCache, supplierById, supplierByName, openSupplierModalWithName } from './suppliers.js';
import { downloadInvoicesCSV } from './export.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage, openModal, closeModal,
  confirmDialog, skeletonRows, getMonth, setMonth, monthLabel, shiftMonth,
  currentMonthKey, inMonth, statusLabel, statusClass, isOverdue, isDueSoon, isComplete,
  todayISO, addDays, notifyDataChange, ICONS, openPopover, closePopover
} from './ui.js';
import { currentUser, isManager } from './auth.js';

let cache = null;          // toutes les factures (le volume reste petit : on filtre côté client)
let loading = null;        // promesse de chargement en cours
let lastRows = [];         // lignes actuellement affichées (pour l'export « sélection »)
let dueTouched = false;    // l'utilisateur a-t-il modifié l'échéance à la main ?
let saveAndNext = false;   // bouton « Enregistrer et suivant »
let highlightId = null;    // ligne à mettre en évidence après un doublon
const selection = new Set();   // ids cochés (sélection multiple)
const busy = new Set();        // requêtes en cours : évite les doubles clics
let flashId = null;            // ligne à faire clignoter (paiement enregistré)

// Filtres actifs
const filters = {
  q: '',
  period: 'month',     // 'month' | 'all'
  supplier: '',
  status: '',
  smart: '',           // '' | 'oui' | 'non'
  winauditor: '',
  stock: ''            // '' | 'sans'
};

// Tri actif
let sort = { key: 'invoice_date', dir: 'desc' };

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
export async function getInvoices(force = false) {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    const { data, error } = await supabase
      .from('invoices')
      .select('*, supplier:suppliers(id, name, payment_terms)')
      .order('invoice_date', { ascending: false });
    if (error) throw error;
    cache = (data || []).map(normalize);
    loading = null;
    return cache;
  })();
  return loading;
}

function normalize(row) {
  return { ...row, supplier_name: row.supplier?.name || '—' };
}

export function invoicesCache() { return cache || []; }
export function currentSelection() { return lastRows; }
export function getFilters() { return { ...filters }; }

/** Applique des filtres depuis l'extérieur (blocs d'alerte du tableau de bord) */
export function setInvoiceFilters(patch) {
  Object.assign(filters, patch);
  syncFilterInputs();
  renderInvoices();
}

export function resetFilters() {
  Object.assign(filters, { q: '', period: 'month', supplier: '', status: '', smart: '', winauditor: '', stock: '' });
  syncFilterInputs();
}

// ---------------------------------------------------------------------
// Filtrage / tri
// ---------------------------------------------------------------------
function applyFilters(rows) {
  const month = getMonth();
  const q = filters.q.trim().toLowerCase();
  return rows.filter((i) => {
    if (filters.period === 'month' && !inMonth(i.invoice_date, month)) return false;
    if (filters.supplier && i.supplier_id !== filters.supplier) return false;
    // « En retard » est calculé (échéance dépassée + non payée), il n'est plus saisi à la main
    if (filters.status === 'overdue' && !isOverdue(i)) return false;
    if (filters.status && filters.status !== 'overdue' && i.payment_status !== filters.status) return false;
    if (filters.smart === 'oui' && !i.in_smart) return false;
    if (filters.smart === 'non' && i.in_smart) return false;
    if (filters.winauditor === 'oui' && !i.in_winauditor) return false;
    if (filters.winauditor === 'non' && i.in_winauditor) return false;
    if (filters.stock === 'sans' && i.stock_in) return false;
    if (q) {
      const hay = `${i.invoice_number} ${i.smart_ref || ''} ${(i.external_refs || []).join(' ')} ${i.supplier_name} ${i.notes || ''} ${i.expense_type || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function applySort(rows) {
  const { key, dir } = sort;
  const mul = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    let va, vb;
    if (key === 'supplier') { va = a.supplier_name; vb = b.supplier_name; }
    else if (key === 'amount_tvac') { va = Number(a.amount_tvac) || 0; vb = Number(b.amount_tvac) || 0; }
    else if (key === 'payment_status') { va = statusLabel(a.payment_status); vb = statusLabel(b.payment_status); }
    else { va = a[key] || ''; vb = b[key] || ''; }
    if (typeof va === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb), 'fr', { numeric: true }) * mul;
  });
}

// ---------------------------------------------------------------------
// Rendu du tableau
// ---------------------------------------------------------------------
export async function renderInvoices() {
  const tbody = $('#inv-tbody');
  if (!cache) skeletonRows(tbody, 8, 13);

  let rows;
  try {
    rows = await getInvoices();
    await getSuppliers();          // pour le filtre fournisseur
  } catch (err) {
    console.error(err);
    emptyState(tbody, errorMessage(err, 'Chargement des factures impossible.'), false);
    toast(errorMessage(err, 'Chargement des factures impossible.'), 'error');
    return;
  }

  fillSupplierFilter();

  const filtered = applySort(applyFilters(rows));
  lastRows = filtered;

  // Pied de tableau : total des lignes affichées
  const totalTvac = filtered.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  const totalHtva = filtered.reduce((s, i) => s + (Number(i.amount_htva) || 0), 0);
  $('#inv-foot-count').textContent = `${filtered.length} facture${filtered.length > 1 ? 's' : ''}`;
  $('#inv-foot-htva').textContent = fmtEUR(totalHtva);
  $('#inv-foot-total').textContent = fmtEUR(totalTvac);

  if (!filtered.length) {
    emptyState(tbody, filters.period === 'month'
      ? `Aucune facture en ${monthLabel(getMonth()).toLowerCase()}`
      : 'Aucune facture ne correspond aux filtres', true);
    updateSortIndicators();
    updateBulkBar();
    return;
  }

  const manager = isManager();
  tbody.innerHTML = filtered.map((i) => rowHtml(i, manager)).join('');
  updateSortIndicators();
  updateBulkBar();

  // Case « tout sélectionner » : cochée si toutes les lignes visibles le sont
  const all = $('#inv-check-all');
  const visibleIds = filtered.map((i) => i.id);
  all.checked = visibleIds.length > 0 && visibleIds.every((id) => selection.has(id));
  all.indeterminate = !all.checked && visibleIds.some((id) => selection.has(id));

  // Animation courte après un paiement
  if (flashId) {
    const tr = tbody.querySelector(`tr[data-id="${flashId}"]`);
    if (tr) { tr.classList.add('row-paid-flash'); setTimeout(() => tr.classList.remove('row-paid-flash'), 700); }
    flashId = null;
  }

  if (highlightId) {
    const tr = tbody.querySelector(`tr[data-id="${highlightId}"]`);
    if (tr) {
      tr.classList.add('row-flash');
      tr.scrollIntoView({ block: 'center' });
      setTimeout(() => tr.classList.remove('row-flash'), 2500);
    }
    highlightId = null;
  }
}

/** Le délai d'escompte court-il encore sur cette facture ? */
function escompteOuvert(i) {
  return !!i.discount_rate && !!i.discount_deadline
      && i.payment_status !== 'paye' && i.discount_deadline >= todayISO();
}

function rowHtml(i, manager) {
  const late = isOverdue(i);
  const soon = isDueSoon(i);
  const done = isComplete(i);
  const checked = selection.has(i.id);

  return `
  <tr data-id="${i.id}" class="${late ? 'row-late' : soon ? 'row-soon' : ''}${done ? ' row-done' : ''}${checked ? ' row-checked' : ''}">
    <td class="td-check no-print">
      <input type="checkbox" class="row-check" data-select="${i.id}" ${checked ? 'checked' : ''}
        aria-label="Sélectionner la facture ${escapeHtml(i.invoice_number)}">
      ${done ? `<span class="done-mark" title="Facture complète : Smart, WinAuditor et payée">${ICONS.check}</span>` : ''}
    </td>
    <td class="td-date" data-label="Date">${fmtDate(i.invoice_date)}</td>
    <td class="td-supplier" data-label="Fournisseur">${escapeHtml(i.supplier_name)}</td>
    <td class="td-number" data-label="N°">${escapeHtml(i.invoice_number)}<span class="mob-meta">${fmtDate(i.invoice_date)}${i.due_date ? ` · éch. ${fmtDate(i.due_date)}` : ''}</span></td>
    <td class="td-smartref" data-label="Réf. Smart">${i.smart_ref ? escapeHtml(i.smart_ref) : '<span class="muted">—</span>'}</td>
    <td class="td-refs" data-label="Références">${(i.external_refs || []).length
      ? i.external_refs.map((r) => `<span class="ref-chip">${escapeHtml(r)}</span>`).join('')
      : '<span class="muted">—</span>'}</td>
    <td class="td-due ${late ? 'txt-red strong' : soon ? 'txt-orange' : ''}" data-label="Échéance">${fmtDate(i.due_date) || '—'}</td>
    <td class="td-amount num strong" data-label="Total TVAC">${fmtEUR(i.amount_tvac)}${escompteOuvert(i)
      ? `<span class="pill-discount" title="Escompte ${Number(i.discount_rate)} % : ${fmtEUR(i.amount_discounted)} si payé avant le ${fmtDate(i.discount_deadline)}">−${Number(i.discount_rate)} %</span>`
      : ''}</td>
    <td class="td-smart" data-label="Smart">${smartPillHtml(i)}</td>
    <td class="td-win" data-label="WinAuditor">${pillHtml(i, 'in_winauditor', !!i.in_winauditor, 'WinAuditor')}</td>
    <td class="td-stock" data-label="Stock">${stockHtml(i)}</td>
    <td class="td-status" data-label="Paiement">${paymentHtml(i, manager)}</td>
    <td class="td-actions no-print">
      <button type="button" class="icon-btn row-action" data-edit="${i.id}" title="Modifier">${ICONS.pencil}</button>
      <button type="button" class="icon-btn row-menu" data-menu="${i.id}" title="Autres actions" aria-haspopup="menu">${ICONS.dots}</button>
    </td>
  </tr>`;
}

/**
 * Pastille Smart. Quand une référence Smart est saisie, elle n'est plus
 * basculable : la référence fait foi, et la base garantit l'invariant.
 * Un clic afficherait sinon une contradiction entre les deux champs.
 */
function smartPillHtml(i) {
  if (i.smart_ref) {
    return `<span class="pill on locked" title="Référence Smart ${escapeHtml(i.smart_ref)} — décocher n'est possible qu'en effaçant la référence">${ICONS.check}</span>`;
  }
  // Sans référence, la pastille reflète in_smart et reste basculable :
  // l'invariant n'est à sens unique (référence ⇒ encodé), et les factures
  // encodées avant l'arrivée de ce champ doivent rester correctes.
  return pillHtml(i, 'in_smart', !!i.in_smart, 'Smart');
}

/** Pastille Smart / WinAuditor : grise pointillée quand c'est à faire, verte pleine quand c'est fait */
function pillHtml(i, field, on, label) {
  return `<button type="button" class="pill ${on ? 'on' : 'off'}" data-toggle="${field}" data-id="${i.id}"
    aria-pressed="${on}" title="${label} : ${on ? 'fait' : 'à faire'} (cliquer pour basculer)">${on ? ICONS.check : ICONS.dash}</button>`;
}

/** Entrée en stock : bouton « Reçu » en un clic, puis la date */
function stockHtml(i) {
  if (i.stock_in) {
    return `<button type="button" class="pill on wide" data-toggle="stock_in" data-id="${i.id}"
      title="Entrée en stock le ${fmtDate(i.stock_in)} (cliquer pour annuler)">${ICONS.check}<span class="pill-txt">${fmtDate(i.stock_in)}</span></button>`;
  }
  return `<button type="button" class="pill off wide" data-toggle="stock_in" data-id="${i.id}"
    title="Marquer la marchandise reçue aujourd'hui">${ICONS.box}<span class="pill-txt">Reçu</span></button>`;
}

/** Cellule de paiement : bouton « Marquer payé » ou pastille verte « Payé le … » */
function paymentHtml(i, manager) {
  if (i.payment_status === 'paye') {
    const d = fmtDate(i.payment_date) || '—';
    if (!manager) return `<span class="paid-badge static">${ICONS.check}<span>Payé le ${d}</span></span>`;
    return `<span class="paid-badge">
        <button type="button" class="paid-main" data-unpay="${i.id}" title="Annuler ce paiement">${ICONS.check}<span>Payé le</span></button>
        <button type="button" class="paid-date" data-paydate="${i.id}" title="Modifier la date de paiement">${d}</button>
      </span>`;
  }

  const extra = (i.payment_status !== 'a_payer' && i.payment_status !== 'en_retard')
    ? `<span class="badge ${statusClass(i.payment_status)}">${escapeHtml(statusLabel(i.payment_status))}</span>` : '';

  if (!manager) {
    return extra || `<span class="badge st-orange">${isOverdue(i) ? 'En retard' : 'À payer'}</span>`;
  }
  return `${extra}<button type="button" class="btn-pay" data-pay="${i.id}">${ICONS.check}<span>Marquer payé</span></button>`;
}

/** État vide soigné : petit dessin + phrase + action */
function emptyState(tbody, message, withAction) {
  tbody.innerHTML = `<tr class="empty-row"><td colspan="13">
      <div class="empty">
        ${ICONS.empty}
        <p>${escapeHtml(message)}</p>
        ${withAction ? '<button type="button" class="btn btn-primary" data-empty-new>Encoder la première</button>' : ''}
      </div>
    </td></tr>`;
}

function updateSortIndicators() {
  $$('#table-invoices th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sort.key);
    th.dataset.dir = th.dataset.sort === sort.key ? sort.dir : '';
  });
}

function fillSupplierFilter() {
  const sel = $('#f-supplier');
  const current = sel.value;
  const sups = suppliersCache().filter((s) => !s.archived || s.id === current);
  sel.innerHTML = '<option value="">Tous les fournisseurs</option>' +
    sups.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  sel.value = filters.supplier || '';
}

// ---------------------------------------------------------------------
// Mises à jour rapides (pastilles + statut) — optimistic update
// ---------------------------------------------------------------------
function findInvoice(id) { return (cache || []).find((x) => x.id === id) || null; }

async function togglePill(id, field) {
  const inv = findInvoice(id);
  if (!inv) return;
  const key = `${id}:${field}`;
  if (busy.has(key)) return;          // une requête est déjà en vol sur ce champ
  busy.add(key);

  let newValue;
  if (field === 'stock_in') newValue = inv.stock_in ? null : todayISO();
  else newValue = !inv[field];

  const previous = inv[field];
  inv[field] = newValue;                       // optimistic
  renderInvoices();

  try {
    const { error } = await supabase.from('invoices').update({ [field]: newValue }).eq('id', id);
    if (error) throw error;
    const labels = { in_smart: 'Smart', in_winauditor: 'WinAuditor', stock_in: 'Entrée en stock' };
    const on = field === 'stock_in' ? !!newValue : newValue;
    toast(`${labels[field]} : ${on ? 'oui' : 'non'} — ${inv.invoice_number}`);
    notifyDataChange();
  } catch (err) {
    console.error(err);
    inv[field] = previous;                     // rollback
    renderInvoices();
    toast(errorMessage(err, 'Modification impossible.'), 'error');
  } finally {
    busy.delete(key);
  }
}

/**
 * Change le statut de paiement (optimistic update).
 * `opts.silent` : pas de toast (utilisé par les actions en lot).
 */
async function applyStatus(id, status, opts = {}) {
  const inv = findInvoice(id);
  if (!inv) return false;
  const key = `${id}:status`;
  if (busy.has(key)) return false;
  busy.add(key);

  const prev = { payment_status: inv.payment_status, payment_date: inv.payment_date };
  const patch = { payment_status: status };
  if (status === 'paye') {
    patch.payment_date = opts.date || inv.payment_date || todayISO();
    // Montant réellement décaissé : le TVAC par défaut, l'escompté si choisi
    patch.amount_paid = opts.amount_paid ?? Number(inv.amount_tvac);
  } else if (status !== 'acompte') {
    patch.payment_date = null;
    patch.amount_paid = null;
  }

  Object.assign(inv, patch);                   // optimistic
  if (status === 'paye') flashId = id;
  if (!opts.noRender) renderInvoices();

  try {
    const { error } = await supabase.from('invoices').update(patch).eq('id', id);
    if (error) throw error;
    if (!opts.silent) {
      if (status === 'paye') {
        toast(`Facture ${inv.invoice_number} payée`, 'ok', 6000,
          { label: 'Annuler', onClick: () => applyStatus(id, 'a_payer') });
      } else {
        toast(`${inv.invoice_number} — ${statusLabel(status)}`);
      }
    }
    notifyDataChange();
    return true;
  } catch (err) {
    console.error(err);
    Object.assign(inv, prev);                  // rollback
    renderInvoices();
    if (!opts.silent) toast(errorMessage(err, 'Enregistrement du paiement impossible.'), 'error');
    return false;
  } finally {
    busy.delete(key);
  }
}

/** Modifie uniquement la date de paiement (paiement antérieur) */
async function setPaymentDate(id, date) {
  const inv = findInvoice(id);
  if (!inv || !date) return;
  const prev = inv.payment_date;
  inv.payment_date = date;
  renderInvoices();
  try {
    const { error } = await supabase.from('invoices').update({ payment_date: date }).eq('id', id);
    if (error) throw error;
    toast(`Paiement daté du ${fmtDate(date)} — ${inv.invoice_number}`);
    notifyDataChange();
  } catch (err) {
    console.error(err);
    inv.payment_date = prev;
    renderInvoices();
    toast(errorMessage(err, 'Modification de la date impossible.'), 'error');
  }
}

/**
 * Deux montants possibles quand l'escompte court encore. Aucun n'est
 * imposé : le gérant tranche, et le montant réellement décaissé est
 * enregistré à part du montant facturé.
 */
function demanderMontant(anchor, inv) {
  const gagne = Number(inv.amount_tvac) - Number(inv.amount_discounted);
  const dansLesDelais = escompteOuvert(inv);
  // Le montant proposé par défaut suit le délai, mais rien n'est imposé.
  const p = openPopover(anchor, `
    <div class="pay-choice">
      <p class="pop-msg">Quel montant as-tu payé ?</p>
      <label class="pay-option">
        <input type="radio" name="montant-paye" value="escompte" ${dansLesDelais ? 'checked' : ''}>
        <span>Escompté <strong>${fmtEUR(inv.amount_discounted)}</strong>
          <span class="muted">(−${fmtEUR(gagne)})</span></span>
      </label>
      <label class="pay-option">
        <input type="radio" name="montant-paye" value="complet" ${dansLesDelais ? '' : 'checked'}>
        <span>Complet <strong>${fmtEUR(inv.amount_tvac)}</strong></span>
      </label>
      <p class="field-hint ${dansLesDelais ? '' : 'warn'}">${dansLesDelais
        ? `Escompte ${Number(inv.discount_rate)} % valable jusqu'au ${fmtDate(inv.discount_deadline)}.`
        : `Délai dépassé le ${fmtDate(inv.discount_deadline)} : l'escompte n'est en principe plus dû. Coche « escompté » seulement si tu l'as réellement déduit.`}
        La facture est soldée dans les deux cas.</p>
      <div class="pop-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-pop-no>Annuler</button>
        <button type="button" class="btn btn-sm btn-primary" data-pop-ok>Marquer payé</button>
      </div>
    </div>`);
  p.querySelector('[data-pop-no]').onclick = () => closePopover();
  p.querySelector('[data-pop-ok]').onclick = () => {
    const choix = p.querySelector('input[name="montant-paye"]:checked')?.value;
    closePopover();
    applyStatus(inv.id, 'paye', {
      amount_paid: choix === 'escompte' ? Number(inv.amount_discounted) : Number(inv.amount_tvac)
    });
  };
}

/** Petit popover de confirmation pour annuler un paiement */
function askUnpay(anchor, id) {
  const p = openPopover(anchor, `
    <p class="pop-msg">Annuler ce paiement ?</p>
    <div class="pop-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-pop-no>Non</button>
      <button type="button" class="btn btn-sm btn-primary" data-pop-yes>Oui</button>
    </div>`);
  p.querySelector('[data-pop-no]').onclick = () => closePopover();
  p.querySelector('[data-pop-yes]').onclick = () => { closePopover(); applyStatus(id, 'a_payer'); };
}

/** Mini sélecteur de date de paiement */
function askPaymentDate(anchor, id) {
  const inv = findInvoice(id);
  const p = openPopover(anchor, `
    <label class="pop-msg" for="pop-date">Date de paiement</label>
    <input type="date" id="pop-date" value="${inv?.payment_date || todayISO()}">
    <div class="pop-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-pop-no>Annuler</button>
      <button type="button" class="btn btn-sm btn-primary" data-pop-ok>Enregistrer</button>
    </div>`);
  const input = p.querySelector('#pop-date');
  input.focus();
  p.querySelector('[data-pop-no]').onclick = () => closePopover();
  p.querySelector('[data-pop-ok]').onclick = () => { const v = input.value; closePopover(); setPaymentDate(id, v); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value; closePopover(); setPaymentDate(id, v); }
  });
}

/** Menu « ⋯ » de fin de ligne : statuts secondaires, duplication, suppression */
function openRowMenu(anchor, id) {
  const inv = findInvoice(id);
  if (!inv) return;
  const manager = isManager();
  const p = openPopover(anchor, `
    <div class="pop-menu">
      <button type="button" data-act="edit">${ICONS.pencil}<span>Modifier</span></button>
      <button type="button" data-act="duplicate">${ICONS.copy}<span>Dupliquer</span></button>
      ${manager ? `
        <hr>
        <button type="button" data-act="litige">${ICONS.dash}<span>Marquer en litige</span></button>
        <button type="button" data-act="acompte">${ICONS.dash}<span>Acompte versé</span></button>
        <button type="button" data-act="a_payer">${ICONS.dash}<span>Remettre à payer</span></button>
        <hr>
        <button type="button" class="danger" data-act="delete">${ICONS.trash}<span>Supprimer</span></button>` : ''}
    </div>`, 'pop-right');

  p.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    closePopover();
    const act = b.dataset.act;
    if (act === 'edit') return openInvoiceModal(inv);
    if (act === 'duplicate') return duplicateInvoice(id);
    if (act === 'delete') return deleteInvoice(id);
    return applyStatus(id, act);
  });
}

/** Rouvre le formulaire pré-rempli (factures récurrentes) */
export function duplicateInvoice(id) {
  const src = findInvoice(id);
  if (!src) return;
  openInvoiceModal(null, src.supplier_id, {
    amount_htva: src.amount_htva,
    vat_rate: src.vat_rate,
    expense_type: src.expense_type,
    notes: src.notes
  });
  toast('Copie pré-remplie : complète le n° et les dates.');
}

async function deleteInvoice(id) {
  const inv = findInvoice(id);
  const ok = await confirmDialog(`Supprimer définitivement la facture ${inv?.invoice_number || ''} ?`, 'Supprimer');
  if (!ok) return;
  try {
    const { error } = await supabase.from('invoices').delete().eq('id', id);
    if (error) throw error;
    cache = cache.filter((x) => x.id !== id);
    selection.delete(id);
    renderInvoices();
    toast('Facture supprimée.');
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Suppression impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Sélection multiple + actions en lot (geste de fin de mois)
// ---------------------------------------------------------------------
function selectedInvoices() {
  return (cache || []).filter((i) => selection.has(i.id));
}

function updateBulkBar() {
  const bar = $('#bulk-bar');
  const rows = selectedInvoices();
  bar.hidden = rows.length === 0;
  if (!rows.length) return;
  const total = rows.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  $('#bulk-summary').textContent =
    `${rows.length} facture${rows.length > 1 ? 's' : ''} sélectionnée${rows.length > 1 ? 's' : ''} — Total ${fmtEUR(total)}`;
  $('#bulk-pay').hidden = !isManager();
}

function toggleSelect(id, on) {
  if (on) selection.add(id); else selection.delete(id);
  // Mise à jour légère : pas de rendu complet du tableau
  const tr = $(`#inv-tbody tr[data-id="${id}"]`);
  if (tr) tr.classList.toggle('row-checked', on);
  const all = $('#inv-check-all');
  const visibleIds = lastRows.map((i) => i.id);
  all.checked = visibleIds.length > 0 && visibleIds.every((x) => selection.has(x));
  all.indeterminate = !all.checked && visibleIds.some((x) => selection.has(x));
  updateBulkBar();
}

function selectAll(on) {
  lastRows.forEach((i) => (on ? selection.add(i.id) : selection.delete(i.id)));
  renderInvoices();
}

function clearSelection() {
  selection.clear();
  renderInvoices();
}

/** Marque toutes les factures sélectionnées comme payées (une seule requête) */
async function bulkPay() {
  const rows = selectedInvoices().filter((i) => i.payment_status !== 'paye');
  if (!rows.length) { toast('Ces factures sont déjà payées.'); return; }
  const ids = rows.map((i) => i.id);
  const date = todayISO();
  const previous = rows.map((i) => ({ id: i.id, payment_status: i.payment_status, payment_date: i.payment_date }));

  rows.forEach((i) => { i.payment_status = 'paye'; i.payment_date = date; });   // optimistic
  renderInvoices();

  try {
    const { error } = await supabase.from('invoices')
      .update({ payment_status: 'paye', payment_date: date }).in('id', ids);
    if (error) throw error;
    toast(`${ids.length} facture${ids.length > 1 ? 's' : ''} marquée${ids.length > 1 ? 's' : ''} payée${ids.length > 1 ? 's' : ''}`,
      'ok', 6000, { label: 'Annuler', onClick: () => bulkRollback(previous) });
    notifyDataChange();
  } catch (err) {
    console.error(err);
    restore(previous);
    renderInvoices();
    toast(errorMessage(err, 'Enregistrement des paiements impossible.'), 'error');
  }
}

/** Marque toutes les factures sélectionnées comme envoyées à WinAuditor */
async function bulkWinauditor() {
  const rows = selectedInvoices().filter((i) => !i.in_winauditor);
  if (!rows.length) { toast('Ces factures sont déjà envoyées à WinAuditor.'); return; }
  const ids = rows.map((i) => i.id);
  rows.forEach((i) => { i.in_winauditor = true; });
  renderInvoices();
  try {
    const { error } = await supabase.from('invoices').update({ in_winauditor: true }).in('id', ids);
    if (error) throw error;
    toast(`${ids.length} facture${ids.length > 1 ? 's' : ''} envoyée${ids.length > 1 ? 's' : ''} à WinAuditor`);
    notifyDataChange();
  } catch (err) {
    console.error(err);
    rows.forEach((i) => { i.in_winauditor = false; });
    renderInvoices();
    toast(errorMessage(err, 'Modification impossible.'), 'error');
  }
}

function restore(previous) {
  previous.forEach((p) => {
    const inv = findInvoice(p.id);
    if (inv) { inv.payment_status = p.payment_status; inv.payment_date = p.payment_date; }
  });
}

async function bulkRollback(previous) {
  const ids = previous.map((p) => p.id);
  restore(previous);
  renderInvoices();
  try {
    // On repasse tout en « à payer » : c'est l'état d'où venaient ces lignes dans 99 % des cas
    const { error } = await supabase.from('invoices')
      .update({ payment_status: 'a_payer', payment_date: null }).in('id', ids);
    if (error) throw error;
    toast('Paiements annulés.');
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Annulation impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Modale facture
// ---------------------------------------------------------------------
export async function openInvoiceModal(invoice = null, presetSupplierId = null, prefill = null) {
  const f = $('#form-invoice');
  f.reset();
  hideDupWarning();
  dueTouched = !!invoice?.due_date;

  const sups = await getSuppliers();
  $('#dl-suppliers').innerHTML = sups.filter((s) => !s.archived)
    .map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');

  const sup = invoice ? supplierById(invoice.supplier_id) : (presetSupplierId ? supplierById(presetSupplierId) : null);
  $('#inv-id').value = invoice?.id || '';
  $('#inv-supplier').value = sup?.name || '';
  $('#inv-supplier-id').value = sup?.id || '';
  $('#inv-number').value = invoice?.invoice_number || '';
  $('#inv-date').value = invoice?.invoice_date || todayISO();
  $('#inv-due').value = invoice?.due_date || '';
  $('#inv-htva').value = invoice?.amount_htva ?? '';
  $('#inv-vat').value = invoice ? String(Number(invoice.vat_rate).toFixed(2)) : '0.21';
  $('#inv-smart').checked = !!invoice?.in_smart;
  $('#inv-winauditor').checked = !!invoice?.in_winauditor;
  $('#inv-stockin').value = invoice?.stock_in || '';
  $('#inv-stockout').value = invoice?.stock_out || '';
  $('#inv-type').value = invoice?.expense_type || '';
  $('#inv-notes').value = invoice?.notes || '';
  $('#inv-encoded').value = invoice?.encoded_at || todayISO();
  $('#inv-status').value = invoice?.payment_status || 'a_payer';
  $('#inv-paydate').value = invoice?.payment_date || '';
  $('#inv-paymethod').value = invoice?.payment_method || '';

  // Les champs de paiement sont réservés au gérant
  const manager = isManager();
  $('#inv-payment-block').hidden = !manager;

  // Duplication : mêmes montant / TVA / type de dépense, n° et dates à saisir
  if (prefill) {
    $('#inv-htva').value = prefill.amount_htva ?? '';
    $('#inv-vat').value = prefill.vat_rate != null ? String(Number(prefill.vat_rate).toFixed(2)) : '0.21';
    $('#inv-type').value = prefill.expense_type || '';
    $('#inv-notes').value = prefill.notes || '';
  }

  $('#modal-invoice-title').textContent = invoice ? 'Modifier la facture' : (prefill ? 'Dupliquer une facture' : 'Nouvelle facture');
  $('#inv-save-next').hidden = !!invoice;
  if (!invoice && !$('#inv-due').value) recomputeDue();
  updateTvacPreview();
  openModal('modal-invoice');
  setTimeout(() => $(invoice ? '#inv-number' : '#inv-supplier').focus(), 40);
}

function resolveSupplier() {
  const s = supplierByName($('#inv-supplier').value);
  $('#inv-supplier-id').value = s?.id || '';
  const unknown = !!$('#inv-supplier').value.trim() && !s;
  $('#inv-supplier-unknown').hidden = !unknown;
  return s;
}

function recomputeDue() {
  const date = $('#inv-date').value;
  const s = supplierByName($('#inv-supplier').value);
  if (!date || !s || dueTouched) return;
  $('#inv-due').value = addDays(date, Number(s.payment_terms ?? 30));
}

function updateTvacPreview() {
  const htva = Number(String($('#inv-htva').value).replace(',', '.')) || 0;
  const rate = Number($('#inv-vat').value) || 0;
  const tva = Math.round(htva * rate * 100) / 100;
  const tvac = Math.round(htva * (1 + rate) * 100) / 100;
  $('#inv-tvac-preview').textContent = `TVA ${fmtEUR(tva)} — Total TVAC ${fmtEUR(tvac)}`;
}

function hideDupWarning() { $('#inv-duplicate').hidden = true; }

function showDupWarning(existing) {
  const box = $('#inv-duplicate');
  box.hidden = false;
  box.innerHTML = `Cette facture est déjà encodée (${escapeHtml(existing.supplier_name)} — ${escapeHtml(existing.invoice_number)}, ${fmtDate(existing.invoice_date)}). ` +
    `<button type="button" class="link-btn" id="inv-goto-dup">Voir la ligne existante</button>`;
  $('#inv-goto-dup').onclick = () => {
    closeModal('modal-invoice');
    highlightId = existing.id;
    resetFilters();
    filters.period = 'all';
    filters.q = existing.invoice_number;
    syncFilterInputs();
    window.dispatchEvent(new CustomEvent('vk:goto-invoices'));
    renderInvoices();
  };
}

async function saveInvoice(e) {
  e.preventDefault();
  hideDupWarning();

  const id = $('#inv-id').value;
  const sup = resolveSupplier();
  if (!sup) { toast('Choisis un fournisseur existant, ou crée-le.', 'error'); $('#inv-supplier').focus(); return; }

  const number = $('#inv-number').value.trim();
  const date = $('#inv-date').value;
  if (!number) { toast('Le numéro de facture est obligatoire.', 'error'); return; }
  if (!date) { toast('La date de facture est obligatoire.', 'error'); return; }

  // Contrôle de doublon (fournisseur + n° de facture)
  const dup = (cache || []).find((x) =>
    x.supplier_id === sup.id &&
    x.invoice_number.trim().toLowerCase() === number.toLowerCase() &&
    x.id !== id);
  if (dup) { showDupWarning(dup); return; }

  const payload = {
    supplier_id: sup.id,
    invoice_number: number,
    invoice_date: date,
    due_date: $('#inv-due').value || null,
    encoded_at: $('#inv-encoded').value || todayISO(),
    amount_htva: Number(String($('#inv-htva').value).replace(',', '.')) || 0,
    vat_rate: Number($('#inv-vat').value) || 0,
    in_smart: $('#inv-smart').checked,
    in_winauditor: $('#inv-winauditor').checked,
    stock_in: $('#inv-stockin').value || null,
    stock_out: $('#inv-stockout').value || null,
    expense_type: $('#inv-type').value.trim() || null,
    notes: $('#inv-notes').value.trim() || null
  };
  if (isManager()) {
    payload.payment_status = $('#inv-status').value;
    payload.payment_date = $('#inv-paydate').value || null;
    payload.payment_method = $('#inv-paymethod').value.trim() || null;
  }
  if (!id && currentUser) payload.created_by = currentUser.id;

  const btns = [$('#inv-save'), $('#inv-save-next')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    let saved;
    if (id) {
      const { data, error } = await supabase.from('invoices').update(payload).eq('id', id)
        .select('*, supplier:suppliers(id, name, payment_terms)').single();
      if (error) throw error;
      saved = normalize(data);
      cache = (cache || []).map((x) => (x.id === id ? saved : x));
    } else {
      const { data, error } = await supabase.from('invoices').insert(payload)
        .select('*, supplier:suppliers(id, name, payment_terms)').single();
      if (error) throw error;
      saved = normalize(data);
      cache = [saved, ...(cache || [])];
    }
    toast(id ? 'Facture modifiée.' : 'Facture enregistrée.');
    notifyDataChange();

    if (saveAndNext && !id) {
      // On rouvre une saisie vide sur le même fournisseur
      saveAndNext = false;
      await openInvoiceModal(null, sup.id);
    } else {
      saveAndNext = false;
      closeModal('modal-invoice');
    }
    renderInvoices();
  } catch (err) {
    console.error(err);
    if (/duplicate key|23505/i.test(err.message || '')) {
      toast('Cette facture est déjà encodée pour ce fournisseur.', 'error');
    } else {
      toast(errorMessage(err, 'Enregistrement de la facture impossible.'), 'error');
    }
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

// ---------------------------------------------------------------------
// Filtres : synchronisation des champs du formulaire
// ---------------------------------------------------------------------
function syncFilterInputs() {
  $('#f-search').value = filters.q;
  $('#f-period').value = filters.period;
  $('#f-supplier').value = filters.supplier;
  $('#f-status').value = filters.status;
  $('#f-smart').value = filters.smart;
  $('#f-winauditor').value = filters.winauditor;
  $('#f-stock').value = filters.stock;
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initInvoices() {
  // Barre d'outils
  $('#f-search').addEventListener('input', (e) => { filters.q = e.target.value; renderInvoices(); });
  $('#f-period').addEventListener('change', (e) => { filters.period = e.target.value; syncFilterInputs(); renderInvoices(); });
  $('#f-supplier').addEventListener('change', (e) => { filters.supplier = e.target.value; renderInvoices(); });
  $('#f-status').addEventListener('change', (e) => { filters.status = e.target.value; renderInvoices(); });
  $('#f-smart').addEventListener('change', (e) => { filters.smart = e.target.value; renderInvoices(); });
  $('#f-winauditor').addEventListener('change', (e) => { filters.winauditor = e.target.value; renderInvoices(); });
  $('#f-stock').addEventListener('change', (e) => { filters.stock = e.target.value; renderInvoices(); });
  $('#f-reset').addEventListener('click', () => { resetFilters(); renderInvoices(); });

  $('#btn-new-invoice').addEventListener('click', () => openInvoiceModal());

  // Tri par en-tête de colonne
  $$('#table-invoices th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else sort = { key, dir: key === 'invoice_date' || key === 'amount_tvac' ? 'desc' : 'asc' };
      renderInvoices();
    });
  });

  // Actions dans le tableau (délégation d'événements)
  $('#inv-tbody').addEventListener('click', (e) => {
    // Un clic sur une pastille ne doit rien déclencher d'autre sur la ligne
    const pill = e.target.closest('[data-toggle]');
    if (pill) { e.stopPropagation(); return togglePill(pill.dataset.id, pill.dataset.toggle); }

    const pay = e.target.closest('[data-pay]');
    if (pay) {
      e.stopPropagation();
      const inv = findInvoice(pay.dataset.pay);
      // Dès qu'un escompte existe, le montant se choisit — même hors délai.
      // Un fournisseur l'accorde parfois en retard, et il arrive d'oublier
      // de le déduire dans les temps : c'est le montant RÉELLEMENT payé qui
      // doit être enregistré, sinon les totaux sont faux.
      if (inv && inv.discount_rate && inv.amount_discounted) return demanderMontant(pay, inv);
      pay.disabled = true;
      return applyStatus(pay.dataset.pay, 'paye');
    }

    const unpay = e.target.closest('[data-unpay]');
    if (unpay) { e.stopPropagation(); return askUnpay(unpay, unpay.dataset.unpay); }

    const paydate = e.target.closest('[data-paydate]');
    if (paydate) { e.stopPropagation(); return askPaymentDate(paydate, paydate.dataset.paydate); }

    const menu = e.target.closest('[data-menu]');
    if (menu) { e.stopPropagation(); return openRowMenu(menu, menu.dataset.menu); }

    const edit = e.target.closest('[data-edit]');
    if (edit) return openInvoiceModal(findInvoice(edit.dataset.edit));

    if (e.target.closest('[data-empty-new]')) return openInvoiceModal();
  });

  // Cases à cocher de sélection
  $('#inv-tbody').addEventListener('change', (e) => {
    const box = e.target.closest('[data-select]');
    if (box) toggleSelect(box.dataset.select, box.checked);
  });
  $('#inv-check-all').addEventListener('change', (e) => selectAll(e.target.checked));

  // Barre d'actions en lot
  $('#bulk-pay').addEventListener('click', bulkPay);
  $('#bulk-winauditor').addEventListener('click', bulkWinauditor);
  $('#bulk-export').addEventListener('click', () => {
    downloadInvoicesCSV(selectedInvoices(), `VK_factures_selection_${getMonth()}.csv`);
  });
  $('#bulk-clear').addEventListener('click', clearSelection);

  // Modale facture
  $('#form-invoice').addEventListener('submit', saveInvoice);
  $('#inv-save-next').addEventListener('click', () => {
    saveAndNext = true;
    $('#form-invoice').requestSubmit($('#inv-save'));   // passe par la validation HTML du formulaire
  });
  $('#inv-supplier').addEventListener('input', () => { resolveSupplier(); recomputeDue(); });
  $('#inv-supplier').addEventListener('change', () => { resolveSupplier(); recomputeDue(); });
  $('#inv-date').addEventListener('change', recomputeDue);
  $('#inv-due').addEventListener('input', () => { dueTouched = true; });
  $('#inv-htva').addEventListener('input', updateTvacPreview);
  $('#inv-vat').addEventListener('change', updateTvacPreview);
  $('#inv-new-supplier').addEventListener('click', () => {
    // Ouvre la modale fournisseur sans perdre la saisie en cours
    openSupplierModalWithName($('#inv-supplier').value.trim(), async (created) => {
      await openSuppliersRefresh();
      $('#inv-supplier').value = created.name;
      resolveSupplier();
      dueTouched = false;
      recomputeDue();
      $('#inv-number').focus();
    });
  });

  // Le mois change -> on re-rend
  window.addEventListener('vk:month', () => renderInvoices());
}

/** Recharge la liste des fournisseurs et met à jour la datalist de la modale */
async function openSuppliersRefresh() {
  const sups = await getSuppliers(true);
  $('#dl-suppliers').innerHTML = sups.filter((s) => !s.archived)
    .map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
}

/**
 * Vide le cache des factures. À appeler quand une autre partie de
 * l'application modifie la base — sans quoi la liste continue d'afficher
 * l'état d'avant, sans le moindre signe.
 */
export function invalidateInvoices() {
  cache = null;
  loading = null;
}

/** Place le curseur dans la recherche (raccourci « / ») */
export function focusSearch() {
  const s = $('#f-search');
  s.focus();
  s.select();
}

/** Rafraîchit complètement les données (après connexion ou changement externe) */
export async function refreshInvoices() {
  await Promise.all([getInvoices(true), getSuppliers(true)]);
}

// =====================================================================
// suppliers.js — CRUD fournisseurs, liste, fiche fournisseur
// =====================================================================
import { supabase } from './supabase.js';
import { getInvoices } from './invoices.js';
import { downloadInvoicesCSV } from './export.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage, openModal, closeModal,
  confirmDialog, skeletonRows, emptyRow, getMonth, monthLabel, inMonth,
  statusLabel, statusClass, isOverdue, slugify, notifyDataChange
} from './ui.js';
import { isManager } from './auth.js';

let cache = null;                 // liste des fournisseurs en mémoire
let detailId = null;              // fiche fournisseur ouverte (null = liste)
let detailAllPeriods = true;      // filtre de la fiche : toutes périodes / mois sélectionné
let onSupplierSaved = null;       // callback après création depuis la modale facture

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
export async function getSuppliers(force = false) {
  if (cache && !force) return cache;
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  cache = data || [];
  return cache;
}

export function suppliersCache() { return cache || []; }

export function supplierById(id) {
  return (cache || []).find((s) => s.id === id) || null;
}

export function supplierByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return (cache || []).find((s) => s.name.trim().toLowerCase() === n) || null;
}

// ---------------------------------------------------------------------
// Statistiques par fournisseur
// ---------------------------------------------------------------------
function statsFor(invoices) {
  let total = 0, paid = 0, due = 0;
  for (const i of invoices) {
    const t = Number(i.amount_tvac) || 0;
    total += t;
    if (i.payment_status === 'paye') paid += t; else due += t;
  }
  return { count: invoices.length, total, paid, due };
}

// ---------------------------------------------------------------------
// Liste des fournisseurs
// ---------------------------------------------------------------------
export async function renderSuppliers() {
  if (detailId) return renderSupplierDetail(detailId);

  $('#suppliers-list-view').hidden = false;
  $('#supplier-detail-view').hidden = true;

  const tbody = $('#suppliers-tbody');
  skeletonRows(tbody, 5, 5);

  let suppliers, invoices;
  try {
    [suppliers, invoices] = await Promise.all([getSuppliers(true), getInvoices()]);
  } catch (err) {
    console.error(err);
    emptyRow(tbody, 5, errorMessage(err, 'Chargement des fournisseurs impossible.'));
    toast(errorMessage(err, 'Chargement des fournisseurs impossible.'), 'error');
    return;
  }

  const q = ($('#sup-search').value || '').trim().toLowerCase();
  const showArchived = $('#sup-archived').checked;

  const rows = suppliers
    .filter((s) => showArchived || !s.archived)
    .filter((s) => !q || `${s.name} ${s.vat_number || ''} ${s.contact_name || ''} ${s.email || ''}`.toLowerCase().includes(q))
    .map((s) => ({ s, st: statsFor(invoices.filter((i) => i.supplier_id === s.id)) }))
    .sort((a, b) => b.st.total - a.st.total || a.s.name.localeCompare(b.s.name, 'fr'));

  if (!rows.length) {
    emptyRow(tbody, 5, 'Aucun fournisseur. Clique sur « + Nouveau fournisseur » pour commencer.');
    return;
  }

  tbody.innerHTML = rows.map(({ s, st }) => `
    <tr>
      <td data-label="Fournisseur">
        <button type="button" class="link-btn" data-open-supplier="${s.id}">${escapeHtml(s.name)}</button>
        ${s.archived ? '<span class="tag">archivé</span>' : ''}
        ${s.vat_number ? `<div class="muted small">${escapeHtml(s.vat_number)}</div>` : ''}
      </td>
      <td data-label="Délai" class="num">${Number(s.payment_terms ?? 30)} j</td>
      <td data-label="Factures" class="num">${st.count}</td>
      <td data-label="Total TVAC" class="num">${fmtEUR(st.total)}</td>
      <td data-label="Reste à payer" class="num ${st.due > 0 ? 'txt-red' : ''}">${fmtEUR(st.due)}</td>
    </tr>`).join('');
}

// ---------------------------------------------------------------------
// Fiche fournisseur
// ---------------------------------------------------------------------
export async function renderSupplierDetail(id) {
  detailId = id;
  $('#suppliers-list-view').hidden = true;
  $('#supplier-detail-view').hidden = false;

  let suppliers, invoices;
  try {
    [suppliers, invoices] = await Promise.all([getSuppliers(), getInvoices()]);
  } catch (err) {
    toast(errorMessage(err, 'Chargement impossible.'), 'error');
    return;
  }

  const s = suppliers.find((x) => x.id === id);
  if (!s) { detailId = null; return renderSuppliers(); }

  const month = getMonth();
  const all = invoices.filter((i) => i.supplier_id === id);
  const shown = detailAllPeriods ? all : all.filter((i) => inMonth(i.invoice_date, month));
  const st = statsFor(shown);

  $('#sd-name').textContent = s.name;
  $('#sd-contact').innerHTML = [
    s.vat_number ? `TVA : ${escapeHtml(s.vat_number)}` : '',
    s.contact_name ? `Contact : ${escapeHtml(s.contact_name)}` : '',
    s.email ? `<a href="mailto:${escapeHtml(s.email)}">${escapeHtml(s.email)}</a>` : '',
    s.phone ? `<a href="tel:${escapeHtml(s.phone)}">${escapeHtml(s.phone)}</a>` : '',
    `Délai de paiement : ${Number(s.payment_terms ?? 30)} jours`,
    s.iban ? `IBAN : ${escapeHtml(s.iban)}` : ''
  ].filter(Boolean).join(' <span class="sep">·</span> ');
  $('#sd-notes').textContent = s.notes || '';
  $('#sd-notes').hidden = !s.notes;

  renderValidationPanel(s);

  $('#sd-period-label').textContent = detailAllPeriods ? 'Toutes périodes' : monthLabel(month);
  $('#sd-count').textContent = st.count;
  $('#sd-total').textContent = fmtEUR(st.total);
  $('#sd-paid').textContent = fmtEUR(st.paid);
  $('#sd-due').textContent = fmtEUR(st.due);
  $('#sd-due').classList.toggle('txt-red', st.due > 0);

  const tbody = $('#sd-tbody');
  if (!shown.length) {
    emptyRow(tbody, 9, detailAllPeriods ? 'Aucune facture pour ce fournisseur.' : `Aucune facture en ${monthLabel(month)}.`);
    return;
  }

  tbody.innerHTML = shown
    .slice()
    .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''))
    .map((i) => `
      <tr class="${isOverdue(i) ? 'row-overdue' : ''}">
        <td data-label="Date facture">${fmtDate(i.invoice_date)}</td>
        <td data-label="N° facture">${escapeHtml(i.invoice_number)}</td>
        <td data-label="Références">${(i.external_refs || []).length
          ? i.external_refs.map((r) => `<span class="ref-chip">${escapeHtml(r)}</span>`).join('')
          : '<span class="muted">—</span>'}</td>
        <td data-label="Encodée le">${fmtDate(i.encoded_at)}</td>
        <td data-label="Échéance">${fmtDate(i.due_date)}</td>
        <td data-label="Total TVAC" class="num">${fmtEUR(i.amount_tvac)}</td>
        <td data-label="Entrée stock">${fmtDate(i.stock_in) || '—'}</td>
        <td data-label="Sortie">${fmtDate(i.stock_out) || '—'}</td>
        <td data-label="Statut"><span class="badge ${statusClass(i.payment_status)}">${escapeHtml(statusLabel(i.payment_status))}</span></td>
      </tr>`).join('');

  // Export de la fiche
  $('#sd-export').onclick = () => {
    const suffix = detailAllPeriods ? 'complet' : getMonth();
    downloadInvoicesCSV(shown, `VK_fournisseur_${slugify(s.name)}_${suffix}.csv`);
  };
  $('#sd-edit').onclick = () => openSupplierModal(s, () => renderSupplierDetail(id));
}

// ---------------------------------------------------------------------
// Validation d'une fiche pré-remplie par l'extraction
//
// Chaque champ pré-rempli est affiché à côté de ce qui a été LU sur le
// document. Rien n'est modifié tant que le gérant n'a pas validé.
// ---------------------------------------------------------------------
function renderValidationPanel(s) {
  const box = $('#sd-validate');
  if (!s.needs_review) { box.hidden = true; box.innerHTML = ''; return; }

  const lu = s.extracted || {};
  const champ = (id, label, valeur, luValeur, type = 'text') => `
    <div class="vf-row">
      <label class="vf-label" for="${id}">${label}</label>
      <input id="${id}" type="${type}" value="${escapeHtml(valeur ?? '')}">
      <span class="vf-read">${luValeur
        ? `lu&nbsp;: <code>${escapeHtml(luValeur)}</code>`
        : '<span class="muted">non lu sur le document</span>'}</span>
    </div>`;

  box.hidden = false;
  box.innerHTML = `
    <div class="vf-head">
      <strong>Fiche créée automatiquement — à valider</strong>
      <span class="muted small">Pré-remplie depuis la facture. Corrige ce qui doit l'être, complète le reste, puis valide.</span>
    </div>

    <div class="vf-grid">
      ${champ('vf-name', 'Nom', s.name, lu.nom)}
      ${champ('vf-vat', 'N° TVA', s.vat_number, lu.tva)}
      ${champ('vf-address', 'Adresse de facturation', s.address, lu.adresse)}
      ${champ('vf-iban', 'IBAN', s.iban, lu.iban)}
    </div>

    <p class="vf-manual-title">À compléter à la main</p>
    <div class="vf-grid">
      ${champ('vf-contact', 'Contact', s.contact_name, null)}
      ${champ('vf-email', 'E-mail de contact', s.email, lu.email, 'email')}
      ${champ('vf-phone', 'Téléphone', s.phone, null, 'tel')}
      ${champ('vf-terms', 'Conditions de paiement (jours)', s.payment_terms ?? 30, null, 'number')}
    </div>

    <div class="vf-actions">
      <span class="muted small">Les corrections sont journalisées.</span>
      <button type="button" class="btn btn-primary" id="vf-save">Valider la fiche</button>
    </div>`;

  $('#vf-save').onclick = () => validateSupplier(s.id);
}

async function validateSupplier(id) {
  const btn = $('#vf-save');
  btn.disabled = true;
  try {
    const changes = {
      name: $('#vf-name').value.trim(),
      vat_number: $('#vf-vat').value.trim(),
      address: $('#vf-address').value.trim(),
      iban: $('#vf-iban').value.trim(),
      contact_name: $('#vf-contact').value.trim(),
      email: $('#vf-email').value.trim(),
      phone: $('#vf-phone').value.trim(),
      payment_terms: String(Number($('#vf-terms').value) || 30)
    };
    if (!changes.name) { toast('Le nom du fournisseur est obligatoire.', 'error'); btn.disabled = false; return; }
    const { error } = await supabase.rpc('validate_supplier', { p_id: id, p_changes: changes });
    if (error) throw error;
    await getSuppliers(true);
    toast('Fiche validée.');
    notifyDataChange();
    renderSupplierDetail(id);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Validation impossible.'), 'error');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Modale création / édition fournisseur
// ---------------------------------------------------------------------
export function openSupplierModal(supplier = null, onSaved = null) {
  onSupplierSaved = onSaved;
  const f = $('#form-supplier');
  f.reset();
  $('#sup-id').value = supplier?.id || '';
  $('#sup-name').value = supplier?.name || '';
  $('#sup-vat').value = supplier?.vat_number || '';
  $('#sup-contact').value = supplier?.contact_name || '';
  $('#sup-email').value = supplier?.email || '';
  $('#sup-phone').value = supplier?.phone || '';
  $('#sup-terms').value = supplier?.payment_terms ?? 30;
  $('#sup-iban').value = supplier?.iban || '';
  $('#sup-notes').value = supplier?.notes || '';
  $('#sup-archived-field').hidden = !supplier;
  $('#sup-archived-input').checked = !!supplier?.archived;
  $('#modal-supplier-title').textContent = supplier ? 'Modifier le fournisseur' : 'Nouveau fournisseur';
  $('#sup-delete').hidden = !supplier || !isManager();
  openModal('modal-supplier');
}

/** Pré-remplit le nom (utilisé depuis la modale facture) */
export function openSupplierModalWithName(name, onSaved) {
  openSupplierModal(null, onSaved);
  $('#sup-name').value = name || '';
}

async function saveSupplier(e) {
  e.preventDefault();
  const id = $('#sup-id').value;
  const payload = {
    name: $('#sup-name').value.trim(),
    vat_number: $('#sup-vat').value.trim() || null,
    contact_name: $('#sup-contact').value.trim() || null,
    email: $('#sup-email').value.trim() || null,
    phone: $('#sup-phone').value.trim() || null,
    payment_terms: Number($('#sup-terms').value) || 0,
    iban: $('#sup-iban').value.trim() || null,
    notes: $('#sup-notes').value.trim() || null
  };
  if (id) payload.archived = $('#sup-archived-input').checked;

  if (!payload.name) { toast('Le nom du fournisseur est obligatoire.', 'error'); return; }

  const btn = $('#sup-save');
  btn.disabled = true; btn.classList.add('is-loading');
  try {
    let saved;
    if (id) {
      const { data, error } = await supabase.from('suppliers').update(payload).eq('id', id).select().single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase.from('suppliers').insert(payload).select().single();
      if (error) throw error;
      saved = data;
    }
    await getSuppliers(true);
    closeModal('modal-supplier');
    toast(id ? 'Fournisseur modifié.' : 'Fournisseur créé.');
    const cb = onSupplierSaved; onSupplierSaved = null;
    if (cb) cb(saved);
    notifyDataChange();
  } catch (err) {
    console.error(err);
    if (/duplicate key|23505/i.test(err.message || '')) {
      toast('Un fournisseur porte déjà ce nom.', 'error');
    } else {
      toast(errorMessage(err, 'Enregistrement du fournisseur impossible.'), 'error');
    }
  } finally {
    btn.disabled = false; btn.classList.remove('is-loading');
  }
}

async function deleteSupplier() {
  const id = $('#sup-id').value;
  if (!id) return;
  const ok = await confirmDialog('Supprimer définitivement ce fournisseur ? (impossible s\'il a des factures)', 'Supprimer');
  if (!ok) return;
  try {
    const { error } = await supabase.from('suppliers').delete().eq('id', id);
    if (error) throw error;
    await getSuppliers(true);
    closeModal('modal-supplier');
    detailId = null;
    toast('Fournisseur supprimé.');
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Suppression impossible : ce fournisseur a des factures.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initSuppliers() {
  $('#form-supplier').addEventListener('submit', saveSupplier);
  $('#sup-delete').addEventListener('click', deleteSupplier);
  $('#btn-new-supplier').addEventListener('click', () => openSupplierModal(null, () => renderSuppliers()));
  $('#sup-search').addEventListener('input', () => renderSuppliers());
  $('#sup-archived').addEventListener('change', () => renderSuppliers());

  // Ouverture d'une fiche depuis la liste
  $('#suppliers-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-supplier]');
    if (btn) renderSupplierDetail(btn.dataset.openSupplier);
  });

  $('#sd-back').addEventListener('click', () => { detailId = null; renderSuppliers(); });
  $$('#sd-period button').forEach((b) => b.addEventListener('click', () => {
    detailAllPeriods = b.dataset.period === 'all';
    $$('#sd-period button').forEach((x) => x.classList.toggle('active', x === b));
    renderSupplierDetail(detailId);
  }));
}

/** Remet la vue fournisseurs sur la liste (utilisé lors d'un changement d'onglet) */
export function resetSupplierView() { detailId = null; }

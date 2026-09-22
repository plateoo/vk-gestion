// =====================================================================
// suppliers.js — CRUD fournisseurs, liste, fiche fournisseur
// =====================================================================
import { supabase } from './supabase.js';
import { getInvoices, invalidateInvoices } from './invoices.js';
import { downloadInvoicesCSV } from './export.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage, openModal, closeModal,
  confirmDialog, skeletonRows, emptyRow, getMonth, monthLabel, inMonth,
  statusLabel, statusClass, isOverdue, slugify, notifyDataChange, estDue
} from './ui.js';
import { isManager } from './auth.js';
import { findSupplierDuplicates, NIVEAU_LABELS } from './duplicates.js';

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
    if (i.payment_status === 'paye') paid += t;
    else if (estDue(i)) due += t;   // « avant reprise » n'est dû à personne
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

  renderSupplierDuplicates(suppliers, invoices);

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
  renderMemoryPanel(s);

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
  const boutonFusion = $('#sd-merge');
  if (boutonFusion) {
    boutonFusion.hidden = !isManager();
    boutonFusion.onclick = () => ouvrirChoixFusion(s);
  }
}

/**
 * Réunir cette fiche avec une autre, choisie à la main.
 *
 * Le rapprochement automatique ne repère que les noms qui se ressemblent.
 * « VDBK » et « Vanden Borre Kitchen » désignent la même société sans se
 * ressembler du tout, et aucune machine ne le devinera. Le gérant, lui,
 * le sait : il faut donc pouvoir le lui dire.
 *
 * La fiche ouverte est celle qui DISPARAÎT — c'est elle qu'on regarde, et
 * c'est le sens de « la réunir avec une autre ». Le libellé le répète, car
 * se tromper de sens ici déplace les factures à l'envers.
 */
async function ouvrirChoixFusion(fiche) {
  const autres = suppliersCache()
    .filter((x) => x.id !== fiche.id && !x.merged_into && !x.archived)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (!autres.length) return toast('Il n\'y a aucune autre fiche avec laquelle la réunir.', 'error');

  $('#modal-fusion-body').innerHTML = `
    <p class="fusion-intro">Réunir « <strong>${escapeHtml(fiche.name)}</strong> » avec une autre fiche</p>
    <p class="muted small">Les factures de <strong>${escapeHtml(fiche.name)}</strong> seront
      rattachées à la fiche choisie, et cette fiche-ci disparaîtra.</p>
    <label for="fusion-cible">Fiche à conserver</label>
    <select id="fusion-cible" class="search">
      ${autres.map((x) => `<option value="${x.id}">${escapeHtml(x.name)}${
        x.vat_number ? ` — ${escapeHtml(x.vat_number)}` : ''}</option>`).join('')}
    </select>
    <div id="fusion-apercu" class="fusion-apercu muted small">Choisis une fiche pour voir ce qui se passera.</div>
    <div class="modal-actions">
      <button type="button" class="btn" data-close="modal-fusion">Annuler</button>
      <button type="button" class="btn btn-primary" id="fusion-ok" disabled>Réunir</button>
    </div>`;
  openModal('modal-fusion');

  const select = $('#fusion-cible');
  const apercu = $('#fusion-apercu');
  const valider = $('#fusion-ok');

  async function montrer() {
    valider.disabled = true;
    apercu.textContent = 'Vérification…';
    try {
      const { data, error } = await supabase.rpc('merge_preview', {
        p_keep: select.value, p_drop: fiche.id
      });
      if (error) throw error;
      const p = typeof data === 'string' ? JSON.parse(data) : data;
      apercu.innerHTML = apercuFusionHtml(p);
      valider.disabled = false;
    } catch (err) {
      console.error(err);
      apercu.textContent = errorMessage(err, 'Vérification impossible.');
    }
  }
  select.addEventListener('change', montrer);
  await montrer();

  valider.onclick = async () => {
    const cible = select.value;
    closeModal('modal-fusion');
    await executerFusion(cible, fiche.id);
  };
}

/** Ce qui va se passer, dit avant d'agir. */
function apercuFusionHtml(p) {
  const collisions = p.collisions || [];
  return `
    <p><strong>${p.a_deplacer}</strong> facture${p.a_deplacer > 1 ? 's' : ''}
       ${p.a_deplacer > 1 ? 'seront rattachées' : 'sera rattachée'} à
       « ${escapeHtml(p.nom_conserve)} ».</p>
    ${p.tva_differentes ? `
      <p class="fusion-alerte">Les deux fiches portent des numéros de TVA <strong>différents</strong> :
        ${escapeHtml(p.tva_conserve || '—')} et ${escapeHtml(p.tva_absorbe || '—')}.
        Ce sont peut-être deux sociétés distinctes — vérifie avant de continuer.</p>` : ''}
    ${collisions.length ? `
      <p class="fusion-alerte"><strong>${collisions.length} facture${collisions.length > 1 ? 's' : ''}
        ${collisions.length > 1 ? 'portent' : 'porte'} un numéro déjà présent</strong> sur la fiche
        conservée, et ${collisions.length > 1 ? 'resteront' : 'restera'} en place :</p>
      <ul class="fusion-collisions">
        ${collisions.map((c) => `<li>n° ${escapeHtml(c.invoice_number)} —
          ${escapeHtml(fmtDate(c.invoice_date))} — ${fmtEUR(c.amount_tvac)}</li>`).join('')}
      </ul>
      <p class="muted small">C'est un vrai doublon de facture : supprime celle qui est en trop,
        puis relance la réunion pour terminer.</p>` : ''}`;
}

// ---------------------------------------------------------------------
// Valeurs mémorisées
//
// Uniquement des champs de nature stable. Elles servent à pré-remplir les
// prochaines factures, jamais à remplacer une valeur lue sur un document.
// ---------------------------------------------------------------------
const MEMOIRE = [
  { champ: 'payment_terms',        label: 'Délai de paiement (jours)', type: 'number' },
  { champ: 'default_vat_rate',     label: 'Taux de TVA habituel',      type: 'select',
    options: [['', '—'], ['0.21', '21 %'], ['0.12', '12 %'], ['0.06', '6 %'], ['0.00', '0 %']] },
  { champ: 'default_expense_type', label: 'Type de dépense habituel',  type: 'text' },
  { champ: 'discount_rate',        label: 'Escompte (%)',              type: 'number', step: '0.01' },
  { champ: 'discount_days',        label: 'Délai d\'escompte (jours)', type: 'number' }
];

function renderMemoryPanel(s) {
  const box = $('#sd-memory');
  if (!box) return;
  const renseignes = MEMOIRE.filter((m) => s[m.champ] !== null && s[m.champ] !== undefined && s[m.champ] !== '');

  box.innerHTML = `
    <div class="card-head" style="padding:0 0 10px">
      <h2>Valeurs mémorisées</h2>
      <p class="muted small">Servent à pré-remplir les prochaines factures. Une valeur lue sur un
        document n'est jamais remplacée : les deux sont alors montrées et c'est toi qui tranches.</p>
    </div>
    <div class="memo-grid">
      ${MEMOIRE.map((m) => {
        const v = s[m.champ] ?? '';
        const id = `mem-${m.champ}`;
        const champ = m.type === 'select'
          ? `<select id="${id}" data-mem="${m.champ}">${m.options.map(([val, lib]) =>
              `<option value="${val}" ${String(v) === val || (val === '' && v === '') ? 'selected' : ''}>${lib}</option>`).join('')}</select>`
          : `<input id="${id}" data-mem="${m.champ}" type="${m.type}" ${m.step ? `step="${m.step}"` : ''} value="${escapeHtml(String(v))}">`;
        return `<div class="memo-row">
            <label class="vf-label" for="${id}">${m.label}</label>
            ${champ}
            ${v !== '' ? `<button type="button" class="link-btn" data-mem-clear="${m.champ}">retirer</button>` : ''}
          </div>`;
      }).join('')}
    </div>
    <div class="vf-actions">
      <span class="muted small">${renseignes.length} valeur${renseignes.length > 1 ? 's' : ''} mémorisée${renseignes.length > 1 ? 's' : ''} · chaque modification est journalisée</span>
      <button type="button" class="btn btn-primary" id="mem-save">Enregistrer</button>
    </div>`;

  $('#mem-save').onclick = () => enregistrerMemoire(s.id);
  $$('#sd-memory [data-mem-clear]').forEach((b) => b.addEventListener('click', () => {
    const el = $(`#mem-${b.dataset.memClear}`);
    if (el) el.value = '';
  }));
}

async function enregistrerMemoire(id) {
  const btn = $('#mem-save');
  btn.disabled = true;
  try {
    let n = 0;
    for (const m of MEMOIRE) {
      const el = $(`#mem-${m.champ}`);
      if (!el) continue;
      const { error } = await supabase.rpc('remember_supplier_value', {
        p_supplier: id, p_field: m.champ, p_value: el.value, p_source: 'fiche fournisseur'
      });
      if (error) throw error;
      n += 1;
    }
    await getSuppliers(true);
    toast('Valeurs mémorisées enregistrées.');
    notifyDataChange();
    renderSupplierDetail(id);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Enregistrement impossible.'), 'error');
    btn.disabled = false;
  }
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
  // Un pays connu mais absent de la liste courte — PT, DK… — se range sous
  // « Autre » plutôt que de disparaître en silence à l'enregistrement.
  const paysConnus = [...$('#sup-country').options].map((o) => o.value);
  $('#sup-country').value = !supplier?.country ? ''
    : (paysConnus.includes(supplier.country) ? supplier.country : '__autre');
  $('#sup-country').dataset.reel = supplier?.country || '';
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
    // « Autre » conserve le code réel de la fiche : on ne le remplace pas
    // par un fourre-tout qui ferait perdre l'information.
    country: $('#sup-country').value === '__autre'
      ? ($('#sup-country').dataset.reel || null)
      : ($('#sup-country').value || null),
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
/**
 * Fiches en double, avec de quoi les réunir.
 *
 * Fusionner déplace les factures et conserve les adresses connues de la
 * fiche absorbée, pour que la reconnaissance automatique continue de
 * fonctionner sur ses e-mails. C'est irréversible : on nomme donc
 * précisément ce qui part et ce qui reste.
 */
function renderSupplierDuplicates(suppliers, invoices) {
  const box = $('#sup-dup');
  if (!box) return;
  const groupes = isManager() ? findSupplierDuplicates(suppliers, invoices) : [];
  if (!groupes.length) { box.hidden = true; box.innerHTML = ''; return; }

  const fiches = groupes.reduce((n, g) => n + g.suppliers.length, 0);
  box.hidden = false;
  box.innerHTML = `
    <div class="card-head" style="padding:0 0 8px">
      <h2>${groupes.length} fournisseur${groupes.length > 1 ? 's' : ''} en double</h2>
      <p class="muted small">${fiches} fiches pour ${groupes.length} société${groupes.length > 1 ? 's' : ''}.
        Tant qu'elles sont séparées, les totaux par fournisseur sont faux.</p>
    </div>
    ${groupes.map((g, k) => {
      const garde = g.suppliers[0];
      return `
      <div class="dup-sup">
        <div class="dup-sup-head">
          <span class="dup-level dup-${g.niveau}">${escapeHtml(NIVEAU_LABELS[g.niveau])}</span>
          <span class="dup-reason">${escapeHtml(g.motif)}</span>
        </div>
        <ul class="dup-sup-list">
          ${g.suppliers.map((s, idx) => `
            <li>
              <span class="dup-sup-name">${escapeHtml(s.name)}</span>
              <span class="muted small">${s.factures} facture${s.factures > 1 ? 's' : ''}${
                s.vat_number ? ` <span class="sep">·</span> ${escapeHtml(s.vat_number)}` : ''}</span>
              ${idx === 0
                ? '<span class="tag">fiche conservée</span>'
                : `<button type="button" class="btn btn-sm" data-merge-keep="${garde.id}" data-merge-drop="${s.id}"
                     data-merge-label="${escapeHtml(s.name)}" data-merge-into="${escapeHtml(garde.name)}"
                     data-merge-count="${s.factures}">Réunir dans « ${escapeHtml(garde.name)} »</button>`}
            </li>`).join('')}
        </ul>
      </div>`;
    }).join('')}`;
}

async function fusionner(btn) {
  btn.disabled = true;
  try {
    await executerFusion(btn.dataset.mergeKeep, btn.dataset.mergeDrop);
  } finally {
    btn.disabled = false;
  }
}

/**
 * Réunir deux fiches, en disant la vérité avant et après.
 *
 * Avant : on demande à la base ce qui va bouger et ce qui va se heurter.
 * Une facture dont le numéro existe des deux côtés est un vrai doublon —
 * elle ne peut pas être déplacée, et il faut le dire AVANT, pas découvrir
 * après coup que la fiche n'a pas disparu.
 *
 * Après : on rapporte ce qui s'est réellement passé, y compris quand le
 * travail est incomplet. C'est ce qui manquait : une fusion partielle
 * s'annonçait comme un succès, et le gérant retrouvait ses deux fiches
 * sans comprendre pourquoi.
 */
async function executerFusion(keep, drop) {
  let p;
  try {
    const { data, error } = await supabase.rpc('merge_preview', { p_keep: keep, p_drop: drop });
    if (error) throw error;
    p = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {
    console.error(err);
    return toast(errorMessage(err, 'Vérification impossible.'), 'error');
  }

  const collisions = p.collisions || [];
  const message = [
    `Réunir « ${p.nom_absorbe} » dans « ${p.nom_conserve} » ?`,
    '',
    `${p.a_deplacer} facture(s) seront rattachées à la fiche conservée, avec les adresses `
      + 'e-mail connues pour que la reconnaissance automatique continue de fonctionner.',
    p.tva_differentes
      ? `\nATTENTION : les deux fiches portent des numéros de TVA différents — `
        + `${p.tva_conserve || '—'} et ${p.tva_absorbe || '—'}. Ce sont peut-être deux sociétés `
        + 'distinctes. Vérifie avant de continuer.'
      : '',
    collisions.length
      ? `\n${collisions.length} facture(s) ne pourront PAS être déplacées : leur numéro existe `
        + `déjà sur la fiche conservée.\n`
        + collisions.slice(0, 5).map((c) => `  • n° ${c.invoice_number} — ${fmtDate(c.invoice_date)} — ${fmtEUR(c.amount_tvac)}`).join('\n')
        + (collisions.length > 5 ? `\n  … et ${collisions.length - 5} autre(s)` : '')
        + '\nCe sont de vrais doublons de facture : la fiche restera en place tant qu\'ils '
        + 'n\'auront pas été supprimés.'
      : '\nLa fiche absorbée disparaîtra. Cette action ne peut pas être annulée.'
  ].filter(Boolean).join('\n');

  const ok = await confirmDialog(message, 'Réunir les fiches');
  if (!ok) return;

  try {
    const { data, error } = await supabase.rpc('merge_suppliers', { p_keep: keep, p_drop: drop });
    if (error) throw error;
    const r = typeof data === 'string' ? JSON.parse(data) : data;

    invalidateInvoices();
    await getSuppliers(true);
    notifyDataChange();
    detailId = null;
    renderSuppliers();

    if (r.supprimee) {
      toast(`Fiches réunies — ${r.moved_invoices} facture(s) rattachée(s) à « ${r.nom_conserve} ».`);
    } else {
      // Le travail est incomplet et l'utilisateur doit le savoir tout de
      // suite, avec le geste précis qui débloque la situation.
      const nums = (r.collisions || []).slice(0, 3).join(', ');
      await confirmDialog(
        `${r.moved_invoices} facture(s) rattachée(s) à « ${r.nom_conserve} ».\n\n`
        + `Mais « ${r.nom_absorbe} » n'a pas pu disparaître : ${r.restantes} facture(s) y restent, `
        + `parce que leur numéro existe déjà sur la fiche conservée`
        + (nums ? ` (${nums}${(r.collisions || []).length > 3 ? '…' : ''})` : '')
        + '.\n\nOuvre la vue Doublons, supprime la facture en trop, puis relance la réunion.',
        'Compris');
    }
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Impossible de réunir les fiches.'), 'error');
  }
}

export function initSuppliers() {
  $('#sup-dup')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-merge-keep]');
    if (b) fusionner(b);
  });

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

// =====================================================================
// invoices.js — CRUD factures, filtres, tableau, modale de saisie
// =====================================================================
import { supabase } from './supabase.js';
import { getSuppliers, suppliersCache, supplierById, supplierByName, openSupplierModalWithName } from './suppliers.js';
import { downloadInvoicesCSV } from './export.js';
import { findDuplicates, duplicateCount, NIVEAU_LABELS } from './duplicates.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage, openModal, closeModal,
  confirmDialog, skeletonRows, getMonth, setMonth, monthLabel, shiftMonth,
  currentMonthKey, inMonth, inPeriod, getPeriod, setPeriod, periodLabel, estDue,
  statusLabel, statusClass, isOverdue, isDueSoon, isComplete,
  todayISO, addDays, longDate, notifyDataChange, ICONS, openPopover, closePopover
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
  stock: '',           // '' | 'sans'
  // Vue du tableau. Par défaut on ne montre que les factures : les pièces
  // classées « document » — conditions générales, bons de commande — ont
  // leur propre vue et ne doivent jamais polluer la liste à encoder.
  view: 'factures'     // 'factures' | 'a_controler' | 'arrivees' | 'documents' | 'doublons'
};

// Valeurs d'ensemble du filtre fournisseur. Préfixées pour ne jamais
// entrer en collision avec un identifiant de fiche.
const PAYS_BE = '__pays_be';
const PAYS_ETRANGER = '__pays_etranger';
const PAYS_INCONNU = '__pays_inconnu';

// Tri actif
let sort = { key: 'invoice_date', dir: 'desc' };

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
export async function getInvoices(force = false) {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    // On énumère les colonnes au lieu de prendre « * » : extraction_notes
    // pesait 43 % du chargement — 140 Ko sur 325 — alors que cet écran ne
    // s'en sert pas. Seul « À contrôler » en a besoin, et il a sa propre
    // requête. Sur une année de factures, cela fait plus d'un mégaoctet
    // épargné à chaque ouverture.
    const { data, error } = await supabase
      .from('invoices')
      .select(`id, supplier_id, invoice_number, invoice_date, due_date, encoded_at,
               amount_htva, vat_rate, amount_tvac, amount_paid,
               discount_rate, discount_days, discount_deadline, amount_discounted,
               in_smart, in_winauditor, smart_ref, external_refs,
               stock_in, stock_out, payment_status, payment_date, payment_method,
               expense_type, notes, review_status, doc_type, doc_summary,
               vat_amount, forced_at, forced_name, forced_reason, validated_name,
               source, file_path, sender_email, message_id, created_at,
               supplier:suppliers(id, name, payment_terms)`)
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
  // Même règle que par la pastille : ces deux vues ne se bornent pas à une
  // période, et la période réelle doit le refléter à l'écran.
  if (patch.period === 'all' || filters.view === 'documents' || filters.view === 'arrivees') {
    setPeriod({ kind: 'all' });
  }
  syncFilterInputs();
  renderInvoices();
}

export function resetFilters() {
  Object.assign(filters, { q: '', period: 'month', supplier: '', status: '', smart: '', winauditor: '', stock: '', view: 'factures' });
  syncFilterInputs();
}

// ---------------------------------------------------------------------
// Filtrage / tri
// ---------------------------------------------------------------------
/**
 * Coupe une liste par journée d'arrivée, la plus récente d'abord.
 *
 * L'en-tête dit ce qu'on a besoin de savoir d'un coup d'œil : combien de
 * pièces, de quel fournisseur, pour quel montant. Quand tout vient du
 * même fournisseur — le cas de la facturation groupée — on le nomme ;
 * au-delà de trois, on compte.
 */
/** Nombre de pièces entrées depuis hier — ce que la pastille annonce. */
export function compterArrivees(rows, jours = 2) {
  const depuis = addDays(todayISO(), -(jours - 1));
  return (rows || []).filter((i) => String(i.created_at || '').slice(0, 10) >= depuis).length;
}

/** Le détail de ce qui vient d'arriver, pour le tableau de bord. */
export function resumeArrivees(rows, jours = 2) {
  const depuis = addDays(todayISO(), -(jours - 1));
  const recentes = (rows || []).filter((i) => String(i.created_at || '').slice(0, 10) >= depuis);
  const noms = [...new Set(recentes.map((i) => i.supplier_name).filter(Boolean))];
  return { nombre: recentes.length, fournisseurs: noms };
}

function groupesParJour(pieces) {
  const auj = todayISO();
  const hier = addDays(auj, -1);
  const groupes = new Map();

  for (const i of pieces) {
    const jour = String(i.created_at || '').slice(0, 10) || '—';
    if (!groupes.has(jour)) groupes.set(jour, []);
    groupes.get(jour).push(i);
  }

  return [...groupes.entries()].map(([jour, liste]) => {
    const noms = [...new Set(liste.map((i) => i.supplier_name).filter(Boolean))];
    const aControler = liste.filter((i) => i.review_status === 'a_controler').length;
    return {
      jour,
      libelle: jour === auj ? "Aujourd'hui" : jour === hier ? 'Hier' : longDate(jour),
      resume: `${liste.length} pièce${liste.length > 1 ? 's' : ''}`
        + (noms.length && noms.length <= 3 ? ` · ${noms.join(', ')}` : ` · ${noms.length} fournisseurs`)
        + (aControler ? ` · ${aControler} à contrôler` : ''),
      total: liste.reduce((s2, i) => s2 + (Number(i.amount_tvac) || 0), 0),
      pieces: liste
    };
  });
}

function applyFilters(rows) {
  const month = getMonth();
  const q = filters.q.trim().toLowerCase();
  return rows.filter((i) => {
    const estDocument = i.review_status === 'document';
    // Les arrivées montrent TOUT ce qui est entré, pièces classées
    // « document » comprises : quand un fournisseur envoie dix fichiers,
    // en cacher trois ferait chercher ce qui n'a jamais disparu.
    if (filters.view === 'arrivees') { /* rien n'est écarté */ }
    else if (filters.view === 'documents') { if (!estDocument) return false; }
    else if (estDocument) return false;
    if (filters.view === 'a_controler' && i.review_status !== 'a_controler') return false;
    // « month » veut dire : restreindre à la période affichée, quelle qu'elle
    // soit — mois, trimestre, année ou dates libres.
    //
    // Sauf dans les arrivées : un fournisseur qui envoie aujourd'hui six ans
    // d'arriéré doit les voir apparaître, et aucun d'eux n'est du mois
    // affiché. C'est précisément le cas que Jordan décrit.
    if (filters.view !== 'arrivees' && filters.period !== 'all' && !inPeriod(i.invoice_date)) return false;
    if (filters.supplier) {
      const pays = supplierById(i.supplier_id)?.country || null;
      if (filters.supplier === PAYS_BE) { if (pays !== 'BE') return false; }
      else if (filters.supplier === PAYS_ETRANGER) { if (!pays || pays === 'BE') return false; }
      else if (filters.supplier === PAYS_INCONNU) { if (pays) return false; }
      else if (i.supplier_id !== filters.supplier) return false;
    }
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
  // Les listes de trimestres et d'années se bâtissent sur les factures
  // chargées : il faut donc les remplir une fois le cache en place.
  syncPeriodInputs();

  // Compteurs des vues : sur toutes les périodes, sinon le chiffre changerait
  // en même temps que le mois affiché et ne voudrait plus rien dire.
  const nbReview = rows.filter((i) => i.review_status === 'a_controler').length;
  const nbDocs = rows.filter((i) => i.review_status === 'document').length;
  const groupes = findDuplicates(rows);
  const nbDup = duplicateCount(groupes);
  const cReview = $('#chip-count-review');
  const cDocs = $('#chip-count-docs');
  const cDup = $('#chip-count-dup');
  // La pastille des arrivées compte CE QUI VIENT D'ENTRER, pas tout
  // l'historique : un chiffre à 254 ne dirait rien. Les deux derniers
  // jours — assez pour couvrir un lundi matin après un envoi du vendredi.
  const nbNouvelles = compterArrivees(rows);
  const cNew = $('#chip-count-new');
  if (cReview) { cReview.textContent = nbReview; cReview.hidden = nbReview === 0; }
  if (cDocs) { cDocs.textContent = nbDocs; cDocs.hidden = nbDocs === 0; }
  if (cDup) { cDup.textContent = nbDup; cDup.hidden = nbDup === 0; }
  if (cNew) { cNew.textContent = nbNouvelles; cNew.hidden = nbNouvelles === 0; }

  // La vue des doublons ne se filtre pas comme les autres : elle montre des
  // groupes, et un groupe n'a de sens que complet. Le restreindre au mois
  // affiché couperait la facture jumelle arrivée le mois d'avant — et c'est
  // précisément celle qu'on cherche.
  if (filters.view === 'doublons') {
    lastRows = groupes.flatMap((g) => g.invoices);
    $('#inv-foot-count').textContent = nbDup
      ? `${groupes.length} groupe${groupes.length > 1 ? 's' : ''} · ${nbDup} facture${nbDup > 1 ? 's' : ''}`
      : 'Aucun doublon';
    $('#inv-foot-htva').textContent = '';
    $('#inv-foot-total').textContent = '';
    if (!groupes.length) {
      emptyState(tbody, 'Aucun doublon détecté : aucune facture ne se retrouve deux fois dans la liste.', false);
      updateSortIndicators();
      updateBulkBar();
      return;
    }
    tbody.innerHTML = groupes.map((g) => `
      <tr class="dup-head"><td colspan="13">
        <span class="dup-level dup-${g.niveau}">${escapeHtml(NIVEAU_LABELS[g.niveau])}</span>
        <span class="dup-reason">${escapeHtml(g.motif)}</span>
      </td></tr>
      ${g.invoices.map((i) => rowHtml(i, isManager())).join('')}`).join('');
    updateSortIndicators();
    updateBulkBar();
    return;
  }

  // Les arrivées : triées par entrée dans l'application, pas par date de
  // facture, et coupées par journée. C'est la réponse à « qu'est-ce qui
  // vient d'arriver ? », une question que le tri par date de facture ne
  // peut pas répondre.
  if (filters.view === 'arrivees') {
    const arrivees = applyFilters(rows).slice()
      .sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
    lastRows = arrivees;

    const totalTvac = arrivees.reduce((s2, i) => s2 + (Number(i.amount_tvac) || 0), 0);
    $('#inv-foot-count').textContent = `${arrivees.length} pièce${arrivees.length > 1 ? 's' : ''}`;
    $('#inv-foot-htva').textContent = '';
    $('#inv-foot-total').textContent = fmtEUR(totalTvac);

    if (!arrivees.length) {
      emptyState(tbody, 'Rien n\'est encore arrivé dans l\'application.', false);
      updateSortIndicators();
      updateBulkBar();
      return;
    }

    const manager = isManager();
    tbody.innerHTML = groupesParJour(arrivees)
      .map((g) => `
        <tr class="jour-head"><td colspan="13">
          <span class="jour-label">${escapeHtml(g.libelle)}</span>
          <span class="jour-detail">${escapeHtml(g.resume)}</span>
          <span class="jour-total">${fmtEUR(g.total)}</span>
        </td></tr>
        ${g.pieces.map((i) => rowHtml(i, manager)).join('')}`).join('');
    updateSortIndicators();
    updateBulkBar();
    return;
  }

  const filtered = applySort(applyFilters(rows));
  lastRows = filtered;

  // Pied de tableau : total des lignes affichées
  const totalTvac = filtered.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  const totalHtva = filtered.reduce((s, i) => s + (Number(i.amount_htva) || 0), 0);
  $('#inv-foot-count').textContent = `${filtered.length} facture${filtered.length > 1 ? 's' : ''}`;
  $('#inv-foot-htva').textContent = fmtEUR(totalHtva);
  $('#inv-foot-total').textContent = fmtEUR(totalTvac);

  if (!filtered.length) {
    const vide = filters.view === 'arrivees'
      ? 'Rien n\'est arrivé récemment.'
      : filters.view === 'documents'
      ? 'Aucune pièce classée « document ». Les conditions générales et bons de commande reçus par e-mail apparaîtront ici.'
      : filters.view === 'a_controler'
        ? 'Rien à contrôler : toutes les factures reçues ont été vérifiées.'
        : filters.period !== 'all'
          ? `Aucune facture sur la période : ${periodLabel().toLowerCase()}`
          : 'Aucune facture ne correspond aux filtres';
    emptyState(tbody, vide, filters.view === 'factures');
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

/** Libellés des natures de document lues par l'extraction */
const DOC_LABELS = {
  facture: 'Facture',
  note_credit: 'Note de crédit',
  conditions_generales: 'Conditions générales',
  bon_commande: 'Bon de commande',
  proforma: 'Proforma',
  listing: 'Listing',
  rappel: 'Rappel',
  autre: 'Autre'
};

/**
 * Ligne d'une pièce qui n'est pas une facture. Rien à encoder : on montre
 * ce que c'est et la synthèse qui permet de le reconnaître sans l'ouvrir,
 * plus un bouton pour la ramener dans les factures si le tri s'est trompé.
 */
function docRowHtml(i) {
  // Le numéro d'une pièce non facturable EST son nom de fichier, préfixé
  // « DOC- » à la création. On le relit donc de là, sans avoir besoin des
  // notes d'extraction — que cet écran ne charge volontairement plus.
  const nom = i.invoice_number.replace(/^DOC-/, '');
  return `
  <tr data-id="${i.id}" class="row-document" data-open="${i.id}">
    <td class="td-check no-print"></td>
    <td class="td-date" data-label="Reçu le">${fmtDate(i.invoice_date)}</td>
    <td class="td-supplier" data-label="Fournisseur">${escapeHtml(i.supplier_name)}</td>
    <td class="td-doc" colspan="9" data-label="Document">
      <span class="doc-kind">${escapeHtml(DOC_LABELS[i.doc_type] || 'Autre')}</span>
      <span class="doc-file">${escapeHtml(nom)}</span>
      ${i.doc_summary ? `<span class="doc-summary">${escapeHtml(i.doc_summary)}</span>` : ''}
    </td>
    <td class="td-actions no-print">
      <button type="button" class="btn btn-sm" data-requalify="${i.id}"
        title="Cette pièce est en réalité une facture : la remettre dans la liste à contrôler">C'est une facture</button>
    </td>
  </tr>`;
}

function rowHtml(i, manager) {
  if (i.review_status === 'document') return docRowHtml(i);
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
    <td class="td-number" data-label="N°">${escapeHtml(i.invoice_number)}${i.forced_at
      ? `<span class="badge st-forcee" title="Acceptée en forçant par ${escapeHtml(i.forced_name || '—')} : ${escapeHtml(i.forced_reason || '')}">forcée</span>`
      : ''}${i.vat_amount != null
      ? '<span class="badge st-forcee" title="TVA saisie à la main : la facture porte plusieurs taux">TVA saisie</span>'
      : ''}<span class="mob-meta">${fmtDate(i.invoice_date)}${i.due_date ? ` · éch. ${fmtDate(i.due_date)}` : ''}</span></td>
    <td class="td-smartref" data-label="Réf. Smart">
      <input type="text" class="smartref-input" data-smartref="${i.id}"
        value="${escapeHtml(i.smart_ref || '')}" placeholder="à saisir" autocomplete="off" spellcheck="false"
        aria-label="Référence Smart de la facture ${escapeHtml(i.invoice_number)}"></td>
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
      ${manager ? `<button type="button" class="icon-btn row-action danger" data-delete="${i.id}"
        title="Supprimer cette facture">${ICONS.trash}</button>` : ''}
      <button type="button" class="icon-btn row-menu" data-menu="${i.id}" title="Autres actions" aria-haspopup="menu">${ICONS.dots}</button>
    </td>
  </tr>`;
}

/**
 * Enregistre la référence Smart saisie dans le tableau. Renseigner la
 * référence coche « Encodé Smart » : la référence fait foi, on ne peut pas
 * avoir un numéro Smart sans être encodé dans Smart. L'effacer décoche.
 */
async function saveSmartRef(id, valeur, champ) {
  const inv = findInvoice(id);
  if (!inv) return;
  const ref = valeur.trim();
  if (ref === (inv.smart_ref || '')) return;      // rien n'a changé
  const key = `${id}:smart_ref`;
  if (busy.has(key)) return;
  busy.add(key);

  const avant = { smart_ref: inv.smart_ref, in_smart: inv.in_smart };
  inv.smart_ref = ref || null;
  inv.in_smart = ref ? true : inv.in_smart;
  champ.classList.add('saving');

  try {
    const { error } = await supabase.from('invoices')
      .update({ smart_ref: inv.smart_ref, in_smart: inv.in_smart }).eq('id', id);
    if (error) throw error;
    champ.classList.remove('saving');
    champ.classList.add('saved');
    setTimeout(() => champ.classList.remove('saved'), 1200);

    // La pastille Smart doit suivre immédiatement. On ne re-rend pas tout le
    // tableau : la ligne suivante est souvent déjà en cours de saisie, et un
    // re-rendu lui ferait perdre le focus au milieu d'un numéro.
    const cellule = champ.closest('tr')?.querySelector('.td-smart');
    if (cellule) cellule.innerHTML = smartPillHtml(inv);
    toast(ref ? `Référence Smart ${ref} — ${inv.invoice_number}`
              : `Référence Smart effacée — ${inv.invoice_number}`);
    notifyDataChange();
  } catch (err) {
    console.error(err);
    Object.assign(inv, avant);                    // rollback
    champ.classList.remove('saving');
    renderInvoices();
    // Le message de la base sur une référence déjà utilisée est illisible :
    // on dit laquelle, et sur quelle facture elle est déjà posée.
    const dejaPrise = /duplicate key|unique/i.test(err?.message || '');
    toast(dejaPrise
      ? `La référence Smart ${ref} est déjà utilisée sur une autre facture.`
      : errorMessage(err, 'Enregistrement de la référence impossible.'), 'error');
  } finally {
    busy.delete(key);
  }
}

/** Une pièce classée « document » est en fait une facture : on la rend à la liste. */
async function requalifier(id) {
  const inv = findInvoice(id);
  if (!inv) return;
  const ok = await confirmDialog(
    `Remettre « ${inv.doc_summary ? inv.invoice_number.replace(/^DOC-/, '') : inv.invoice_number} » `
    + 'dans les factures ? Elle repassera dans « À contrôler » pour être encodée normalement.',
    'Oui, c\'est une facture');
  if (!ok) return;
  try {
    const { error } = await supabase.rpc('set_document_kind', { p_invoice: id, p_kind: 'facture' });
    if (error) throw error;
    inv.review_status = 'a_controler';
    inv.doc_type = 'facture';
    toast('Pièce remise dans les factures à contrôler.');
    await getInvoices(true);
    renderInvoices();
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Requalification impossible.'), 'error');
  }
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

/**
 * Liste des fournisseurs, groupée par pays.
 *
 * Les achats intracommunautaires se déclarent à part — autoliquidation,
 * grilles séparées, listing intracommunautaire. Le comptable a besoin de
 * les voir ENSEMBLE, pas dispersés parmi les factures belges. D'où deux
 * entrées d'ensemble en tête de liste, avant les fournisseurs un par un.
 *
 * Le pays vient du numéro de TVA, jamais du taux : CESI est belge et
 * facture à 0 %. Une fiche sans numéro de TVA reste « à préciser » —
 * visible, plutôt que rangée d'office du mauvais côté.
 */
function fillSupplierFilter() {
  const sel = $('#f-supplier');
  const current = sel.value;
  const sups = suppliersCache().filter((s) => !s.archived || s.id === current);
  const parNom = (a, b) => a.name.localeCompare(b.name, 'fr');

  const belges = sups.filter((s) => s.country === 'BE').sort(parNom);
  const etrangers = sups.filter((s) => s.country && s.country !== 'BE').sort(parNom);
  const inconnus = sups.filter((s) => !s.country).sort(parNom);

  const groupe = (titre, liste) => liste.length
    ? `<optgroup label="${escapeHtml(titre)}">${liste
        .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}${
          s.country && s.country !== 'BE' ? ` (${s.country})` : ''}</option>`).join('')}</optgroup>`
    : '';

  sel.innerHTML =
    '<option value="">Tous les fournisseurs</option>' +
    (belges.length ? `<option value="${PAYS_BE}">— Tous les fournisseurs belges (${belges.length})</option>` : '') +
    (etrangers.length ? `<option value="${PAYS_ETRANGER}">— Tous les fournisseurs hors Belgique (${etrangers.length})</option>` : '') +
    (inconnus.length ? `<option value="${PAYS_INCONNU}">— Pays à préciser (${inconnus.length})</option>` : '') +
    groupe('Belgique', belges) +
    groupe('Hors Belgique', etrangers) +
    groupe('Pays à préciser', inconnus);

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
  if (!inv) return;
  // Rien n'est réversible ici : on nomme la facture au complet, faute de quoi
  // deux lignes qui se ressemblent — c'est tout le sujet des doublons — sont
  // impossibles à distinguer au moment de trancher.
  const ok = await confirmDialog(
    `Supprimer définitivement cette facture ?\n`
    + `${inv.supplier_name || '?'} · ${inv.invoice_number} · ${fmtDate(inv.invoice_date)} · ${fmtEUR(inv.amount_tvac)}`
    + `${inv.smart_ref ? ` · réf. Smart ${inv.smart_ref}` : ''}\n`
    + 'Le document d\'origine reste dans le stockage. Cette action ne peut pas être annulée.',
    'Supprimer');
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
  const rows = selectedInvoices().filter(estDue);
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
/**
 * Reprise d'historique.
 *
 * L'ancien franchisé a retransmis sa boîte : des dizaines de factures
 * échues depuis des mois, déjà réglées par lui, s'affichaient comme
 * impayées. Elles ne sont effacées ni masquées — elles reçoivent un état
 * qui dit ce qu'elles sont, et sortent du reste à payer.
 *
 * Réversible : le filtre « Avant reprise » les retrouve, et le même
 * bouton les remet dans le circuit.
 */
async function bulkTakeover() {
  const choisies = selectedInvoices();
  if (!choisies.length) return;

  // Si tout le lot est déjà marqué, le geste devient l'annulation : c'est
  // le même bouton, et il fait la seule chose qui ait du sens.
  const toutesMarquees = choisies.every((i) => i.payment_status === 'avant_reprise');
  const cibles = toutesMarquees
    ? choisies
    : choisies.filter((i) => i.payment_status === 'a_payer' || i.payment_status === 'en_retard');

  if (!cibles.length) {
    return toast('Aucune de ces factures n\'est concernée : les factures payées et les litiges ne sont pas touchés.', 'error');
  }

  const total = cibles.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  const ok = await confirmDialog(
    toutesMarquees
      ? `Remettre ${cibles.length} facture(s) dans le circuit de paiement ?\n`
        + `${fmtEUR(total)} repasseront en « à payer » et réapparaîtront dans les retards.`
      : `Déclarer ${cibles.length} facture(s) réglée(s) avant la reprise du magasin ?\n`
        + `${fmtEUR(total)} sortiront du reste à payer et des alertes de retard.\n`
        + 'SEUL LE PAIEMENT est concerné : elles restent à contrôler, à encoder dans Smart '
        + 'et à envoyer à WinAuditor comme les autres.\n'
        + 'Les factures payées et les litiges ne sont pas touchés.',
    toutesMarquees ? 'Remettre à payer' : 'Réglées avant reprise');
  if (!ok) return;

  try {
    const { data, error } = await supabase.rpc('mark_before_takeover', {
      p_ids: cibles.map((i) => i.id), p_undo: toutesMarquees
    });
    if (error) throw error;
    const r = typeof data === 'string' ? JSON.parse(data) : data;
    toast(toutesMarquees
      ? `${r.traitees} facture(s) remises à payer.`
      : `${r.traitees} facture(s) sorties du reste à payer.`);
    clearSelection();
    await getInvoices(true);
    renderInvoices();
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Opération impossible.'), 'error');
  }
}

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
/**
 * Remplit le sélecteur de période et n'affiche que le réglage utile :
 * la liste des trimestres, celle des années, ou les deux dates libres.
 * Les listes sont bâties sur les factures réellement en base — proposer
 * une année sans aucune facture n'apporte rien.
 */
function syncPeriodInputs() {
  const p = getPeriod();
  filters.period = p.kind === 'all' ? 'all' : 'month';
  $('#f-period').value = p.kind;

  const annees = [...new Set((cache || []).map((i) => String(i.invoice_date || '').slice(0, 4)).filter(Boolean))];
  if (!annees.includes(p.month.slice(0, 4))) annees.push(p.month.slice(0, 4));
  annees.sort().reverse();

  const selTrim = $('#f-quarter');
  selTrim.innerHTML = annees.flatMap((y) => [4, 3, 2, 1].map((q) =>
    `<option value="${y}-Q${q}">${periodLabel({ kind: 'quarter', quarter: `${y}-Q${q}` })}</option>`)).join('');
  if (!selTrim.querySelector(`[value="${p.quarter}"]`)) {
    selTrim.insertAdjacentHTML('afterbegin', `<option value="${p.quarter}">${periodLabel({ ...p, kind: 'quarter' })}</option>`);
  }
  selTrim.value = p.quarter;

  const selAn = $('#f-year');
  selAn.innerHTML = annees.map((y) => `<option value="${y}">${y}</option>`).join('');
  selAn.value = p.year;

  $('#f-from').value = p.from || '';
  $('#f-to').value = p.to || '';

  selTrim.hidden = p.kind !== 'quarter';
  selAn.hidden = p.kind !== 'year';
  $('#f-range').hidden = p.kind !== 'range';
}

function syncFilterInputs() {
  $('#f-search').value = filters.q;
  syncPeriodInputs();
  // La vue peut être imposée de l'extérieur — un bloc du tableau de bord.
  // Sans cela, la pastille active resterait sur « Factures » alors que le
  // tableau montre autre chose.
  $$('.view-chips [data-view]').forEach((c) => {
    const actif = c.dataset.view === filters.view;
    c.classList.toggle('active', actif);
    c.setAttribute('aria-selected', actif ? 'true' : 'false');
  });
  $('#f-supplier').value = filters.supplier;
  $('#f-status').value = filters.status;
  $('#f-smart').value = filters.smart;
  $('#f-winauditor').value = filters.winauditor;
  $('#f-stock').value = filters.stock;
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initInvoices(onOpenDocument = null) {
  // Vues du tableau : factures, à contrôler, documents
  $$('.view-chips [data-view]').forEach((chip) => {
    chip.addEventListener('click', () => {
      filters.view = chip.dataset.view;
      $$('.view-chips [data-view]').forEach((c) => {
        const actif = c === chip;
        c.classList.toggle('active', actif);
        c.setAttribute('aria-selected', actif ? 'true' : 'false');
      });
      // Les documents ne sont pas datés comme des factures, et les arrivées
      // se moquent du mois affiché : les enfermer dans la période les
      // rendrait invisibles.
      //
      // Il faut passer par setPeriod : écrire filters.period directement ne
      // tenait pas, syncPeriodInputs le relit de la période réelle et le
      // remettait aussitôt sur « mois ». La vue Documents en souffrait
      // depuis sa mise en service sans que cela se voie.
      if (filters.view === 'documents' || filters.view === 'arrivees') {
        setPeriod({ kind: 'all' });
      }
      syncFilterInputs();
      renderInvoices();
    });
  });

  // Barre d'outils
  $('#f-search').addEventListener('input', (e) => { filters.q = e.target.value; renderInvoices(); });
  // Période : un seul réglage pour le tableau, les totaux et les exports.
  $('#f-period').addEventListener('change', (e) => { setPeriod({ kind: e.target.value }); syncFilterInputs(); renderInvoices(); });
  $('#f-quarter').addEventListener('change', (e) => { setPeriod({ kind: 'quarter', quarter: e.target.value }); renderInvoices(); });
  $('#f-year').addEventListener('change', (e) => { setPeriod({ kind: 'year', year: e.target.value }); renderInvoices(); });
  $('#f-from').addEventListener('change', (e) => { setPeriod({ kind: 'range', from: e.target.value }); renderInvoices(); });
  $('#f-to').addEventListener('change', (e) => { setPeriod({ kind: 'range', to: e.target.value }); renderInvoices(); });
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

    const del = e.target.closest('[data-delete]');
    if (del) { e.stopPropagation(); return deleteInvoice(del.dataset.delete); }

    const requalify = e.target.closest('[data-requalify]');
    if (requalify) { e.stopPropagation(); return requalifier(requalify.dataset.requalify); }

    if (e.target.closest('[data-empty-new]')) return openInvoiceModal();

    // Reste du clic : ouvrir la pièce en pleine page, document à gauche et
    // champs à droite. Les cases à cocher et les champs de saisie gardent
    // leur comportement propre.
    if (e.target.closest('input, select, textarea, button, a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr && onOpenDocument) onOpenDocument(tr.dataset.id);
  });

  // Référence Smart saisie directement dans le tableau : c'est le numéro qui
  // fait le lien avec WinAuditor, il ne doit demander aucun détour.
  $('#inv-tbody').addEventListener('keydown', (e) => {
    const champ = e.target.closest('[data-smartref]');
    if (!champ) return;
    if (e.key === 'Enter') { e.preventDefault(); champ.blur(); }
    if (e.key === 'Escape') {
      const inv = findInvoice(champ.dataset.smartref);
      champ.value = inv?.smart_ref || '';
      champ.blur();
    }
  });
  $('#inv-tbody').addEventListener('focusout', (e) => {
    const champ = e.target.closest('[data-smartref]');
    if (champ) saveSmartRef(champ.dataset.smartref, champ.value, champ);
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
  $('#bulk-takeover').addEventListener('click', bulkTakeover);
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

// =====================================================================
// export.js — export CSV (Excel FR) et impression / PDF
// =====================================================================
import { getInvoices, currentSelection } from './invoices.js';
import {
  $, $$, csvNum, fmtDate, statusLabel, getMonth, monthLabel, inMonth,
  toast, errorMessage
} from './ui.js';

// En-têtes identiques au fichier Excel du magasin
const HEADERS = [
  'Date encodage', 'Fournisseur', 'N° facture', 'Date facture', 'Échéance',
  'Montant HTVA', 'TVA %', 'Montant TVA', 'Total TVAC',
  'Encodé Smart', 'Réf. Smart', 'Références', 'Envoyé WinAuditor', 'Entrée en stock', 'Sortie / livraison',
  'Statut paiement', 'Date paiement', 'Mode paiement', 'Type de dépense', 'Remarques'
];

const oui = (b) => (b ? 'Oui' : 'Non');

/** Échappe une valeur pour le CSV (séparateur point-virgule) */
function cell(v) {
  const s = String(v ?? '');
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Taux 0.21 -> "21" */
function ratePct(rate) {
  const p = Math.round((Number(rate) || 0) * 10000) / 100;
  return String(p).replace('.', ',');
}

function lineFor(i) {
  const htva = Number(i.amount_htva) || 0;
  const tvac = Number(i.amount_tvac) || 0;
  return [
    fmtDate(i.encoded_at),
    i.supplier_name || i.supplier?.name || '',
    i.invoice_number,
    fmtDate(i.invoice_date),
    fmtDate(i.due_date),
    csvNum(htva),
    ratePct(i.vat_rate),
    csvNum(tvac - htva),
    csvNum(tvac),
    oui(i.in_smart),
    i.smart_ref || '',
    (i.external_refs || []).join(' / '),
    oui(i.in_winauditor),
    fmtDate(i.stock_in),
    fmtDate(i.stock_out),
    statusLabel(i.payment_status),
    fmtDate(i.payment_date),
    i.payment_method || '',
    i.expense_type || '',
    i.notes || ''
  ].map(cell).join(';');
}

/** Construit le contenu CSV complet (UTF-8 avec BOM, fins de ligne CRLF) */
export function buildCSV(rows) {
  const lines = [HEADERS.map(cell).join(';'), ...rows.map(lineFor)];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';   // BOM UTF-8 pour Excel FR
}

/** Déclenche le téléchargement du fichier */
export function downloadInvoicesCSV(rows, filename) {
  if (!rows.length) { toast('Rien à exporter pour cette sélection.', 'error'); return; }
  const blob = new Blob([buildCSV(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${rows.length} ligne${rows.length > 1 ? 's' : ''} exportée${rows.length > 1 ? 's' : ''} → ${filename}`);
}

// ---------------------------------------------------------------------
// Câblage des boutons
// ---------------------------------------------------------------------
async function exportMonth() {
  const month = getMonth();
  try {
    const rows = (await getInvoices()).filter((i) => inMonth(i.invoice_date, month));
    downloadInvoicesCSV(rows, `VK_factures_${month}.csv`);
  } catch (err) { toast(errorMessage(err, 'Export impossible.'), 'error'); }
}

function exportSelection() {
  downloadInvoicesCSV(currentSelection(), `VK_factures_selection_${getMonth()}.csv`);
}

async function exportAll() {
  try {
    downloadInvoicesCSV(await getInvoices(), 'VK_factures_complet.csv');
  } catch (err) { toast(errorMessage(err, 'Export impossible.'), 'error'); }
}

export function initExport() {
  const menu = $('#export-menu');
  const toggle = $('#btn-export');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => e.stopPropagation());

  $('#export-month').addEventListener('click', () => { menu.hidden = true; exportMonth(); });
  $('#export-selection').addEventListener('click', () => { menu.hidden = true; exportSelection(); });
  $('#export-all').addEventListener('click', () => { menu.hidden = true; exportAll(); });

  // Impression / PDF
  $$('[data-print]').forEach((b) => b.addEventListener('click', () => {
    $('#print-month').textContent = monthLabel(getMonth());
    window.print();
  }));
}

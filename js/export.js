// =====================================================================
// export.js — export CSV (Excel FR) et impression / PDF
// =====================================================================
import { getInvoices, currentSelection, getFilters } from './invoices.js';
import { suppliersCache } from './suppliers.js';
import { supabase } from './supabase.js';
import { buildXlsx } from './xlsx.js';
import { buildZip, nomSur } from './zip.js';
import {
  $, $$, csvNum, fmtDate, statusLabel, getMonth, monthLabel, inMonth,
  toast, errorMessage, confirmDialog, inPeriod, periodLabel, periodSlug, getPeriod
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
// Classeur Excel
//
// Mêmes colonnes que le CSV, mais typées : les dates sont des dates, les
// montants des nombres. Le comptable trie et additionne sans rien
// reformater, et un numéro de facture commençant par un zéro le garde.
// ---------------------------------------------------------------------
const COLONNES = [
  { key: 'encode_le',   label: 'Date encodage',     type: 'date',   width: 13 },
  { key: 'fournisseur', label: 'Fournisseur',       type: 'text',   width: 30 },
  { key: 'numero',      label: 'N° facture',        type: 'text',   width: 18 },
  { key: 'date',        label: 'Date facture',      type: 'date',   width: 13 },
  { key: 'echeance',    label: 'Échéance',          type: 'date',   width: 13 },
  { key: 'htva',        label: 'Montant HTVA',      type: 'money',  width: 14 },
  { key: 'taux',        label: 'TVA %',             type: 'number', width: 8 },
  { key: 'tva',         label: 'Montant TVA',       type: 'money',  width: 14 },
  { key: 'tvac',        label: 'Total TVAC',        type: 'money',  width: 14 },
  { key: 'paye',        label: 'Montant payé',      type: 'money',  width: 14 },
  { key: 'escompte',    label: 'Escompte obtenu',   type: 'money',  width: 14 },
  { key: 'smart',       label: 'Encodé Smart',      type: 'text',   width: 12 },
  { key: 'smart_ref',   label: 'Réf. Smart',        type: 'text',   width: 16 },
  { key: 'refs',        label: 'Références',        type: 'text',   width: 22 },
  { key: 'winauditor',  label: 'Envoyé WinAuditor', type: 'text',   width: 15 },
  { key: 'stock_in',    label: 'Entrée en stock',   type: 'date',   width: 13 },
  { key: 'stock_out',   label: 'Sortie / livraison', type: 'date',  width: 15 },
  { key: 'statut',      label: 'Statut paiement',   type: 'text',   width: 15 },
  { key: 'date_paie',   label: 'Date paiement',     type: 'date',   width: 13 },
  { key: 'mode',        label: 'Mode paiement',     type: 'text',   width: 14 },
  { key: 'depense',     label: 'Type de dépense',   type: 'text',   width: 16 },
  { key: 'fichier',     label: 'Fichier joint',     type: 'text',   width: 30 },
  { key: 'remarques',   label: 'Remarques',         type: 'text',   width: 30 }
];

function ligneXlsx(i) {
  const htva = Number(i.amount_htva) || 0;
  const tvac = Number(i.amount_tvac) || 0;
  const paye = i.amount_paid === null || i.amount_paid === undefined ? null : Number(i.amount_paid);
  return {
    encode_le: i.encoded_at,
    fournisseur: i.supplier_name || i.supplier?.name || '',
    numero: i.invoice_number,
    date: i.invoice_date,
    echeance: i.due_date,
    htva,
    taux: Math.round((Number(i.vat_rate) || 0) * 10000) / 100,
    tva: Math.round((tvac - htva) * 100) / 100,
    tvac,
    paye,
    // L'escompte réellement obtenu : l'écart entre le facturé et le décaissé.
    // Rien n'est déduit tant que le paiement n'a pas eu lieu.
    escompte: paye !== null && paye < tvac ? Math.round((tvac - paye) * 100) / 100 : null,
    smart: oui(i.in_smart),
    smart_ref: i.smart_ref || '',
    refs: (i.external_refs || []).join(' / '),
    winauditor: oui(i.in_winauditor),
    stock_in: i.stock_in,
    stock_out: i.stock_out,
    statut: statusLabel(i.payment_status),
    date_paie: i.payment_date,
    mode: i.payment_method || '',
    depense: i.expense_type || '',
    fichier: nomFichierJoint(i),
    remarques: i.notes || ''
  };
}

/** Nom lisible du PDF d'origine, celui qu'on retrouvera dans le dossier ZIP */
function nomFichierJoint(i) {
  if (!i.file_path) return '';
  return String(i.file_path).replace(/^.*\/[0-9a-f-]{36}-/i, '');
}

function telecharger(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadInvoicesXLSX(rows, filename, sheetName) {
  if (!rows.length) { toast('Rien à exporter pour cette période.', 'error'); return; }
  const blob = buildXlsx(COLONNES, rows.map(ligneXlsx), { sheetName });
  telecharger(blob, filename);
  toast(`${rows.length} ligne${rows.length > 1 ? 's' : ''} → ${filename}`);
}

// ---------------------------------------------------------------------
// Câblage des boutons
// ---------------------------------------------------------------------

/**
 * Ce qui part à l'export : EXACTEMENT ce qui est affiché.
 *
 * Un fichier nommé « hors Belgique » qui contiendrait toute la période
 * serait pire qu'inutile — le comptable déclarerait de travers. On prend
 * donc les lignes du tableau telles qu'elles sont, filtre compris.
 *
 * Le repli sur la période ne sert qu'au cas où le tableau n'a pas encore
 * été rendu : mieux vaut exporter la période que rien du tout.
 */
async function facturesAffichees() {
  const affichees = currentSelection().filter((i) => i.review_status !== 'document');
  if (affichees.length) return affichees;
  const p = getPeriod();
  return (await getInvoices()).filter((i) =>
    i.review_status !== 'document' && inPeriod(i.invoice_date, p));
}

/**
 * Ce que le nom du fichier doit dire en plus de la période.
 *
 * Un classeur qui ne contient que les achats hors Belgique et s'appelle
 * « toutes périodes » ment au comptable. Le filtre en cours fait partie
 * de ce que contient le fichier : il doit se lire sur l'étiquette.
 */
function suffixeFiltre() {
  const f = getFilters();
  if (f.supplier === '__pays_etranger') return '_hors-Belgique';
  if (f.supplier === '__pays_be') return '_Belgique';
  if (f.supplier === '__pays_inconnu') return '_pays-a-preciser';
  if (f.supplier) {
    const nom = suppliersCache().find((s) => s.id === f.supplier)?.name;
    return nom ? '_' + nomSur(nom).replace(/\s+/g, '-').slice(0, 28) : '';
  }
  return '';
}

async function exportMonth() {
  try {
    downloadInvoicesCSV(await facturesAffichees(), `VK_factures_${periodSlug()}${suffixeFiltre()}.csv`);
  } catch (err) { toast(errorMessage(err, 'Export impossible.'), 'error'); }
}

async function exportXlsx() {
  try {
    const rows = await facturesAffichees();
    downloadInvoicesXLSX(rows, `VK_factures_${periodSlug()}${suffixeFiltre()}.xlsx`, periodLabel());
  } catch (err) { toast(errorMessage(err, 'Export impossible.'), 'error'); }
}

// ---------------------------------------------------------------------
// Dossier pour le comptable
//
// Une archive qui se suffit à elle-même : le récapitulatif Excel et les
// documents d'origine, nommés pour être rapprochés du tableau ligne à
// ligne. Ce qui manque est écrit dans le ZIP plutôt que passé sous
// silence — un document absent doit se voir.
// ---------------------------------------------------------------------
async function exportAccountant() {
  let rows;
  try {
    const selection = currentSelection().filter((i) => i.review_status !== 'document');
    const periode = await facturesAffichees();
    // Une sélection explicite prime sur la période affichée.
    rows = selection.length && selection.length !== periode.length ? selection : periode;
  } catch (err) {
    return toast(errorMessage(err, 'Préparation impossible.'), 'error');
  }
  if (!rows.length) return toast('Aucune facture sur cette période.', 'error');

  const avecPdf = rows.filter((i) => i.file_path);
  const sansPieceCount = rows.length - avecPdf.length;
  const ok = await confirmDialog(
    `Préparer le dossier comptable de ${periodLabel().toLowerCase()} ? `
    + `${rows.length} facture${rows.length > 1 ? 's' : ''} au récapitulatif, `
    + `${avecPdf.length} document${avecPdf.length > 1 ? 's' : ''} d'origine à joindre`
    + `${sansPieceCount > 0 ? `, ${sansPieceCount} sans pièce jointe` : ''}. `
    + 'Le téléchargement peut prendre un moment.',
    'Préparer l\'archive');
  if (!ok) return;

  const etiquette = periodSlug() + suffixeFiltre();
  const fichiers = [{
    name: `Recapitulatif_${etiquette}.xlsx`,
    data: new Uint8Array(await buildXlsx(COLONNES, rows.map(ligneXlsx), { sheetName: periodLabel() }).arrayBuffer())
  }];

  const manquants = [];
  const utilises = new Set();
  let faits = 0;

  for (const i of avecPdf) {
    try {
      const { data, error } = await supabase.storage.from('factures').download(i.file_path);
      if (error || !data) throw error || new Error('document introuvable');

      // Nom parlant : le comptable retrouve la ligne du tableau sans ouvrir
      // le PDF. On dédoublonne, deux factures pouvant porter le même nom.
      const ext = (nomFichierJoint(i).match(/\.[a-z0-9]+$/i) || ['.pdf'])[0];
      let nom = nomSur(`${i.supplier_name || 'Fournisseur'} - ${i.invoice_number}`) + ext;
      let n = 2;
      while (utilises.has(nom.toLowerCase())) {
        nom = nomSur(`${i.supplier_name || 'Fournisseur'} - ${i.invoice_number} (${n++})`) + ext;
      }
      utilises.add(nom.toLowerCase());

      fichiers.push({ name: `Factures/${nom}`, data: new Uint8Array(await data.arrayBuffer()) });
      faits++;
      if (faits % 10 === 0) toast(`Dossier comptable : ${faits}/${avecPdf.length} documents…`);
    } catch (err) {
      console.error(err);
      manquants.push(`${i.supplier_name || '?'} ${i.invoice_number} — ${errorMessage(err, 'document illisible')}`);
    }
  }

  const sansPiece = rows.filter((i) => !i.file_path)
    .map((i) => `${i.supplier_name || '?'} ${i.invoice_number} — aucune pièce jointe (saisie manuelle)`);

  if (manquants.length || sansPiece.length) {
    fichiers.push({
      name: 'DOCUMENTS_MANQUANTS.txt',
      data: '﻿' + [
        `Dossier ${periodLabel()} — ${rows.length} facture(s) au récapitulatif.`,
        `${faits} document(s) joint(s).`,
        '',
        'Les factures ci-dessous figurent dans le récapitulatif mais sans document :',
        '',
        ...sansPiece, ...manquants
      ].join('\r\n') + '\r\n'
    });
  }

  telecharger(buildZip(fichiers), `VK_comptable_${etiquette}.zip`);
  toast(manquants.length
    ? `Dossier prêt : ${faits} document(s), ${manquants.length} illisible(s) — voir DOCUMENTS_MANQUANTS.txt`
    : `Dossier prêt : ${rows.length} facture(s), ${faits} document(s).`);
}

function exportSelection() {
  downloadInvoicesCSV(currentSelection(), `VK_factures_selection_${periodSlug()}.csv`);
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

  $('#export-xlsx').addEventListener('click', () => { menu.hidden = true; exportXlsx(); });
  $('#export-accountant').addEventListener('click', () => { menu.hidden = true; exportAccountant(); });
  $('#export-month').addEventListener('click', () => { menu.hidden = true; exportMonth(); });
  $('#export-selection').addEventListener('click', () => { menu.hidden = true; exportSelection(); });
  $('#export-all').addEventListener('click', () => { menu.hidden = true; exportAll(); });

  // Impression / PDF
  $$('[data-print]').forEach((b) => b.addEventListener('click', () => {
    $('#print-month').textContent = periodLabel();
    window.print();
  }));
}

// =====================================================================
// maintenance.js — sauvegardes, contrôle de sécurité, mises à jour.
//
// Trois sujets qu'on ne regarde jamais spontanément, et qui ne se
// rappellent à vous qu'au mauvais moment. L'application les affiche donc
// d'elle-même, et dit ce qui ne va pas plutôt que d'aligner des voyants
// verts rassurants.
// =====================================================================
import { supabase } from './supabase.js';
import { buildZip } from './zip.js';
import { buildXlsx } from './xlsx.js';
import { isManager } from './auth.js';
import {
  $, $$, escapeHtml, toast, errorMessage, confirmDialog, longDate, fmtDate, fmtEUR, ICONS
} from './ui.js';

let sauvegardes = [];
let etatSauvegarde = null;
let controle = [];

const octets = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} o`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} Ko`;
  return `${(v / 1024 / 1024).toFixed(1)} Mo`;
};

const horodatage = (iso) => {
  if (!iso) return '—';
  const d = String(iso);
  return `${longDate(d.slice(0, 10))} à ${d.slice(11, 16)}`;
};

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
export async function loadMaintenance() {
  const [s, l, a] = await Promise.all([
    supabase.rpc('backup_status'),
    supabase.rpc('backup_list'),
    supabase.rpc('security_audit')
  ]);
  const lire = (r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
  etatSauvegarde = lire(s) || {};
  sauvegardes = lire(l) || [];
  controle = lire(a) || [];
  return { etatSauvegarde, sauvegardes, controle };
}

// ---------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------
const ETATS = {
  ok:        { icone: '✓', classe: 'sec-ok' },
  attention: { icone: '!', classe: 'sec-warn' },
  probleme:  { icone: '✗', classe: 'sec-bad' }
};

export function securityCardHtml() {
  const pires = controle.filter((c) => c.etat !== 'ok').length;
  return `
    <div class="card">
      <div class="card-head">
        <h2>Contrôle de sécurité</h2>
        <p class="muted small">${pires
          ? `${pires} point${pires > 1 ? 's' : ''} à regarder`
          : 'Tous les contrôles passent'}</p>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" id="sec-refresh">Relancer le contrôle</button>
      </div>
      <ul class="sec-list">
        ${controle.map((c) => `
          <li class="${ETATS[c.etat]?.classe || ''}">
            <span class="sec-mark">${ETATS[c.etat]?.icone || '·'}</span>
            <span class="sec-text">
              <strong>${escapeHtml(c.titre)}</strong>
              <span>${escapeHtml(c.detail)}</span>
            </span>
          </li>`).join('')}
      </ul>
    </div>`;
}

export function backupCardHtml() {
  const e = etatSauvegarde || {};
  const heures = Number(e.heures_depuis);
  const jours = e.dernier_telechargement === null ? null : Number(e.jours_depuis_telechargement);

  // Deux alertes distinctes, parce que ce sont deux risques distincts.
  const alerteAuto = !e.derniere || (Number.isFinite(heures) && heures > 48);
  const alerteEmport = jours === null || (Number.isFinite(jours) && jours > 14);

  return `
    <div class="card">
      <div class="card-head">
        <h2>Sauvegardes</h2>
        <p class="muted small">${e.planifiee ? 'Instantané automatique chaque nuit à 2 h 15' : 'Planification inactive'}</p>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" id="bk-now">Sauvegarder maintenant</button>
        <button type="button" class="btn btn-sm btn-primary" id="bk-download">Télécharger la sauvegarde</button>
      </div>

      <div class="pad">
        <div class="bk-state ${alerteAuto ? 'is-bad' : 'is-ok'}">
          <strong>Dans la base — protège d'une suppression par erreur</strong>
          <span>${e.derniere
            ? `Dernier instantané ${horodatage(e.derniere)} · ${octets(e.derniere_taille)} · ${e.total} conservé${Number(e.total) > 1 ? 's' : ''}`
            : 'Aucun instantané. Lance-en un maintenant.'}</span>
        </div>
        <div class="bk-state ${alerteEmport ? 'is-bad' : 'is-ok'}">
          <strong>Hors de la base — protège de la perte du projet</strong>
          <span>${e.dernier_telechargement
            ? `Dernier téléchargement ${horodatage(e.dernier_telechargement)}${jours > 14 ? ` — il y a ${jours} jours, c'est trop` : ''}`
            : 'Jamais téléchargée. Tant que tout reste au même endroit, une sauvegarde ne protège que de la moitié des accidents.'}</span>
        </div>
      </div>

      <div class="table-wrap">
        <table class="table" id="bk-table">
          <thead><tr>
            <th>Date</th><th>Origine</th><th>Contenu</th><th>Taille</th><th>Emportée</th>
            <th class="no-print">Actions</th>
          </tr></thead>
          <tbody>
            ${sauvegardes.length ? sauvegardes.map((b) => `
              <tr>
                <td>${horodatage(b.created_at)}</td>
                <td>${b.kind === 'auto' ? 'Automatique' : 'Manuelle'}</td>
                <td class="muted small">${Object.entries(b.row_counts || {})
                    .filter(([, v]) => Number(v) > 0)
                    .map(([k, v]) => `${v} ${k}`).join(' · ')}</td>
                <td class="num">${octets(b.size_bytes)}</td>
                <td>${b.downloaded_at ? horodatage(b.downloaded_at) : '<span class="muted">—</span>'}</td>
                <td class="no-print">
                  <button type="button" class="btn btn-sm" data-bk-dl="${b.id}">Télécharger</button>
                  <button type="button" class="btn btn-sm" data-bk-restore="${b.id}">Factures supprimées…</button>
                </td>
              </tr>`).join('')
              : '<tr class="empty-row"><td colspan="6"><div class="empty"><p>Aucune sauvegarde pour l\'instant.</p></div></td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------
async function sauvegarderMaintenant(rerender) {
  const btn = $('#bk-now');
  if (btn) { btn.disabled = true; btn.textContent = 'Sauvegarde…'; }
  try {
    const { data, error } = await supabase.rpc('backup_create', { p_kind: 'manuel', p_note: 'lancée depuis l\'application' });
    if (error) throw error;
    const r = typeof data === 'string' ? JSON.parse(data) : data;
    toast(`Sauvegarde faite — ${octets(r.taille)}.`);
    await rerender();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Sauvegarde impossible.'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Sauvegarder maintenant'; }
  }
}

/** Colonnes du récapitulatif lisible joint à l'archive */
const COLONNES_SAUVEGARDE = [
  { key: 'invoice_date',   label: 'Date facture',  type: 'date',  width: 13 },
  { key: 'fournisseur',    label: 'Fournisseur',   type: 'text',  width: 30 },
  { key: 'invoice_number', label: 'N° facture',    type: 'text',  width: 18 },
  { key: 'smart_ref',      label: 'Réf. Smart',    type: 'text',  width: 16 },
  { key: 'amount_htva',    label: 'Montant HTVA',  type: 'money', width: 14 },
  { key: 'amount_tvac',    label: 'Total TVAC',    type: 'money', width: 14 },
  { key: 'payment_status', label: 'Paiement',      type: 'text',  width: 14 },
  { key: 'payment_date',   label: 'Date paiement', type: 'date',  width: 13 },
  { key: 'file_path',      label: 'Document',      type: 'text',  width: 34 }
];

async function telecharger(id, rerender) {
  toast('Préparation de la sauvegarde…');
  try {
    const { data, error } = await supabase.rpc('backup_fetch', { p_id: id, p_mark: true });
    if (error) throw error;
    const contenu = typeof data === 'string' ? JSON.parse(data) : data;

    const fournisseurs = new Map((contenu.suppliers || []).map((s) => [s.id, s.name]));
    const lignes = (contenu.invoices || []).map((i) => ({
      ...i,
      fournisseur: fournisseurs.get(i.supplier_id) || '?',
      file_path: String(i.file_path || '').replace(/^.*\/[0-9a-f-]{36}-/i, '')
    }));

    const quand = String(contenu.fait_le || '').slice(0, 10) || 'sauvegarde';
    const zip = buildZip([
      // Le JSON est la sauvegarde : c'est lui qui permet de tout remettre.
      { name: `sauvegarde-${quand}.json`, data: JSON.stringify(contenu, null, 2) },
      // Le classeur est là pour être lu par un humain, pas pour restaurer.
      { name: `factures-${quand}.xlsx`,
        data: new Uint8Array(await buildXlsx(COLONNES_SAUVEGARDE, lignes, { sheetName: 'Factures' }).arrayBuffer()) },
      { name: 'LISEZ-MOI.txt', data: '﻿' + [
        'SAUVEGARDE VK GESTION',
        `Constituée le ${quand}.`,
        '',
        'Contenu :',
        ...Object.entries(contenu).filter(([, v]) => Array.isArray(v))
          .map(([k, v]) => `  ${String(v.length).padStart(6)} ${k}`),
        '',
        'sauvegarde-*.json  — la sauvegarde elle-même. C\'est ce fichier qui permet',
        '                     de tout remettre en place. Ne le modifie pas.',
        'factures-*.xlsx    — la même chose, lisible dans Excel. Pour consulter,',
        '                     pas pour restaurer.',
        '',
        'CE QUI N\'EST PAS DEDANS : les PDF des factures. Ils pèsent trop lourd et',
        'vivent dans l\'espace de stockage. Pour les emporter aussi, utilise',
        '« Dossier pour le comptable » sur l\'écran Factures, période par période.',
        '',
        'OÙ LA RANGER : ailleurs que sur l\'ordinateur du magasin. Un disque externe',
        'ou un espace en ligne différent. Une sauvegarde posée à côté de l\'original',
        'disparaît avec lui.'
      ].join('\r\n') + '\r\n' }
    ]);

    const url = URL.createObjectURL(zip);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VK_sauvegarde_${quand}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Sauvegarde téléchargée. Range-la ailleurs que sur cet ordinateur.');
    await rerender();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Téléchargement impossible.'), 'error');
  }
}

/**
 * Factures présentes dans une sauvegarde et absentes aujourd'hui : ce sont
 * exactement celles qu'une suppression a emportées.
 */
async function proposerRestauration(backupId, rerender) {
  try {
    const [{ data, error }, actuelles] = await Promise.all([
      supabase.rpc('backup_fetch', { p_id: backupId, p_mark: false }),
      supabase.from('invoices').select('id')
    ]);
    if (error) throw error;
    const contenu = typeof data === 'string' ? JSON.parse(data) : data;
    const existantes = new Set((actuelles.data || []).map((r) => r.id));
    const fournisseurs = new Map((contenu.suppliers || []).map((s) => [s.id, s.name]));
    const perdues = (contenu.invoices || []).filter((i) => !existantes.has(i.id));

    if (!perdues.length) {
      toast('Aucune facture de cette sauvegarde ne manque : rien à restaurer.');
      return;
    }

    const liste = perdues.slice(0, 12).map((i) =>
      `• ${fournisseurs.get(i.supplier_id) || '?'} · ${i.invoice_number} · ${fmtDate(i.invoice_date)} · ${fmtEUR(i.amount_tvac)}`).join('\n');
    const ok = await confirmDialog(
      `${perdues.length} facture${perdues.length > 1 ? 's' : ''} de cette sauvegarde ${perdues.length > 1 ? 'ne sont plus' : 'n\'est plus'} dans l'application :\n`
      + liste + (perdues.length > 12 ? `\n… et ${perdues.length - 12} autre(s)` : '')
      + '\n\nLes remettre en place ? Rien de ce qui existe aujourd\'hui ne sera touché.',
      'Restaurer');
    if (!ok) return;

    let faites = 0;
    const soucis = [];
    for (const i of perdues) {
      const { error: e } = await supabase.rpc('backup_restore_invoice', { p_backup: backupId, p_invoice: i.id });
      if (e) soucis.push(`${i.invoice_number} : ${errorMessage(e, 'refusée')}`);
      else faites++;
    }
    toast(soucis.length
      ? `${faites} facture(s) restaurée(s), ${soucis.length} refusée(s) : ${soucis[0]}`
      : `${faites} facture(s) restaurée(s).`, soucis.length ? 'error' : 'success');
    await rerender();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Restauration impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Câblage — appelé après chaque rendu de l'écran Administration
// ---------------------------------------------------------------------
export function wireMaintenance(rerender) {
  $('#bk-now')?.addEventListener('click', () => sauvegarderMaintenant(rerender));
  $('#bk-download')?.addEventListener('click', () => {
    if (!sauvegardes.length) return toast('Aucune sauvegarde à télécharger. Lances-en une d\'abord.', 'error');
    telecharger(sauvegardes[0].id, rerender);
  });
  $('#sec-refresh')?.addEventListener('click', rerender);
  $$('[data-bk-dl]').forEach((b) =>
    b.addEventListener('click', () => telecharger(b.dataset.bkDl, rerender)));
  $$('[data-bk-restore]').forEach((b) =>
    b.addEventListener('click', () => proposerRestauration(b.dataset.bkRestore, rerender)));
}

// ---------------------------------------------------------------------
// Mises à jour de l'application
//
// Le site est un ensemble de fichiers statiques : un navigateur qui a
// gardé l'ancien index.html en cache continue de l'utiliser sans rien
// dire. On compare donc la version chargée à celle publiée, et on
// propose de recharger. On ne recharge jamais d'autorité : Marie peut
// être au milieu d'une saisie.
// ---------------------------------------------------------------------
let versionChargee = null;

async function lireVersion() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const v = await r.json();
    return v?.version || null;
  } catch { return null; }
}

export async function initUpdateCheck() {
  versionChargee = await lireVersion();

  const verifier = async () => {
    const publiee = await lireVersion();
    if (!publiee || !versionChargee || publiee === versionChargee) return;
    const banniere = $('#update-banner');
    if (!banniere || !banniere.hidden) return;
    banniere.hidden = false;
    $('#update-version').textContent = publiee;
  };

  // À la reprise de l'onglet, et sinon toutes les demi-heures.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verifier(); });
  setInterval(verifier, 30 * 60 * 1000);
  setTimeout(verifier, 60 * 1000);

  $('#update-reload')?.addEventListener('click', () => location.reload(true));
  $('#update-dismiss')?.addEventListener('click', () => { $('#update-banner').hidden = true; });
}

export function versionAffichee() { return versionChargee; }

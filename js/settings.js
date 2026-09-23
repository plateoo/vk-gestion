// =====================================================================
// settings.js — Réglages : quarantaine, liste blanche, purge bornée
//
// Réservé au gérant. La base tranche : allow_sender_and_replay et
// purge_quarantine refusent l'appel si is_manager() est faux, et la
// fonction replay-inbound revérifie le rôle de son côté.
// =====================================================================
import { supabase } from './supabase.js';
import { invalidateInvoices } from './invoices.js';
import {
  $, $$, escapeHtml, toast, errorMessage, confirmDialog, fmtDate,
  longDate, notifyDataChange, ICONS, ouvrirLien
} from './ui.js';
import { isManager } from './auth.js';

let senders = [];   // quarantaine groupée par expéditeur
let allowed = [];   // liste blanche
let ouvert = null;  // expéditeur dont on regarde les messages

// ---------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------
async function load() {
  const [q, a] = await Promise.all([
    supabase.rpc('quarantine_by_sender'),
    supabase.from('allowed_senders').select('*').order('email')
  ]);
  if (q.error) throw q.error;
  if (a.error) throw a.error;
  const raw = typeof q.data === 'string' ? JSON.parse(q.data) : q.data;
  senders = Array.isArray(raw) ? raw : [];
  allowed = a.data || [];
}

// ---------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------
export async function renderSettings() {
  const box = $('#tab-settings');
  if (!isManager()) {
    box.innerHTML = `<div class="page-head"><h1>Réglages</h1></div>
      <div class="card pad"><p class="muted">Cet écran est réservé au gérant.</p></div>`;
    return;
  }

  const list = $('#quarantine-list');
  list.innerHTML = '<div class="muted small" style="padding:12px">Chargement…</div>';
  try {
    await load();
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="empty"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  const totalMsg = senders.reduce((s, x) => s + Number(x.messages), 0);
  $('#quarantine-summary').textContent = totalMsg
    ? `${totalMsg} message${totalMsg > 1 ? 's' : ''} en attente d'autorisation, ${senders.length} expéditeur${senders.length > 1 ? 's' : ''}`
    : 'Aucun message en quarantaine.';

  list.innerHTML = senders.length ? senders.map((s) => `
    <div class="q-row ${ouvert === s.sender_email ? 'deplie' : ''}" data-sender="${escapeHtml(s.sender_email)}">
      <div class="q-main">
        <span class="q-email">${escapeHtml(s.sender_email)}</span>
        <span class="q-meta">${s.messages} message${Number(s.messages) > 1 ? 's' : ''}
          <span class="sep">·</span> ${s.fichiers} fichier${Number(s.fichiers) > 1 ? 's' : ''}
          <span class="sep">·</span> dernier le ${escapeHtml(longDate(String(s.derniere_reception).slice(0, 10)) || '—')}</span>
        ${s.dernier_sujet ? `<span class="q-subject">« ${escapeHtml(s.dernier_sujet)} »</span>` : ''}
      </div>
      <div class="q-actions">
        <!-- Voir avant de décider. Sans cela, on demandait de trancher
             « est-ce un fournisseur ? » en cachant ce qui permet de
             répondre : le sujet des messages et les pièces jointes. -->
        <button type="button" class="btn btn-sm" data-voir="${escapeHtml(s.sender_email)}"
                aria-expanded="${ouvert === s.sender_email}">
          ${ouvert === s.sender_email ? 'Masquer' : 'Voir les messages'}
        </button>
        <label class="check" title="Cocher si cette adresse retransmet les factures d'AUTRES fournisseurs : ancien franchisé, comptable, boîte interne. Son adresse ne servira alors jamais à identifier un fournisseur.">
          <input type="checkbox" data-forwarder="${escapeHtml(s.sender_email)}"> transitaire
        </label>
        <button type="button" class="btn btn-danger btn-sm" data-reject="${escapeHtml(s.sender_email)}">
          Refuser
        </button>
        <button type="button" class="btn btn-primary btn-sm" data-allow="${escapeHtml(s.sender_email)}">
          Autoriser et rejouer
        </button>
      </div>
      ${ouvert === s.sender_email ? `<div class="q-detail" data-detail="${escapeHtml(s.sender_email)}">
        <p class="muted small">Chargement des messages…</p></div>` : ''}
    </div>`).join('')
    : `<div class="empty">${ICONS.empty}<p>Rien en quarantaine</p></div>`;

  if (ouvert) chargerDetail(ouvert);

  $('#allowed-list').innerHTML = allowed.length ? allowed.map((a) => `
    <div class="q-row">
      <div class="q-main">
        <span class="q-email">${escapeHtml(a.email)}</span>
        <span class="q-meta">${a.label ? escapeHtml(a.label) : ''}${a.is_forwarder
          ? `${a.label ? ' <span class="sep">·</span> ' : ''}<span class="tag">transitaire</span>` : ''}</span>
      </div>
      <button type="button" class="icon-btn danger" data-revoke="${a.id}" title="Retirer de la liste blanche">${ICONS.trash}</button>
    </div>`).join('')
    : '<p class="muted small" style="padding:10px 12px">Liste blanche vide : tout message entrant part en quarantaine.</p>';
}

// ---------------------------------------------------------------------
// Voir ce qu'un expéditeur a envoyé
//
// Sujet, date, pièces jointes. Chaque pièce s'ouvre par un lien signé
// d'une heure : les fichiers restent dans un espace privé, rien ne
// devient lisible sans connexion.
// ---------------------------------------------------------------------
async function chargerDetail(email) {
  const boite = $(`[data-detail="${CSS.escape(email)}"]`);
  if (!boite) return;
  try {
    const { data, error } = await supabase.rpc('quarantine_detail', { p_email: email });
    if (error) throw error;
    const messages = (typeof data === 'string' ? JSON.parse(data) : data) || [];
    if (!messages.length) {
      boite.innerHTML = '<p class="muted small">Aucun message à afficher.</p>';
      return;
    }
    boite.innerHTML = messages.map((m) => `
      <div class="q-msg">
        <div class="q-msg-head">
          <strong>${escapeHtml(m.subject || '(sans sujet)')}</strong>
          <span class="muted small">${escapeHtml(longDate(String(m.received_at || m.created_at).slice(0, 10)) || '—')}</span>
        </div>
        ${(m.files || []).length ? `
          <div class="q-fichiers">
            ${(m.files || []).map((f) => `
              <button type="button" class="q-fichier" data-piece="${escapeHtml(f.path || '')}"
                      title="Ouvrir ${escapeHtml(f.name || '')}">
                ${icone(f)} ${escapeHtml(f.name || 'pièce jointe')}
                <small>${poids(f.size)}</small>
              </button>`).join('')}
          </div>`
          : '<p class="muted small">Aucune pièce jointe.</p>'}
      </div>`).join('');
  } catch (err) {
    console.error(err);
    boite.innerHTML = `<p class="muted small">${escapeHtml(errorMessage(err, 'Messages illisibles.'))}</p>`;
  }
}

const icone = (f) => {
  const n = String(f?.name || '').toLowerCase();
  if (n.endsWith('.pdf')) return '📄';
  if (/\.(png|jpe?g|gif|webp|heic)$/.test(n)) return '🖼';
  if (/\.(xlsx?|csv)$/.test(n)) return '▦';
  if (/\.(docx?)$/.test(n)) return '✎';
  return '📎';
};

function poids(n) {
  const o = Number(n) || 0;
  if (!o) return '';
  if (o < 1024) return `${o} o`;
  if (o < 1024 * 1024) return `${Math.round(o / 1024)} ko`;
  return `${(o / (1024 * 1024)).toFixed(1)} Mo`.replace('.', ',');
}

/** Ouvre une pièce jointe encore en quarantaine, par lien signé. */
async function ouvrirPiece(chemin) {
  if (!chemin) return toast('Cette pièce n\'a pas de fichier associé.', 'error');
  try {
    const { data, error } = await supabase.storage.from('factures').createSignedUrl(chemin, 3600);
    if (error) throw error;
    ouvrirLien(data.signedUrl);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Document introuvable.'), 'error');
  }
}

/**
 * Refuser un expéditeur.
 *
 * Ses messages quittent la quarantaine sans devenir des factures, et
 * leurs fichiers sont effacés du stockage. L'adresse n'est PAS mise sur
 * une liste noire : un expéditeur refusé aujourd'hui peut écrire demain
 * une facture légitime, et une liste noire silencieuse serait la
 * meilleure façon de perdre une facture sans jamais savoir pourquoi.
 */
async function refuser(email, btn) {
  const entry = senders.find((s) => s.sender_email === email);
  const n = entry ? Number(entry.messages) : 0;
  const ok = await confirmDialog(
    `Refuser ${email} ?\n\n`
    + `${n} message${n > 1 ? 's' : ''} ${n > 1 ? 'seront supprimés' : 'sera supprimé'} de la quarantaine, `
    + 'avec leurs pièces jointes. Aucune facture n\'en sortira.\n\n'
    + 'L\'adresse n\'est pas bloquée : si elle écrit à nouveau, le message '
    + 'repassera en quarantaine et tu pourras revoir ta décision.',
    'Refuser');
  if (!ok) return;

  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('quarantine_reject', { p_email: email });
    if (error) throw error;
    const r = typeof data === 'string' ? JSON.parse(data) : data;
    const chemins = r?.chemins || [];
    if (chemins.length) {
      const { error: errStock } = await supabase.storage.from('factures').remove(chemins);
      // Un objet resté en trop ne justifie pas d'alarmer : la ligne est
      // partie, c'est elle qui compte. On le note pour la console.
      if (errStock) console.warn('pièces non effacées', errStock);
    }
    toast(`${r?.messages ?? n} message(s) refusé(s).`);
    ouvert = null;
    await renderSettings();
    notifyDataChange();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    toast(errorMessage(err, 'Refus impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Autoriser un expéditeur, puis rejouer ses messages
// ---------------------------------------------------------------------
async function allowAndReplay(email, btn) {
  const entry = senders.find((s) => s.sender_email === email);
  const n = entry ? Number(entry.messages) : 0;
  const estTransitaire = !!$(`[data-forwarder="${CSS.escape(email)}"]`)?.checked;
  const fichiers = entry ? Number(entry.fichiers) : 0;
  const ok = await confirmDialog(
    `Autoriser ${email} et rejouer ${n} message${n > 1 ? 's' : ''} ? `
    + `Chaque pièce jointe donne une facture, soit ${fichiers} extraction${fichiers > 1 ? 's' : ''} attendue${fichiers > 1 ? 's' : ''}.`
    + (estTransitaire
        ? ' Marqué transitaire : son adresse ne servira pas à identifier les fournisseurs.'
        : ''),
    'Autoriser et rejouer');
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = 'Autorisation…';
  try {
    // 1. La base ajoute l'expéditeur et sort ses messages de quarantaine
    const transitaire = !!$(`[data-forwarder="${CSS.escape(email)}"]`)?.checked;
    const { data, error } = await supabase.rpc('allow_sender_and_replay',
      { p_email: email, p_label: null, p_is_forwarder: transitaire });
    if (error) throw error;
    const payload = typeof data === 'string' ? JSON.parse(data) : data;
    const ids = payload?.queue_ids || [];
    if (!ids.length) { toast('Aucun message à rejouer pour cet expéditeur.'); await renderSettings(); return; }

    // 2. La fonction rejoue, par paquets de 50 (sa limite)
    btn.textContent = `Rejeu de ${ids.length}…`;
    for (let i = 0; i < ids.length; i += 50) {
      const { error: fnErr } = await supabase.functions.invoke('replay-inbound', {
        body: { ids: ids.slice(i, i + 50) }
      });
      if (fnErr) throw fnErr;
    }

    toast(`${email} autorisé — ${ids.length} message${ids.length > 1 ? 's' : ''} en cours de traitement.`, 'ok', 6000);
    invalidateInvoices();
    notifyDataChange();
    await renderSettings();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Autorisation impossible.'), 'error');
    btn.disabled = false;
    btn.textContent = 'Autoriser et rejouer';
  }
}

async function revokeSender(id) {
  const entry = allowed.find((a) => a.id === id);
  const ok = await confirmDialog(
    `Retirer ${entry?.email} de la liste blanche ? Ses prochains messages repartiront en quarantaine.`,
    'Retirer');
  if (!ok) return;
  try {
    const { error } = await supabase.from('allowed_senders').delete().eq('id', id);
    if (error) throw error;
    toast('Expéditeur retiré.');
    await renderSettings();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Suppression impossible.'), 'error');
  }
}

async function addSender() {
  const email = $('#new-sender').value.trim().toLowerCase();
  if (!email || !email.includes('@')) { toast('Adresse e-mail invalide.', 'error'); return; }
  try {
    const { error } = await supabase.from('allowed_senders')
      .insert({ email, label: $('#new-sender-label').value.trim() || null });
    if (error) throw error;
    $('#new-sender').value = '';
    $('#new-sender-label').value = '';
    toast(`${email} ajouté à la liste blanche.`);
    await renderSettings();
  } catch (err) {
    console.error(err);
    if (/duplicate key|23505/i.test(err.message || '')) toast('Cet expéditeur est déjà autorisé.', 'error');
    else toast(errorMessage(err, 'Ajout impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Purge bornée
// ---------------------------------------------------------------------
async function previewPurge() {
  const days = Number($('#purge-days').value) || 90;
  try {
    const { data, error } = await supabase.rpc('purge_quarantine_preview', { p_days: days });
    if (error) throw error;
    const p = typeof data === 'string' ? JSON.parse(data) : data;
    const el = $('#purge-preview');
    el.hidden = false;
    el.textContent = Number(p.messages)
      ? `${p.messages} message${Number(p.messages) > 1 ? 's' : ''} et ${p.fichiers} fichier${Number(p.fichiers) > 1 ? 's' : ''} seraient supprimés définitivement.`
      : `Aucun message en quarantaine n'a plus de ${days} jours.`;
    el.className = Number(p.messages) ? 'purge-preview danger' : 'purge-preview';
    $('#purge-run').disabled = !Number(p.messages);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Aperçu impossible.'), 'error');
  }
}

async function runPurge() {
  const days = Number($('#purge-days').value) || 90;
  const ok = await confirmDialog(
    `Supprimer définitivement les messages en quarantaine de plus de ${days} jours, ainsi que leurs fichiers ? Cette action est irréversible.`,
    'Supprimer définitivement');
  if (!ok) return;
  try {
    const { data, error } = await supabase.rpc('purge_quarantine', { p_days: days });
    if (error) throw error;
    const r = typeof data === 'string' ? JSON.parse(data) : data;
    // Les objets du coffre sont retirés séparément : la base ne les gère pas.
    const paths = r.paths || [];
    if (paths.length) {
      const { error: sErr } = await supabase.storage.from('factures').remove(paths);
      if (sErr) console.warn('fichiers non supprimés du coffre', sErr);
    }
    toast(`${r.deleted_rows} message${r.deleted_rows > 1 ? 's' : ''} et ${paths.length} fichier${paths.length > 1 ? 's' : ''} supprimés.`);
    $('#purge-preview').hidden = true;
    await renderSettings();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Purge impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Retrouver la trace d'un courrier
//
// Jordan : « il me réclame des factures mais je ne trouve pas de traces
// dans le logiciel ». La question n'est pas « quelle facture ai-je ? »
// mais « qu'est-ce qui est ARRIVÉ ? ». Un message peut être en
// quarantaine, avoir échoué à l'extraction, ou n'avoir contenu aucune
// facture lisible : dans les trois cas il n'existe aucune facture, et
// pourtant le fournisseur a bien écrit. Sans cette vue, l'absence de
// facture ne se distingue pas de l'absence d'envoi.
// ---------------------------------------------------------------------
const ETATS_COURRIER = {
  done: { label: 'Traité', classe: 'st-green' },
  quarantine: { label: 'En quarantaine', classe: 'st-orange' },
  pending: { label: 'En attente', classe: 'st-orange' },
  processing: { label: 'En cours', classe: 'st-orange' },
  error: { label: 'Échec de lecture', classe: 'st-red' },
  sans_facture: { label: 'Sans facture lisible', classe: 'st-grey' },
  ignored: { label: 'Ignoré', classe: 'st-grey' }
};

async function chercherTrace() {
  const q = $('#trace-q').value.trim();
  const boite = $('#trace-resultats');
  if (q.length < 3) {
    boite.innerHTML = '<p class="muted small">Tape au moins trois lettres : un nom de fournisseur, un domaine, un numéro de facture.</p>';
    return;
  }
  boite.innerHTML = '<p class="muted small">Recherche…</p>';
  try {
    const { data, error } = await supabase.rpc('courrier_trace', { p_q: q, p_limit: 100 });
    if (error) throw error;
    const lignes = (typeof data === 'string' ? JSON.parse(data) : data) || [];
    if (!lignes.length) {
      boite.innerHTML = `<div class="trace-vide">
        <p><strong>Aucun message reçu</strong> ne correspond à « ${escapeHtml(q)} ».</p>
        <p class="muted small">Si le fournisseur affirme avoir envoyé, c'est que le message
          n'est jamais arrivé dans la boîte, ou qu'il n'a pas été déplacé dans le dossier
          Factures d'Outlook. Cherche dans Outlook avant de le rappeler.</p></div>`;
      return;
    }
    const sansFacture = lignes.filter((l) => !Number(l.factures)).length;
    boite.innerHTML = `
      <p class="trace-resume">${lignes.length} message${lignes.length > 1 ? 's' : ''} reçu${lignes.length > 1 ? 's' : ''}${
        sansFacture ? ` — dont <strong>${sansFacture} sans facture dans l'application</strong>` : ''}.</p>
      <table class="table trace-table">
        <thead><tr><th>Date</th><th>Expéditeur</th><th>Sujet</th><th>État</th><th>Facture</th></tr></thead>
        <tbody>${lignes.map((l) => {
          const e = ETATS_COURRIER[l.status] || { label: l.status, classe: 'st-grey' };
          return `<tr>
            <td data-label="Date">${escapeHtml(fmtDate(String(l.quand || '').slice(0, 10)) || '—')}</td>
            <td data-label="Expéditeur">${escapeHtml(l.sender_email)}</td>
            <td data-label="Sujet">${escapeHtml(l.subject || '(sans sujet)')}
              ${l.fichiers ? `<span class="trace-pj">${escapeHtml(l.fichiers)}</span>` : ''}</td>
            <td data-label="État"><span class="badge ${e.classe}">${escapeHtml(e.label)}</span>
              ${l.error ? `<span class="trace-err" title="${escapeHtml(l.error)}">détail</span>` : ''}</td>
            <td data-label="Facture" class="num">${Number(l.factures)
              ? `<span class="badge st-green">${l.factures}</span>`
              : '<span class="muted">aucune</span>'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  } catch (err) {
    console.error(err);
    boite.innerHTML = `<p class="muted small">${escapeHtml(errorMessage(err, 'Recherche impossible.'))}</p>`;
  }
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initSettings() {
  $('#quarantine-list').addEventListener('click', (e) => {
    const piece = e.target.closest('[data-piece]');
    if (piece) return ouvrirPiece(piece.dataset.piece);

    const voir = e.target.closest('[data-voir]');
    if (voir) {
      // Un seul expéditeur déplié à la fois : la quarantaine sert à
      // trancher cas par cas, pas à tout étaler.
      ouvert = ouvert === voir.dataset.voir ? null : voir.dataset.voir;
      return renderSettings();
    }

    const refus = e.target.closest('[data-reject]');
    if (refus) return refuser(refus.dataset.reject, refus);

    const b = e.target.closest('[data-allow]');
    if (b) allowAndReplay(b.dataset.allow, b);
  });

  // Retrouver la trace d'un courrier : la réponse à « le fournisseur me
  // réclame une facture dont je ne trouve pas trace ».
  $('#trace-btn').addEventListener('click', chercherTrace);
  $('#trace-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); chercherTrace(); }
  });
  $('#allowed-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-revoke]');
    if (b) revokeSender(b.dataset.revoke);
  });
  $('#add-sender').addEventListener('click', addSender);
  $('#new-sender').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSender(); } });
  $('#purge-preview-btn').addEventListener('click', previewPurge);
  $('#purge-run').addEventListener('click', runPurge);
}

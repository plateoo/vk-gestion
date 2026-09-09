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
  longDate, notifyDataChange, ICONS
} from './ui.js';
import { isManager } from './auth.js';

let senders = [];   // quarantaine groupée par expéditeur
let allowed = [];   // liste blanche

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
    <div class="q-row" data-sender="${escapeHtml(s.sender_email)}">
      <div class="q-main">
        <span class="q-email">${escapeHtml(s.sender_email)}</span>
        <span class="q-meta">${s.messages} message${Number(s.messages) > 1 ? 's' : ''}
          <span class="sep">·</span> ${s.fichiers} fichier${Number(s.fichiers) > 1 ? 's' : ''}
          <span class="sep">·</span> dernier le ${escapeHtml(longDate(String(s.derniere_reception).slice(0, 10)) || '—')}</span>
        ${s.dernier_sujet ? `<span class="q-subject">« ${escapeHtml(s.dernier_sujet)} »</span>` : ''}
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-allow="${escapeHtml(s.sender_email)}">
        Autoriser et rejouer
      </button>
    </div>`).join('')
    : `<div class="empty">${ICONS.empty}<p>Rien en quarantaine</p></div>`;

  $('#allowed-list').innerHTML = allowed.length ? allowed.map((a) => `
    <div class="q-row">
      <div class="q-main">
        <span class="q-email">${escapeHtml(a.email)}</span>
        ${a.label ? `<span class="q-meta">${escapeHtml(a.label)}</span>` : ''}
      </div>
      <button type="button" class="icon-btn danger" data-revoke="${a.id}" title="Retirer de la liste blanche">${ICONS.trash}</button>
    </div>`).join('')
    : '<p class="muted small" style="padding:10px 12px">Liste blanche vide : tout message entrant part en quarantaine.</p>';
}

// ---------------------------------------------------------------------
// Autoriser un expéditeur, puis rejouer ses messages
// ---------------------------------------------------------------------
async function allowAndReplay(email, btn) {
  const entry = senders.find((s) => s.sender_email === email);
  const n = entry ? Number(entry.messages) : 0;
  const ok = await confirmDialog(
    `Autoriser ${email} et rejouer ${n} message${n > 1 ? 's' : ''} ? Les factures seront créées et arriveront dans « À contrôler ».`,
    'Autoriser et rejouer');
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = 'Autorisation…';
  try {
    // 1. La base ajoute l'expéditeur et sort ses messages de quarantaine
    const { data, error } = await supabase.rpc('allow_sender_and_replay', { p_email: email, p_label: null });
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
// Initialisation
// ---------------------------------------------------------------------
export function initSettings() {
  $('#quarantine-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-allow]');
    if (b) allowAndReplay(b.dataset.allow, b);
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

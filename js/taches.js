// =====================================================================
// taches.js — la liste des choses à faire, partagée.
//
// Conçue pour le téléphone d'abord. Jordan pense à quelque chose en
// voiture : le champ d'ajout est en haut de l'écran, il tape, il envoie.
// Rien d'autre n'est obligatoire — ni date, ni priorité, ni destinataire.
// Une liste qui demande cinq renseignements avant d'accepter une ligne
// est une liste qu'on n'alimente pas.
//
// Marie répond dans le même fil : faite, annulée, reportée, ou un mot.
// Chaque geste laisse une trace, pour qu'on n'ait jamais à redemander
// « tu l'as fait ? ».
// =====================================================================
import { supabase } from './supabase.js';
import { ouvrirAideSujet } from './help.js';
import { currentUser, isManager, displayName } from './auth.js';
import {
  $, $$, escapeHtml, toast, errorMessage, confirmDialog,
  fmtDate, longDate, todayISO, addDays, notifyDataChange
} from './ui.js';

let taches = [];
let montrerClos = false;
let ouverte = null;        // id de la tâche dont l'échange est déplié

const PRIORITES = { haute: 'Urgent', normale: 'Normal', basse: 'Quand tu peux' };

/** « aujourd'hui », « demain », « en retard de 3 jours » */
function echeanceTexte(t) {
  if (!t.due_date) return '';
  const j = Math.round((Date.parse(t.due_date) - Date.parse(todayISO())) / 86400000);
  if (j === 0) return "aujourd'hui";
  if (j === 1) return 'demain';
  if (j === -1) return 'hier';
  if (j < 0) return `en retard de ${-j} jours`;
  if (j <= 7) return `dans ${j} jours`;
  return fmtDate(t.due_date);
}

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
export async function chargerTaches() {
  const { data, error } = await supabase.rpc('task_list', { p_closes: montrerClos });
  if (error) throw error;
  taches = (typeof data === 'string' ? JSON.parse(data) : data) || [];
  return taches;
}

export async function refreshTaskBadge() {
  try {
    const { data } = await supabase.rpc('task_count');
    const c = (typeof data === 'string' ? JSON.parse(data) : data) || {};
    const n = Number(c.a_faire) || 0;
    ['#task-badge', '#task-badge-m'].forEach((sel) => {
      const b = $(sel);
      if (!b) return;
      b.textContent = n;
      b.hidden = n === 0;
      b.classList.toggle('urgent', Number(c.en_retard) > 0);
    });
  } catch { /* la pastille n'est qu'un indicateur */ }
}

// ---------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------
function ligneHtml(t) {
  const retard = t.status === 'a_faire' && t.due_date && t.due_date < todayISO();
  const clos = t.status !== 'a_faire';
  const echange = t.comments || [];
  const deplie = ouverte === t.id;

  return `
    <li class="tache ${t.priority} ${retard ? 'retard' : ''} ${clos ? 'close' : ''}" data-tache="${t.id}">
      <div class="tache-haut">
        <button type="button" class="tache-coche" data-faite="${t.id}"
          title="${clos ? 'Remettre à faire' : 'Marquer faite'}"
          aria-label="${clos ? 'Remettre à faire' : 'Marquer faite'}">${clos ? '↺' : '✓'}</button>
        <div class="tache-corps">
          <span class="tache-titre">${escapeHtml(t.title)}</span>
          ${t.details ? `<span class="tache-detail tache-details">${escapeHtml(t.details).replace(/\n/g, '<br>')}</span>` : ''}
          ${t.help_topic ? `
            <button type="button" class="tache-aide" data-aide="${escapeHtml(t.help_topic)}">
              ? Comment faire</button>` : ''}
          <span class="tache-meta">
            ${t.priority === 'haute' ? '<span class="tache-prio">Urgent</span>' : ''}
            ${t.due_date ? `<span class="${retard ? 'txt-red strong' : ''}">${escapeHtml(echeanceTexte(t))}</span>` : ''}
            ${t.postponed ? `<span class="tache-reports">reportée ${t.postponed} fois</span>` : ''}
            ${t.assigned_name ? `<span class="muted">pour ${escapeHtml(t.assigned_name)}</span>` : ''}
            <span class="muted">de ${escapeHtml(t.created_name || '—')}</span>
            ${t.status === 'annulee' ? '<span class="tache-annulee">annulée</span>' : ''}
            ${t.status === 'faite' ? '<span class="tache-faite">faite</span>' : ''}
          </span>
        </div>
        <button type="button" class="tache-fil" data-fil="${t.id}"
          title="Commentaires" aria-expanded="${deplie}">
          💬${echange.length ? `<span class="tache-n">${echange.length}</span>` : ''}
        </button>
      </div>

      ${deplie ? `
        <div class="tache-echange">
          ${echange.length ? echange.map((c) => `
            <div class="tache-mot ${c.automatique ? 'auto' : ''}">
              <span class="tache-qui">${escapeHtml(c.author_name || '—')}</span>
              <span class="tache-quand">${escapeHtml(String(c.created_at).slice(0, 16).replace('T', ' à '))}</span>
              <span class="tache-texte">${escapeHtml(c.body)}</span>
            </div>`).join('')
            : `<p class="muted small">Rien d'écrit pour l'instant.</p>`}

          <div class="tache-repondre">
            <input type="text" class="search" data-mot="${t.id}" placeholder="Répondre…" autocomplete="off">
            <button type="button" class="btn btn-sm btn-primary" data-envoyer="${t.id}">Envoyer</button>
          </div>

          <div class="tache-actions">
            <button type="button" class="btn btn-sm" data-reporter="${t.id}">Reporter…</button>
            ${t.status !== 'annulee'
              ? `<button type="button" class="btn btn-sm" data-annuler="${t.id}">Annuler la demande</button>`
              : ''}
            ${isManager() ? `<button type="button" class="btn btn-sm btn-danger" data-suppr="${t.id}">Supprimer</button>` : ''}
          </div>
        </div>` : ''}
    </li>`;
}

export async function renderTaches() {
  const boite = $('#taches-body');
  if (!boite) return;

  try {
    await chargerTaches();
  } catch (err) {
    console.error(err);
    boite.innerHTML = `<div class="card pad"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  const ouvertes = taches.filter((t) => t.status === 'a_faire');
  const closes = taches.filter((t) => t.status !== 'a_faire');
  const retard = ouvertes.filter((t) => t.due_date && t.due_date < todayISO()).length;

  boite.innerHTML = `
    <div class="card pad taches-resume">
      <strong>${ouvertes.length || 'Aucune'} chose${ouvertes.length > 1 ? 's' : ''} à faire</strong>
      ${retard ? `<span class="txt-red strong">${retard} en retard</span>` : ''}
      <span class="spacer"></span>
      <label class="check"><input type="checkbox" id="taches-closes" ${montrerClos ? 'checked' : ''}>
        Voir ce qui est terminé</label>
    </div>

    ${ouvertes.length
      ? `<ul class="taches">${ouvertes.map(ligneHtml).join('')}</ul>`
      : `<div class="card pad"><p class="muted">Rien à faire pour l'instant. Ajoute quelque chose ci-dessus.</p></div>`}

    ${montrerClos && closes.length ? `
      <p class="taches-titre">Terminé</p>
      <ul class="taches">${closes.map(ligneHtml).join('')}</ul>` : ''}`;

  cabler();
  refreshTaskBadge();
}

// ---------------------------------------------------------------------
// Gestes
// ---------------------------------------------------------------------
async function ajouter() {
  const champ = $('#tache-titre');
  const titre = champ.value.trim();
  if (!titre) return champ.focus();

  const bouton = $('#tache-ajouter');
  bouton.disabled = true;
  try {
    const { error } = await supabase.rpc('task_create', {
      p_title: titre,
      p_details: null,
      p_due: $('#tache-date').value || null,
      p_priority: $('#tache-prio').value || 'normale',
      // Par défaut, ce que j'écris est pour l'autre : c'est le cas courant.
      p_assigned: $('#tache-pour').value || null
    });
    if (error) throw error;
    champ.value = '';
    $('#tache-date').value = '';
    $('#tache-prio').value = 'normale';
    toast('Ajouté.');
    // Le curseur reste dans le champ : on note souvent deux choses de suite.
    champ.focus();
    await renderTaches();
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Ajout impossible.'), 'error');
  } finally {
    bouton.disabled = false;
  }
}

async function basculerFaite(id) {
  const t = taches.find((x) => x.id === id);
  if (!t) return;
  try {
    const { error } = await supabase.rpc('task_set_status', {
      p_id: id, p_status: t.status === 'a_faire' ? 'faite' : 'a_faire', p_note: null
    });
    if (error) throw error;
    await renderTaches();
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Modification impossible.'), 'error');
  }
}

async function annuler(id) {
  const t = taches.find((x) => x.id === id);
  const ok = await confirmDialog(
    `Annuler la demande « ${t?.title || ''} » ?\n`
    + 'Elle reste consultable avec tout son échange, mais sort de la liste à faire.',
    'Annuler la demande');
  if (!ok) return;
  const mot = $(`[data-mot="${id}"]`)?.value.trim() || null;
  try {
    const { error } = await supabase.rpc('task_set_status', { p_id: id, p_status: 'annulee', p_note: mot });
    if (error) throw error;
    await renderTaches();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Annulation impossible.'), 'error');
  }
}

async function reporter(id) {
  const t = taches.find((x) => x.id === id);
  const depart = t?.due_date || todayISO();
  const propose = addDays(depart < todayISO() ? todayISO() : depart, 7);
  const ok = await confirmDialog(
    `Reporter « ${t?.title || ''} » d'une semaine, au ${fmtDate(propose)} ?\n`
    + `${longDate(propose)}. La tâche reste à faire.`,
    'Reporter');
  if (!ok) return;
  try {
    const { error } = await supabase.rpc('task_postpone', {
      p_id: id, p_due: propose, p_note: $(`[data-mot="${id}"]`)?.value.trim() || null
    });
    if (error) throw error;
    toast(`Reportée au ${fmtDate(propose)}.`);
    await renderTaches();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Report impossible.'), 'error');
  }
}

async function commenter(id) {
  const champ = $(`[data-mot="${id}"]`);
  const texte = champ?.value.trim();
  if (!texte) return champ?.focus();
  try {
    const { error } = await supabase.rpc('task_comment', { p_id: id, p_body: texte });
    if (error) throw error;
    champ.value = '';
    await renderTaches();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Envoi impossible.'), 'error');
  }
}

async function supprimer(id) {
  const t = taches.find((x) => x.id === id);
  const ok = await confirmDialog(
    `Supprimer définitivement « ${t?.title || ''} » ?\n`
    + 'Tout l\'échange qui s\'y rattache disparaît aussi. Pour la sortir de la liste sans '
    + 'rien perdre, préfère « Annuler la demande ».',
    'Supprimer');
  if (!ok) return;
  try {
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) throw error;
    toast('Tâche supprimée.');
    await renderTaches();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Suppression impossible.'), 'error');
  }
}

function cabler() {
  $('#taches-closes')?.addEventListener('change', (e) => {
    montrerClos = e.target.checked;
    renderTaches();
  });

  const boite = $('#taches-body');
  if (!boite || boite.dataset.cable) return;
  boite.dataset.cable = '1';

  boite.addEventListener('click', (e) => {
    const b = e.target.closest('[data-faite],[data-fil],[data-reporter],[data-annuler],[data-envoyer],[data-suppr],[data-aide]');
    if (!b) return;
    // Le chapitre du mode d'emploi qui concerne CETTE demande, ouvert
    // sur place. Une consigne qui oblige à chercher ailleurs est une
    // consigne qu'on repousse.
    if (b.dataset.aide) return ouvrirAideSujet(b.dataset.aide);
    if (b.dataset.faite) return basculerFaite(b.dataset.faite);
    if (b.dataset.fil) { ouverte = ouverte === b.dataset.fil ? null : b.dataset.fil; return renderTaches(); }
    if (b.dataset.reporter) return reporter(b.dataset.reporter);
    if (b.dataset.annuler) return annuler(b.dataset.annuler);
    if (b.dataset.envoyer) return commenter(b.dataset.envoyer);
    if (b.dataset.suppr) return supprimer(b.dataset.suppr);
  });

  boite.addEventListener('keydown', (e) => {
    const champ = e.target.closest('[data-mot]');
    if (champ && e.key === 'Enter') { e.preventDefault(); commenter(champ.dataset.mot); }
  });
}

export function initTaches() {
  $('#tache-ajouter')?.addEventListener('click', ajouter);
  // Entrée envoie : sur un téléphone, c'est la touche qui tombe sous le pouce.
  $('#tache-titre')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ajouter(); }
  });

  // Qui fait quoi : la liste se remplit une fois les comptes connus.
  window.addEventListener('vk:profil', () => remplirDestinataires());
}

/**
 * « Pour qui ». Par défaut l'autre personne : on se note rarement à
 * soi-même une tâche qu'on vient d'écrire dans une liste partagée.
 */
export async function remplirDestinataires() {
  const sel = $('#tache-pour');
  if (!sel) return;
  try {
    // Pas la table des profils : elle porte les rôles, et sa policy ne
    // laisse voir les autres qu'au gérant — Marie n'aurait pas pu adresser
    // une demande à Jordan. equipe() ne rend qu'un identifiant et un nom.
    const { data } = await supabase.rpc('equipe');
    const tous = (typeof data === 'string' ? JSON.parse(data) : data) || [];
    // currentUser est une variable exportée, pas une fonction.
    const gens = tous.filter((p) => p.id !== currentUser?.id);
    sel.innerHTML = '<option value="">Pour personne en particulier</option>' +
      gens.map((p) => `<option value="${p.id}">Pour ${escapeHtml(p.full_name || '—')}</option>`).join('');
    if (gens.length === 1) sel.value = gens[0].id;
  } catch { /* le champ reste facultatif */ }
}

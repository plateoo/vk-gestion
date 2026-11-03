// =====================================================================
// clients.js — les dossiers clients : poses et service après-vente.
//
// Un client téléphone, passe au magasin ou envoie un mail : on doit
// pouvoir ouvrir son dossier en dix secondes, le nom suffit. Tout le
// reste se complète ensuite, sur le dossier lui-même.
//
// Un dossier porte des FICHES. Une pose avance d'« à planifier » à
// « planifiée » dès qu'elle a une date, puis se termine de deux façons :
// clôturée, ou avec un SAV. Un SAV avance par ses étapes — commandé,
// reçu, planifié — et se termine clôturé, ou en nouvelle intervention.
// « Avec suite », c'est toujours une nouvelle fiche SAV reliée à la
// précédente : la base le fait en un seul geste (client_job_followup).
//
// Le fil du dossier s'écrit tout seul pour les changements d'état et de
// date (déclencheur en base). On n'y tape que ce qui ne se déduit pas.
// =====================================================================
import { supabase } from './supabase.js';
import { isManager } from './auth.js';
import {
  $, $$, escapeHtml, toast, errorMessage, confirmDialog, fmtDate, todayISO
} from './ui.js';

let dossiers = [];
let filtre = 'encours';
let recherche = '';
let ouvert = null;          // id du dossier affiché, null = la liste
let notes = [];
let suite = null;           // id de la fiche dont le formulaire « suite » est déplié
let montrerFinies = false;
let creation = { source: 'telephone', kind: 'pose' };

export const ETATS = {
  pose: {
    a_planifier: { label: 'À planifier', cls: 'st-orange' },
    planifiee:   { label: 'Planifiée',   cls: 'st-blue' },
    terminee:    { label: 'Terminée',    cls: 'st-green' },
    sav:         { label: 'Terminée avec SAV', cls: 'st-grey' }
  },
  sav: {
    a_traiter: { label: 'À traiter', cls: 'st-red' },
    commande:  { label: 'Commandé',  cls: 'st-orange' },
    recu:      { label: 'Reçu',      cls: 'st-orange' },
    planifie:  { label: 'Planifié',  cls: 'st-blue' },
    cloture:   { label: 'Clôturé',   cls: 'st-green' },
    nouvelle_intervention: { label: 'Nouvelle intervention', cls: 'st-grey' }
  }
};
// Les étapes d'un SAV, dans l'ordre où elles arrivent
const ETAPES_SAV = ['a_traiter', 'commande', 'recu', 'planifie'];
const SOURCES = { telephone: 'Téléphone', magasin: 'Magasin', mail: 'Mail' };

const finie = (j) => (j.kind === 'pose' && ['terminee', 'sav'].includes(j.status))
  || (j.kind === 'sav' && ['cloture', 'nouvelle_intervention'].includes(j.status));
const etat = (j) => ETATS[j.kind]?.[j.status] || { label: j.status, cls: 'st-grey' };

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
async function chargerDossiers() {
  const { data, error } = await supabase.rpc('client_file_list');
  if (error) throw error;
  dossiers = (typeof data === 'string' ? JSON.parse(data) : data) || [];
}

async function chargerNotes(id) {
  const { data, error } = await supabase.from('client_notes')
    .select('*').eq('file_id', id).order('created_at', { ascending: false });
  if (error) throw error;
  notes = (data || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Un dossier est en cours tant qu'il n'a pas de fiche, ou qu'une fiche est ouverte. */
const enCours = (d) => !d.jobs.length || d.jobs.some((j) => !finie(j));

const FILTRES = {
  encours:    { label: 'En cours',          test: enCours },
  a_planifier:{ label: 'Poses à planifier', test: (d) => d.jobs.some((j) => j.kind === 'pose' && j.status === 'a_planifier') },
  poses:      { label: 'Poses à venir',     test: (d) => d.jobs.some((j) => j.kind === 'pose' && j.status === 'planifiee') },
  sav:        { label: 'SAV en cours',      test: (d) => d.jobs.some((j) => j.kind === 'sav' && !finie(j)) },
  clotures:   { label: 'Clôturés',          test: (d) => !enCours(d) },
  tous:       { label: 'Tous',              test: () => true }
};

function correspond(d, q) {
  if (!q) return true;
  const n = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const chiffres = q.replace(/\D/g, '');
  const texte = n([d.name, d.email, d.address, d.todo, ...d.jobs.map((j) => `${j.title || ''} ${j.order_ref || ''} ${j.remarks || ''}`)].join(' '));
  return texte.includes(n(q)) || (chiffres.length >= 3 && String(d.phone || '').replace(/\D/g, '').includes(chiffres));
}

/** La prochaine date utile d'un dossier : livraison, pose ou intervention à venir */
function prochaineDate(d) {
  const dates = [];
  for (const j of d.jobs) {
    if (finie(j)) continue;
    if (j.delivery_date) dates.push({ date: j.delivery_date, quoi: 'Livraison' });
    if (j.pose_date) dates.push({ date: j.pose_date, quoi: 'Pose' });
    if (j.intervention_date) dates.push({ date: j.intervention_date, quoi: 'Intervention SAV' });
  }
  const futures = dates.filter((x) => x.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date));
  return futures[0] || null;
}

// ---------------------------------------------------------------------
// Rendu — la liste
// ---------------------------------------------------------------------
function carteHtml(d) {
  const prochaine = prochaineDate(d);
  const ouvertes = d.jobs.filter((j) => !finie(j));
  const montrees = ouvertes.length ? ouvertes : d.jobs.slice(-1);
  return `
    <li class="cl-carte" data-ouvrir="${d.id}" tabindex="0" role="button">
      <div class="cl-carte-haut">
        <strong class="cl-nom">${escapeHtml(d.name)}</strong>
        ${d.phone ? `<span class="muted small">${escapeHtml(d.phone)}</span>` : ''}
        <span class="spacer"></span>
        ${prochaine ? `<span class="cl-date">${escapeHtml(prochaine.quoi)} ${escapeHtml(fmtDate(prochaine.date))}</span>` : ''}
      </div>
      ${d.address ? `<span class="muted small">${escapeHtml(d.address)}</span>` : ''}
      <div class="cl-fiches">
        ${montrees.map((j) => `
          <span class="badge ${etat(j).cls}">${j.kind === 'pose' ? 'Pose' : 'SAV'} · ${escapeHtml(etat(j).label)}</span>`).join('')}
        ${!d.jobs.length ? '<span class="badge st-grey">Aucune fiche</span>' : ''}
      </div>
      ${d.todo ? `<p class="cl-todo">${escapeHtml(d.todo)}</p>` : ''}
      ${d.last_note && !d.last_note.automatique ? `<p class="cl-dernier muted small">« ${escapeHtml(d.last_note.body)} » — ${escapeHtml(d.last_note.author_name || '')}</p>` : ''}
    </li>`;
}

function listeHtml() {
  const compte = (k) => dossiers.filter(FILTRES[k].test).length;
  const visibles = dossiers.filter(FILTRES[filtre].test).filter((d) => correspond(d, recherche));
  return `
    <div class="cl-filtres">
      ${Object.entries(FILTRES).map(([k, f]) => `
        <button type="button" class="cl-filtre ${k === filtre ? 'active' : ''}" data-filtre="${k}">
          ${f.label}<span class="cl-n">${compte(k)}</span></button>`).join('')}
    </div>
    ${visibles.length
      ? `<ul class="cl-liste">${visibles.map(carteHtml).join('')}</ul>`
      : `<div class="card pad"><p class="muted">${dossiers.length
          ? 'Aucun dossier ne correspond.'
          : 'Aucun dossier client pour l\'instant. Crée le premier ci-dessus : le nom suffit.'}</p></div>`}`;
}

// ---------------------------------------------------------------------
// Rendu — un dossier
// ---------------------------------------------------------------------
function champ(cle, label, valeur, type = 'text') {
  return `
    <label class="field">
      <span class="sub">${label}</span>
      <input type="${type}" data-champ-dossier="${cle}" value="${escapeHtml(valeur || '')}">
    </label>`;
}

function formSuiteHtml(j) {
  const pose = j.kind === 'pose';
  return `
    <div class="cl-suite">
      <p class="small"><strong>${pose ? 'Ouvrir un SAV après cette pose' : 'Nouvelle intervention sur ce SAV'}</strong><br>
        <span class="muted">${pose
          ? 'La pose passe en « Terminée avec SAV » et une fiche SAV est créée, reliée à elle.'
          : 'Cette fiche passe en « Nouvelle intervention » et une nouvelle fiche SAV est créée, reliée à elle.'}</span></p>
      <input type="text" class="search" data-suite-titre="${j.id}" placeholder="Quel est le problème ?"
             value="${pose ? '' : escapeHtml(j.title || '')}" autocomplete="off">
      <div class="cl-choix" data-suite-source="${j.id}">
        ${Object.entries(SOURCES).map(([k, l]) => `<button type="button" data-source="${k}">${l}</button>`).join('')}
      </div>
      <div class="cl-actions">
        <button type="button" class="btn btn-primary btn-sm" data-suite-ok="${j.id}">Créer la fiche SAV</button>
        <button type="button" class="btn btn-ghost btn-sm" data-suite-annuler="${j.id}">Annuler</button>
      </div>
    </div>`;
}

function ficheHtml(j, d) {
  const e = etat(j);
  const pose = j.kind === 'pose';
  const parent = j.parent_id ? d.jobs.find((x) => x.id === j.parent_id) : null;

  // Une fiche terminée reste entièrement modifiable : on corrige une
  // date ou une remarque après coup sans devoir la rouvrir.
  const close = finie(j);
  const avecSuite = ['sav', 'nouvelle_intervention'].includes(j.status);

  return `
    <div class="cl-fiche ${pose ? 'pose' : 'sav'}${close ? ' finie' : ''}" data-fiche="${j.id}">
      <div class="cl-fiche-haut">
        <span class="cl-type">${pose ? 'Pose' : 'SAV'}</span>
        <span class="badge ${e.cls}">${escapeHtml(e.label)}</span>
        ${close && j.closed_at ? `<span class="muted small">terminée le ${escapeHtml(fmtDate(String(j.closed_at).slice(0, 10)))}</span>` : ''}
        ${j.source && SOURCES[j.source] ? `<span class="muted small">signalé par ${SOURCES[j.source].toLowerCase()}</span>` : ''}
        ${parent ? `<span class="muted small">suite de : ${parent.kind === 'pose' ? 'la pose' : 'SAV'}${parent.title ? ` « ${escapeHtml(parent.title)} »` : ''}</span>` : ''}
      </div>

      ${pose || close ? '' : `
        <div class="cl-etapes" role="group" aria-label="Étape du SAV">
          ${ETAPES_SAV.map((s) => `
            <button type="button" class="${s === j.status ? 'active' : ''} ${ETAPES_SAV.indexOf(s) < ETAPES_SAV.indexOf(j.status) ? 'passee' : ''}"
              data-etape="${s}" data-job="${j.id}">${ETATS.sav[s].label}</button>`).join('')}
        </div>`}

      <div class="cl-grille">
        <label class="field col-2"><span class="sub">${pose ? 'Objet (facultatif)' : 'Problème'}</span>
          <input type="text" data-champ-fiche="title" data-job="${j.id}" value="${escapeHtml(j.title || '')}"
                 placeholder="${pose ? 'Cuisine complète, plan de travail…' : 'Porte abîmée, pièce manquante…'}"></label>
        ${pose ? `
          <label class="field"><span class="sub">Livraison</span>
            <input type="date" data-champ-fiche="delivery_date" data-job="${j.id}" value="${j.delivery_date || ''}"></label>
          <label class="field"><span class="sub">Pose</span>
            <input type="date" data-champ-fiche="pose_date" data-job="${j.id}" value="${j.pose_date || ''}"></label>` : `
          <label class="field"><span class="sub">Référence de commande</span>
            <input type="text" data-champ-fiche="order_ref" data-job="${j.id}" value="${escapeHtml(j.order_ref || '')}"></label>
          <label class="field"><span class="sub">Date d'intervention</span>
            <input type="date" data-champ-fiche="intervention_date" data-job="${j.id}" value="${j.intervention_date || ''}"></label>`}
        <label class="field col-2"><span class="sub">Remarques</span>
          <textarea rows="2" data-champ-fiche="remarks" data-job="${j.id}"
            placeholder="Tout ce qui est utile : accès, pièce en stock, à rappeler…">${escapeHtml(j.remarks || '')}</textarea></label>
      </div>

      ${close ? `
        <div class="cl-actions">
          ${avecSuite
            ? '<span class="muted small">La suite est dans la fiche SAV qui en est issue.</span>'
            : `<button type="button" class="btn btn-sm" data-rouvrir="${j.id}">Rouvrir la fiche</button>`}
          ${isManager() ? `<button type="button" class="btn btn-ghost btn-sm" data-suppr-fiche="${j.id}">Supprimer la fiche</button>` : ''}
        </div>` : suite === j.id ? formSuiteHtml(j) : `
        <div class="cl-actions">
          <button type="button" class="btn btn-sm cl-ok" data-cloturer="${j.id}">✓ ${pose ? 'Pose terminée' : 'Clôturer le SAV'}</button>
          <button type="button" class="btn btn-sm cl-sav" data-suite="${j.id}">${pose ? '⚠ Ouvrir un SAV' : '↻ Nouvelle intervention'}</button>
          ${isManager() ? `<button type="button" class="btn btn-ghost btn-sm" data-suppr-fiche="${j.id}">Supprimer la fiche</button>` : ''}
        </div>`}
    </div>`;
}

function noteHtml(n) {
  const quand = String(n.created_at).slice(0, 16).replace('T', ' à ');
  return `
    <li class="cl-note ${n.automatique ? 'auto' : ''}">
      <span class="cl-note-meta">${escapeHtml(n.author_name || '—')} · ${escapeHtml(quand)}</span>
      <span class="cl-note-texte">${escapeHtml(n.body)}</span>
    </li>`;
}

/**
 * Sur place, chez le client : appeler et s'y rendre, chacun en un geste.
 * L'itinéraire ouvre l'application de cartes du téléphone.
 */
function contactHtml(d) {
  const liens = [];
  if (d.phone) {
    liens.push(`<a class="btn btn-sm" href="tel:${escapeHtml(String(d.phone).replace(/[^\d+]/g, ''))}">📞 Appeler ${escapeHtml(d.phone)}</a>`);
  }
  if (d.address) {
    liens.push(`<a class="btn btn-sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.address)}">📍 Itinéraire</a>`);
  }
  if (d.email) {
    liens.push(`<a class="btn btn-sm" href="mailto:${escapeHtml(d.email)}">✉ Écrire</a>`);
  }
  return liens.length ? `<div class="cl-contact">${liens.join('')}</div>` : '';
}

function dossierHtml(d) {
  const ouvertes = d.jobs.filter((j) => !finie(j));
  const finies = d.jobs.filter(finie);
  return `
    <div class="cl-retour">
      <button type="button" class="btn btn-sm" data-retour>← Tous les clients</button>
    </div>

    <div class="card pad cl-bloc">
      ${d.address ? `<p class="cl-adresse">${escapeHtml(d.address)}</p>` : ''}
      ${contactHtml(d)}
      <div class="cl-grille">
        <label class="field col-2"><span class="sub">Nom du client</span>
          <input type="text" class="cl-nom-champ" data-champ-dossier="name" value="${escapeHtml(d.name)}" required></label>
        ${champ('phone', 'Téléphone', d.phone, 'tel')}
        ${champ('email', 'E-mail', d.email, 'email')}
        <label class="field col-2"><span class="sub">Adresse</span>
          <input type="text" data-champ-dossier="address" value="${escapeHtml(d.address || '')}"></label>
      </div>
    </div>

    <div class="card pad cl-bloc">
      <label class="field"><span class="sub"><strong>Ce qu'il reste à faire</strong></span>
        <textarea rows="3" data-champ-dossier="todo" placeholder="Ex. : poser les plinthes, régler la porte du frigo…">${escapeHtml(d.todo || '')}</textarea></label>
    </div>

    <div class="cl-section-tete">
      <h2>Fiches</h2>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" data-nouvelle-fiche="pose">+ Fiche pose</button>
      <button type="button" class="btn btn-sm" data-nouvelle-fiche="sav">+ Fiche SAV</button>
    </div>
    ${ouvertes.length ? ouvertes.map((j) => ficheHtml(j, d)).join('')
      : `<div class="card pad"><p class="muted small">${finies.length
          ? 'Tout est terminé pour ce client.'
          : 'Pas encore de fiche. Ajoute une pose ou un SAV.'}</p></div>`}
    ${finies.length ? `
      <button type="button" class="btn btn-ghost btn-sm cl-finies-btn" data-finies>
        ${montrerFinies ? '▾' : '▸'} Fiches terminées (${finies.length})</button>
      ${montrerFinies ? finies.map((j) => ficheHtml(j, d)).join('') : ''}` : ''}

    <div class="cl-section-tete"><h2>Notes</h2></div>
    <div class="card pad cl-bloc">
      <div class="cl-note-ajout">
        <textarea id="client-note" rows="2" placeholder="Ajouter une note : appel du client, information utile…"></textarea>
        <button type="button" class="btn btn-primary btn-sm" data-noter>Ajouter</button>
      </div>
      ${notes.length ? `<ul class="cl-notes">${notes.map(noteHtml).join('')}</ul>`
        : '<p class="muted small">Rien d\'écrit pour l\'instant.</p>'}
    </div>

    ${isManager() ? `
      <div class="cl-danger">
        <button type="button" class="btn btn-ghost btn-sm" data-suppr-dossier>Supprimer ce dossier</button>
      </div>` : ''}`;
}

// ---------------------------------------------------------------------
// Pour le Planning : les dates des fiches, jour par jour
// ---------------------------------------------------------------------
/**
 * Les rendez-vous chez les clients : livraisons, poses, interventions.
 * Une fiche relancée en nouvelle intervention n'y figure plus — sa date
 * est celle de la fiche qui lui succède.
 */
export async function rendezVousClients() {
  await chargerDossiers();
  const out = [];
  for (const d of dossiers) {
    for (const j of d.jobs) {
      if (j.status === 'nouvelle_intervention') continue;
      const base = { nom: d.name, dossier: d.id, finie: finie(j), titre: j.title || '' };
      if (j.delivery_date) out.push({ ...base, jour: j.delivery_date, quoi: 'livraison' });
      if (j.pose_date) out.push({ ...base, jour: j.pose_date, quoi: 'pose' });
      if (j.intervention_date) out.push({ ...base, jour: j.intervention_date, quoi: 'sav' });
    }
  }
  return out;
}

/** Ouvre un dossier depuis un autre écran */
export function ouvrirDossier(id) {
  ouvert = id;
  suite = null;
  montrerFinies = false;
  window.dispatchEvent(new CustomEvent('vk:goto', { detail: 'clients' }));
}

export async function renderClients() {
  const boite = $('#clients-body');
  if (!boite) return;
  try {
    await chargerDossiers();
    if (ouvert && !dossiers.some((d) => d.id === ouvert)) ouvert = null;
    if (ouvert) await chargerNotes(ouvert);
  } catch (err) {
    console.error(err);
    boite.innerHTML = `<div class="card pad"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }
  // La création rapide et la recherche n'ont de sens que sur la liste
  $('#clients-tete').hidden = !!ouvert;
  boite.innerHTML = ouvert ? dossierHtml(dossiers.find((d) => d.id === ouvert)) : listeHtml();
}

// ---------------------------------------------------------------------
// Gestes
// ---------------------------------------------------------------------
async function rpc(nom, args, echec) {
  const { data, error } = await supabase.rpc(nom, args);
  if (error) { console.error(error); toast(errorMessage(error, echec), 'error'); return null; }
  return (typeof data === 'string' ? JSON.parse(data) : data) || {};
}

async function creer() {
  const nom = $('#client-nom').value.trim();
  if (!nom) { $('#client-nom').focus(); return toast('Le nom du client suffit, mais il le faut.', 'error'); }
  const bouton = $('#client-creer');
  bouton.disabled = true;
  try {
    const r = await rpc('client_file_create', {
      p_name: nom,
      p_phone: $('#client-tel').value.trim() || null,
      p_email: null,
      p_address: $('#client-adresse').value.trim() || null,
      p_source: creation.source || null,
      p_kind: creation.kind || null,
      p_title: $('#client-objet').value.trim() || null,
      p_note: null
    }, 'Création impossible.');
    if (!r) return;
    ['#client-nom', '#client-tel', '#client-adresse', '#client-objet'].forEach((s) => { $(s).value = ''; });
    toast(`Dossier « ${nom} » créé.`);
    // On ouvre le dossier : la suite (dates, adresse) se remplit là.
    ouvert = r.id;
    montrerFinies = false;
    await renderClients();
    window.scrollTo(0, 0);
  } finally {
    bouton.disabled = false;
  }
}

async function majDossier(cle, valeur) {
  const d = dossiers.find((x) => x.id === ouvert);
  if (!d) return;
  const v = cle === 'email' ? valeur.trim().toLowerCase() : valeur.trim();
  if (cle === 'name' && !v) { toast('Le nom ne peut pas être vide.', 'error'); return renderClients(); }
  if ((d[cle] || '') === v) return;
  const { error } = await supabase.from('client_files').update({ [cle]: v || null }).eq('id', d.id);
  if (error) { console.error(error); return toast(errorMessage(error, 'Enregistrement impossible.'), 'error'); }
  d[cle] = v || null;
  toast('Enregistré.', 'ok', 1400);
}

async function majFiche(id, patch, { redessiner = true, message = null } = {}) {
  const { error } = await supabase.from('client_jobs').update(patch).eq('id', id);
  if (error) { console.error(error); toast(errorMessage(error, 'Enregistrement impossible.'), 'error'); return false; }
  if (message) toast(message, 'ok', 1800);
  if (redessiner) await renderClients();
  return true;
}

async function nouvelleFiche(kind) {
  const r = await rpc('client_job_create', { p_file: ouvert, p_kind: kind, p_title: null, p_source: null }, 'Création impossible.');
  if (!r) return;
  toast(kind === 'pose' ? 'Fiche pose ajoutée.' : 'Fiche SAV ajoutée.');
  await renderClients();
  $(`[data-fiche="${r.id}"] input`)?.focus();
}

async function creerSuite(id) {
  const titre = $(`[data-suite-titre="${id}"]`)?.value.trim() || null;
  const source = $(`[data-suite-source="${id}"] .active`)?.dataset.source || null;
  const r = await rpc('client_job_followup', { p_job: id, p_title: titre, p_source: source }, 'Création du SAV impossible.');
  if (!r) return;
  suite = null;
  toast('Fiche SAV créée.');
  await renderClients();
}

async function cloturer(id) {
  const d = dossiers.find((x) => x.id === ouvert);
  const j = d?.jobs.find((x) => x.id === id);
  if (!j) return;
  await majFiche(id, { status: j.kind === 'pose' ? 'terminee' : 'cloture' },
    { message: j.kind === 'pose' ? 'Pose clôturée.' : 'SAV clôturé.' });
}

async function rouvrir(id) {
  const d = dossiers.find((x) => x.id === ouvert);
  const j = d?.jobs.find((x) => x.id === id);
  if (!j) return;
  // La base remet « à planifier » une pose sans date.
  const status = j.kind === 'pose' ? 'planifiee' : (j.intervention_date ? 'planifie' : 'a_traiter');
  await majFiche(id, { status }, { message: 'Fiche rouverte.' });
}

async function noter() {
  const champ = $('#client-note');
  const texte = champ?.value.trim();
  if (!texte) return champ?.focus();
  const r = await rpc('client_note_add', { p_file: ouvert, p_body: texte, p_job: null }, 'Note non enregistrée.');
  if (!r) return;
  await renderClients();
}

async function supprimerFiche(id) {
  const ok = await confirmDialog('Supprimer définitivement cette fiche ?\n'
    + 'Pour la terminer sans rien perdre, préfère « Clôturer ».', 'Supprimer');
  if (!ok) return;
  const { error } = await supabase.from('client_jobs').delete().eq('id', id);
  if (error) return toast(errorMessage(error, 'Suppression impossible.'), 'error');
  toast('Fiche supprimée.');
  await renderClients();
}

async function supprimerDossier() {
  const d = dossiers.find((x) => x.id === ouvert);
  const ok = await confirmDialog(`Supprimer définitivement le dossier « ${d?.name || ''} » ?\n`
    + 'Toutes ses fiches et toutes ses notes disparaissent avec lui.', 'Supprimer le dossier');
  if (!ok) return;
  const { error } = await supabase.from('client_files').delete().eq('id', ouvert);
  if (error) return toast(errorMessage(error, 'Suppression impossible.'), 'error');
  toast('Dossier supprimé.');
  ouvert = null;
  await renderClients();
}

/** Un groupe de boutons dont un seul est choisi */
function choisir(groupe, bouton) {
  $$('button', groupe).forEach((b) => b.classList.toggle('active', b === bouton && !b.classList.contains('active')));
}

function cabler() {
  const boite = $('#clients-body');

  boite.addEventListener('click', (e) => {
    const b = e.target.closest('button, [data-ouvrir]');
    if (!b || e.target.closest('a')) return;
    const ds = b.dataset;
    if (ds.ouvrir) { ouvert = ds.ouvrir; suite = null; montrerFinies = false; renderClients().then(() => window.scrollTo(0, 0)); return; }
    if ('retour' in ds) { ouvert = null; suite = null; return renderClients(); }
    if (ds.filtre) { filtre = ds.filtre; return renderClients(); }
    if (ds.nouvelleFiche) return nouvelleFiche(ds.nouvelleFiche);
    if (ds.etape) return majFiche(ds.job, { status: ds.etape }, { message: `SAV : ${ETATS.sav[ds.etape].label}.` });
    if (ds.cloturer) return cloturer(ds.cloturer);
    if (ds.suite) { suite = ds.suite; return renderClients().then(() => $(`[data-suite-titre="${ds.suite}"]`)?.focus()); }
    if (ds.suiteAnnuler) { suite = null; return renderClients(); }
    if (ds.suiteOk) return creerSuite(ds.suiteOk);
    if (ds.source) return choisir(b.parentElement, b);
    if (ds.rouvrir) return rouvrir(ds.rouvrir);
    if ('finies' in ds) { montrerFinies = !montrerFinies; return renderClients(); }
    if ('noter' in ds) return noter();
    if (ds.supprFiche) return supprimerFiche(ds.supprFiche);
    if ('supprDossier' in ds) return supprimerDossier();
  });

  boite.addEventListener('keydown', (e) => {
    const carte = e.target.closest('[data-ouvrir]');
    if (carte && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); carte.click(); }
    if (e.target.matches('[data-suite-titre]') && e.key === 'Enter') { e.preventDefault(); creerSuite(e.target.dataset.suiteTitre); }
  });

  // Les champs s'enregistrent en quittant le champ : pas de bouton
  // « Enregistrer » à oublier.
  boite.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.champDossier) return majDossier(t.dataset.champDossier, t.value);
    if (t.dataset.champFiche) {
      const cle = t.dataset.champFiche;
      const date = t.type === 'date';
      // Une date change l'état ou le fil : on redessine. Un texte, non —
      // le curseur est déjà dans le champ suivant.
      return majFiche(t.dataset.job, { [cle]: t.value.trim() || null },
        { redessiner: date, message: date ? null : 'Enregistré.' });
    }
  });
}

export function initClients() {
  if (!$('#clients-body')) return;
  cabler();

  $('#client-creer')?.addEventListener('click', creer);
  ['#client-nom', '#client-tel', '#client-adresse', '#client-objet'].forEach((s) => {
    $(s)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); creer(); } });
  });
  $('#client-recherche')?.addEventListener('input', (e) => {
    recherche = e.target.value.trim();
    if (!ouvert) $('#clients-body').innerHTML = listeHtml();
  });

  // Les deux choix de la création rapide : comment, et pour quoi
  for (const [sel, cle] of [['#client-source', 'source'], ['#client-type', 'kind']]) {
    const groupe = $(sel);
    groupe?.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('button', groupe).forEach((x) => x.classList.toggle('active', x === b));
      creation[cle] = b.dataset.val || null;
    });
  }
}

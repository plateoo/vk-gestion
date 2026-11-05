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
//
// Le RELAIS : Jordan confie un dossier à Marie avec une consigne, elle
// répond « traité » ou « pas traité » d'un geste, avec un mot. Jordan lit
// la réponse et classe. Un relais à la fois par dossier (client_relais).
// =====================================================================
import { supabase } from './supabase.js';
import { isManager, isSeller, currentUser, displayName } from './auth.js';
import {
  $, $$, escapeHtml, toast, errorMessage, confirmDialog, fmtDate, longDate, todayISO
} from './ui.js';

let dossiers = [];
let filtre = 'encours';
let recherche = '';
let ouvert = null;          // id du dossier affiché, null = la liste
let notes = [];
let documents = [];         // les documents du dossier ouvert
let travailKind = 'mail';   // la sorte de travail choisie dans « Noter un travail fait »
let suite = null;           // id de la fiche dont le formulaire « suite » est déplié
let courriel = null;        // id de la fiche dont le mail au client est déplié
let montrerFinies = false;
let creation = { source: 'telephone', kind: 'pose' };
let equipe = null;          // [{ id, full_name, role }] : à qui confier un dossier
let filtreChoisi = false;   // tant que personne n'a choisi, le filtre suit le relais

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
  },
  mesure: {
    a_planifier: { label: 'À planifier', cls: 'st-orange' },
    planifiee:   { label: 'Planifié',    cls: 'st-blue' },
    faite:       { label: 'Fait',        cls: 'st-green' }
  },
  demande: {
    a_traiter: { label: 'À traiter', cls: 'st-red' },
    en_cours:  { label: 'En cours',  cls: 'st-orange' },
    traitee:   { label: 'Traitée',   cls: 'st-green' }
  }
};
// Le nom d'une fiche, selon sa sorte
export const SORTES = { pose: 'Pose', sav: 'SAV', mesure: 'Mesurage', demande: 'Demande' };
// Les étapes, dans l'ordre où elles arrivent (un mesurage avance par sa date)
const ETAPES = { sav: ['a_traiter', 'commande', 'recu', 'planifie'], demande: ['a_traiter', 'en_cours'] };
// L'état final « sans suite » de chaque sorte
const FIN = { pose: 'terminee', sav: 'cloture', mesure: 'faite', demande: 'traitee' };
const SOURCES = { telephone: 'Téléphone', magasin: 'Magasin', mail: 'Mail' };

const finie = (j) => (j.kind === 'pose' && ['terminee', 'sav'].includes(j.status))
  || (j.kind === 'sav' && ['cloture', 'nouvelle_intervention'].includes(j.status))
  || (j.kind === 'mesure' && j.status === 'faite')
  || (j.kind === 'demande' && j.status === 'traitee');
const etat = (j) => ETATS[j.kind]?.[j.status] || { label: j.status, cls: 'st-grey' };

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
async function chargerDossiers() {
  const { data, error } = await supabase.rpc('client_file_list');
  if (error) throw error;
  dossiers = (typeof data === 'string' ? JSON.parse(data) : data) || [];
  if (equipe === null) await chargerEquipe();
}

/**
 * Le relais n'existe qu'une fois sa migration (0042) appliquée : avant,
 * la liste ne porte pas la colonne, et l'écran ne propose rien.
 */
const relaisActif = () => dossiers.some((d) => 'relais' in d);

/** Toute l'équipe, pour « confier à » — les vendeurs compris */
async function chargerEquipe() {
  equipe = [];
  try {
    const { data } = await supabase.rpc('equipe');
    equipe = (typeof data === 'string' ? JSON.parse(data) : data) || [];
  } catch { /* sans annuaire, on ne peut confier à personne */ }
}

const moi = () => currentUser?.id;
const ROLE_COURT = { manager: 'gérant', secretary: 'bureau', seller: 'vendeur' };
/** « Marie (bureau) », « Marie Closson (vendeur) » : les deux Marie se distinguent */
const nomPersonne = (p) => `${p.full_name || '—'}${ROLE_COURT[p.role] ? ` (${ROLE_COURT[p.role]})` : ''}`;
const collegues = () => (equipe || []).filter((p) => p.id !== moi());

function poserPastille(n, urgent = false) {
  $$('.client-badge').forEach((b) => {
    b.textContent = n;
    // Un vendeur a Clients dans sa barre du bas : pas de doublon sur « Plus »
    b.hidden = n === 0 || (isSeller() && !!b.closest('#tabbar-plus'));
    b.classList.toggle('urgent', urgent);
  });
}

/**
 * La pastille du menu : ce qu'on m'a confié, plus les réponses à ce que
 * j'ai confié. Appelée à la connexion : on oublie alors l'équipe et le
 * filtre du compte précédent.
 */
export async function refreshClientBadge({ connexion = false } = {}) {
  if (connexion) { equipe = null; filtreChoisi = false; ouvert = null; }
  try {
    const { data, error } = await supabase.rpc('client_relais_count');
    if (error) throw error;
    const c = (typeof data === 'string' ? JSON.parse(data) : data) || {};
    poserPastille((Number(c.a_traiter) || 0) + (Number(c.reponses) || 0), Number(c.urgents) > 0);
  } catch { /* une pastille absente ne bloque rien */ }
}

async function chargerDocuments(id) {
  documents = [];
  const { data, error } = await supabase.from('client_documents').select('*').eq('file_id', id).order('created_at', { ascending: false });
  // Avant la migration 0043 la table n'existe pas : pas de document, pas d'erreur
  if (!error) documents = data || [];
}

async function chargerNotes(id) {
  const { data, error } = await supabase.from('client_notes')
    .select('*').eq('file_id', id).order('created_at', { ascending: false });
  if (error) throw error;
  notes = (data || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Un dossier est en cours tant qu'il n'a pas de fiche, ou qu'une fiche est ouverte. */
// Un dossier clôturé à la main est rangé, quelles que soient ses fiches.
const enCours = (d) => !d.closed_at && (!d.jobs.length || d.jobs.some((j) => !finie(j)));

// Les filtres du relais se lisent du point de vue de qui regarde.
const pourMoi = (d) => d.relais === 'a_traiter' && d.relais_pour === moi();
const reponseAMoi = (d) => ['traite', 'non_traite'].includes(d.relais) && d.relais_de === moi();
const FILTRES = {
  relais:     { label: 'À traiter pour toi', test: pourMoi },
  reponses:   { label: 'Réponses reçues',    test: reponseAMoi },
  confies:    { label: 'Confiés en attente', test: (d) => d.relais === 'a_traiter' && d.relais_de === moi() },
  urgents:    { label: 'Urgents',           test: (d) => (d.todo_urgent && String(d.todo || '').trim()) || pourMoi(d) && d.relais_urgent },
  retard:     { label: 'En retard',         test: (d) => retard(d) > 0 },
  encours:    { label: 'En cours',          test: enCours },
  miens:      { label: 'Mes dossiers',      test: (d) => d.created_by === moi() || d.relais_pour === moi() || d.relais_de === moi() },
  mesures:    { label: 'Mesurages à planifier', test: (d) => d.jobs.some((j) => j.kind === 'mesure' && j.status === 'a_planifier') },
  a_planifier:{ label: 'Poses à planifier', test: (d) => d.jobs.some((j) => j.kind === 'pose' && j.status === 'a_planifier') },
  poses:      { label: 'Poses à venir',     test: (d) => d.jobs.some((j) => j.kind === 'pose' && j.status === 'planifiee') },
  sav:        { label: 'SAV en cours',      test: (d) => d.jobs.some((j) => j.kind === 'sav' && !finie(j)) },
  demandes:   { label: 'Demandes en cours', test: (d) => d.jobs.some((j) => j.kind === 'demande' && !finie(j)) },
  problemes:  { label: '⚠ Problèmes',        test: (d) => !!d.probleme },
  clotures:   { label: 'Clôturés',          test: (d) => !enCours(d) },
  tous:       { label: 'Tous',              test: () => true }
};

function correspond(d, q) {
  if (!q) return true;
  const n = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const chiffres = q.replace(/\D/g, '');
  const texte = n([d.name, d.email, d.address, d.todo, d.created_name, ...d.jobs.map((j) => `${j.title || ''} ${j.order_ref || ''} ${j.remarks || ''} ${j.preferences || ''}`)].join(' '));
  return texte.includes(n(q)) || (chiffres.length >= 3 && String(d.phone || '').replace(/\D/g, '').includes(chiffres));
}

/** La prochaine date utile d'un dossier : livraison, pose ou intervention à venir */
function prochaineDate(d) {
  const dates = [];
  for (const j of d.jobs) {
    if (finie(j)) continue;
    if (j.delivery_date) dates.push({ date: j.delivery_date, quoi: 'Livraison' });
    if (j.pose_date) dates.push({ date: j.pose_date, quoi: 'Pose' });
    if (j.intervention_date) dates.push({ date: j.intervention_date, quoi: j.kind === 'mesure' ? 'Mesurage' : 'Intervention SAV' });
  }
  const futures = dates.filter((x) => x.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date));
  return futures[0] || null;
}

// ---------------------------------------------------------------------
// Rendu — la liste
// ---------------------------------------------------------------------
const RELAIS = {
  a_traiter:  { cls: 'st-orange', texte: (d) => d.relais_pour === moi() ? 'À traiter pour toi' : `Chez ${d.relais_pour_name || '—'}` },
  traite:     { cls: 'st-green',  texte: (d) => `✓ Traité par ${d.relais_par_name || '—'}` },
  non_traite: { cls: 'st-red',    texte: (d) => `✗ Pas traité par ${d.relais_par_name || '—'}` }
};
const libelleFiltre = (k) => FILTRES[k].label;
const FILTRES_RELAIS = ['relais', 'reponses', 'confies'];

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
        ${(d.relais === 'a_traiter' && d.relais_urgent) || (d.todo_urgent && String(d.todo || '').trim()) ? '<span class="badge st-red cl-urgent">URGENT</span>' : ''}
        ${d.probleme ? '<span class="badge st-red cl-urgent">⚠ Problème</span>' : ''}
        ${d.closed_at ? '<span class="badge st-grey">Dossier clôturé</span>' : ''}
        ${estTraite(d) ? '<span class="badge st-green">✓ Traité</span>' : ''}
        ${retard(d) ? `<span class="badge st-red">En retard de ${retard(d)} j</span>` : d.todo_due && String(d.todo || '').trim() ? `<span class="badge st-blue">Pour le ${escapeHtml(fmtDate(d.todo_due))}</span>` : ''}
        ${d.relais ? `<span class="badge ${RELAIS[d.relais].cls} cl-relais-badge">${escapeHtml(RELAIS[d.relais].texte(d))}</span>` : ''}
        ${montrees.map((j) => `
          <span class="badge ${etat(j).cls}">${SORTES[j.kind] || j.kind} · ${escapeHtml(etat(j).label)}</span>`).join('')}
        ${!d.jobs.length ? '<span class="badge st-grey">Aucune fiche</span>' : ''}
      </div>
      ${d.relais === 'a_traiter' && d.relais_consigne
        ? `<p class="cl-todo cl-consigne">${escapeHtml(d.relais_consigne)}</p>`
        : d.todo && !d.relais ? `<p class="cl-todo">${escapeHtml(d.todo)}</p>` : ''}
      ${d.relais && d.relais !== 'a_traiter' ? `
        <p class="cl-dernier muted small">Consigne : ${escapeHtml(d.relais_consigne || '')}</p>
        ${d.relais_reponse ? `<p class="cl-dernier small">« ${escapeHtml(d.relais_reponse)} » — ${escapeHtml(d.relais_par_name || '')}</p>` : ''}` : ''}
      ${d.last_note && !d.last_note.automatique && !d.relais ? `<p class="cl-dernier muted small">« ${escapeHtml(d.last_note.body)} » — ${escapeHtml(d.last_note.author_name || '')}</p>` : ''}
      ${d.probleme ? `<p class="cl-todo cl-probleme-txt">⚠ ${escapeHtml(d.probleme)}</p>` : ''}
      ${d.last_work ? `<p class="cl-dernier small cl-fait">${escapeHtml(d.last_work.body)} — ${escapeHtml(d.last_work.author_name || '')}</p>` : ''}
      ${d.closed_at ? '' : 'todo_due' in d && String(d.todo || '').trim() ? `<div class="cl-carte-actions"><button type="button" class="btn btn-sm cl-ok" data-traite="${d.id}">✓ Dossier traité</button></div>`
        : estTraite(d) && 'id' in d.last_work ? `<div class="cl-carte-actions"><button type="button" class="btn btn-sm btn-ghost" data-traite-annuler="${d.id}">Annuler « traité »</button></div>` : ''}
      ${d.created_name ? `<p class="cl-qui muted small">Créé par ${escapeHtml(d.created_name)}${d.updated_name && d.updated_name !== d.created_name ? ` · modifié par ${escapeHtml(d.updated_name)}` : ''}</p>` : ''}
    </li>`;
}

function listeHtml() {
  const compte = (k) => dossiers.filter(FILTRES[k].test).length;
  // À l'ouverture, chacun tombe sur ce qui l'attend : ce qu'on lui a
  // confié d'abord, puis les réponses à ce qu'il a confié.
  if (!filtreChoisi) {
    filtre = compte('relais') ? 'relais' : compte('reponses') ? 'reponses' : 'encours';
  }
  // Les filtres du relais et des sortes rares n'apparaissent que s'ils ont
  // quelque chose à montrer ; « Mes dossiers » sert surtout aux vendeurs.
  const facultatifs = [...FILTRES_RELAIS, 'urgents', 'retard', 'problemes', 'mesures', 'demandes', ...(isSeller() ? [] : ['miens'])];
  const montres = Object.keys(FILTRES).filter((k) => !facultatifs.includes(k) || compte(k) || k === filtre);
  // L'urgent passe devant, puis le retard
  const poids = (d) => (pourMoi(d) && d.relais_urgent ? 8 : 0) + (d.probleme ? 4 : 0) + (d.todo_urgent && String(d.todo || '').trim() ? 2 : 0) + (retard(d) ? 1 : 0);
  const visibles = dossiers.filter(FILTRES[filtre].test).filter((d) => correspond(d, recherche))
    .sort((a, b) => poids(b) - poids(a));
  const urgents = dossiers.filter((d) => pourMoi(d) && d.relais_urgent).length;
  // Confier d'un coup les SAV en cours qui ont un « reste à faire »
  const aConfier = !isSeller() && filtre === 'sav' && relaisActif() && collegues().length
    ? visibles.filter((d) => d.relais !== 'a_traiter' && String(d.todo || '').trim()) : [];
  return `
    ${urgents ? `
      <button type="button" class="cl-alerte-urgent" data-filtre="relais">
        <strong>${urgents} demande${urgents > 1 ? 's' : ''} urgente${urgents > 1 ? 's' : ''} pour toi</strong>
        <span>Voir</span></button>` : ''}
    <div class="cl-filtres">
      ${montres.map((k) => `
        <button type="button" class="cl-filtre ${k === filtre ? 'active' : ''}${FILTRES_RELAIS.includes(k) ? ' relais' : ''}" data-filtre="${k}">
          ${escapeHtml(libelleFiltre(k))}<span class="cl-n">${compte(k)}</span></button>`).join('')}
    </div>
    ${aConfier.length ? `
      <div class="cl-lot">
        <span class="small">${aConfier.length} dossier${aConfier.length > 1 ? 's' : ''} SAV avec un « reste à faire » pas encore confié${aConfier.length > 1 ? 's' : ''}.</span>
        <select id="lot-pour" aria-label="Confier à">${collegues().map((p) => `<option value="${p.id}" ${p.role === 'secretary' ? 'selected' : ''}>${escapeHtml(nomPersonne(p))}</option>`).join('')}</select>
        <button type="button" class="btn btn-sm btn-primary" data-confier-lot="${aConfier.map((d) => d.id).join(',')}">Tout confier</button>
      </div>` : ''}
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

// ---------------------------------------------------------------------
// Le mail au client : un récapitulatif de sa fiche
// ---------------------------------------------------------------------
// Il part de la messagerie de qui l'envoie (lien mailto) : le client
// répond à une vraie personne, et rien ne part sans avoir été relu. Le
// texte est prérempli depuis la fiche, puis modifiable librement.
const MAGASIN = 'Vanden Borre Kitchen Boncelles';
const ORIGINE = { telephone: 'votre appel', magasin: 'votre passage au magasin', mail: 'votre mail' };

// Trois sortes de mail : la confirmation d'une fiche, l'annonce d'une
// date, ou un mot au client sur son dossier. Chacun reprend les
// informations de la fiche ; on coche ce qui part, on décoche ce qui
// doit rester chez nous.
const MODELES = {
  maj:          { label: 'Mise à jour',    blocs: ['demande', 'contact'] },
  confirmation: { label: 'Fiche créée',   blocs: ['demande', 'infos', 'ref', 'dates', 'prefs', 'adresse', 'tel', 'contact'] },
  date:         { label: 'Date planifiée', blocs: ['demande', 'dates', 'adresse', 'contact'] },
  info:         { label: 'Message libre',  blocs: ['demande', 'contact'] }
};

// Ce que la fiche peut apporter au mail. « valeur » vide = case absente.
const BLOCS = [
  { cle: 'demande', label: (j) => j.kind === 'pose' ? 'Objet' : j.kind === 'mesure' ? 'À mesurer' : 'Demande', valeur: (j) => j.title },
  { cle: 'infos',   label: () => 'Informations notées', valeur: (j) => j.remarks,
    aide: 'reprend les remarques de la fiche : rien d\'interne ?' },
  { cle: 'ref',     label: () => 'Référence de commande', valeur: (j) => j.kind === 'sav' ? j.order_ref : '' },
  { cle: 'dates',   label: (j) => ({ pose: 'Dates de livraison et de pose', mesure: 'Date du mesurage' }[j.kind] || 'Date d\'intervention'), valeur: (j) => phraseDate(j).join(' ') },
  { cle: 'prefs',   label: () => 'Vos disponibilités notées', valeur: (j) => j.preferences },
  { cle: 'adresse', label: () => 'Adresse', valeur: (j, d) => d.address },
  { cle: 'tel',     label: () => 'Téléphone', valeur: (j, d) => d.phone },
  { cle: 'reste',   label: () => 'Ce qu\'il reste à faire', valeur: (j, d) => d.todo, aide: 'note interne, décochée d\'office' },
  { cle: 'contact', label: () => '« Répondez à ce mail pour toute question »', valeur: () => 'oui' }
];

// Les informations qu'on oublie le plus souvent de donner
const PHRASES = [
  'Merci de nous confirmer votre présence à cette date.',
  'Merci de nous indiquer vos disponibilités.',
  'Notre technicien vous appellera avant son passage.',
  'Merci de prévoir un accès dégagé à la zone d\'intervention.',
  'Pourriez-vous nous envoyer une photo du problème en réponse à ce mail ?',
  'Le nécessaire est en commande : nous revenons vers vous dès sa réception.'
];

let mailOpts = null;        // { modele, blocs: Set, phrases: Set, ajout, changes: Set } du mail déplié

function optsParDefaut(modele, j = null, d = null) {
  const ch = j && d ? changements(j, d) : [];
  return { modele, blocs: new Set(MODELES[modele].blocs), phrases: new Set(), ajout: '',
           changes: new Set(ch.filter((c) => c.coche).map((c) => c.cle)), docs: new Set(), liens: {} };
}

// ---------------------------------------------------------------------
// Ce qui a changé depuis le dernier mail
// ---------------------------------------------------------------------
// Le fil du dossier note chaque changement d'étape, de date et de
// référence (déclencheur client_jobs_fil), avec la fiche concernée. Le
// dernier « Mail récapitulatif préparé » de la fiche sert de repère : ce
// qui est écrit après, le client ne le sait pas encore.
const NOTE_MAIL = 'Mail récapitulatif préparé';
const NOTES_INTERNES = /^(Mail récapitulatif préparé|À traiter :|Traité|Pas traité)/;

function dernierMail(j) {
  return notes.filter((n) => n.job_id === j.id && String(n.body).startsWith(NOTE_MAIL))
    .map((n) => n.created_at).sort().pop() || null;
}

/** La date d'avant, lue dans « déplacée du A au B » ou « retirée (était le A) » */
function dateAvant(body) {
  const m = String(body).match(/(?:déplacée? du|était le) (\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Les changements à annoncer, chacun avec sa phrase pour le client.
 * Plusieurs changements du même genre n'en font qu'un : le client veut
 * savoir où on en est, pas par où on est passé.
 */
function changements(j, d) {
  const depuis = dernierMail(j);
  const apres = notes.filter((n) => (!depuis || n.created_at > depuis) && !String(n.body).startsWith(NOTE_MAIL))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const auto = apres.filter((n) => n.automatique && n.job_id === j.id);
  const le = (iso) => longDate(String(iso).slice(0, 10));
  const pose = j.kind === 'pose';
  const out = [];

  const etapes = auto.filter((n) => /^(SAV|Pose|Mesurage|Demande) : .+ → /.test(n.body));
  const dateNotes = (mot) => auto.filter((n) => String(n.body).startsWith(mot + ' '));
  const interv = j.kind === 'mesure' ? dateNotes('Mesurage').filter((n) => !/^Mesurage : /.test(n.body)) : dateNotes('Intervention');
  const livr = dateNotes('Livraison');
  const posee = dateNotes('Pose').filter((n) => !/^Pose : /.test(n.body));
  // Une date fixée pour la première fois, en même temps que l'étape
  // « planifié », se dit en une phrase : celle de l'étape.
  const dateDejaDite = (liste, valeur) => liste.length && !dateAvant(liste[0].body) && valeur
    && etapes.length && ['planifie', 'planifiee'].includes(j.status);

  if (etapes.length) {
    const ancien = String(etapes[0].body).split(' : ')[1].split(' → ')[0];
    const parSorte = {
      'mesure:planifiee': j.intervention_date ? `Le mesurage est planifié le ${le(j.intervention_date)}.` : 'Le mesurage va être planifié : nous vous communiquerons la date très prochainement.',
      'mesure:faite': 'Le mesurage a été effectué. Merci pour votre accueil.',
      'mesure:a_planifier': 'La date du mesurage reste à fixer : nous vous la communiquerons prochainement.',
      'demande:en_cours': 'Votre demande est en cours de traitement.',
      'demande:traitee': 'Votre demande a été traitée.',
      'demande:a_traiter': 'Votre demande est de nouveau en cours : nous revenons vers vous rapidement.'
    };
    const phrase = parSorte[`${j.kind}:${j.status}`] || {
      commande: `La pièce nécessaire a été commandée${j.order_ref ? ` (référence ${j.order_ref})` : ''}. Nous vous recontacterons dès sa réception pour fixer une date d'intervention.`,
      recu: 'Bonne nouvelle : la pièce est arrivée au magasin. Il nous reste à convenir avec vous d\'une date d\'intervention.',
      planifie: j.intervention_date ? `Votre intervention est planifiée le ${le(j.intervention_date)}.` : 'Votre intervention va être planifiée : nous vous communiquerons la date très prochainement.',
      cloture: 'Votre dossier de service après-vente est à présent clôturé. Merci pour votre confiance.',
      a_traiter: 'Votre demande est de nouveau en cours de traitement : nous revenons vers vous rapidement.',
      nouvelle_intervention: 'Une nouvelle intervention est nécessaire : nous revenons vers vous pour l\'organiser.',
      planifiee: j.pose_date ? `Votre pose est planifiée le ${le(j.pose_date)}.` : 'Votre pose va être planifiée.',
      a_planifier: 'La date de votre pose reste à fixer : nous vous la communiquerons prochainement.',
      terminee: 'La pose est terminée. Merci pour votre confiance.',
      sav: 'La pose est terminée ; un point reste à régler : nous revenons vers vous pour l\'organiser.'
    }[j.status];
    if (phrase && ETATS[j.kind]?.[j.status]?.label !== ancien) {
      out.push({ cle: 'etape', label: `Étape : ${ancien} → ${etat(j).label}`, phrase, coche: true });
    }
  }
  const dateChange = (liste, valeur, cle, quoi, nom) => {
    if (!liste.length || dateDejaDite(liste, valeur)) return;
    const avant = dateAvant(liste[0].body);
    if (avant && valeur === avant) return;               // revenue à la date d'origine
    const phrase = !valeur
      ? `La date ${nom} prévue le ${le(avant)} est annulée : nous vous recontacterons pour en fixer une nouvelle.`
      : avant ? `La date ${nom} est modifiée : ${quoi} aura lieu le ${le(valeur)} (au lieu du ${le(avant)}).`
      : `${quoi[0].toUpperCase() + quoi.slice(1)} est fixé${quoi.startsWith('le ') ? '' : 'e'} au ${le(valeur)}.`;
    out.push({ cle, label: `${{ 'd\'intervention': 'Intervention', 'de livraison': 'Livraison', 'du mesurage': 'Mesurage' }[nom] || 'Pose'} : ${valeur ? fmtDate(valeur) : 'date retirée'}${avant ? ` (était le ${fmtDate(avant)})` : ''}`, phrase, coche: true });
  };
  if (pose) {
    dateChange(livr, j.delivery_date, 'livraison', 'la livraison', 'de livraison');
    dateChange(posee, j.pose_date, 'pose', 'la pose', 'de pose');
  } else if (j.kind === 'mesure') {
    dateChange(interv, j.intervention_date, 'intervention', 'le mesurage', 'du mesurage');
  } else {
    dateChange(interv, j.intervention_date, 'intervention', 'l\'intervention', 'd\'intervention');
  }
  if (auto.some((n) => String(n.body).startsWith('Référence de commande')) && j.order_ref && !out.some((c) => c.cle === 'etape' && j.status === 'commande')) {
    out.push({ cle: 'ref', label: `Référence de commande : ${j.order_ref}`, phrase: `Votre référence de commande : ${j.order_ref}.`, coche: true });
  }
  // Les notes écrites à la main : souvent internes, donc à cocher exprès
  apres.filter((n) => !n.automatique && (!n.job_id || n.job_id === j.id) && !NOTES_INTERNES.test(n.body))
    .forEach((n) => out.push({ cle: `note:${n.id}`, label: `Note : ${n.body}`, phrase: n.body, coche: false, note: true }));
  return out;
}

/** La sorte de mail qui convient : une mise à jour dès qu'il y a du neuf */
function modeleProbable(j) {
  const ch = changements(j, dossiers.find((x) => x.id === ouvert) || {});
  if (!ch.some((c) => !c.note)) return 'confirmation';
  if (dernierMail(j)) return 'maj';
  // Sans mail précédent, ce qui a été réglé le jour même de la création
  // fait partie de la confirmation.
  const jour = String(j.created_at || '').slice(0, 10);
  const tard = notes.some((n) => n.automatique && n.job_id === j.id && String(n.created_at).slice(0, 10) > jour);
  return tard ? 'maj' : 'confirmation';
}

/** Où en est la date : ce qu'on peut en dire au client */
function phraseDate(j) {
  const le = (iso) => longDate(String(iso).slice(0, 10));
  if (j.kind === 'mesure') {
    if (j.status === 'faite') return ['Le mesurage a été effectué. Merci pour votre accueil.'];
    return [j.intervention_date ? `Le mesurage est planifié le ${le(j.intervention_date)}.`
      : 'La date du mesurage vous sera communiquée prochainement.'];
  }
  if (j.kind === 'demande') {
    return j.status === 'traitee' ? ['Votre demande a été traitée.'] : [];
  }
  if (j.kind === 'pose') {
    return [
      j.delivery_date ? `Livraison prévue le ${le(j.delivery_date)}.` : '',
      j.pose_date ? `La pose est planifiée le ${le(j.pose_date)}.` : 'La date de pose vous sera communiquée prochainement.'
    ].filter(Boolean);
  }
  if (j.intervention_date && !['cloture', 'nouvelle_intervention'].includes(j.status)) {
    return [`Notre intervention est planifiée le ${le(j.intervention_date)}.`];
  }
  if (j.status === 'commande') return ['Le nécessaire a été commandé. Nous vous recontacterons dès sa réception pour fixer la date d\'intervention.'];
  if (j.status === 'recu') return ['Le nécessaire est arrivé au magasin. La date d\'intervention vous sera communiquée très prochainement.'];
  if (j.status === 'cloture') return ['Ce dossier de service après-vente est à présent clôturé.'];
  return ['La date d\'intervention vous sera communiquée plus tard.'];
}

function texteMail(j, d, o = optsParDefaut('confirmation')) {
  const pose = j.kind === 'pose';
  const a = (cle) => o.blocs.has(cle) && String(BLOCS.find((b) => b.cle === cle).valeur(j, d) || '').trim();
  const quoi = { pose: 'dossier de pose', sav: 'demande de service après-vente', mesure: 'demande de mesurage', demande: 'demande' }[j.kind];
  const lignes = [`Bonjour${d.name ? ` ${d.name}` : ''},`, ''];

  if (o.modele === 'maj') {
    lignes.push(`Nous revenons vers vous au sujet de votre ${quoi}${j.title ? ` (${j.title})` : ''} pour vous informer de son avancement.`);
  } else if (o.modele === 'confirmation') {
    const quand = j.created_at ? ` du ${fmtDate(String(j.created_at).slice(0, 10))}` : '';
    const fin = `nous vous confirmons que votre ${quoi} est bien enregistré${pose ? '' : 'e'}.`;
    lignes.push(j.source && ORIGINE[j.source] ? `Suite à ${ORIGINE[j.source]}${quand}, ${fin}` : fin[0].toUpperCase() + fin.slice(1));
  } else {
    lignes.push(`Nous revenons vers vous au sujet de votre ${quoi}${o.modele === 'date' ? ' pour vous communiquer la date prévue' : ''}.`);
  }

  const details = [];
  if (a('demande') && !(o.modele === 'maj' && j.title)) details.push(`${pose ? 'Objet' : j.kind === 'mesure' ? 'À mesurer' : 'Demande'} : ${j.title}`);
  if (a('infos')) details.push(`Informations notées : ${j.remarks}`);
  if (a('ref')) details.push(`Référence de commande : ${j.order_ref}`);
  if (a('reste')) details.push(`Prochaine étape : ${d.todo}`);
  if (a('prefs')) details.push(`Vos disponibilités notées : ${j.preferences}`);
  if (details.length) lignes.push('', ...details);

  if (o.modele === 'maj') {
    const ch = changements(j, d).filter((c) => o.changes.has(c.cle)).map((c) => c.phrase);
    lignes.push('', ...(ch.length ? ch : ['Votre dossier suit son cours : nous revenons vers vous dès qu\'il y a du nouveau.']));
  }
  if (o.blocs.has('dates')) lignes.push('', ...phraseDate(j));

  const ajouts = [...PHRASES.filter((x) => o.phrases.has(x)), ...(o.ajout.trim() ? [o.ajout.trim()] : [])];
  if (ajouts.length) lignes.push('', ...ajouts);

  const joints = documents.filter((x) => o.docs?.has(x.id) && o.liens?.[x.id]);
  if (joints.length) {
    lignes.push('', joints.length > 1 ? 'Vous trouverez les documents ici (liens valables 30 jours) :' : 'Vous trouverez le document ici (lien valable 30 jours) :');
    joints.forEach((x) => lignes.push(`- ${x.name} : ${o.liens[x.id]}`));
  }

  if (a('adresse') || a('tel')) {
    lignes.push('', 'Merci de vérifier vos coordonnées :');
    if (a('adresse')) lignes.push(`Adresse : ${d.address}`);
    if (a('tel')) lignes.push(`Téléphone : ${d.phone}`);
  }
  if (o.blocs.has('contact')) lignes.push('', 'Pour toute question, il vous suffit de répondre à ce mail.');
  lignes.push('', 'Bien cordialement,', displayName() ? `${displayName()} — ${MAGASIN}` : MAGASIN);
  return lignes.join('\n');
}

function objetMail(j, modele = 'confirmation') {
  const dossier = { pose: 'de pose', sav: 'SAV', mesure: 'de mesurage', demande: '' }[j.kind] ?? '';
  if (modele === 'maj') return `Suivi de votre dossier${dossier ? ` ${dossier}` : ''} — ${MAGASIN}`;
  if (modele === 'date') return `${{ pose: 'Date de pose', mesure: 'Date du mesurage' }[j.kind] || 'Date d\'intervention'} — ${MAGASIN}`;
  return `Votre dossier${dossier ? ` ${dossier}` : ''} — ${MAGASIN}`;
}

/** mailto : les fins de ligne en CRLF, comme le veut la norme */
const lienMail = (a, objet, corps) => `mailto:${encodeURIComponent(a || '')}`
  + `?subject=${encodeURIComponent(objet)}&body=${encodeURIComponent(corps.replace(/\r?\n/g, '\r\n'))}`;

function formMailHtml(j, d) {
  if (!d.email) {
    return `
      <div class="cl-suite cl-mail">
        <p class="small"><strong>Mail au client</strong><br>
          <span class="muted">Ajoute d'abord l'e-mail du client, en haut du dossier.</span></p>
        <div class="cl-actions">
          <button type="button" class="btn btn-sm" data-mail-email>Saisir l'e-mail</button>
          <button type="button" class="btn btn-ghost btn-sm" data-mail-fermer>Fermer</button>
        </div>
      </div>`;
  }
  const o = mailOpts || (mailOpts = optsParDefaut(modeleProbable(j), j, d));
  const ch = changements(j, d);
  const depuis = dernierMail(j);
  const objet = objetMail(j, o.modele);
  const corps = texteMail(j, d, o);
  const blocs = BLOCS.filter((b) => String(b.valeur(j, d) || '').trim());
  return `
    <div class="cl-suite cl-mail" data-mail-fiche="${j.id}">
      <p class="small"><strong>Mail à ${escapeHtml(d.email)}</strong></p>

      <div class="cl-choix" role="group" aria-label="Sorte de mail">
        ${Object.entries(MODELES).map(([k, m]) => `<button type="button" class="${k === o.modele ? 'active' : ''}" data-mail-modele="${k}">${m.label}</button>`).join('')}
      </div>

      ${o.modele === 'maj' ? `
      <fieldset class="cl-mail-cases cl-mail-changes">
        <legend>Ce qui a changé ${depuis ? `depuis le dernier mail (${escapeHtml(fmtDate(String(depuis).slice(0, 10)))})` : 'depuis la création de la fiche'}</legend>
        ${ch.length ? ch.map((c) => `
          <label class="cl-case">
            <input type="checkbox" data-mail-change="${escapeHtml(c.cle)}" ${o.changes.has(c.cle) ? 'checked' : ''}>
            <span><strong>${escapeHtml(c.label.slice(0, 140))}</strong>
              ${c.note ? '<em class="cl-aide">note du dossier : à cocher si elle est pour le client</em>' : ''}</span>
          </label>`).join('') : '<p class="muted small">Rien de neuf dans le fil depuis. Écris ci-dessous ce que tu veux annoncer.</p>'}
      </fieldset>` : ''}

      <fieldset class="cl-mail-cases">
        <legend>Ce que le mail reprend de la fiche</legend>
        ${blocs.map((b) => `
          <label class="cl-case">
            <input type="checkbox" data-mail-bloc="${b.cle}" ${o.blocs.has(b.cle) ? 'checked' : ''}>
            <span><strong>${escapeHtml(b.label(j))}</strong>${b.cle === 'contact' ? '' : ` <span class="muted">${escapeHtml(String(b.valeur(j, d)).slice(0, 90))}</span>`}
              ${b.aide ? `<em class="cl-aide">${escapeHtml(b.aide)}</em>` : ''}</span>
          </label>`).join('')}
      </fieldset>

      ${'todo_due' in d ? `
      <fieldset class="cl-mail-cases">
        <legend>Documents à joindre</legend>
        ${documents.map((x) => `
          <label class="cl-case">
            <input type="checkbox" data-mail-doc="${x.id}" ${o.docs.has(x.id) ? 'checked' : ''}>
            <span><strong>${escapeHtml(x.name)}</strong> <span class="muted">${escapeHtml(x.created_name || '')}</span></span>
          </label>`).join('') || '<p class="muted small">Aucun document dans ce dossier.</p>'}
        <div class="cl-actions">
          <button type="button" class="btn btn-sm" data-mail-doc-ajouter>+ Ajouter un document</button>
        </div>
        <p class="muted small">Chaque document coché part sous forme de lien de téléchargement, valable 30 jours.${
          peutPartager() ? ' Sur téléphone, « Partager avec les pièces jointes » les joint vraiment au mail.' : ''}</p>
      </fieldset>` : ''}

      <fieldset class="cl-mail-cases">
        <legend>Informations utiles à ajouter</legend>
        <div class="cl-phrases">
          ${PHRASES.map((x, i) => `<button type="button" class="cl-phrase ${o.phrases.has(x) ? 'active' : ''}" data-mail-phrase="${i}">${o.phrases.has(x) ? '✓ ' : '+ '}${escapeHtml(x)}</button>`).join('')}
        </div>
        <textarea rows="2" data-mail-ajout placeholder="Autre chose à dire au client : horaire, consigne, rappel…">${escapeHtml(o.ajout)}</textarea>
      </fieldset>

      <p class="small muted">Le mail, tel qu'il partira. Tu peux encore le retoucher ici, en dernier : changer une case ci-dessus le réécrit.</p>
      <input type="text" class="search" data-mail-objet value="${escapeHtml(objet)}" aria-label="Objet du mail">
      <textarea rows="14" data-mail-corps aria-label="Texte du mail">${escapeHtml(corps)}</textarea>
      <div class="cl-actions">
        <a class="btn btn-primary btn-sm" data-mail-envoyer href="${escapeHtml(lienMail(d.email, objet, corps))}">✉ Ouvrir dans ma messagerie</a>
        ${peutPartager() && o.docs.size ? '<button type="button" class="btn btn-sm" data-mail-partager>📎 Partager avec les pièces jointes</button>' : ''}
        <button type="button" class="btn btn-sm" data-mail-copier>Copier le texte</button>
        <button type="button" class="btn btn-ghost btn-sm" data-mail-fermer>Fermer</button>
      </div>
    </div>`;
}

/**
 * Le bouton du mail se fait remarquer quand la fiche a bougé depuis le
 * dernier mail : le client n'est pas encore au courant.
 */
function boutonMail(j, d) {
  const neuf = d.email && modeleProbable(j) === 'maj';
  return neuf
    ? `<button type="button" class="btn btn-sm cl-prevenir" data-mail="${j.id}">✉ Prévenir le client du changement</button>`
    : `<button type="button" class="btn btn-sm" data-mail="${j.id}">✉ Mail au client</button>`;
}

// Ce que dit le champ « objet » de chaque sorte de fiche
const OBJET = {
  pose:    { label: 'Objet (facultatif)', aide: 'Cuisine complète, plan de travail…' },
  sav:     { label: 'Problème', aide: 'Porte abîmée, pièce manquante…' },
  mesure:  { label: 'À mesurer', aide: 'Cuisine, îlot, salle de bain…' },
  demande: { label: 'Demande', aide: 'Devis, renseignement, rappel…' }
};
const BOUTON_FIN = { pose: 'Pose terminée', sav: 'Clôturer le SAV', mesure: 'Mesurage fait', demande: 'Demande traitée' };

/** « créée par Bob Tilkin le 04/11/2026 · modifiée par Marie » */
function quiHtml(o, genre = 'e') {
  const parts = [];
  if (o.created_name) parts.push(`créé${genre} par ${escapeHtml(o.created_name)}${o.created_at ? ` le ${escapeHtml(fmtDate(String(o.created_at).slice(0, 10)))}` : ''}`);
  if (o.updated_name) parts.push(`modifié${genre} par ${escapeHtml(o.updated_name)}${o.updated_at ? ` le ${escapeHtml(fmtDate(String(o.updated_at).slice(0, 10)))}` : ''}`);
  return parts.length ? `<p class="cl-qui muted small">${parts.join(' · ')}</p>` : '';
}

function ficheHtml(j, d) {
  const e = etat(j);
  const k = j.kind;
  const pose = k === 'pose';
  const parent = j.parent_id ? d.jobs.find((x) => x.id === j.parent_id) : null;

  // Une fiche terminée reste entièrement modifiable : on corrige une
  // date ou une remarque après coup sans devoir la rouvrir.
  const close = finie(j);
  const avecSuite = ['sav', 'nouvelle_intervention'].includes(j.status);
  const etapes = ETAPES[k];
  const objet = OBJET[k] || OBJET.demande;

  return `
    <div class="cl-fiche ${k}${close ? ' finie' : ''}" data-fiche="${j.id}">
      <div class="cl-fiche-haut">
        <span class="cl-type">${SORTES[k] || k}</span>
        <span class="badge ${e.cls}">${escapeHtml(e.label)}</span>
        ${close && j.closed_at ? `<span class="muted small">terminée le ${escapeHtml(fmtDate(String(j.closed_at).slice(0, 10)))}</span>` : ''}
        ${j.source && SOURCES[j.source] ? `<span class="muted small">signalé par ${SOURCES[j.source].toLowerCase()}</span>` : ''}
        ${parent ? `<span class="muted small">suite de : ${parent.kind === 'pose' ? 'la pose' : 'SAV'}${parent.title ? ` « ${escapeHtml(parent.title)} »` : ''}</span>` : ''}
      </div>
      ${quiHtml(j)}

      ${!etapes || close ? '' : `
        <div class="cl-etapes" role="group" aria-label="Étape">
          ${etapes.map((s) => `
            <button type="button" class="${s === j.status ? 'active' : ''} ${etapes.indexOf(s) < etapes.indexOf(j.status) ? 'passee' : ''}"
              data-etape="${s}" data-job="${j.id}">${ETATS[k][s].label}</button>`).join('')}
        </div>`}

      <div class="cl-grille">
        <label class="field col-2"><span class="sub">${objet.label}</span>
          <input type="text" data-champ-fiche="title" data-job="${j.id}" value="${escapeHtml(j.title || '')}"
                 placeholder="${objet.aide}"></label>
        ${pose ? `
          <label class="field"><span class="sub">Livraison</span>
            <input type="date" data-champ-fiche="delivery_date" data-job="${j.id}" value="${j.delivery_date || ''}"></label>
          <label class="field"><span class="sub">Pose</span>
            <input type="date" data-champ-fiche="pose_date" data-job="${j.id}" value="${j.pose_date || ''}"></label>` : ''}
        ${k === 'sav' ? `
          <label class="field"><span class="sub">Référence de commande</span>
            <input type="text" data-champ-fiche="order_ref" data-job="${j.id}" value="${escapeHtml(j.order_ref || '')}"></label>
          <label class="field"><span class="sub">Date d'intervention</span>
            <input type="date" data-champ-fiche="intervention_date" data-job="${j.id}" value="${j.intervention_date || ''}"></label>` : ''}
        ${k === 'mesure' ? `
          <label class="field"><span class="sub">Date du mesurage</span>
            <input type="date" data-champ-fiche="intervention_date" data-job="${j.id}" value="${j.intervention_date || ''}"></label>` : ''}
        <label class="field col-2"><span class="sub">Disponibilités du client</span>
          <textarea rows="2" data-champ-fiche="preferences" data-job="${j.id}"
            placeholder="Quand le client est joignable, quand on peut passer : le mardi après 17 h, pas le vendredi…">${escapeHtml(j.preferences || '')}</textarea></label>
        <label class="field col-2"><span class="sub">Remarques</span>
          <textarea rows="2" data-champ-fiche="remarks" data-job="${j.id}"
            placeholder="Tout ce qui est utile : accès, pièce en stock, à rappeler…">${escapeHtml(j.remarks || '')}</textarea></label>
      </div>

      ${courriel === j.id ? formMailHtml(j, d) : ''}
      ${close ? `
        <div class="cl-actions">
          ${courriel === j.id ? '' : boutonMail(j, d)}
          ${avecSuite
            ? '<span class="muted small">La suite est dans la fiche SAV qui en est issue.</span>'
            : `<button type="button" class="btn btn-sm" data-rouvrir="${j.id}">Rouvrir la fiche</button>`}
          ${isManager() ? `<button type="button" class="btn btn-ghost btn-sm" data-suppr-fiche="${j.id}">Supprimer la fiche</button>` : ''}
        </div>` : suite === j.id ? formSuiteHtml(j) : `
        <div class="cl-actions">
          <button type="button" class="btn btn-sm cl-ok" data-cloturer="${j.id}">✓ ${BOUTON_FIN[k] || 'Terminer'}</button>
          ${['pose', 'sav'].includes(k) ? `<button type="button" class="btn btn-sm cl-sav" data-suite="${j.id}">${pose ? '⚠ Ouvrir un SAV' : '↻ Nouvelle intervention'}</button>` : ''}
          ${courriel === j.id ? '' : boutonMail(j, d)}
          ${isManager() ? `<button type="button" class="btn btn-ghost btn-sm" data-suppr-fiche="${j.id}">Supprimer la fiche</button>` : ''}
        </div>`}
    </div>`;
}

function noteHtml(n) {
  const quand = String(n.created_at).slice(0, 16).replace('T', ' à ');
  return `
    <li class="cl-note ${n.automatique ? 'auto' : ''}${n.annule_le ? ' annulee' : ''}">
      <span class="cl-note-meta">${escapeHtml(n.author_name || '—')} · ${escapeHtml(quand)}${
        n.annule_le ? ` · annulé par ${escapeHtml(n.annule_par || '—')}` : ''}${
        n.work_kind && !n.annule_le && 'avant' in n ? ` · <button type="button" class="cl-note-annuler" data-travail-annuler="${n.id}">Annuler</button>` : ''}</span>
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

/**
 * Le relais dans un dossier. Jordan confie, Marie répond, Jordan classe.
 * Chacun peut faire chaque geste : si Jordan a lui-même réglé la chose, il
 * la marque traitée sans attendre.
 */
function relaisHtml(d) {
  if (!relaisActif()) return '';
  const quand = d.relais_le ? fmtDate(String(d.relais_le).slice(0, 10)) : '';
  // Qui a confié peut retirer ou classer ; le gérant aussi, toujours.
  const maitre = d.relais_de === moi() || isManager();
  if (d.relais === 'a_traiter') {
    const pourToi = d.relais_pour === moi();
    return `
      <div class="card pad cl-bloc cl-relais attente${d.relais_urgent ? ' urgent' : ''}">
        <p class="cl-relais-titre">
          ${d.relais_urgent ? '<span class="badge st-red cl-urgent">URGENT</span>' : ''}
          <strong>${pourToi ? 'À traiter pour toi' : `Confié à ${escapeHtml(d.relais_pour_name || '—')}`}</strong>
          <span class="muted small">par ${escapeHtml(d.relais_de_name || '—')}${quand ? ` · ${escapeHtml(quand)}` : ''}</span></p>
        <p class="cl-consigne">${escapeHtml(d.relais_consigne || '')}</p>
        <textarea id="relais-texte" rows="2" placeholder="${pourToi ? 'Ta réponse : ce que tu as fait, ou pourquoi ce n\'est pas fait' : 'Un mot (facultatif)'}"></textarea>
        <div class="cl-actions">
          <button type="button" class="btn btn-sm cl-ok" data-relais="traite">✓ Traité</button>
          <button type="button" class="btn btn-sm cl-sav" data-relais="non_traite">✗ Pas traité</button>
          ${maitre ? '<button type="button" class="btn btn-ghost btn-sm" data-relais="classe">Retirer</button>' : ''}
        </div>
      </div>`;
  }
  if (d.relais) {
    const fait = d.relais === 'traite';
    return `
      <div class="card pad cl-bloc cl-relais ${fait ? 'fait' : 'pas-fait'}">
        <p class="cl-relais-titre"><strong>${fait ? '✓ Traité' : '✗ Pas traité'}</strong>
          <span class="muted small">par ${escapeHtml(d.relais_par_name || '—')}${quand ? ` · ${escapeHtml(quand)}` : ''}</span></p>
        <p class="muted small">Consigne de ${escapeHtml(d.relais_de_name || '—')} : ${escapeHtml(d.relais_consigne || '')}</p>
        ${d.relais_reponse ? `<p class="cl-consigne">« ${escapeHtml(d.relais_reponse)} »</p>` : ''}
        ${maitre ? `
          <textarea id="relais-texte" rows="2" placeholder="Nouvelle consigne, si tu le renvoies"></textarea>
          <div class="cl-actions">
            <button type="button" class="btn btn-sm cl-ok" data-relais="classe">Vu, classer</button>
            <button type="button" class="btn btn-sm" data-relais="a_traiter" data-pour="${d.relais_pour || ''}">Renvoyer à ${escapeHtml(d.relais_pour_name || '—')}</button>
          </div>` : `<p class="muted small">En attente de lecture par ${escapeHtml(d.relais_de_name || '—')}.</p>`}
      </div>`;
  }
  // Rien en cours : n'importe qui confie le dossier à un collègue
  const gens = collegues();
  if (!gens.length) return '';
  // Le bureau confie d'abord à la secrétaire ; un vendeur, au gérant
  const defaut = (isSeller() ? gens.find((p) => p.role === 'manager') : gens.find((p) => p.role === 'secretary')) || gens[0];
  return `
    <div class="card pad cl-bloc cl-relais">
      <p class="cl-relais-titre"><strong>Confier ce dossier</strong>
        <span class="muted small">à un collègue, avec une consigne</span></p>
      <textarea id="relais-texte" rows="2" placeholder="Ce qu'il faut faire. Laissé vide : « ce qu'il reste à faire » ci-dessus"></textarea>
      <div class="cl-actions">
        <select id="relais-pour" aria-label="Confier à">
          ${gens.map((p) => `<option value="${p.id}" ${p.id === defaut.id ? 'selected' : ''}>${escapeHtml(nomPersonne(p))}</option>`).join('')}
        </select>
        <label class="cl-case cl-case-urgent"><input type="checkbox" id="relais-urgent"><span><strong>Urgent</strong></span></label>
        <button type="button" class="btn btn-sm btn-primary" data-relais="a_traiter">Confier</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// L'échéance, le travail fait, les documents
// ---------------------------------------------------------------------
/** Jours de retard du reste à faire (0 = pas en retard) */
function retard(d) {
  if (!d.todo_due || !String(d.todo || '').trim()) return 0;
  const j = Math.round((Date.parse(todayISO()) - Date.parse(d.todo_due)) / 86400000);
  return j > 0 ? j : 0;
}

/**
 * « Dossier traité » : un geste, une date, un nom. Le reste à faire,
 * son échéance et l'urgence s'effacent ; la carte le dit en vert, pour
 * que personne ne refasse le travail.
 */
const estTraite = (d) => d.last_work?.kind === 'traite' && !String(d.todo || '').trim() && !(d.relais === 'a_traiter');
function traiteHtml(d) {
  if (estTraite(d)) {
    return `<div class="cl-traite-ok">
      <span>✓ ${escapeHtml(String(d.last_work.body).replace(/^✓\s*/, ''))} — ${escapeHtml(d.last_work.author_name || '')}</span>
      ${'id' in d.last_work ? `<button type="button" class="btn btn-sm btn-ghost" data-traite-annuler="${d.id}">Annuler</button>` : ''}
    </div>`;
  }
  return `<button type="button" class="btn cl-ok cl-traite-btn" data-traite="${d.id}">✓ Dossier traité</button>`;
}

let signalement = false;    // le formulaire « Signaler un problème » est-il déplié ?

/**
 * La barre d'actions du dossier : traité, problème, clôturer — en haut,
 * là où le regard tombe en ouvrant le dossier.
 */
function actionsHtml(d) {
  if (!('probleme' in d)) return '';                 // avant la migration 0044
  if (d.closed_at) {
    return `
      <div class="cl-clos">
        <span>🔒 Dossier clôturé le ${escapeHtml(fmtDate(String(d.closed_at).slice(0, 10)))}${d.closed_name ? ` par ${escapeHtml(d.closed_name)}` : ''}</span>
        <button type="button" class="btn btn-sm" data-dossier-rouvrir="${d.id}">Rouvrir le dossier</button>
      </div>`;
  }
  return `
    ${d.probleme ? `
      <div class="cl-probleme">
        <div><strong>⚠ Problème</strong> <span class="small">signalé par ${escapeHtml(d.probleme_par || '—')}${d.probleme_le ? ` le ${escapeHtml(fmtDate(String(d.probleme_le).slice(0, 10)))}` : ''}</span>
          <p>${escapeHtml(d.probleme)}</p></div>
        <div class="cl-actions">
          <button type="button" class="btn btn-sm" data-probleme-ouvrir>Modifier</button>
          <button type="button" class="btn btn-sm cl-ok" data-probleme-resolu>✓ Problème résolu</button>
        </div>
      </div>` : ''}
    ${signalement ? `
      <div class="card pad cl-bloc cl-signaler">
        <label class="field"><span class="sub"><strong>Quel est le problème ?</strong></span>
          <textarea id="probleme-texte" rows="2" placeholder="Ex. : le client conteste la facture, pièce livrée cassée, attention chien…">${escapeHtml(d.probleme || '')}</textarea></label>
        <div class="cl-actions">
          <button type="button" class="btn btn-sm btn-primary" data-probleme-ok>Enregistrer</button>
          <button type="button" class="btn btn-sm btn-ghost" data-probleme-annuler>Annuler</button>
        </div>
      </div>` : ''}
    <div class="cl-barre">
      ${'todo_due' in d ? traiteHtml(d) : ''}
      ${d.probleme || signalement ? '' : '<button type="button" class="btn cl-sav" data-probleme-ouvrir>⚠ Signaler un problème</button>'}
      <button type="button" class="btn" data-dossier-cloturer="${d.id}">🔒 Clôturer le dossier</button>
    </div>`;
}

const TRAVAUX = { mail: 'Mail envoyé', appel: 'Client appelé', devis: 'Devis envoyé', commande: 'Commande passée', rdv: 'Rendez-vous fixé', visite: 'Passage chez le client', autre: 'Autre' };

function travailHtml(d) {
  if (!('todo_due' in d)) return '';           // avant la migration 0043
  return `
    <div class="card pad cl-bloc cl-travail">
      <p class="cl-relais-titre"><strong>Noter un travail fait</strong>
        <span class="muted small">avec sa date : on sait qui a fait quoi, et quand</span></p>
      <div class="cl-phrases" role="group" aria-label="Ce qui a été fait">
        ${Object.entries(TRAVAUX).map(([k, l]) => `<button type="button" class="cl-phrase ${k === travailKind ? 'active' : ''}" data-travail-kind="${k}">${l}</button>`).join('')}
      </div>
      <div class="cl-travail-ligne">
        <label class="field"><span class="sub">Le</span>
          <input type="date" id="travail-date" value="${todayISO()}" max="${todayISO()}"></label>
        <label class="field cl-travail-texte"><span class="sub">Précision (facultatif)</span>
          <input type="text" id="travail-texte" placeholder="Ex. : devis complémentaire envoyé, client absent…"></label>
      </div>
      <div class="cl-actions">
        ${String(d.todo || '').trim() ? '<label class="cl-case"><input type="checkbox" id="travail-fini"><span>Le reste à faire est terminé</span></label>' : ''}
        <button type="button" class="btn btn-sm btn-primary" data-travail>Enregistrer</button>
      </div>
    </div>`;
}

function documentsHtml(d) {
  if (!('todo_due' in d)) return '';
  return `
    <div class="cl-section-tete">
      <h2>Documents</h2>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" data-doc-ajouter>+ Ajouter un document</button>
    </div>
    <div class="card pad cl-bloc">
      ${documents.length ? `<ul class="cl-docs">${documents.map((x) => `
        <li>
          <button type="button" class="cl-doc-nom" data-doc-ouvrir="${x.id}">📄 ${escapeHtml(x.name)}</button>
          <span class="muted small">${escapeHtml(x.created_name || '')} · ${escapeHtml(fmtDate(String(x.created_at).slice(0, 10)))}</span>
          ${isManager() ? `<button type="button" class="btn btn-ghost btn-sm" data-doc-suppr="${x.id}">Supprimer</button>` : ''}
        </li>`).join('')}</ul>`
        : '<p class="muted small">Devis, plan, photo… Ajoute-les ici : ils pourront être joints au mail du client.</p>'}
    </div>`;
}

function dossierHtml(d) {
  const ouvertes = d.jobs.filter((j) => !finie(j));
  const finies = d.jobs.filter(finie);
  return `
    <div class="cl-retour">
      <button type="button" class="btn btn-sm" data-retour>← Tous les clients</button>
    </div>
    ${actionsHtml(d)}

    <div class="card pad cl-bloc">
      ${d.address ? `<p class="cl-adresse">${escapeHtml(d.address)}</p>` : ''}
      ${contactHtml(d)}
      ${quiHtml(d, '')}
      <div class="cl-grille">
        <label class="field col-2"><span class="sub">Nom du client</span>
          <input type="text" class="cl-nom-champ" data-champ-dossier="name" value="${escapeHtml(d.name)}" required></label>
        ${champ('phone', 'Téléphone', d.phone, 'tel')}
        ${champ('email', 'E-mail', d.email, 'email')}
        <label class="field col-2"><span class="sub">Adresse</span>
          <input type="text" data-champ-dossier="address" value="${escapeHtml(d.address || '')}"></label>
      </div>
    </div>

    <div class="card pad cl-bloc${retard(d) ? ' cl-en-retard' : ''}">
      <label class="field"><span class="sub"><strong>Ce qu'il reste à faire</strong></span>
        <textarea rows="3" data-champ-dossier="todo" placeholder="Ex. : poser les plinthes, régler la porte du frigo…">${escapeHtml(d.todo || '')}</textarea></label>
      ${'todo_due' in d ? `
        <div class="cl-echeance">
          <label class="field"><span class="sub">À faire pour le</span>
            <input type="date" data-champ-dossier="todo_due" value="${d.todo_due || ''}"></label>
          <label class="cl-case cl-case-urgent"><input type="checkbox" data-champ-dossier="todo_urgent" ${d.todo_urgent ? 'checked' : ''}><span><strong>Urgent</strong></span></label>
          ${retard(d) ? `<span class="badge st-red">En retard de ${retard(d)} jour${retard(d) > 1 ? 's' : ''}</span>` : ''}
        </div>` : ''}
    </div>

    ${travailHtml(d)}

    ${relaisHtml(d)}

    <div class="cl-section-tete">
      <h2>Fiches</h2>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" data-nouvelle-fiche="mesure">+ Mesurage</button>
      <button type="button" class="btn btn-sm" data-nouvelle-fiche="pose">+ Pose</button>
      <button type="button" class="btn btn-sm" data-nouvelle-fiche="sav">+ SAV</button>
      <button type="button" class="btn btn-sm" data-nouvelle-fiche="demande">+ Autre demande</button>
    </div>
    ${ouvertes.length ? ouvertes.map((j) => ficheHtml(j, d)).join('')
      : `<div class="card pad"><p class="muted small">${finies.length
          ? 'Tout est terminé pour ce client.'
          : 'Pas encore de fiche. Ajoute un mesurage, une pose, un SAV ou une autre demande.'}</p></div>`}
    ${finies.length ? `
      <button type="button" class="btn btn-ghost btn-sm cl-finies-btn" data-finies>
        ${montrerFinies ? '▾' : '▸'} Fiches terminées (${finies.length})</button>
      ${montrerFinies ? finies.map((j) => ficheHtml(j, d)).join('') : ''}` : ''}

    ${documentsHtml(d)}

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
      if (j.intervention_date) out.push({ ...base, jour: j.intervention_date, quoi: j.kind === 'mesure' ? 'mesure' : 'sav' });
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
    if (ouvert) await Promise.all([chargerNotes(ouvert), chargerDocuments(ouvert)]);
    poserPastille(dossiers.filter(FILTRES[isManager() ? 'reponses' : 'relais'].test).length);
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
  if (typeof valeur === 'boolean') {
    const { error } = await supabase.from('client_files').update({ [cle]: valeur }).eq('id', d.id);
    if (error) { console.error(error); return toast(errorMessage(error, 'Enregistrement impossible.'), 'error'); }
    d[cle] = valeur;
    toast(valeur ? 'Marqué urgent.' : 'Plus urgent.', 'ok', 1400);
    return;
  }
  const v = cle === 'email' ? valeur.trim().toLowerCase() : valeur.trim();
  if (cle === 'name' && !v) { toast('Le nom ne peut pas être vide.', 'error'); return renderClients(); }
  if ((d[cle] || '') === v) return;
  const { error } = await supabase.from('client_files').update({ [cle]: v || null }).eq('id', d.id);
  if (error) { console.error(error); return toast(errorMessage(error, 'Enregistrement impossible.'), 'error'); }
  d[cle] = v || null;
  toast('Enregistré.', 'ok', 1400);
  // L'échéance change le bandeau « en retard »
  if (cle === 'todo_due') await renderClients();
  // Le mail au client attendait cette adresse
  if (cle === 'email' && courriel) await renderClients();
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
  toast({ pose: 'Fiche pose ajoutée.', sav: 'Fiche SAV ajoutée.', mesure: 'Fiche mesurage ajoutée.', demande: 'Demande ajoutée.' }[kind]);
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
  await majFiche(id, { status: FIN[j.kind] },
    { message: { pose: 'Pose clôturée.', sav: 'SAV clôturé.', mesure: 'Mesurage fait.', demande: 'Demande traitée.' }[j.kind] });
}

async function rouvrir(id) {
  const d = dossiers.find((x) => x.id === ouvert);
  const j = d?.jobs.find((x) => x.id === id);
  if (!j) return;
  // La base remet « à planifier » une pose sans date.
  const status = { pose: 'planifiee', mesure: 'planifiee', demande: 'en_cours',
                   sav: j.intervention_date ? 'planifie' : 'a_traiter' }[j.kind];
  await majFiche(id, { status }, { message: 'Fiche rouverte.' });
}

async function relais(etat, pourDonne = null) {
  const d = dossiers.find((x) => x.id === ouvert);
  const texte = $('#relais-texte')?.value.trim() || null;
  const pour = etat === 'a_traiter' ? (pourDonne || $('#relais-pour')?.value || null) : null;
  const urgent = etat === 'a_traiter' ? !!$('#relais-urgent')?.checked : false;
  const r = await rpc('client_relais', {
    p_file: ouvert, p_etat: etat, p_texte: texte, p_pour: pour, p_urgent: urgent
  }, 'Enregistrement impossible.');
  if (!r) return;
  const lui = (equipe || []).find((p) => p.id === pour);
  toast({ a_traiter: `Confié à ${lui ? nomPersonne(lui) : 'un collègue'}${urgent ? ', en urgent' : ''}.`,
          traite: 'Marqué traité.', non_traite: 'Marqué pas traité.', classe: 'Classé.' }[etat]);
  // On a répondu à ce qu'on nous avait confié : retour à la liste, au suivant
  if (d?.relais_pour === moi() && ['traite', 'non_traite'].includes(etat)) {
    ouvert = null; await renderClients(); window.scrollTo(0, 0); return;
  }
  await renderClients();
}

async function confierLot(ids) {
  const pour = $('#lot-pour')?.value;
  const lui = (equipe || []).find((p) => p.id === pour);
  if (!lui) return toast('Choisis à qui confier.', 'error');
  const ok = await confirmDialog(`Confier à ${nomPersonne(lui)} ${ids.length} dossier${ids.length > 1 ? 's' : ''} ?\n`
    + 'Pour chacun, la consigne est son « reste à faire ».', 'Confier');
  if (!ok) return;
  const r = await rpc('client_relais_lot', { p_files: ids, p_pour: pour, p_urgent: false }, 'Envoi impossible.');
  if (!r) return;
  toast(`${r.confies} dossier${r.confies > 1 ? 's' : ''} confié${r.confies > 1 ? 's' : ''} à ${nomPersonne(lui)}.`);
  filtre = 'confies';
  filtreChoisi = true;
  await renderClients();
}

/** Le partage de fichiers (téléphone, Safari) : la vraie pièce jointe */
const peutPartager = () => {
  try { return !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); } catch { return false; }
};

/** Cocher un document : son lien signé entre dans le mail */
async function basculerDocMail(id, coche) {
  if (!mailOpts) return;
  if (!coche) { mailOpts.docs.delete(id); return renderClients(); }
  const doc = documents.find((x) => x.id === id);
  if (!doc) return;
  try {
    mailOpts.liens[id] = mailOpts.liens[id] || await lienSigne(doc);
    mailOpts.docs.add(id);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Lien de téléchargement impossible.'), 'error');
  }
  await renderClients();
}

/** Ajoutés depuis le mail : ils sont cochés d'office */
async function cocherDocsMail(ajoutes) {
  for (const x of ajoutes) await basculerDocMail(x.id, true);
}

async function partagerMail() {
  const zone = $('[data-mail-fiche]');
  if (!zone || !mailOpts) return;
  const choisis = documents.filter((x) => mailOpts.docs.has(x.id));
  try {
    const files = [];
    for (const x of choisis) {
      const { data, error } = await supabase.storage.from('clients').download(x.path);
      if (error) throw error;
      files.push(new File([data], x.name, { type: x.content_type || data.type || 'application/octet-stream' }));
    }
    const d = dossiers.find((y) => y.id === ouvert);
    // Le partage ne sait pas remplir le destinataire : on le copie.
    try { await navigator.clipboard.writeText(d?.email || ''); } catch { /* facultatif */ }
    await navigator.share({ files, title: $('[data-mail-objet]', zone).value, text: $('[data-mail-corps]', zone).value });
    toast(`Choisis « Mail » ; l'adresse ${d?.email || ''} est copiée, colle-la dans « À ».`, 'ok', 6000);
    mailOuvert();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    toast(errorMessage(err, 'Partage impossible : utilise les liens du mail.'), 'error');
  }
}

/** Une case ou une phrase a changé : le mail se réécrit */
function majApercu() {
  const zone = $('[data-mail-fiche]');
  const d = dossiers.find((x) => x.id === ouvert);
  const j = d?.jobs.find((x) => x.id === zone?.dataset.mailFiche);
  if (!zone || !j) return;
  $('[data-mail-corps]', zone).value = texteMail(j, d, mailOpts);
  $('[data-mail-objet]', zone).value = objetMail(j, mailOpts.modele);
  majLienMail();
}

/** Le texte retouché à la main : le lien suit chaque frappe */
function majLienMail() {
  const zone = $('[data-mail-fiche]');
  const d = dossiers.find((x) => x.id === ouvert);
  if (!zone || !d) return;
  $('[data-mail-envoyer]', zone).href = lienMail(d.email, $('[data-mail-objet]', zone).value, $('[data-mail-corps]', zone).value);
}

async function copierMail() {
  const zone = $('[data-mail-fiche]');
  if (!zone) return;
  try {
    await navigator.clipboard.writeText(`${$('[data-mail-objet]', zone).value}\n\n${$('[data-mail-corps]', zone).value}`);
    toast('Texte copié.', 'ok', 1600);
  } catch { toast('Copie impossible : sélectionne le texte à la main.', 'error'); }
}

/**
 * Une trace dans le fil : on ne peut pas savoir si le mail est vraiment
 * parti, seulement qu'il a été préparé — la note le dit tel quel.
 */
async function mailOuvert() {
  const d = dossiers.find((x) => x.id === ouvert);
  const zone = $('[data-mail-fiche]');
  if (!d || !zone) return;
  const job = zone.dataset.mailFiche;
  const { error } = await supabase.rpc('client_note_add', {
    p_file: ouvert, p_body: `Mail récapitulatif préparé pour ${d.email}`, p_job: job
  });
  if (error) console.error(error);
  setTimeout(() => { courriel = null; renderClients(); }, 400);
}

async function marquerTraite(id) {
  const d = dossiers.find((x) => x.id === id);
  const r = await rpc('client_travail', { p_file: id, p_kind: 'traite', p_date: todayISO(), p_texte: null, p_job: null, p_fini: true }, 'Enregistrement impossible.');
  if (!r) return;
  toast(`« ${d?.name || 'Dossier'} » marqué traité.`, 'ok', 6000,
    { label: 'Annuler', onClick: () => annulerTravail(id) });
  await renderClients();
}

async function signalerProbleme(texte) {
  const t = texte.trim();
  if (!t && !dossiers.find((x) => x.id === ouvert)?.probleme) { $('#probleme-texte')?.focus(); return toast('Écris quel est le problème.', 'error'); }
  const r = await rpc('client_probleme', { p_file: ouvert, p_texte: t || null }, 'Enregistrement impossible.');
  if (!r) return;
  signalement = false;
  toast(t ? 'Problème signalé : il s\'affiche sur le dossier et dans la liste.' : 'Problème résolu.', 'ok', 2600);
  await renderClients();
}

async function cloturerDossier(id, rouvrir) {
  const d = dossiers.find((x) => x.id === id);
  if (!rouvrir) {
    const ouvertes = (d?.jobs || []).filter((j) => !finie(j)).length;
    const ok = await confirmDialog(`Clôturer le dossier « ${d?.name || ''} » ?\nIl quitte « En cours » et se range dans « Clôturés » ; on peut le rouvrir à tout moment.`
      + (ouvertes ? `\n\n${ouvertes} fiche${ouvertes > 1 ? 's' : ''} encore ouverte${ouvertes > 1 ? 's' : ''} resteront telles quelles.` : ''), 'Clôturer');
    if (!ok) return;
  }
  const r = await rpc('client_dossier_cloturer', { p_file: id, p_rouvrir: rouvrir }, rouvrir ? 'Réouverture impossible.' : 'Clôture impossible.');
  if (!r) return;
  toast(rouvrir ? 'Dossier rouvert.' : 'Dossier clôturé.', 'ok', 5000,
    rouvrir ? null : { label: 'Annuler', onClick: () => cloturerDossier(id, true) });
  await renderClients();
}

/** Annuler « Dossier traité » (ou un travail noté) : le reste à faire revient tel quel */
async function annulerTravail(fileId, noteId = null) {
  const r = await rpc('client_travail_annuler', { p_file: fileId, p_note: noteId }, 'Annulation impossible.');
  if (!r) return;
  toast(noteId ? 'Travail annulé.' : '« Dossier traité » annulé : le reste à faire est revenu.', 'ok', 2600);
  await renderClients();
}

async function noterTravail() {
  const fini = !!$('#travail-fini')?.checked;
  const r = await rpc('client_travail', {
    p_file: ouvert, p_kind: travailKind, p_date: $('#travail-date')?.value || null,
    p_texte: $('#travail-texte')?.value.trim() || null, p_job: null, p_fini: fini
  }, 'Enregistrement impossible.');
  if (!r) return;
  toast(`${TRAVAUX[travailKind] === 'Autre' ? 'Travail' : TRAVAUX[travailKind]} noté${fini ? ', reste à faire terminé' : ''}.`, 'ok', 2200);
  await renderClients();
}

// ---------------------------------------------------------------------
// Les documents du dossier
// ---------------------------------------------------------------------
const DOC_MAX = 25 * 1024 * 1024;
let choixDocs = null;       // le sélecteur de fichiers, créé à la demande
let apresAjout = null;      // rappel après un ajout fait depuis le mail

function choisirDocuments(rappel = null) {
  apresAjout = rappel;
  if (!choixDocs) {
    choixDocs = document.createElement('input');
    choixDocs.type = 'file';
    choixDocs.multiple = true;
    choixDocs.accept = '.pdf,.doc,.docx,.xls,.xlsx,.txt,image/*';
    choixDocs.hidden = true;
    document.body.appendChild(choixDocs);
    choixDocs.addEventListener('change', () => ajouterDocuments(choixDocs.files));
  }
  choixDocs.value = '';
  choixDocs.click();
}

async function ajouterDocuments(fichiers) {
  const liste = [...(fichiers || [])];
  if (!liste.length || !ouvert) return;
  const ajoutes = [];
  for (const f of liste) {
    if (f.size > DOC_MAX) { toast(`« ${f.name} » dépasse 25 Mo.`, 'error'); continue; }
    const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80) || 'document';
    const path = `${ouvert}/${crypto.randomUUID()}-${safe}`;
    const { error: e1 } = await supabase.storage.from('clients').upload(path, f, { contentType: f.type || undefined, upsert: false });
    if (e1) { console.error(e1); toast(errorMessage(e1, `Envoi de « ${f.name} » impossible.`), 'error'); continue; }
    const { data, error: e2 } = await supabase.from('client_documents')
      .insert({ file_id: ouvert, path, name: f.name, content_type: f.type || null, size: f.size }).select().single();
    if (e2) { console.error(e2); toast(errorMessage(e2, `« ${f.name} » non enregistré.`), 'error'); continue; }
    ajoutes.push(data);
  }
  if (!ajoutes.length) return;
  toast(`${ajoutes.length} document${ajoutes.length > 1 ? 's' : ''} ajouté${ajoutes.length > 1 ? 's' : ''}.`, 'ok', 1800);
  const rappel = apresAjout;
  apresAjout = null;
  await renderClients();
  if (rappel) await rappel(ajoutes);
}

/** Un lien de téléchargement signé : 30 jours, de quoi laisser le client ouvrir son devis */
async function lienSigne(doc, jours = 30) {
  const { data, error } = await supabase.storage.from('clients').createSignedUrl(doc.path, jours * 86400, { download: doc.name });
  if (error) throw error;
  return data.signedUrl;
}

async function ouvrirDocument(id) {
  const doc = documents.find((x) => x.id === id);
  if (!doc) return;
  // La fenêtre s'ouvre tout de suite : un navigateur bloque celle qu'on
  // ouvre après une attente.
  const fenetre = window.open('', '_blank');
  try {
    const { data, error } = await supabase.storage.from('clients').createSignedUrl(doc.path, 600);
    if (error) throw error;
    if (fenetre) fenetre.location = data.signedUrl; else window.location.href = data.signedUrl;
  } catch (err) {
    fenetre?.close();
    toast(errorMessage(err, 'Document introuvable.'), 'error');
  }
}

async function supprimerDocument(id) {
  const doc = documents.find((x) => x.id === id);
  if (!doc) return;
  const ok = await confirmDialog(`Supprimer « ${doc.name} » du dossier ?\nUn lien déjà envoyé au client ne fonctionnera plus.`, 'Supprimer');
  if (!ok) return;
  const { error } = await supabase.from('client_documents').delete().eq('id', id);
  if (error) return toast(errorMessage(error, 'Suppression impossible.'), 'error');
  await supabase.storage.from('clients').remove([doc.path]);
  toast('Document supprimé.');
  await renderClients();
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
    const envoi = e.target.closest('[data-mail-envoyer]');
    if (envoi) { mailOuvert(); return; }   // le lien mailto fait le reste
    const b = e.target.closest('button, [data-ouvrir]');
    if (!b || e.target.closest('a')) return;
    const ds = b.dataset;
    if (ds.ouvrir) { ouvert = ds.ouvrir; suite = null; courriel = null; signalement = false; montrerFinies = false; renderClients().then(() => window.scrollTo(0, 0)); return; }
    if ('retour' in ds) { ouvert = null; suite = null; courriel = null; return renderClients(); }
    if (ds.mail) { courriel = ds.mail; mailOpts = null; return renderClients().then(() => $('.cl-mail')?.scrollIntoView({ block: 'nearest' })); }
    if ('mailFermer' in ds) { courriel = null; return renderClients(); }
    if (ds.mailModele) {
      // Changer de sorte de mail reprend ses cases par défaut ; les phrases
      // et le texte ajoutés restent.
      const garde = mailOpts || optsParDefaut('confirmation');
      mailOpts = { ...optsParDefaut(ds.mailModele), phrases: garde.phrases, ajout: garde.ajout, changes: garde.changes, docs: garde.docs, liens: garde.liens };
      return renderClients();
    }
    if (ds.mailPhrase) {
      const x = PHRASES[Number(ds.mailPhrase)];
      if (mailOpts.phrases.has(x)) mailOpts.phrases.delete(x); else mailOpts.phrases.add(x);
      b.classList.toggle('active', mailOpts.phrases.has(x));
      b.textContent = `${mailOpts.phrases.has(x) ? '✓ ' : '+ '}${x}`;
      return majApercu();
    }
    if ('mailCopier' in ds) return copierMail();
    if ('mailEmail' in ds) { const c = $('[data-champ-dossier="email"]'); c?.scrollIntoView({ block: 'center' }); c?.focus(); return; }
    if (ds.filtre) { filtre = ds.filtre; filtreChoisi = true; return renderClients(); }
    if (ds.relais) return relais(ds.relais, ds.pour || null);
    if (ds.travailKind) { travailKind = ds.travailKind; $$('[data-travail-kind]').forEach((x) => x.classList.toggle('active', x === b)); return; }
    if ('travail' in ds) return noterTravail();
    if (ds.traite) return marquerTraite(ds.traite);
    if ('problemeOuvrir' in ds) { signalement = true; return renderClients().then(() => $('#probleme-texte')?.focus()); }
    if ('problemeAnnuler' in ds) { signalement = false; return renderClients(); }
    if ('problemeOk' in ds) return signalerProbleme($('#probleme-texte')?.value || '');
    if ('problemeResolu' in ds) return signalerProbleme('');
    if (ds.dossierCloturer) return cloturerDossier(ds.dossierCloturer, false);
    if (ds.dossierRouvrir) return cloturerDossier(ds.dossierRouvrir, true);
    if (ds.traiteAnnuler) return annulerTravail(ds.traiteAnnuler);
    if (ds.travailAnnuler) return annulerTravail(ouvert, ds.travailAnnuler);
    if ('docAjouter' in ds) return choisirDocuments();
    if (ds.docOuvrir) return ouvrirDocument(ds.docOuvrir);
    if (ds.docSuppr) return supprimerDocument(ds.docSuppr);
    if ('mailDocAjouter' in ds) return choisirDocuments(cocherDocsMail);
    if ('mailPartager' in ds) return partagerMail();
    if (ds.confierLot) return confierLot(ds.confierLot.split(','));
    if (ds.nouvelleFiche) return nouvelleFiche(ds.nouvelleFiche);
    if (ds.etape) {
      const j = dossiers.find((x) => x.id === ouvert)?.jobs.find((x) => x.id === ds.job);
      return majFiche(ds.job, { status: ds.etape }, { message: `${SORTES[j?.kind] || 'Fiche'} : ${ETATS[j?.kind]?.[ds.etape]?.label || ds.etape}.` });
    }
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
  boite.addEventListener('input', (e) => {
    if (e.target.matches('[data-mail-objet], [data-mail-corps]')) return majLienMail();
    if (e.target.matches('[data-mail-ajout]') && mailOpts) { mailOpts.ajout = e.target.value; return majApercu(); }
  });

  boite.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-mail-objet], [data-mail-corps], [data-mail-ajout]')) return;
    if (t.dataset.mailDoc) return basculerDocMail(t.dataset.mailDoc, t.checked);
    if (t.dataset.mailChange && mailOpts) {
      if (t.checked) mailOpts.changes.add(t.dataset.mailChange); else mailOpts.changes.delete(t.dataset.mailChange);
      return majApercu();
    }
    if (t.dataset.mailBloc && mailOpts) {
      if (t.checked) mailOpts.blocs.add(t.dataset.mailBloc); else mailOpts.blocs.delete(t.dataset.mailBloc);
      return majApercu();
    }
    if (t.dataset.champDossier) return majDossier(t.dataset.champDossier, t.type === 'checkbox' ? t.checked : t.value);
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

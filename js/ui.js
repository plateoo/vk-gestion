// =====================================================================
// ui.js — helpers DOM, formatage (€, dates), toasts, modales, mois courant
// =====================================================================

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- Formatage nombres / montants (fr-BE) ----------
const EUR = new Intl.NumberFormat('fr-BE', {
  style: 'currency', currency: 'EUR',
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const NUM = new Intl.NumberFormat('fr-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Selon les navigateurs, Intl rend le séparateur de milliers fr-BE par une espace
 * fine insécable (« 5 868,50 € »). L'usage belge attend le point : on le force.
 * Le lookahead évite de toucher à l'espace qui précède le symbole €.
 */
function groupWithDots(s) { return s.replace(/[\u202F\u00A0\u2009 ](?=\d)/g, '.'); }

/** 5868.5 -> "5.868,50 €" */
export function fmtEUR(v) { return groupWithDots(EUR.format(Number(v) || 0)); }
/** 5868.5 -> "5.868,50" */
export function fmtNum(v) { return groupWithDots(NUM.format(Number(v) || 0)); }
/** Pour le CSV Excel FR : virgule décimale, pas de séparateur de milliers, pas de symbole */
export function csvNum(v) { return (Number(v) || 0).toFixed(2).replace('.', ','); }

// ---------- Dates ----------
/** '2026-09-07' -> '07/09/2026' */
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y}`;
}

/**
 * '2026-09-05' -> 'vendredi 5 septembre 2026'
 * Les champs <input type="date"> s'affichent selon la langue du NAVIGATEUR,
 * pas celle de la page : un navigateur en anglais montre 09/05/2026 pour le
 * 5 septembre. Écrire la date en toutes lettres lève l'ambiguïté.
 */
export function longDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-BE',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

const pad = (n) => String(n).padStart(2, '0');

/** Date du jour au format ISO local (pas UTC, pour éviter les décalages de fuseau) */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Ajoute n jours à une date ISO et renvoie une date ISO */
export function addDays(iso, n) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Number(n || 0));
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// ---------- Période affichée (partagée par tous les écrans) ----------
// Un seul réglage commande le tableau, les totaux, le tableau de bord et
// les exports : un chiffre affiché correspond toujours à ce qui est listé
// en dessous. Mois, trimestre, année ou dates libres.
const MONTH_STORAGE_KEY = 'vk_selected_month';
const PERIOD_STORAGE_KEY = 'vk_period';

export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** '2026-09' -> '2026-Q3' */
export function quarterOf(month) {
  const [y, mo] = month.split('-').map(Number);
  return `${y}-Q${Math.floor((mo - 1) / 3) + 1}`;
}

/** '2026-09' -> '2026-S2'. Le semestre manquait, et il sert au comptable. */
export function semesterOf(month) {
  const [y, mo] = month.split('-').map(Number);
  return `${y}-S${mo <= 6 ? 1 : 2}`;
}

const PERIOD_DEFAUT = { kind: 'month', month: null, quarter: null, semester: null, year: null, from: '', to: '' };

export function getPeriod() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PERIOD_STORAGE_KEY) || '{}'); } catch { p = {}; }
  const mois = /^\d{4}-\d{2}$/.test(p.month || '')
    ? p.month
    : (/^\d{4}-\d{2}$/.test(localStorage.getItem(MONTH_STORAGE_KEY) || '')
        ? localStorage.getItem(MONTH_STORAGE_KEY) : currentMonthKey());
  const out = { ...PERIOD_DEFAUT, ...p, month: mois };
  if (!['month', 'quarter', 'semester', 'year', 'range', 'all'].includes(out.kind)) out.kind = 'month';
  if (!/^\d{4}-Q[1-4]$/.test(out.quarter || '')) out.quarter = quarterOf(mois);
  if (!/^\d{4}-S[12]$/.test(out.semester || '')) out.semester = semesterOf(mois);
  if (!/^\d{4}$/.test(String(out.year || ''))) out.year = mois.slice(0, 4);
  return out;
}

/**
 * Modifie la période et prévient toute l'app. 'vk:month' est conservé :
 * les écrans qui ne raisonnent qu'en mois continuent de fonctionner.
 */
export function setPeriod(patch) {
  const p = { ...getPeriod(), ...patch };
  localStorage.setItem(PERIOD_STORAGE_KEY, JSON.stringify(p));
  localStorage.setItem(MONTH_STORAGE_KEY, p.month);
  window.dispatchEvent(new CustomEvent('vk:period', { detail: p }));
  window.dispatchEvent(new CustomEvent('vk:month', { detail: p.month }));
  return p;
}

export function getMonth() { return getPeriod().month; }

/** Choisir un mois ramène la période au mois : c'est le geste du sélecteur du bandeau. */
export function setMonth(m) {
  setPeriod({ kind: 'month', month: m, quarter: quarterOf(m), semester: semesterOf(m), year: m.slice(0, 4) });
}

/** Bornes de la période, incluses. null pour « toutes périodes ». */
export function periodRange(p = getPeriod()) {
  const dernierJour = (y, mo) => `${y}-${pad(mo)}-${pad(new Date(y, mo, 0).getDate())}`;
  if (p.kind === 'all') return null;
  if (p.kind === 'month') {
    const [y, mo] = p.month.split('-').map(Number);
    return { from: `${p.month}-01`, to: dernierJour(y, mo) };
  }
  if (p.kind === 'quarter') {
    const [y, q] = p.quarter.split('-Q').map(Number);
    const debut = (q - 1) * 3 + 1;
    return { from: `${y}-${pad(debut)}-01`, to: dernierJour(y, debut + 2) };
  }
  if (p.kind === 'semester') {
    const [y, sem] = p.semester.split('-S').map(Number);
    return sem === 1
      ? { from: `${y}-01-01`, to: `${y}-06-30` }
      : { from: `${y}-07-01`, to: `${y}-12-31` };
  }
  if (p.kind === 'year') return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
  // Dates libres : une borne manquante n'enferme rien de ce côté.
  return { from: p.from || '0000-01-01', to: p.to || '9999-12-31' };
}

/** true si la date ISO tombe dans la période affichée */
export function inPeriod(iso, p = getPeriod()) {
  if (!iso) return false;
  const r = periodRange(p);
  if (!r) return true;
  const d = String(iso).slice(0, 10);
  return d >= r.from && d <= r.to;
}

/** Libellé lisible, utilisé dans les en-têtes, les exports et les noms de fichier */
export function periodLabel(p = getPeriod()) {
  if (p.kind === 'all') return 'Toutes périodes';
  if (p.kind === 'month') return monthLabel(p.month);
  if (p.kind === 'quarter') {
    const [y, q] = p.quarter.split('-Q');
    return `${q}${q === '1' ? 'ᵉʳ' : 'ᵉ'} trimestre ${y}`;
  }
  if (p.kind === 'semester') {
    const [y, sem] = p.semester.split('-S');
    return `${sem}${sem === '1' ? 'ᵉʳ' : 'ᵉ'} semestre ${y}`;
  }
  if (p.kind === 'year') return `Année ${p.year}`;
  const r = periodRange(p);
  if (!p.from && !p.to) return 'Période libre';
  if (!p.to) return `À partir du ${fmtDate(r.from)}`;
  if (!p.from) return `Jusqu'au ${fmtDate(r.to)}`;
  return `Du ${fmtDate(r.from)} au ${fmtDate(r.to)}`;
}

/**
 * Période précédente de même nature, pour les variations du tableau de
 * bord : le mois d'avant, le trimestre d'avant, l'année d'avant. Pour des
 * dates libres, la tranche de même durée qui précède. null quand la
 * comparaison n'a pas de sens (toutes périodes).
 */
export function previousRange(p = getPeriod()) {
  if (p.kind === 'all') return null;
  if (p.kind === 'month') {
    const m = shiftMonth(p.month, -1);
    return periodRange({ ...PERIOD_DEFAUT, kind: 'month', month: m });
  }
  if (p.kind === 'quarter') {
    const [y, q] = p.quarter.split('-Q').map(Number);
    const prec = q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
    return periodRange({ ...PERIOD_DEFAUT, kind: 'quarter', quarter: prec });
  }
  if (p.kind === 'semester') {
    const [y, sem] = p.semester.split('-S').map(Number);
    const prec = sem === 1 ? `${y - 1}-S2` : `${y}-S1`;
    return periodRange({ ...PERIOD_DEFAUT, kind: 'semester', semester: prec });
  }
  if (p.kind === 'year') {
    return periodRange({ ...PERIOD_DEFAUT, kind: 'year', year: String(Number(p.year) - 1) });
  }
  const r = periodRange(p);
  const jour = 86400000;
  const debut = Date.parse(r.from);
  const fin = Date.parse(r.to);
  if (!Number.isFinite(debut) || !Number.isFinite(fin)) return null;
  const duree = fin - debut + jour;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(debut - duree), to: iso(debut - jour) };
}

/**
 * Avance ou recule d'UNE période, quelle que soit sa nature.
 *
 * Les flèches du bandeau reculaient toujours d'un mois, même quand
 * l'écran affichait une année : on cliquait douze fois pour voir l'année
 * précédente. Elles suivent maintenant ce qui est affiché.
 *
 * « Toutes périodes » et les dates libres ne se décalent pas : la
 * première n'a pas de voisine, les secondes ont été choisies à la main.
 */
export function shiftPeriod(pas, p = getPeriod()) {
  if (p.kind === 'all' || p.kind === 'range') return p;
  if (p.kind === 'month') {
    const m = shiftMonth(p.month, pas);
    return { ...p, month: m, quarter: quarterOf(m), semester: semesterOf(m), year: m.slice(0, 4) };
  }
  if (p.kind === 'quarter') {
    const [y, q] = p.quarter.split('-Q').map(Number);
    const total = y * 4 + (q - 1) + pas;
    const ny = Math.floor(total / 4);
    const nq = (total % 4 + 4) % 4 + 1;
    // Le mois suit le trimestre : les écrans qui ne raisonnent qu'en mois
    // ne doivent pas rester sur une date étrangère à la période.
    const m = `${ny}-${pad((nq - 1) * 3 + 1)}`;
    return { ...p, quarter: `${ny}-Q${nq}`, month: m, semester: semesterOf(m), year: String(ny) };
  }
  if (p.kind === 'semester') {
    const [y, sem] = p.semester.split('-S').map(Number);
    const total = y * 2 + (sem - 1) + pas;
    const ny = Math.floor(total / 2);
    const ns = (total % 2 + 2) % 2 + 1;
    const m = `${ny}-${ns === 1 ? '01' : '07'}`;
    return { ...p, semester: `${ny}-S${ns}`, month: m, quarter: quarterOf(m), year: String(ny) };
  }
  const ny = String(Number(p.year) + pas);
  const m = `${ny}-01`;
  return { ...p, year: ny, month: m, quarter: quarterOf(m), semester: semesterOf(m) };
}

// ---------------------------------------------------------------------
// Ouvrir et imprimer quand l'application est installée sur un téléphone
//
// Une fois posée sur l'écran d'accueil, l'application tourne en mode
// « standalone » : plus de barre d'adresse, plus d'onglets. Dans ce mode,
// iOS ampute deux choses sans rien dire :
//
//   • window.open('…', '_blank') n'ouvre rien du tout ;
//   • window.print() ne fait rien non plus.
//
// D'où les boutons « qui ne fonctionnent pas » : ils fonctionnaient, mais
// le système les ignorait. Un bouton muet est pire qu'un bouton absent —
// on le presse deux fois, puis on cesse de croire l'application.
// ---------------------------------------------------------------------

/** L'application tourne-t-elle depuis l'écran d'accueil ? */
export function estInstallee() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

/**
 * Ouvre une adresse et dit la vérité quand ce n'est pas possible.
 *
 * On tente d'abord l'ouverture normale. Si elle échoue — bloquée, ou
 * ignorée par iOS — on ne laisse pas l'utilisateur devant un bouton mort :
 * on navigue dans la fenêtre courante, ce qui marche toujours, en le
 * prévenant qu'il devra revenir en arrière.
 */
export function ouvrirLien(url, { memeFenetre = false } = {}) {
  if (!url) return false;
  if (!memeFenetre) {
    let f = null;
    try { f = window.open(url, '_blank', 'noopener'); } catch { f = null; }
    if (f) return true;
  }
  // Dernier recours : on quitte l'écran courant. L'application est une
  // page unique, le retour du navigateur ramène exactement où l'on était.
  toast('Ouverture du document… utilise le retour pour revenir.', 'ok', 4000);
  setTimeout(() => { window.location.href = url; }, 250);
  return true;
}

/**
 * Imprime l'écran, ou explique pourquoi c'est impossible ici.
 *
 * Sur un téléphone où l'application est installée, l'impression n'existe
 * pas. Plutôt qu'un bouton qui ne répond pas, on dit où aller — et l'on
 * propose la sortie qui, elle, fonctionne partout.
 */
export function imprimerEcran(avant = null) {
  if (estInstallee()) {
    toast('L\'impression n\'est pas possible depuis l\'application installée. '
      + 'Ouvre plateoo.github.io/vk-gestion dans Safari ou Chrome pour imprimer, '
      + 'ou utilise l\'export Excel.', 'error', 8000);
    return false;
  }
  try { avant?.(); } catch { /* l'en-tête d'impression n'est pas vital */ }
  window.print();
  return true;
}

/** true si la date ISO tombe dans une tranche {from, to} */
export function inRange(iso, r) {
  if (!r || !iso) return !r;
  const d = String(iso).slice(0, 10);
  return d >= r.from && d <= r.to;
}

/** Même chose, sans accent ni espace : pour les noms de fichier */
export function periodSlug(p = getPeriod()) {
  if (p.kind === 'all') return 'toutes-periodes';
  if (p.kind === 'month') return p.month;
  if (p.kind === 'quarter') return p.quarter;
  if (p.kind === 'year') return String(p.year);
  const r = periodRange(p);
  return `${r.from}_${r.to}`;
}

/** '2026-09' + 1 -> '2026-10' */
export function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** '2026-09' -> 'Septembre 2026' */
export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  const s = new Date(y, mo - 1, 1).toLocaleDateString('fr-BE', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** true si la date ISO appartient au mois 'YYYY-MM' */
export function inMonth(iso, m) {
  return !!iso && String(iso).slice(0, 7) === m;
}

// ---------- TVA ----------
export const LEGAL_RATES = [0.21, 0.12, 0.06, 0];

/**
 * Le taux choisi est-il cohérent avec le montant de TVA lu sur le document ?
 * Même règle et même tolérance que le contrôle serveur (0,02 €) : c'est ce
 * qui garantit qu'un taux rendu en pourcentage plutôt qu'en décimal, ou une
 * lecture erronée, ne passe jamais inaperçu.
 *   'unknown' : rien à recouper (aucun montant de TVA lu)
 *   true      : incohérent, la validation doit être bloquée
 *   false     : cohérent
 */
export function vatMismatch(htva, readTva, rate) {
  if (!Number.isFinite(rate)) return true;
  if (!Number.isFinite(readTva) || !Number.isFinite(htva) || Math.abs(htva) < 0.01) return 'unknown';
  const calc = Math.round(htva * rate * 100) / 100;
  return Math.abs(calc - readTva) > 0.02;
}

// ---------- Statuts de paiement ----------
export const STATUSES = {
  a_payer:  { label: 'À payer',        cls: 'st-orange' },
  paye:     { label: 'Payé',           cls: 'st-green'  },
  en_retard:{ label: 'En retard',      cls: 'st-red'    },
  litige:   { label: 'Litige',         cls: 'st-red'    },
  acompte:  { label: 'Acompte versé',  cls: 'st-grey'   },
  // Le PAIEMENT est réglé, rien d'autre. Le libellé doit le dire : ces
  // factures restent à encoder dans Smart et à envoyer à WinAuditor
  // comme les autres. « Avant reprise » tout court laissait croire
  // qu'elles sortaient du travail — elles n'en sortent pas.
  avant_reprise: { label: 'Payée avant reprise', cls: 'st-grey' }
};
export function statusLabel(s) { return (STATUSES[s] || {}).label || s || ''; }
export function statusClass(s) { return (STATUSES[s] || {}).cls || 'st-grey'; }

// ---------- Échéance dépassée / proche ----------
export function isOverdue(inv) {
  // Une facture antérieure à la reprise n'est pas « en retard » : elle
  // n'est pas due. La compter alimenterait une alerte fausse, et une
  // alerte fausse finit par rendre toutes les autres invisibles.
  return !!inv.due_date
      && inv.payment_status !== 'paye'
      && inv.payment_status !== 'avant_reprise'
      && inv.due_date < todayISO();
}

/**
 * Cette facture représente-t-elle une somme à décaisser ?
 *
 * Non si elle est payée, non si elle précède la reprise du magasin. Un
 * seul endroit en décide, pour que le tableau de bord, les fiches
 * fournisseur et le tableau ne puissent jamais se contredire.
 */
export function estDue(inv) {
  return inv.payment_status !== 'paye' && inv.payment_status !== 'avant_reprise';
}

/** Nombre de jours entre aujourd'hui et une date ISO (négatif = passé) */
export function daysUntil(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}

/** Échéance dans les 5 jours (et pas encore payée) */
export function isDueSoon(inv) {
  if (inv.payment_status === 'paye' || isOverdue(inv)) return false;
  const d = daysUntil(inv.due_date);
  return d !== null && d >= 0 && d <= 5;
}

/** Facture entièrement traitée : encodée Smart + envoyée WinAuditor + payée */
export function isComplete(inv) {
  return !!inv.in_smart && !!inv.in_winauditor && inv.payment_status === 'paye';
}

// ---------- Échappement HTML ----------
export function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- Toasts ----------
/**
 * Affiche un toast. `action` = { label, onClick } ajoute un lien (ex. « Annuler »).
 * Renvoie un handle { el, dismiss() }.
 */
export function toast(message, type = 'ok', ms = 3200, action = null) {
  const box = $('#toasts');
  if (!box) return null;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.setAttribute('role', 'status');

  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = message;
  t.appendChild(span);

  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.onClick(); });
    t.appendChild(b);
  }

  box.appendChild(t);
  const timer = setTimeout(() => t.remove(), ms);
  return { el: t, dismiss() { clearTimeout(timer); t.remove(); } };
}

/** Message d'erreur lisible en français à partir d'une erreur Supabase/JS */
export function errorMessage(err, fallback = 'Une erreur est survenue.') {
  if (!err) return fallback;
  const msg = err.message || String(err);
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Connexion au serveur impossible. Vérifie ta connexion internet.';
  if (/Invalid login credentials/i.test(msg)) return 'Email ou mot de passe incorrect.';
  if (/duplicate key|23505/i.test(msg)) return 'Cet enregistrement existe déjà.';
  if (/violates row-level security|permission denied|42501/i.test(msg)) return 'Tu n\'as pas les droits pour cette action.';
  if (/violates foreign key|23503/i.test(msg)) return 'Impossible : cet élément est encore utilisé par des factures.';
  if (/JWT|token is expired/i.test(msg)) return 'Session expirée, reconnecte-toi.';
  return fallback;
}

// ---------- Modales ----------
export function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.hidden = false;
  document.body.classList.add('modal-open');
  // focus sur le premier champ utilisable
  const first = m.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
}

export function closeModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.hidden = true;
  if (!$$('.modal:not([hidden])').length) document.body.classList.remove('modal-open');
}

/** Confirmation maison (pas de window.confirm) -> Promise<boolean> */
export function confirmDialog(message, okLabel = 'Confirmer') {
  return new Promise((resolve) => {
    const modal = $('#modal-confirm');
    $('#confirm-message').textContent = message;
    const ok = $('#confirm-ok');
    const cancel = $('#confirm-cancel');
    ok.textContent = okLabel;
    const done = (val) => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      closeModal('modal-confirm');
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => ok.focus(), 30);
  });
}

// ---------- États de chargement / vide ----------
/** Lignes squelette dans un <tbody> */
export function skeletonRows(tbody, rows = 6, cols = 10) {
  tbody.innerHTML = Array.from({ length: rows }, () =>
    `<tr class="skeleton-row">${'<td><span class="skeleton"></span></td>'.repeat(cols)}</tr>`
  ).join('');
}

export function emptyRow(tbody, cols, message) {
  tbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}"><div class="empty">${escapeHtml(message)}</div></td></tr>`;
}

// ---------- Divers ----------
export function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}

/** Prévient les autres écrans qu'une donnée a changé */
export function notifyDataChange() {
  window.dispatchEvent(new CustomEvent('vk:data'));
}

// ---------- Icônes SVG inline (trait 1.5px, aucune librairie) ----------
const svg = (paths, cls = '') =>
  `<svg class="ico-svg ${cls}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  check: svg('<path d="M4 10.5 8 14.5 16 6"/>'),
  checkCircle: svg('<circle cx="10" cy="10" r="7.25"/><path d="M6.75 10.25 9 12.5l4.25-4.75"/>'),
  dash: svg('<path d="M6 10h8"/>'),
  box: svg('<path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5z"/><path d="M3.5 6.5 10 10l6.5-3.5M10 10v7"/>'),
  dots: svg('<circle cx="4.5" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.15" fill="currentColor" stroke="none"/>'),
  pencil: svg('<path d="M13.5 3.5 16.5 6.5 7 16H4v-3z"/>'),
  copy: svg('<rect x="7" y="7" width="9.5" height="9.5" rx="1.5"/><path d="M13 4.5H4.5A1 1 0 0 0 3.5 5.5V14"/>'),
  trash: svg('<path d="M4 6h12M8.5 6V4.5h3V6M6 6l.75 10h6.5L14 6"/>'),
  empty: `<svg class="empty-art" viewBox="0 0 120 80" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="22" y="14" width="60" height="52" rx="4"/>
      <path d="M34 28h36M34 38h36M34 48h22"/>
      <circle cx="86" cy="56" r="14" fill="#fff"/>
      <path d="M80 56h12M86 50v12"/>
    </svg>`
};

// ---------- Popover léger (confirmation, mini sélecteur de date, menu ⋯) ----------
let popEl = null;

export function closePopover() {
  if (popEl) { popEl.remove(); popEl = null; }
}

/** Ouvre un popover ancré sous un élément. Renvoie l'élément créé. */
export function openPopover(anchor, html, cls = '') {
  closePopover();
  const p = document.createElement('div');
  p.className = `popover ${cls}`;
  p.innerHTML = html;
  document.body.appendChild(p);

  const r = anchor.getBoundingClientRect();
  const maxLeft = window.scrollX + document.documentElement.clientWidth - p.offsetWidth - 10;
  const left = Math.max(window.scrollX + 8, Math.min(window.scrollX + r.left, maxLeft));
  let top = window.scrollY + r.bottom + 6;
  // si ça déborde en bas, on place au-dessus
  if (r.bottom + p.offsetHeight + 10 > document.documentElement.clientHeight) {
    top = window.scrollY + r.top - p.offsetHeight - 6;
  }
  p.style.top = `${Math.max(window.scrollY + 8, top)}px`;
  p.style.left = `${left}px`;
  popEl = p;
  return p;
}

// Fermeture au clic extérieur / Échap / scroll
document.addEventListener('mousedown', (e) => {
  if (popEl && !popEl.contains(e.target)) closePopover();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
window.addEventListener('resize', closePopover);

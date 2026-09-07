// =====================================================================
// tour.js — visite guidée au premier lancement (6 étapes, selon le rôle)
// =====================================================================
import { $ } from './ui.js';

let steps = [];
let index = 0;
let overlay = null;
let hole = null;
let bubble = null;
let current = null;          // élément mis en évidence
let storageKey = 'vkg_tour_done';
let switchTab = () => {};

// ---------------------------------------------------------------------
// Contenu des étapes — le premier sélecteur trouvé sert de cible
// ---------------------------------------------------------------------
function stepsFor(role) {
  const common1 = {
    tab: 'dashboard',
    targets: ['.appbar .month-picker'],
    title: 'Le mois affiché',
    text: 'Tout ce que vous voyez concerne ce mois. Les flèches changent de période, et le bouton « Mois en cours » vous ramène à aujourd\'hui.'
  };
  const common2 = {
    tab: 'invoices',
    targets: ['#btn-new-invoice'],
    title: 'Encoder une facture',
    text: 'C\'est ici que vous encodez chaque facture reçue. L\'échéance et le total TVAC se calculent tout seuls.'
  };
  const common5 = {
    tab: 'invoices',
    targets: ['#f-search'],
    title: 'La recherche et les filtres',
    text: 'Pour retrouver une facture en deux secondes : numéro, fournisseur ou remarque, puis les filtres par statut.'
  };
  const common6 = {
    tab: 'dashboard',
    targets: ['.alerts'],
    title: 'Ce qui reste à faire',
    text: 'Ces trois blocs vous disent ce qui reste à faire ce mois-ci. Quand tout est vert, le mois est en ordre.'
  };

  if (role === 'manager') {
    return [
      common1,
      common2,
      {
        tab: 'invoices',
        targets: ['.btn-pay', '#table-invoices thead th:nth-child(10)'],
        title: 'Marquer payé',
        text: 'Un clic, la date du jour s\'inscrit toute seule. Vous avez 6 secondes pour annuler depuis le message en bas de l\'écran.'
      },
      {
        tab: 'invoices',
        targets: ['#table-invoices thead th:nth-child(1)'],
        title: 'La sélection multiple',
        text: 'Cochez plusieurs factures pour toutes les marquer payées après un virement groupé, ou les exporter ensemble.'
      },
      common5,
      common6
    ];
  }

  return [
    common1,
    common2,
    {
      tab: 'invoices',
      targets: ['.td-smart', '#table-invoices thead th:nth-child(7)'],
      title: 'Smart et WinAuditor',
      text: 'Un clic suffit pour indiquer que c\'est fait. Vert = fait, gris = à faire. C\'est enregistré immédiatement.'
    },
    {
      tab: 'invoices',
      targets: ['.td-stock', '#table-invoices thead th:nth-child(9)'],
      title: 'L\'entrée en stock',
      text: 'Le bouton « Reçu » inscrit la date du jour à la réception de la marchandise. Un second clic l\'efface.'
    },
    common5,
    common6
  ];
}

// ---------------------------------------------------------------------
// Lancement
// ---------------------------------------------------------------------
/** Lance la visite si l'utilisateur ne l'a jamais vue */
export function maybeStartTour(userId, role, showTab) {
  storageKey = `vkg_tour_done_${userId || 'anon'}`;
  if (localStorage.getItem(storageKey)) return;
  startTour(role, showTab, false);
}

/** Lance (ou relance) la visite guidée */
export function startTour(role, showTab, force = false) {
  if (force) { /* relance manuelle : on repart de zéro */ }
  switchTab = showTab || (() => {});
  steps = stepsFor(role);
  index = 0;
  build();
  setTimeout(show, 350);   // laisse le temps au premier rendu
}

function build() {
  destroy();
  overlay = document.createElement('div');
  overlay.className = 'tour-overlay';

  hole = document.createElement('div');
  hole.className = 'tour-hole';

  bubble = document.createElement('div');
  bubble.className = 'tour-bubble';

  overlay.appendChild(hole);
  overlay.appendChild(bubble);
  document.body.appendChild(overlay);

  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
}

function destroy() {
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', reposition, true);
  if (overlay) overlay.remove();
  overlay = hole = bubble = current = null;
}

function finish() {
  localStorage.setItem(storageKey, '1');
  destroy();
}

// ---------------------------------------------------------------------
// Affichage d'une étape
// ---------------------------------------------------------------------
function show() {
  if (!overlay) return;
  const step = steps[index];
  if (!step) return finish();

  switchTab(step.tab);

  // On cherche la première cible disponible
  let target = null;
  for (const sel of step.targets) {
    target = document.querySelector(sel);
    if (target) break;
  }
  if (!target) target = $('.main');
  current = target;
  target.scrollIntoView({ block: 'center', inline: 'nearest' });

  bubble.innerHTML = `
    <div class="tour-step">Étape ${index + 1} sur ${steps.length}</div>
    <div class="tour-title">${step.title}</div>
    <p class="tour-text">${step.text}</p>
    <div class="tour-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-tour="skip">Passer</button>
      <button type="button" class="btn btn-primary btn-sm" data-tour="next">${index === steps.length - 1 ? 'Terminer' : 'Suivant'}</button>
    </div>`;

  bubble.querySelector('[data-tour="skip"]').onclick = finish;
  bubble.querySelector('[data-tour="next"]').onclick = () => { index += 1; show(); };

  reposition();
}

/** Repositionne le trou et la bulle sur la cible courante (scroll / redimensionnement) */
function reposition() {
  if (!overlay || !current) return;
  const r = current.getBoundingClientRect();
  const pad = 6;

  hole.style.top = `${r.top - pad}px`;
  hole.style.left = `${r.left - pad}px`;
  hole.style.width = `${r.width + pad * 2}px`;
  hole.style.height = `${r.height + pad * 2}px`;

  const bw = bubble.offsetWidth || 300;
  const bh = bubble.offsetHeight || 160;
  let top = r.bottom + 12;
  if (top + bh > window.innerHeight - 10) top = Math.max(10, r.top - bh - 12);
  let left = r.left;
  if (left + bw > window.innerWidth - 10) left = Math.max(10, window.innerWidth - bw - 10);
  bubble.style.top = `${top}px`;
  bubble.style.left = `${left}px`;
}

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

// ---------- Mois sélectionné (partagé Tableau de bord <-> Factures) ----------
const MONTH_STORAGE_KEY = 'vk_selected_month';

export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function getMonth() {
  const m = localStorage.getItem(MONTH_STORAGE_KEY);
  return /^\d{4}-\d{2}$/.test(m || '') ? m : currentMonthKey();
}

/** Mémorise le mois et prévient toute l'app (événement 'vk:month') */
export function setMonth(m) {
  localStorage.setItem(MONTH_STORAGE_KEY, m);
  window.dispatchEvent(new CustomEvent('vk:month', { detail: m }));
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

// ---------- Statuts de paiement ----------
export const STATUSES = {
  a_payer:  { label: 'À payer',        cls: 'st-orange' },
  paye:     { label: 'Payé',           cls: 'st-green'  },
  en_retard:{ label: 'En retard',      cls: 'st-red'    },
  litige:   { label: 'Litige',         cls: 'st-red'    },
  acompte:  { label: 'Acompte versé',  cls: 'st-grey'   }
};
export function statusLabel(s) { return (STATUSES[s] || {}).label || s || ''; }
export function statusClass(s) { return (STATUSES[s] || {}).cls || 'st-grey'; }

// ---------- Échéance dépassée / proche ----------
export function isOverdue(inv) {
  return !!inv.due_date && inv.payment_status !== 'paye' && inv.due_date < todayISO();
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

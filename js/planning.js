// =====================================================================
// planning.js — le mois vu comme un calendrier.
//
// Ni Outlook ni Google ne savent ce que ce calendrier montre : quelles
// factures échoient quel jour, combien elles pèsent, et quels escomptes
// expirent — c'est-à-dire l'argent qu'on perd en attendant un jour de
// plus.
//
// Aucune requête supplémentaire : tout est déjà dans le cache des
// factures. Un calendrier qui rechargerait la base pour afficher des
// dates qu'on a déjà serait un gaspillage.
// =====================================================================
import { getInvoices, setInvoiceFilters } from './invoices.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage, longDate,
  getMonth, setMonth, shiftMonth, monthLabel, todayISO, estDue, isOverdue
} from './ui.js';

const JOURS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

/** Jours du mois, précédés des cases vides pour caler sur le lundi */
function grille(mois) {
  const [y, m] = mois.split('-').map(Number);
  const premier = new Date(y, m - 1, 1);
  // getDay() : dimanche = 0. En Belgique la semaine commence le lundi.
  const decalage = (premier.getDay() + 6) % 7;
  const nbJours = new Date(y, m, 0).getDate();
  const cases = Array.from({ length: decalage }, () => null);
  for (let j = 1; j <= nbJours; j++) {
    cases.push(`${mois}-${String(j).padStart(2, '0')}`);
  }
  while (cases.length % 7) cases.push(null);
  return cases;
}

/**
 * Ce qui tombe chaque jour du mois.
 *
 * Une même facture peut apparaître deux fois : le jour où son escompte
 * expire, et le jour de son échéance. Ce sont deux échéances distinctes,
 * avec deux conséquences distinctes — les confondre ferait perdre
 * précisément ce que ce calendrier sert à montrer.
 */
function parJour(factures, mois) {
  const map = new Map();
  const ajouter = (date, item) => {
    if (!date || String(date).slice(0, 7) !== mois) return;
    const k = String(date).slice(0, 10);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  };

  for (const i of factures) {
    if (i.review_status === 'document') continue;
    if (!estDue(i)) continue;              // payée, ou antérieure à la reprise

    if (i.due_date) {
      ajouter(i.due_date, {
        type: 'echeance', id: i.id,
        libelle: i.supplier_name, detail: i.invoice_number,
        montant: Number(i.amount_tvac) || 0,
        retard: isOverdue(i)
      });
    }
    // L'escompte n'a de sens que s'il court encore.
    if (i.discount_deadline && i.amount_discounted && i.discount_deadline >= todayISO()) {
      const gain = (Number(i.amount_tvac) || 0) - (Number(i.amount_discounted) || 0);
      if (gain > 0) {
        ajouter(i.discount_deadline, {
          type: 'escompte', id: i.id,
          libelle: i.supplier_name, detail: `escompte ${Number(i.discount_rate)} %`,
          montant: gain
        });
      }
    }
  }
  return map;
}

export async function renderPlanning() {
  const boite = $('#planning-body');
  if (!boite) return;
  const mois = getMonth();
  $('#planning-label').textContent = monthLabel(mois);

  let factures;
  try {
    factures = await getInvoices();
  } catch (err) {
    console.error(err);
    boite.innerHTML = `<div class="card pad"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  const jours = parJour(factures, mois);
  const aujourdhui = todayISO();

  // Les trois chiffres qui décident d'une journée de travail
  let aPayer = 0, enRetard = 0, escompte = 0;
  for (const [, items] of jours) {
    for (const it of items) {
      if (it.type === 'escompte') escompte += it.montant;
      else if (it.retard) enRetard += it.montant;
      else aPayer += it.montant;
    }
  }

  const cases = grille(mois).map((jour) => {
    if (!jour) return '<div class="pl-case vide"></div>';
    const items = jours.get(jour) || [];
    const num = Number(jour.slice(8));
    const total = items.filter((i) => i.type === 'echeance').reduce((s, i) => s + i.montant, 0);
    const retard = items.some((i) => i.retard);
    const classes = [
      'pl-case',
      jour === aujourdhui ? 'aujourdhui' : '',
      items.length ? 'charge' : '',
      retard ? 'retard' : ''
    ].filter(Boolean).join(' ');

    return `
      <div class="${classes}" ${items.length ? `data-jour="${jour}"` : ''}>
        <div class="pl-num">${num}${jour === aujourdhui ? '<span class="pl-today">aujourd&rsquo;hui</span>' : ''}</div>
        ${items.length ? `
          <ul class="pl-items">
            ${items.slice(0, 3).map((it) => `
              <li class="pl-item ${it.type}${it.retard ? ' en-retard' : ''}">
                <span class="pl-lib">${escapeHtml(it.libelle)}</span>
                <span class="pl-mt">${it.type === 'escompte' ? '−' : ''}${fmtEUR(it.montant)}</span>
              </li>`).join('')}
            ${items.length > 3 ? `<li class="pl-plus">+ ${items.length - 3} autre(s)</li>` : ''}
          </ul>
          ${total ? `<div class="pl-total">${fmtEUR(total)}</div>` : ''}` : ''}
      </div>`;
  }).join('');

  boite.innerHTML = `
    <div class="pl-resume">
      <div class="pl-chiffre">
        <span class="pl-chiffre-lbl">À payer ce mois-ci</span>
        <strong>${fmtEUR(aPayer)}</strong>
      </div>
      <div class="pl-chiffre ${enRetard ? 'alerte' : ''}">
        <span class="pl-chiffre-lbl">Déjà en retard</span>
        <strong>${fmtEUR(enRetard)}</strong>
      </div>
      <div class="pl-chiffre ${escompte ? 'gain' : ''}">
        <span class="pl-chiffre-lbl">Escomptes encore saisissables</span>
        <strong>${fmtEUR(escompte)}</strong>
      </div>
    </div>

    <div class="card pad">
      <div class="pl-entetes">${JOURS.map((j) => `<span>${j}</span>`).join('')}</div>
      <div class="pl-grille">${cases}</div>
      <p class="pl-legende">
        <span class="pl-pastille echeance"></span> échéance de paiement
        <span class="pl-pastille escompte"></span> dernier jour pour l'escompte
        <span class="pl-pastille en-retard"></span> déjà échue
        <span class="sep">·</span> clique sur un jour pour voir ses factures
      </p>
    </div>`;

  // Un jour cliqué ouvre les factures concernées : le calendrier montre,
  // le tableau permet d'agir.
  $$('#planning-body [data-jour]').forEach((c) => {
    c.addEventListener('click', () => {
      const jour = c.dataset.jour;
      const items = jours.get(jour) || [];
      const noms = [...new Set(items.map((i) => i.libelle))];
      setInvoiceFilters({ q: noms.length === 1 ? noms[0] : '', period: 'month', status: '', view: 'factures' });
      window.dispatchEvent(new CustomEvent('vk:goto', { detail: 'invoices' }));
      toast(`${fmtDate(jour)} — ${items.length} échéance${items.length > 1 ? 's' : ''}. ${longDate(jour)}.`);
    });
  });
}

export function initPlanning() {
  $('#planning-prev')?.addEventListener('click', () => setMonth(shiftMonth(getMonth(), -1)));
  $('#planning-next')?.addEventListener('click', () => setMonth(shiftMonth(getMonth(), 1)));
  window.addEventListener('vk:month', () => {
    if (!$('#tab-planning')?.hidden) renderPlanning();
  });
  window.addEventListener('vk:data', () => {
    if (!$('#tab-planning')?.hidden) renderPlanning();
  });
}

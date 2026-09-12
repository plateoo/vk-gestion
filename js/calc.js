// =====================================================================
// calc.js — calculette à bande, pour vérifier une facture.
//
// Pas une calculette de téléphone : une bande, comme sur une machine de
// bureau. Marie additionne des lignes de facture — il faut qu'elle VOIE
// ce qu'elle a déjà saisi, pour retrouver son erreur sans tout refaire.
// Une calculette qui n'affiche qu'un nombre oblige à recommencer au
// moindre doute.
//
// Trois gestes propres à une facture : retirer la TVA d'un montant TVAC,
// l'ajouter à un montant HTVA, et recopier le total dans le champ qu'on
// était en train de remplir.
// =====================================================================
import { $, fmtEUR, toast } from './ui.js';

const LIGNES = [];          // { valeur, operateur, total }
let champCible = null;      // dernier champ de saisie actif, pour y coller

const arrondi = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Le total courant, c'est la dernière ligne. */
function total() {
  return LIGNES.length ? LIGNES[LIGNES.length - 1].total : 0;
}

function ajouter(valeur, operateur = '+') {
  const v = arrondi(valeur);
  if (!Number.isFinite(v)) return;
  const base = total();
  let t = base;
  if (!LIGNES.length) t = v;
  else if (operateur === '+') t = base + v;
  else if (operateur === '−') t = base - v;
  else if (operateur === '×') t = base * v;
  else if (operateur === '÷') t = v === 0 ? base : base / v;
  LIGNES.push({ valeur: v, operateur: LIGNES.length ? operateur : '=', total: arrondi(t) });
  rendre();
}

/** Applique un taux au total, sans ajouter de ligne de saisie */
function appliquer(libelle, calcul) {
  if (!LIGNES.length) return toast('Saisis d\'abord un montant.', 'error');
  const t = arrondi(calcul(total()));
  LIGNES.push({ valeur: null, operateur: libelle, total: t });
  rendre();
}

function effacerTout() { LIGNES.length = 0; rendre(); }
function retirerDerniere() { LIGNES.pop(); rendre(); }

function rendre() {
  const bande = $('#calc-tape');
  const ecran = $('#calc-total');
  if (!bande || !ecran) return;

  bande.innerHTML = LIGNES.length
    ? LIGNES.map((l, k) => `
        <li>
          <span class="calc-op">${l.operateur === '=' ? '' : l.operateur}</span>
          <span class="calc-val">${l.valeur === null ? '' : fmtEUR(l.valeur)}</span>
          <span class="calc-run">${fmtEUR(l.total)}</span>
          <button type="button" class="calc-del" data-calc-del="${k}" title="Retirer cette ligne">×</button>
        </li>`).join('')
    : '<li class="calc-vide">Tape un montant, puis + ou −.</li>';

  ecran.textContent = fmtEUR(total());
  bande.scrollTop = bande.scrollHeight;
}

/**
 * Colle le total dans le champ que l'utilisateur remplissait avant
 * d'ouvrir la calculette. Sans cela il faudrait relire le résultat et le
 * retaper — c'est-à-dire réintroduire l'erreur qu'on cherchait à éviter.
 */
async function coller() {
  const t = total();
  if (champCible && document.body.contains(champCible)) {
    champCible.value = String(t);
    champCible.dispatchEvent(new Event('input', { bubbles: true }));
    champCible.dispatchEvent(new Event('change', { bubbles: true }));
    fermer();
    champCible.focus();
    return toast(`${fmtEUR(t)} reporté dans le champ.`);
  }
  try {
    await navigator.clipboard.writeText(String(t));
    toast(`${fmtEUR(t)} copié.`);
  } catch {
    toast('Copie impossible : sélectionne le total à la main.', 'error');
  }
}

// ---------------------------------------------------------------------
// Ouverture / fermeture
// ---------------------------------------------------------------------
/**
 * @param {boolean} repartirDeZero  vrai quand on ouvre POUR remplir un champ.
 *
 * Ouvrir la calculette depuis un champ de montant veut dire « je veux
 * calculer cette valeur-ci ». Garder le calcul précédent ferait s'ajouter
 * en silence un total qui n'a rien à voir — l'erreur exacte que cette
 * calculette existe pour éviter. Depuis le bandeau, au contraire, on
 * reprend son calcul là où on l'avait laissé.
 */
export function ouvrirCalc(repartirDeZero = false) {
  const boite = $('#calc');
  if (!boite) return;
  // On retient le champ de saisie actif AVANT d'ouvrir : c'est là que le
  // résultat devra retourner.
  const actif = document.activeElement;
  if (actif && actif.matches?.('input[type="number"], input[type="text"]') && !actif.closest('#calc')) {
    champCible = actif;
    repartirDeZero = true;
  }
  if (repartirDeZero) LIGNES.length = 0;
  boite.hidden = false;
  $('#calc-input').value = '';
  $('#calc-input').focus();
  rendre();
}

export function fermer() {
  const boite = $('#calc');
  if (boite) boite.hidden = true;
}

function basculer() { ($('#calc')?.hidden ? ouvrirCalc : fermer)(); }

// ---------------------------------------------------------------------
// Câblage
// ---------------------------------------------------------------------
export function initCalc() {
  const boite = $('#calc');
  if (!boite) return;

  const lire = () => {
    // Virgule ou point : Marie tape ce qu'elle voit sur la facture.
    const brut = $('#calc-input').value.replace(',', '.').trim();
    return brut === '' ? null : Number(brut);
  };

  const saisir = (op) => {
    const v = lire();
    if (v === null || !Number.isFinite(v)) return;
    ajouter(v, op);
    $('#calc-input').value = '';
    $('#calc-input').focus();
  };

  $('#calc-input').addEventListener('keydown', (e) => {
    if (['+', '-', '*', '/'].includes(e.key)) {
      e.preventDefault();
      saisir({ '+': '+', '-': '−', '*': '×', '/': '÷' }[e.key]);
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); saisir('+'); }
    if (e.key === 'Escape') { e.preventDefault(); fermer(); }
  });

  boite.addEventListener('click', (e) => {
    const b = e.target.closest('[data-calc]');
    if (b) {
      const a = b.dataset.calc;
      if (a === 'plus') return saisir('+');
      if (a === 'moins') return saisir('−');
      if (a === 'fois') return saisir('×');
      if (a === 'divise') return saisir('÷');
      if (a === 'clear') return effacerTout();
      if (a === 'back') return retirerDerniere();
      if (a === 'paste') return coller();
      if (a === 'close') return fermer();
      // Trois gestes propres à une facture belge
      if (a === 'tva21') return appliquer('+ TVA 21 %', (t) => t * 1.21);
      if (a === 'tva6')  return appliquer('+ TVA 6 %',  (t) => t * 1.06);
      if (a === 'sanstva21') return appliquer('− TVA 21 %', (t) => t / 1.21);
      if (a === 'sanstva6')  return appliquer('− TVA 6 %',  (t) => t / 1.06);
    }
    const del = e.target.closest('[data-calc-del]');
    if (del) {
      // Retirer une ligne au milieu : on recalcule tout derrière, sinon
      // les totaux intermédiaires afficheraient n'importe quoi.
      const k = Number(del.dataset.calcDel);
      const restantes = LIGNES.filter((_, idx) => idx !== k);
      LIGNES.length = 0;
      let t = 0;
      for (const l of restantes) {
        if (l.valeur === null) continue;      // un taux appliqué perd son sens ici
        t = LIGNES.length === 0 ? l.valeur
          : l.operateur === '+' ? t + l.valeur
          : l.operateur === '−' ? t - l.valeur
          : l.operateur === '×' ? t * l.valeur
          : l.valeur === 0 ? t : t / l.valeur;
        LIGNES.push({ ...l, operateur: LIGNES.length === 0 ? '=' : l.operateur, total: arrondi(t) });
      }
      rendre();
    }
  });

  $('#btn-calc')?.addEventListener('click', (e) => { e.stopPropagation(); basculer(); });

  // Deux raccourcis, parce que les deux situations existent :
  //   « C » quand on lit un tableau, les mains libres ;
  //   « Alt+C » quand on est DANS un champ de montant — le moment où le
  //   besoin de calculer se fait vraiment sentir.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'c' && e.key !== 'C') return;
    if (e.ctrlKey || e.metaKey) return;
    const dansUnChamp = e.target.matches?.('input, textarea, select') || e.target.isContentEditable;
    if (dansUnChamp && !e.altKey) return;
    e.preventDefault();
    basculer();
  });

  // Le « = » accolé aux champs de montant, où qu'il soit et même créé après
  // coup : la délégation évite d'avoir à recâbler à chaque rendu.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-calc-open]');
    if (!b) return;
    e.preventDefault();
    const champ = document.getElementById(b.dataset.calcOpen);
    if (champ) { champCible = champ; champ.focus(); }
    ouvrirCalc(true);
  });
}

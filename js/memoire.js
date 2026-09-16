// =====================================================================
// memoire.js — la mémoire du poste.
//
// Tout ce qu'une secrétaire finit par savoir sans que ce soit écrit :
// quel fournisseur envoie d'une adresse bizarre, à qui téléphoner chez
// Electrolux, quoi faire quand une facture arrive en double. Ce savoir
// part avec la personne — un congé, un remplacement, et le magasin
// réapprend tout.
//
// Volontairement dépouillé : un titre, un texte. Pas de champ
// obligatoire, pas de mise en forme à apprendre. Une base de
// connaissance qui exige de remplir un formulaire ne se remplit pas.
// =====================================================================
import { supabase } from './supabase.js';
import { isManager } from './auth.js';
import {
  $, $$, escapeHtml, toast, errorMessage, confirmDialog, longDate
} from './ui.js';

let fiches = [];
let edition = null;      // id en cours d'édition, ou 'nouvelle'
let recherche = '';

const THEMES = {
  encodage: 'Encodage',
  fournisseurs: 'Fournisseurs',
  boite_mail: 'Boîte mail',
  comptabilite: 'Comptabilité',
  clients: 'Clients',
  divers: 'Divers'
};

const sansAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export async function chargerMemoire() {
  const { data, error } = await supabase.rpc('memo_list');
  if (error) throw error;
  fiches = (typeof data === 'string' ? JSON.parse(data) : data) || [];
  return fiches;
}

/** Le texte tel qu'il a été tapé : sauts de ligne conservés, rien d'autre. */
function corpsHtml(texte) {
  return escapeHtml(texte || '').replace(/\n/g, '<br>');
}

function ficheHtml(f) {
  if (edition === f.id) return formulaireHtml(f);
  return `
    <article class="memo ${f.epingle ? 'epinglee' : ''}" data-memo="${f.id}">
      <div class="memo-head">
        <span class="memo-theme">${escapeHtml(THEMES[f.theme] || 'Divers')}</span>
        <h3 class="memo-titre">${f.epingle ? '📌 ' : ''}${escapeHtml(f.title)}</h3>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" data-editer="${f.id}">Modifier</button>
      </div>
      <div class="memo-corps">${corpsHtml(f.body) || '<span class="muted">Fiche vide.</span>'}</div>
      <p class="memo-pied">
        Mis à jour par ${escapeHtml(f.updated_name || '—')}
        le ${escapeHtml(longDate(String(f.updated_at).slice(0, 10)))}
      </p>
    </article>`;
}

function formulaireHtml(f) {
  const n = f || { id: null, title: '', body: '', theme: 'divers', epingle: false };
  return `
    <article class="memo en-edition">
      <div class="memo-form">
        <input type="text" id="memo-titre" class="search" value="${escapeHtml(n.title)}"
               placeholder="De quoi parle cette fiche ?" autocomplete="off">
        <textarea id="memo-corps" rows="9" placeholder="Écris ici tout ce qu'il faut savoir.
Par exemple :
— Bermabru envoie ses factures depuis account@bermabru.be, jamais d'une autre adresse.
— Chez Electrolux, demander Nathalie au service compta pour les litiges.
— Quand une facture arrive en double, vérifier la vue Doublons avant de supprimer.">${escapeHtml(n.body)}</textarea>
        <div class="memo-form-bas">
          <select id="memo-theme">
            ${Object.entries(THEMES).map(([k, v]) =>
              `<option value="${k}" ${n.theme === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
          </select>
          <label class="check"><input type="checkbox" id="memo-epingle" ${n.epingle ? 'checked' : ''}>
            Épingler en tête</label>
          <span class="spacer"></span>
          ${n.id && isManager() ? `<button type="button" class="btn btn-sm btn-danger" data-suppr-memo="${n.id}">Supprimer</button>` : ''}
          <button type="button" class="btn btn-sm" data-annuler-memo>Annuler</button>
          <button type="button" class="btn btn-sm btn-primary" data-enregistrer="${n.id || ''}">Enregistrer</button>
        </div>
      </div>
    </article>`;
}

export async function renderMemoire() {
  const boite = $('#memoire-body');
  if (!boite) return;

  try {
    await chargerMemoire();
  } catch (err) {
    console.error(err);
    boite.innerHTML = `<div class="card pad"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  const q = sansAccent(recherche);
  const vues = q
    ? fiches.filter((f) => sansAccent(`${f.title} ${f.body} ${THEMES[f.theme]}`).includes(q))
    : fiches;

  boite.innerHTML = `
    <div class="card pad memo-barre">
      <input type="search" id="memo-recherche" class="search" value="${escapeHtml(recherche)}"
             placeholder="Chercher dans la mémoire…" aria-label="Chercher">
      <button type="button" class="btn btn-primary" id="memo-nouvelle">+ Nouvelle fiche</button>
    </div>

    ${edition === 'nouvelle' ? formulaireHtml(null) : ''}

    ${vues.length
      ? vues.map(ficheHtml).join('')
      : fiches.length
        ? `<div class="card pad"><p class="muted">Rien trouvé pour « ${escapeHtml(recherche)} ».</p></div>`
        : `<div class="card pad">
             <p class="muted">La mémoire est vide.</p>
             <p class="muted small">C'est ici qu'on écrit ce qu'on est seul à savoir : les habitudes
               d'un fournisseur, le nom de la personne à qui téléphoner, ce qu'il faut faire dans
               un cas particulier. De quoi permettre à quelqu'un d'autre de tenir le poste.</p>
           </div>`}`;

  cabler();
}

async function enregistrer(id) {
  const titre = $('#memo-titre').value.trim();
  if (!titre) { toast('Donne un titre à la fiche.', 'error'); return $('#memo-titre').focus(); }
  try {
    const { error } = await supabase.rpc('memo_save', {
      p_id: id || null,
      p_title: titre,
      p_body: $('#memo-corps').value,
      p_theme: $('#memo-theme').value,
      p_epingle: $('#memo-epingle').checked
    });
    if (error) throw error;
    edition = null;
    toast('Fiche enregistrée.');
    await renderMemoire();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Enregistrement impossible.'), 'error');
  }
}

async function supprimer(id) {
  const f = fiches.find((x) => x.id === id);
  const ok = await confirmDialog(
    `Supprimer la fiche « ${f?.title || ''} » ?\n`
    + 'Ce qui y est écrit disparaît, et personne ne pourra le retrouver.',
    'Supprimer');
  if (!ok) return;
  try {
    const { error } = await supabase.from('memo').delete().eq('id', id);
    if (error) throw error;
    edition = null;
    toast('Fiche supprimée.');
    await renderMemoire();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Suppression impossible.'), 'error');
  }
}

function cabler() {
  const boite = $('#memoire-body');
  if (!boite) return;

  $('#memo-recherche')?.addEventListener('input', (e) => {
    recherche = e.target.value;
    const pos = e.target.selectionStart;
    renderMemoire().then(() => {
      const c = $('#memo-recherche');
      if (c) { c.focus(); c.setSelectionRange(pos, pos); }
    });
  });

  $('#memo-nouvelle')?.addEventListener('click', () => {
    edition = 'nouvelle';
    renderMemoire().then(() => $('#memo-titre')?.focus());
  });

  if (boite.dataset.cable) return;
  boite.dataset.cable = '1';
  boite.addEventListener('click', (e) => {
    const b = e.target.closest('[data-editer],[data-enregistrer],[data-annuler-memo],[data-suppr-memo]');
    if (!b) return;
    if (b.dataset.editer !== undefined && b.dataset.editer) {
      edition = b.dataset.editer;
      return renderMemoire().then(() => $('#memo-titre')?.focus());
    }
    if (b.dataset.enregistrer !== undefined) return enregistrer(b.dataset.enregistrer);
    if (b.hasAttribute('data-annuler-memo')) { edition = null; return renderMemoire(); }
    if (b.dataset.supprMemo) return supprimer(b.dataset.supprMemo);
  });
}

export function initMemoire() { /* tout se câble au rendu */ }

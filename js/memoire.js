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

// Ce que le stockage accepte. La même liste vit côté serveur sur le
// bucket : celle-ci n'est là que pour prévenir avant l'envoi plutôt
// qu'après, une limite côté navigateur n'étant pas une limite.
const TAILLE_MAX = 25 * 1024 * 1024;
const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', txt: 'text/plain',
  csv: 'text/csv', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

/** Documents choisis avant que la fiche existe : ils partent après l'enregistrement. */
let enAttente = [];

const extension = (nom) => String(nom || '').split('.').pop().toLowerCase();

/**
 * Le type déclaré par le navigateur, ou déduit de l'extension.
 * Safari sur iPhone annonce parfois « application/octet-stream » pour un
 * PDF pris en photo depuis Fichiers, et le stockage le refuserait.
 */
const typeDe = (f) => (TYPES[extension(f.name)] || f.type || 'application/octet-stream');

function poids(n) {
  const o = Number(n) || 0;
  if (o < 1024) return `${o} o`;
  if (o < 1024 * 1024) return `${Math.round(o / 1024)} ko`;
  return `${(o / (1024 * 1024)).toFixed(1)} Mo`.replace('.', ',');
}

/** Un nom de fichier sûr, sans accents ni espaces, mais encore lisible. */
function cheminSur(memoId, nom) {
  const base = sansAccent(nom).replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80);
  return `${memoId}/${crypto.randomUUID()}-${base || 'document'}`;
}

const ICONE = (mime, nom) => {
  const e = extension(nom);
  if (/pdf/.test(mime || '') || e === 'pdf') return '📄';
  if (/^image\//.test(mime || '')) return '🖼';
  if (['xls', 'xlsx', 'csv'].includes(e)) return '▦';
  if (['doc', 'docx'].includes(e)) return '✎';
  return '📎';
};

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

/**
 * Les documents attachés à une fiche.
 *
 * Visibles hors édition : un mode d'emploi qu'il faut d'abord « modifier »
 * pour apercevoir ne serait jamais ouvert. Ils s'ouvrent dans un onglet,
 * par lien signé et temporaire — rien n'est public.
 */
function fichiersHtml(f, enEdition) {
  const liste = f.fichiers || [];
  if (!liste.length && !enEdition) return '';
  return `
    <div class="memo-fichiers">
      ${liste.map((d) => `
        <span class="memo-fichier">
          <button type="button" class="memo-fichier-ouvrir" data-ouvrir-doc="${d.path}"
                  title="Ouvrir ${escapeHtml(d.name)}">
            ${ICONE(d.mime, d.name)} ${escapeHtml(d.name)}
            <small>${poids(d.size_bytes)}</small>
          </button>
          ${enEdition && isManager()
            ? `<button type="button" class="memo-fichier-oter" data-oter-doc="${d.id}"
                       title="Retirer ce document" aria-label="Retirer ${escapeHtml(d.name)}">×</button>`
            : ''}
        </span>`).join('')}
    </div>`;
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
      ${fichiersHtml(f, false)}
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
        ${fichiersHtml(n, true)}

        <!-- Le mode d'emploi d'un fournisseur, la notice d'un appareil, la
             procédure d'un logiciel : ce qui arrive en PDF et qui, sinon,
             reste dans une boîte mail que le remplaçant n'aura pas. -->
        <div class="memo-joindre">
          <label class="btn btn-sm" for="memo-fichier">＋ Joindre un document</label>
          <input type="file" id="memo-fichier" multiple hidden
                 accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.txt,.csv,.doc,.docx,.xls,.xlsx">
          <span class="muted small">PDF, image, Word ou Excel — 25 Mo par fichier</span>
          <span id="memo-envoi" class="muted small"></span>
        </div>
        ${enAttente.length ? `
          <p class="memo-attente">${enAttente.length} document(s) partiront à l'enregistrement :
            ${enAttente.map((f) => escapeHtml(f.name)).join(', ')}</p>` : ''}

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

/**
 * Dépose un document et le rattache à la fiche.
 *
 * L'objet part d'abord vers le stockage, la ligne ensuite : la fonction
 * de rattachement refuse un chemin qui n'existe pas, ce qui garantit
 * qu'aucune fiche ne promet un document introuvable. Si le rattachement
 * échoue, l'objet déposé est retiré — mieux vaut rien qu'un orphelin.
 */
async function envoyerDocument(memoId, fichier) {
  if (fichier.size > TAILLE_MAX) {
    throw new Error(`« ${fichier.name} » pèse ${poids(fichier.size)}, au-delà des 25 Mo autorisés.`);
  }
  const chemin = cheminSur(memoId, fichier.name);
  // Le navigateur envoie le fichier en multipart, et c'est le type porté
  // par le fichier LUI-MÊME qui fait foi — l'option contentType n'est pas
  // lue dans ce cas. Or Safari sur iPhone annonce volontiers
  // « application/octet-stream » pour un PDF pris depuis Fichiers, et le
  // stockage le refuserait sans que personne comprenne pourquoi. On
  // reconstruit donc le fichier avec le type déduit de son extension.
  const type = typeDe(fichier);
  const corps = fichier.type === type ? fichier : new File([fichier], fichier.name, { type });
  const { error: errUp } = await supabase.storage.from('memoire')
    .upload(chemin, corps, { contentType: type, upsert: false });
  if (errUp) {
    throw new Error(/mime|type/i.test(errUp.message || '')
      ? `Ce type de fichier n'est pas accepté : ${fichier.name}`
      : errorMessage(errUp, `Envoi de « ${fichier.name} » impossible.`));
  }
  const { error } = await supabase.rpc('memo_file_add', {
    p_memo: memoId, p_path: chemin, p_name: fichier.name,
    p_mime: typeDe(fichier), p_size: fichier.size
  });
  if (error) {
    await supabase.storage.from('memoire').remove([chemin]);
    throw error;
  }
}

/** Envoie une série de documents en montrant où l'on en est. */
async function envoyerSerie(memoId, fichiers) {
  const compteur = $('#memo-envoi');
  let n = 0;
  for (const f of fichiers) {
    if (compteur) compteur.textContent = `Envoi ${++n}/${fichiers.length} — ${f.name}…`;
    await envoyerDocument(memoId, f);
  }
  if (compteur) compteur.textContent = '';
}

/** Ouvre un document par lien signé, valable une heure. */
async function ouvrirDocument(chemin) {
  try {
    const { data, error } = await supabase.storage.from('memoire').createSignedUrl(chemin, 3600);
    if (error) throw error;
    window.open(data.signedUrl, '_blank', 'noopener');
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Document introuvable.'), 'error');
  }
}

async function oterDocument(id) {
  const ok = await confirmDialog(
    'Retirer ce document de la fiche ?\nIl sera effacé du stockage et ne sera pas récupérable.',
    'Retirer');
  if (!ok) return;
  try {
    const { data, error } = await supabase.rpc('memo_file_remove', { p_id: id });
    if (error) throw error;
    const chemin = (typeof data === 'string' ? JSON.parse(data) : data)?.path;
    if (chemin) await supabase.storage.from('memoire').remove([chemin]);
    toast('Document retiré.');
    await renderMemoire();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Retrait impossible.'), 'error');
  }
}

async function enregistrer(id) {
  const titre = $('#memo-titre').value.trim();
  if (!titre) { toast('Donne un titre à la fiche.', 'error'); return $('#memo-titre').focus(); }
  try {
    const { data, error } = await supabase.rpc('memo_save', {
      p_id: id || null,
      p_title: titre,
      p_body: $('#memo-corps').value,
      p_theme: $('#memo-theme').value,
      p_epingle: $('#memo-epingle').checked
    });
    if (error) throw error;

    // Les documents choisis avant que la fiche existe partent maintenant
    // qu'elle a un identifiant. Un échec ici ne doit pas faire croire que
    // la fiche n'a pas été enregistrée : elle l'est.
    if (enAttente.length) {
      const cible = id || (typeof data === 'string' ? JSON.parse(data) : data)?.id;
      const aEnvoyer = enAttente;
      enAttente = [];
      try {
        await envoyerSerie(cible, aEnvoyer);
      } catch (e) {
        console.error(e);
        toast(`Fiche enregistrée, mais ${errorMessage(e, 'un document n\'est pas parti.')}`, 'error');
      }
    }

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
    enAttente = [];
    renderMemoire().then(() => $('#memo-titre')?.focus());
  });

  // Choisir un document : il part tout de suite si la fiche existe déjà,
  // il attend l'enregistrement sinon. Dans les deux cas, on ne demande
  // rien de plus à l'utilisateur.
  $('#memo-fichier')?.addEventListener('change', async (e) => {
    const choisis = [...e.target.files];
    e.target.value = '';
    if (!choisis.length) return;

    const trop = choisis.find((f) => f.size > TAILLE_MAX);
    if (trop) return toast(`« ${trop.name} » pèse ${poids(trop.size)} : la limite est de 25 Mo.`, 'error');

    if (edition === 'nouvelle') {
      enAttente = [...enAttente, ...choisis];
      // On garde la saisie en cours : re-rendre effacerait le titre tapé.
      const zone = $('.memo-attente');
      const texte = `${enAttente.length} document(s) partiront à l'enregistrement : `
        + enAttente.map((f) => f.name).join(', ');
      if (zone) zone.textContent = texte;
      else $('#memo-envoi').textContent = texte;
      return;
    }

    try {
      await envoyerSerie(edition, choisis);
      toast(choisis.length > 1 ? `${choisis.length} documents joints.` : 'Document joint.');
      await renderMemoire();
    } catch (err) {
      console.error(err);
      $('#memo-envoi').textContent = '';
      toast(errorMessage(err, 'Envoi impossible.'), 'error');
    }
  });

  if (boite.dataset.cable) return;
  boite.dataset.cable = '1';
  boite.addEventListener('click', (e) => {
    const b = e.target.closest('[data-editer],[data-enregistrer],[data-annuler-memo],'
      + '[data-suppr-memo],[data-ouvrir-doc],[data-oter-doc]');
    if (!b) return;
    if (b.dataset.ouvrirDoc) return ouvrirDocument(b.dataset.ouvrirDoc);
    if (b.dataset.oterDoc) return oterDocument(b.dataset.oterDoc);
    if (b.dataset.editer !== undefined && b.dataset.editer) {
      edition = b.dataset.editer;
      enAttente = [];
      return renderMemoire().then(() => $('#memo-titre')?.focus());
    }
    if (b.dataset.enregistrer !== undefined) return enregistrer(b.dataset.enregistrer);
    if (b.hasAttribute('data-annuler-memo')) { edition = null; enAttente = []; return renderMemoire(); }
    if (b.dataset.supprMemo) return supprimer(b.dataset.supprMemo);
  });
}

export function initMemoire() { /* tout se câble au rendu */ }

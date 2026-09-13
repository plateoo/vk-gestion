// =====================================================================
// help.js — l'aide, dans l'application.
//
// Une seule source : le mode d'emploi lui-même. Le texte n'est recopié
// nulle part, il est lu dans guide.html et découpé en sections. Un guide
// et une aide qui se contrediraient seraient pires que l'un des deux
// seul — et c'est ce qui finit toujours par arriver quand on duplique.
//
// L'aide s'ouvre sur le sujet de l'écran où l'on se trouve : chercher
// « comment je fais » quand on est déjà au bon endroit est une perte de
// temps.
// =====================================================================
import { $, $$, escapeHtml, openModal, closeModal, toast } from './ui.js';

let sections = null;      // [{ id, titre, texte, html, gerant }]
let chargement = null;

/** Écran affiché -> section d'aide la plus utile */
const PAR_ECRAN = {
  dashboard: 'parcours',
  planning: 'planning',
  review: 'controler',
  invoices: 'parcours',
  suppliers: 'fournisseurs',
  payments: 'paiement',
  settings: 'email',
  admin: 'sauvegardes'
};

/**
 * Lit le mode d'emploi et le découpe. Une seule fois par session : le
 * fichier ne change pas sous les pieds de l'utilisateur.
 */
async function charger() {
  if (sections) return sections;
  if (chargement) return chargement;
  chargement = (async () => {
    const r = await fetch('guide.html', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`guide indisponible (${r.status})`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    sections = [...doc.querySelectorAll('.guide-content section')].map((s) => {
      const h2 = s.querySelector('h2');
      const titre = (h2?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        id: s.id,
        // « 4. Contrôler une facture » -> « Contrôler une facture »
        titre: titre.replace(/^\d+\.\s*/, '').replace(/\s*gérant\s*$/i, '').trim(),
        gerant: /gérant/i.test(h2?.querySelector('.tag')?.textContent || ''),
        texte: (s.textContent || '').replace(/\s+/g, ' ').trim(),
        html: s.innerHTML
      };
    }).filter((s) => s.id && s.titre);
    chargement = null;
    return sections;
  })();
  return chargement;
}

/** Découpe la requête en mots, sans accents : « contrôler » trouve « controler » */
const sansAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function chercher(q) {
  const mots = sansAccent(q).split(/\s+/).filter((m) => m.length > 2);
  if (!mots.length) return sections;
  return sections
    .map((s) => {
      const titre = sansAccent(s.titre);
      const texte = sansAccent(s.texte);
      // Le titre pèse plus lourd que le corps : chercher « paiement »
      // doit d'abord proposer la section qui s'appelle ainsi.
      let score = 0;
      for (const m of mots) {
        if (titre.includes(m)) score += 10;
        const n = texte.split(m).length - 1;
        score += Math.min(n, 5);
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

/** Extrait de texte autour du premier mot trouvé, pour situer le résultat */
function extrait(section, q) {
  const mots = sansAccent(q).split(/\s+/).filter((m) => m.length > 2);
  const texte = section.texte;
  if (!mots.length) return texte.slice(0, 120) + '…';
  const pos = sansAccent(texte).indexOf(mots[0]);
  if (pos < 0) return texte.slice(0, 120) + '…';
  const debut = Math.max(0, pos - 50);
  return (debut ? '…' : '') + texte.slice(debut, debut + 150) + '…';
}

// ---------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------
function rendreListe(q = '') {
  const liste = $('#help-list');
  if (!liste) return;
  const trouvees = chercher(q);

  if (!trouvees.length) {
    liste.innerHTML = `
      <div class="empty">
        <p>Rien trouvé pour « ${escapeHtml(q)} ».</p>
        <p class="muted small">Essaie un autre mot, ou ouvre le mode d'emploi complet.</p>
      </div>`;
    return;
  }

  liste.innerHTML = trouvees.map((s) => `
    <button type="button" class="help-item" data-help-section="${s.id}">
      <span class="help-item-title">${escapeHtml(s.titre)}${s.gerant ? ' <span class="tag">gérant</span>' : ''}</span>
      ${q ? `<span class="help-item-snippet">${escapeHtml(extrait(s, q))}</span>` : ''}
    </button>`).join('');
}

function afficherSection(id) {
  const s = sections?.find((x) => x.id === id);
  const vue = $('#help-article');
  if (!s || !vue) return;
  vue.innerHTML = s.html;
  vue.hidden = false;
  $('#help-browse').hidden = true;
  $('#help-back').hidden = false;
  $('#help-title').textContent = s.titre;
  vue.scrollTop = 0;
}

function revenirListe() {
  $('#help-article').hidden = true;
  $('#help-browse').hidden = false;
  $('#help-back').hidden = true;
  $('#help-title').textContent = 'Aide';
  $('#help-search')?.focus();
}

// ---------------------------------------------------------------------
// Ouverture
// ---------------------------------------------------------------------
export async function ouvrirAide(ecran = null) {
  openModal('modal-help');
  $('#help-search').value = '';
  const liste = $('#help-list');
  liste.innerHTML = '<div class="muted small" style="padding:12px">Chargement de l\'aide…</div>';
  revenirListe();

  try {
    await charger();
  } catch (err) {
    console.error(err);
    liste.innerHTML = `<div class="empty"><p>L'aide n'a pas pu être chargée.</p>
      <p class="muted small">Le mode d'emploi reste accessible en entier dans un nouvel onglet.</p></div>`;
    return;
  }

  rendreListe('');
  // On ouvre directement sur le sujet de l'écran où l'on se trouve.
  const cible = ecran && PAR_ECRAN[ecran];
  if (cible && sections.some((s) => s.id === cible)) afficherSection(cible);
  else $('#help-search').focus();
}

export function initHelp(onTour, onShortcuts, ecranActif) {
  const modal = $('#modal-help');
  if (!modal) return;

  $('#btn-help').addEventListener('click', (e) => {
    e.stopPropagation();
    ouvrirAide(typeof ecranActif === 'function' ? ecranActif() : null);
  });

  $('#help-search').addEventListener('input', (e) => {
    if (!$('#help-article').hidden) revenirListe();
    rendreListe(e.target.value.trim());
  });

  modal.addEventListener('click', (e) => {
    const item = e.target.closest('[data-help-section]');
    if (item) return afficherSection(item.dataset.helpSection);

    const act = e.target.closest('[data-help-act]')?.dataset.helpAct;
    if (act === 'back') return revenirListe();
    if (act === 'guide') {
      window.open('guide.html', '_blank', 'noopener');
      return;
    }
    // Deux pages à imprimer et à poser près du clavier, pour les premiers
    // jours. Le mode d'emploi complet reste à côté, pour le reste.
    if (act === 'demarrage') {
      window.open('demarrage.html', '_blank', 'noopener');
      return;
    }
    if (act === 'tour') { closeModal('modal-help'); return onTour?.(); }
    if (act === 'keys') { closeModal('modal-help'); return onShortcuts?.(); }
    if (act === 'print') {
      // Imprimer la seule section lue, plutôt que les seize.
      const s = sections?.find((x) => x.titre === $('#help-title').textContent);
      if (!s) return toast('Ouvre d\'abord un sujet.', 'error');
      const w = window.open('', '_blank', 'noopener,width=800,height=900');
      if (!w) return toast('La fenêtre d\'impression a été bloquée.', 'error');
      w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
        <title>${escapeHtml(s.titre)} — VK Gestion</title>
        <link rel="stylesheet" href="css/style.css"></head>
        <body class="guide-body"><div class="guide"><main class="guide-content">
        <h1 class="guide-title">${escapeHtml(s.titre)}</h1>${s.html}</main></div></body></html>`);
      w.document.close();
      w.addEventListener('load', () => w.print());
    }
  });
}

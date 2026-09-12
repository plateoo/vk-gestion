// =====================================================================
// courrier.js — l'aperçu du courrier, sur la page d'accueil.
//
// Ce qui est arrivé, résumé, trié par ce qui mérite un regard. Aucun
// message n'est déplacé : on regarde, c'est tout.
//
// Le parti pris : montrer PEU. Ce qui compte est détaillé, le courant est
// détaillé après, et le négligeable est seulement compté. Un aperçu qui
// affiche tout n'est plus un aperçu, c'est une seconde boîte mail — et
// personne n'a besoin de deux.
// =====================================================================
import { supabase } from './supabase.js';
import { isManager } from './auth.js';
import { $, $$, escapeHtml, toast, errorMessage, longDate } from './ui.js';

let apercu = null;

const CATEGORIES = {
  facture: 'Facture',
  fournisseur: 'Fournisseur',
  client: 'Client',
  administratif: 'Administration',
  banque: 'Banque',
  personnel: 'Personnel',
  publicite: 'Publicité',
  autre: 'Autre'
};

/** « aujourd'hui à 14:32 », « hier à 09:05 », sinon la date */
function quand(iso) {
  if (!iso) return '';
  const d = String(iso);
  const jour = d.slice(0, 10);
  const heure = d.slice(11, 16);
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (jour === aujourdhui) return `aujourd'hui à ${heure}`;
  if (jour === hier) return `hier à ${heure}`;
  return `${longDate(jour)} à ${heure}`;
}

function ligne(m) {
  const prive = m.category === 'personnel';
  return `
    <li class="courrier-item ${m.seen_at ? 'vu' : ''} ${m.importance === 'haute' ? 'urgent' : ''}">
      <div class="courrier-main">
        <span class="courrier-de">${prive
          ? '<em class="muted">Courrier personnel</em>'
          : escapeHtml(m.sender_name || m.sender_email || '—')}</span>
        <span class="courrier-objet">${prive ? '' : escapeHtml(m.subject || '(sans objet)')}</span>
        ${m.summary ? `<span class="courrier-resume">${escapeHtml(m.summary)}</span>` : ''}
      </div>
      <div class="courrier-cote">
        <span class="courrier-cat">${escapeHtml(CATEGORIES[m.category] || 'Autre')}</span>
        ${m.action ? `<span class="courrier-action">${escapeHtml(m.action)}</span>` : ''}
        <span class="courrier-quand muted small">${escapeHtml(quand(m.received_at))}</span>
        ${m.invoice_id ? '<span class="tag">déjà en facture</span>' : ''}
      </div>
    </li>`;
}

export async function renderCourrier() {
  const boite = $('#courrier');
  if (!boite) return;
  // Le courrier de l'entreprise ne regarde que le gérant.
  if (!isManager()) { boite.hidden = true; return; }

  try {
    const { data, error } = await supabase.rpc('courrier_apercu', { p_jours: 7 });
    if (error) throw error;
    apercu = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {
    console.warn('aperçu du courrier indisponible', err);
    boite.hidden = true;
    return;
  }

  // Tant que le flux n'est pas branché, ce bloc n'a rien à dire : il se
  // tait plutôt que d'afficher un zéro qui ressemblerait à une panne.
  if (!apercu || !Number(apercu.total)) { boite.hidden = true; return; }

  const importants = apercu.importants || [];
  const courants = apercu.courants || [];
  const nonVus = Number(apercu.non_vus) || 0;
  const negligeable = Number(apercu.sans_importance) || 0;

  boite.hidden = false;
  boite.innerHTML = `
    <div class="card-head">
      <h2>Courrier</h2>
      <p class="muted small">${apercu.total} message${Number(apercu.total) > 1 ? 's' : ''} sur sept jours${
        nonVus ? ` · <strong>${nonVus} pas encore vu${nonVus > 1 ? 's' : ''}</strong>` : ''}</p>
      <span class="spacer"></span>
      ${nonVus ? '<button type="button" class="btn btn-sm" id="courrier-vu">Tout marquer comme vu</button>' : ''}
    </div>

    <div class="pad">
      ${importants.length ? `
        <p class="courrier-titre">À regarder</p>
        <ul class="courrier-liste">${importants.map(ligne).join('')}</ul>`
        : '<p class="courrier-rien">Rien d\'urgent sur les sept derniers jours.</p>'}

      ${courants.length ? `
        <p class="courrier-titre">Le courant</p>
        <ul class="courrier-liste">${courants.slice(0, 8).map(ligne).join('')}</ul>
        ${courants.length > 8 ? `<p class="muted small">… et ${courants.length - 8} autre(s).</p>` : ''}` : ''}

      ${negligeable ? `
        <p class="courrier-negligeable">
          ${negligeable} message${negligeable > 1 ? 's' : ''} sans importance — publicités,
          newsletters, accusés de réception. Non détaillé${negligeable > 1 ? 's' : ''} ici.
        </p>` : ''}
    </div>`;

  $('#courrier-vu')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { error } = await supabase.rpc('courrier_vu', { p_ids: null });
      if (error) throw error;
      renderCourrier();
    } catch (err) {
      console.error(err);
      e.target.disabled = false;
      toast(errorMessage(err, 'Impossible de marquer le courrier.'), 'error');
    }
  });
}

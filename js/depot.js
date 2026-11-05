// =====================================================================
// depot.js — déposer une facture à la main, et voir les mails qui n'ont
// donné aucune facture.
//
// La boîte mail reste le chemin normal. Mais certaines factures n'en
// sortent pas : mail transféré « en pièce jointe » (la facture est dans un
// mail imbriqué que Power Automate ne déballe pas), lien de
// téléchargement, facture dans le corps du mail, papier. Le bureau les
// dépose ici : elles suivent exactement le chemin d'un mail — extraction,
// rapprochement, puis « À contrôler ».
//
// Les mails arrivés dans le dossier Factures sans pièce lisible ne
// disparaissent plus en silence : ils sont listés, avec « Déposer la
// facture » et « Écarter ».
// =====================================================================
import { supabase } from './supabase.js';
import { $, $$, escapeHtml, toast, errorMessage, fmtDate, notifyDataChange } from './ui.js';

const ACCEPTE = '.pdf,.xml,application/pdf,application/xml,text/xml,image/*';
const MAX_OCTETS = 15 * 1024 * 1024;
let noteDepot = '';          // l'objet du mail d'origine, s'il y en a un
let mails = [];

/** Un fichier en base64, sans l'en-tête « data:…;base64, » */
function enBase64(fichier) {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^;]*;base64,/, ''));
    r.onerror = () => ko(r.error);
    r.readAsDataURL(fichier);
  });
}

async function deposer(fichiers) {
  const liste = [...fichiers];
  if (!liste.length) return;
  const total = liste.reduce((s, f) => s + f.size, 0);
  if (total > MAX_OCTETS) return toast('Dépôt trop lourd : 15 Mo au plus en une fois.', 'error');
  if (liste.length > 10) return toast('10 fichiers au plus par dépôt.', 'error');
  const boutons = $$('.js-deposer');
  boutons.forEach((b) => { b.disabled = true; });
  toast(`Envoi de ${liste.length} fichier${liste.length > 1 ? 's' : ''}…`, 'ok', 2500);
  try {
    const files = await Promise.all(liste.map(async (f) => ({ name: f.name, type: f.type, b64: await enBase64(f) })));
    const { data, error } = await supabase.functions.invoke('deposer-factures', { body: { files, note: noteDepot } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    toast(`${data.files} fichier${data.files > 1 ? 's' : ''} déposé${data.files > 1 ? 's' : ''}. Lecture en cours : `
      + 'la facture arrive dans « À contrôler » d\'ici une minute.', 'ok', 7000);
    // L'extraction prend 10 à 20 s par pièce : on rafraîchit ensuite.
    setTimeout(notifyDataChange, 25000);
    setTimeout(notifyDataChange, 60000);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, err.message || 'Dépôt impossible.'), 'error');
  } finally {
    noteDepot = '';
    boutons.forEach((b) => { b.disabled = false; });
  }
}

/** Ouvre le choix de fichiers ; la note accompagne le dépôt (objet du mail). */
export function choisirFichiers(note = '') {
  noteDepot = note;
  const input = $('#depot-input');
  input.value = '';
  input.click();
}

// ---------------------------------------------------------------------
// Les mails sans facture
// ---------------------------------------------------------------------
export async function renderMailsSansFacture() {
  const boite = $('#mails-sans-facture');
  if (!boite) return;
  try {
    const { data, error } = await supabase.rpc('mails_sans_facture');
    if (error) throw error;
    mails = (typeof data === 'string' ? JSON.parse(data) : data) || [];
  } catch (err) {
    // Avant la migration 0043, la fonction n'existe pas : rien à montrer.
    console.warn(err);
    boite.hidden = true;
    return;
  }
  boite.hidden = !mails.length;
  if (!mails.length) { boite.innerHTML = ''; return; }
  boite.innerHTML = `
    <details class="card pad msf" ${mails.length <= 3 ? 'open' : ''}>
      <summary><strong>${mails.length} mail${mails.length > 1 ? 's' : ''} sans facture lisible</strong>
        <span class="muted small">— arrivé${mails.length > 1 ? 's' : ''} dans le dossier Factures, rien n'a pu être lu</span></summary>
      <p class="small muted">La facture est souvent dans un mail transféré « en pièce jointe », derrière un lien, ou dans le corps du
        message. Ouvre le mail dans Outlook, enregistre la facture (PDF ou photo) et dépose-la : elle sera lue comme si elle était
        arrivée par mail. Si ce n'est pas une facture (rappel, notification), écarte-le.</p>
      <ul class="msf-liste">
        ${mails.map((m) => `
          <li class="msf-ligne">
            <div class="msf-texte">
              <strong>${escapeHtml(m.subject || '(sans objet)')}</strong>
              <span class="muted small">${escapeHtml(m.sender_email || '—')} · ${escapeHtml(fmtDate(String(m.recu).slice(0, 10)))}${
                Number(m.deliveries) > 1 ? ` · relevé ${m.deliveries} fois` : ''}</span>
            </div>
            <div class="msf-actions">
              <button type="button" class="btn btn-sm btn-primary js-deposer" data-deposer-pour="${m.id}">⇪ Déposer la facture</button>
              <button type="button" class="btn btn-sm btn-ghost" data-ecarter="${m.id}">Écarter</button>
            </div>
          </li>`).join('')}
      </ul>
    </details>`;
}

async function ecarter(id) {
  const { error } = await supabase.rpc('mail_sans_facture_ecarter', { p_id: id });
  if (error) return toast(errorMessage(error, 'Impossible d\'écarter ce mail.'), 'error');
  toast('Mail écarté.', 'ok', 1500);
  renderMailsSansFacture();
}

export function initDepot() {
  const input = $('#depot-input');
  if (!input) return;
  input.accept = ACCEPTE;
  input.addEventListener('change', () => deposer(input.files));

  document.addEventListener('click', (e) => {
    const pour = e.target.closest('[data-deposer-pour]');
    if (pour) {
      const m = mails.find((x) => x.id === pour.dataset.deposerPour);
      return choisirFichiers(m ? `mail « ${m.subject || ''} » de ${m.sender_email || ''}` : '');
    }
    if (e.target.closest('.js-deposer')) return choisirFichiers();
    const ec = e.target.closest('[data-ecarter]');
    if (ec) ecarter(ec.dataset.ecarter);
  });

  // Glisser-déposer sur les écrans des factures
  for (const sel of ['#tab-review', '#tab-invoices']) {
    const zone = $(sel);
    if (!zone) continue;
    zone.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      zone.classList.add('depot-survol');
    });
    zone.addEventListener('dragleave', (e) => { if (e.target === zone) zone.classList.remove('depot-survol'); });
    zone.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      zone.classList.remove('depot-survol');
      noteDepot = '';
      deposer(e.dataTransfer.files);
    });
  }
}

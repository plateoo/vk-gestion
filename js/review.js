// =====================================================================
// review.js — file « À contrôler » : document d'origine à gauche,
// champs extraits à droite, modifiables.
//
// Règle centrale : le taux de TVA est un champ à part entière, visible et
// modifiable. Il n'est jamais déduit en silence. S'il ne correspond pas au
// rapport TVA / HTVA lu sur le document, il passe en rouge et la
// validation est bloquée tant que Marie n'a pas tranché.
// =====================================================================
import { supabase } from './supabase.js';
import { getSuppliers, suppliersCache } from './suppliers.js';
import { invalidateInvoices } from './invoices.js';
import {
  $, $$, fmtEUR, fmtDate, escapeHtml, toast, errorMessage, confirmDialog,
  todayISO, notifyDataChange, ICONS, LEGAL_RATES, vatMismatch, longDate
} from './ui.js';
import { isManager, displayName } from './auth.js';

let queue = [];          // factures en attente de contrôle
let current = null;      // facture ouverte
let signedUrl = null;    // lien signé du document affiché
let confirmed = new Set(); // champs douteux explicitement confirmés par l'utilisateur
let fromInvoices = false;  // ouvert depuis le tableau : liste de gauche masquée
// Marie encode dans Smart fournisseur par fournisseur : elle a besoin de
// grouper la file comme elle travaille, pas comme les messages sont arrivés.
let tri = { fournisseur: '', ordre: 'date' };   // 'date' | 'fournisseur'

// ---------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------
export async function loadReviewQueue() {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, supplier:suppliers(id, name, vat_number, needs_review)')
    .eq('review_status', 'a_controler')
    .order('created_at', { ascending: false });
  if (error) throw error;
  queue = (data || []).map((r) => ({ ...r, supplier_name: r.supplier?.name || '—', meta: parseNotes(r.extraction_notes) }));
  // Les extractions en échec passent devant : ce sont elles qui demandent le plus de travail.
  queue.sort((a, b) => (b.meta.failed ? 1 : 0) - (a.meta.failed ? 1 : 0));
  return queue;
}

function parseNotes(raw) {
  try {
    const n = JSON.parse(raw || '{}');
    return {
      notes: n.notes || null,
      failed: n.notes === 'échec extraction',
      source: n.source || null,
      alerts: Array.isArray(n.alerts) ? n.alerts : [],
      uncertain: Array.isArray(n.champs_incertains) ? n.champs_incertains : [],
      comment: n.commentaire || null,
      rapprochement: n.rapprochement || {},
      brut: n.brut || {}
    };
  } catch {
    return { notes: null, failed: false, source: null, alerts: [], uncertain: [], comment: null, rapprochement: {}, brut: {} };
  }
}

export function reviewCount() { return queue.length; }

/**
 * Cette facture peut-elle être validée sans qu'on l'ouvre ?
 *
 * Uniquement si l'extraction n'a RIEN laissé en suspens : fournisseur
 * identifié, numéro lu, date, montant, taux légal cohérent avec la TVA du
 * document, aucun champ incertain, aucune alerte, aucun IBAN divergent.
 *
 * Les mêmes conditions que la validation à l'unité, appliquées aux
 * données plutôt qu'aux champs à l'écran. Au moindre doute, la facture
 * reste à ouvrir : c'est le sens du filtre, pas une formalité.
 */
export function validableSansOuvrir(i) {
  const m = i.meta || {};
  if (m.failed) return false;
  if (m.alerts?.length || m.uncertain?.length) return false;
  if (m.rapprochement?.iban_divergent) return false;
  if (!i.supplier_id || i.supplier?.needs_review) return false;
  if (i.supplier_name === 'À identifier') return false;
  if (!i.invoice_number || /^SANS-NUMERO/i.test(i.invoice_number)) return false;
  if (!i.invoice_date) return false;
  if (!(Number(i.amount_htva) > 0)) return false;
  const taux = Number(i.vat_rate);
  if (!LEGAL_RATES.includes(taux)) return false;
  // Le contrôle de TVA reste bloquant : si le rapport TVA / HTVA du
  // document contredit le taux enregistré, on n'y touche pas en série.
  if (vatMismatch(Number(i.amount_htva), Number(m.brut?.montant_tva), taux) === true) return false;
  return true;
}

/**
 * Valide en série les factures que l'extraction a lues sans réserve.
 *
 * Elles partent SANS référence Smart : ce numéro n'est pas sur le
 * document, il s'attribue à l'encodage. Il se saisit ensuite directement
 * dans la ligne du tableau des factures, ce qui est bien plus rapide que
 * d'ouvrir chaque document pour ne rien y corriger d'autre.
 */
async function validerSansReserve() {
  const lot = queue.filter(validableSansOuvrir);
  if (!lot.length) return toast('Aucune facture ne peut être validée sans être ouverte.', 'error');

  const total = lot.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  const apercu = lot.slice(0, 8)
    .map((i) => `• ${i.supplier_name} · ${i.invoice_number} · ${fmtEUR(i.amount_tvac)}`).join('\n');
  const ok = await confirmDialog(
    `Valider ${lot.length} facture(s) sans les ouvrir ?\n`
    + `${fmtEUR(total)} au total. Ce sont celles que l'extraction a lues sans la moindre réserve :\n`
    + apercu + (lot.length > 8 ? `\n… et ${lot.length - 8} autre(s)` : '')
    + '\n\nElles passeront dans les factures, sans référence Smart — tu la saisiras directement dans le tableau.',
    `Valider les ${lot.length}`);
  if (!ok) return;

  const bouton = $('#rv-bulk');
  if (bouton) { bouton.disabled = true; bouton.textContent = 'Validation…'; }

  let faites = 0;
  const soucis = [];
  for (const i of lot) {
    // L'échéance se déduit des conditions du fournisseur quand le document
    // ne la porte pas — exactement comme à la validation à l'unité.
    let echeance = i.due_date;
    if (!echeance && i.invoice_date) {
      const sup = suppliersCache().find((x) => x.id === i.supplier_id);
      if (sup?.payment_terms) {
        const d = new Date(i.invoice_date);
        d.setDate(d.getDate() + Number(sup.payment_terms));
        echeance = d.toISOString().slice(0, 10);
      }
    }
    const { error } = await supabase.from('invoices')
      .update({ review_status: 'valide', due_date: echeance || null })
      .eq('id', i.id);
    if (error) soucis.push(`${i.invoice_number} : ${errorMessage(error, 'refusée')}`);
    else faites++;
  }

  toast(soucis.length
    ? `${faites} validée(s), ${soucis.length} refusée(s) : ${soucis[0]}`
    : `${faites} facture(s) validées. Saisis maintenant les références Smart dans le tableau.`,
    soucis.length ? 'error' : 'success');
  invalidateInvoices();
  notifyDataChange();
  renderReview();
}

/**
 * Ouvre UNE pièce, quelle qu'elle soit, depuis le tableau des factures :
 * document d'origine à gauche, champs à droite, sur la même page. La liste
 * de gauche est masquée — le tableau qu'on vient de quitter la remplace.
 *
 * Fonctionne aussi sur une facture déjà validée : c'est l'écran de
 * consultation et de correction, plus seulement celui du premier contrôle.
 */
export async function openDocument(id, showTab) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, supplier:suppliers(id, name, vat_number, needs_review)')
    .eq('id', id).maybeSingle();
  if (error || !data) {
    toast(errorMessage(error, 'Facture introuvable.'), 'error');
    return;
  }
  await getSuppliers();
  current = { ...data, supplier_name: data.supplier?.name || '—', meta: parseNotes(data.extraction_notes) };
  fromInvoices = true;

  if (showTab) showTab('review');
  $('#review-layout').classList.add('solo');
  $('#review-back').hidden = false;
  $('#rv-back-label').textContent = `${current.supplier_name} · ${current.invoice_number}`;
  $('#catchup').hidden = true;
  renderDetail();
}

/**
 * Rend son écran complet à « À contrôler ». Appelée quand on y arrive par
 * le menu : sans cela l'écran resterait figé sur la pièce ouverte depuis
 * le tableau.
 */
export function resetDocumentView() {
  fromInvoices = false;
  current = null;
  const layout = $('#review-layout');
  if (layout) layout.classList.remove('solo');
  const back = $('#review-back');
  if (back) back.hidden = true;
}

// ---------------------------------------------------------------------
// Rendu de la liste
// ---------------------------------------------------------------------
export async function renderReview() {
  // Ouvert depuis le tableau : c'est openDocument qui a choisi la pièce à
  // afficher. Re-rendre la file ici l'écraserait par la première de la liste.
  if (fromInvoices) return;
  const list = $('#review-list');
  list.innerHTML = '<div class="muted small" style="padding:12px">Chargement…</div>';
  try {
    await Promise.all([loadReviewQueue(), getSuppliers()]);
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="empty"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  updateBadge();
  renderCatchup();

  if (!queue.length) {
    list.innerHTML = `<div class="empty">${ICONS.empty}<p>Rien à contrôler</p></div>`;
    $('#review-detail').innerHTML = `<div class="empty"><p>Les factures arrivées par e-mail apparaîtront ici.</p></div>`;
    return;
  }

  const sansReserve = queue.filter(validableSansOuvrir).length;
  const entete = sansReserve > 1 ? `
    <div class="review-bulk">
      <button type="button" class="btn btn-primary btn-sm" id="rv-bulk">
        Valider les ${sansReserve} sans réserve</button>
      <span class="muted small">lues sans champ douteux ni alerte</span>
    </div>` : '';

  // Regroupement : un fournisseur à la fois, ou tout par date. Encoder
  // dans Smart se fait fournisseur par fournisseur — la file doit pouvoir
  // s'ordonner comme le travail, pas comme les messages sont arrivés.
  const fournisseurs = [...new Set(queue.map((i) => i.supplier_name))].sort((a, b) => a.localeCompare(b, 'fr'));
  const compte = (nom) => queue.filter((i) => i.supplier_name === nom).length;
  const barre = `
    <div class="review-filters">
      <select id="rv-filter-sup" aria-label="Filtrer par fournisseur">
        <option value="">Tous les fournisseurs (${queue.length})</option>
        ${fournisseurs.map((n) => `<option value="${escapeHtml(n)}" ${tri.fournisseur === n ? 'selected' : ''}>${escapeHtml(n)} (${compte(n)})</option>`).join('')}
      </select>
      <select id="rv-filter-order" aria-label="Trier">
        <option value="date" ${tri.ordre === 'date' ? 'selected' : ''}>Par date de facture</option>
        <option value="fournisseur" ${tri.ordre === 'fournisseur' ? 'selected' : ''}>Par fournisseur</option>
      </select>
    </div>`;

  let visibles = tri.fournisseur ? queue.filter((i) => i.supplier_name === tri.fournisseur) : queue.slice();
  visibles.sort((a, b) => tri.ordre === 'fournisseur'
    ? a.supplier_name.localeCompare(b.supplier_name, 'fr') || String(a.invoice_date || '').localeCompare(String(b.invoice_date || ''))
    : String(a.invoice_date || '').localeCompare(String(b.invoice_date || '')));

  if (!visibles.length) {
    list.innerHTML = barre + `<div class="empty"><p>Aucune facture pour ce fournisseur.</p></div>`;
    wireReviewFilters();
    return;
  }

  list.innerHTML = barre + entete + visibles.map((i) => {
    const problems = i.meta.failed ? 'échec extraction'
      : (i.meta.alerts.length ? i.meta.alerts[0] : (i.meta.uncertain.length ? 'champs incertains' : ''));
    return `
    <button type="button" class="review-item ${current?.id === i.id ? 'active' : ''}" data-review="${i.id}">
      <span class="ri-supplier">${escapeHtml(i.supplier_name)}</span>
      <span class="ri-num">${escapeHtml(i.invoice_number)}</span>
      <span class="ri-amount num">${fmtEUR(i.amount_tvac)}</span>
      ${problems ? `<span class="ri-flag">${escapeHtml(problems)}</span>` : ''}
    </button>`;
  }).join('');

  $('#rv-bulk')?.addEventListener('click', validerSansReserve);
  wireReviewFilters();

  // La facture ouverte doit rester dans ce qui est affiché, sinon la liste
  // et le document ne parleraient plus de la même chose.
  if (!current || !visibles.some((i) => i.id === current.id)) current = visibles[0];
  renderDetail();
}

function wireReviewFilters() {
  $('#rv-filter-sup')?.addEventListener('change', (e) => {
    tri.fournisseur = e.target.value;
    current = null;             // on repart sur la première du fournisseur choisi
    renderReview();
  });
  $('#rv-filter-order')?.addEventListener('change', (e) => {
    tri.ordre = e.target.value;
    renderReview();
  });
}

/**
 * Avancement du rattrapage. Power Automate remonte au plus 20 messages par
 * exécution : un lot plus petit que ce plafond signifie que le dossier
 * Outlook est vidé. C'est le seul signal fiable de fin, l'application ne
 * voit pas la boîte mail.
 */
async function renderCatchup() {
  const box = $('#catchup');
  if (!box) return;
  try {
    const [{ data, error }, { data: fileData }] = await Promise.all([
      supabase.rpc('catchup_progress', { p_limit: 20 }),
      supabase.rpc('queue_backlog', { p_limit: 10 })
    ]);
    if (error) throw error;
    const p = typeof data === 'string' ? JSON.parse(data) : data;
    const file = (typeof fileData === 'string' ? JSON.parse(fileData) : fileData) || {};
    if (!p || !p.total_messages) { box.hidden = true; return; }

    const traites = Number(p.traites) + Number(p.ignores);
    const total = Number(p.total_messages);
    const pct = total ? Math.round((traites / total) * 100) : 0;
    const dernier = p.dernier_lot || {};
    const attente = Number(file.en_attente) || 0;
    box.hidden = false;
    box.innerHTML = `
      <div class="catchup-head">
        <strong>${p.termine ? 'Rattrapage terminé' : 'Rattrapage en cours'}</strong>
        <span class="muted small">${traites} message${traites > 1 ? 's' : ''} traité${traites > 1 ? 's' : ''} sur ${total}</span>
      </div>
      <div class="progress-track"><div class="progress-bar ${pct >= 100 ? 'full' : ''}" style="width:${pct}%"></div></div>
      <div class="catchup-detail">
        ${[
          Number(p.en_quarantaine) ? `${p.en_quarantaine} en quarantaine` : '',
          attente ? `${attente} en attente de lecture` : '',
          Number(file.en_erreur) ? `<span class="txt-red">${file.en_erreur} en erreur</span>` : '',
          Number(file.sans_facture) ? `${file.sans_facture} sans facture` : '',
          `${p.lots} lot${Number(p.lots) > 1 ? 's' : ''} reçu${Number(p.lots) > 1 ? 's' : ''}`,
          dernier.messages != null ? `dernier lot : ${dernier.messages} message${dernier.messages > 1 ? 's' : ''}` : ''
        ].filter(Boolean).join(' <span class="sep">·</span> ')}
      </div>
      ${attente && isManager() ? `
        <div class="catchup-actions">
          <button type="button" class="btn btn-primary btn-sm" id="cu-drain">
            Lire les ${attente} message${attente > 1 ? 's' : ''} en attente</button>
          <button type="button" class="btn btn-sm" id="cu-stop" hidden>Arrêter</button>
          <span class="muted small" id="cu-progress"></span>
        </div>
        <p class="field-hint">Ces messages sont déjà arrivés : ils attendent d'être lus.
          Power Automate ne les redonnera pas, c'est ici que cela se déclenche.
          Comptez une dizaine de secondes par message.</p>`
        : (p.termine ? '' : '<p class="field-hint">Le prochain lot arrive au cycle suivant de Power Automate.</p>')}`;

    $('#cu-drain')?.addEventListener('click', viderLaFile);
  } catch (err) {
    console.warn('avancement du rattrapage indisponible', err);
    box.hidden = true;
  }
}

/**
 * Vide la file des messages déjà reçus mais jamais lus.
 *
 * Par paquets, en attendant que chacun soit sorti de la file avant de
 * demander le suivant : la fonction d'extraction travaille en arrière-plan,
 * lui envoyer tout d'un coup ne ferait que saturer sans rien accélérer.
 * Arrêtable à tout moment — ce qui est déjà lu reste lu.
 */
let arretDemande = false;

async function viderLaFile() {
  const bouton = $('#cu-drain');
  const stop = $('#cu-stop');
  const avancement = $('#cu-progress');
  arretDemande = false;
  if (bouton) bouton.disabled = true;
  if (stop) { stop.hidden = false; stop.onclick = () => { arretDemande = true; stop.disabled = true; }; }

  const lire = async () => {
    const { data } = await supabase.rpc('queue_backlog', { p_limit: 10 });
    return (typeof data === 'string' ? JSON.parse(data) : data) || {};
  };

  try {
    let etat = await lire();
    const depart = Number(etat.en_attente) || 0;
    let tours = 0;

    while (!arretDemande && Number(etat.en_attente) > 0 && tours < 60) {
      const ids = etat.prochains || [];
      if (!ids.length) break;

      const { error } = await supabase.functions.invoke('replay-inbound', { body: { ids } });
      if (error) throw error;

      // On attend que le paquet quitte la file avant d'en demander un autre.
      const avant = Number(etat.en_attente);
      for (let i = 0; i < 30 && !arretDemande; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        etat = await lire();
        const fait = depart - Number(etat.en_attente);
        if (avancement) avancement.textContent = `${fait} / ${depart} lu${fait > 1 ? 's' : ''}…`;
        if (Number(etat.en_attente) < avant) break;
      }
      tours++;
    }

    const reste = Number(etat.en_attente) || 0;
    toast(arretDemande
      ? `Arrêté. ${reste} message${reste > 1 ? 's' : ''} encore en attente.`
      : reste
        ? `${depart - reste} message(s) lus, ${reste} encore en attente — relance quand tu veux.`
        : 'Toute la file a été lue.');
    invalidateInvoices();
    notifyDataChange();
    renderReview();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Lecture de la file impossible.'), 'error');
    if (bouton) bouton.disabled = false;
    if (stop) stop.hidden = true;
  }
}

function updateBadge(n = queue.length) {
  // deux emplacements : barre latérale en desktop, onglets bas en mobile
  ['#review-badge', '#review-badge-m'].forEach((sel) => {
    const b = $(sel);
    if (!b) return;
    b.textContent = n;
    b.hidden = n === 0;
  });
}

// ---------------------------------------------------------------------
// Rendu du détail : document à gauche, champs à droite
// ---------------------------------------------------------------------
async function renderDetail() {
  const box = $('#review-detail');
  if (!current) { box.innerHTML = ''; return; }
  const i = current;
  const m = i.meta;
  confirmed = new Set();

  // Fiche du fournisseur rattaché : c'est elle qui porte la mémoire
  const sup = suppliersCache().find((x) => x.id === i.supplier_id) || null;

  const rateOptions = LEGAL_RATES
    .map((r) => `<option value="${r}" ${Number(i.vat_rate) === r ? 'selected' : ''}>${(r * 100).toFixed(0)} %</option>`)
    .join('');
  const nonStandard = !LEGAL_RATES.includes(Number(i.vat_rate));

  box.innerHTML = `
    ${m.comment ? `<div class="review-banner">${ICONS.dash}<span>${escapeHtml(m.comment)}</span></div>` : ''}
    ${m.failed ? `<div class="review-banner danger">${ICONS.dash}<span>L'extraction automatique a échoué. Les champs sont à saisir à la main.</span></div>` : ''}
    ${reprisebanniere(i)}
    ${ibanAlertHtml(m)}
    ${escompteBanniere(i)}

    <div class="review-split">
      <div class="review-doc">
        <div class="review-doc-bar">
          <span class="muted small">Document d'origine</span>
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm" id="rv-print">Imprimer</button>
          <button type="button" class="btn btn-sm" id="rv-open">Ouvrir</button>
        </div>
        <div id="rv-viewer" class="review-viewer"><div class="muted small" style="padding:16px">Chargement du document…</div></div>
      </div>

      <form class="review-fields" id="rv-form">
        <!-- Le numéro Smart n'est pas sur la facture : il est attribué à
             l'encodage. C'est le geste central de Marie, donc il vient en
             premier et reçoit le focus à l'ouverture. -->
        <div class="field smart-field">
          <label for="rv-smart">Référence Smart</label>
          <input id="rv-smart" data-f="smart_ref" type="text" autocomplete="off"
                 placeholder="numéro attribué lors de l'encodage dans Smart"
                 value="${escapeHtml(i.smart_ref || '')}">
          <p class="field-hint" id="rv-smart-hint">Renseigner cette référence coche « Encodé Smart » automatiquement.</p>
        </div>

        <div class="field">
          <label for="rv-refs">Références</label>
          <input id="rv-refs" data-f="external_refs" type="text" autocomplete="off"
                 placeholder="bon de commande, chantier, client…"
                 value="${escapeHtml((i.external_refs || []).join(', '))}">
          <p class="field-hint">Plusieurs références possibles, séparées par des virgules.</p>
        </div>

        <div class="field">
          <label for="rv-supplier">Fournisseur</label>
          <select id="rv-supplier" data-f="supplier_id"></select>
          ${i.supplier?.needs_review ? '<p class="field-hint warn">Fiche créée automatiquement, à vérifier.</p>' : ''}
        </div>

        <div class="grid2">
          <div class="field">
            <label for="rv-number">N° facture</label>
            <input id="rv-number" data-f="invoice_number" type="text" value="${escapeHtml(i.invoice_number)}">
          </div>
          <div class="field">
            <label for="rv-date">Date facture</label>
            <input id="rv-date" data-f="invoice_date" type="date" value="${i.invoice_date || ''}">
            <!-- Le navigateur affiche la date selon SA langue : un navigateur en
                 anglais montre 09/05/2026 pour le 5 septembre. On la réécrit en
                 toutes lettres pour lever toute ambiguïté. -->
            <p class="field-hint" id="rv-date-text"></p>
          </div>
          <div class="field">
            <label for="rv-due">Échéance</label>
            <input id="rv-due" data-f="due_date" type="date" value="${i.due_date || ''}">
            <p class="field-hint" id="rv-due-text"></p>
            <label class="check memo-check" id="rv-memo-terms-wrap" hidden>
              <input type="checkbox" id="rv-memo-terms"> retenir ce délai pour ce fournisseur
            </label>
          </div>
          <div class="field">
            <label for="rv-htva">Montant HTVA (€)</label>
            <div class="field-with-calc">
              <input id="rv-htva" data-f="amount_htva" type="number" step="0.01" value="${Number(i.amount_htva)}">
              <button type="button" class="btn-calc-inline" data-calc-open="rv-htva"
                      title="Additionner plusieurs lignes (Alt+C)" aria-label="Ouvrir la calculette">=</button>
            </div>
          </div>
        </div>

        <!-- Champs de nature stable : ils peuvent être retenus sur la fiche.
             Jamais les montants, le numéro, les dates ni les références :
             ce sont des valeurs propres à chaque document. -->
        <fieldset class="memo-block">
          <legend>Fournisseur <span class="muted small">valeurs retenables</span></legend>
          ${memoField('rv-sup-name', 'Nom', sup?.name, m.brut?.fournisseur_nom, 'name')}
          ${memoField('rv-sup-vat', 'N° TVA', sup?.vat_number, m.brut?.fournisseur_tva, 'vat_number')}
          ${memoField('rv-sup-address', 'Adresse de facturation', sup?.address, m.brut?.fournisseur_adresse, 'address')}
        </fieldset>

        <!-- Le taux de TVA : champ à part entière, jamais déduit en silence -->
        <fieldset class="vat-block" id="rv-vat-block">
          <legend>Taux de TVA</legend>
          <div class="vat-row">
            <select id="rv-rate" data-f="vat_rate">
              ${rateOptions}
              <option value="autre" ${nonStandard ? 'selected' : ''}>Autre…</option>
            </select>
            <input id="rv-rate-custom" type="number" step="0.01" min="0" max="100"
                   value="${nonStandard ? (Number(i.vat_rate) * 100).toFixed(2) : ''}"
                   placeholder="%" ${nonStandard ? '' : 'hidden'}>
            <div class="vat-computed">
              <span>TVA calculée <strong id="rv-tva-calc">—</strong></span>
              <span>Total TVAC <strong id="rv-tvac-calc">—</strong></span>
            </div>
          </div>
          <p class="vat-read">Lu sur le document : TVA <strong id="rv-tva-read">—</strong></p>
          ${sup?.default_vat_rate != null ? `<p class="memo-hint">Retenu pour ce fournisseur : ${(Number(sup.default_vat_rate) * 100).toFixed(0)} %</p>` : ''}
          <label class="check memo-check" id="rv-memo-rate-wrap" hidden>
            <input type="checkbox" id="rv-memo-rate"> retenir ce taux pour ce fournisseur
          </label>
          <p class="vat-verdict" id="rv-vat-verdict"></p>
        </fieldset>

        <fieldset class="memo-block">
          <legend>Escompte pour paiement anticipé <span class="muted small">retenable</span></legend>
          <div class="grid2">
            <div class="field">
              <label for="rv-disc-rate">Taux (%)</label>
              <input id="rv-disc-rate" type="number" step="0.01" min="0" max="100"
                     value="${i.discount_rate ?? (sup?.discount_rate ?? '')}">
            </div>
            <div class="field">
              <label for="rv-disc-days">Délai (jours)</label>
              <input id="rv-disc-days" type="number" step="1" min="1"
                     value="${i.discount_days ?? (sup?.discount_days ?? '')}">
            </div>
          </div>
          ${sup?.discount_rate ? `<p class="memo-hint">Retenu pour ce fournisseur : ${Number(sup.discount_rate)} % à ${sup.discount_days ?? '—'} jours</p>` : ''}
          <label class="check memo-check" id="rv-memo-disc-wrap" hidden>
            <input type="checkbox" id="rv-memo-disc"> retenir cet escompte pour ce fournisseur
          </label>
        </fieldset>

        <div class="grid2">
          <div class="field">
            <label for="rv-type">Type de dépense</label>
            <input id="rv-type" data-f="expense_type" type="text" value="${escapeHtml(i.expense_type || '')}">
            ${sup?.default_expense_type ? `<p class="memo-hint">Retenu : ${escapeHtml(sup.default_expense_type)}</p>` : ''}
            <label class="check memo-check" id="rv-memo-type-wrap" hidden>
              <input type="checkbox" id="rv-memo-type"> retenir pour ce fournisseur
            </label>
          </div>
          <div class="field">
            <label for="rv-stock">Entrée en stock</label>
            <input id="rv-stock" data-f="stock_in" type="date" value="${i.stock_in || ''}">
          </div>
        </div>

        <div class="field">
          <label for="rv-notes">Remarques</label>
          <textarea id="rv-notes" data-f="notes" rows="2">${escapeHtml(i.notes || '')}</textarea>
        </div>

        ${m.uncertain.length ? `
          <div class="uncertain-box">
            <p>Champs signalés incertains par l'extraction. Confirme chacun après contrôle sur le document :</p>
            ${m.uncertain.map((f) => `
              <label class="check"><input type="checkbox" data-confirm="${escapeHtml(f)}"> ${escapeHtml(f)}</label>`).join('')}
          </div>` : ''}

        <div class="review-actions">
          <button type="button" class="btn btn-danger" id="rv-reject">Rejeter</button>
          <span class="spacer"></span>
          <button type="button" class="btn" id="rv-retry"
            ${(i.extraction_attempts ?? 0) >= 3 ? 'disabled title="3 tentatives déjà utilisées"' : ''}>
            Relancer l'extraction (${3 - (i.extraction_attempts ?? 0)})
          </button>
          <button type="button" class="btn btn-primary" id="rv-validate">Valider</button>
        </div>
        <p class="block-reason" id="rv-block-reason" hidden></p>
      </form>
    </div>`;

  fillSupplierSelect(i.supplier_id);
  // Pré-remplissage depuis la mémoire du fournisseur, UNIQUEMENT si le
  // document n'a rien donné. Une valeur lue n'est jamais écrasée.
  if (sup) {
    if (!i.expense_type && sup.default_expense_type) $('#rv-type').value = sup.default_expense_type;
    if (!i.due_date && i.invoice_date && sup.payment_terms) {
      const d = new Date(i.invoice_date);
      d.setDate(d.getDate() + Number(sup.payment_terms));
      $('#rv-due').value = d.toISOString().slice(0, 10);
    }
  }
  wireDetail();
  refreshVat();
  loadDocument(i.file_path);
  // Marie enchaîne les factures au clavier : le curseur l'attend dans le
  // champ qu'elle remplit en premier.
  setTimeout(() => { const f = $('#rv-smart'); if (f) { f.focus(); f.select(); } }, 60);
}

function fillSupplierSelect(selected) {
  const sel = $('#rv-supplier');
  sel.innerHTML = suppliersCache()
    .filter((s) => !s.archived)
    .map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${escapeHtml(s.name)}${s.needs_review ? ' (à vérifier)' : ''}</option>`)
    .join('');
}

// ---------------------------------------------------------------------
// Document d'origine
// ---------------------------------------------------------------------
async function loadDocument(path) {
  const viewer = $('#rv-viewer');
  signedUrl = null;
  if (!path) { viewer.innerHTML = '<div class="empty"><p>Aucun document joint.</p></div>'; return; }
  try {
    const { data, error } = await supabase.storage.from('factures').createSignedUrl(path, 3600);
    if (error) throw error;
    signedUrl = data.signedUrl;
    // <object> plutôt que <iframe> : si le navigateur ne sait pas afficher un
    // PDF en ligne (Safari mobile, visualiseur désactivé), le contenu de repli
    // s'affiche au lieu d'un rectangle gris inexpliqué.
    viewer.innerHTML = /\.xml$/i.test(path)
      ? `<pre class="xml-view" id="rv-xml">Chargement…</pre>`
      : `<object data="${signedUrl}#zoom=page-width" type="application/pdf" title="Document d'origine">
           <div class="empty">
             <p>Ton navigateur n'affiche pas les PDF directement.</p>
             <a class="btn btn-primary" href="${signedUrl}" target="_blank" rel="noopener">Ouvrir le document</a>
           </div>
         </object>`;
    if (/\.xml$/i.test(path)) {
      const txt = await (await fetch(signedUrl)).text();
      $('#rv-xml').textContent = txt.slice(0, 20000);
    }
  } catch (err) {
    console.error(err);
    viewer.innerHTML = `<div class="empty"><p>${escapeHtml(errorMessage(err, 'Document illisible.'))}</p></div>`;
  }
}

// ---------------------------------------------------------------------
// Le contrôle de TVA, visible et bloquant
// ---------------------------------------------------------------------
function currentRate() {
  const sel = $('#rv-rate');
  if (sel.value === 'autre') {
    const pct = Number($('#rv-rate-custom').value);
    return Number.isFinite(pct) ? pct / 100 : NaN;
  }
  return Number(sel.value);
}

/**
 * Bannière d'escompte. Le montant escompté vient de la base : la TVA n'est
 * jamais recalculée, seul le HTVA est diminué — règle belge.
 */
/**
 * Facture de l'ancienne franchise.
 *
 * Elle a peut-être DÉJÀ été encodée dans Smart par David — personne n'en
 * est sûr. L'encoder une seconde fois créerait un doublon en comptabilité,
 * et un doublon en comptabilité coûte plus cher à défaire qu'à éviter.
 * D'où l'ordre : chercher dans Smart d'abord, reporter le numéro s'il
 * existe, encoder seulement s'il n'existe pas.
 *
 * L'avertissement est ici, sur la facture, et pas seulement dans le mode
 * d'emploi : c'est au moment d'agir qu'on a besoin de le lire.
 */
function reprisebanniere(i) {
  if (i.payment_status !== 'avant_reprise') return '';
  return `
    <div class="review-banner warn">${ICONS.dash}<span>
      <strong>Facture de l'ancienne franchise, déjà payée par elle.</strong>
      Elle reste à encoder et à envoyer au comptable — mais
      <strong>cherche-la d'abord dans Smart</strong> : si David l'y a déjà encodée,
      reporte son numéro ici au lieu de l'encoder une seconde fois.
    </span></div>`;
}

function escompteBanniere(i) {
  if (!i.discount_rate || !i.amount_discounted) return '';
  const limite = i.discount_deadline;
  const encore = limite && limite >= todayISO();
  return `
    <div class="discount-banner" ${encore ? '' : 'style="background:var(--surface-hover);border-color:var(--border);color:var(--muted)"'}>
      ${ICONS.check}
      <span>Escompte ${Number(i.discount_rate)} % :
        payer <strong>${fmtEUR(i.amount_discounted)}</strong>
        au lieu de <strong>${fmtEUR(i.amount_tvac)}</strong>
        — soit ${fmtEUR(Number(i.amount_tvac) - Number(i.amount_discounted))} gagnés</span>
      <span class="spacer"></span>
      <span>${encore
        ? `à payer avant le ${fmtDate(limite)}`
        : `délai dépassé le ${fmtDate(limite)} — l'escompte n'est en principe plus dû`}</span>
    </div>`;
}

/**
 * Champ de nature stable : sa valeur actuelle sur la fiche, et ce qui a été
 * lu sur le document. Si les deux diffèrent, les deux sont montrés et c'est
 * l'utilisateur qui tranche — la valeur mémorisée ne remplace jamais celle
 * lue, et l'inverse non plus.
 */
function memoField(id, label, valeurFiche, valeurLue, champ) {
  const fiche = valeurFiche ?? '';
  const lue = valeurLue ?? '';
  const divergent = lue && fiche && String(lue).trim() !== String(fiche).trim();
  return `
    <div class="memo-row ${divergent ? 'is-diff' : ''}">
      <label class="vf-label" for="${id}">${label}</label>
      <input id="${id}" type="text" data-memo-field="${champ}"
             data-initial="${escapeHtml(fiche)}" value="${escapeHtml(fiche)}">
      ${lue ? `<span class="memo-read">lu&nbsp;: <code>${escapeHtml(lue)}</code>${
        divergent ? ` <button type="button" class="link-btn" data-use-read="${id}">utiliser</button>` : ''}</span>` : ''}
      <label class="check memo-check" hidden>
        <input type="checkbox" data-memo-for="${id}"> retenir pour ce fournisseur
      </label>
    </div>`;
}

/** « BC-123, chantier Dupont » -> ['BC-123', 'chantier Dupont'] */
export function splitRefs(value) {
  return String(value || '')
    .split(/[,;\n]/)
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * IBAN divergent : jamais appliqué automatiquement. On bloque la validation
 * tant que le gérant n'a pas tranché entre l'ancien et le nouveau, et le
 * choix est journalisé.
 */
function ibanAlertHtml(m) {
  const r = m.rapprochement || {};
  if (!r.iban_divergent) return '';
  return `
    <div class="review-banner danger iban-alert" id="rv-iban-alert">
      <div class="iban-body">
        <strong>L'IBAN de cette facture diffère de celui de la fiche fournisseur.</strong>
        <div class="iban-compare">
          <span>Fiche : <code>${escapeHtml(r.iban_fiche || '—')}</code></span>
          <span>Facture : <code>${escapeHtml(r.iban_lu || '—')}</code></span>
        </div>
        <p class="iban-warn">Un changement d'IBAN non sollicité est le signe d'une fraude par
          détournement de facture. Vérifie par téléphone auprès du fournisseur, sur un numéro
          que tu connais déjà, avant de choisir.</p>
        <div class="iban-actions">
          <label class="check"><input type="radio" name="iban-choice" value="garder" checked>
            Conserver l'IBAN de la fiche</label>
          <label class="check"><input type="radio" name="iban-choice" value="remplacer">
            Remplacer par celui de la facture</label>
        </div>
      </div>
    </div>`;
}

/** Réécrit les dates en toutes lettres, indépendamment de la langue du navigateur */
function spellDates() {
  const pairs = [['#rv-date', '#rv-date-text'], ['#rv-due', '#rv-due-text']];
  for (const [input, out] of pairs) {
    const el = $(out);
    if (!el) continue;
    el.textContent = longDate($(input)?.value);
  }
}

function refreshVat() {
  const htva = Number($('#rv-htva').value) || 0;
  const rate = currentRate();
  const readTva = Number(current?.meta?.brut?.montant_tva);
  const calcTva = Number.isFinite(rate) ? Math.round(htva * rate * 100) / 100 : NaN;

  $('#rv-tva-calc').textContent = Number.isFinite(calcTva) ? fmtEUR(calcTva) : '—';
  $('#rv-tvac-calc').textContent = Number.isFinite(calcTva) ? fmtEUR(htva + calcTva) : '—';
  $('#rv-tva-read').textContent = Number.isFinite(readTva) ? fmtEUR(readTva) : 'non lu';

  spellDates();

  const verdict = $('#rv-vat-verdict');
  const block = $('#rv-vat-block');
  block.classList.remove('is-warn', 'is-danger', 'is-ok');

  const mismatch = vatMismatch(htva, readTva, rate);
  if (!Number.isFinite(rate)) {
    block.classList.add('is-danger');
    verdict.textContent = 'Taux de TVA manquant.';
  } else if (mismatch === 'unknown') {
    block.classList.add('is-warn');
    verdict.textContent = 'Aucun montant de TVA lu sur le document : le taux ne peut pas être recoupé, vérifie-le à l\'œil.';
  } else if (mismatch) {
    block.classList.add('is-danger');
    verdict.textContent = `Le taux choisi donne ${fmtEUR(calcTva)} de TVA, alors que le document indique ${fmtEUR(readTva)}. Corrige le taux ou le montant HTVA avant de valider.`;
  } else {
    block.classList.add('is-ok');
    verdict.textContent = 'Le taux correspond au montant de TVA lu sur le document.';
  }
  refreshValidateState();
}

function blockingReason() {
  const htva = Number($('#rv-htva').value);
  const rate = currentRate();
  if (!$('#rv-supplier').value) return 'Choisis un fournisseur.';
  if (!$('#rv-number').value.trim()) return 'Le numéro de facture est obligatoire.';
  if (!$('#rv-date').value) return 'La date de facture est obligatoire.';
  if (!Number.isFinite(rate)) return 'Le taux de TVA doit être renseigné.';
  const mismatch = vatMismatch(htva, Number(current?.meta?.brut?.montant_tva), rate);
  if (mismatch === true) return 'Le taux de TVA ne correspond pas au montant lu sur le document.';
  const pending = (current?.meta?.uncertain || []).filter((f) => !confirmed.has(f));
  if (pending.length) return `Confirme les champs incertains : ${pending.join(', ')}.`;
  if (current?.meta?.rapprochement?.iban_divergent && !$('input[name="iban-choice"]:checked')) {
    return 'Tranche sur l\'IBAN : conserver celui de la fiche ou le remplacer.';
  }
  return null;
}

function refreshValidateState() {
  const reason = blockingReason();
  const btn = $('#rv-validate');
  const note = $('#rv-block-reason');
  btn.disabled = !!reason;
  note.hidden = !reason;
  note.textContent = reason || '';
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------
function wireDetail() {
  $('#rv-form').addEventListener('input', refreshVat);
  wireMemory();
  $('#rv-rate').addEventListener('change', () => {
    $('#rv-rate-custom').hidden = $('#rv-rate').value !== 'autre';
    refreshVat();
  });
  $$('#rv-form [data-confirm]').forEach((c) => c.addEventListener('change', (e) => {
    if (e.target.checked) confirmed.add(e.target.dataset.confirm);
    else confirmed.delete(e.target.dataset.confirm);
    refreshValidateState();
  }));

  $('#rv-open').addEventListener('click', () => signedUrl && window.open(signedUrl, '_blank', 'noopener'));
  $('#rv-print').addEventListener('click', printCurrent);
  $('#rv-validate').addEventListener('click', validateCurrent);
  $('#rv-reject').addEventListener('click', rejectCurrent);
  $('#rv-retry').addEventListener('click', retryExtraction);
}

/**
 * La case « retenir » n'apparaît qu'une fois le champ réellement modifié :
 * proposer de mémoriser une valeur qu'on n'a pas touchée n'a pas de sens.
 */
function wireMemory() {
  $$('#rv-form [data-memo-field]').forEach((input) => {
    const wrap = input.closest('.memo-row')?.querySelector('.memo-check');
    input.addEventListener('input', () => {
      if (!wrap) return;
      wrap.hidden = input.value.trim() === (input.dataset.initial || '').trim();
      if (wrap.hidden) wrap.querySelector('input').checked = false;
    });
  });

  $$('#rv-form [data-use-read]').forEach((b) => b.addEventListener('click', () => {
    const input = $(`#${b.dataset.useRead}`);
    const code = b.closest('.memo-read')?.querySelector('code');
    if (input && code) { input.value = code.textContent; input.dispatchEvent(new Event('input', { bubbles: true })); }
  }));

  // Taux, délai et type de dépense : même règle, la case suit la modification
  const suivre = (champ, caseWrap, valeurInitiale) => {
    const el = $(champ), wrap = $(caseWrap);
    if (!el || !wrap) return;
    const maj = () => {
      wrap.hidden = String(el.value) === String(valeurInitiale);
      if (wrap.hidden) wrap.querySelector('input').checked = false;
    };
    el.addEventListener('input', maj);
    el.addEventListener('change', maj);
  };
  suivre('#rv-rate', '#rv-memo-rate-wrap', String(current?.vat_rate ?? ''));
  suivre('#rv-type', '#rv-memo-type-wrap', current?.expense_type ?? '');
  suivre('#rv-due', '#rv-memo-terms-wrap', current?.due_date ?? '');
  suivre('#rv-disc-rate', '#rv-memo-disc-wrap', String(current?.discount_rate ?? ''));
  suivre('#rv-disc-days', '#rv-memo-disc-wrap', String(current?.discount_days ?? ''));
}

/** Ouvre le document dans une fenêtre et lance l'impression */
function printCurrent() {
  if (!signedUrl) { toast('Aucun document à imprimer.', 'error'); return; }
  const w = window.open(signedUrl, '_blank', 'noopener');
  if (!w) { toast('Le navigateur a bloqué la fenêtre d\'impression.', 'error'); return; }
  w.addEventListener('load', () => { try { w.print(); } catch { /* le visualiseur gère */ } });
}

async function validateCurrent() {
  const reason = blockingReason();
  if (reason) { toast(reason, 'error'); return; }

  const rate = currentRate();
  const patch = {
    smart_ref: $('#rv-smart').value.trim() || null,
    discount_rate: Number($('#rv-disc-rate')?.value) || null,
    discount_days: Number($('#rv-disc-days')?.value) || null,
    external_refs: splitRefs($('#rv-refs').value),
    supplier_id: $('#rv-supplier').value,
    invoice_number: $('#rv-number').value.trim(),
    invoice_date: $('#rv-date').value,
    due_date: $('#rv-due').value || null,
    amount_htva: Number($('#rv-htva').value) || 0,
    vat_rate: rate,
    expense_type: $('#rv-type').value.trim() || null,
    stock_in: $('#rv-stock').value || null,
    notes: $('#rv-notes').value.trim() || null,
    review_status: 'valide'
  };

  const btn = $('#rv-validate');
  btn.disabled = true;
  try {
    const { error } = await supabase.from('invoices').update(patch).eq('id', current.id);
    if (error) throw error;
    await applyIbanChoice(patch.supplier_id);
    await appliquerMemorisations(patch.supplier_id, patch);
    await rememberSender(patch.supplier_id, current.sender_email);
    // La facture rejoint la liste normale : son cache doit repartir de la base.
    invalidateInvoices();
    toast(`Facture ${patch.invoice_number} validée.`);
    current = null;
    await renderReview();
    notifyDataChange();
  } catch (err) {
    // Le doublon de référence est un cas prévu et traité : inutile de
    // déverser l'erreur Postgres brute dans la console.
    if (!/invoices_smart_ref_key/.test(err.message || '')) console.error(err);
    if (/invoices_smart_ref_key/.test(err.message || '')) {
      const hint = $('#rv-smart-hint');
      hint.textContent = `La référence Smart ${patch.smart_ref} est déjà utilisée par une autre facture.`;
      hint.className = 'field-hint danger';
      $('#rv-smart').focus();
      toast(`Référence Smart ${patch.smart_ref} déjà utilisée.`, 'error');
    } else {
      toast(errorMessage(err, 'Validation impossible.'), 'error');
    }
    btn.disabled = false;
  }
}

/**
 * Enregistre les corrections que l'utilisateur a choisi de retenir sur la
 * fiche fournisseur. Chaque mémorisation est journalisée par la base.
 */
async function appliquerMemorisations(supplierId, patch) {
  if (!supplierId) return;
  const aRetenir = [];

  // Champs de la fiche : nom, TVA, adresse
  $$('#rv-form [data-memo-field]').forEach((input) => {
    const coche = input.closest('.memo-row')?.querySelector('[data-memo-for]');
    if (coche?.checked && input.value.trim()) {
      aRetenir.push({ field: input.dataset.memoField, value: input.value.trim() });
    }
  });

  if ($('#rv-memo-rate')?.checked) {
    aRetenir.push({ field: 'default_vat_rate', value: String(patch.vat_rate) });
  }
  if ($('#rv-memo-disc')?.checked && patch.discount_rate) {
    aRetenir.push({ field: 'discount_rate', value: String(patch.discount_rate) });
    if (patch.discount_days) aRetenir.push({ field: 'discount_days', value: String(patch.discount_days) });
  }
  if ($('#rv-memo-type')?.checked && patch.expense_type) {
    aRetenir.push({ field: 'default_expense_type', value: patch.expense_type });
  }
  if ($('#rv-memo-terms')?.checked && patch.due_date && patch.invoice_date) {
    // Le délai retenu est l'écart réel entre facture et échéance
    const jours = Math.round(
      (new Date(patch.due_date) - new Date(patch.invoice_date)) / 86400000);
    if (jours > 0) aRetenir.push({ field: 'payment_terms', value: String(jours) });
  }

  if (!aRetenir.length) return;
  try {
    for (const m of aRetenir) {
      const { error } = await supabase.rpc('remember_supplier_value', {
        p_supplier: supplierId, p_field: m.field, p_value: m.value,
        p_source: `retenu depuis la facture ${patch.invoice_number}`
      });
      if (error) throw error;
    }
    await getSuppliers(true);
    toast(`${aRetenir.length} valeur${aRetenir.length > 1 ? 's' : ''} retenue${aRetenir.length > 1 ? 's' : ''} pour ce fournisseur.`);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Mémorisation impossible.'), 'error');
  }
}

/**
 * Applique le choix du gérant sur un IBAN divergent, et le journalise dans
 * les deux cas — conserver est une décision autant que remplacer.
 */
async function applyIbanChoice(supplierId) {
  const r = current?.meta?.rapprochement || {};
  if (!r.iban_divergent) return;
  const choix = $('input[name="iban-choice"]:checked')?.value || 'garder';
  try {
    if (choix === 'remplacer') {
      const { error } = await supabase.from('suppliers').update({ iban: r.iban_lu }).eq('id', supplierId);
      if (error) throw error;
    }
    await supabase.from('change_log').insert({
      entity: 'supplier',
      entity_id: supplierId,
      entity_label: current.supplier_name,
      field: 'iban',
      old_value: r.iban_fiche || null,
      new_value: choix === 'remplacer' ? (r.iban_lu || null) : (r.iban_fiche || null),
      reason: choix === 'remplacer'
        ? `IBAN remplacé après contrôle, facture ${current.invoice_number}`
        : `IBAN de la fiche conservé malgré divergence, facture ${current.invoice_number}`,
      author_name: displayName()
    });
    toast(choix === 'remplacer' ? 'IBAN de la fiche remplacé et journalisé.' : 'IBAN de la fiche conservé, décision journalisée.');
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Enregistrement du choix d\'IBAN impossible.'), 'error');
  }
}

/**
 * Mémorise l'adresse de l'expéditeur sur le fournisseur retenu :
 * la reconnaissance automatique s'améliore à chaque validation.
 */
async function rememberSender(supplierId, email) {
  if (!supplierId || !email) return;
  try {
    // Un transitaire retransmet les factures d'autrui : mémoriser son
    // adresse sur une fiche rattacherait à tort toutes les suivantes.
    const { data: exp } = await supabase.from('allowed_senders')
      .select('is_forwarder').eq('email', email).maybeSingle();
    if (exp?.is_forwarder) return;
    const { data } = await supabase.from('suppliers').select('known_emails').eq('id', supplierId).single();
    const list = data?.known_emails || [];
    if (list.includes(email)) return;
    await supabase.from('suppliers').update({ known_emails: [...list, email] }).eq('id', supplierId);
  } catch (err) {
    console.warn('mémorisation de l\'expéditeur impossible', err);
  }
}

async function rejectCurrent() {
  const ok = await confirmDialog(
    `Rejeter cette facture ? Elle sera supprimée de la file. Le document d'origine reste dans le coffre.`,
    'Rejeter');
  if (!ok) return;
  try {
    const { error } = await supabase.from('invoices').delete().eq('id', current.id);
    if (error) throw error;
    invalidateInvoices();
    toast('Facture rejetée.');
    current = null;
    await renderReview();
    notifyDataChange();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Rejet impossible.'), 'error');
  }
}

async function retryExtraction() {
  if (!isManager()) { toast('Seul le gérant peut relancer une extraction.', 'error'); return; }
  toast('Relance demandée, le résultat arrive dans quelques secondes.');
  try {
    const { data: q } = await supabase.from('inbound_queue')
      .select('id').eq('message_id', current.message_id).maybeSingle();
    if (!q) { toast('Message d\'origine introuvable dans la file.', 'error'); return; }
    const { error } = await supabase.functions.invoke('replay-inbound', { body: { ids: [q.id] } });
    if (error) throw error;
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Relance impossible.'), 'error');
  }
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initReview() {
  $('#review-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-review]');
    if (!b) return;
    current = queue.find((i) => i.id === b.dataset.review) || null;
    renderReview();
  });
  window.addEventListener('vk:data', () => { if (!$('#tab-review').hidden) renderReview(); });
}

/** Compteur de la pastille, rafraîchi sans ouvrir l'onglet */
export async function refreshReviewBadge() {
  try {
    const { count } = await supabase.from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('review_status', 'a_controler');
    updateBadge(count ?? 0);
  } catch { /* silencieux : ce n'est qu'un compteur */ }
}

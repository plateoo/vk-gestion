// =====================================================================
// dashboard.js — KPI du mois sélectionné, alertes, top fournisseurs
// =====================================================================
import { getInvoices, setInvoiceFilters, resumeArrivees } from './invoices.js';
import {
  $, fmtEUR, escapeHtml, toast, errorMessage, getMonth, setMonth, shiftMonth,
  currentMonthKey, monthLabel, inMonth, isOverdue, ICONS,
  getPeriod, periodLabel, inPeriod, previousRange, inRange, estDue
} from './ui.js';

export async function renderDashboard() {
  const month = getMonth();
  const periode = getPeriod();
  // Les chiffres suivent la période choisie sur l'écran Factures : mois,
  // trimestre, année ou dates libres. Un KPI correspond toujours à ce qui
  // est listé en dessous.
  $('#dash-month-label').textContent = periodLabel(periode);
  $('#print-month').textContent = periodLabel(periode);

  const tbody = $('#top-tbody');
  let invoices;
  try {
    invoices = await getInvoices();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, 'Chargement du tableau de bord impossible.'), 'error');
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4"><div class="empty"><p>Données indisponibles.</p></div></td></tr>`;
    return;
  }

  // Les pièces qui ne sont pas des factures ne comptent dans aucun total.
  const facturesSeules = invoices.filter((i) => i.review_status !== 'document');
  const rows = facturesSeules.filter((i) => inPeriod(i.invoice_date, periode));
  const precedente = previousRange(periode);
  const prevRows = precedente
    ? facturesSeules.filter((i) => inRange(i.invoice_date, precedente))
    : [];

  // ---------- 6 KPI ----------
  const htva = rows.reduce((s, i) => s + (Number(i.amount_htva) || 0), 0);
  const tvac = rows.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  const tva = tvac - htva;
  const due = rows.filter(estDue)
    .reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  const late = rows.filter(isOverdue);

  // Période précédente de même nature, pour les variations
  const pHtva = prevRows.reduce((s, i) => s + (Number(i.amount_htva) || 0), 0);
  const pTvac = prevRows.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0);
  // Sans période précédente — « toutes périodes » — il n'y a rien à comparer.
  const vs = !precedente ? ''
    : periode.kind === 'month' ? `vs ${shortMonth(precedente.from.slice(0, 7))}`
    : periode.kind === 'quarter' ? 'vs trimestre précédent'
    : periode.kind === 'year' ? `vs ${Number(periode.year) - 1}`
    : 'vs période précédente';

  $('#kpi-count').textContent = rows.length;
  $('#kpi-htva').textContent = fmtEUR(htva);
  $('#kpi-tva').textContent = fmtEUR(tva);
  $('#kpi-tvac').textContent = fmtEUR(tvac);
  $('#kpi-due').textContent = fmtEUR(due);
  $('#kpi-due').classList.toggle('txt-red', due > 0);
  $('#card-due').classList.toggle('is-alert', due > 0);

  setVariation('#kpi-count-sub', rows.length, prevRows.length, vs);
  setVariation('#kpi-htva-sub', htva, pHtva, vs);
  setVariation('#kpi-tva-sub', tvac - htva, pTvac - pHtva, vs);
  setVariation('#kpi-tvac-sub', tvac, pTvac, vs);
  $('#kpi-late').textContent = late.length;
  $('#kpi-late-sub').textContent = late.length
    ? fmtEUR(late.reduce((s, i) => s + (Number(i.amount_tvac) || 0), 0)) + ' en souffrance'
    : 'Rien en retard';
  $('#card-late').classList.toggle('is-alert', late.length > 0);

  // ---------- 3 blocs d'alerte ----------
  const noSmart = rows.filter((i) => !i.in_smart).length;
  const noWin = rows.filter((i) => !i.in_winauditor).length;
  const noStock = rows.filter((i) => !i.stock_in).length;
  setAlert('#alert-smart', noSmart, 'facture', 'pas encore encodée dans Smart', 'pas encore encodées dans Smart', 'Tout est encodé dans Smart');
  setAlert('#alert-win', noWin, 'facture', 'pas encore envoyée à WinAuditor', 'pas encore envoyées à WinAuditor', 'Tout est envoyé à WinAuditor');
  setAlert('#alert-stock', noStock, 'facture', 'sans entrée en stock', 'sans entrée en stock', 'Tout est entré en stock');

  // ---------- Ce qui vient d'arriver ----------
  //
  // Calculé sur TOUTES les pièces, pas sur la période affichée : un
  // fournisseur qui envoie aujourd'hui son arriéré de 2024 doit être
  // signalé même si l'on regarde le mois en cours. C'est précisément le
  // cas qui rendait ces factures introuvables.
  const arrivees = resumeArrivees(invoices);
  const blocArrivees = $('#alert-arrivees');
  if (blocArrivees) {
    blocArrivees.hidden = arrivees.nombre === 0;
    const qui = arrivees.fournisseurs.length === 1
      ? ` de ${arrivees.fournisseurs[0]}`
      : arrivees.fournisseurs.length <= 3 && arrivees.fournisseurs.length
        ? ` de ${arrivees.fournisseurs.join(', ')}`
        : arrivees.fournisseurs.length
          ? ` de ${arrivees.fournisseurs.length} fournisseurs`
          : '';
    blocArrivees.querySelector('.alert-text').textContent =
      `${arrivees.nombre} pièce${arrivees.nombre > 1 ? 's' : ''} arrivée${arrivees.nombre > 1 ? 's' : ''}`
      + ` depuis hier${qui}`;
  }

  // ---------- Barres de progression du mois ----------
  setProgress('smart', rows.length - noSmart, rows.length, 'encodée dans Smart', 'encodées dans Smart');
  setProgress('win', rows.length - noWin, rows.length, 'envoyée à WinAuditor', 'envoyées à WinAuditor');

  // ---------- Top fournisseurs du mois ----------
  const map = new Map();
  for (const i of rows) {
    const key = i.supplier_id;
    if (!map.has(key)) map.set(key, { name: i.supplier_name, count: 0, total: 0, due: 0 });
    const e = map.get(key);
    e.count += 1;
    e.total += Number(i.amount_tvac) || 0;
    if (estDue(i)) e.due += Number(i.amount_tvac) || 0;
  }
  const top = [...map.values()].sort((a, b) => b.total - a.total);

  if (!top.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">
      <div class="empty">
        ${ICONS.empty}
        <p>Aucune facture sur la période : ${escapeHtml(periodLabel(periode).toLowerCase())}</p>
        <button type="button" class="btn btn-primary" id="dash-empty-new">Encoder la première</button>
      </div></td></tr>`;
    const b = $('#dash-empty-new');
    if (b) b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('vk:new-invoice')));
    return;
  }
  tbody.innerHTML = top.map((t) => `
    <tr>
      <td data-label="Fournisseur">${escapeHtml(t.name)}</td>
      <td data-label="Factures" class="num">${t.count}</td>
      <td data-label="Total TVAC" class="num">${fmtEUR(t.total)}</td>
      <td data-label="Reste dû" class="num ${t.due > 0 ? 'txt-red' : ''}">${fmtEUR(t.due)}</td>
    </tr>`).join('');
}

/** '2026-08' -> 'août' */
function shortMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('fr-BE', { month: 'long' });
}

/** Variation en % par rapport au mois précédent (affichée sous le chiffre) */
function setVariation(sel, cur, prev, vsLabel) {
  const el = $(sel);
  if (!el) return;
  // « Toutes périodes » : aucune période précédente, donc aucune variation
  // à afficher — mieux vaut rien qu'un tiret sans référence.
  if (!vsLabel) { el.textContent = ''; el.className = 'kpi-sub'; return; }
  if (!prev) {
    el.textContent = cur ? `— ${vsLabel}` : '';
    el.className = 'kpi-sub';
    return;
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  el.textContent = `${pct > 0 ? '+' : ''}${pct} % ${vsLabel}`;
  el.className = `kpi-sub ${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}`;
}

/** Barre de progression fine « 34 factures sur 41 envoyées à WinAuditor » */
function setProgress(key, done, total, singular, plural) {
  const bar = $(`#prog-${key}-bar`);
  const txt = $(`#prog-${key}-text`);
  if (!bar || !txt) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  bar.classList.toggle('full', total > 0 && done === total);
  // « 34 factures sur 41 envoyées » / « 1 facture sur 4 envoyée » : tout s'accorde avec `done`
  txt.textContent = total
    ? `${done} facture${done > 1 ? 's' : ''} sur ${total} ${done > 1 ? plural : singular}`
    : 'Aucune facture ce mois-ci';
}

/** Met à jour un bloc d'alerte (vert avec une coche quand le compteur est à 0) */
function setAlert(sel, n, noun, singular, plural, okText) {
  const box = $(sel);
  box.classList.toggle('ok', n === 0);
  box.querySelector('.alert-text').textContent = n === 0
    ? `✓ ${okText}`
    : `${n} ${noun}${n > 1 ? 's' : ''} ${n > 1 ? plural : singular}`;
}

export function initDashboard() {
  // Le sélecteur de mois est unique et vit dans le bandeau supérieur (voir index.html)

  // Chaque bloc d'alerte filtre la liste des factures
  $('#alert-smart').addEventListener('click', () => gotoInvoices({ smart: 'non' }));
  $('#alert-win').addEventListener('click', () => gotoInvoices({ winauditor: 'non' }));
  $('#alert-stock').addEventListener('click', () => gotoInvoices({ stock: 'sans' }));
  // Les arrivées ignorent la période : c'est tout l'intérêt. Un fournisseur
  // qui envoie aujourd'hui des factures de 2024 doit apparaître ici.
  $('#alert-arrivees').addEventListener('click', () => gotoInvoices({ view: 'arrivees', period: 'all' }));
  $('#card-late').addEventListener('click', () => gotoInvoices({}));

  window.addEventListener('vk:month', () => renderDashboard());
  window.addEventListener('vk:period', () => renderDashboard());
}

function gotoInvoices(patch) {
  window.dispatchEvent(new CustomEvent('vk:goto-invoices'));
  setInvoiceFilters(Object.assign(
    { q: '', period: 'month', supplier: '', status: '', smart: '', winauditor: '', stock: '',
      view: 'factures' },
    patch
  ));
}

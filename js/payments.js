// =====================================================================
// payments.js — écran Paiements, réservé au gérant.
//
// Lecture seule : aucune écriture, aucun bouton d'action sur les données.
// La période est celle du bandeau, et le critère est la DATE DE PAIEMENT,
// pas la date de facture — c'est ce qui compte pour un relevé de trésorerie.
// =====================================================================
import { supabase } from './supabase.js';
import { renderSupplierDetail } from './suppliers.js';
import { downloadInvoicesCSV } from './export.js';
import {
  $, fmtEUR, fmtDate, escapeHtml, toast, errorMessage,
  getMonth, monthLabel, slugify, ICONS
} from './ui.js';
import { isManager } from './auth.js';

let rows = [];   // factures payées sur la période affichée

/** Bornes du mois sélectionné, au format ISO */
function monthBounds(m) {
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(y, mo, 0).getDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` };
}

// ---------------------------------------------------------------------
export async function renderPayments() {
  if (!isManager()) {
    $('#payments-body').innerHTML =
      '<div class="card pad"><p class="muted">Cet écran est réservé au gérant.</p></div>';
    return;
  }

  const month = getMonth();
  const { from, to } = monthBounds(month);
  $('#payments-month').textContent = monthLabel(month);
  const body = $('#payments-body');
  body.innerHTML = '<div class="muted small" style="padding:14px">Chargement…</div>';

  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, smart_ref, external_refs, invoice_date, payment_date, payment_method, amount_htva, amount_tvac, vat_rate, encoded_at, due_date, in_smart, in_winauditor, stock_in, stock_out, payment_status, expense_type, notes, supplier:suppliers(id, name)')
      .eq('payment_status', 'paye')
      .gte('payment_date', from)
      .lte('payment_date', to)
      .order('payment_date', { ascending: false });
    if (error) throw error;
    rows = (data || []).map((r) => ({ ...r, supplier_name: r.supplier?.name || '—' }));
  } catch (err) {
    console.error(err);
    body.innerHTML = `<div class="empty"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  const total = rows.reduce((s, r) => s + (Number(r.amount_tvac) || 0), 0);
  const totalHtva = rows.reduce((s, r) => s + (Number(r.amount_htva) || 0), 0);

  if (!rows.length) {
    body.innerHTML = `<div class="card"><div class="empty">${ICONS.empty}
      <p>Aucun paiement enregistré en ${escapeHtml(monthLabel(month).toLowerCase())}</p></div></div>`;
    return;
  }

  // Détail par fournisseur
  const parFournisseur = new Map();
  for (const r of rows) {
    const key = r.supplier?.id || r.supplier_name;
    if (!parFournisseur.has(key)) {
      parFournisseur.set(key, { id: r.supplier?.id, nom: r.supplier_name, n: 0, tvac: 0 });
    }
    const e = parFournisseur.get(key);
    e.n += 1;
    e.tvac += Number(r.amount_tvac) || 0;
  }
  const fournisseurs = [...parFournisseur.values()].sort((a, b) => b.tvac - a.tvac);

  body.innerHTML = `
    <div class="kpi-grid kpi-grid-4">
      <div class="card kpi kpi-hero">
        <div class="kpi-label">Total payé sur le mois</div>
        <div class="kpi-value">${fmtEUR(total)}</div>
        <div class="kpi-sub">sur la date de paiement, pas la date de facture</div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">Factures payées</div>
        <div class="kpi-value">${rows.length}</div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">Total HTVA</div>
        <div class="kpi-value">${fmtEUR(totalHtva)}</div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">Fournisseurs</div>
        <div class="kpi-value">${fournisseurs.length}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Par fournisseur</h2></div>
      <div class="table-wrap">
        <table class="table" id="pay-by-supplier">
          <thead><tr>
            <th>Fournisseur</th><th class="num">Factures</th><th class="num">Total payé</th><th class="num">Part</th>
          </tr></thead>
          <tbody>
            ${fournisseurs.map((f) => `
              <tr>
                <td data-label="Fournisseur">${f.id
                  ? `<button type="button" class="link-btn" data-pay-supplier="${f.id}">${escapeHtml(f.nom)}</button>`
                  : escapeHtml(f.nom)}</td>
                <td data-label="Factures" class="num">${f.n}</td>
                <td data-label="Total payé" class="num strong">${fmtEUR(f.tvac)}</td>
                <td data-label="Part" class="num">${total ? Math.round((f.tvac / total) * 100) : 0} %</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Factures payées</h2></div>
      <div class="table-wrap">
        <table class="table" id="pay-invoices">
          <thead><tr>
            <th>Date de paiement</th><th>Fournisseur</th><th>N° facture</th>
            <th>Réf. Smart</th><th>Mode</th><th class="num">Total TVAC</th>
          </tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td data-label="Date de paiement">${fmtDate(r.payment_date)}</td>
                <td data-label="Fournisseur">${escapeHtml(r.supplier_name)}</td>
                <td data-label="N° facture">${escapeHtml(r.invoice_number)}</td>
                <td data-label="Réf. Smart">${r.smart_ref ? escapeHtml(r.smart_ref) : '<span class="muted">—</span>'}</td>
                <td data-label="Mode">${r.payment_method ? escapeHtml(r.payment_method) : '<span class="muted">—</span>'}</td>
                <td data-label="Total TVAC" class="num strong">${fmtEUR(r.amount_tvac)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="table-foot">
        <span>${rows.length} facture${rows.length > 1 ? 's' : ''}</span>
        <span>Total payé : <strong class="big">${fmtEUR(total)}</strong></span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
export function initPayments(showTab) {
  $('#payments-export').addEventListener('click', () => {
    if (!rows.length) { toast('Aucun paiement à exporter sur ce mois.', 'error'); return; }
    downloadInvoicesCSV(rows, `VK_paiements_${getMonth()}.csv`);
  });

  $('#payments-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pay-supplier]');
    if (!b) return;
    showTab('suppliers');
    renderSupplierDetail(b.dataset.paySupplier);
  });

  window.addEventListener('vk:month', () => {
    if (!$('#tab-payments').hidden) renderPayments();
  });
}

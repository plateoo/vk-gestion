// =====================================================================
// admin.js — écran Administration, réservé au gérant.
//
// Aucune opération sensible n'est faite depuis le navigateur : la création
// de compte, la désactivation et les liens de réinitialisation passent par
// la fonction admin-users, qui détient la clé service_role côté serveur et
// revérifie le rôle de l'appelant.
//
// Aucun mot de passe n'est affiché ni transmis. Un nouveau compte reçoit un
// lien de définition de mot de passe, produit par Supabase Auth.
// =====================================================================
import { supabase } from './supabase.js';
import {
  $, $$, escapeHtml, toast, errorMessage, confirmDialog,
  fmtDate, longDate, ICONS
} from './ui.js';
import { isManager } from './auth.js';
import { loadMaintenance, backupCardHtml, securityCardHtml, wireMaintenance } from './maintenance.js';

let users = [];

const octets = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} o`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} Ko`;
  return `${(v / 1024 / 1024).toFixed(1)} Mo`;
};

async function appeler(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body: { action, ...payload } });
  if (error) {
    // le corps d'erreur de la fonction porte le message utile
    let msg = error.message;
    try { msg = (await error.context?.json())?.error || msg; } catch { /* garde le message d'origine */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------------
export async function renderAdmin() {
  const body = $('#admin-body');
  if (!isManager()) {
    body.innerHTML = '<div class="card pad"><p class="muted">Cet écran est réservé au gérant.</p></div>';
    return;
  }
  body.innerHTML = '<div class="muted small" style="padding:14px">Chargement…</div>';

  let etat = null, journal = [];
  try {
    const [u, s, l] = await Promise.all([
      appeler('list'),
      supabase.rpc('system_status'),
      supabase.from('change_log').select('*').order('created_at', { ascending: false }).limit(40),
      // Sauvegardes et contrôle de sécurité : chargés en même temps que le
      // reste, pour que l'écran ne s'affiche jamais sans eux.
      loadMaintenance()
    ]);
    users = u.users || [];
    etat = typeof s.data === 'string' ? JSON.parse(s.data) : s.data;
    journal = l.data || [];
  } catch (err) {
    console.error(err);
    body.innerHTML = `<div class="card pad"><p>${escapeHtml(errorMessage(err, 'Chargement impossible.'))}</p></div>`;
    return;
  }

  const erreurs = etat?.erreurs_extraction || [];

  body.innerHTML = `
    <!-- État du système -->
    <div class="kpi-grid kpi-grid-4">
      <div class="card kpi"><div class="kpi-label">En quarantaine</div>
        <div class="kpi-value">${etat.quarantaine}</div>
        <div class="kpi-sub">${etat.expediteurs_autorises} expéditeur${Number(etat.expediteurs_autorises) > 1 ? 's' : ''} autorisé${Number(etat.expediteurs_autorises) > 1 ? 's' : ''}</div></div>
      <div class="card kpi"><div class="kpi-label">Dernière réception</div>
        <div class="kpi-value" style="font-size:16px">${etat.derniere_reception ? escapeHtml(longDate(String(etat.derniere_reception).slice(0, 10))) : '—'}</div>
        <div class="kpi-sub">${etat.derniere_reception ? String(etat.derniere_reception).slice(11, 16) : ''}</div></div>
      <div class="card kpi ${Number(etat.en_erreur) ? 'is-alert' : ''}"><div class="kpi-label">Extractions en erreur</div>
        <div class="kpi-value">${etat.en_erreur}</div>
        <div class="kpi-sub">${etat.en_attente} en cours</div></div>
      <div class="card kpi"><div class="kpi-label">Stockage</div>
        <div class="kpi-value">${octets(etat.stockage_octets)}</div>
        <div class="kpi-sub">${etat.stockage_fichiers} fichier${Number(etat.stockage_fichiers) > 1 ? 's' : ''}</div></div>
    </div>

    ${backupCardHtml()}
    ${securityCardHtml()}

    <!-- Comptes -->
    <div class="card">
      <div class="card-head"><h2>Comptes</h2></div>
      <div class="table-wrap">
        <table class="table" id="admin-users">
          <thead><tr>
            <th>Utilisateur</th><th>Rôle</th><th>Dernière connexion</th><th>État</th><th class="no-print">Actions</th>
          </tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr data-user="${u.id}">
                <td data-label="Utilisateur">
                  <span class="strong">${escapeHtml(u.full_name || '—')}</span>
                  ${u.is_self ? '<span class="tag">vous</span>' : ''}
                  <div class="muted small">${escapeHtml(u.email || '')}</div>
                </td>
                <td data-label="Rôle">
                  <select class="role-select" data-role-for="${u.id}" ${u.is_self ? 'disabled title="Vous ne pouvez pas modifier votre propre rôle"' : ''}>
                    <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>Gérant</option>
                    <option value="secretary" ${u.role === 'secretary' ? 'selected' : ''}>Secrétaire</option>
                  </select>
                  ${u.role ? '' : '<div class="field-hint warn">sans profil : aucun accès aux données</div>'}
                </td>
                <td data-label="Dernière connexion">${u.last_sign_in_at ? fmtDate(u.last_sign_in_at.slice(0, 10)) : '<span class="muted">jamais</span>'}</td>
                <td data-label="État">${u.disabled
                  ? '<span class="badge st-red">désactivé</span>'
                  : '<span class="badge st-green">actif</span>'}</td>
                <td data-label="Actions" class="no-print actions">
                  <button type="button" class="btn btn-sm" data-reset="${escapeHtml(u.email || '')}">Lien de mot de passe</button>
                  ${u.is_self ? '' : `<button type="button" class="btn btn-sm ${u.disabled ? '' : 'btn-danger'}"
                     data-toggle-user="${u.id}" data-disabled="${u.disabled ? '1' : ''}">${u.disabled ? 'Réactiver' : 'Désactiver'}</button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Création -->
    <div class="card pad">
      <div class="card-head" style="padding:0 0 10px"><h2>Créer un compte</h2></div>
      <div class="toolbar">
        <input id="adm-email" type="email" placeholder="prenom@vkgestion.local" class="search">
        <input id="adm-name" type="text" placeholder="Nom affiché">
        <select id="adm-role">
          <option value="secretary">Secrétaire</option>
          <option value="manager">Gérant</option>
        </select>
        <button type="button" id="adm-create" class="btn btn-primary">Créer</button>
      </div>
      <p class="field-hint">Aucun mot de passe n'est créé ni affiché. Un lien de définition de mot de passe
        est produit, à transmettre à la personne.</p>
      <div id="adm-link" class="admin-link" hidden></div>
    </div>

    <!-- Erreurs d'extraction -->
    ${erreurs.length ? `
      <div class="card">
        <div class="card-head"><h2>Dernières erreurs d'extraction</h2></div>
        <div class="q-list">
          ${erreurs.map((e) => `
            <div class="q-row">
              <div class="q-main">
                <span class="q-email">${escapeHtml(e.sender_email || '—')}</span>
                <span class="q-meta">${escapeHtml(e.subject || '(sans objet)')}
                  <span class="sep">·</span> ${e.quand ? escapeHtml(String(e.quand).slice(0, 16).replace('T', ' à ')) : ''}
                  <span class="sep">·</span> ${e.attempts} tentative${Number(e.attempts) > 1 ? 's' : ''}</span>
                <span class="q-subject txt-red">${escapeHtml(e.error || '')}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}

    <!-- Journal -->
    <div class="card">
      <div class="card-head"><h2>Journal des changements</h2>
        <p class="muted small">Lecture seule, 40 dernières entrées.</p></div>
      ${journal.length ? `
        <div class="table-wrap">
          <table class="table" id="admin-journal">
            <thead><tr><th>Quand</th><th>Qui</th><th>Quoi</th><th>Avant</th><th>Après</th><th>Motif</th></tr></thead>
            <tbody>
              ${journal.map((l) => `
                <tr>
                  <td data-label="Quand">${escapeHtml(String(l.created_at).slice(0, 16).replace('T', ' à '))}</td>
                  <td data-label="Qui">${escapeHtml(l.author_name || '—')}</td>
                  <td data-label="Quoi">${escapeHtml(l.entity_label || l.entity)} <span class="muted">· ${escapeHtml(l.field)}</span></td>
                  <td data-label="Avant" class="muted">${escapeHtml(l.old_value ?? '—')}</td>
                  <td data-label="Après" class="strong">${escapeHtml(l.new_value ?? '—')}</td>
                  <td data-label="Motif" class="muted small">${escapeHtml(l.reason || '')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      : `<div class="empty" id="admin-journal-vide"><p>Aucun changement journalisé pour l'instant.</p></div>`}
    </div>`;

  // Les boutons des cartes Sauvegardes et Contrôle de sécurité sont recréés
  // à chaque rendu : on les recâble ici, en leur donnant de quoi se
  // rafraîchir eux-mêmes.
  wireMaintenance(renderAdmin);
}

// ---------------------------------------------------------------------
function afficherLien(lien, email) {
  const box = $('#adm-link');
  if (!lien) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `
    <p class="strong">Lien à transmettre à ${escapeHtml(email)}</p>
    <input type="text" readonly value="${escapeHtml(lien)}" id="adm-link-value">
    <p class="field-hint">Ce lien permet de définir un mot de passe : traite-le comme un secret,
      transmets-le par un canal sûr, et sache qu'il expire.</p>
    <button type="button" class="btn btn-sm" id="adm-copy">Copier</button>`;
  $('#adm-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(lien);
      toast('Lien copié.');
    } catch {
      $('#adm-link-value').select();
      toast('Sélectionne et copie le lien.', 'error');
    }
  };
}

async function creer() {
  const email = $('#adm-email').value.trim();
  const full_name = $('#adm-name').value.trim();
  const role = $('#adm-role').value;
  if (!email.includes('@')) { toast('Adresse e-mail invalide.', 'error'); return; }
  const btn = $('#adm-create');
  btn.disabled = true;
  try {
    const r = await appeler('create', { email, full_name, role });
    toast(`Compte ${email} créé.`);
    $('#adm-email').value = '';
    $('#adm-name').value = '';
    await renderAdmin();
    afficherLien(r.lien, email);
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, err.message || 'Création impossible.'), 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
export function initAdmin() {
  const body = $('#admin-body');

  body.addEventListener('click', async (e) => {
    const creerBtn = e.target.closest('#adm-create');
    if (creerBtn) return creer();

    const reset = e.target.closest('[data-reset]');
    if (reset) {
      try {
        const r = await appeler('reset', { email: reset.dataset.reset });
        afficherLien(r.lien, reset.dataset.reset);
        $('#adm-link')?.scrollIntoView({ block: 'center' });
      } catch (err) {
        toast(errorMessage(err, err.message || 'Lien impossible à produire.'), 'error');
      }
      return;
    }

    const bascule = e.target.closest('[data-toggle-user]');
    if (bascule) {
      const desactive = !!bascule.dataset.disabled;
      const u = users.find((x) => x.id === bascule.dataset.toggleUser);
      const ok = await confirmDialog(
        desactive
          ? `Réactiver le compte ${u?.email} ?`
          : `Désactiver ${u?.email} ? La personne ne pourra plus se connecter, mais ses données restent.`,
        desactive ? 'Réactiver' : 'Désactiver');
      if (!ok) return;
      try {
        await appeler(desactive ? 'enable' : 'disable', { id: bascule.dataset.toggleUser });
        toast(desactive ? 'Compte réactivé.' : 'Compte désactivé.');
        await renderAdmin();
      } catch (err) {
        toast(errorMessage(err, err.message || 'Opération impossible.'), 'error');
      }
    }
  });

  body.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role-for]');
    if (!sel) return;
    try {
      await appeler('set_role', { id: sel.dataset.roleFor, role: sel.value });
      toast('Rôle modifié.');
      await renderAdmin();
    } catch (err) {
      toast(errorMessage(err, err.message || 'Changement de rôle impossible.'), 'error');
      await renderAdmin();
    }
  });
}

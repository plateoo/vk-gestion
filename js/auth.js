// =====================================================================
// auth.js — connexion / déconnexion / session / rôle utilisateur
// =====================================================================
import { supabase } from './supabase.js';
import { errorMessage } from './ui.js';

// État courant (live bindings : les autres modules voient toujours la valeur à jour)
export let currentUser = null;
export let currentProfile = null;

/** L'utilisateur connecté est-il le gérant ? */
export function isManager() {
  return currentProfile?.role === 'manager';
}

export function displayName() {
  return currentProfile?.full_name || currentUser?.email || '';
}

export function roleLabel() {
  return isManager() ? 'Gérant' : 'Secrétaire';
}

/** Session existante au chargement (null si aucune) */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** Charge le profil (nom + rôle) de l'utilisateur connecté */
export async function loadProfile(user) {
  currentUser = user;
  if (!user) { currentProfile = null; return null; }
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single();
  if (error) {
    // Profil manquant : on dégrade en "secretary" plutôt que de bloquer l'app
    console.warn('[VK Gestion] profil introuvable :', error.message);
    currentProfile = { id: user.id, full_name: user.email, role: 'secretary' };
    return currentProfile;
  }
  currentProfile = data;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(errorMessage(error, 'Connexion impossible.'));
  await loadProfile(data.user);
  return data.user;
}

export async function signOut() {
  await supabase.auth.signOut();
  currentUser = null;
  currentProfile = null;
}

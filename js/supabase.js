// Initialisation du client Supabase (client officiel via CDN ESM, aucune dépendance locale)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// La configuration est-elle réellement renseignée ?
export const CONFIG_OK = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL)
  && SUPABASE_ANON_KEY.length > 20;

if (!CONFIG_OK) {
  console.error('[VK Gestion] js/config.js n\'est pas rempli : SUPABASE_URL / SUPABASE_ANON_KEY manquants ou invalides.');
}

// Si la config est absente, on crée le client sur une URL neutre : l'app affiche un
// message clair au lieu de planter au chargement du module.
export const supabase = createClient(
  CONFIG_OK ? SUPABASE_URL : 'https://placeholder.supabase.co',
  CONFIG_OK ? SUPABASE_ANON_KEY : 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,      // session conservée entre les rechargements
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  }
);

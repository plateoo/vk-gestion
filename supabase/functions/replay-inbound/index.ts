// =====================================================================
// replay-inbound — rejoue des messages sortis de quarantaine.
//
// Appelée par l'écran de réglages avec le jeton de l'utilisateur connecté.
// Le contrôle du rôle se fait côté base : is_manager() décide, pas le front.
//
// POST { ids: string[] }  ->  { replayed: n }
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { processQueueRow } from '../_shared/process.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Non authentifié.' }, 401);

  // Client porteur du jeton de l'appelant : c'est la base qui tranche.
  const asUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } }
  );

  const { data: isManager, error: roleErr } = await asUser.rpc('is_manager');
  if (roleErr) return json({ error: 'Vérification du rôle impossible.' }, 400);
  if (!isManager) return json({ error: 'Seul le gérant peut rejouer un message.' }, 403);

  let ids: string[] = [];
  try {
    const body = await req.json();
    ids = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === 'string') : [];
  } catch {
    return json({ error: 'Requête illisible.' }, 400);
  }
  if (!ids.length) return json({ error: 'Aucun message à rejouer.' }, 400);
  if (ids.length > 50) return json({ error: 'Trop de messages d\'un coup (50 maximum).' }, 400);

  // On répond tout de suite : chaque extraction prend une dizaine de secondes.
  // @ts-ignore : EdgeRuntime est fourni par le runtime Supabase
  EdgeRuntime.waitUntil((async () => {
    for (const id of ids) await processQueueRow(id);
  })());

  return json({ replaying: ids.length });
});

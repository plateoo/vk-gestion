// =====================================================================
// deposer-factures — une facture déposée à la main dans l'application
//
// Quand une facture n'arrive pas par la boîte mail (pièce jointe
// imbriquée dans un mail transféré, lien de téléchargement, papier
// photographié), le bureau la dépose ici. Elle suit EXACTEMENT le chemin
// d'un mail : dépôt dans le stockage, file d'attente, extraction,
// rapprochement, puis « À contrôler ». Rien n'entre en base sans qu'un
// humain valide.
//
// L'expéditeur de la file est depot@vk-gestion.app, déclaré transitaire
// (migration 0043) : son adresse ne sert jamais à rapprocher un
// fournisseur, ni ne s'inscrit dans une fiche.
//
// POST { files: [{ name, type, b64 }], note? }  ->  { queue_id, files }
// Réservé au bureau (is_member) : un vendeur ne touche pas aux factures.
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { db, processQueueRow } from '../_shared/process.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const EXPEDITEUR = 'depot@vk-gestion.app';
const MAX_FICHIERS = 10;
const MAX_OCTETS = 15 * 1024 * 1024;

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Non authentifié.' });

  // Le droit se lit en base, avec le jeton de l'appelant
  const asUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } }
  );
  const { data: bureau, error: roleErr } = await asUser.rpc('is_member');
  if (roleErr) return json({ error: 'Vérification du droit impossible.' });
  if (!bureau) return json({ error: 'Seuls le gérant et le bureau déposent des factures.' });
  const { data: me } = await asUser.auth.getUser();
  const moi = me?.user?.id ?? null;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Requête illisible.' }); }
  const liste = Array.isArray(body.files) ? body.files as Record<string, unknown>[] : [];
  if (!liste.length) return json({ error: 'Aucun fichier à déposer.' });
  if (liste.length > MAX_FICHIERS) return json({ error: `${MAX_FICHIERS} fichiers au plus par dépôt.` });

  const sb = db();
  const { data: profil } = await sb.from('profiles').select('full_name').eq('id', moi).maybeSingle();
  const qui = profil?.full_name || 'le bureau';

  const now = new Date();
  const dossier = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const files: { path: string; name: string; content_type: string; size: number }[] = [];
  let total = 0;
  for (const f of liste) {
    const name = String(f.name ?? 'facture').slice(0, 120) || 'facture';
    const type = String(f.type ?? '') || 'application/octet-stream';
    if (!/pdf|xml|image\//i.test(type) && !/\.(pdf|xml|png|jpe?g|webp|gif)$/i.test(name)) {
      return json({ error: `« ${name} » n'est ni un PDF, ni un XML, ni une photo.` });
    }
    let bytes: Uint8Array;
    try { bytes = b64ToBytes(String(f.b64 ?? '')); } catch { return json({ error: `« ${name} » est illisible.` }); }
    if (!bytes.length) return json({ error: `« ${name} » est vide.` });
    total += bytes.length;
    if (total > MAX_OCTETS) return json({ error: 'Dépôt trop lourd : 15 Mo au plus en une fois.' });
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80);
    const path = `${dossier}/${crypto.randomUUID()}-${safe}`;
    const { error } = await sb.storage.from('factures').upload(path, bytes, { contentType: type, upsert: false });
    if (error) return json({ error: `Dépôt de « ${name} » impossible : ${error.message}` });
    files.push({ path, name, content_type: type, size: bytes.length });
  }

  const note = String(body.note ?? '').trim().slice(0, 200);
  const { data: queued, error: qErr } = await sb.from('inbound_queue').insert({
    message_id: `depot:${crypto.randomUUID()}`,
    sender_email: EXPEDITEUR,
    subject: `Déposé dans l'application par ${qui}${note ? ` — ${note}` : ''}`,
    received_at: now.toISOString(),
    files,
    status: 'pending'
  }).select('id').single();
  if (qErr) return json({ error: `Mise en file impossible : ${qErr.message}` });

  // Réponse immédiate ; l'extraction (10 à 20 s par pièce) continue.
  // @ts-ignore : EdgeRuntime est fourni par le runtime Supabase
  EdgeRuntime.waitUntil(processQueueRow(queued.id));

  return json({ queue_id: queued.id, files: files.length });
});

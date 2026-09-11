// =====================================================================
// classify-documents — dit ce qu'est chaque pièce déjà en base.
//
// Les premières factures sont arrivées avant que l'extraction sache
// distinguer une facture de conditions générales. Cette fonction relit
// les pièces non classées, leur pose un type et écrit la synthèse qui
// permet de les reconnaître sans les ouvrir.
//
// Ne touche jamais aux montants, numéros ni dates déjà enregistrés : elle
// n'écrit que doc_type, doc_summary et, pour une pièce qui n'est pas une
// facture, review_status = 'document'.
//
// POST { ids?: string[], limit?: number }  ->  { classifying: n }
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractFromPdf } from '../_shared/process.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const TYPES = ['facture', 'note_credit', 'conditions_generales', 'bon_commande',
               'proforma', 'listing', 'rappel', 'autre'];

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
  if (!isManager) return json({ error: 'Seul le gérant peut lancer un classement.' }, 403);

  let ids: string[] = [];
  let limite = 20;
  try {
    const body = await req.json().catch(() => ({}));
    ids = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === 'string') : [];
    if (Number.isFinite(body?.limit)) limite = Math.max(1, Math.min(40, Number(body.limit)));
  } catch { /* corps facultatif */ }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Sans liste explicite : les pièces jamais classées, les plus anciennes
  // d'abord, par paquets — pour que la barre de progression avance.
  let cibles = ids;
  if (!cibles.length) {
    // doc_summary non nul avec doc_type nul = échec déjà constaté sur cette
    // pièce. On ne la reprend pas en boucle : elle reste visible et se
    // relance en passant son id explicitement.
    const { data } = await sb.from('invoices')
      .select('id')
      .is('doc_type', null)
      .is('doc_summary', null)
      .not('file_path', 'is', null)
      .order('created_at', { ascending: true })
      .limit(limite);
    cibles = (data ?? []).map((r: { id: string }) => r.id);
  }
  if (!cibles.length) return json({ classifying: 0, message: 'Tout est déjà classé.' });

  // On répond tout de suite : chaque lecture prend une dizaine de secondes.
  // @ts-ignore : EdgeRuntime est fourni par le runtime Supabase
  EdgeRuntime.waitUntil((async () => {
    for (const id of cibles) {
      try {
        const { data: inv } = await sb.from('invoices')
          .select('id, file_path, review_status').eq('id', id).maybeSingle();
        if (!inv?.file_path) continue;

        // Les pièces jointes qui ne sont ni PDF ni XML n'ont jamais été
        // lues : on les marque sans appeler l'API, cela ne servirait à rien.
        if (!/\.pdf$/i.test(inv.file_path)) {
          await sb.from('invoices').update({
            doc_type: 'autre',
            doc_summary: 'Pièce jointe qui n\'est pas un PDF : non lue par l\'extraction.',
            review_status: 'document'
          }).eq('id', id);
          continue;
        }

        const { data: blob, error: dlErr } = await sb.storage.from('factures').download(inv.file_path);
        if (dlErr || !blob) throw new Error('fichier introuvable dans le stockage');

        const lu = await extractFromPdf(new Uint8Array(await blob.arrayBuffer()));
        const kind = TYPES.includes(String(lu.type_document)) ? String(lu.type_document) : 'autre';
        const estFacture = kind === 'facture' || kind === 'note_credit';

        await sb.from('invoices').update({
          doc_type: kind,
          doc_summary: (lu.synthese as string) ?? null,
          // une facture garde l'état où elle est ; le reste part au dossier
          review_status: estFacture ? inv.review_status : 'document'
        }).eq('id', id);
      } catch (e) {
        // Une pièce illisible ne bloque pas les suivantes. On garde
        // doc_type à null — la pièce n'est PAS déclarée « autre », ce serait
        // affirmer qu'on l'a lue — et on note l'échec, visible à l'écran.
        await sb.from('invoices').update({
          doc_summary: `Classement impossible : ${e instanceof Error ? e.message : String(e)}`
        }).eq('id', id);
      }
    }
  })());

  return json({ classifying: cibles.length });
});

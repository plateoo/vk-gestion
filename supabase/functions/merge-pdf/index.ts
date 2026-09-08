// =====================================================================
// merge-pdf — assemble en un seul PDF les fichiers d'origine des factures
// sélectionnées, pour une impression en une seule fois.
//
// Appelée depuis le front avec le jeton de l'utilisateur connecté :
// on interroge la base et le stockage AVEC ce jeton, donc les policies RLS
// s'appliquent telles quelles. Aucune clé service_role ici.
//
// POST { ids: string[] }  ->  application/pdf
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Non authentifié.' }, 401);

  let ids: string[] = [];
  try {
    const body = await req.json();
    ids = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === 'string') : [];
  } catch {
    return json({ error: 'Requête illisible.' }, 400);
  }
  if (!ids.length) return json({ error: 'Aucune facture sélectionnée.' }, 400);
  if (ids.length > 200) return json({ error: 'Trop de factures d\'un coup (200 maximum).' }, 400);

  // Client porteur du jeton de l'utilisateur : les policies RLS s'appliquent.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } }
  );

  const { data: rows, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, file_path, supplier:suppliers(name)')
    .in('id', ids)
    .not('file_path', 'is', null)
    .order('invoice_date', { ascending: true });

  if (error) return json({ error: 'Lecture des factures impossible.', detail: error.message }, 400);
  if (!rows?.length) return json({ error: 'Aucun document joint sur cette sélection.' }, 404);

  const merged = await PDFDocument.create();
  const skipped: string[] = [];

  for (const row of rows) {
    try {
      const { data: file, error: dlError } = await supabase.storage
        .from('factures')
        .download(row.file_path as string);
      if (dlError || !file) { skipped.push(`${row.invoice_number} (fichier introuvable)`); continue; }

      const bytes = new Uint8Array(await file.arrayBuffer());
      // Un PDF commence toujours par %PDF- ; le reste (XML, image) n'est pas assemblable.
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
        skipped.push(`${row.invoice_number} (n'est pas un PDF)`);
        continue;
      }

      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch (e) {
      skipped.push(`${row.invoice_number} (illisible)`);
      console.error('merge-pdf', row.invoice_number, e instanceof Error ? e.message : e);
    }
  }

  if (merged.getPageCount() === 0) {
    return json({ error: 'Aucun PDF exploitable dans la sélection.', skipped }, 422);
  }

  const out = await merged.save();
  return new Response(out, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="VK_factures.pdf"',
      // Permet au front de prévenir Marie que certaines pièces ont été écartées
      'X-Skipped': encodeURIComponent(skipped.join(' | ')),
      'X-Merged-Count': String(rows.length - skipped.length)
    }
  });
});

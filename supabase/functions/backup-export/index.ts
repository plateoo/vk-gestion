// =====================================================================
// backup-export — remet la dernière sauvegarde à un automate extérieur.
//
// Sert à un flux Power Automate planifié qui dépose l'archive dans
// OneDrive : c'est la seule protection contre la perte du projet
// Supabase lui-même. Un instantané rangé dans la base qu'il protège ne
// couvre que la moitié des accidents.
//
// CE QUE CETTE FONCTION EXPOSE : l'intégralité des données — factures,
// fournisseurs, journal, file de réception. C'est plus que le jeton de
// réception, qui ne permet que d'injecter un message. Le jeton doit donc
// vivre uniquement dans les secrets de la fonction et dans le flux Power
// Automate, jamais dans le dépôt ni dans une conversation.
//
//   POST/GET, en-tête x-backup-token
//   ?format=json (défaut) — la sauvegarde elle-même
//   ?fresh=1              — constitue un instantané neuf avant de répondre
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const JETON = Deno.env.get('BACKUP_EXPORT_TOKEN') ?? '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Comparaison à durée constante : une comparaison ordinaire s'arrête au
 * premier caractère différent, et le temps de réponse renseigne alors sur
 * le préfixe correct.
 */
function memeJeton(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (!JETON) return json({ error: 'Export non configuré.' }, 503);

  const url = new URL(req.url);
  const fourni = req.headers.get('x-backup-token')
    ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!memeJeton(fourni, JETON)) {
    // Aucun détail : ni la longueur attendue, ni l'existence du secret.
    return json({ error: 'Non autorisé.' }, 401);
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    // Par défaut on prend le dernier instantané : il date au pire de la
    // nuit. « fresh=1 » en constitue un neuf, pour un export qui doit
    // refléter l'instant même.
    if (url.searchParams.get('fresh') === '1') {
      const { error } = await sb.rpc('backup_create', { p_kind: 'auto', p_note: 'export automatique' });
      if (error) throw error;
    }

    const { data: dernier, error: e1 } = await sb.from('backups')
      .select('id, created_at, payload, row_counts, size_bytes')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (e1) throw e1;
    if (!dernier) return json({ error: 'Aucune sauvegarde disponible.' }, 404);

    // La sauvegarde est comptée comme emportée : c'est ce qui éteint
    // l'alerte « rien n'est sorti de la base » du contrôle de sécurité.
    await sb.from('backups')
      .update({ downloaded_at: new Date().toISOString(), note: 'export automatique vers OneDrive' })
      .eq('id', dernier.id);

    const nom = `VK_sauvegarde_${String(dernier.created_at).slice(0, 10)}.json`;
    return new Response(JSON.stringify(dernier.payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${nom}"`,
        'X-VK-Backup-Date': String(dernier.created_at),
        'X-VK-Backup-Rows': JSON.stringify(dernier.row_counts)
      }
    });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

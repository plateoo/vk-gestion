// =====================================================================
// inbound-mail — l'aperçu du courrier.
//
// Reçoit un message, le classe, en garde une phrase. PAS son contenu.
//
// Ce que cette fonction NE FAIT PAS, volontairement :
//   • elle ne stocke ni le corps du message ni ses pièces jointes ;
//   • elle ne déplace rien dans la boîte mail ;
//   • elle ne résume pas le courrier personnel.
//
// Les factures continuent de passer par inbound-invoice, qui seul lit les
// pièces jointes. Les deux chemins sont séparés à dessein : l'un traite
// des documents comptables, l'autre ne fait que compter et résumer.
//
//   POST, en-tête x-mail-token
//   { message_id, received_at, sender_email, sender_name, subject, body }
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const JETON = Deno.env.get('MAIL_DIGEST_TOKEN') ?? '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-mail-token, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function memeJeton(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PROMPT = `Tu tries le courrier d'une cuisiniste belge — Vanden Borre Kitchen, un
magasin de cuisines. Tu reçois l'expéditeur, l'objet et le début du message.

Réponds UNIQUEMENT avec un objet JSON, sans texte avant ou après.

{
  "categorie": "facture"|"fournisseur"|"client"|"administratif"|"banque"|"personnel"|"publicite"|"autre",
  "importance": "haute"|"normale"|"basse",
  "synthese": string|null,   // UNE phrase, 140 caractères maximum
  "action": string|null      // ce qu'il y a à faire, en 5 mots, ou null
}

CATÉGORIES
- "facture" : une facture, une note de crédit ou un rappel de paiement d'un fournisseur.
- "fournisseur" : commande, livraison, tarif, catalogue, service après-vente.
- "client" : un particulier ou un chantier — devis, rendez-vous, réclamation.
- "administratif" : TVA, ONSS, comptable, assurance, commune, contrôle.
- "banque" : relevé, virement, financement, carte.
- "personnel" : tout ce qui ne relève pas de l'activité du magasin —
  famille, santé, loisirs, correspondance privée.
- "publicite" : démarchage, newsletter, promotion non sollicitée.
- "autre" : le reste.

IMPORTANCE — du point de vue du gérant, pas de l'expéditeur.
- "haute" : de l'argent ou un délai est en jeu. Rappel de paiement, mise en
  demeure, courrier de l'administration ou de la banque, réclamation d'un
  client, livraison bloquée, incident.
- "normale" : le courant de l'activité.
- "basse" : publicité, newsletter, notification automatique, accusé de
  réception. Rien à faire, rien à lire.

RÈGLE ABSOLUE SUR LE COURRIER PERSONNEL
Si categorie vaut "personnel", alors synthese et action valent null. Aucune
exception. Tu ne résumes JAMAIS un message privé : cet aperçu est affiché
dans un logiciel de travail, et le contenu n'y a pas sa place.

AUTRES RÈGLES
- La synthèse dit de quoi il s'agit, pas ce que le message dit joliment.
  « Rappel de la facture 2026-4471, 1 245 € échus depuis le 3 septembre »
  vaut mieux que « le fournisseur revient vers vous ».
- action : « à payer », « répondre au client », « rien à faire ». Null si
  rien n'est attendu.
- Dans le doute entre deux importances, choisis la plus basse. Une alerte
  qui se déclenche pour rien finit par ne plus être regardée.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);
  if (!JETON) return json({ error: 'Aperçu du courrier non configuré.' }, 503);

  const fourni = req.headers.get('x-mail-token')
    ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!memeJeton(fourni, JETON)) return json({ error: 'Non autorisé.' }, 401);

  let p: Record<string, string>;
  try { p = await req.json(); } catch { return json({ error: 'Requête illisible.' }, 400); }

  const messageId = String(p.message_id ?? '').trim();
  if (!messageId) return json({ error: 'message_id manquant.' }, 400);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Déjà vu : on ne relit pas, et surtout on ne repaie pas une lecture.
  const { data: deja } = await sb.from('mail_digest')
    .select('id').eq('message_id', messageId).maybeSingle();
  if (deja) return json({ ignored: true, reason: 'message déjà vu' });

  // On répond tout de suite : Power Automate n'a pas à attendre la lecture.
  // @ts-ignore : EdgeRuntime est fourni par le runtime Supabase
  EdgeRuntime.waitUntil((async () => {
    let lu = { categorie: 'autre', importance: 'normale', synthese: null as string | null, action: null as string | null };
    try {
      // Le corps est tronqué : l'objet et les premières lignes suffisent à
      // classer, et en envoyer moins coûte moins cher — à 100 messages par
      // jour, la différence compte.
      const extrait = String(p.body ?? '').replace(/\s+/g, ' ').slice(0, 1500);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `${PROMPT}\n\n---\nDe : ${p.sender_name ?? ''} <${p.sender_email ?? ''}>\n`
                   + `Objet : ${p.subject ?? '(sans objet)'}\n\n${extrait}`
          }]
        })
      });
      if (res.ok) {
        const body = await res.json();
        const texte = (body?.content ?? [])
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text).join('').trim();
        lu = { ...lu, ...JSON.parse(texte.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()) };
      }
    } catch (e) {
      console.error('classement du courrier', e);
      // Non classé plutôt que mal classé : il apparaîtra dans le courant,
      // sans résumé. Mieux vaut un blanc qu'une phrase inventée.
    }

    const categories = ['facture', 'fournisseur', 'client', 'administratif', 'banque', 'personnel', 'publicite', 'autre'];
    const categorie = categories.includes(lu.categorie) ? lu.categorie : 'autre';
    const importance = ['haute', 'normale', 'basse'].includes(lu.importance) ? lu.importance : 'normale';
    // Le garde-fou est appliqué ICI aussi, pas seulement demandé au modèle :
    // une consigne n'est pas une garantie, et la vie privée mérite les deux.
    const prive = categorie === 'personnel';

    // Le message a-t-il déjà donné une facture ? On fait le lien plutôt que
    // d'afficher deux fois la même chose sous deux formes.
    const { data: fact } = await sb.from('invoices')
      .select('id').eq('message_id', messageId).limit(1).maybeSingle();

    // Pour un message privé, l'EXPÉDITEUR est masqué lui aussi. « Cabinet
    // Lemaire » en dit déjà long sur la nature du courrier ; taire l'objet
    // sans taire le nom ne protégerait rien. Il ne reste que la date et le
    // fait qu'un courrier personnel est arrivé — ce qui suffit à compter,
    // et c'est tout ce que cet écran a à faire.
    await sb.from('mail_digest').insert({
      message_id: messageId,
      received_at: p.received_at ?? new Date().toISOString(),
      sender_email: prive ? null : (p.sender_email ?? null),
      sender_name: prive ? null : (p.sender_name ?? null),
      subject: prive ? '(courrier personnel)' : (p.subject ?? null),
      category: categorie,
      importance: prive ? 'normale' : importance,
      summary: prive ? null : (lu.synthese ?? null),
      action: prive ? null : (lu.action ?? null),
      invoice_id: fact?.id ?? null
    });
  })());

  return json({ received: true });
});

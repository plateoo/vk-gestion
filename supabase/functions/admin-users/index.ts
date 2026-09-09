// =====================================================================
// admin-users — gestion des comptes, réservée au gérant.
//
// La création d'un compte exige la clé service_role, qui ne doit jamais
// figurer dans le front. Cette fonction la détient côté serveur et ne
// l'expose pas ; elle vérifie d'abord que l'appelant est bien gérant, en
// interrogeant la base avec le jeton de l'appelant.
//
// Aucun mot de passe n'est renvoyé ni journalisé. Un nouveau compte reçoit
// un mot de passe aléatoire que personne ne lit : l'accès se fait par un
// lien de définition de mot de passe, produit par Supabase Auth.
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const admin = () => createClient(URL_, SERVICE, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Non authentifié.' }, 401);

  // C'est la base qui tranche sur le rôle, pas le front.
  const asUser = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } });
  const { data: isManager, error: roleErr } = await asUser.rpc('is_manager');
  if (roleErr) return json({ error: 'Vérification du rôle impossible.' }, 400);
  if (!isManager) return json({ error: 'Seul le gérant peut gérer les comptes.' }, 403);

  const { data: me } = await asUser.auth.getUser();
  const moi = me?.user?.id ?? null;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Requête illisible.' }, 400); }
  const action = String(body.action ?? '');
  const sb = admin();

  /** Journalise une opération d'administration : c'est ce qui rend le
   *  journal utile, les changements de compte étant les plus sensibles. */
  async function journaliser(champ: string, avant: string | null, apres: string | null,
                             motif: string, cible: string | null, libelle: string | null) {
    const { data: p } = await sb.from('profiles').select('full_name').eq('id', moi).maybeSingle();
    await sb.from('change_log').insert({
      entity: 'compte', entity_id: cible, entity_label: libelle,
      field: champ, old_value: avant, new_value: apres,
      reason: motif, author: moi, author_name: p?.full_name ?? null
    });
  }

  /** Nombre de gérants restants si l'on retire celui-ci */
  async function autresGerants(sauf: string | null): Promise<number> {
    const { data } = await sb.from('profiles').select('id').eq('role', 'manager');
    return (data || []).filter((p) => p.id !== sauf).length;
  }

  try {
    // -----------------------------------------------------------------
    if (action === 'list') {
      const { data: users, error } = await sb.auth.admin.listUsers({ perPage: 200 });
      if (error) throw error;
      const { data: profiles } = await sb.from('profiles').select('id, full_name, role');
      const byId = new Map((profiles || []).map((p) => [p.id, p]));
      return json({
        users: users.users.map((u) => {
          const p = byId.get(u.id);
          return {
            id: u.id,
            email: u.email,
            full_name: p?.full_name ?? null,
            role: p?.role ?? null,           // sans profil : compte sans accès aux données
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at,
            // un compte banni loin dans le futur est un compte désactivé
            disabled: !!u.banned_until && new Date(u.banned_until) > new Date(),
            is_self: u.id === moi
          };
        })
      });
    }

    // -----------------------------------------------------------------
    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = String(body.role ?? 'secretary');
      const fullName = String(body.full_name ?? '').trim() || email.split('@')[0];
      if (!email.includes('@')) return json({ error: 'Adresse e-mail invalide.' }, 400);
      if (!['manager', 'secretary'].includes(role)) return json({ error: 'Rôle inconnu.' }, 400);

      // Mot de passe aléatoire que personne ne lit : l'accès passe par le lien.
      const jetable = crypto.randomUUID() + crypto.randomUUID();
      const { data: created, error } = await sb.auth.admin.createUser({
        email, password: jetable, email_confirm: true, user_metadata: { full_name: fullName }
      });
      if (error) throw error;

      const { error: pErr } = await sb.from('profiles')
        .insert({ id: created.user.id, full_name: fullName, role });
      if (pErr) {
        // Pas de compte orphelin sans profil si l'insertion échoue
        await sb.auth.admin.deleteUser(created.user.id);
        throw pErr;
      }

      await journaliser('compte', null, `${email} (${role})`, 'création de compte', created.user.id, email);

      const { data: lien } = await sb.auth.admin.generateLink({ type: 'recovery', email });
      return json({
        created: true, id: created.user.id, email, role,
        // lien à transmettre : il permet de DÉFINIR le mot de passe, il n'en révèle aucun
        lien: lien?.properties?.action_link ?? null
      });
    }

    // -----------------------------------------------------------------
    if (action === 'reset') {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!email) return json({ error: 'Adresse manquante.' }, 400);
      const { data: lien, error } = await sb.auth.admin.generateLink({ type: 'recovery', email });
      if (error) throw error;
      await journaliser('mot_de_passe', null, 'lien de réinitialisation produit',
                        'réinitialisation demandée', null, email);
      return json({ lien: lien?.properties?.action_link ?? null });
    }

    // -----------------------------------------------------------------
    if (action === 'set_role') {
      const id = String(body.id ?? '');
      const role = String(body.role ?? '');
      if (!['manager', 'secretary'].includes(role)) return json({ error: 'Rôle inconnu.' }, 400);
      if (id === moi && role !== 'manager') {
        return json({ error: 'Un gérant ne peut pas se retirer lui-même le rôle gérant.' }, 403);
      }
      const { data: actuel } = await sb.from('profiles').select('role').eq('id', id).single();
      if (actuel?.role === 'manager' && role !== 'manager' && (await autresGerants(id)) === 0) {
        return json({ error: 'Impossible de retirer le rôle au dernier gérant.' }, 403);
      }
      const { error } = await sb.from('profiles').update({ role }).eq('id', id);
      if (error) throw error;
      const { data: u } = await sb.auth.admin.getUserById(id);
      await journaliser('role', actuel?.role ?? null, role, 'changement de rôle', id, u?.user?.email ?? null);
      return json({ updated: true, id, role });
    }

    // -----------------------------------------------------------------
    if (action === 'disable' || action === 'enable') {
      const id = String(body.id ?? '');
      const desactiver = action === 'disable';
      if (desactiver && id === moi) {
        return json({ error: 'Un gérant ne peut pas désactiver son propre compte.' }, 403);
      }
      if (desactiver) {
        const { data: p } = await sb.from('profiles').select('role').eq('id', id).single();
        if (p?.role === 'manager' && (await autresGerants(id)) === 0) {
          return json({ error: 'Impossible de désactiver le dernier compte gérant.' }, 403);
        }
      }
      const { error } = await sb.auth.admin.updateUserById(id, {
        ban_duration: desactiver ? '876000h' : 'none'
      });
      if (error) throw error;
      const { data: u2 } = await sb.auth.admin.getUserById(id);
      await journaliser('etat', desactiver ? 'actif' : 'désactivé', desactiver ? 'désactivé' : 'actif',
                        desactiver ? 'désactivation du compte' : 'réactivation du compte',
                        id, u2?.user?.email ?? null);
      return json({ updated: true, id, disabled: desactiver });
    }

    return json({ error: 'Action inconnue.' }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('admin-users', action, msg);
    return json({ error: msg }, 400);
  }
});

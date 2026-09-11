-- =====================================================================
-- VK Gestion — durcissement et contrôle de sécurité permanent
--
-- Deux choses distinctes :
--   1. une correction : figer le search_path des fonctions privilégiées ;
--   2. un contrôle qui tourne à la demande et dit, en français, ce qui va
--      et ce qui ne va pas — pour que l'état de sécurité ne dépende plus
--      de la mémoire de celui qui a écrit le code.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. FIGER LE search_path DES FONCTIONS « SECURITY DEFINER »
--
--    Ces fonctions s'exécutent avec les droits de leur propriétaire. Si
--    le search_path n'est pas fixé, quelqu'un qui pourrait créer un objet
--    dans un schéma consulté avant « public » ferait exécuter son propre
--    code avec ces droits.
--
--    Ce n'est pas exploitable ici : ni anon ni authenticated n'ont le
--    droit CREATE sur public. C'est une ceinture en plus des bretelles,
--    et elle ne coûte rien.
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosecdef
       and p.proconfig is null
  loop
    execute format('alter function %s set search_path = public, pg_temp', f.signature);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. LE CONTRÔLE
--
--    Chaque ligne : un intitulé, un état, et une phrase qui explique ce
--    que cela veut dire. Un contrôle qui dirait seulement « échec » sans
--    dire quoi faire ne servirait à personne.
--
--    Les états : 'ok' · 'attention' · 'probleme'
-- ---------------------------------------------------------------------
create or replace function public.security_audit()
returns json language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
  v json;
  v_sans_rls    text;
  v_sans_policy text;
  v_sans_path   int;
  v_buckets     text;
  v_gerants     int;
  v_comptes     int;
  v_sauv        timestamptz;
  v_emport      timestamptz;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut consulter le contrôle de sécurité.' using errcode = '42501';
  end if;

  select string_agg(c.relname, ', ') into v_sans_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  select string_agg(c.relname, ', ') into v_sans_policy
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  select count(*) into v_sans_path
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proconfig is null;

  select string_agg(id, ', ') into v_buckets from storage.buckets where public;

  select count(*) filter (where role = 'manager'), count(*) into v_gerants, v_comptes
    from public.profiles;

  select max(created_at), max(downloaded_at) into v_sauv, v_emport from public.backups;

  select json_agg(x) into v from (
    select 'Cloisonnement des données' as titre,
           case when v_sans_rls is null then 'ok' else 'probleme' end as etat,
           case when v_sans_rls is null
                then 'Toutes les tables sont protégées : personne ne lit une ligne sans y avoir droit.'
                else 'Tables sans protection : ' || v_sans_rls || '. Leurs données sont lisibles par n''importe quel compte.'
           end as detail
    union all
    select 'Règles d''accès',
           case when v_sans_policy is null then 'ok' else 'probleme' end,
           case when v_sans_policy is null
                then 'Chaque table protégée a ses règles d''accès.'
                else 'Tables protégées mais sans aucune règle, donc inaccessibles à tous : ' || v_sans_policy || '.'
           end
    union all
    select 'Compte sans fiche',
           case when public.is_member() then 'ok' else 'probleme' end,
           'Un compte créé sans fiche utilisateur ne voit aucune donnée : ni facture, ni fournisseur, ni message.'
    union all
    select 'Fonctions privilégiées',
           case when v_sans_path = 0 then 'ok' else 'attention' end,
           case when v_sans_path = 0
                then 'Les fonctions qui s''exécutent avec des droits élevés ont un chemin de recherche figé.'
                else v_sans_path || ' fonction(s) sans chemin figé. Sans droit de création sur le schéma, ce n''est pas exploitable, mais il faut le corriger.'
           end
    union all
    select 'Écriture dans le schéma',
           case when has_schema_privilege('authenticated', 'public', 'CREATE')
                  or has_schema_privilege('anon', 'public', 'CREATE') then 'probleme' else 'ok' end,
           'Aucun compte connecté ne peut créer d''objet dans la base. C''est ce qui rend inoffensif tout détournement de nom.'
    union all
    select 'Documents',
           case when v_buckets is null then 'ok' else 'probleme' end,
           case when v_buckets is null
                then 'Les factures ne sont accessibles que par lien signé et temporaire. Sans connexion, rien ne s''ouvre.'
                else 'Espaces de stockage ouverts à tous : ' || v_buckets || '. Les documents y sont lisibles sans connexion.'
           end
    union all
    select 'Comptes',
           case when v_gerants = 0 then 'probleme' when v_gerants > 2 then 'attention' else 'ok' end,
           v_comptes || ' compte(s), dont ' || v_gerants || ' gérant(s). '
           || case when v_gerants = 0 then 'Plus personne ne peut administrer l''application.'
                   when v_gerants > 2 then 'Beaucoup de droits de gérance : à revoir si ce n''est pas voulu.'
                   else 'Chaque personne a son compte : une action reste attribuable à quelqu''un.' end
    union all
    select 'Sauvegarde automatique',
           case when v_sauv is null then 'probleme'
                when v_sauv < now() - interval '48 hours' then 'attention' else 'ok' end,
           case when v_sauv is null then 'Aucune sauvegarde n''a jamais été faite.'
                else 'Dernier instantané il y a ' || round(extract(epoch from (now() - v_sauv)) / 3600) || ' h. Il protège d''une suppression par erreur.'
           end
    union all
    select 'Sauvegarde emportée hors ligne',
           case when v_emport is null then 'probleme'
                when v_emport < now() - interval '14 days' then 'attention' else 'ok' end,
           case when v_emport is null
                then 'Aucune sauvegarde n''a jamais été téléchargée. Tout est au même endroit : le jour où ce projet disparaît, les données disparaissent avec lui.'
                else 'Dernier téléchargement il y a ' || round(extract(epoch from (now() - v_emport)) / 86400) || ' jour(s).'
           end
  ) x;

  return coalesce(v, '[]'::json);
end;
$$;

revoke all on function public.security_audit() from public;
grant execute on function public.security_audit() to authenticated;

-- =====================================================================
-- VK Gestion — qui compose l'équipe
--
-- La liste « À faire » est un échange à deux sens : Marie doit pouvoir
-- adresser une demande à Jordan, comme l'inverse. Or la policy de
-- profiles ne laisse voir les autres qu'au gérant — à raison, cette table
-- porte les rôles et pourra porter davantage.
--
-- On n'ouvre donc pas profiles : on expose UNIQUEMENT ce qu'il faut pour
-- adresser une tâche — un identifiant et un nom. Rien d'autre ne sort.
-- =====================================================================
create or replace function public.equipe()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(json_build_object('id', p.id, 'full_name', p.full_name)
                           order by p.full_name), '[]'::json)
    from public.profiles p
   where public.is_member();
$$;

revoke all on function public.equipe() from public;
grant execute on function public.equipe() to authenticated;

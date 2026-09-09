-- =====================================================================
-- VK Gestion — LOT 6, écran Administration
--   • état du système
--   • garde-fou sur le dernier compte gérant, tenu par la base
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. GARDE-FOU : il doit toujours rester un gérant
--    Tenu par un trigger et non par l'interface : même un appel direct à
--    l'API ne peut pas laisser l'application sans administrateur.
-- ---------------------------------------------------------------------
create or replace function public.protect_last_manager() returns trigger as $$
declare
  v_restants int;
begin
  -- Combien de gérants subsisteraient après l'opération ?
  select count(*) into v_restants
    from public.profiles
   where role = 'manager'
     and id <> coalesce(old.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if tg_op = 'DELETE' then
    if old.role = 'manager' and v_restants = 0 then
      raise exception 'Impossible de supprimer le dernier compte gérant.' using errcode = '42501';
    end if;
    return old;
  end if;

  -- UPDATE : on ne rétrograde pas le dernier gérant
  if old.role = 'manager' and new.role <> 'manager' and v_restants = 0 then
    raise exception 'Impossible de retirer le rôle au dernier gérant.' using errcode = '42501';
  end if;

  -- Un gérant ne peut pas se retirer son propre rôle
  if old.role = 'manager' and new.role <> 'manager' and old.id = auth.uid() then
    raise exception 'Un gérant ne peut pas se retirer lui-même le rôle gérant.' using errcode = '42501';
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists profiles_protect_manager on public.profiles;
create trigger profiles_protect_manager before update or delete on public.profiles
for each row execute function public.protect_last_manager();

-- ---------------------------------------------------------------------
-- 2. ÉTAT DU SYSTÈME
-- ---------------------------------------------------------------------
create or replace function public.system_status()
returns json language sql stable as $$
  select json_build_object(
    'quarantaine',      (select count(*) from public.inbound_queue where status = 'quarantine'),
    'en_attente',       (select count(*) from public.inbound_queue where status in ('pending','processing')),
    'en_erreur',        (select count(*) from public.inbound_queue where status = 'error'),
    'traites',          (select count(*) from public.inbound_queue where status = 'done'),
    'derniere_reception', (select max(created_at) from public.inbound_queue),
    'a_controler',      (select count(*) from public.invoices where review_status = 'a_controler'),
    'factures',         (select count(*) from public.invoices),
    'fournisseurs',     (select count(*) from public.suppliers),
    'fiches_a_valider', (select count(*) from public.suppliers where needs_review),
    'expediteurs_autorises', (select count(*) from public.allowed_senders),
    'stockage_octets',  (select coalesce(sum((metadata->>'size')::bigint), 0)
                           from storage.objects where bucket_id = 'factures'),
    'stockage_fichiers',(select count(*) from storage.objects where bucket_id = 'factures'),
    'erreurs_extraction', coalesce((
      select json_agg(e order by e.quand desc) from (
        select q.sender_email, q.subject, q.error, q.processed_at as quand, q.attempts
          from public.inbound_queue q
         where q.status = 'error'
         order by q.processed_at desc nulls last
         limit 10
      ) e), '[]'::json)
  );
$$;

grant execute on function public.system_status() to authenticated;

-- Réservé au gérant : la fonction lit des compteurs globaux, on ne la
-- laisse pas à la secrétaire.
revoke execute on function public.system_status() from public;

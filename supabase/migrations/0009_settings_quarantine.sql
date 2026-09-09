-- =====================================================================
-- VK Gestion — écran de réglages : quarantaine et liste blanche
-- =====================================================================

-- ---------------------------------------------------------------------
-- Quarantaine regroupée par expéditeur.
-- security invoker : la policy « queue read » réserve déjà la lecture au
-- gérant, la fonction ne contourne rien.
-- ---------------------------------------------------------------------
create or replace function public.quarantine_by_sender()
returns json language sql stable as $$
  select coalesce(json_agg(x order by x.messages desc, x.sender_email), '[]'::json) from (
    select q.sender_email,
           count(*)                                as messages,
           max(q.received_at)                      as dernier_message,
           max(q.created_at)                       as derniere_reception,
           sum(jsonb_array_length(q.files))        as fichiers,
           (select count(*) from public.allowed_senders a
             where a.email = q.sender_email) > 0   as deja_autorise,
           (array_agg(q.subject order by q.created_at desc))[1] as dernier_sujet
      from public.inbound_queue q
     where q.status = 'quarantine'
     group by q.sender_email
  ) x;
$$;

-- ---------------------------------------------------------------------
-- Le gérant peut supprimer un fichier du coffre.
-- Nécessaire pour que la purge de quarantaine n'abandonne pas des objets
-- orphelins dans le bucket.
-- ---------------------------------------------------------------------
drop policy if exists "factures delete" on storage.objects;
create policy "factures delete" on storage.objects
  for delete using (bucket_id = 'factures' and public.is_manager());

-- ---------------------------------------------------------------------
-- Purge bornée : renvoie les chemins à supprimer du coffre, que
-- l'interface enlève ensuite. Réservée au gérant.
-- ---------------------------------------------------------------------
create or replace function public.purge_quarantine(p_days int default 90)
returns json language plpgsql security definer as $$
declare
  v_paths text[];
  v_count int;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut purger la quarantaine.' using errcode = '42501';
  end if;
  if p_days < 1 then
    raise exception 'La purge exige un nombre de jours d''au moins 1.';
  end if;

  select coalesce(array_agg(f->>'path'), '{}')
    into v_paths
    from public.inbound_queue q, lateral jsonb_array_elements(q.files) f
   where q.status = 'quarantine' and q.created_at < now() - make_interval(days => p_days);

  delete from public.rejected_messages
   where queue_id in (select id from public.inbound_queue
                       where status = 'quarantine'
                         and created_at < now() - make_interval(days => p_days));

  delete from public.inbound_queue
   where status = 'quarantine' and created_at < now() - make_interval(days => p_days);
  get diagnostics v_count = row_count;

  return json_build_object('deleted_rows', v_count, 'paths', v_paths);
end;
$$;

-- Combien de lignes seraient purgées ? Sert à confirmer avant d'agir.
create or replace function public.purge_quarantine_preview(p_days int default 90)
returns json language sql stable as $$
  select json_build_object(
    'messages', (select count(*) from public.inbound_queue
                  where status = 'quarantine' and created_at < now() - make_interval(days => p_days)),
    'fichiers', (select coalesce(sum(jsonb_array_length(files)), 0) from public.inbound_queue
                  where status = 'quarantine' and created_at < now() - make_interval(days => p_days)),
    'plus_ancien', (select min(created_at) from public.inbound_queue where status = 'quarantine')
  );
$$;

revoke all on function public.purge_quarantine(int) from public;
grant execute on function public.purge_quarantine(int) to authenticated;
grant execute on function public.purge_quarantine_preview(int) to authenticated;
grant execute on function public.quarantine_by_sender() to authenticated;

-- =====================================================================
-- VK Gestion — quarantaine et rejeu des messages refusés
--
-- Un message venu d'un expéditeur inconnu ne crée aucune facture, mais ses
-- pièces jointes sont conservées : autoriser l'expéditeur plus tard doit
-- permettre de rejouer le message, pas de constater qu'il est perdu.
-- La file de contrôle reste propre : la quarantaine est une liste à part.
-- =====================================================================

-- 'quarantine' : reçu, fichiers conservés, en attente d'une autorisation
alter table public.inbound_queue drop constraint if exists inbound_queue_status_check;
alter table public.inbound_queue add constraint inbound_queue_status_check
  check (status in ('pending','processing','done','error','ignored','quarantine'));

create index if not exists inbound_queue_quarantine_idx
  on public.inbound_queue (sender_email, created_at desc)
  where status = 'quarantine';

-- Le journal pointe vers la ligne rejouable, quand il y en a une.
alter table public.rejected_messages
  add column if not exists queue_id uuid references public.inbound_queue(id) on delete set null,
  add column if not exists attachment_count int not null default 0,
  add column if not exists replayed_at timestamptz;

-- ---------------------------------------------------------------------
-- Autoriser un expéditeur et remettre ses messages en attente de traitement.
-- Renvoie les identifiants de file à rejouer, que l'interface passe ensuite
-- à la fonction replay-inbound.
-- ---------------------------------------------------------------------
create or replace function public.allow_sender_and_replay(p_email text, p_label text default null)
returns json language plpgsql security definer as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_ids uuid[];
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut autoriser un expéditeur.' using errcode = '42501';
  end if;
  if v_email = '' then
    raise exception 'Adresse d''expéditeur vide.';
  end if;

  insert into public.allowed_senders (email, label, created_by)
  values (v_email, nullif(btrim(coalesce(p_label, '')), ''), auth.uid())
  on conflict (email) do update set label = coalesce(excluded.label, public.allowed_senders.label);

  -- CTE : on ne récupère que les lignes réellement sorties de quarantaine,
  -- sans ramasser d'éventuelles lignes déjà en attente pour une autre raison.
  with upd as (
    update public.inbound_queue
       set status = 'pending', error = null, processed_at = null
     where sender_email = v_email and status = 'quarantine'
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_ids from upd;

  update public.rejected_messages
     set replayed_at = now()
   where sender_email = v_email and replayed_at is null and queue_id is not null;

  return json_build_object('email', v_email, 'queue_ids', coalesce(v_ids, '{}'));
end;
$$;

revoke all on function public.allow_sender_and_replay(text, text) from public;
grant execute on function public.allow_sender_and_replay(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Purge manuelle de la quarantaine : la conservation est bornée, mais
-- c'est le gérant qui décide, jamais une suppression automatique.
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

  select coalesce(array_agg(f->>'path'), '{}')
    into v_paths
    from public.inbound_queue q, lateral jsonb_array_elements(q.files) f
   where q.status = 'quarantine' and q.created_at < now() - make_interval(days => p_days);

  delete from public.inbound_queue
   where status = 'quarantine' and created_at < now() - make_interval(days => p_days);
  get diagnostics v_count = row_count;

  -- Les objets du bucket sont supprimés par l'appelant, qui a la clé service_role
  return json_build_object('deleted_rows', v_count, 'orphan_paths', v_paths);
end;
$$;

revoke all on function public.purge_quarantine(int) from public;
grant execute on function public.purge_quarantine(int) to authenticated;

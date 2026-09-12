-- =====================================================================
-- VK Gestion — le courrier en un coup d'œil
--
-- Jordan veut savoir ce qui est arrivé dans la boîte sans l'ouvrir :
-- combien de messages, lesquels comptent, de quoi ils parlent.
--
-- CE QUI EST STOCKÉ, ET CE QUI NE L'EST PAS
--
-- Afficher le courrier oblige à le faire entrer ici. On en garde donc le
-- strict minimum : expéditeur, objet, date, une phrase de résumé, un
-- niveau d'importance. **Jamais le corps du message**, jamais ses pièces
-- jointes — sauf pour une facture, qui a son propre chemin depuis
-- toujours.
--
-- Un message reconnu comme personnel ne reçoit AUCUN résumé : seulement
-- la mention « courrier personnel ». Ce n'est pas une précaution
-- théorique — cette table est lisible dans une application que la
-- secrétaire ouvre tous les jours, et elle n'a pas à y lire la
-- correspondance privée du gérant.
--
-- Réservé au gérant, et purgé au bout de trente jours : un aperçu du
-- courrier n'a aucune raison d'être conservé.
-- =====================================================================

create table if not exists public.mail_digest (
  id            uuid primary key default gen_random_uuid(),
  message_id    text not null unique,
  received_at   timestamptz not null,
  sender_email  text,
  sender_name   text,
  subject       text,
  category      text not null default 'autre'
                check (category in ('facture', 'fournisseur', 'client', 'administratif',
                                    'banque', 'personnel', 'publicite', 'autre')),
  importance    text not null default 'normale'
                check (importance in ('haute', 'normale', 'basse')),
  -- Une phrase. Null pour le courrier personnel.
  summary       text,
  -- Ce qu'il y aurait à faire, s'il y a quelque chose à faire.
  action        text,
  -- La facture née de ce message, s'il y en a une.
  invoice_id    uuid references public.invoices(id) on delete set null,
  seen_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists mail_digest_date_idx on public.mail_digest (received_at desc);
create index if not exists mail_digest_unseen_idx on public.mail_digest (received_at desc)
  where seen_at is null;

alter table public.mail_digest enable row level security;

-- Gérant uniquement. La correspondance de l'entreprise n'a pas à être
-- lisible par tous les comptes.
drop policy if exists mail_digest_read on public.mail_digest;
create policy mail_digest_read on public.mail_digest
  for select using (public.is_manager());

drop policy if exists mail_digest_update on public.mail_digest;
create policy mail_digest_update on public.mail_digest
  for update using (public.is_manager()) with check (public.is_manager());

-- ---------------------------------------------------------------------
-- CE QUE L'ACCUEIL AFFICHE
--
-- Deux chiffres et deux listes : ce qui compte, et le reste. Le « reste »
-- est compté mais pas détaillé — l'intérêt d'un aperçu est de ne PAS tout
-- montrer.
-- ---------------------------------------------------------------------
create or replace function public.courrier_apercu(p_jours int default 7)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  with r as (
    select * from public.mail_digest
     where received_at > now() - make_interval(days => greatest(1, least(p_jours, 30)))
  )
  select json_build_object(
    'total',      (select count(*) from r),
    'non_vus',    (select count(*) from r where seen_at is null),
    'depuis',     (select min(received_at) from r),
    'par_categorie', coalesce((select json_agg(c order by c.n desc) from (
        select category, count(*) as n, count(*) filter (where seen_at is null) as non_vus
          from r group by category) c), '[]'::json),
    -- Ce qui mérite un regard : détaillé.
    'importants', coalesce((select json_agg(m order by m.received_at desc) from (
        select id, received_at, sender_name, sender_email, subject,
               category, importance, summary, action, invoice_id, seen_at
          from r where importance = 'haute'
         order by received_at desc limit 25) m), '[]'::json),
    -- Le courant : détaillé aussi, mais après.
    'courants', coalesce((select json_agg(m order by m.received_at desc) from (
        select id, received_at, sender_name, sender_email, subject,
               category, importance, summary, action, invoice_id, seen_at
          from r where importance = 'normale'
         order by received_at desc limit 25) m), '[]'::json),
    -- Le négligeable : compté, jamais détaillé.
    'sans_importance', (select count(*) from r where importance = 'basse')
  ) where public.is_manager();
$$;

/** Marquer comme vu : tout, ou un message précis. */
create or replace function public.courrier_vu(p_ids uuid[] default null)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  if not public.is_manager() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_ids is null then
    update public.mail_digest set seen_at = now() where seen_at is null;
  else
    update public.mail_digest set seen_at = now() where id = any(p_ids) and seen_at is null;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/**
 * Ménage. Un aperçu du courrier n'a aucune raison de vivre plus d'un
 * mois : ce n'est pas une archive, c'est un coup d'œil.
 */
create or replace function public.courrier_purge(p_jours int default 30)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  delete from public.mail_digest where received_at < now() - make_interval(days => greatest(7, p_jours));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.courrier_apercu(int) from public;
revoke all on function public.courrier_vu(uuid[]) from public;
revoke all on function public.courrier_purge(int) from public;
grant execute on function public.courrier_apercu(int) to authenticated;
grant execute on function public.courrier_vu(uuid[]) to authenticated;

-- Purge quotidienne, dans la foulée de la sauvegarde.
select cron.unschedule(jobid) from cron.job where jobname = 'vk-courrier-purge';
select cron.schedule('vk-courrier-purge', '30 2 * * *',
  $$select public.courrier_purge(30)$$);

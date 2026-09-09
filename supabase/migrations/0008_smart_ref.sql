-- =====================================================================
-- VK Gestion — référence Smart
--
-- Le numéro Smart est attribué à l'encodage dans Smart, il ne figure pas
-- sur la facture. C'est Marie qui le saisit, et c'est le cœur de son
-- travail de contrôle.
--
-- « Encodé dans Smart » et « référence Smart renseignée » disent la même
-- chose : la base les tient synchronisés, l'interface n'a rien à déduire.
-- =====================================================================

alter table public.invoices
  add column if not exists smart_ref text;

-- Unique : deux factures ne peuvent pas porter la même référence Smart.
-- En PostgreSQL, une contrainte unique tolère plusieurs NULL, donc les
-- factures pas encore encodées ne se gênent pas entre elles.
create unique index if not exists invoices_smart_ref_key
  on public.invoices (smart_ref) where smart_ref is not null;

-- Recherche par référence dans la liste des factures
create index if not exists invoices_smart_ref_search_idx
  on public.invoices (smart_ref);

-- ---------------------------------------------------------------------
-- Synchronisation avec la pastille « Encodé Smart »
--   • saisir une référence coche la pastille ;
--   • effacer la référence la décoche ;
--   • si la référence ne change pas, la pastille reste librement
--     basculable — indispensable pour les factures encodées avant
--     l'arrivée de ce champ.
-- ---------------------------------------------------------------------
create or replace function public.sync_smart_ref() returns trigger as $$
begin
  new.smart_ref := nullif(btrim(coalesce(new.smart_ref, '')), '');

  -- Effacer la référence décoche la pastille.
  if tg_op = 'UPDATE' and new.smart_ref is null and old.smart_ref is not null then
    new.in_smart := false;
  end if;

  -- Invariant : une référence saisie vaut « encodé dans Smart ». On le tient
  -- dans la base et pas seulement dans l'interface, sinon une bascule de
  -- pastille peut laisser les deux informations se contredire.
  if new.smart_ref is not null then
    new.in_smart := true;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists invoices_smart_ref on public.invoices;
create trigger invoices_smart_ref before insert or update on public.invoices
for each row execute function public.sync_smart_ref();

-- ---------------------------------------------------------------------
-- Rattrapage : identifiant du lot Power Automate
-- Permet de mesurer l'avancement — un lot plus petit que le plafond
-- signifie que le dossier est vidé.
-- ---------------------------------------------------------------------
alter table public.inbound_queue
  add column if not exists batch_id text;

create index if not exists inbound_queue_batch_idx
  on public.inbound_queue (batch_id, created_at);

-- Avancement du rattrapage, lot par lot
create or replace function public.catchup_progress(p_limit int default 20)
returns json language sql stable as $$
  with lots as (
    select coalesce(batch_id, 'sans-lot-' || to_char(created_at, 'YYYYMMDDHH24MI')) as lot,
           count(*)      as messages,
           min(created_at) as debut,
           max(created_at) as fin
      from public.inbound_queue
     group by 1
  )
  select json_build_object(
    'total_messages',  (select count(*) from public.inbound_queue),
    'traites',         (select count(*) from public.inbound_queue where status = 'done'),
    'en_quarantaine',  (select count(*) from public.inbound_queue where status = 'quarantine'),
    'en_attente',      (select count(*) from public.inbound_queue where status in ('pending','processing')),
    'en_erreur',       (select count(*) from public.inbound_queue where status = 'error'),
    'ignores',         (select count(*) from public.inbound_queue where status = 'ignored'),
    'lots',            (select count(*) from lots),
    'dernier_lot',     (select json_build_object('messages', messages, 'fin', fin)
                          from lots order by fin desc limit 1),
    -- un lot plus petit que le plafond veut dire qu'il ne restait plus rien à prendre
    'termine',         coalesce((select messages < p_limit from lots order by fin desc limit 1), true)
  );
$$;

-- =====================================================================
-- VK Gestion — file d'attente de réception et rapprochement fournisseur
--
-- La fonction inbound-invoice répond immédiatement à Power Automate puis
-- travaille en arrière-plan. Si ce travail échoue, la ligne reste en
-- 'pending' ou 'error' : rien n'est perdu, tout est rejouable.
-- =====================================================================

create table if not exists public.inbound_queue (
  id uuid primary key default gen_random_uuid(),
  message_id    text unique,          -- Internet Message Id : garantit l'unicité
  sender_email  text not null,
  subject       text,
  received_at   timestamptz,
  files         jsonb not null default '[]',   -- [{path, name, content_type, size}]
  status        text not null default 'pending'
                check (status in ('pending','processing','done','error','ignored')),
  attempts      int  not null default 0,
  error         text,
  invoice_id    uuid references public.invoices(id) on delete set null,
  created_at    timestamptz default now(),
  processed_at  timestamptz
);

create index if not exists inbound_queue_status_idx
  on public.inbound_queue (status, created_at)
  where status in ('pending','error');

alter table public.inbound_queue enable row level security;

-- Le gérant supervise la file ; les écritures viennent de la fonction
-- serveur, qui utilise la clé service_role et ne passe pas par RLS.
drop policy if exists "queue read"   on public.inbound_queue;
drop policy if exists "queue delete" on public.inbound_queue;
create policy "queue read"   on public.inbound_queue for select using (public.is_manager());
create policy "queue delete" on public.inbound_queue for delete using (public.is_manager());

-- ---------------------------------------------------------------------
-- RAPPROCHEMENT FOURNISSEUR
--   L'ordre compte, et on s'arrête au premier succès :
--     1. numéro de TVA normalisé
--     2. adresse d'expéditeur déjà connue
--     3. nom normalisé strictement identique
--     4. création avec needs_review
--   Aucune ressemblance approximative : mieux vaut une fiche en trop,
--   qui se fusionne en un clic, qu'une comptabilité fausse.
-- ---------------------------------------------------------------------
create or replace function public.match_or_create_supplier(
  p_name  text,
  p_vat   text default null,
  p_email text default null
) returns json language plpgsql security definer as $$
declare
  v_id    uuid;
  v_how   text;
  v_vat   text := public.normalize_vat(p_vat);
  v_norm  text := public.normalize_supplier_name(p_name);
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_created boolean := false;
begin
  -- 1. numéro de TVA
  if v_vat is not null then
    select id into v_id from public.suppliers
     where merged_into is null and public.normalize_vat(vat_number) = v_vat
     order by created_at limit 1;
    if v_id is not null then v_how := 'numéro de TVA'; end if;
  end if;

  -- 2. expéditeur déjà associé
  if v_id is null and v_email is not null then
    select id into v_id from public.suppliers
     where merged_into is null
       and (v_email = any(known_emails) or lower(email) = v_email)
     order by created_at limit 1;
    if v_id is not null then v_how := 'adresse expéditeur'; end if;
  end if;

  -- 3. nom normalisé
  if v_id is null and v_norm is not null then
    select id into v_id from public.suppliers
     where merged_into is null and normalized_name = v_norm
     order by created_at limit 1;
    if v_id is not null then v_how := 'nom normalisé'; end if;
  end if;

  -- 4. création
  if v_id is null then
    if coalesce(btrim(p_name), '') = '' then
      return json_build_object('id', null, 'matched_by', null,
                               'created', false, 'reason', 'nom du fournisseur absent');
    end if;
    insert into public.suppliers (name, vat_number, email, needs_review, known_emails)
    values (btrim(p_name), nullif(btrim(coalesce(p_vat, '')), ''), v_email, true,
            case when v_email is null then '{}'::text[] else array[v_email] end)
    returning id into v_id;
    v_how := 'création automatique';
    v_created := true;
  elsif v_email is not null then
    -- la reconnaissance s'améliore d'elle-même : on mémorise l'expéditeur
    update public.suppliers
       set known_emails = array(select distinct e from unnest(coalesce(known_emails, '{}') || array[v_email]) e)
     where id = v_id and not (v_email = any(coalesce(known_emails, '{}')));
  end if;

  return json_build_object('id', v_id, 'matched_by', v_how, 'created', v_created);
end;
$$;

revoke all on function public.match_or_create_supplier(text, text, text) from public;
grant execute on function public.match_or_create_supplier(text, text, text) to service_role, authenticated;

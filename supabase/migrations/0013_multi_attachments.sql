-- =====================================================================
-- VK Gestion — un mail peut contenir plusieurs factures
--
-- Deux défauts corrigés ici, tous deux révélés par le lot transféré par
-- l'ancien franchisé :
--
--   1. Le traitement ne retenait QUE la première pièce jointe de chaque
--      message. Sur 215 messages portant 545 fichiers, 330 factures
--      auraient disparu sans le moindre signal.
--
--   2. L'adresse de l'expéditeur servait de clé de rapprochement. Pour un
--      transitaire qui retransmet les factures de dizaines de fournisseurs,
--      c'est faux par construction : la deuxième facture serait rattachée
--      au fournisseur de la première.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. UNE FACTURE PAR FICHIER, PAS PAR MESSAGE
--    message_id ne peut donc plus être unique à lui seul.
-- ---------------------------------------------------------------------
alter table public.invoices drop constraint if exists invoices_message_id_key;

-- L'unicité porte désormais sur le couple message + fichier : un même
-- message rejoué ne recrée rien, mais ses pièces jointes coexistent.
create unique index if not exists invoices_message_file_key
  on public.invoices (message_id, file_path)
  where message_id is not null;

alter table public.inbound_queue
  add column if not exists invoice_ids uuid[] not null default '{}';

-- ---------------------------------------------------------------------
-- 2. EXPÉDITEURS TRANSITAIRES
--    Une adresse qui retransmet des factures d'autrui ne dit rien du
--    fournisseur : on ne s'en sert jamais pour rapprocher, et on ne la
--    mémorise sur aucune fiche.
-- ---------------------------------------------------------------------
alter table public.allowed_senders
  add column if not exists is_forwarder boolean not null default false;

comment on column public.allowed_senders.is_forwarder is
  'Adresse qui retransmet les factures d''autres fournisseurs (ancien franchisé, comptable, boîte interne). Jamais utilisée pour rapprocher.';

-- ---------------------------------------------------------------------
-- 3. RAPPROCHEMENT : l'étape « adresse expéditeur » devient conditionnelle
-- ---------------------------------------------------------------------
drop function if exists public.match_or_create_supplier(text, text, text, text, text);

create or replace function public.match_or_create_supplier(
  p_name        text,
  p_vat         text default null,
  p_email       text default null,
  p_address     text default null,
  p_iban        text default null,
  p_is_forwarder boolean default false
) returns json language plpgsql security definer as $$
declare
  v_id    uuid;
  v_how   text;
  v_vat   text := public.normalize_vat(p_vat);
  v_norm  text := public.normalize_supplier_name(p_name);
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_created boolean := false;
  v_iban_existant text;
  v_iban_lu text := nullif(upper(regexp_replace(coalesce(p_iban, ''), '[^A-Za-z0-9]', '', 'g')), '');
begin
  -- Un transitaire n'est pas un fournisseur : son adresse ne sert à rien ici.
  if p_is_forwarder then v_email := null; end if;

  -- 1. numéro de TVA
  if v_vat is not null then
    select id into v_id from public.suppliers
     where merged_into is null and public.normalize_vat(vat_number) = v_vat
     order by created_at limit 1;
    if v_id is not null then v_how := 'numéro de TVA'; end if;
  end if;

  -- 2. expéditeur déjà associé — sauté pour un transitaire
  if v_id is null and v_email is not null then
    select id into v_id from public.suppliers
     where merged_into is null
       and (v_email = any(known_emails) or lower(email) = v_email)
     order by created_at limit 1;
    if v_id is not null then v_how := 'adresse expéditeur'; end if;
  end if;

  -- 3. nom normalisé, égalité stricte
  if v_id is null and v_norm is not null then
    select id into v_id from public.suppliers
     where merged_into is null and normalized_name = v_norm
     order by created_at limit 1;
    if v_id is not null then v_how := 'nom normalisé'; end if;
  end if;

  -- 4. création, pré-remplie depuis la facture
  if v_id is null then
    if coalesce(btrim(p_name), '') = '' then
      return json_build_object('id', null, 'matched_by', null, 'created', false,
                               'reason', 'nom du fournisseur absent');
    end if;
    insert into public.suppliers (name, vat_number, email, address, iban,
                                  needs_review, known_emails, extracted)
    values (btrim(p_name),
            nullif(btrim(coalesce(p_vat, '')), ''),
            v_email,
            nullif(btrim(coalesce(p_address, '')), ''),
            nullif(btrim(coalesce(p_iban, '')), ''),
            true,
            case when v_email is null then '{}'::text[] else array[v_email] end,
            json_build_object('nom', p_name, 'tva', p_vat, 'adresse', p_address,
                              'iban', p_iban, 'email', v_email, 'lu_le', now())::jsonb)
    returning id into v_id;
    v_how := 'création automatique';
    v_created := true;
  else
    if v_email is not null then
      update public.suppliers
         set known_emails = array(select distinct e from unnest(coalesce(known_emails, '{}') || array[v_email]) e)
       where id = v_id and not (v_email = any(coalesce(known_emails, '{}')));
    end if;
    select nullif(upper(regexp_replace(coalesce(iban, ''), '[^A-Za-z0-9]', '', 'g')), '')
      into v_iban_existant from public.suppliers where id = v_id;
  end if;

  return json_build_object(
    'id', v_id, 'matched_by', v_how, 'created', v_created,
    'iban_lu', v_iban_lu, 'iban_fiche', v_iban_existant,
    'iban_divergent', (v_iban_lu is not null and v_iban_existant is not null
                       and v_iban_lu <> v_iban_existant)
  );
end;
$$;

revoke all on function public.match_or_create_supplier(text, text, text, text, text, boolean) from public;
grant execute on function public.match_or_create_supplier(text, text, text, text, text, boolean)
  to service_role, authenticated;

-- ---------------------------------------------------------------------
-- 4. Autoriser un expéditeur en le déclarant transitaire
-- ---------------------------------------------------------------------
create or replace function public.allow_sender_and_replay(
  p_email text, p_label text default null, p_is_forwarder boolean default false
) returns json language plpgsql security definer as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_ids uuid[];
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut autoriser un expéditeur.' using errcode = '42501';
  end if;
  if v_email = '' then raise exception 'Adresse d''expéditeur vide.'; end if;

  insert into public.allowed_senders (email, label, created_by, is_forwarder)
  values (v_email, nullif(btrim(coalesce(p_label, '')), ''), auth.uid(), p_is_forwarder)
  on conflict (email) do update
     set label = coalesce(excluded.label, public.allowed_senders.label),
         is_forwarder = excluded.is_forwarder;

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

  return json_build_object('email', v_email, 'queue_ids', coalesce(v_ids, '{}'),
                           'is_forwarder', p_is_forwarder);
end;
$$;

revoke all on function public.allow_sender_and_replay(text, text, boolean) from public;
grant execute on function public.allow_sender_and_replay(text, text, boolean) to authenticated;
drop function if exists public.allow_sender_and_replay(text, text);

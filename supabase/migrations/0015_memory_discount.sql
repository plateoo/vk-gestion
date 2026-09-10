-- =====================================================================
-- VK Gestion — mémoire fournisseur et escompte pour paiement anticipé
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. MÉMOIRE FOURNISSEUR
--    Uniquement des champs de nature stable. Jamais un montant, un numéro
--    de facture, une date ou une référence : ce sont des valeurs propres
--    à chaque document.
--    Trois champs mémorisables existent déjà sur la fiche : name, address,
--    vat_number, payment_terms. On ajoute les deux manquants.
-- ---------------------------------------------------------------------
alter table public.suppliers
  add column if not exists default_vat_rate numeric(4,2),
  add column if not exists default_expense_type text,
  -- escompte habituel accordé par ce fournisseur
  add column if not exists discount_rate numeric(5,2),
  add column if not exists discount_days int;

alter table public.suppliers
  drop constraint if exists suppliers_default_vat_rate_check;
alter table public.suppliers
  add constraint suppliers_default_vat_rate_check
  check (default_vat_rate is null or default_vat_rate in (0, 0.06, 0.12, 0.21));

alter table public.suppliers
  drop constraint if exists suppliers_discount_check;
alter table public.suppliers
  add constraint suppliers_discount_check
  check ((discount_rate is null or (discount_rate > 0 and discount_rate <= 100))
     and (discount_days is null or discount_days > 0));

-- ---------------------------------------------------------------------
-- 2. ESCOMPTE SUR LA FACTURE
--
--    Règle belge : l'escompte ne touche PAS la base TVA. La TVA reste
--    calculée sur le montant brut, sauf mention contraire du document.
--    Le montant à payer est donc le TVAC diminué du seul escompte sur
--    le HTVA — la TVA, elle, ne bouge pas.
--
--    Une colonne générée ne peut pas en référencer une autre : on
--    réécrit donc le TVAC à partir de amount_htva et vat_rate.
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists discount_rate numeric(5,2),
  add column if not exists discount_days int,
  -- montant réellement décaissé, distinct du montant facturé
  add column if not exists amount_paid numeric(12,2);

alter table public.invoices
  drop constraint if exists invoices_discount_check;
alter table public.invoices
  add constraint invoices_discount_check
  check ((discount_rate is null or (discount_rate > 0 and discount_rate <= 100))
     and (discount_days is null or discount_days > 0));

alter table public.invoices
  drop column if exists discount_deadline;
alter table public.invoices
  add column discount_deadline date
  generated always as (
    case when discount_days is not null then invoice_date + discount_days else null end
  ) stored;

alter table public.invoices
  drop column if exists amount_discounted;
alter table public.invoices
  add column amount_discounted numeric(12,2)
  generated always as (
    case when discount_rate is not null and discount_rate > 0
         then round(amount_htva * (1 + vat_rate), 2) - round(amount_htva * discount_rate / 100, 2)
         else null end
  ) stored;

create index if not exists invoices_discount_idx
  on public.invoices (discount_deadline)
  where discount_deadline is not null and payment_status <> 'paye';

comment on column public.invoices.amount_discounted is
  'Montant à payer si l''escompte est pris. La TVA n''est jamais recalculée : seul le HTVA est diminué.';
comment on column public.invoices.amount_paid is
  'Montant réellement décaissé. Peut être inférieur au TVAC si l''escompte a été pris.';

-- ---------------------------------------------------------------------
-- 3. MÉMORISER UNE CORRECTION
--    Champs autorisés en dur : l'appel ne peut pas mémoriser autre chose,
--    même en forçant la requête.
-- ---------------------------------------------------------------------
create or replace function public.remember_supplier_value(
  p_supplier uuid,
  p_field    text,
  p_value    text,
  p_source   text default null      -- pour le journal : d'où vient la correction
) returns json language plpgsql security definer as $$
declare
  v_autorises text[] := array['name','address','vat_number','payment_terms',
                              'default_vat_rate','default_expense_type',
                              'discount_rate','discount_days'];
  v_avant text;
  v_nom   text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if not (p_field = any(v_autorises)) then
    raise exception 'Ce champ ne se mémorise pas : % (valeurs propres à chaque document)', p_field;
  end if;

  execute format('select (%I)::text from public.suppliers where id = $1', p_field)
    into v_avant using p_supplier;

  execute format('update public.suppliers set %I = $1 where id = $2', p_field)
    using nullif(btrim(coalesce(p_value, '')), ''), p_supplier;

  select full_name into v_nom from public.profiles where id = auth.uid();

  if v_avant is distinct from nullif(btrim(coalesce(p_value, '')), '') then
    insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value,
                                   reason, author, author_name)
    select 'supplier', p_supplier, s.name, p_field, v_avant, nullif(btrim(coalesce(p_value, '')), ''),
           coalesce(p_source, 'mémorisation depuis une facture'), auth.uid(), v_nom
      from public.suppliers s where s.id = p_supplier;
  end if;

  return json_build_object('field', p_field, 'value', p_value, 'before', v_avant);
end;
$$;

revoke all on function public.remember_supplier_value(uuid, text, text, text) from public;
grant execute on function public.remember_supplier_value(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Escompte gagné sur un mois — pour l'écran Paiements
-- ---------------------------------------------------------------------
create or replace function public.payments_summary(p_from date, p_to date)
returns json language sql stable as $$
  with r as (
    select * from public.invoices
     where payment_status = 'paye' and payment_date between p_from and p_to
  )
  select json_build_object(
    'factures',  (select count(*) from r),
    'facture',   (select coalesce(sum(amount_tvac), 0) from r),
    'decaisse',  (select coalesce(sum(coalesce(amount_paid, amount_tvac)), 0) from r),
    'escompte',  (select coalesce(sum(amount_tvac - coalesce(amount_paid, amount_tvac)), 0) from r),
    'avec_escompte', (select count(*) from r
                       where amount_paid is not null and amount_paid < amount_tvac)
  );
$$;

grant execute on function public.payments_summary(date, date) to authenticated;

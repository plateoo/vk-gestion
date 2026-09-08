-- =====================================================================
-- VK Gestion — périodes libres et rangement par fournisseur
--   1. normalisation des noms et numéros de TVA (une seule implémentation,
--      côté base, pour que le serveur et l'interface ne divergent jamais)
--   2. agrégats de période calculés en SQL : une année ne doit jamais être
--      chargée ligne à ligne dans le navigateur
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. NORMALISATION
-- ---------------------------------------------------------------------

-- Retrait des accents sans dépendre d'une extension : immutable, donc
-- utilisable dans un index d'expression.
create or replace function public.vk_unaccent(p text) returns text as $$
  select translate(coalesce(p, ''),
    'àáâãäåçèéêëìíîïñòóôõöùúûüýÿÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ',
    'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUY');
$$ language sql immutable;

-- « Blum SA », « blum s.a. » et « BLUM » donnent la même chaîne.
-- On compacte AVANT de retirer la forme juridique : sinon « s.a. » devient
-- « s a » et n'est plus reconnu comme une forme juridique.
-- Comparaison par égalité stricte uniquement — aucune ressemblance approximative.
create or replace function public.normalize_supplier_name(p text) returns text as $$
  select nullif(
    regexp_replace(
      regexp_replace(lower(public.vk_unaccent(p)), '[^a-z0-9]', '', 'g'),
      '(sa|sprl|srl|bvba|bv|nv|gmbh|sas|sarl|ltd|llc|inc|plc|ag|kg|scrl|vof|cvba)$', ''),
    '');
$$ language sql immutable;

-- « BE 0403.211.988 » et « BE0403211988 » donnent la même chaîne.
create or replace function public.normalize_vat(p text) returns text as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$ language sql immutable;

-- ---------------------------------------------------------------------
-- 2. COLONNES DE RAPPROCHEMENT
-- ---------------------------------------------------------------------
alter table public.suppliers
  add column if not exists normalized_name text,
  add column if not exists known_emails text[] default '{}',
  add column if not exists merged_into uuid references public.suppliers(id);

-- Le nom normalisé est maintenu par la base, jamais par l'application.
create or replace function public.touch_normalized_name() returns trigger as $$
begin
  new.normalized_name := public.normalize_supplier_name(new.name);
  return new;
end;
$$ language plpgsql;

drop trigger if exists suppliers_normalize on public.suppliers;
create trigger suppliers_normalize before insert or update of name on public.suppliers
for each row execute function public.touch_normalized_name();

-- Remplissage des fiches déjà présentes
update public.suppliers
   set normalized_name = public.normalize_supplier_name(name)
 where normalized_name is distinct from public.normalize_supplier_name(name);

create index if not exists suppliers_normalized_idx on public.suppliers (normalized_name);
create index if not exists suppliers_vat_idx        on public.suppliers (vat_number);
create index if not exists suppliers_vat_norm_idx   on public.suppliers (public.normalize_vat(vat_number));
create index if not exists suppliers_emails_idx     on public.suppliers using gin (known_emails);

-- ---------------------------------------------------------------------
-- 3. AGRÉGATS DE PÉRIODE
--    security invoker (défaut) : les policies RLS de invoices s'appliquent
--    à l'appelant, la fonction ne contourne rien.
-- ---------------------------------------------------------------------
create or replace function public.period_summary(p_from date, p_to date)
returns json language sql stable as $$
  with r as (
    select * from public.invoices
     where invoice_date >= p_from and invoice_date <= p_to
  )
  select json_build_object(
    'count',       (select count(*) from r),
    'htva',        (select coalesce(sum(amount_htva), 0) from r),
    'tvac',        (select coalesce(sum(amount_tvac), 0) from r),
    'tva',         (select coalesce(sum(amount_tvac - amount_htva), 0) from r),
    'paid',        (select coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) from r),
    'due',         (select coalesce(sum(amount_tvac) filter (where payment_status <> 'paye'), 0) from r),
    'late_count',  (select count(*) from r where payment_status <> 'paye' and due_date is not null and due_date < current_date),
    'late_amount', (select coalesce(sum(amount_tvac), 0) from r where payment_status <> 'paye' and due_date is not null and due_date < current_date),
    'no_smart',    (select count(*) from r where not in_smart),
    'no_win',      (select count(*) from r where not in_winauditor),
    'no_stock',    (select count(*) from r where stock_in is null),
    'to_review',   (select count(*) from r where review_status = 'a_controler'),
    'by_month', coalesce((select json_agg(m order by m.month) from (
        select to_char(invoice_date, 'YYYY-MM') as month,
               count(*)                          as count,
               sum(amount_tvac)                  as tvac,
               coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) as paid
          from r group by 1) m), '[]'::json),
    'by_vat', coalesce((select json_agg(v order by v.vat_rate desc) from (
        select vat_rate,
               count(*)                            as count,
               sum(amount_htva)                    as htva,
               sum(amount_tvac - amount_htva)      as tva,
               sum(amount_tvac)                    as tvac
          from r group by 1) v), '[]'::json),
    'by_supplier', coalesce((select json_agg(s order by s.tvac desc) from (
        select r.supplier_id,
               sup.name,
               count(*)                        as count,
               sum(r.amount_htva)              as htva,
               sum(r.amount_tvac - r.amount_htva) as tva,
               sum(r.amount_tvac)              as tvac,
               coalesce(sum(r.amount_tvac) filter (where r.payment_status = 'paye'), 0)  as paid,
               coalesce(sum(r.amount_tvac) filter (where r.payment_status <> 'paye'), 0) as due
          from r join public.suppliers sup on sup.id = r.supplier_id
         group by r.supplier_id, sup.name) s), '[]'::json)
  );
$$;

-- ---------------------------------------------------------------------
-- 4. STATISTIQUES D'UNE FICHE FOURNISSEUR
-- ---------------------------------------------------------------------
create or replace function public.supplier_stats(p_supplier uuid)
returns json language sql stable as $$
  with r as (select * from public.invoices where supplier_id = p_supplier)
  select json_build_object(
    'count',        (select count(*) from r),
    'tvac',         (select coalesce(sum(amount_tvac), 0) from r),
    'paid',         (select coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) from r),
    'due',          (select coalesce(sum(amount_tvac) filter (where payment_status <> 'paye'), 0) from r),
    'avg_amount',   (select coalesce(round(avg(amount_tvac), 2), 0) from r),
    'last_invoice', (select max(invoice_date) from r),
    -- délai de paiement moyen réellement constaté, pas le délai théorique
    'avg_delay',    (select round(avg(payment_date - invoice_date)) from r
                      where payment_date is not null),
    'last_12m', coalesce((select json_agg(m order by m.month) from (
        select to_char(invoice_date, 'YYYY-MM') as month,
               count(*)                          as count,
               sum(amount_tvac)                  as tvac
          from r
         where invoice_date >= (date_trunc('month', current_date) - interval '11 months')::date
         group by 1) m), '[]'::json)
  );
$$;

-- ---------------------------------------------------------------------
-- 5. DOUBLONS PROBABLES DE FOURNISSEURS
--
--    Distinction essentielle :
--      • le RAPPROCHEMENT automatique (fonction de réception) n'utilise que
--        l'égalité stricte — jamais rien d'approximatif ;
--      • ici on ne fait que PROPOSER des fiches à un humain qui tranche, donc
--        on accepte en plus le préfixe (« nobilia » ⊂ « nobiliawerke »).
--        Déterministe et explicable, sans score de ressemblance.
-- ---------------------------------------------------------------------
create or replace function public.supplier_duplicates()
returns json language sql stable as $$
  select coalesce(json_agg(x order by x.name), '[]'::json) from (
    select s.id, s.name, s.vat_number, s.email, s.needs_review, s.created_at,
           coalesce((
             select json_agg(json_build_object(
                      'id', o.id, 'name', o.name, 'vat_number', o.vat_number,
                      'email', o.email,
                      'reason', case
                        when public.normalize_vat(o.vat_number) is not null
                         and public.normalize_vat(o.vat_number) = public.normalize_vat(s.vat_number)
                        then 'même numéro de TVA'
                        when o.normalized_name = s.normalized_name
                        then 'même nom normalisé'
                        else 'nom contenu dans l''autre' end,
                      'invoice_count', (select count(*) from public.invoices i where i.supplier_id = o.id)
                    ) order by o.name)
               from public.suppliers o
              where o.id <> s.id
                and o.merged_into is null
                and (
                  (public.normalize_vat(o.vat_number) is not null
                    and public.normalize_vat(o.vat_number) = public.normalize_vat(s.vat_number))
                  or (o.normalized_name is not null and o.normalized_name = s.normalized_name)
                  -- préfixe : « nobilia » et « nobiliawerke ». Seuil de 5 caractères
                  -- pour éviter que des sigles courts ne s'attirent tous.
                  or (o.normalized_name is not null and s.normalized_name is not null
                      and length(least(o.normalized_name, s.normalized_name)) >= 5
                      and (o.normalized_name like s.normalized_name || '%'
                        or s.normalized_name like o.normalized_name || '%'))
                )
           ), '[]'::json) as candidates,
           (select count(*) from public.invoices i where i.supplier_id = s.id) as invoice_count
      from public.suppliers s
     where s.merged_into is null
       and (s.needs_review
            or exists (select 1 from public.suppliers o
                        where o.id <> s.id and o.merged_into is null
                          and o.normalized_name is not null and s.normalized_name is not null
                          and (o.normalized_name = s.normalized_name
                            or (length(least(o.normalized_name, s.normalized_name)) >= 5
                                and (o.normalized_name like s.normalized_name || '%'
                                  or s.normalized_name like o.normalized_name || '%')))))
  ) x
  where json_array_length(x.candidates) > 0 or x.needs_review;
$$;

-- ---------------------------------------------------------------------
-- 6. FUSION DE DEUX FICHES — tout ou rien
--    Réservée au gérant : la fonction refuse l'opération pour tout autre.
-- ---------------------------------------------------------------------
create or replace function public.merge_suppliers(p_keep uuid, p_drop uuid)
returns json language plpgsql security definer as $$
declare
  moved int;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut fusionner des fournisseurs.' using errcode = '42501';
  end if;
  if p_keep = p_drop then
    raise exception 'Impossible de fusionner une fiche avec elle-même.';
  end if;
  if not exists (select 1 from public.suppliers where id = p_keep)
     or not exists (select 1 from public.suppliers where id = p_drop) then
    raise exception 'Fiche fournisseur introuvable.';
  end if;

  -- Les factures d'abord : aucune ne doit rester orpheline.
  update public.invoices set supplier_id = p_keep where supplier_id = p_drop;
  get diagnostics moved = row_count;

  -- On conserve les adresses connues de la fiche absorbée : la
  -- reconnaissance automatique continue de fonctionner pour ses e-mails.
  update public.suppliers k
     set known_emails = (
           select array(select distinct e from unnest(
             coalesce(k.known_emails, '{}') ||
             coalesce((select d.known_emails from public.suppliers d where d.id = p_drop), '{}') ||
             coalesce((select array[d.email] from public.suppliers d where d.id = p_drop and d.email is not null), '{}')
           ) e where e is not null))
   where k.id = p_keep;

  delete from public.suppliers where id = p_drop;

  return json_build_object('moved_invoices', moved, 'kept', p_keep);
end;
$$;

revoke all on function public.merge_suppliers(uuid, uuid) from public;
grant execute on function public.merge_suppliers(uuid, uuid) to authenticated;

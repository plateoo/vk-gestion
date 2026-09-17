-- =====================================================================
-- VK Gestion — forcer l'acceptation d'un document
--
-- Jordan : « dans les documents à contrôler il y a des fois des problèmes
-- que je ne peux pas régler, je dois pouvoir forcer l'acceptation, soit
-- avec un montant que j'introduis moi, soit en forçant l'acceptation. »
--
-- Deux besoins distincts, et une seule cause la plupart du temps.
--
-- 1. Le montant. L'application ne connaissait qu'UN taux de TVA par
--    facture. Or une facture de rénovation porte couramment du 6 % sur la
--    main-d'œuvre et du 21 % sur le matériel, sur le même document. Aucun
--    taux unique ne peut alors reproduire le montant de TVA imprimé, le
--    recoupement échoue, et la validation reste bloquée pour toujours.
--    Ce n'était pas un cas limite : c'était un trou dans le modèle.
--    D'où vat_amount — la TVA telle qu'elle est écrite sur le papier,
--    saisie à la main. Quand elle est là, c'est elle qui fait foi.
--
-- 2. Le reste. Un document illisible, un champ qu'on ne saura jamais
--    recouper, un fournisseur qui a écrit n'importe quoi. Là, il n'y a
--    rien à calculer : il faut pouvoir passer outre. Mais un passage en
--    force sans motif ne vaut rien — dans trois mois, personne ne saura
--    pourquoi ce montant-là. Le motif est donc obligatoire, il est
--    conservé, et il reste visible sur la facture.
--
-- Au passage : on note enfin QUI a validé une facture et quand. La fiche
-- fournisseur le notait déjà ; la facture, non. La question « est-ce que
-- Marie a fait son travail ? » n'avait donc aucune réponse dans la base.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. La TVA saisie à la main
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists vat_amount numeric(12,2);

alter table public.invoices
  drop constraint if exists invoices_vat_amount_check;
alter table public.invoices
  add constraint invoices_vat_amount_check
  check (vat_amount is null or vat_amount >= 0);

comment on column public.invoices.vat_amount is
  'Montant de TVA saisi à la main, tel qu''imprimé sur le document. '
  'Renseigné quand la facture porte plusieurs taux : aucun taux unique ne '
  'reproduirait ce montant. Quand il est présent, il prime sur vat_rate.';

-- Le TVAC se recalcule à partir du montant saisi quand il existe. Une
-- colonne générée ne peut pas en référencer une autre : les deux formules
-- sont donc réécrites en entier, chacune de son côté.
alter table public.invoices drop column if exists amount_tvac;
alter table public.invoices
  add column amount_tvac numeric(12,2)
  generated always as (
    round(amount_htva + coalesce(vat_amount, amount_htva * vat_rate), 2)
  ) stored;

-- L'escompte, lui, ne change pas de règle : il porte sur le HTVA seul, la
-- TVA n'est jamais recalculée. Règle belge, elle vaut aussi ici.
alter table public.invoices drop column if exists amount_discounted;
alter table public.invoices
  add column amount_discounted numeric(12,2)
  generated always as (
    case when discount_rate is not null and discount_rate > 0
         then round(amount_htva + coalesce(vat_amount, amount_htva * vat_rate), 2)
              - round(amount_htva * discount_rate / 100, 2)
         else null end
  ) stored;

create index if not exists invoices_discount_idx
  on public.invoices (discount_deadline)
  where discount_deadline is not null and payment_status <> 'paye';

-- ---------------------------------------------------------------------
-- 2. Qui a validé, et qui a forcé
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists validated_at   timestamptz,
  add column if not exists validated_by   uuid references auth.users,
  add column if not exists validated_name text,
  add column if not exists forced_at      timestamptz,
  add column if not exists forced_by      uuid references auth.users,
  add column if not exists forced_name    text,
  add column if not exists forced_reason  text;

alter table public.invoices
  drop constraint if exists invoices_forced_reason_check;
alter table public.invoices
  add constraint invoices_forced_reason_check
  check (forced_reason is null or btrim(forced_reason) <> '');

comment on column public.invoices.forced_reason is
  'Pourquoi cette facture a été acceptée malgré un contrôle en échec. '
  'Obligatoire dès qu''il y a forçage : sans le motif, la trace ne sert à rien.';

create index if not exists invoices_forcees_idx
  on public.invoices (forced_at desc) where forced_at is not null;

-- ---------------------------------------------------------------------
-- 3. La signature se pose toute seule
--
-- Un déclencheur plutôt qu'un appel depuis l'application : la validation
-- passe par trois chemins différents — à l'unité, en lot, et depuis le
-- tableau des factures. Le jour où un quatrième apparaît, il sera signé
-- lui aussi sans que personne y pense.
-- ---------------------------------------------------------------------
create or replace function public.tg_invoice_signature()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_nom text;
begin
  if new.review_status = 'valide'
     and (tg_op = 'INSERT' or old.review_status is distinct from 'valide') then
    select full_name into v_nom from public.profiles where id = auth.uid();
    new.validated_at   := now();
    new.validated_by   := auth.uid();
    new.validated_name := v_nom;
  end if;

  -- Le motif de forçage arrive : on l'horodate et on le signe. On ne
  -- réécrit jamais une signature existante — un forçage déjà consigné
  -- appartient à celui qui l'a fait.
  if new.forced_reason is not null
     and (tg_op = 'INSERT' or old.forced_reason is distinct from new.forced_reason) then
    select full_name into v_nom from public.profiles where id = auth.uid();
    new.forced_at   := now();
    new.forced_by   := auth.uid();
    new.forced_name := v_nom;
  end if;

  -- Retirer le motif retire la marque : une facture corrigée pour de bon
  -- ne doit pas rester estampillée « forcée » à vie.
  if new.forced_reason is null and tg_op = 'UPDATE' and old.forced_reason is not null then
    new.forced_at := null; new.forced_by := null; new.forced_name := null;
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_signature on public.invoices;
create trigger invoices_signature
  before insert or update on public.invoices
  for each row execute function public.tg_invoice_signature();

-- ---------------------------------------------------------------------
-- 4. Les factures forcées, pour le gérant
--
-- Une liste qu'on peut relire à froid. C'est le contrepoids du forçage :
-- il est permis, mais il est visible.
-- ---------------------------------------------------------------------
create or replace function public.forcees(p_limit int default 200)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(f order by f.forced_at desc), '[]'::json) from (
    select i.id, i.invoice_number, i.invoice_date, i.amount_htva, i.amount_tvac,
           i.vat_rate, i.vat_amount, i.forced_at, i.forced_name, i.forced_reason,
           i.review_status, s.name as supplier_name
      from public.invoices i
      join public.suppliers s on s.id = i.supplier_id
     where i.forced_at is not null
       and public.is_member()
     order by i.forced_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  ) f;
$$;

revoke all on function public.forcees(int) from public;
grant execute on function public.forcees(int) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Les récapitulatifs distinguent la TVA saisie à la main
--
-- Pour le comptable, une facture à taux mixte ne doit pas se retrouver
-- rangée sous un taux moyen qui n'existe nulle part. Elle est isolée.
-- ---------------------------------------------------------------------
create or replace function public.period_summary(p_from date, p_to date)
returns json language sql stable as $$
  with r as (
    select * from public.invoices
     where invoice_date >= p_from and invoice_date <= p_to
       and review_status <> 'document'
  ),
  du as (select * from r where payment_status not in ('paye', 'avant_reprise'))
  select json_build_object(
    'count',       (select count(*) from r),
    'htva',        (select coalesce(sum(amount_htva), 0) from r),
    'tvac',        (select coalesce(sum(amount_tvac), 0) from r),
    'tva',         (select coalesce(sum(amount_tvac - amount_htva), 0) from r),
    'paid',        (select coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) from r),
    'due',         (select coalesce(sum(amount_tvac), 0) from du),
    'avant_reprise',(select count(*) from r where payment_status = 'avant_reprise'),
    'late_count',  (select count(*) from du where due_date is not null and due_date < current_date),
    'late_amount', (select coalesce(sum(amount_tvac), 0) from du where due_date is not null and due_date < current_date),
    'no_smart',    (select count(*) from r where not in_smart),
    'no_win',      (select count(*) from r where not in_winauditor),
    'no_stock',    (select count(*) from r where stock_in is null),
    'to_review',   (select count(*) from r where review_status = 'a_controler'),
    'forcees',     (select count(*) from r where forced_at is not null),
    'tva_manuelle',(select count(*) from r where vat_amount is not null),
    'documents',   (select count(*) from public.invoices
                     where review_status = 'document'
                       and invoice_date >= p_from and invoice_date <= p_to),
    'by_month', coalesce((select json_agg(m order by m.month) from (
        select to_char(invoice_date, 'YYYY-MM') as month,
               count(*)                          as count,
               sum(amount_tvac)                  as tvac,
               coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) as paid
          from r group by 1) m), '[]'::json),
    'by_vat', coalesce((select json_agg(v order by v.manuel, v.vat_rate desc) from (
        select case when vat_amount is not null then null else vat_rate end as vat_rate,
               (vat_amount is not null)            as manuel,
               count(*)                            as count,
               sum(amount_htva)                    as htva,
               sum(amount_tvac - amount_htva)      as tva,
               sum(amount_tvac)                    as tvac
          from r group by 1, 2) v), '[]'::json),
    'by_supplier', coalesce((select json_agg(s order by s.tvac desc) from (
        select r.supplier_id,
               sup.name,
               count(*)                        as count,
               sum(r.amount_htva)              as htva,
               sum(r.amount_tvac - r.amount_htva) as tva,
               sum(r.amount_tvac)              as tvac,
               coalesce(sum(r.amount_tvac) filter (where r.payment_status = 'paye'), 0)  as paid,
               coalesce(sum(r.amount_tvac) filter (where r.payment_status not in ('paye','avant_reprise')), 0) as due
          from r join public.suppliers sup on sup.id = r.supplier_id
         group by r.supplier_id, sup.name) s), '[]'::json)
  );
$$;

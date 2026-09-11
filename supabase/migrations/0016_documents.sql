-- =====================================================================
-- VK Gestion — séparer les factures des autres documents
--
-- Constat sur les 102 premières pièces remontées : 39 n'étaient pas des
-- factures. Les fournisseurs agrafent leurs conditions générales à chaque
-- envoi (AGB_nobilia_FR.pdf 18 fois, verkoopsv.bermabru.pdf 4 fois), et
-- s'y ajoutent bons de commande, proformas et listings comptables.
-- Chacun créait une ligne vide à contrôler.
--
-- Ces pièces ne sont pas jetées : elles gardent leur ligne et leur PDF,
-- reçoivent un type et une synthèse écrite par l'extraction, et sortent
-- de la liste des factures pour aller dans leur propre dossier.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. UN TROISIÈME ÉTAT DE CONTRÔLE
--    'a_controler' → facture à vérifier    'valide' → facture contrôlée
--    'document'    → ce n'est pas une facture
-- ---------------------------------------------------------------------
alter table public.invoices
  drop constraint if exists invoices_review_status_check;
alter table public.invoices
  add constraint invoices_review_status_check
  check (review_status in ('a_controler', 'valide', 'document'));

alter table public.invoices
  add column if not exists doc_type text,
  add column if not exists doc_summary text;

alter table public.invoices
  drop constraint if exists invoices_doc_type_check;
alter table public.invoices
  add constraint invoices_doc_type_check
  check (doc_type is null or doc_type in (
    'facture', 'note_credit', 'conditions_generales', 'bon_commande',
    'proforma', 'listing', 'rappel', 'autre'));

comment on column public.invoices.doc_type is
  'Nature du document lue par l''extraction. Tout ce qui n''est ni facture ni note de crédit part en review_status = ''document''.';
comment on column public.invoices.doc_summary is
  'Synthèse en une ou deux phrases : ce que contient le document, pour le reconnaître sans l''ouvrir.';

create index if not exists invoices_documents_idx
  on public.invoices (created_at desc)
  where review_status = 'document';

-- ---------------------------------------------------------------------
-- 2. LES DOCUMENTS SORTENT DES AGRÉGATS
--    Sans cela, 39 pièces à 0 € gonflent le nombre de factures du mois
--    et se retrouvent dans « sans référence Smart » ou « à payer ».
-- ---------------------------------------------------------------------
create or replace function public.period_summary(p_from date, p_to date)
returns json language sql stable as $$
  with r as (
    select * from public.invoices
     where invoice_date >= p_from and invoice_date <= p_to
       and review_status <> 'document'
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
    'documents',   (select count(*) from public.invoices
                     where review_status = 'document'
                       and invoice_date >= p_from and invoice_date <= p_to),
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
-- 3. REQUALIFIER UNE PIÈCE À LA MAIN
--    Dans les deux sens : une facture prise pour des conditions générales
--    revient dans la liste, et l'inverse.
-- ---------------------------------------------------------------------
create or replace function public.set_document_kind(
  p_invoice uuid,
  p_kind    text,                  -- 'facture' rend la pièce à la liste
  p_reason  text default null
) returns json language plpgsql security definer as $$
declare
  v_avant text;
  v_label text;
  v_nom   text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('facture','note_credit','conditions_generales',
                                      'bon_commande','proforma','listing','rappel','autre') then
    raise exception 'Nature de document inconnue : %', p_kind;
  end if;

  select coalesce(i.doc_type, 'facture'), coalesce(s.name, '?') || ' ' || i.invoice_number
    into v_avant, v_label
    from public.invoices i left join public.suppliers s on s.id = i.supplier_id
   where i.id = p_invoice;
  if v_label is null then
    raise exception 'Facture introuvable.';
  end if;

  update public.invoices
     set doc_type = p_kind,
         -- une facture ou une note de crédit repasse en contrôle ;
         -- le reste part au dossier des documents
         review_status = case when p_kind in ('facture','note_credit')
                              then 'a_controler' else 'document' end,
         updated_at = now()
   where id = p_invoice;

  select full_name into v_nom from public.profiles where id = auth.uid();

  if v_avant is distinct from p_kind then
    insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value,
                                   reason, author, author_name)
    values ('invoice', p_invoice, v_label, 'doc_type', v_avant, p_kind,
            coalesce(p_reason, 'requalification manuelle'), auth.uid(), v_nom);
  end if;

  return json_build_object('id', p_invoice, 'doc_type', p_kind, 'before', v_avant);
end;
$$;

revoke all on function public.set_document_kind(uuid, text, text) from public;
grant execute on function public.set_document_kind(uuid, text, text) to authenticated;

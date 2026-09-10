-- =====================================================================
-- VK Gestion — annulation d'un rejeu
--
-- Découvrir un défaut après 500 extractions ne doit pas être irréversible.
-- On peut supprimer les factures issues d'un expéditeur et remettre ses
-- messages en quarantaine : les fichiers d'origine n'ont jamais quitté le
-- coffre, tout est rejouable.
--
-- Deux protections :
--   • seules les factures encore « à contrôler » sont supprimées. Une
--     facture déjà validée porte du travail humain (référence Smart,
--     références libres, corrections) : on ne la détruit pas en masse.
--   • seules les factures issues de l'e-mail sont concernées. Une facture
--     saisie à la main n'est jamais touchée.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Aperçu : ce que l'annulation ferait, sans rien faire
-- ---------------------------------------------------------------------
create or replace function public.rollback_sender_preview(p_email text)
returns json language sql stable as $$
  with q as (
    select * from public.inbound_queue
     where sender_email = lower(btrim(p_email)) and status in ('done', 'ignored', 'error')
  ),
  ids as (
    select unnest(invoice_ids) as id from q
    union
    select invoice_id from q where invoice_id is not null
  ),
  f as (
    select i.* from public.invoices i join ids on ids.id = i.id where i.source = 'email'
  )
  select json_build_object(
    'email',              lower(btrim(p_email)),
    'messages',           (select count(*) from q),
    'factures_total',     (select count(*) from f),
    'factures_a_annuler', (select count(*) from f where review_status = 'a_controler'),
    'factures_validees',  (select count(*) from f where review_status = 'valide'),
    'montant_a_annuler',  (select coalesce(sum(amount_tvac), 0) from f where review_status = 'a_controler'),
    -- fiches créées automatiquement qui n'auraient plus aucune facture
    'fiches_orphelines',  (select count(*) from public.suppliers s
                            where s.needs_review
                              and not exists (
                                select 1 from public.invoices i
                                 where i.supplier_id = s.id
                                   and i.id not in (select id from f where review_status = 'a_controler')))
  );
$$;

-- ---------------------------------------------------------------------
-- Annulation effective
-- ---------------------------------------------------------------------
create or replace function public.rollback_sender(
  p_email text,
  p_revoke boolean default true      -- retirer aussi l'expéditeur de la liste blanche
) returns json language plpgsql security definer as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_supprimees int := 0;
  v_conservees int := 0;
  v_messages int := 0;
  v_fiches int := 0;
  v_nom text;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut annuler un rejeu.' using errcode = '42501';
  end if;
  if v_email = '' then raise exception 'Adresse d''expéditeur vide.'; end if;

  select full_name into v_nom from public.profiles where id = auth.uid();

  create temporary table _rb_ids on commit drop as
    with q as (
      select * from public.inbound_queue
       where sender_email = v_email and status in ('done', 'ignored', 'error')
    )
    select distinct x.id
      from (
        select unnest(invoice_ids) as id from q
        union
        select invoice_id from q where invoice_id is not null
      ) x
     where x.id is not null;

  select count(*) into v_conservees
    from public.invoices i join _rb_ids r on r.id = i.id
   where i.source = 'email' and i.review_status = 'valide';

  delete from public.invoices i
   using _rb_ids r
   where i.id = r.id and i.source = 'email' and i.review_status = 'a_controler';
  get diagnostics v_supprimees = row_count;

  -- Fiches créées automatiquement devenues sans objet
  delete from public.suppliers s
   where s.needs_review
     and not exists (select 1 from public.invoices i where i.supplier_id = s.id);
  get diagnostics v_fiches = row_count;

  -- Retour en quarantaine : les fichiers sont toujours dans le coffre
  update public.inbound_queue
     set status = 'quarantine', error = null, processed_at = null,
         invoice_id = null, invoice_ids = '{}'
   where sender_email = v_email and status in ('done', 'ignored', 'error');
  get diagnostics v_messages = row_count;

  if p_revoke then
    delete from public.allowed_senders where email = v_email;
  end if;

  insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value, reason, author, author_name)
  values ('reception', null, v_email, 'rejeu',
          v_supprimees || ' factures', 'annulé',
          format('annulation du rejeu : %s factures supprimées, %s validées conservées, %s messages remis en quarantaine',
                 v_supprimees, v_conservees, v_messages),
          auth.uid(), v_nom);

  return json_build_object(
    'email', v_email,
    'factures_supprimees', v_supprimees,
    'factures_validees_conservees', v_conservees,
    'fiches_supprimees', v_fiches,
    'messages_remis_en_quarantaine', v_messages,
    'expediteur_retire', p_revoke
  );
end;
$$;

revoke all on function public.rollback_sender(text, boolean) from public;
grant execute on function public.rollback_sender(text, boolean) to authenticated;
grant execute on function public.rollback_sender_preview(text) to authenticated;

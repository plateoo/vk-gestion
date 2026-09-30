-- =====================================================================
-- VK Gestion — mémoriser un oui/non sur la fiche fournisseur
--
-- remember_supplier_value ne connaissait que des champs texte et
-- numériques. Le nouveau réglage « montants présentés autrement » est un
-- booléen, et deux choses l'auraient fait échouer :
--
--   • il ne figurait pas dans la liste blanche des champs mémorisables,
--     et la fonction refuse par principe tout champ non prévu — ce qui est
--     la bonne façon de se tromper : elle dit non plutôt que d'écrire
--     n'importe où ;
--   • un champ laissé vide devient NULL, et la colonne est NOT NULL.
--     Décocher la case aurait produit une erreur au lieu d'un « non ».
--
-- On traite donc le vide comme un « non » pour les booléens : c'est le
-- sens que lui donne l'utilisateur quand il efface une case.
-- =====================================================================

create or replace function public.remember_supplier_value(
  p_supplier uuid,
  p_field    text,
  p_value    text,
  p_source   text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_autorises text[] := array['name','address','vat_number','payment_terms',
                              'default_vat_rate','default_expense_type',
                              'discount_rate','discount_days','country',
                              'encodage_particulier'];
  v_type  text;
  v_avant text;
  v_nom   text;
  v_net   text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if not (p_field = any(v_autorises)) then
    raise exception 'Ce champ ne se mémorise pas : % (valeurs propres à chaque document)', p_field;
  end if;

  select atttypid::regtype::text into v_type
    from pg_attribute
   where attrelid = 'public.suppliers'::regclass and attname = p_field and attnum > 0;
  if v_type is null then
    raise exception 'Champ inconnu sur la fiche fournisseur : %', p_field;
  end if;

  v_net := nullif(btrim(coalesce(p_value, '')), '');
  if v_type in ('numeric', 'integer', 'bigint', 'smallint', 'real', 'double precision') then
    v_net := replace(v_net, ',', '.');
  end if;
  -- Effacer une case à cocher veut dire « non », pas « inconnu ».
  if v_type = 'boolean' then
    v_net := case when v_net is null then 'false'
                  when lower(v_net) in ('true', 't', 'oui', '1') then 'true'
                  else 'false' end;
  end if;

  execute format('select (%I)::text from public.suppliers where id = $1', p_field)
    into v_avant using p_supplier;

  execute format('update public.suppliers set %I = $1::%s where id = $2', p_field, v_type)
    using v_net, p_supplier;

  select full_name into v_nom from public.profiles where id = auth.uid();

  -- Journalisation reprise mot pour mot de 0026 : change_log n'a pas de
  -- colonne « source », le motif se range dans « reason ».
  if v_avant is distinct from v_net then
    insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value,
                                   reason, author, author_name)
    select 'supplier', p_supplier, s.name, p_field, v_avant, v_net,
           coalesce(p_source, 'mémorisation depuis une facture'), auth.uid(), v_nom
      from public.suppliers s where s.id = p_supplier;
  end if;

  return json_build_object('field', p_field, 'value', v_net, 'before', v_avant, 'type', v_type);
end;
$$;

revoke all on function public.remember_supplier_value(uuid, text, text, text) from public;
grant execute on function public.remember_supplier_value(uuid, text, text, text) to authenticated;

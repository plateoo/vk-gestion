-- =====================================================================
-- VK Gestion — la mémorisation ne marchait pas sur les nombres
--
-- remember_supplier_value écrit la valeur reçue TELLE QUELLE, en texte :
--
--     execute format('update public.suppliers set %I = $1 ...')
--
-- Cela fonctionne pour name, address ou vat_number, qui sont du texte.
-- Mais quatre champs de sa propre liste sont numériques — payment_terms,
-- default_vat_rate, discount_rate, discount_days — et Postgres refuse :
-- « 42804 : column is of type numeric but expression is of type text ».
--
-- Autrement dit, depuis sa mise en service, la case « retenir cet escompte
-- pour ce fournisseur » de l'écran de contrôle échouait silencieusement.
-- Aucune fiche ne porte d'escompte à ce jour, et c'est la raison.
--
-- On lit le type réel de la colonne dans le catalogue et on convertit.
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
                              'discount_rate','discount_days','country'];
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

  -- Le type réel de la colonne : c'est lui qui commande la conversion.
  select atttypid::regtype::text into v_type
    from pg_attribute
   where attrelid = 'public.suppliers'::regclass and attname = p_field and attnum > 0;
  if v_type is null then
    raise exception 'Champ inconnu sur la fiche fournisseur : %', p_field;
  end if;

  v_net := nullif(btrim(coalesce(p_value, '')), '');
  -- Une virgule décimale saisie à la belge ne doit pas faire échouer la
  -- conversion : « 2,5 » vaut 2.5.
  if v_type in ('numeric', 'integer', 'bigint', 'smallint', 'real', 'double precision') then
    v_net := replace(v_net, ',', '.');
  end if;

  execute format('select (%I)::text from public.suppliers where id = $1', p_field)
    into v_avant using p_supplier;

  execute format('update public.suppliers set %I = $1::%s where id = $2', p_field, v_type)
    using v_net, p_supplier;

  select full_name into v_nom from public.profiles where id = auth.uid();

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

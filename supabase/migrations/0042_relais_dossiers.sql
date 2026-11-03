-- =====================================================================
-- 0042 — Le relais entre Jordan et Marie sur les dossiers clients.
--
-- Jordan confie un dossier à Marie avec une consigne (« vérifier si la
-- commande est passée »). Marie répond d'un geste : traité, ou pas traité,
-- avec un mot. Jordan voit les réponses, puis classe le retour.
--
-- Un seul relais à la fois par dossier : c'est l'état du dossier, pas un
-- échange. L'historique s'écrit dans le fil du dossier (client_notes), qui
-- garde chaque consigne et chaque réponse.
--
--   relais = null          rien en attente
--   relais = 'a_traiter'   confié, Marie ne l'a pas encore traité
--   relais = 'traite'      Marie l'a traité — Jordan n'a pas encore classé
--   relais = 'non_traite'  Marie n'a pas pu — Jordan n'a pas encore classé
-- =====================================================================

alter table public.client_files
  add column if not exists relais          text,
  add column if not exists relais_consigne text,
  add column if not exists relais_reponse  text,
  add column if not exists relais_par_name text,
  add column if not exists relais_le       timestamptz;

alter table public.client_files drop constraint if exists client_files_relais_ck;
alter table public.client_files add constraint client_files_relais_ck
  check (relais is null or relais in ('a_traiter', 'traite', 'non_traite'));

create index if not exists client_files_relais_idx on public.client_files (relais)
  where relais is not null;

-- Un geste du relais, avec sa trace dans le fil du dossier.
--   p_etat 'a_traiter'  : confier (p_texte = la consigne ; vide = « ce qu'il reste à faire »)
--   p_etat 'traite'     : traité (p_texte = un mot facultatif)
--   p_etat 'non_traite' : pas traité (p_texte = pourquoi, facultatif)
--   p_etat 'classe'     : le retour est lu, le relais se referme
create or replace function public.client_relais(p_file uuid, p_etat text, p_texte text default null)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_moi    text := public._client_moi();
  v_texte  text := nullif(btrim(coalesce(p_texte, '')), '');
  v_f      public.client_files%rowtype;
  v_note   text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_etat not in ('a_traiter', 'traite', 'non_traite', 'classe') then
    raise exception 'Geste inconnu : %', p_etat;
  end if;

  select * into v_f from public.client_files where id = p_file for update;
  if not found then
    raise exception 'Ce dossier n''existe plus.';
  end if;

  if p_etat = 'a_traiter' then
    v_texte := coalesce(v_texte, nullif(btrim(coalesce(v_f.todo, '')), ''));
    if v_texte is null then
      raise exception 'Écris ce qu''il faut faire : la consigne est vide.';
    end if;
    update public.client_files
       set relais = 'a_traiter', relais_consigne = v_texte, relais_reponse = null,
           relais_par_name = v_moi, relais_le = now()
     where id = p_file;
    v_note := 'À traiter : ' || v_texte;

  elsif p_etat in ('traite', 'non_traite') then
    if v_f.relais is null then
      raise exception 'Rien n''est en attente sur ce dossier.';
    end if;
    update public.client_files
       set relais = p_etat, relais_reponse = v_texte,
           relais_par_name = v_moi, relais_le = now()
     where id = p_file;
    v_note := case p_etat when 'traite' then 'Traité' else 'Pas traité' end
              || coalesce(' — ' || v_texte, '');

  else
    update public.client_files
       set relais = null, relais_le = now(), relais_par_name = v_moi
     where id = p_file;
    -- Classer ne dit rien de neuf : pas de ligne dans le fil.
    return json_build_object('id', p_file, 'relais', null);
  end if;

  insert into public.client_notes (file_id, body, automatique, author, author_name)
  values (p_file, v_note, false, auth.uid(), v_moi);

  return json_build_object('id', p_file, 'relais', p_etat);
end;
$$;

-- Plusieurs dossiers d'un coup, chacun avec son « reste à faire » pour
-- consigne. Les dossiers sans reste à faire, ou déjà confiés, sont laissés.
create or replace function public.client_relais_lot(p_files uuid[])
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  for v_id in
    select f.id from public.client_files f
     where f.id = any(p_files)
       and f.relais is distinct from 'a_traiter'
       and nullif(btrim(coalesce(f.todo, '')), '') is not null
  loop
    perform public.client_relais(v_id, 'a_traiter', null);
    v_n := v_n + 1;
  end loop;
  return json_build_object('confies', v_n);
end;
$$;

-- La liste reprend les nouvelles colonnes : on la redéclare.
create or replace function public.client_file_list()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(d order by d.updated_at desc), '[]'::json)
    from (
      select f.*,
             coalesce((select json_agg(j order by j.created_at)
                         from public.client_jobs j where j.file_id = f.id), '[]'::json) as jobs,
             (select json_build_object('body', n.body, 'author_name', n.author_name,
                                       'created_at', n.created_at, 'automatique', n.automatique)
                from public.client_notes n where n.file_id = f.id
               order by n.created_at desc limit 1) as last_note
        from public.client_files f
       where public.is_member()
    ) d;
$$;

-- Ce que la pastille du menu affiche
create or replace function public.client_relais_count()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select json_build_object(
    'a_traiter', count(*) filter (where relais = 'a_traiter'),
    'reponses',  count(*) filter (where relais in ('traite', 'non_traite'))
  ) from public.client_files where public.is_member();
$$;

revoke all on function public.client_relais(uuid, text, text) from public;
revoke all on function public.client_relais_lot(uuid[]) from public;
revoke all on function public.client_relais_count() from public;
grant execute on function public.client_relais(uuid, text, text) to authenticated;
grant execute on function public.client_relais_lot(uuid[]) to authenticated;
grant execute on function public.client_relais_count() to authenticated;

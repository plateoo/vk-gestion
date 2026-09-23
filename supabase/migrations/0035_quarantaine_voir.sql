-- =====================================================================
-- VK Gestion — voir ce qu'il y a dans un message en quarantaine
--
-- Jordan : « un souci pour ceux que je ne sais pas, je voulais ouvrir
-- pour voir les documents internes afin de savoir ce qu'il en est, mais
-- aucune possibilité de voir, donc pas de possibilité d'accepter,
-- supprimer ou mettre en transitaire. »
--
-- Le défaut est grave et il était sous mes yeux : l'écran n'affichait
-- qu'une adresse, un décompte et le dernier sujet. On demandait à
-- quelqu'un de décider « est-ce un fournisseur du magasin ? » en lui
-- cachant précisément ce qui permet de répondre — le sujet de chaque
-- message et le nom des pièces jointes. Devant une adresse inconnue, la
-- seule conduite prudente était de ne rien faire. C'est ce qui s'est
-- passé : treize expéditeurs immobiles depuis deux semaines.
--
-- On ouvre donc le contenu, et l'on ajoute le geste qui manquait : le
-- refus. Autoriser était possible, refuser ne l'était pas — un tri où
-- l'on ne peut dire que « oui » n'est pas un tri.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Le détail d'un expéditeur en quarantaine
--
-- Sujet, date et pièces jointes de chaque message. Les chemins servent à
-- fabriquer des liens signés : les fichiers restent dans un espace privé,
-- rien ne devient lisible sans connexion.
-- ---------------------------------------------------------------------
create or replace function public.quarantine_detail(p_email text)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(m order by m.received_at desc nulls last), '[]'::json) from (
    select q.id,
           q.subject,
           q.received_at,
           q.created_at,
           q.message_id,
           coalesce(q.files, '[]'::jsonb) as files
      from public.inbound_queue q
     where q.status = 'quarantine'
       and lower(q.sender_email) = lower(btrim(coalesce(p_email, '')))
       and public.is_manager()
     order by q.received_at desc nulls last
     limit 200
  ) m;
$$;

revoke all on function public.quarantine_detail(text) from public;
grant execute on function public.quarantine_detail(text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Refuser un expéditeur
--
-- Ses messages quittent la quarantaine sans jamais devenir des factures.
-- On rend les chemins des pièces jointes pour que l'appelant efface les
-- objets : sans cela, on paierait indéfiniment le stockage de documents
-- que plus rien ne référence.
--
-- Le refus n'inscrit PAS l'adresse sur une liste noire. Un expéditeur
-- refusé aujourd'hui peut écrire demain une facture légitime, et une
-- liste noire silencieuse serait la meilleure façon de perdre une
-- facture sans jamais savoir pourquoi.
-- ---------------------------------------------------------------------
create or replace function public.quarantine_reject(p_email text)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_chemins text[];
  v_n int;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut refuser un expéditeur.' using errcode = '42501';
  end if;
  if coalesce(btrim(coalesce(p_email, '')), '') = '' then
    raise exception 'Adresse manquante.';
  end if;

  select array_agg(distinct f->>'path')
    into v_chemins
    from public.inbound_queue q, jsonb_array_elements(coalesce(q.files, '[]'::jsonb)) f
   where q.status = 'quarantine'
     and lower(q.sender_email) = lower(btrim(p_email))
     and f->>'path' is not null;

  delete from public.inbound_queue
   where status = 'quarantine'
     and lower(sender_email) = lower(btrim(p_email));
  get diagnostics v_n = row_count;

  return json_build_object('messages', v_n, 'chemins', coalesce(v_chemins, '{}'));
end;
$$;

revoke all on function public.quarantine_reject(text) from public;
grant execute on function public.quarantine_reject(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Retrouver la trace d'un fournisseur dans le courrier
--
-- Jordan : « je vais contrôler que toutes les factures ont bien été
-- envoyées par mon fournisseur, car il me réclame des factures mais je ne
-- trouve pas de traces dans le logiciel. »
--
-- La question n'est pas « quelles factures ai-je ? » mais « qu'est-ce qui
-- est ARRIVÉ ? ». Un message peut être en quarantaine, avoir échoué à
-- l'extraction, ou n'avoir contenu aucune facture lisible : dans les
-- trois cas il n'existe aucune facture, et pourtant le fournisseur a bien
-- écrit. Sans cette vue, l'absence de facture ne se distingue pas de
-- l'absence d'envoi — et c'est exactement le doute où il se trouve.
--
-- On cherche large : l'adresse, le domaine, le sujet. Un fournisseur
-- écrit rarement depuis une seule adresse.
-- ---------------------------------------------------------------------
create or replace function public.courrier_trace(p_q text, p_limit int default 100)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(m order by m.quand desc nulls last), '[]'::json) from (
    select q.id,
           q.sender_email,
           q.subject,
           q.status,
           coalesce(q.received_at, q.created_at) as quand,
           q.error,
           jsonb_array_length(coalesce(q.files, '[]'::jsonb)) as nb_fichiers,
           coalesce((select string_agg(f->>'name', ', ')
                       from jsonb_array_elements(coalesce(q.files, '[]'::jsonb)) f), '') as fichiers,
           -- La facture née de ce message, s'il y en a une. C'est elle qui
           -- transforme « reçu » en « traité ».
           (select count(*) from public.invoices i where i.message_id = q.message_id) as factures
      from public.inbound_queue q
     where public.is_manager()
       and (
         public.vk_unaccent(lower(q.sender_email)) like '%' || public.vk_unaccent(lower(btrim(coalesce(p_q, '')))) || '%'
         or public.vk_unaccent(lower(coalesce(q.subject, ''))) like '%' || public.vk_unaccent(lower(btrim(coalesce(p_q, '')))) || '%'
       )
       and btrim(coalesce(p_q, '')) <> ''
     order by coalesce(q.received_at, q.created_at) desc nulls last
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) m;
$$;

revoke all on function public.courrier_trace(text, int) from public;
grant execute on function public.courrier_trace(text, int) to authenticated;

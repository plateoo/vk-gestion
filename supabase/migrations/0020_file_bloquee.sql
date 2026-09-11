-- =====================================================================
-- VK Gestion — débloquer la file de réception
--
-- Deux fuites constatées le 11 septembre, sur des factures réelles :
--
--   1. 138 messages en 'pending' depuis le 9 septembre. Le traitement
--      n'est déclenché qu'à l'ARRIVÉE d'un message ; ceux qui sortent de
--      quarantaine en lot ne sont rejoués que 20 à la fois, et rien ne
--      reprend le reste. Ils seraient restés là indéfiniment, sans que
--      personne ne s'en aperçoive : l'écran annonçait « le prochain lot
--      arrive au cycle suivant », alors que Power Automate ne les
--      redonnera jamais.
--
--   2. 5 messages figés en 'processing' depuis deux jours. La fonction
--      les avait marqués en cours, puis s'est interrompue. Aucun
--      mécanisme ne les remet en file : cinq vraies factures perdues en
--      silence — Bermabru, Dal Creations, une facture Electrolux.
--
-- Le silence est le vrai défaut ici. Une pièce qui n'arrive pas doit se
-- voir, et se rattraper.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. REMETTRE EN FILE CE QUI EST RESTÉ EN ROUTE
--    Un traitement dépasse rarement la minute. Au-delà de vingt, il n'est
--    plus en cours : il est mort.
-- ---------------------------------------------------------------------
create or replace function public.requeue_stuck(p_minutes int default 20)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  update public.inbound_queue
     set status = 'pending',
         error = coalesce(error, '') || case when error is null then '' else ' | ' end
                 || 'traitement interrompu, remis en file'
   where status = 'processing'
     and coalesce(processed_at, created_at) < now() - make_interval(mins => p_minutes);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. CE QUI RESTE À TRAITER
--    Le front a besoin de savoir combien, et lesquels prendre ensuite.
--    Les plus anciens d'abord : ce sont eux qui attendent le plus.
-- ---------------------------------------------------------------------
create or replace function public.queue_backlog(p_limit int default 10)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select json_build_object(
    'en_attente',   (select count(*) from public.inbound_queue where status = 'pending'),
    'en_cours',     (select count(*) from public.inbound_queue where status = 'processing'),
    'bloques',      (select count(*) from public.inbound_queue
                      where status = 'processing'
                        and coalesce(processed_at, created_at) < now() - interval '20 minutes'),
    'traites',      (select count(*) from public.inbound_queue where status = 'done'),
    'sans_facture', (select count(*) from public.inbound_queue where status = 'sans_facture'),
    'en_erreur',    (select count(*) from public.inbound_queue where status = 'error'),
    'prochains',    coalesce((select json_agg(id) from (
                       select id from public.inbound_queue
                        where status = 'pending'
                        order by created_at
                        limit greatest(1, least(p_limit, 20))) n), '[]'::json)
  ) where public.is_manager();
$$;

revoke all on function public.requeue_stuck(int) from public;
revoke all on function public.queue_backlog(int) from public;
grant execute on function public.requeue_stuck(int) to authenticated;
grant execute on function public.queue_backlog(int) to authenticated;

-- ---------------------------------------------------------------------
-- 3. LE FAIRE TOUT SEUL
--    Toutes les dix minutes, ce qui est resté en route repart en file.
--    Le traitement lui-même reste déclenché depuis l'application : il
--    demande un appel réseau vers la fonction d'extraction, et pg_cron
--    n'a pas à détenir de jeton pour cela.
-- ---------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'vk-file-bloquee';
select cron.schedule('vk-file-bloquee', '*/10 * * * *',
  $$select public.requeue_stuck(20)$$);

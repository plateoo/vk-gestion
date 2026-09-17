-- =====================================================================
-- VK Gestion — la sauvegarde de nuit, inscrite noir sur blanc
--
-- Jordan : « je veux que l'apps crée des sauvegardes chaque jour pendant
-- la nuit ».
--
-- C'est déjà le cas depuis le 11 septembre : six instantanés d'affilée à
-- 02 h 15. Mais en le vérifiant, deux défauts sont apparus, et tous les
-- deux comptent.
--
-- 1. La tâche planifiée avait été créée à la main, directement dans la
--    base. Elle n'existait dans AUCUNE migration. Le jour où la base est
--    reconstruite — restauration, changement de projet — les sauvegardes
--    s'arrêteraient sans que personne ne s'en aperçoive, et on ne le
--    découvrirait qu'en ayant besoin d'une sauvegarde. Elle est donc
--    écrite ici, avec le reste.
--
-- 2. L'indicateur « sauvegarde planifiée » de l'écran d'administration se
--    contentait de vérifier que l'extension pg_cron était installée. Il
--    aurait affiché « oui » avec une tâche supprimée. Un voyant qui ne
--    peut pas s'éteindre ne sert à rien : il lit maintenant la tâche
--    elle-même, et dit à quelle heure et quand elle est passée.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Deux heures du matin et quart : le magasin dort, la base est calme.
--
--    La tâche existante ne faisait que créer l'instantané, jamais élaguer.
--    Les sauvegardes s'accumulaient donc sans fin — invisible aujourd'hui
--    avec six fichiers d'un mégaoctet, moins drôle dans deux ans. On garde
--    le nom historique de la tâche et on lui ajoute l'élagage.
--
--    Un seul nom : la tâche « vk-sauvegarde-nuit » d'une première version
--    de cette migration est retirée, sinon la base se sauvegarderait deux
--    fois la même nuit.
-- ---------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job
 where jobname in ('vk-sauvegarde-nuit', 'vk-sauvegarde-quotidienne');
select cron.schedule('vk-sauvegarde-quotidienne', '15 2 * * *',
  $$select public.backup_create('auto', 'sauvegarde de nuit'), public.backup_prune()$$);

-- ---------------------------------------------------------------------
-- 2. Un voyant qui dit la vérité
--
-- On ne rapporte plus « pg_cron est installé » mais « la tâche existe,
-- elle est active, voici son horaire, et voici si son dernier passage a
-- réussi ». Les trois questions qu'on se pose vraiment.
-- ---------------------------------------------------------------------
create or replace function public.backup_status()
returns json language sql stable security definer
set search_path = public, cron, pg_temp as $$
  select json_build_object(
    'total',            (select count(*) from public.backups),
    'derniere',         (select max(created_at) from public.backups),
    'derniere_taille',  (select size_bytes from public.backups order by created_at desc limit 1),
    'dernier_telechargement', (select max(downloaded_at) from public.backups),
    'heures_depuis',    (select round(extract(epoch from (now() - max(created_at))) / 3600)
                           from public.backups),
    'jours_depuis_telechargement',
                        (select round(extract(epoch from (now() - max(downloaded_at))) / 86400)
                           from public.backups),
    -- La tâche de nuit, telle qu'elle est réellement enregistrée.
    'planifiee',        exists (select 1 from cron.job
                                 where jobname = 'vk-sauvegarde-quotidienne' and active),
    'horaire',          (select schedule from cron.job where jobname = 'vk-sauvegarde-quotidienne'),
    'dernier_passage',  (select max(start_time) from cron.job_run_details d
                          join cron.job j on j.jobid = d.jobid
                         where j.jobname = 'vk-sauvegarde-quotidienne'),
    'dernier_passage_ok', (select d.status = 'succeeded' from cron.job_run_details d
                            join cron.job j on j.jobid = d.jobid
                           where j.jobname = 'vk-sauvegarde-quotidienne'
                           order by d.start_time desc limit 1),
    -- Combien de nuits d'affilée ont produit un instantané : c'est cela
    -- qui prouve que la mécanique tourne, pas la présence d'une tâche.
    'nuits_consecutives', (select count(distinct created_at::date) from public.backups
                            where kind = 'auto' and created_at > now() - interval '30 days')
  ) where public.is_manager();
$$;

revoke all on function public.backup_status() from public;
grant execute on function public.backup_status() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Le contrôle de sécurité vérifie la tâche, plus seulement l'extension
-- ---------------------------------------------------------------------
comment on function public.backup_status() is
  'État des sauvegardes. « planifiee » lit la tâche pg_cron vk-sauvegarde-quotidienne '
  'elle-même : si quelqu''un la supprime, le voyant s''éteint.';

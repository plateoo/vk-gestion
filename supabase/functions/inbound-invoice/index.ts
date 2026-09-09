// =====================================================================
// inbound-invoice — réception des factures depuis Power Automate
//
// Déclencheur « À l'arrivée d'un nouvel e-mail (V3) » sur le dossier
// Factures, suivi d'une action HTTP POST vers cette URL.
//
// Réponse immédiate, extraction en arrière-plan : une lecture de PDF prend
// 10 à 20 s, bien au-delà de ce qu'attend un connecteur HTTP.
//
// Expéditeur inconnu : aucune facture n'est créée, mais les pièces jointes
// sont CONSERVÉES en quarantaine. Autoriser l'expéditeur plus tard doit
// permettre de rejouer le message, pas de constater qu'il est perdu.
// =====================================================================
import { db, processQueueRow } from '../_shared/process.ts';

const INBOUND_TOKEN = Deno.env.get('INBOUND_TOKEN') ?? '';

// Power Automate reçoit toujours 200 : un code d'erreur le ferait réessayer
// en boucle, et chaque tentative créerait une ligne de plus.
const ok = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

type Attachment = { name: string; contentType: string; bytes: Uint8Array };

function pick(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const found = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
    if (found && o[found] != null && String(o[found]).trim() !== '') return String(o[found]).trim();
  }
  return '';
}

/** « Nom <a@b.c> » ou adresse nue */
function emailOf(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseAttachments(payload: Record<string, unknown>): Attachment[] {
  const key = Object.keys(payload).find((k) => k.toLowerCase() === 'attachments');
  const list = key ? payload[key] : null;
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const name = pick(a, 'name', 'fileName') || 'piece-jointe';
    const b64 = pick(a, 'contentBytes', 'content');
    if (!b64) continue;
    let bytes: Uint8Array;
    try { bytes = b64ToBytes(b64); } catch { continue; }
    // Signatures et logos pèsent quelques kilo-octets : on les ignore.
    if (bytes.length < 5 * 1024) continue;
    out.push({ name, contentType: pick(a, 'contentType') || 'application/octet-stream', bytes });
  }
  return out;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1. Jeton dans l'URL : la fonction est publique, c'est la première barrière.
  if (!INBOUND_TOKEN || url.searchParams.get('token') !== INBOUND_TOKEN) {
    return new Response(JSON.stringify({ error: 'jeton invalide' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (req.method !== 'POST') return ok({ ignored: true, reason: 'méthode non supportée' });

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return ok({ ignored: true, reason: 'corps illisible' }); }

  const sb = db();

  // Rejeu administratif d'une ligne déjà en file (utilisé par les tests et
  // l'exploitation ; l'interface passe, elle, par replay-inbound et un JWT).
  const replayId = pick(payload, 'replay_queue_id');
  if (replayId) {
    // @ts-ignore : EdgeRuntime est fourni par le runtime Supabase
    EdgeRuntime.waitUntil(processQueueRow(replayId));
    return ok({ replaying: replayId });
  }

  const sender    = emailOf(pick(payload, 'from', 'sender', 'fromAddress', 'emailAddress'));
  const subject   = pick(payload, 'subject');
  const messageId = pick(payload, 'messageId', 'internetMessageId', 'id') || `sans-id-${crypto.randomUUID()}`;
  const received  = pick(payload, 'receivedAt', 'receivedDateTime', 'dateTimeReceived') || new Date().toISOString();
  // Identifiant du lot Power Automate : sert à mesurer l'avancement du
  // rattrapage. Un lot plus petit que le plafond veut dire dossier vidé.
  const batchId   = pick(payload, 'batchId', 'batch_id', 'runId') || null;

  // 2. Déjà reçu ? Power Automate peut rejouer un déclencheur.
  //    On compte la livraison : sans ce compteur, un renvoi ne laisse aucune
  //    trace et l'on ne peut plus savoir si un message manquant a été envoyé.
  const { data: seen } = await sb.from('inbound_queue').select('id, status, deliveries')
    .eq('message_id', messageId).maybeSingle();
  if (seen) {
    await sb.from('inbound_queue').update({
      deliveries: (seen.deliveries ?? 1) + 1,
      last_delivery_at: new Date().toISOString()
    }).eq('id', seen.id);
    return ok({
      ignored: true, reason: 'message déjà reçu',
      queue_id: seen.id, status: seen.status, deliveries: (seen.deliveries ?? 1) + 1
    });
  }

  // 3. Pièces jointes : déposées avant tout contrôle d'expéditeur, pour que
  //    la quarantaine soit réellement rejouable.
  const attachments = parseAttachments(payload);
  if (!attachments.length) {
    await sb.from('rejected_messages').insert({
      sender_email: sender, subject, message_id: messageId,
      reason: 'aucune pièce jointe exploitable', attachment_count: 0
    });
    return ok({ ignored: true, reason: 'aucune pièce jointe exploitable' });
  }

  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const files: { path: string; name: string; content_type: string; size: number }[] = [];
  for (const a of attachments) {
    const safe = a.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80);
    const path = `${folder}/${crypto.randomUUID()}-${safe}`;
    const { error } = await sb.storage.from('factures')
      .upload(path, a.bytes, { contentType: a.contentType, upsert: false });
    if (!error) files.push({ path, name: a.name, content_type: a.contentType, size: a.bytes.length });
  }
  if (!files.length) return ok({ ignored: true, reason: 'dépôt des fichiers impossible' });

  // 4. Expéditeur autorisé ?
  const { data: allowed } = await sb.from('allowed_senders').select('id').eq('email', sender).maybeSingle();

  const { data: queued, error: qErr } = await sb.from('inbound_queue').insert({
    message_id: messageId, sender_email: sender, subject, received_at: received, files,
    batch_id: batchId,
    status: allowed ? 'pending' : 'quarantine'
  }).select('id').single();
  if (qErr) return ok({ ignored: true, reason: 'mise en file impossible', detail: qErr.message });

  if (!allowed) {
    // Journalisé, rien créé, mais tout est conservé et rejouable.
    await sb.from('rejected_messages').insert({
      sender_email: sender, subject, message_id: messageId,
      reason: 'expéditeur non autorisé', attachment_count: files.length, queue_id: queued.id
    });
    return ok({ quarantined: true, reason: 'expéditeur non autorisé', sender, queue_id: queued.id, files: files.length });
  }

  // 5. Réponse immédiate ; l'extraction continue en arrière-plan.
  // @ts-ignore : EdgeRuntime est fourni par le runtime Supabase
  EdgeRuntime.waitUntil(processQueueRow(queued.id));

  return ok({ accepted: true, queue_id: queued.id, files: files.length });
});

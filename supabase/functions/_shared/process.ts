// =====================================================================
// Traitement d'un message de la file, partagé par inbound-invoice
// (réception) et replay-inbound (rejeu après autorisation d'un expéditeur).
// Une seule implémentation : les deux chemins ne peuvent pas diverger.
// =====================================================================
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

export const db = (): SupabaseClient =>
  createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------
// Extraction UBL — cas secondaire, mais fiable à 100 % quand il est là
// ---------------------------------------------------------------------
function tagValue(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>([^<]*)<`, 'i'));
  return m ? m[1].trim() : null;
}

export function parseUbl(xml: string) {
  const num = (v: string | null) => (v == null || v === '' ? null : Number(v));
  const supplierBlock = xml.match(
    /<(?:[a-zA-Z0-9]+:)?AccountingSupplierParty[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?AccountingSupplierParty>/i
  )?.[0] ?? '';
  const percent = num(tagValue(xml, 'Percent'));
  const adresse = [
    tagValue(supplierBlock, 'StreetName'),
    tagValue(supplierBlock, 'BuildingNumber'),
    tagValue(supplierBlock, 'PostalZone'),
    tagValue(supplierBlock, 'CityName')
  ].filter(Boolean).join(' ');
  const payeeBlock = xml.match(
    /<(?:[a-zA-Z0-9]+:)?PayeeFinancialAccount[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?PayeeFinancialAccount>/i
  )?.[0] ?? '';
  return {
    fournisseur_nom: tagValue(supplierBlock, 'RegistrationName') || tagValue(supplierBlock, 'Name'),
    fournisseur_tva: tagValue(supplierBlock, 'CompanyID'),
    fournisseur_adresse: adresse || null,
    fournisseur_iban: tagValue(payeeBlock, 'ID'),
    numero_facture: tagValue(xml, 'ID'),
    date_facture: tagValue(xml, 'IssueDate'),
    date_echeance: tagValue(xml, 'DueDate'),
    montant_htva: num(tagValue(xml, 'TaxExclusiveAmount')),
    montant_tvac: num(tagValue(xml, 'TaxInclusiveAmount')),
    montant_tva: num(tagValue(xml, 'TaxAmount')),
    taux_tva: percent == null ? null : percent / 100,
    devise: tagValue(xml, 'DocumentCurrencyCode') || 'EUR',
    est_avoir: false,
    champs_incertains: [] as string[],
    commentaire: null as string | null,
    _source: 'ubl'
  };
}

// ---------------------------------------------------------------------
// Extraction PDF — chemin principal
// ---------------------------------------------------------------------
const EXTRACTION_PROMPT = `Tu extrais les données d'une facture fournisseur belge ou européenne.

Réponds UNIQUEMENT avec un objet JSON, sans texte avant ou après,
sans balises markdown.

{
  "fournisseur_nom": string,
  "fournisseur_tva": string|null,
  "fournisseur_adresse": string|null,   // adresse de facturation complète, sur une ligne
  "fournisseur_iban": string|null,      // IBAN de paiement figurant sur la facture
  "numero_facture": string,
  "date_facture": "AAAA-MM-JJ",
  "date_echeance": "AAAA-MM-JJ"|null,
  "montant_htva": number,
  "montant_tva": number,
  "montant_tvac": number,
  "taux_tva": number,          // décimal entre 0 et 1 : 0.21 pour 21 %, jamais 21
  "devise": string,
  "est_avoir": boolean,
  "champs_incertains": string[],
  "commentaire": string|null
}

Règles strictes :
- Si une information est absente ou illisible, mets null. N'invente jamais
  une valeur, ne déduis pas un montant manquant par calcul.
- Les montants sont des nombres, point décimal, sans symbole ni séparateur
  de milliers.
- Attention aux formats de date européens : 03/09/2026 est le 3 septembre.
- Le fournisseur est l'émetteur de la facture, pas le destinataire.
  Le destinataire est Vandenborre Kitchen : ne le confonds jamais avec
  l'émetteur. L'adresse et l'IBAN demandés sont ceux de l'ÉMETTEUR.
- N'invente jamais un IBAN : s'il n'apparaît pas, mets null.
- Une note de crédit a des montants négatifs : mets est_avoir à true et
  les montants en négatif.
- Si plusieurs taux de TVA coexistent, indique le taux principal et
  signale-le dans commentaire.
- Ajoute à champs_incertains tout champ lu sur un document flou, coupé
  ou ambigu.
- Si le document n'est pas une facture, renvoie tous les champs à null et
  explique-le dans commentaire.`;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export async function extractFromPdf(bytes: Uint8Array) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY absente');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) } },
          { type: 'text', text: EXTRACTION_PROMPT }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`API Anthropic ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = (body?.content ?? [])
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text).join('').trim();
  const json = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return { ...JSON.parse(json), _source: 'pdf' };
}

// ---------------------------------------------------------------------
// Taux de TVA : le modèle rend tantôt 0.21, tantôt 21. Sans normalisation,
// « 6 » serait rejeté par la liste des taux légaux et retomberait
// silencieusement sur 21 % — une facture à 6 % enregistrée à 21 %.
// On unifie d'abord, on recoupe ensuite avec le rapport TVA / HTVA.
// ---------------------------------------------------------------------
export const LEGAL_RATES = [0, 0.06, 0.12, 0.21];

export function normalizedRate(d: Record<string, unknown>): number | null {
  // Attention : Number(null) vaut 0, pas NaN. Sans ce garde-fou, un taux
  // absent serait lu comme 0 % et la TVA déductible disparaîtrait.
  const v = d.taux_tva;
  const raw = (v === null || v === undefined || v === '') ? NaN : Number(v);
  const rate = Number.isFinite(raw) ? (Math.abs(raw) > 1 ? raw / 100 : raw) : NaN;

  const htva = Number(d.montant_htva);
  const tva  = Number(d.montant_tva);
  const implied = (Number.isFinite(htva) && Number.isFinite(tva) && Math.abs(htva) > 0.01)
    ? tva / htva : NaN;

  // Un taux annoncé qui colle à un taux légal l'emporte.
  if (Number.isFinite(rate)) {
    const hit = LEGAL_RATES.find((r) => Math.abs(rate - r) < 0.005);
    if (hit !== undefined) return hit;
  }
  // Sinon on se rabat sur le taux réellement porté par les montants.
  if (Number.isFinite(implied)) {
    const hit = LEGAL_RATES.find((r) => Math.abs(implied - r) < 0.005);
    if (hit !== undefined) return hit;
  }
  return Number.isFinite(rate) ? rate : null;
}

// ---------------------------------------------------------------------
// Contrôles automatiques : ils rattrapent les erreurs de lecture
// ---------------------------------------------------------------------
export function runChecks(d: Record<string, unknown>): string[] {
  const alerts: string[] = [];
  const htva = Number(d.montant_htva);
  const tva  = Number(d.montant_tva);
  const tvac = Number(d.montant_tvac);
  const rate = normalizedRate(d) ?? NaN;

  if ([htva, tva, tvac].every(Number.isFinite)) {
    if (Math.abs(htva + tva - tvac) > 0.02) alerts.push('montants incohérents');
    if (Number.isFinite(rate) && Math.abs(htva) > 0.01 && Math.abs(tva / htva - rate) > 0.02) {
      alerts.push('taux de TVA incohérent avec les montants');
    }
  } else {
    alerts.push('montants incomplets');
  }

  const date = String(d.date_facture ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const t = new Date(date + 'T00:00:00Z').getTime();
    const now = Date.now();
    if (t < now - 400 * 86400000 || t > now + 31 * 86400000) alerts.push('date de facture invraisemblable');
  } else {
    alerts.push('date de facture illisible');
  }

  if (Number.isFinite(tvac) && Math.abs(tvac) > 50000) alerts.push('montant supérieur à 50 000 €');
  return alerts;
}

// ---------------------------------------------------------------------
// Fiche d'attente : uniquement quand l'extraction ne rend aucun nom.
// Jamais un nom déduit du domaine de l'expéditeur.
// ---------------------------------------------------------------------
const PLACEHOLDER = 'À identifier';

async function placeholderSupplier(sb: SupabaseClient): Promise<string> {
  const { data: found } = await sb.from('suppliers').select('id').eq('name', PLACEHOLDER).maybeSingle();
  if (found) return found.id;
  const { data: created, error } = await sb.from('suppliers')
    .insert({ name: PLACEHOLDER, needs_review: true, payment_terms: 30 })
    .select('id').single();
  if (error || !created) throw new Error('fiche d\'attente impossible à créer');
  return created.id;
}

// ---------------------------------------------------------------------
// Traitement d'une ligne de file
// ---------------------------------------------------------------------
export async function processQueueRow(queueId: string): Promise<void> {
  const sb = db();
  const { data: row } = await sb.from('inbound_queue').select('*').eq('id', queueId).single();
  if (!row) return;

  await sb.from('inbound_queue')
    .update({ status: 'processing', attempts: (row.attempts ?? 0) + 1 }).eq('id', queueId);

  try {
    const files = (row.files ?? []) as { path: string; name: string; content_type: string }[];
    const exploitables = files.filter((f) =>
      /\.(pdf|xml)$/i.test(f.name) || /pdf|xml/i.test(f.content_type));
    if (!exploitables.length) throw new Error('aucune pièce jointe exploitable');

    // L'expéditeur est-il un transitaire ? Son adresse ne dit alors rien du
    // fournisseur : un ancien franchisé retransmet les factures de dizaines
    // de sociétés, s'en servir pour rapprocher serait faux par construction.
    const { data: expediteur } = await sb.from('allowed_senders')
      .select('is_forwarder').eq('email', row.sender_email).maybeSingle();
    const transitaire = !!expediteur?.is_forwarder;

    // UNE FACTURE PAR PIÈCE JOINTE. Un même mail peut en porter plusieurs,
    // de fournisseurs différents : n'en traiter qu'une les perdrait toutes
    // sauf la première, sans le moindre signal.
    const creees: string[] = [];
    const doublons: string[] = [];
    const soucis: string[] = [];

    for (const cible of exploitables) {
      try {
        const id = await traiterFichier(sb, row, cible, transitaire);
        if (id) creees.push(id);
        else doublons.push(cible.name);   // déjà en base, écarté sciemment
      } catch (e) {
        soucis.push(`${cible.name} : ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Aucun fichier retenu et aucun doublon : c'est un échec, pas un silence.
    if (!creees.length && !doublons.length) {
      throw new Error(soucis.join(' | ') || 'aucune facture créée');
    }

    // Le compte rendu dit toujours ce qu'il est advenu de CHAQUE pièce jointe.
    const rendu = [
      `${creees.length}/${exploitables.length} facture${creees.length > 1 ? 's' : ''} créée${creees.length > 1 ? 's' : ''}`,
      doublons.length ? `doublons écartés : ${doublons.join(', ')}` : '',
      soucis.length ? `échecs : ${soucis.join(' | ')}` : ''
    ].filter(Boolean).join(' — ');

    await sb.from('inbound_queue').update({
      status: 'done',
      invoice_id: creees[0] ?? null,
      invoice_ids: creees,
      error: (doublons.length || soucis.length) ? rendu : null,
      processed_at: new Date().toISOString()
    }).eq('id', queueId);
  } catch (e) {
    await sb.from('inbound_queue').update({
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      processed_at: new Date().toISOString()
    }).eq('id', queueId);
  }
}

/**
 * Traite une pièce jointe et renvoie l'identifiant de la facture créée,
 * ou null si c'est un doublon déjà connu.
 */
async function traiterFichier(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  cible: { path: string; name: string; content_type: string },
  transitaire: boolean
): Promise<string | null> {
  const estXml = /\.xml$/i.test(cible.name) || /xml/i.test(cible.content_type);

  const { data: blob, error: dlErr } = await sb.storage.from('factures').download(cible.path);
  if (dlErr || !blob) throw new Error('fichier introuvable dans le stockage');
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let extracted: Record<string, unknown>;
  let notes = '';
  try {
    extracted = estXml ? parseUbl(new TextDecoder().decode(bytes)) : await extractFromPdf(bytes);
  } catch (e) {
    extracted = { _source: 'échec', commentaire: e instanceof Error ? e.message : String(e) };
    notes = 'échec extraction';
  }

  const alerts = notes ? [] : runChecks(extracted);
  const uncertain = Array.isArray(extracted.champs_incertains) ? extracted.champs_incertains as string[] : [];

  const { data: match } = await sb.rpc('match_or_create_supplier', {
    p_name:         (extracted.fournisseur_nom as string) ?? '',
    p_vat:          (extracted.fournisseur_tva as string) ?? null,
    p_email:        row.sender_email,
    p_address:      (extracted.fournisseur_adresse as string) ?? null,
    p_iban:         (extracted.fournisseur_iban as string) ?? null,
    p_is_forwarder: transitaire
  });
  const m = (match ?? {}) as Record<string, unknown>;
  if (m.iban_divergent) alerts.push('IBAN différent de celui de la fiche fournisseur');

  let supplierId = (m.id as string) ?? null;
  if (!supplierId) {
    supplierId = await placeholderSupplier(sb);
    notes = notes || 'fournisseur non identifié';
  }

  const number = String(extracted.numero_facture ?? '').trim()
    || `SANS-NUMERO-${crypto.randomUUID().slice(0, 8)}`;

  const { data: dup } = await sb.from('invoices').select('id')
    .eq('supplier_id', supplierId).eq('invoice_number', number).maybeSingle();
  if (dup) return null;   // doublon : on ne crée rien, on passe au fichier suivant

  const rate = normalizedRate(extracted);
  const htva = Number(extracted.montant_htva);
  if (rate !== null && !LEGAL_RATES.includes(rate)) alerts.push(`taux de TVA non standard (${rate})`);

  const { data: created, error: insErr } = await sb.from('invoices').insert({
    supplier_id: supplierId,
    invoice_number: number,
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(String(extracted.date_facture ?? ''))
      ? extracted.date_facture : new Date().toISOString().slice(0, 10),
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(extracted.date_echeance ?? ''))
      ? extracted.date_echeance : null,
    amount_htva: Number.isFinite(htva) ? htva : 0,
    vat_rate: rate !== null && LEGAL_RATES.includes(rate) ? rate : 0.21,
    source: 'email',
    review_status: 'a_controler',
    file_path: cible.path,
    sender_email: row.sender_email,
    message_id: row.message_id,
    extraction_notes: JSON.stringify({
      notes: notes || null,
      source: extracted._source,
      fichier: cible.name,
      alerts,
      champs_incertains: uncertain,
      commentaire: extracted.commentaire ?? null,
      rapprochement: {
        par: m.matched_by ?? null,
        fiche_creee: m.created ?? false,
        transitaire,
        iban_lu: m.iban_lu ?? null,
        iban_fiche: m.iban_fiche ?? null,
        iban_divergent: m.iban_divergent ?? false
      },
      brut: extracted
    })
  }).select('id').single();
  if (insErr) throw new Error(insErr.message);
  return created.id;
}

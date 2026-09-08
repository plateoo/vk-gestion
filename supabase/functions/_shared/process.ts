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
  return {
    fournisseur_nom: tagValue(supplierBlock, 'RegistrationName') || tagValue(supplierBlock, 'Name'),
    fournisseur_tva: tagValue(supplierBlock, 'CompanyID'),
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
  "numero_facture": string,
  "date_facture": "AAAA-MM-JJ",
  "date_echeance": "AAAA-MM-JJ"|null,
  "montant_htva": number,
  "montant_tva": number,
  "montant_tvac": number,
  "taux_tva": number,
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
  l'émetteur.
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
// Contrôles automatiques : ils rattrapent les erreurs de lecture
// ---------------------------------------------------------------------
export function runChecks(d: Record<string, unknown>): string[] {
  const alerts: string[] = [];
  const htva = Number(d.montant_htva);
  const tva  = Number(d.montant_tva);
  const tvac = Number(d.montant_tvac);
  const rate = Number(d.taux_tva);

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
    const xmlFile = files.find((f) => /\.xml$/i.test(f.name) || /xml/i.test(f.content_type));
    const pdfFile = files.find((f) => /\.pdf$/i.test(f.name) || /pdf/i.test(f.content_type));
    const target = xmlFile ?? pdfFile;
    if (!target) throw new Error('aucune pièce jointe exploitable');

    const { data: blob, error: dlErr } = await sb.storage.from('factures').download(target.path);
    if (dlErr || !blob) throw new Error('fichier introuvable dans le stockage');
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let extracted: Record<string, unknown>;
    let notes = '';
    try {
      extracted = xmlFile ? parseUbl(new TextDecoder().decode(bytes)) : await extractFromPdf(bytes);
    } catch (e) {
      extracted = { _source: 'échec', commentaire: e instanceof Error ? e.message : String(e) };
      notes = 'échec extraction';
    }

    const alerts = notes ? [] : runChecks(extracted);
    const uncertain = Array.isArray(extracted.champs_incertains) ? extracted.champs_incertains as string[] : [];

    const { data: match } = await sb.rpc('match_or_create_supplier', {
      p_name:  (extracted.fournisseur_nom as string) ?? '',
      p_vat:   (extracted.fournisseur_tva as string) ?? null,
      p_email: row.sender_email
    });
    let supplierId = (match as { id?: string } | null)?.id ?? null;
    if (!supplierId) {
      supplierId = await placeholderSupplier(sb);
      notes = notes || 'fournisseur non identifié';
    }

    const number = String(extracted.numero_facture ?? '').trim()
      || `SANS-NUMERO-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

    const { data: dup } = await sb.from('invoices').select('id')
      .eq('supplier_id', supplierId).eq('invoice_number', number).maybeSingle();
    if (dup) {
      await sb.from('inbound_queue').update({
        status: 'ignored',
        error: `doublon probable : ${number} existe déjà pour ce fournisseur`,
        processed_at: new Date().toISOString()
      }).eq('id', queueId);
      return;
    }

    const rate = Number(extracted.taux_tva);
    const htva = Number(extracted.montant_htva);
    const invoice = {
      supplier_id: supplierId,
      invoice_number: number,
      invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(String(extracted.date_facture ?? ''))
        ? extracted.date_facture : new Date().toISOString().slice(0, 10),
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(extracted.date_echeance ?? ''))
        ? extracted.date_echeance : null,
      amount_htva: Number.isFinite(htva) ? htva : 0,
      vat_rate: [0, 0.06, 0.12, 0.21].includes(rate) ? rate : 0.21,
      source: 'email',
      review_status: 'a_controler',
      file_path: target.path,
      sender_email: row.sender_email,
      message_id: row.message_id,
      extraction_notes: JSON.stringify({
        notes: notes || null,
        source: extracted._source,
        alerts,
        champs_incertains: uncertain,
        commentaire: extracted.commentaire ?? null,
        brut: extracted
      })
    };

    const { data: created, error: insErr } = await sb.from('invoices').insert(invoice).select('id').single();
    if (insErr) throw new Error(insErr.message);

    await sb.from('inbound_queue').update({
      status: 'done', invoice_id: created.id, error: null, processed_at: new Date().toISOString()
    }).eq('id', queueId);
  } catch (e) {
    await sb.from('inbound_queue').update({
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      processed_at: new Date().toISOString()
    }).eq('id', queueId);
  }
}

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkCreatorEligibility } from '@/lib/opportunities/eligibility';
import { deliverOpportunity } from '@/lib/opportunities/matching';
import { computeExpiryDays, type OpportunityType, type Urgency } from '@/lib/opportunities/caps';

function stripContactInfo(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    // emails
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, '[redacted]')
    // phone-ish: sequences with 7+ digits allowing spaces/dashes/parens
    .replace(/(?:\+?\d[\s-.()]*){7,}/g, '[redacted]')
    // obvious URLs
    .replace(/https?:\/\/\S+/gi, '[redacted]');
}

type CreatePayload = {
  type: OpportunityType;
  title: string;
  description?: string;
  criteria: {
    role_title?: string;
    seniority?: string;
    industry?: string;
    expertise?: string[];
    role_types?: string[];
    need?: string;
  };
  include_recruiters?: boolean;
  urgency?: Urgency;
};

function validate(body: unknown): { ok: true; data: CreatePayload } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body.' };
  const b = body as Record<string, unknown>;
  if (b.type !== 'hiring' && b.type !== 'business') {
    return { ok: false, error: 'type must be hiring or business.' };
  }
  if (typeof b.title !== 'string' || b.title.trim().length < 3 || b.title.length > 140) {
    return { ok: false, error: 'title is required (3–140 chars).' };
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    return { ok: false, error: 'description must be text.' };
  }
  if (b.description && (b.description as string).length > 2000) {
    return { ok: false, error: 'description too long (max 2000 chars).' };
  }
  if (!b.criteria || typeof b.criteria !== 'object') {
    return { ok: false, error: 'criteria required.' };
  }
  if (b.type === 'business') {
    const u = b.urgency;
    if (u !== 'low' && u !== 'medium' && u !== 'urgent') {
      return { ok: false, error: 'urgency required for business needs.' };
    }
  }
  return { ok: true, data: b as unknown as CreatePayload };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let raw: unknown;
  try { raw = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }

  const check = validate(raw);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const payload = check.data;

  const elig = await checkCreatorEligibility(user.id);
  if (!elig.ok) {
    return NextResponse.json({ error: elig.message, code: elig.code }, { status: 403 });
  }

  const admin = createAdminClient();
  const expiresAt = new Date(
    Date.now() + computeExpiryDays(payload.type, payload.urgency) * 86400_000
  ).toISOString();

  const { data: opportunity, error: insertErr } = await admin
    .from('opportunities')
    .insert({
      creator_id: user.id,
      type: payload.type,
      title: payload.title.trim(),
      description: stripContactInfo(payload.description?.trim() ?? null),
      criteria: payload.criteria,
      include_recruiters: payload.type === 'hiring' && !!payload.include_recruiters,
      urgency: payload.type === 'business' ? payload.urgency : null,
      expires_at: expiresAt,
    })
    .select('id, creator_id, type, include_recruiters, criteria')
    .single();

  if (insertErr || !opportunity) {
    console.error('[opportunities/create] insert failed', { by: user.email, err: insertErr });
    return NextResponse.json({ error: 'Could not create.' }, { status: 500 });
  }

  let delivered: { candidatesNotified: number; recruitersNotified: number };
  try {
    delivered = await deliverOpportunity(opportunity as any);
  } catch (err) {
    console.error('[opportunities/create] delivery failed', { by: user.email, err });
    return NextResponse.json(
      {
        opportunity_id: opportunity.id,
        candidates_notified: 0,
        recruiters_notified: 0,
        warning: 'Created, but delivery is delayed.',
      },
      { status: 201 }
    );
  }

  console.log('[opportunities/create] success', {
    by: user.email,
    opportunity_id: opportunity.id,
    ...delivered,
  });

  return NextResponse.json(
    {
      opportunity_id: opportunity.id,
      candidates_notified: delivered.candidatesNotified,
      recruiters_notified: delivered.recruitersNotified,
    },
    { status: 201 }
  );
}

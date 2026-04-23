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

// Prompt #15 — Creator validation rules
// Reject generic-only titles/tags, enforce minimum signal quality.

const GENERIC_TITLE_TOKENS = new Set([
  'lawyer', 'attorney', 'counsel', 'consultant', 'advisor',
  'partner', 'associate', 'specialist', 'expert', 'professional',
  'person', 'someone', 'help'
]);

const GENERIC_TAGS = new Set([
  'help', 'advice', 'meeting', 'connection', 'network',
  'consulting', 'business', 'work', 'expert', 'guidance'
]);

function isGenericOnlyTitle(title: string): boolean {
  // Title is generic-only if every alphabetic token is in GENERIC_TITLE_TOKENS.
  const tokens = title.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => GENERIC_TITLE_TOKENS.has(t));
}

function isGenericOnlyTagSet(tags: string[]): boolean {
  if (tags.length === 0) return true;
  return tags.every((t) => GENERIC_TAGS.has(t.toLowerCase().trim()));
}

type ValidationErrors = Record<string, string>;

function validate(
  body: unknown
): { ok: true; data: CreatePayload } | { ok: false; errors: ValidationErrors } {
  const errors: ValidationErrors = {};

  if (!body || typeof body !== 'object') {
    return { ok: false, errors: { _root: 'Invalid body.' } };
  }
  const b = body as Record<string, unknown>;

  // Type
  if (b.type !== 'hiring' && b.type !== 'business') {
    errors.type = 'Type must be hiring or business.';
    return { ok: false, errors };
  }

  // Title
  if (typeof b.title !== 'string' || b.title.trim().length === 0) {
    errors.title = 'Title is required.';
  } else {
    const title = b.title.trim();
    if (title.length < 8) errors.title = 'Title must be at least 8 characters.';
    else if (title.length > 80) errors.title = 'Title must be 80 characters or fewer.';
    else if (b.type === 'hiring' && isGenericOnlyTitle(title)) {
      errors.title = 'Be more specific. "Lawyer" or "Attorney" alone is too generic — add the practice area or focus (e.g., "Privacy Counsel", "M&A Associate").';
    }
  }

  // Description
  if (b.description !== undefined && typeof b.description !== 'string') {
    errors.description = 'Description must be text.';
  } else if (b.description && (b.description as string).length > 2000) {
    errors.description = 'Description too long (max 2000 chars).';
  }

  // Criteria (required object)
  if (!b.criteria || typeof b.criteria !== 'object') {
    errors.criteria = 'Criteria required.';
    return { ok: false, errors };
  }
  const c = b.criteria as Record<string, unknown>;

  // Expertise tags
  const rawExpertise = Array.isArray(c.expertise) ? (c.expertise as unknown[]) : [];
  const tags = rawExpertise
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const minTags = b.type === 'business' ? 2 : 1;
  if (tags.length < minTags) {
    errors.expertise =
      b.type === 'business'
        ? 'Business needs require at least 2 specific expertise tags.'
        : 'Hiring needs at least 1 expertise tag.';
  } else if (tags.length > 8) {
    errors.expertise = 'Maximum 8 expertise tags.';
  } else {
    const badLen = tags.find((t) => t.length < 3 || t.length > 40);
    if (badLen) {
      errors.expertise = 'Each tag must be 3–40 characters.';
    } else if (isGenericOnlyTagSet(tags)) {
      errors.expertise = 'These tags are too generic. Add at least one specific area of practice or domain.';
    }
  }

  // Hiring requires seniority + role_types
  if (b.type === 'hiring') {
    const sen = typeof c.seniority === 'string' ? c.seniority.trim() : '';
    if (!sen) errors.seniority = 'Seniority is required.';

    const roleTypes = Array.isArray(c.role_types)
      ? (c.role_types as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];
    if (roleTypes.length === 0) errors.role_types = 'At least one role type is required.';
  }

  // Business requires urgency
  if (b.type === 'business') {
    const u = b.urgency;
    if (u !== 'low' && u !== 'medium' && u !== 'urgent') {
      errors.urgency = 'Urgency is required.';
    }
  }

  // Substantive content check — description after redaction must have something
  // left, OR tags must carry the meaning.
  if (!errors.description && b.description) {
    const redacted = stripContactInfo((b.description as string).trim());
    if (redacted) {
      const withoutRedacted = redacted.replace(/\[redacted\]/g, '').trim();
      if (withoutRedacted.length === 0 && tags.length < minTags + 1) {
        errors.description = 'Description is mostly contact info. Describe the need instead — Andrel handles introductions.';
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
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
  if (!check.ok) {
    return NextResponse.json(
      { error: 'validation_failed', fields: check.errors },
      { status: 400 }
    );
  }
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

  // Observability
  const { logEvent } = await import('@/lib/opportunities/events');
  await logEvent({
    eventType: 'opportunity_created',
    opportunityId: opportunity.id,
    userId: user.id,
    metadata: { type: payload.type, urgency: payload.urgency ?? null },
  });

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

  // Schedule tranche 2 delivery if tranche 1 delivered at least one candidate.
  // Cron picks this up after 48h and delivers up to 2 more candidates, unless
  // the creator has already introduced someone from tranche 1.
  const totalDelivered = delivered.candidatesNotified + delivered.recruitersNotified;
  if (totalDelivered > 0) {
    const { TRANCHE_2_DELAY_HOURS } = await import('@/lib/opportunities/caps');
    const scheduledAt = new Date(
      Date.now() + TRANCHE_2_DELAY_HOURS * 3600_000
    ).toISOString();
    await admin
      .from('opportunities')
      .update({ tranche_2_scheduled_at: scheduledAt })
      .eq('id', opportunity.id);
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

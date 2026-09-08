-- Local-only fixtures. Two Professional members, two Next members, one platform admin.
-- NOTHING here is production data and no Next member exists in production.
INSERT INTO public.profiles (id, email, full_name, company, member_type, is_admin) VALUES
 ('11111111-1111-4111-8111-111111111111','p1@x.com','Pro One','Acme','professional', false),
 ('22222222-2222-4222-8222-222222222222','p2@x.com','Pro Two','Globex','professional', false),
 ('33333333-3333-4333-8333-333333333333','n1@x.com','Next One','Harvard Law','next', false),
 ('44444444-4444-4444-8444-444444444444','n2@x.com','Next Two','Yale Law','next', false),
 ('55555555-5555-4555-8555-555555555555','admin@x.com','Platform','Andrel','professional', true);
INSERT INTO public.meeting_credits (user_id, free_credits, premium_credits, balance)
SELECT id, 5, 0, 5 FROM public.profiles;

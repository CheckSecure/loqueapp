const { Pool } = require('pg')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const SQL = `
-- PROFILES
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  role text,
  company text,
  location text,
  bio text,
  expertise text[] DEFAULT '{}',
  intro_preferences text[] DEFAULT '{}',
  open_to_intros boolean DEFAULT true,
  linkedin_url text,
  twitter_url text,
  website_url text,
  avatar_color text DEFAULT 'bg-indigo-500',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='Profiles viewable by authenticated users') THEN
    CREATE POLICY "Profiles viewable by authenticated users" ON public.profiles FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='Users can insert own profile') THEN
    CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='Users can update own profile') THEN
    CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  colors text[] := ARRAY['bg-violet-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-cyan-500','bg-indigo-500','bg-pink-500','bg-teal-500'];
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_color)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', colors[floor(random() * 8 + 1)])
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- INTRODUCTIONS
CREATE TABLE IF NOT EXISTS public.introductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(requester_id, target_id)
);

ALTER TABLE public.introductions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='introductions' AND policyname='Users see their introductions') THEN
    CREATE POLICY "Users see their introductions" ON public.introductions FOR SELECT TO authenticated USING (requester_id = auth.uid() OR target_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='introductions' AND policyname='Users can request introductions') THEN
    CREATE POLICY "Users can request introductions" ON public.introductions FOR INSERT TO authenticated WITH CHECK (requester_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='introductions' AND policyname='Targets can update status') THEN
    CREATE POLICY "Targets can update status" ON public.introductions FOR UPDATE TO authenticated USING (target_id = auth.uid());
  END IF;
END $$;

-- CONVERSATIONS
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversation_participants (
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversations' AND policyname='Users see their conversations') THEN
    CREATE POLICY "Users see their conversations" ON public.conversations FOR SELECT TO authenticated
      USING (id IN (SELECT conversation_id FROM public.conversation_participants WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversations' AND policyname='Participants can create conversations') THEN
    CREATE POLICY "Participants can create conversations" ON public.conversations FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversation_participants' AND policyname='Users see conversation participants') THEN
    CREATE POLICY "Users see conversation participants" ON public.conversation_participants FOR SELECT TO authenticated
      USING (conversation_id IN (SELECT conversation_id FROM public.conversation_participants cp WHERE cp.user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversation_participants' AND policyname='Users can join conversations') THEN
    CREATE POLICY "Users can join conversations" ON public.conversation_participants FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
END $$;

-- MESSAGES
CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='messages' AND policyname='Users see messages in their conversations') THEN
    CREATE POLICY "Users see messages in their conversations" ON public.messages FOR SELECT TO authenticated
      USING (conversation_id IN (SELECT conversation_id FROM public.conversation_participants WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='messages' AND policyname='Users can send messages') THEN
    CREATE POLICY "Users can send messages" ON public.messages FOR INSERT TO authenticated
      WITH CHECK (sender_id = auth.uid() AND conversation_id IN (SELECT conversation_id FROM public.conversation_participants WHERE user_id = auth.uid()));
  END IF;
END $$;

-- MEETINGS
CREATE TABLE IF NOT EXISTS public.meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  organizer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  attendee_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL,
  duration_minutes integer DEFAULT 30,
  meeting_type text DEFAULT 'video' CHECK (meeting_type IN ('video','in-person')),
  location text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meetings' AND policyname='Users see their meetings') THEN
    CREATE POLICY "Users see their meetings" ON public.meetings FOR SELECT TO authenticated USING (organizer_id = auth.uid() OR attendee_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meetings' AND policyname='Users can create meetings') THEN
    CREATE POLICY "Users can create meetings" ON public.meetings FOR INSERT TO authenticated WITH CHECK (organizer_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meetings' AND policyname='Organizers can update meetings') THEN
    CREATE POLICY "Organizers can update meetings" ON public.meetings FOR UPDATE TO authenticated USING (organizer_id = auth.uid());
  END IF;
END $$;
`

async function migrate() {
  const client = await pool.connect()
  try {
    console.log('Running migration...')
    await client.query(SQL)
    console.log('Migration complete!')

    // Backfill profiles for existing users
    await client.query(`
      INSERT INTO public.profiles (id, full_name, avatar_color)
      SELECT id, raw_user_meta_data->>'full_name', 'bg-indigo-500'
      FROM auth.users
      ON CONFLICT (id) DO NOTHING
    `)
    console.log('Existing users backfilled.')
  } catch (err) {
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate()

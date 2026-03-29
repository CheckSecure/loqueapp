import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const PASSWORD = 'cadre-demo-2026'

const users = [
  // CLUSTER 1 - IN-HOUSE LEGAL
  {
    email: 'daniel.abrams@apexfinancial.com',
    full_name: 'Daniel Abrams',
    title: 'General Counsel',
    company: 'Apex Financial Group',
    location: 'New York, NY',
    seniority: 'Executive',
    tier: 'executive',
    bio: 'GC overseeing regulatory and transactional legal strategy for a Fortune 200 financial services firm.',
    interests: 'compliance, M&A, financial regulation',
    role_type: 'In-house attorney',
    mentorship_role: null,
  },
  {
    email: 'rachel.stein@medcore.com',
    full_name: 'Rachel Stein',
    title: 'Associate General Counsel',
    company: 'MedCore Health',
    location: 'Boston, MA',
    seniority: 'Senior',
    tier: 'professional',
    bio: 'AGC focused on healthcare compliance and litigation management.',
    interests: 'healthcare, compliance, litigation',
    role_type: 'In-house attorney',
    mentorship_role: null,
  },
  {
    email: 'jason.liu@nexatech.com',
    full_name: 'Jason Liu',
    title: 'Senior Counsel',
    company: 'NexaTech',
    location: 'San Francisco, CA',
    seniority: 'Senior',
    tier: 'free',
    bio: 'In-house counsel specializing in product and privacy law.',
    interests: 'privacy, tech, AI',
    role_type: 'In-house attorney',
    mentorship_role: null,
  },
  {
    email: 'priya.kapoor@globallogistics.com',
    full_name: 'Priya Kapoor',
    title: 'Deputy General Counsel',
    company: 'Global Logistics Inc.',
    location: 'Chicago, IL',
    seniority: 'Executive',
    tier: 'professional',
    bio: 'Oversees global compliance and contracts for logistics operations.',
    interests: 'international law, compliance',
    role_type: 'In-house attorney',
    mentorship_role: null,
  },
  
  // CLUSTER 2 - LAW FIRM
  {
    email: 'michael.grant@grantcole.com',
    full_name: 'Michael Grant',
    title: 'Partner',
    company: 'Grant & Cole LLP',
    location: 'New York, NY',
    seniority: 'Executive',
    tier: 'executive',
    bio: 'Partner leading financial services litigation practice.',
    interests: 'litigation, regulatory',
    role_type: 'Law firm attorney',
    mentorship_role: 'Mentor',
  },
  {
    email: 'sarah.whitman@whitmanlegal.com',
    full_name: 'Sarah Whitman',
    title: 'Partner',
    company: 'Whitman Legal Group',
    location: 'Washington, DC',
    seniority: 'Executive',
    tier: 'professional',
    bio: 'Specializes in government investigations and compliance.',
    interests: 'investigations, compliance',
    role_type: 'Law firm attorney',
    mentorship_role: 'Mentor',
  },
  {
    email: 'alex.romero@klinereed.com',
    full_name: 'Alex Romero',
    title: 'Senior Associate',
    company: 'Kline & Reed',
    location: 'Miami, FL',
    seniority: 'Mid-level',
    tier: 'free',
    bio: 'Corporate associate focusing on M&A transactions.',
    interests: 'M&A, corporate',
    role_type: 'Law firm attorney',
    mentorship_role: 'Mentee',
  },
  
  // CLUSTER 3 - CONSULTANTS
  {
    email: 'david.chen@insightforensics.com',
    full_name: 'David Chen',
    title: 'Managing Director',
    company: 'Insight Forensics',
    location: 'New York, NY',
    seniority: 'Executive',
    tier: 'executive',
    bio: 'Leads forensic investigations and eDiscovery teams for enterprise clients.',
    interests: 'investigations, eDiscovery',
    role_type: 'Consultant',
    mentorship_role: null,
  },
  {
    email: 'laura.simmons@complianceadvisory.com',
    full_name: 'Laura Simmons',
    title: 'Director',
    company: 'Compliance Advisory Group',
    location: 'Boston, MA',
    seniority: 'Senior',
    tier: 'professional',
    bio: 'Advises companies on regulatory compliance programs.',
    interests: 'compliance, risk',
    role_type: 'Consultant',
    mentorship_role: null,
  },
  {
    email: 'mark.feldman@datalex.com',
    full_name: 'Mark Feldman',
    title: 'Senior Consultant',
    company: 'DataLex Solutions',
    location: 'Chicago, IL',
    seniority: 'Mid-level',
    tier: 'free',
    bio: 'Supports litigation teams with data strategy.',
    interests: 'eDiscovery, litigation',
    role_type: 'Consultant',
    mentorship_role: null,
  },
  
  // CLUSTER 4 - CONNECTORS
  {
    email: 'kevin.brooks@legalnetwork.com',
    full_name: 'Kevin Brooks',
    title: 'Founder',
    company: 'Legal Network Collective',
    location: 'New York, NY',
    seniority: 'Executive',
    tier: 'executive',
    bio: 'Hosts private legal networking events and connects industry leaders.',
    interests: 'networking, partnerships',
    role_type: 'Other',
    mentorship_role: 'Both',
  },
  {
    email: 'emily.carter@legalleaders.com',
    full_name: 'Emily Carter',
    title: 'Podcast Host',
    company: 'Legal Leaders Podcast',
    location: 'Washington, DC',
    seniority: 'Senior',
    tier: 'professional',
    bio: 'Interviews top GCs and legal operators.',
    interests: 'legal ops, networking',
    role_type: 'Other',
    mentorship_role: 'Both',
  },
]

async function seedUsers() {
  console.log('Starting user seeding...')
  
  for (const user of users) {
    try {
      // Create auth user
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: user.email,
        password: PASSWORD,
        email_confirm: true,
      })

      if (authError) {
        console.error(`Failed to create auth for ${user.email}:`, authError.message)
        continue
      }

      console.log(`✓ Created auth for ${user.full_name}`)

      // Create profile
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authData.user.id,
          email: user.email,
          full_name: user.full_name,
          title: user.title,
          company: user.company,
          location: user.location,
          bio: user.bio,
          interests: user.interests,
          seniority: user.seniority,
          role_type: user.role_type,
          mentorship_role: user.mentorship_role,
          subscription_tier: user.tier,
          onboarding_completed: true,
        })

      if (profileError) {
        console.error(`Failed to create profile for ${user.email}:`, profileError.message)
        continue
      }

      console.log(`✓ Created profile for ${user.full_name}`)

      // Give initial credits based on tier
      const initialCredits = user.tier === 'executive' ? 20 : user.tier === 'professional' ? 10 : 3
      
      const { error: creditError } = await supabase
        .from('credit_transactions')
        .insert({
          user_id: authData.user.id,
          amount: initialCredits,
          transaction_type: 'grant',
          description: 'Initial credits',
        })

      if (creditError) {
        console.error(`Failed to add credits for ${user.email}:`, creditError.message)
      } else {
        console.log(`✓ Added ${initialCredits} credits for ${user.full_name}\n`)
      }

    } catch (err) {
      console.error(`Error processing ${user.email}:`, err)
    }
  }

  console.log('\n✓ Seeding complete!')
}

seedUsers()

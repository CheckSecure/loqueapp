import { createClient } from '@/lib/supabase/server'
import { Camera, Briefcase, MapPin, Link as LinkIcon, Twitter, Linkedin, Edit3 } from 'lucide-react'

export const metadata = { title: 'Profile | Cadre' }

export default async function ProfilePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const displayName = (user?.user_metadata?.full_name as string) || user?.email?.split('@')[0] || 'Your Name'
  const email = user?.email || ''
  const initials = displayName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8">
      <div className="max-w-2xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Profile</h1>
            <p className="text-slate-500 text-sm mt-0.5">How you appear to other professionals on Cadre.</p>
          </div>
          <button className="flex items-center gap-2 text-sm font-semibold text-slate-700 border border-slate-200 px-4 py-2 rounded-lg hover:bg-slate-50 transition-colors">
            <Edit3 className="w-4 h-4" />
            Edit profile
          </button>
        </div>

        {/* Profile card */}
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden mb-6">
          <div className="h-24 bg-gradient-to-r from-indigo-500 to-violet-600" />
          <div className="px-6 pb-6">
            <div className="flex items-end justify-between -mt-10 mb-4">
              <div className="relative">
                <div className="w-20 h-20 rounded-2xl bg-indigo-600 flex items-center justify-center text-white text-2xl font-bold border-4 border-white shadow-sm">
                  {initials}
                </div>
                <button className="absolute -bottom-1 -right-1 w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center shadow-sm hover:bg-slate-50 transition-colors">
                  <Camera className="w-3 h-3 text-slate-500" />
                </button>
              </div>
              <div className="flex items-center gap-1 mb-1">
                <div className="w-2 h-2 bg-emerald-500 rounded-full" />
                <span className="text-xs text-slate-500 font-medium">Open to intros</span>
              </div>
            </div>
            <h2 className="text-xl font-bold text-slate-900">{displayName}</h2>
            <p className="text-slate-500 text-sm mt-0.5">{email}</p>

            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Briefcase className="w-4 h-4 text-slate-400" />
                <span className="text-slate-400 italic">Add your role and company</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <MapPin className="w-4 h-4 text-slate-400" />
                <span className="text-slate-400 italic">Add your location</span>
              </div>
            </div>
          </div>
        </div>

        {/* About */}
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">About</h3>
            <button className="text-xs text-indigo-600 font-medium hover:underline">Add</button>
          </div>
          <p className="text-sm text-slate-400 italic">Tell your professional story. What do you work on? What are you looking for?</p>
        </div>

        {/* Expertise */}
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">Expertise</h3>
            <button className="text-xs text-indigo-600 font-medium hover:underline">Add tags</button>
          </div>
          <p className="text-sm text-slate-400 italic">Add up to 8 topics that describe your expertise.</p>
        </div>

        {/* Links */}
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-900">Links</h3>
            <button className="text-xs text-indigo-600 font-medium hover:underline">Add link</button>
          </div>
          <div className="space-y-3">
            {[
              { icon: Linkedin, label: 'LinkedIn', placeholder: 'linkedin.com/in/yourprofile' },
              { icon: Twitter, label: 'Twitter / X', placeholder: '@yourhandle' },
              { icon: LinkIcon, label: 'Personal site', placeholder: 'yourwebsite.com' },
            ].map(({ icon: Icon, label, placeholder }) => (
              <div key={label} className="flex items-center gap-3">
                <div className="w-8 h-8 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-slate-400" />
                </div>
                <div className="flex-1">
                  <p className="text-xs font-medium text-slate-700">{label}</p>
                  <p className="text-xs text-slate-400">{placeholder}</p>
                </div>
                <button className="text-xs text-indigo-600 font-medium hover:underline">Add</button>
              </div>
            ))}
          </div>
        </div>

        {/* Intro preferences */}
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-1">Introduction preferences</h3>
          <p className="text-xs text-slate-400 mb-4">Let people know what kinds of introductions you welcome.</p>
          <div className="grid grid-cols-2 gap-2">
            {['Investors', 'Founders', 'Potential hires', 'Collaborators', 'Mentors', 'Customers'].map((pref) => (
              <label key={pref} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-indigo-600 rounded" defaultChecked={['Founders', 'Collaborators'].includes(pref)} />
                <span className="text-sm text-slate-700">{pref}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

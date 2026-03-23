'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { completeOnboarding } from '@/app/actions'
import { Loader2, User, Camera } from 'lucide-react'
import Image from 'next/image'
import { cn } from '@/lib/utils'

const ROLE_TYPES = [
  'Executive / C-Suite',
  'Investor / VC',
  'Government / Policy',
  'Finance',
  'Healthcare',
  'Legal',
]

export default function OnboardingForm() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [fullName, setFullName] = useState('')
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [roleType, setRoleType] = useState('')
  const [bio, setBio] = useState('')
  const [lookingFor, setLookingFor] = useState('')

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarFile(file)
    const reader = new FileReader()
    reader.onloadend = () => setAvatarPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!fullName.trim()) {
      setError('Full name is required')
      return
    }
    setSaving(true)
    setError(null)

    let avatarUrl: string | null = null

    if (avatarFile) {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const ext = avatarFile.name.split('.').pop() ?? 'jpg'
          const path = `${user.id}.${ext}`
          const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(path, avatarFile, { upsert: true })
          if (uploadError) {
            console.warn('[onboarding] avatar upload failed:', uploadError.message)
          } else {
            const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path)
            avatarUrl = urlData.publicUrl
          }
        }
      } catch (err) {
        console.warn('[onboarding] avatar upload threw:', err)
      }
    }

    const fd = new FormData()
    fd.append('full_name', fullName.trim())
    fd.append('title', title.trim())
    fd.append('company', company.trim())
    fd.append('role_type', roleType)
    fd.append('bio', bio.trim())
    fd.append('looking_for', lookingFor.trim())
    if (avatarUrl) fd.append('avatar_url', avatarUrl)

    const result = await completeOnboarding(fd)
    if (result.error) {
      setError(result.error)
      setSaving(false)
      return
    }

    router.push('/dashboard/introductions')
  }

  return (
    <div className="min-h-screen bg-[#F5F6FB] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">

        <div className="text-center mb-8">
          <span className="text-2xl font-bold text-[#1B2850] tracking-tight block mb-6">Andrel</span>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Complete your profile</h1>
          <p className="text-slate-500 text-sm">
            Tell us about yourself so we can match you with the right people.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-5">

          {/* Avatar */}
          <div className="flex flex-col items-center gap-2 pb-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="relative w-20 h-20 rounded-full bg-slate-100 border-2 border-dashed border-slate-300 hover:border-[#1B2850] transition-colors flex items-center justify-center overflow-hidden group"
            >
              {avatarPreview ? (
                <Image src={avatarPreview} alt="Preview" fill className="object-cover" />
              ) : (
                <User className="w-8 h-8 text-slate-300" />
              )}
              <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full">
                <Camera className="w-5 h-5 text-white" />
              </div>
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs text-[#1B2850] font-medium hover:underline"
            >
              {avatarPreview ? 'Change photo' : 'Upload profile photo'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {/* Full name */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Full name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Smith"
              required
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            />
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">Title / Role</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Chief Executive Officer"
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            />
          </div>

          {/* Company */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">Company</label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Acme Corp"
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            />
          </div>

          {/* Role type */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-2">Role type</label>
            <div className="flex flex-wrap gap-2">
              {ROLE_TYPES.map((rt) => (
                <button
                  key={rt}
                  type="button"
                  onClick={() => setRoleType(rt === roleType ? '' : rt)}
                  className={cn(
                    'px-3.5 py-2 rounded-lg text-sm font-medium border transition-all',
                    roleType === rt
                      ? 'bg-[#1B2850] text-white border-[#1B2850]'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
                  )}
                >
                  {rt}
                </button>
              ))}
            </div>
          </div>

          {/* Bio */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">Short bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A few sentences about your background and what you bring to the table."
              rows={3}
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition resize-none"
            />
          </div>

          {/* Looking for */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              What are you looking for?{' '}
              <span className="text-slate-400 font-normal text-xs">optional</span>
            </label>
            <textarea
              value={lookingFor}
              onChange={(e) => setLookingFor(e.target.value)}
              placeholder="e.g. Investors for Series A, mentorship from senior operators, strategic partners..."
              rows={2}
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 bg-[#C4922A] text-white text-sm font-semibold px-6 py-3 rounded-lg hover:bg-[#b07e21] transition-colors disabled:opacity-60"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saving ? 'Saving...' : 'Complete Profile'}
          </button>
        </form>
      </div>
    </div>
  )
}

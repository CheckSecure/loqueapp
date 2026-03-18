'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Camera, Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import Image from 'next/image'

const AVATAR_COLORS = [
  'bg-[#1B2850]', 'bg-[#2E4080]', 'bg-amber-500', 'bg-rose-500',
  'bg-cyan-600', 'bg-teal-600', 'bg-pink-500', 'bg-slate-600',
]
function pickColor(id?: string) {
  if (!id) return 'bg-[#1B2850]'
  const n = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

interface AvatarUploadProps {
  userId: string
  initialAvatarUrl?: string | null
  displayName: string
  onUpload?: (url: string) => void
}

export default function AvatarUpload({
  userId,
  initialAvatarUrl,
  displayName,
  onUpload,
}: AvatarUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialAvatarUrl ?? null)

  const initText = (displayName || '?')
    .split(' ')
    .map(n => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setError('Please select an image file (jpg, png, gif, webp).')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be under 5 MB.')
      return
    }

    setUploading(true)
    setError(null)
    setUploaded(false)

    const localUrl = URL.createObjectURL(file)
    setPreviewUrl(localUrl)

    try {
      const supabase = createClient()
      const storagePath = `${userId}/avatar.jpg`

      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(storagePath, file, { upsert: true, contentType: file.type })

      if (uploadErr) {
        setError(`Upload failed: ${uploadErr.message}`)
        setPreviewUrl(initialAvatarUrl ?? null)
        return
      }

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(storagePath)

      const finalUrl = `${publicUrl}?t=${Date.now()}`

      const { error: saveErr } = await supabase
        .from('profiles')
        .update({ avatar_url: finalUrl })
        .eq('id', userId)

      if (saveErr) {
        setError(`Could not save URL: ${saveErr.message}`)
        return
      }

      setPreviewUrl(finalUrl)
      setUploaded(true)
      onUpload?.(finalUrl)
      setTimeout(() => setUploaded(false), 3000)
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div>
      <div className="relative -mt-8 mb-4">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="relative group block w-16 h-16 rounded-xl border-4 border-white shadow-sm overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C4922A]"
          title="Click to change photo"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={displayName}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className={`w-full h-full ${pickColor(userId)} flex items-center justify-center text-white text-xl font-bold`}>
              {initText}
            </div>
          )}

          {/* Hover/loading overlay */}
          <span className={`
            absolute inset-0 bg-black/50 flex items-center justify-center
            transition-opacity
            ${uploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
          `}>
            {uploading
              ? <Loader2 className="w-5 h-5 text-white animate-spin" />
              : <Camera className="w-5 h-5 text-white" />
            }
          </span>
        </button>

        {/* Success ring */}
        {uploaded && (
          <span className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center shadow">
            <CheckCircle className="w-4 h-4 text-[#C4922A]" />
          </span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-red-600 mt-1 -mb-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </p>
      )}
      {uploaded && (
        <p className="flex items-center gap-1.5 text-xs text-[#C4922A] font-medium mt-1 -mb-2">
          <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
          Photo saved!
        </p>
      )}
    </div>
  )
}

export type CompressOptions = {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  maxBytes?: number
}

async function loadBitmap(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      return null
    }
  }
  return null
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  if (!blob) throw new Error('Gagal memproses gambar')
  return blob
}

function pickOutputName(originalName: string, ext: string) {
  const base = (originalName || 'photo').replace(/\.[^.]+$/, '')
  return `${base}.${ext}`
}

export async function compressImageFile(file: File, opts: CompressOptions = {}): Promise<File> {
  if (!file.type.startsWith('image/')) return file

  const maxWidth = opts.maxWidth ?? 1280
  const maxHeight = opts.maxHeight ?? 1280
  const maxBytes = opts.maxBytes ?? 1_000_000
  const baseQuality = opts.quality ?? 0.82

  const bitmap = await loadBitmap(file)
  if (!bitmap) return file

  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height)
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return file
  ctx.drawImage(bitmap, 0, 0, w, h)

  let quality = baseQuality
  let blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  while (blob.size > maxBytes && quality > 0.55) {
    quality = Math.max(0.55, quality - 0.07)
    blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  }

  const outName = pickOutputName(file.name, 'jpg')
  return new File([blob], outName, { type: 'image/jpeg', lastModified: file.lastModified })
}


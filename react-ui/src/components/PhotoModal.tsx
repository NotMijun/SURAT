import Modal from './Modal'

type AttachmentTab = { id: number; label: string }

type Props = {
  open: boolean
  title: string
  photoUrl: string
  alt?: string
  attachments?: AttachmentTab[]
  activeAttachmentId?: number | null
  onSelectAttachment?: (id: number) => void
  onClose: () => void
}

export default function PhotoModal({
  open,
  title,
  photoUrl,
  alt,
  attachments,
  activeAttachmentId,
  onSelectAttachment,
  onClose,
}: Props) {
  return (
    <Modal open={open} ariaLabel="Foto" onClose={onClose}>
      <div className="modal-header">
        <div className="modal-title">{title}</div>
        <button className="button button-secondary button-sm" type="button" onClick={onClose}>
          Tutup
        </button>
      </div>
      <div className="modal-body">
        {attachments && attachments.length > 1 && (
          <div className="attachment-strip">
            {attachments.map((a) => (
              <button
                key={a.id}
                className={`button button-sm button-secondary${activeAttachmentId === a.id ? ' button-active' : ''}`}
                type="button"
                onClick={() => onSelectAttachment?.(a.id)}
                aria-pressed={activeAttachmentId === a.id}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        <img className="modal-photo" src={photoUrl} alt={alt || 'Foto'} />
      </div>
    </Modal>
  )
}

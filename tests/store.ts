import { AttachmentStore, AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'

/** One deterministic image reference shared by image fixtures. */
export const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

/** A minimal durable attachment store whose request versions carry three fixed bytes. */
export class StaticAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 16,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 64,
    maxImagePixels: 4,
    maxImageDimension: 4,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve(IMAGE_REF)
  }

  readImage(ref: ImageAttachmentRef, _signal?: AbortSignal): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: Uint8Array.of(1, 2, 3) })
  }

  override readImageRequest(
    ref: ImageAttachmentRef,
    _policy: ImageRequestPolicy,
    _signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return Promise.resolve({
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
      attachment: ref,
      data: Uint8Array.of(1, 2, 3),
      mediaType: ref.mediaType,
      bytes: 3,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    })
  }
}

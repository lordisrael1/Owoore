import { v2 as cloudinary } from 'cloudinary';
import { env } from './env';

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key:    env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

export async function uploadToCloudinary(
  fileBuffer: Buffer,
  folder: string,
): Promise<{ url: string; publicId: string }> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder, resource_type: 'image' }, (err, result) => {
        if (err || !result) return reject(err ?? new Error('Cloudinary upload failed'));
        resolve({ url: result.secure_url, publicId: result.public_id });
      })
      .end(fileBuffer);
  });
}

export async function deleteFromCloudinary(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}

/**
 * publicIdFromCloudinaryUrl — recovers the public_id from a stored
 * secure_url, e.g.
 *   https://res.cloudinary.com/<cloud>/image/upload/v1712345/droptithe/logos/abc.png
 *   → droptithe/logos/abc
 *
 * We only persist logo_url (not public_id), so this is how the old
 * asset is located when a logo is replaced. Returns null for anything
 * that isn't a Cloudinary delivery URL — callers must treat that as
 * "nothing to delete", never as an error.
 */
export function publicIdFromCloudinaryUrl(url: string): string | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== 'res.cloudinary.com') return null;

    const match = pathname.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
    return match?.[1] ?? null;
  } catch {
    return null; // not a URL at all
  }
}

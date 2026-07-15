import { Request, Response } from 'express';
import 'multer';
import { catchAsync } from '../../utils/catchAsync';
import { orgService } from './org.service';
import { env } from '../../config/env';
import {
  uploadToCloudinary,
  deleteFromCloudinary,
  publicIdFromCloudinaryUrl,
} from '../../config/cloudinary';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';

/**
 * deleteOldLogo — best-effort cleanup of a replaced logo's Cloudinary
 * asset. Runs AFTER the DB points at the new URL, so the worst case of
 * a failed delete is a stray file in Cloudinary — never a broken logo.
 */
async function deleteOldLogo(oldUrl: string | null, newPublicId: string): Promise<void> {
  if (!oldUrl) return;

  const oldPublicId = publicIdFromCloudinaryUrl(oldUrl);
  if (!oldPublicId || oldPublicId === newPublicId) return;

  await deleteFromCloudinary(oldPublicId).catch((err) =>
    logger.warn({ publicId: oldPublicId, err: err.message },
      '[OrgController] Could not delete replaced logo from Cloudinary — orphaned asset'),
  );
}

export const orgController = {
  // POST /orgs — register a new church
  create: catchAsync(async (req: Request, res: Response) => {
    const { name, admin_name, admin_email, admin_password } = req.body;

    let logoUrl: string | undefined;
    let logoPublicId: string | undefined;

    if (req.file) {
      const uploaded = await uploadToCloudinary(req.file.buffer, 'droptithe/logos');
      logoUrl = uploaded.url;
      logoPublicId = uploaded.publicId;
    }

    try {
      const result = await orgService.create({
        name,
        adminName:     admin_name,
        adminEmail:    admin_email,
        adminPassword: admin_password,
        logoUrl,
      });

      res.status(201).json({ success: true, data: result });
    } catch (err) {
      if (logoPublicId) {
        await deleteFromCloudinary(logoPublicId).catch((delErr) =>
          logger.error({ publicId: logoPublicId, err: delErr }, '[OrgController] Failed to rollback Cloudinary upload'),
        );
      }
      throw err;
    }
  }),

  // GET /orgs/:slug — get church by join slug (public — used by member join page)
  getBySlug: catchAsync(async (req: Request, res: Response) => {
    const org = await orgService.getBySlug(req.params.slug as string);

    res.json({
      success: true,
      data: {
        id:       org.id,
        name:     org.name,
        slug:     org.slug,
        logo_url: org.logo_url,
        joinLink: `${env.APP_BASE_URL}/join/${org.slug}`,
      },
    });
  }),

  // PATCH /orgs/:id — update church details (admin only)
  update: catchAsync(async (req: Request, res: Response) => {
    const { name } = req.body;
    const orgId = req.params.id as string;

    let logoUrl: string | undefined;
    let logoPublicId: string | undefined;
    let previousLogoUrl: string | null = null;

    if (req.file) {
      // Capture the current logo BEFORE overwriting so it can be cleaned up
      previousLogoUrl = (await orgService.getById(orgId)).logo_url;

      const uploaded = await uploadToCloudinary(req.file.buffer, 'droptithe/logos');
      logoUrl = uploaded.url;
      logoPublicId = uploaded.publicId;
    }

    try {
      const updated = await orgService.update(orgId, { name, logo_url: logoUrl });

      if (logoPublicId) {
        await deleteOldLogo(previousLogoUrl, logoPublicId);
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      if (logoPublicId) {
        await deleteFromCloudinary(logoPublicId).catch((delErr) =>
          logger.error({ publicId: logoPublicId, err: delErr }, '[OrgController] Failed to rollback Cloudinary upload'),
        );
      }
      throw err;
    }
  }),

  // PUT /orgs/:id/logo — replace the church logo (admin only).
  // Uploads the new image, points the org at it, then deletes the
  // previous Cloudinary asset so replaced logos don't pile up.
  updateLogo: catchAsync(async (req: Request, res: Response) => {
    if (!req.file) {
      throw Errors.badRequest('No logo file provided — attach an image as multipart field "logo"');
    }

    const orgId = req.params.id as string;

    // 404 before paying for the upload
    const previousLogoUrl = (await orgService.getById(orgId)).logo_url;

    const uploaded = await uploadToCloudinary(req.file.buffer, 'droptithe/logos');

    let updated;
    try {
      updated = await orgService.update(orgId, { logo_url: uploaded.url });
    } catch (err) {
      // DB update failed — the new upload is the orphan; remove it
      await deleteFromCloudinary(uploaded.publicId).catch((delErr) =>
        logger.error({ publicId: uploaded.publicId, err: delErr },
          '[OrgController] Failed to rollback Cloudinary upload'),
      );
      throw err;
    }

    await deleteOldLogo(previousLogoUrl, uploaded.publicId);

    logger.info({ org_id: orgId, logo_url: uploaded.url }, '[OrgController] Logo replaced');

    res.json({ success: true, data: updated });
  }),
};
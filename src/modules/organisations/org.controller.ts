import { Request, Response } from 'express';
import 'multer';
import { catchAsync } from '../../utils/catchAsync';
import { orgService } from './org.service';
import { env } from '../../config/env';
import { uploadToCloudinary, deleteFromCloudinary } from '../../config/cloudinary';
import { logger } from '../../utils/logger';

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

    let logoUrl: string | undefined;
    let logoPublicId: string | undefined;

    if (req.file) {
      const uploaded = await uploadToCloudinary(req.file.buffer, 'droptithe/logos');
      logoUrl = uploaded.url;
      logoPublicId = uploaded.publicId;
    }

    try {
      const updated = await orgService.update(req.params.id as string, { name, logo_url: logoUrl });
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
};
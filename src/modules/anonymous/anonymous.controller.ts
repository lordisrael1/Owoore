import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { anonymousVaService } from '../virtual-accounts/anonymous-va.service';
import { orgService } from '../organisations/org.service';

export const anonymousController = {
  getGivingPage: catchAsync(async (req: Request, res: Response) => {
    const orgSlug = req.params.orgSlug as string;

    const org = await orgService.getBySlug(orgSlug);
    const va = await anonymousVaService.getOrCreateForOrg(org.id);

    res.json({
      success: true,
      data: {
        org: {
          name:     org.name,
          slug:     org.slug,
          logo_url: org.logo_url,
        },
        account: {
          va_number:    va.va_number,
          bank_name:    va.bank_name,
          instructions: `Transfer to ${va.va_number} (${va.bank_name})`,
        },
        notice:
          'Payments to this account are received by the church but not attributed to a specific member. ' +
          'Register at /join/' + org.slug + ' for a personal account with giving history.',
      },
    });
  }),
};

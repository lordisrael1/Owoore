import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const { queryOne } = await import('../db');
  const { vaNomba }  = await import('../modules/virtual-accounts/va.nomba');

  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: tsx src/scripts/cleanup-stale-anon-va.ts <org-slug>');
    process.exit(1);
  }

  const org = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM organisations WHERE slug = $1`,
    [slug],
  );

  if (!org) {
    console.error(`No organisation found with slug "${slug}"`);
    process.exit(1);
  }

  const accountRef = `anon_${org.id}`;
  console.log(`Expiring stale anonymous VA for "${org.name}" (${accountRef})...`);

  const expired = await vaNomba.expire(accountRef);
  console.log(expired ? 'Expired successfully.' : 'Nomba did not confirm expiry.');

  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message ?? err);
  process.exit(1);
});

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding development database...');

  const passwordHash = await bcrypt.hash('Password123!', 12);

  const admin = await prisma.user.upsert({
    where:  { email: 'admin@opsshield.io' },
    update: {},
    create: {
      email:    'admin@opsshield.io',
      passwordHash,
      firstName: 'Admin',
      lastName:  'User',
    },
  });

  const member = await prisma.user.upsert({
    where:  { email: 'member@opsshield.io' },
    update: {},
    create: {
      email:    'member@opsshield.io',
      passwordHash,
      firstName: 'Team',
      lastName:  'Member',
    },
  });

  const org = await prisma.organisation.upsert({
    where:  { slug: 'acme-corp-dev' },
    update: {},
    create: {
      name: 'Acme Corp',
      slug: 'acme-corp-dev',
      plan: 'FREE',
      members: {
        create: [
          { userId: admin.id,  role: 'ADMIN'  },
          { userId: member.id, role: 'MEMBER' },
        ]
      }
    },
  });

  await prisma.task.createMany({
    skipDuplicates: true,
    data: [
      {
        title:           'Set up cloud infrastructure',
        description:     'Provision VPC, ECS, and RDS via Terraform',
        status:          'IN_PROGRESS',
        requiresApproval: false,
        organisationId:  org.id,
        createdById:     admin.id,
        assignedToId:    member.id,
      },
      {
        title:           'Complete threat model',
        description:     'STRIDE threat model for all MVP features',
        status:          'AWAITING_APPROVAL',
        requiresApproval: true,
        organisationId:  org.id,
        createdById:     member.id,
        assignedToId:    admin.id,
      },
      {
        title:           'Integrate Paystack billing',
        description:     'Webhook handler, plan upgrade, billing history',
        status:          'PENDING',
        requiresApproval: false,
        organisationId:  org.id,
        createdById:     admin.id,
      },
    ]
  });

  console.log('Seed complete.');
  console.log('Admin:  admin@opsshield.io  / Password123!');
  console.log('Member: member@opsshield.io / Password123!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

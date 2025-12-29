import prisma from "../lib/prisma";
import bcrypt from "bcryptjs";

async function main() {
  const newPassword = "password123";
  const hashed = await bcrypt.hash(newPassword, 10);

  const result = await prisma.user.updateMany({
    data: { password: hashed },
  });

  console.log(`🔑 Updated ${result.count} users to new test password "${newPassword}"`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

 

//   npx ts-node src/jobs/resetPasswords.ts


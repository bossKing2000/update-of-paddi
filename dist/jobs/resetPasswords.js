"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = __importDefault(require("../lib/prisma"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
async function main() {
    const newPassword = "password123";
    const hashed = await bcryptjs_1.default.hash(newPassword, 10);
    const result = await prisma_1.default.user.updateMany({
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
    await prisma_1.default.$disconnect();
});
//   npx ts-node src/jobs/resetPasswords.ts

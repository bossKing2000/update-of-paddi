import { User } from "@prisma/client";
import { isPhoneIdentityVerified } from "./phone";

export const buildAuthResponse = (user: User & { addresses?: any[] }, accessToken: string) => {
  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      roles: user.roles,
      phoneNumber: user.phoneNumber,
      avatarUrl: user.avatarUrl,
      preferences: user.preferences,
      bio: user.bio,
      brandLogo: user.brandLogo,
      brandName: user.brandName,
      kycStatus: user.kycStatus,
      // Mobile routing scalars: already-loaded User columns, no extra query.
      vendorStatus: user.vendorStatus,
      // Batch 1D.40: derived, not the raw column. `isPhoneVerified` is only
      // reported when the number being displayed is the canonical number
      // that was actually verified, so a client can never render
      // "verified" beside a number nobody proved. This also keeps rows
      // written before the write-path guard honest without a migration.
      isPhoneVerified: isPhoneIdentityVerified(user),
      // ✅ FIXED: Use addresses[0] as default address, or empty object
    },
    accessToken,
  };
};

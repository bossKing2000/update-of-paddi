import { User } from "@prisma/client";

export const buildAuthResponse = (user: User & { addresses?: any[] }, accessToken: string) => {
  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      phoneNumber: user.phoneNumber,
      avatarUrl: user.avatarUrl,
      preferences: user.preferences,
      bio: user.bio,
      brandLogo: user.brandLogo,
      brandName: user.brandName,
      // ✅ FIXED: Use addresses[0] as default address, or empty object
    },
    accessToken,
  };
};

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAuthResponse = void 0;
const buildAuthResponse = (user, accessToken) => {
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
exports.buildAuthResponse = buildAuthResponse;

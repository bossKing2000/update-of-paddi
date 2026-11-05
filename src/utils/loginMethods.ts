// Which sign-in methods this application actually supports, and whether an
// account still has at least one of them.
//
// Every supported method maps to a concrete, checked condition — there is no
// generic "has a credential" shortcut, because a credential that the login
// path refuses (an unverified email, a Google account with no linked googleId)
// is not a usable login method and must not be counted as one.

export type LoginMethod = "LOCAL" | "GOOGLE" | "PHONE";

export interface LoginMethodState {
  /** Email + password, and /login only accepts it once the email is verified. */
  isEmailVerified?: boolean | null;
  password?: string | null;
  /** Set once a Google identity is linked; /google-login then works. */
  googleId?: string | null;
  /** Phase 1D.38 phone login requires a verified, canonically owned number. */
  isPhoneVerified?: boolean | null;
  phoneNumberE164?: string | null;
}

/**
 * The methods this account could actually sign in with right now.
 *
 * A verified phone alone counts: Phase 1D.38 adds phone login, so a user
 * whose email has never been verified is not locked out of their own account.
 */
export function usableLoginMethods(user: LoginMethodState): LoginMethod[] {
  const methods: LoginMethod[] = [];
  if (user.password && user.isEmailVerified) methods.push("LOCAL");
  if (user.googleId) methods.push("GOOGLE");
  if (user.isPhoneVerified && user.phoneNumberE164) methods.push("PHONE");
  return methods;
}

export function hasUsableLoginMethod(user: LoginMethodState): boolean {
  return usableLoginMethods(user).length > 0;
}
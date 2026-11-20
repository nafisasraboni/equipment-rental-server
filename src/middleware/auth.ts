import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Role, User } from "../types";
import { ApiError } from "../lib/errors";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyToken(req: Request, _res: Response, next: NextFunction) {
  const authorization = req.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "AUTH_REQUIRED", "Please sign in to continue.");
  const issuer = req.context.env.AUTH_ISSUER.replace(/\/$/, "");
  let keys = jwksByIssuer.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/api/auth/jwks`), { timeoutDuration: 7000 });
    jwksByIssuer.set(issuer, keys);
  }
  let subject: string;
  try {
    const { payload } = await jwtVerify(authorization.slice(7), keys, { issuer, audience: req.context.env.JWT_AUDIENCE, algorithms: ["EdDSA", "RS256", "ES256"] });
    if (!payload.sub) throw new Error("JWT subject missing");
    subject = payload.sub;
  } catch {
    throw new ApiError(401, "INVALID_TOKEN", "Your session has expired. Please sign in again.");
  }
  const user = await req.context.db.collection<User>("users").findOne({ _id: subject });
  if (!user) throw new ApiError(401, "USER_NOT_FOUND", "This account is no longer available.");
  if (user.status === "suspended") throw new ApiError(403, "ACCOUNT_SUSPENDED", "Your account is suspended. Contact an administrator.");
  req.user = user;
  next();
}

export function requireRoles(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!roles.includes(req.user.role)) throw new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
    next();
  };
}

export const verifyRenter = requireRoles("customer");
export const verifyOwner = requireRoles("owner");
export const verifyAdmin = requireRoles("admin");

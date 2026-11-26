import { compare, hash } from "npm:bcryptjs";

const ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return await hash(password, ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!password || !passwordHash) return false;
  try {
    return await compare(password, passwordHash);
  } catch {
    return false;
  }
}

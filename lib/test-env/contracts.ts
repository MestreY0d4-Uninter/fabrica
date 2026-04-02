import type { CanonicalStack } from "../intake/types.js";
import { familyForStack, type TestEnvironmentFamily } from "./bootstrap.js";

export type StackEnvironmentContract = {
  stack: CanonicalStack;
  family: TestEnvironmentFamily;
  version: string;
  requiresSharedToolchain: boolean;
};

export function resolveStackEnvironmentContract(stack: CanonicalStack): StackEnvironmentContract {
  const family = familyForStack(stack);
  if (family === "python") {
    return {
      stack,
      family,
      version: "python@v1",
      requiresSharedToolchain: true,
    };
  }

  return {
    stack,
    family,
    version: `${family}@v1`,
    requiresSharedToolchain: false,
  };
}

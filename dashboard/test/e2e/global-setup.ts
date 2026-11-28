import { clearServerErrors } from "./server-errors";

// Start each run with no server errors written down (test/e2e/server-errors.ts).
export default function globalSetup(): void {
  clearServerErrors(Number(process.env.E2E_PORT ?? 3100));
}

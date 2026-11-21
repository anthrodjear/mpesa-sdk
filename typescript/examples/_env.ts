/**
 * Read a required environment variable, or exit with a clear, value-free
 * message instead of passing `undefined` into Config (raw ConfigError).
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name} — check your environment`);
    process.exit(1);
  }
  return value;
}

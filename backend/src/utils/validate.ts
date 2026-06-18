const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(id: string): boolean {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

const ALLOWED_FILENAMES = new Set([
  'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'AGENTS.md',
  'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md',
]);

export function isAllowedFilename(name: string): boolean {
  return ALLOWED_FILENAMES.has(name);
}

export function sanitizeText(input: string): string {
  if (typeof input !== 'string') return '';
  return input.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

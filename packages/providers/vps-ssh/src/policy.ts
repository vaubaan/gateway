const READ_PATTERNS = [
  /^sudo\s+journalctl\b.*/,
  /^journalctl\b.*/,
  /^cat\s+[\w/.-]+$/,
  /^ls(\s+-[\w]+)*(\s+[\w/.-]+)?$/,
  /^tail(\s+-[\w]+(\s+\d+)?)*\s+[\w/.-]+$/,
  /^head(\s+-[\w]+(\s+\d+)?)*\s+[\w/.-]+$/,
  /^grep\s+/,
  /^pgrep\s+/,
  /^ps(\s+-[\w]+)?$/,
  /^docker\s+ps(\s+--[\w-]+([\s=]\S+)?)*$/,
  /^docker\s+inspect\s+\S+$/,
  /^docker\s+logs(\s+--[\w-]+([\s=]\S+)?)*\s+\S+$/,
  /^sudo\s+systemctl\s+(is-active|status|list-units)\b.*/,
  /^systemctl\s+(is-active|status|list-units)\b.*/,
  /^df(\s+-[\w]+)?$/,
  /^free(\s+-[\w]+)?$/,
  /^uptime$/,
  /^who$/,
  /^sudo\s+ss\s+-tlnp$/,
  /^ss\s+-tlnp$/,
  /^md5sum\s+\S+$/,
  /^stat\s+\S+$/,
];

export function isReadAllowed(cmd: string): boolean {
  return READ_PATTERNS.some((p) => p.test(cmd));
}

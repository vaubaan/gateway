import { Client } from 'ssh2';

export interface VpsSshBinding {
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key_pem: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  truncated: boolean;
}

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_S = 300;

function humanizeConnError(err: Error): Error {
  const msg = err.message ?? '';
  if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
    return new Error(`Connection refused — host unreachable or SSH not listening on that port.`);
  }
  if (msg.includes('Authentication') || msg.includes('auth')) {
    return new Error(`Authentication failed — check that the public key is in authorized_keys.`);
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
    return new Error(`Connection timed out — host may be unreachable.`);
  }
  return err;
}

export async function sshExec(
  binding: VpsSshBinding,
  cmd: string,
  timeout_s: number = 30,
): Promise<ExecResult> {
  const effectiveTimeout = Math.min(timeout_s, MAX_TIMEOUT_S);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        reject(new Error(`SSH command timed out after ${effectiveTimeout}s.`));
      }
    }, effectiveTimeout * 1000);

    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          settled = true;
          conn.end();
          reject(humanizeConnError(err));
          return;
        }

        stream.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_STDOUT_BYTES) {
            stdout += chunk.toString('utf8');
            if (stdout.length > MAX_STDOUT_BYTES) {
              truncated = true;
              stdout = stdout.slice(0, MAX_STDOUT_BYTES) + `\n[…truncated]`;
            }
          } else {
            truncated = true;
          }
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8').slice(0, 4096);
        });

        stream.on('close', (code: number) => {
          clearTimeout(timer);
          settled = true;
          conn.end();
          resolve({
            stdout,
            stderr,
            exit_code: code ?? -1,
            duration_ms: Date.now() - start,
            truncated,
          });
        });
      });
    });

    conn.on('error', (err: Error) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(humanizeConnError(err));
      }
    });

    conn.connect({
      host: binding.host_address,
      port: binding.port,
      username: binding.ssh_user,
      privateKey: binding.ssh_private_key_pem,
      readyTimeout: Math.min(effectiveTimeout * 1000, 10000),
    });
  });
}

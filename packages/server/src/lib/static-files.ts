import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface StaticFileOptions {
  root: string;
  prefix?: string;
  fallbackFile?: string;
}

export async function sendContainedStaticFile(
  req: FastifyRequest,
  reply: FastifyReply,
  options: StaticFileOptions,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  const root = resolve(options.root);
  const requestPath = parseRequestPath(req.url, options.prefix);
  if (requestPath === null) return false;

  const primary = resolveContainedPath(root, requestPath);
  const fallback = options.fallbackFile
    ? resolveContainedPath(root, options.fallbackFile)
    : null;

  const target = await firstReadableFile(primary, fallback);
  if (!target) return false;

  const fileStat = await stat(target);
  reply.header('Content-Type', contentTypeFor(target));
  reply.header('Content-Length', String(fileStat.size));
  reply.header('Cache-Control', target.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600');

  if (req.method === 'HEAD') {
    reply.send();
    return true;
  }

  reply.send(createReadStream(target));
  return true;
}

function parseRequestPath(rawUrl: string, prefix = '/'): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://agentforge.local').pathname;
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const normalizedPrefix = prefix.endsWith('/') && prefix.length > 1
    ? prefix.slice(0, -1)
    : prefix;

  if (normalizedPrefix !== '/' && pathname !== normalizedPrefix && !pathname.startsWith(`${normalizedPrefix}/`)) {
    return null;
  }

  const stripped = normalizedPrefix === '/'
    ? pathname
    : pathname.slice(normalizedPrefix.length) || '/';

  return stripped === '/' ? 'index.html' : stripped.replace(/^\/+/, '');
}

function resolveContainedPath(root: string, requestPath: string): string | null {
  const target = resolve(root, requestPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return null;
  }
  return target;
}

async function firstReadableFile(...paths: Array<string | null>): Promise<string | null> {
  for (const path of paths) {
    if (!path) continue;
    try {
      const fileStat = await stat(path);
      if (fileStat.isFile()) return path;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

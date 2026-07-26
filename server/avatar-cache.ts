import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveRoom } from '../src/types';

const maxAvatarBytes = 3 * 1024 * 1024;

function extensionFor(contentType: string): string | undefined {
  if (contentType.includes('image/jpeg')) return 'jpg';
  if (contentType.includes('image/png')) return 'png';
  if (contentType.includes('image/webp')) return 'webp';
  if (contentType.includes('image/gif')) return 'gif';
  return undefined;
}

export type AvatarCache = {
  cache(room: LiveRoom, url: string): Promise<string | undefined>;
};

/** 将页面实际展示的公开头像复制到本地房间目录，避免依赖会过期的 CDN 链接。 */
export class LocalAvatarCache implements AvatarCache {
  constructor(private readonly dataDirectory: string) {}

  async cache(room: LiveRoom, url: string): Promise<string | undefined> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: 'https://live.douyin.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136 Safari/537.36',
        },
      });
      const extension = extensionFor(response.headers.get('content-type')?.toLocaleLowerCase() ?? '');
      if (!response.ok || !extension) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > maxAvatarBytes) return undefined;
      const digest = createHash('sha256').update(url).digest('hex').slice(0, 24);
      const relativeFile = join('saves', room.id, 'avatars', `${digest}.${extension}`);
      const filePath = join(this.dataDirectory, relativeFile);
      await mkdir(join(this.dataDirectory, 'saves', room.id, 'avatars'), { recursive: true });
      await writeFile(filePath, bytes);
      return relativeFile;
    } catch {
      return undefined;
    }
  }
}

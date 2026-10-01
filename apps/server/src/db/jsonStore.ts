import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Küçük bir JSON dosyası üzerinde kalıcı durum. Yazmalar birleştirilir (debounce) ve
 * atomik yapılır (geçici dosyaya yaz → yeniden adlandır), böylece çökme anında dosya bozulmaz.
 */
export class JsonStore<T> {
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;

  constructor(
    dataDir: string,
    file: string,
    private readonly delayMs = 500,
  ) {
    this.path = join(dataDir, file);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  load(fallback: T): T {
    if (!existsSync(this.path)) return fallback;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as T;
    } catch (err) {
      console.error(`[db] ${this.path} okunamadı, varsayılan kullanılıyor:`, (err as Error).message);
      return fallback;
    }
  }

  /** `getData` yazma anında çağrılır, böylece en güncel durum kaydedilir. */
  scheduleSave(getData: () => T): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow(getData());
    }, this.delayMs);
  }

  writeNow(data: T): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }

  flush(getData: () => T): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.writeNow(getData());
    }
  }
}

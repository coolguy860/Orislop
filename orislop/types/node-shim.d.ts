declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  cwd(): string;
};

declare module "node:fs" {
  export function existsSync(path: string): boolean;
}

declare module "node:fs/promises" {
  export function cp(source: string, destination: string, options?: Record<string, unknown>): Promise<void>;
  export function mkdir(path: string, options?: Record<string, unknown>): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  export function rm(path: string, options?: Record<string, unknown>): Promise<void>;
  export function writeFile(path: string, data: string, encoding?: BufferEncoding): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;

  const pathModule: {
    basename: typeof basename;
    dirname: typeof dirname;
    isAbsolute: typeof isAbsolute;
    join: typeof join;
    resolve: typeof resolve;
  };
  export default pathModule;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

type BufferEncoding = "utf8" | "utf-8";

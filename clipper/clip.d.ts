// Types for clip.js (plain JavaScript, so the extension loads without a build), for the tests.
export interface Clip {
  kind: "page" | "selection" | "image";
  url: string;
  title?: string;
  selection?: string;
  image?: Blob;
  imageName?: string;
}
export interface ClipSettings {
  server?: string;
  token?: string;
}
export function quoteFor(selection: string, title: string, url: string): string;
export function formFor(clip: Clip): FormData;
export function send(settings: ClipSettings, clip: Clip, fetcher?: (url: URL, init: RequestInit) => Promise<Response>): Promise<{ ok: boolean; message: string }>;

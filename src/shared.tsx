import { Clipboard } from "@raycast/api";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImageUris {
  small: string;
  normal: string;
  large: string;
  png: string;
  art_crop: string;
  border_crop: string;
}

export interface CardFace {
  name: string;
  image_uris?: ImageUris;
  mana_cost?: string;
  oracle_text?: string;
  flavor_text?: string;
}

export interface Card {
  id: string;
  name: string;
  set: string;
  collector_number: string;
  scryfall_uri: string;
  prints_search_uri?: string;
  image_uris?: ImageUris;
  card_faces?: CardFace[];
  type_line?: string;
  mana_cost?: string;
  oracle_text?: string;
  flavor_text?: string;
  set_name?: string;
  edhrec_rank?: number;
  prices?: { usd?: string; usd_foil?: string };
}

export interface ScryfallSearchResponse {
  object: string;
  data: Card[];
  total_cards: number;
  has_more: boolean;
  next_page?: string;
}

export type SortOrder = "name" | "edhrec" | "usd";

export interface ScryfallError extends Error {
  status?: number;
  scryfallCode?: string;
}

// ─── Scryfall fetch helpers ───────────────────────────────────────────────────
//
// useFetch's default parser throws `new Error(response.statusText)` on any
// non-2xx response, which loses the HTTP status. Scryfall returns 404 when a
// (valid) query matches no cards and 400 when the query syntax is incomplete —
// both happen constantly while the user is mid-typing (e.g. "c:", "cmc<=").
// This parser preserves the status (and Scryfall's own error code/details) so
// callers can silently ignore those expected cases instead of flashing a toast.

export async function parseScryfallResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  let details: string | undefined;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { details?: string; code?: string };
    details = body.details;
    code = body.code;
  } catch {
    // Non-JSON error body — fall back to statusText below.
  }

  const err = new Error(details ?? response.statusText) as ScryfallError;
  err.status = response.status;
  err.scryfallCode = code;
  throw err;
}

/**
 * True for the "expected while typing" Scryfall errors: 404 (no cards matched)
 * and 400 (incomplete/invalid query syntax). These should not surface a toast.
 */
export function isExpectedSearchError(err: Error): boolean {
  const status = (err as ScryfallError).status;
  return status === 404 || status === 400;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const FEEDBACK_URL = "https://github.com/aayushpi/scrycast/issues";
export const SAVED_CARDS_KEY = "savedCards";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getCardImageUri(card: Card, size: keyof ImageUris = "png"): string {
  if (card.image_uris?.[size]) return card.image_uris[size];
  if (card.card_faces?.[0]?.image_uris?.[size]) return card.card_faces[0].image_uris[size];
  const fallback = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? "";
  if (fallback) {
    console.warn(`[Scrycast] ${size} unavailable for "${card.name}" (${card.id}), falling back to normal`);
  } else {
    console.error(`[Scrycast] No image URI found for card "${card.name}" (${card.id})`, card);
  }
  return fallback;
}

export function getTaggerUrl(card: Card): string {
  return `https://tagger.scryfall.com/card/${card.set}/${card.collector_number}`;
}

export function getEdhrecUrl(cardName: string): string {
  return `https://edhrec.com/cards/${cardName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, "-")}`;
}

export function scryfallMultiUrl(cards: Card[]): string {
  const query = cards.map((c) => `!"${c.name}"`).join(" OR ");
  return `https://scryfall.com/search?q=${encodeURIComponent(query)}`;
}

export function sortCards(cards: Card[], order: SortOrder): Card[] {
  return [...cards].sort((a, b) => {
    if (order === "name") return a.name.localeCompare(b.name);
    if (order === "edhrec") {
      const ra = a.edhrec_rank ?? Infinity;
      const rb = b.edhrec_rank ?? Infinity;
      return ra - rb;
    }
    const pa = Math.max(parseFloat(a.prices?.usd ?? "0"), parseFloat(a.prices?.usd_foil ?? "0"));
    const pb = Math.max(parseFloat(b.prices?.usd ?? "0"), parseFloat(b.prices?.usd_foil ?? "0"));
    return pb - pa;
  });
}

export async function copyCardImage(imageUri: string): Promise<void> {
  const response = await fetch(imageUri);
  if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  const tmpPath = join(tmpdir(), `scrycast-${Date.now()}.png`);
  await writeFile(tmpPath, buffer);
  await Clipboard.copy({ file: tmpPath });
}

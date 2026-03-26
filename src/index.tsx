import { Grid, List, ActionPanel, Action, showToast, Toast, Color, Icon, Clipboard } from "@raycast/api";
import { useState, useMemo, useEffect } from "react";
import { useFetch, usePromise } from "@raycast/utils";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImageUris {
  small: string;
  normal: string;
  large: string;
  png: string;
  art_crop: string;
  border_crop: string;
}

interface CardFace {
  name: string;
  image_uris?: ImageUris;
}

interface Card {
  id: string;
  name: string;
  set: string;
  collector_number: string;
  scryfall_uri: string;
  image_uris?: ImageUris;
  card_faces?: CardFace[];
  type_line?: string;
  set_name?: string;
  edhrec_rank?: number;
  prices?: { usd?: string; usd_foil?: string };
}

interface ScryfallSearchResponse {
  object: string;
  data: Card[];
  total_cards: number;
  has_more: boolean;
  next_page?: string;
}

interface Tagging {
  tag: {
    name: string;
    type: "ORACLE_CARD_TAG" | "ILLUSTRATION_TAG" | string;
  };
}

interface TaggerResponse {
  data?: { card?: { taggings: Tagging[] } };
  errors?: Array<{ message: string }>;
}

type SortOrder = "name" | "edhrec" | "usd";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCardImageUri(card: Card, size: keyof ImageUris = "png"): string {
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

function getTaggerUrl(card: Card): string {
  return `https://tagger.scryfall.com/card/${card.set}/${card.collector_number}`;
}


// Sort locally so order changes never trigger a re-fetch
function sortCards(cards: Card[], order: SortOrder): Card[] {
  return [...cards].sort((a, b) => {
    if (order === "name") {
      return a.name.localeCompare(b.name); // A → Z
    }
    if (order === "edhrec") {
      // Lower rank number = more popular; nulls go last
      const ra = a.edhrec_rank ?? Infinity;
      const rb = b.edhrec_rank ?? Infinity;
      return ra - rb;
    }
    // usd: higher price first; nulls go last
    const pa = parseFloat(a.prices?.usd ?? "-1");
    const pb = parseFloat(b.prices?.usd ?? "-1");
    return pb - pa;
  });
}

async function copyCardImage(imageUri: string): Promise<void> {
  const response = await fetch(imageUri);
  if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  const tmpPath = join(tmpdir(), `scrycast-${Date.now()}.png`);
  await writeFile(tmpPath, buffer);
  await Clipboard.copy({ file: tmpPath });
}

function scryfallMultiUrl(cards: Card[]): string {
  const query = cards.map((c) => `!"${c.name}"`).join(" OR ");
  return `https://scryfall.com/search?q=${encodeURIComponent(query)}`;
}

const FEEDBACK_URL = "https://github.com/aayushpi/scrycast/issues";

// ─── Tagger API ───────────────────────────────────────────────────────────────

async function fetchCardTags(set: string, collectorNumber: string): Promise<Tagging[]> {
  const cardUrl = `https://tagger.scryfall.com/card/${set}/${collectorNumber}`;

  console.log(`[Scrycast] Fetching tagger page for ${set}/${collectorNumber}`);
  const pageResponse = await fetch(cardUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!pageResponse.ok) {
    console.error(`[Scrycast] Tagger page returned ${pageResponse.status} for ${cardUrl}`);
    throw new Error(`Tagger page unavailable (${pageResponse.status})`);
  }

  const html = await pageResponse.text();
  const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!csrfMatch) {
    console.error("[Scrycast] CSRF token not found. Page excerpt:", html.slice(0, 500));
    throw new Error("Could not find CSRF token on tagger page");
  }

  const csrfToken = csrfMatch[1];
  const setCookies: string[] =
    typeof (pageResponse.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (pageResponse.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [pageResponse.headers.get("set-cookie") ?? ""];

  const cookieHeader = setCookies
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");

  console.log(`[Scrycast] CSRF acquired (${csrfToken.slice(0, 12)}…), cookies: ${cookieHeader.slice(0, 60)}…`);

  const gqlResponse = await fetch("https://tagger.scryfall.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: cookieHeader,
      Origin: "https://tagger.scryfall.com",
      Referer: cardUrl,
    },
    body: JSON.stringify({
      query: `query {
        card: cardBySet(set: ${JSON.stringify(set)}, number: ${JSON.stringify(collectorNumber)}) {
          taggings { tag { name type } }
        }
      }`,
    }),
  });

  if (!gqlResponse.ok) {
    const body = await gqlResponse.text();
    console.error(`[Scrycast] GraphQL ${gqlResponse.status}:`, body);
    throw new Error(`GraphQL request failed (${gqlResponse.status})`);
  }

  const result = (await gqlResponse.json()) as TaggerResponse;

  if (result.errors?.length) {
    console.error("[Scrycast] GraphQL errors:", JSON.stringify(result.errors, null, 2));
    throw new Error(result.errors[0]?.message ?? "GraphQL error");
  }

  const taggings: Tagging[] = result.data?.card?.taggings ?? [];
  console.log(`[Scrycast] ${taggings.length} tags returned for ${set}/${collectorNumber}`);
  return taggings;
}

// ─── Card Tags View ───────────────────────────────────────────────────────────

function tagSearchQuery(type: string, name: string): string {
  if (type === "ORACLE_CARD_TAG") return `oracletag:"${name}"`;
  if (type === "ILLUSTRATION_TAG") return `arttag:"${name}"`;
  return `"${name}"`;
}

function CardTagsView({ card }: { card: Card }) {
  // Use the normal variant (488×680px)
  const imageUri = getCardImageUri(card, "normal");

  const {
    isLoading,
    data: taggings,
    error,
  } = usePromise(() => fetchCardTags(card.set, card.collector_number), [], {
    onError: (err) => {
      console.error("[Scrycast] fetchCardTags failed:", err.message, "\nStack:", err.stack);
      showToast({ style: Toast.Style.Failure, title: "Failed to load tags", message: err.message });
    },
  });

  const oracleTags = (taggings ?? []).filter((t) => t.tag.type === "ORACLE_CARD_TAG");
  const artTags = (taggings ?? []).filter((t) => t.tag.type === "ILLUSTRATION_TAG");
  const otherTags = (taggings ?? []).filter(
    (t) => t.tag.type !== "ORACLE_CARD_TAG" && t.tag.type !== "ILLUSTRATION_TAG"
  );

  const cardDetail = <List.Item.Detail markdown={`![${card.name}](${imageUri})`} />;

  function tagItem(t: Tagging, color: Color) {
    const query = tagSearchQuery(t.tag.type, t.tag.name);
    return (
      <List.Item
        key={t.tag.name}
        title={t.tag.name}
        icon={{ source: Icon.Tag, tintColor: color }}
        detail={cardDetail}
        actions={
          <ActionPanel>
            <Action.Push
              title="Search This Tag"
              icon={Icon.MagnifyingGlass}
              target={<Command initialSearch={query} />}
            />
            <Action.OpenInBrowser
              title="Open in Scryfall Tagger"
              url={getTaggerUrl(card)}
              icon={{ source: Icon.Tag, tintColor: Color.Orange }}
            />
            <Action.OpenInBrowser
              title="Open in Scryfall"
              url={card.scryfall_uri}
              icon={{ source: Icon.Globe, tintColor: Color.Blue }}
            />
            <ActionPanel.Section title="Feedback">
              <Action.OpenInBrowser
                title="Submit Bug or Feature Request"
                url={FEEDBACK_URL}
                icon={Icon.Bug}
              />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List navigationTitle={`${card.name} — Tags`} isLoading={isLoading} isShowingDetail>
      {!isLoading && taggings?.length === 0 && !error && (
        <List.EmptyView icon="🪄" title="No Tags Found" description="This card has no tagger entries yet." />
      )}
      {oracleTags.length > 0 && (
        <List.Section title="Oracle Tags">{oracleTags.map((t) => tagItem(t, Color.Blue))}</List.Section>
      )}
      {artTags.length > 0 && (
        <List.Section title="Art Tags">{artTags.map((t) => tagItem(t, Color.Purple))}</List.Section>
      )}
      {otherTags.length > 0 && (
        <List.Section title="Other Tags">{otherTags.map((t) => tagItem(t, Color.SecondaryText))}</List.Section>
      )}
    </List>
  );
}

// ─── Main Search View ─────────────────────────────────────────────────────────

export default function Command({ initialSearch = "" }: { initialSearch?: string }) {
  const [searchText, setSearchText] = useState(initialSearch);
  const [order, setOrder] = useState<SortOrder>("name");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Clear selection whenever the search query changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [searchText]);

  // Fetch without &order — we sort locally so order changes never re-fetch
  const { isLoading, data } = useFetch<ScryfallSearchResponse>(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(searchText)}&unique=cards`,
    {
      execute: searchText.trim().length > 0,
      keepPreviousData: true,
      onError: (err) => {
        const isNotFound = err.message.includes("404") || err.message.includes("No cards found");
        if (!isNotFound) {
          console.error("[Scrycast] Search error:", err.message, "\nStack:", err.stack);
          showToast({ style: Toast.Style.Failure, title: "Search failed", message: err.message });
        } else {
          console.log(`[Scrycast] No results for query: "${searchText}"`);
        }
      },
    }
  );

  // Sort locally — instant for ≤175 cards, no extra network requests
  const cards = useMemo(() => sortCards(data?.data ?? [], order), [data, order]);

  const hasResults = cards.length > 0;
  const isSearching = isLoading && searchText.trim().length > 0 && !hasResults;
  const selectedCards = cards.filter((c) => selectedIds.has(c.id));
  // Show selection mode as soon as anything is selected so the user gets immediate feedback
  const isMultiSelect = selectedIds.size >= 1;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Grid
      columns={4}
      aspectRatio="2/3"
      fit={Grid.Fit.Fill}
      inset={Grid.Inset.Small}
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder='Search cards — try "t:creature c:red cmc<=3" or just a card name'
      throttle
      searchBarAccessory={
        <Grid.Dropdown tooltip="Sort Order" value={order} onChange={(v) => setOrder(v as SortOrder)}>
          <Grid.Dropdown.Item title="Name (A → Z)" value="name" />
          <Grid.Dropdown.Item title="EDHRec Rank (High → Low)" value="edhrec" />
          <Grid.Dropdown.Item title="Price (High → Low)" value="usd" />
        </Grid.Dropdown>
      }
    >
      {isSearching ? (
        <Grid.EmptyView icon="🪄" title="Searching…" description={`Looking up "${searchText}"`} />
      ) : !hasResults ? (
        <Grid.EmptyView
          icon="🪄"
          title={searchText.trim() ? "No Cards Found" : "Search Scryfall"}
          description={
            searchText.trim()
              ? `No cards match "${searchText}". Try different Scryfall syntax.`
              : 'Type a card name or Scryfall syntax to find cards — e.g. "t:dragon pow>=5"'
          }
        />
      ) : (
        <Grid.Section
          title={
            selectedIds.size > 0
              ? `${selectedIds.size} selected · ${data?.total_cards?.toLocaleString() ?? cards.length} results`
              : `${data?.total_cards?.toLocaleString() ?? cards.length} result${(data?.total_cards ?? 0) !== 1 ? "s" : ""}`
          }
          subtitle={data?.has_more ? "Showing first 175 — refine your search to narrow results" : undefined}
        >
          {cards.map((card) => {
            const imageUri = getCardImageUri(card);
            const isSelected = selectedIds.has(card.id);

            return (
              <Grid.Item
                key={card.id}
                content={{ source: imageUri }}
                title={isSelected ? `✓ ${card.name}` : card.name}
                subtitle={card.set_name}
                actions={
                  <ActionPanel>
                    {isMultiSelect ? (
                      <ActionPanel.Section title={`${selectedIds.size} cards selected`}>
                        <Action.CopyToClipboard
                          title="Copy Card Names"
                          content={selectedCards.map((c) => c.name).join("\n")}
                          icon={Icon.Clipboard}
                        />
                        <Action.OpenInBrowser
                          title="Show in Scryfall"
                          url={scryfallMultiUrl(selectedCards)}
                          icon={{ source: Icon.Globe, tintColor: Color.Blue }}
                        />
                        <Action
                          title={isSelected ? "Deselect Card" : "Select Card"}
                          icon={isSelected ? Icon.XMarkCircle : Icon.Checkmark}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                          onAction={() => toggleSelect(card.id)}
                        />
                        <Action
                          title="Clear Selection"
                          icon={Icon.Trash}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
                          onAction={() => setSelectedIds(new Set())}
                        />
                      </ActionPanel.Section>
                    ) : (
                      <ActionPanel.Section title={card.name}>
                        <Action.OpenInBrowser
                          title="Open in Scryfall"
                          url={card.scryfall_uri}
                          icon={{ source: Icon.Globe, tintColor: Color.Blue }}
                        />
                        <Action.Push
                          title="Show Tags"
                          target={<CardTagsView card={card} />}
                          icon={{ source: Icon.Tag, tintColor: Color.Purple }}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
                        />
                        <Action.CopyToClipboard
                          title="Copy Card Name"
                          content={card.name}
                          shortcut={{ modifiers: ["cmd"], key: "c" }}
                          icon={Icon.Clipboard}
                        />
                        <Action.OpenInBrowser
                          title="Open in Scryfall Tagger"
                          url={getTaggerUrl(card)}
                          icon={{ source: Icon.Tag, tintColor: Color.Orange }}
                          shortcut={{ modifiers: ["cmd"], key: "t" }}
                        />
                        <Action
                          title="Copy Card Image"
                          icon={Icon.Image}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                          onAction={async () => {
                            const toast = await showToast({ style: Toast.Style.Animated, title: "Copying image…" });
                            try {
                              await copyCardImage(imageUri);
                              toast.style = Toast.Style.Success;
                              toast.title = "Image copied";
                            } catch (err) {
                              console.error("[Scrycast] copyCardImage failed:", (err as Error).message);
                              toast.style = Toast.Style.Failure;
                              toast.title = "Failed to copy image";
                              toast.message = (err as Error).message;
                            }
                          }}
                        />
                        <Action
                          title={isSelected ? "Deselect Card" : "Select Card"}
                          icon={isSelected ? Icon.XMarkCircle : Icon.Checkmark}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                          onAction={() => toggleSelect(card.id)}
                        />
                      </ActionPanel.Section>
                    )}
                    <ActionPanel.Section title="Feedback">
                      <Action.OpenInBrowser
                        title="Submit Bug or Feature Request"
                        url={FEEDBACK_URL}
                        icon={Icon.Bug}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </Grid.Section>
      )}
    </Grid>
  );
}

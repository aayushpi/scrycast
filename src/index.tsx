import { Grid, ActionPanel, Action, showToast, Toast, Color, Icon, Detail } from "@raycast/api";
import { useState } from "react";
import { useFetch, usePromise } from "@raycast/utils";

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
  mana_cost?: string;
  set_name?: string;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCardImageUri(card: Card): string {
  // Use png: transparent, rounded full card at 745×1040 (https://scryfall.com/docs/api/images)
  if (card.image_uris?.png) return card.image_uris.png;
  if (card.card_faces?.[0]?.image_uris?.png) return card.card_faces[0].image_uris.png;

  const fallback = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? "";
  if (fallback) {
    console.warn(`[Scrycast] PNG unavailable for "${card.name}" (${card.id}), falling back to normal`);
  } else {
    console.error(`[Scrycast] No image URI found for card "${card.name}" (${card.id})`, card);
  }
  return fallback;
}

function getTaggerUrl(card: Card): string {
  return `https://tagger.scryfall.com/card/${card.set}/${card.collector_number}`;
}

// ─── Tagger API ───────────────────────────────────────────────────────────────

async function fetchCardTags(set: string, collectorNumber: string): Promise<Tagging[]> {
  const cardUrl = `https://tagger.scryfall.com/card/${set}/${collectorNumber}`;

  // Step 1: load the page to get a session cookie + CSRF token
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

  // Node 18+ exposes getSetCookie() for proper multi-cookie parsing
  const setCookies: string[] =
    typeof (pageResponse.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (pageResponse.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [pageResponse.headers.get("set-cookie") ?? ""];

  const cookieHeader = setCookies
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");

  console.log(
    `[Scrycast] CSRF acquired (${csrfToken.slice(0, 12)}…), cookies: ${cookieHeader.slice(0, 60)}…`
  );

  // Step 2: query the GraphQL endpoint
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

// ─── Card Tags Detail View ────────────────────────────────────────────────────

function CardTagsView({ card }: { card: Card }) {
  const imageUri = getCardImageUri(card);

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

  return (
    <Detail
      navigationTitle={`${card.name} — Tags`}
      isLoading={isLoading}
      markdown={`![${card.name}](${imageUri})`}
      metadata={
        <Detail.Metadata>
          {oracleTags.length > 0 && (
            <Detail.Metadata.TagList title="Oracle Tags">
              {oracleTags.map((t) => (
                <Detail.Metadata.TagList.Item key={t.tag.name} text={t.tag.name} color={Color.Blue} />
              ))}
            </Detail.Metadata.TagList>
          )}
          {artTags.length > 0 && (
            <>
              {oracleTags.length > 0 && <Detail.Metadata.Separator />}
              <Detail.Metadata.TagList title="Art Tags">
                {artTags.map((t) => (
                  <Detail.Metadata.TagList.Item key={t.tag.name} text={t.tag.name} color={Color.Purple} />
                ))}
              </Detail.Metadata.TagList>
            </>
          )}
          {otherTags.length > 0 && (
            <>
              <Detail.Metadata.Separator />
              <Detail.Metadata.TagList title="Other Tags">
                {otherTags.map((t) => (
                  <Detail.Metadata.TagList.Item key={t.tag.name} text={t.tag.name} />
                ))}
              </Detail.Metadata.TagList>
            </>
          )}
          {!isLoading && taggings?.length === 0 && !error && (
            <Detail.Metadata.Label title="Tags" text="No tags found for this card" />
          )}
          {error && (
            <Detail.Metadata.Label title="Error" text={error.message} icon={Icon.ExclamationMark} />
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
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
        </ActionPanel>
      }
    />
  );
}

// ─── Main Search View ─────────────────────────────────────────────────────────

export default function Command() {
  const [searchText, setSearchText] = useState("");

  const { isLoading, data } = useFetch<ScryfallSearchResponse>(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(searchText)}&order=name&unique=cards`,
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

  const cards = data?.data ?? [];
  const hasResults = cards.length > 0;
  const isSearching = isLoading && searchText.trim().length > 0 && !hasResults;

  return (
    <Grid
      columns={4}
      aspectRatio="2/3"
      fit={Grid.Fit.Fill}
      inset={Grid.Inset.Small}
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder='Search cards — try "t:creature c:red cmc<=3" or just a card name'
      throttle
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
          title={`${data?.total_cards?.toLocaleString() ?? cards.length} result${(data?.total_cards ?? 0) !== 1 ? "s" : ""}`}
          subtitle={data?.has_more ? "Showing first 175 — refine your search to narrow results" : undefined}
        >
          {cards.map((card) => {
            const imageUri = getCardImageUri(card);
            const taggerUrl = getTaggerUrl(card);

            return (
              <Grid.Item
                key={card.id}
                content={{ source: imageUri }}
                title={card.name}
                subtitle={card.set_name}
                actions={
                  <ActionPanel>
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
                        url={taggerUrl}
                        icon={{ source: Icon.Tag, tintColor: Color.Orange }}
                        shortcut={{ modifiers: ["cmd"], key: "t" }}
                      />
                      <Action.CopyToClipboard
                        title="Copy Card Image URL"
                        content={imageUri}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                        icon={Icon.Image}
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

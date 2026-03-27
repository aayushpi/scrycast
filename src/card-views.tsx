import { List, Detail, ActionPanel, Action, showToast, Toast, Color, Icon } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import {
  Card,
  FEEDBACK_URL,
  getCardImageUri,
  getTaggerUrl,
  getEdhrecUrl,
} from "./shared";

// ─── Tagger API ───────────────────────────────────────────────────────────────

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
    throw new Error(`Tagger page unavailable (${pageResponse.status})`);
  }

  const html = await pageResponse.text();
  const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!csrfMatch) throw new Error("Could not find CSRF token on tagger page");

  const csrfToken = csrfMatch[1];
  const setCookies: string[] =
    typeof (pageResponse.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (pageResponse.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [pageResponse.headers.get("set-cookie") ?? ""];

  const cookieHeader = setCookies
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");

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
  if (result.errors?.length) throw new Error(result.errors[0]?.message ?? "GraphQL error");

  const taggings: Tagging[] = result.data?.card?.taggings ?? [];
  console.log(`[Scrycast] ${taggings.length} tags returned for ${set}/${collectorNumber}`);
  return taggings;
}

// ─── Card Tags View ───────────────────────────────────────────────────────────

function tagScryfallSearchUrl(type: string, name: string): string {
  if (type === "ORACLE_CARD_TAG") return `https://scryfall.com/search?q=oracletag%3A"${encodeURIComponent(name)}"`;
  if (type === "ILLUSTRATION_TAG") return `https://scryfall.com/search?q=arttag%3A"${encodeURIComponent(name)}"`;
  return `https://scryfall.com/search?q="${encodeURIComponent(name)}"`;
}

export interface CardTagsViewProps {
  card: Card;
  // When provided, "Search This Tag" pushes in-app; otherwise opens Scryfall in browser.
  searchTagTarget?: (query: string) => JSX.Element;
}

function tagSearchQuery(type: string, name: string): string {
  if (type === "ORACLE_CARD_TAG") return `oracletag:"${name}"`;
  if (type === "ILLUSTRATION_TAG") return `arttag:"${name}"`;
  return `"${name}"`;
}

export function CardTagsView({ card, searchTagTarget }: CardTagsViewProps) {
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

  const cardDetail = <List.Item.Detail markdown={`<img src="${imageUri}" width="366" />`} />;

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
            {searchTagTarget ? (
              <>
                <Action.Push title="Search This Tag" icon={Icon.MagnifyingGlass} target={searchTagTarget(query)} />
                <Action.OpenInBrowser
                  title="Search This Tag on Scryfall"
                  icon={{ source: Icon.Globe, tintColor: Color.Blue }}
                  url={tagScryfallSearchUrl(t.tag.type, t.tag.name)}
                  shortcut={{ modifiers: ["cmd"], key: "return" }}
                />
              </>
            ) : (
              <Action.OpenInBrowser
                title="Search This Tag on Scryfall"
                icon={Icon.MagnifyingGlass}
                url={tagScryfallSearchUrl(t.tag.type, t.tag.name)}
              />
            )}
            <Action.OpenInBrowser
              title="Open in Scryfall Tagger"
              url={getTaggerUrl(card)}
              icon={{ source: Icon.Tag, tintColor: Color.Orange }}
              shortcut={{ modifiers: ["cmd"], key: "t" }}
            />
            <ActionPanel.Section title="Feedback">
              <Action.OpenInBrowser title="Submit Bug or Feature Request" url={FEEDBACK_URL} icon={Icon.Bug} />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List navigationTitle={`${card.name} — Tags`} isLoading={isLoading} isShowingDetail>
      {!isLoading && error && (
        <List.EmptyView icon={Icon.ExclamationMark} title="Could Not Load Tags" description={error.message} />
      )}
      {!isLoading && !error && taggings?.length === 0 && (
        <List.EmptyView icon="🧙" title="No Tags Found" description="This card has no tagger entries yet." />
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

// ─── Card Detail View ─────────────────────────────────────────────────────────

export interface CardDetailViewProps {
  card: Card;
  searchTagTarget?: (query: string) => JSX.Element;
}

export function CardDetailView({ card, searchTagTarget }: CardDetailViewProps) {
  const imageUri = getCardImageUri(card, "large");

  const oracleText =
    card.oracle_text ??
    card.card_faces?.map((f) => `<strong>${f.name}</strong>\n${f.oracle_text ?? ""}`).join("\n");
  const flavorText =
    card.flavor_text ??
    card.card_faces?.map((f) => f.flavor_text).filter(Boolean).join(" // ");
  const manaCost =
    card.mana_cost ?? card.card_faces?.map((f) => f.mana_cost).filter(Boolean).join(" // ");

  const markdown = `<img src="${imageUri}" width="504" />`;
  const oracleLines = oracleText?.split("\n").filter(Boolean) ?? [];

  return (
    <Detail
      navigationTitle={card.name}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Name" text={card.name} />
          {card.type_line && <Detail.Metadata.Label title="Type" text={card.type_line} />}
          {manaCost && <Detail.Metadata.Label title="Mana Cost" text={manaCost} />}
          {oracleLines.length > 0 && (
            <>
              {oracleLines.map((line, i) => (
                <Detail.Metadata.Label key={i} title={i === 0 ? "Oracle Text" : ""} text={line} />
              ))}
            </>
          )}
          {flavorText && <Detail.Metadata.Label title="Flavor Text" text={flavorText} />}
          <Detail.Metadata.Separator />
          <Detail.Metadata.Link title="Scryfall" target={card.scryfall_uri} text="View on Scryfall" />
          <Detail.Metadata.Link title="EDHRec" target={getEdhrecUrl(card.name)} text="View on EDHRec" />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.OpenInBrowser
            title="Open in Scryfall"
            url={card.scryfall_uri}
            icon={{ source: Icon.Globe, tintColor: Color.Blue }}
            shortcut={{ modifiers: ["cmd"], key: "return" }}
          />
          <Action.OpenInBrowser
            title="Open in EDHRec"
            url={getEdhrecUrl(card.name)}
            icon={{ source: Icon.Person, tintColor: Color.Green }}
            shortcut={{ modifiers: ["cmd", "ctrl"], key: "return" }}
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
          <Action.Push
            title="Show Tags"
            target={<CardTagsView card={card} searchTagTarget={searchTagTarget} />}
            icon={{ source: Icon.Tag, tintColor: Color.Purple }}
            shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
          />
          <ActionPanel.Section title="Feedback">
            <Action.OpenInBrowser title="Submit Bug or Feature Request" url={FEEDBACK_URL} icon={Icon.Bug} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

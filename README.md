# Scrycast

Search Magic: The Gathering cards using [Scryfall's](https://scryfall.com) powerful syntax, right from Raycast.

## Commands

### Search Cards
Search the full Scryfall card database. Supports all Scryfall syntax — type a card name or use filters like `t:creature c:red cmc<=3`.

**Actions on a card:**
- **Enter** — Show card details (image, oracle text, mana cost, type, flavor text)
- **⌘↵** — Open in Scryfall
- **⌘⌃↵** — Open in EDHRec
- **⌘C** — Copy card name
- **⌘⇧C** — Copy card image
- **⌘B** — Save / Remove from Saved
- **⌘T** — Open in Scryfall Tagger
- **⌘⇧T** — Show tags (oracle tags and art tags from Scryfall Tagger)
- **⌘⇧S** — Select card (for multi-select)

**Multi-select:**
Select multiple cards with **⌘⇧S**, then copy all names or open a combined Scryfall search.

**Sort:** Use the dropdown to sort results by name, EDHRec rank, or price.

### View Saved Cards
Browse cards you've saved from Search Cards. All the same actions are available, plus **⌘B** to remove a card from your collection.

## Tags

The tags view pulls oracle tags and art tags from [Scryfall Tagger](https://tagger.scryfall.com). Press **Enter** on any tag to search for other cards with that tag inside Raycast, or **⌘↵** to open the search on Scryfall.

## No Setup Required

Scrycast uses the public Scryfall API — no API key or account needed.

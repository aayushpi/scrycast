import { readFile } from "node:fs/promises";

export const COLLECTION_IDS_KEY = "collectionIds";

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Parses a ManaBox CSV and returns an array of Scryfall IDs.
export async function parseCollectionCSV(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV appears empty or has no data rows");

  const headers = parseCSVLine(lines[0]);
  const idCol = headers.indexOf("Scryfall ID");
  if (idCol === -1) throw new Error('Could not find "Scryfall ID" column — is this a ManaBox CSV?');

  const ids: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const id = parseCSVLine(lines[i])[idCol]?.trim();
      if (id) ids.push(id);
    } catch {
      // skip malformed rows
    }
  }

  if (ids.length === 0) throw new Error("No Scryfall IDs found in CSV");
  return ids;
}

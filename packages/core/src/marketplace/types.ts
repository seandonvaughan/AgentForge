export interface EntryMetadata {
  author?: string;
  version?: string;
  tags?: string[];
  category?: string;
  license?: string;
  homepage?: string;
}

export interface MarketplaceEntry {
  id: string;
  name: string;
  description: string;
  agentType: string;
  metadata: EntryMetadata;
  yamlPath?: string;
  installedAt?: string;
  publishedAt: string;
  downloadCount: number;
  rating: number;
}

export interface InstallResult {
  success: boolean;
  entryId: string;
  installedPath?: string;
  error?: string;
}

export interface MarketplaceStats {
  totalEntries: number;
  totalInstalls: number;
  categories: Record<string, number>;
  topRated: MarketplaceEntry[];
}

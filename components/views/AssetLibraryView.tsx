"use client";
import AssetCatalogView from "@/components/views/AssetCatalogView";
import type { Asset } from "@/lib/useAssetIcons";
export default function AssetLibraryView(
  _props: {
    ownerId?: string;
    initialListing?: import("@/lib/workspaceInitial").WorkspaceInitial["material"];
    initialCdnEnabled?: boolean;
    initialAssets?: Asset[];
    initialTotal?: number;
  } = {},
) {
  return <AssetCatalogView ownerId={_props.ownerId} initial={_props.initialListing} />;
}

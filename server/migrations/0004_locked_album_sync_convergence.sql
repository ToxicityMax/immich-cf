ALTER TABLE "album_asset_audit" ADD COLUMN "relationUpdateId" TEXT;

DROP TRIGGER IF EXISTS "TR_album_asset_delete_audit";
CREATE TRIGGER "TR_album_asset_delete_audit"
AFTER DELETE ON "album_asset" FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "sync_delete_guard" WHERE "entityType" = 'album' AND "entityId" = OLD."albumId"
)
BEGIN
  INSERT INTO "album_asset_audit" ("id", "albumId", "assetId", "visibility", "relationUpdateId") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    OLD."albumId", OLD."assetId", (SELECT "visibility" FROM "asset" WHERE "id" = OLD."assetId"), OLD."updateId"
  );
END;

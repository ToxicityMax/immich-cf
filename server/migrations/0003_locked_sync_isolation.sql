ALTER TABLE "asset_audit" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'delete';
ALTER TABLE "asset_audit" ADD COLUMN "visibility" TEXT;
ALTER TABLE "stack_audit" ADD COLUMN "visibility" TEXT;
ALTER TABLE "album_asset_audit" ADD COLUMN "visibility" TEXT;
ALTER TABLE "memory_asset_audit" ADD COLUMN "visibility" TEXT;
ALTER TABLE "asset_metadata_audit" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "asset_metadata_audit" ADD COLUMN "visibility" TEXT;
ALTER TABLE "asset_edit_audit" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "asset_edit_audit" ADD COLUMN "visibility" TEXT;

DROP TRIGGER IF EXISTS "TR_asset_delete_audit";
CREATE TRIGGER "TR_asset_delete_audit"
AFTER DELETE ON "asset" FOR EACH ROW
BEGIN
  INSERT INTO "asset_audit" ("id", "assetId", "ownerId", "reason", "visibility") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    OLD."id", OLD."ownerId", 'delete', OLD."visibility"
  );
END;

CREATE TRIGGER "TR_asset_lock_audit"
AFTER UPDATE OF "visibility" ON "asset" FOR EACH ROW
WHEN OLD."visibility" != 'locked' AND NEW."visibility" = 'locked'
BEGIN
  INSERT INTO "asset_audit" ("id", "assetId", "ownerId", "reason", "visibility") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    NEW."id", NEW."ownerId", 'lock', NEW."visibility"
  );
END;

DROP TRIGGER IF EXISTS "TR_stack_delete_audit";
CREATE TRIGGER "TR_stack_delete_audit"
AFTER DELETE ON "stack" FOR EACH ROW
BEGIN
  INSERT INTO "stack_audit" ("id", "stackId", "userId", "visibility") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    OLD."id", OLD."ownerId", (SELECT "visibility" FROM "asset" WHERE "id" = OLD."primaryAssetId")
  );
END;

DROP TRIGGER IF EXISTS "TR_album_asset_delete_audit";
CREATE TRIGGER "TR_album_asset_delete_audit"
AFTER DELETE ON "album_asset" FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "sync_delete_guard" WHERE "entityType" = 'album' AND "entityId" = OLD."albumId"
)
BEGIN
  INSERT INTO "album_asset_audit" ("id", "albumId", "assetId", "visibility") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    OLD."albumId", OLD."assetId", (SELECT "visibility" FROM "asset" WHERE "id" = OLD."assetId")
  );
END;

DROP TRIGGER IF EXISTS "TR_memory_asset_delete_audit";
CREATE TRIGGER "TR_memory_asset_delete_audit"
AFTER DELETE ON "memory_asset" FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "sync_delete_guard" WHERE "entityType" = 'memory' AND "entityId" = OLD."memoriesId"
)
BEGIN
  INSERT INTO "memory_asset_audit" ("id", "memoryId", "assetId", "visibility") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    OLD."memoriesId", OLD."assetId", (SELECT "visibility" FROM "asset" WHERE "id" = OLD."assetId")
  );
END;

DROP TRIGGER IF EXISTS "TR_asset_metadata_delete_audit";
CREATE TRIGGER "TR_asset_metadata_delete_audit"
AFTER DELETE ON "asset_metadata" FOR EACH ROW
BEGIN
  INSERT INTO "asset_metadata_audit" ("id", "assetId", "key", "ownerId", "visibility") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    OLD."assetId", OLD."key", (SELECT "ownerId" FROM "asset" WHERE "id" = OLD."assetId"),
    (SELECT "visibility" FROM "asset" WHERE "id" = OLD."assetId")
  );
END;

DROP TRIGGER IF EXISTS "TR_asset_edit_delete_audit";
CREATE TRIGGER "TR_asset_edit_delete_audit"
AFTER DELETE ON "asset_edit" FOR EACH ROW
BEGIN
  INSERT INTO "asset_edit_audit" ("id", "editId", "assetId", "ownerId", "visibility") VALUES (
    lower(printf('%08x-%04x-7%03x-%04x-%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) >> 16, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) & 65535, random() & 4095, (random() & 16383) | 32768, random() & 281474976710655)),
    OLD."id", OLD."assetId", (SELECT "ownerId" FROM "asset" WHERE "id" = OLD."assetId"),
    (SELECT "visibility" FROM "asset" WHERE "id" = OLD."assetId")
  );
END;

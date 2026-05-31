-- Link a git source to a Product. A product can own many repos; a repo
-- maps to (at most) one product. On sync, each synced doc is tagged with
-- this product (doc_tags kind='product'), which drives `search_docs`
-- scope defaults — so git-mirrored docs surface for the right users
-- automatically instead of relying on a folder prefix.
--
-- Additive ALTER. NULL = no product association (docs stay untagged →
-- globally visible, the open-read default). ON DELETE SET NULL so
-- deleting a product detaches its sources rather than cascading.
ALTER TABLE git_sources ADD COLUMN product_id TEXT REFERENCES products(id) ON DELETE SET NULL;

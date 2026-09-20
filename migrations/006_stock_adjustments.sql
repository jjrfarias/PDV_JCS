ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_check;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_kind_check CHECK(kind IN('INITIAL','SALE','ADJUSTMENT')),
  ADD CONSTRAINT stock_movements_check CHECK(
    (kind='SALE' AND quantity<0 AND sale_id IS NOT NULL)
    OR (kind='INITIAL' AND quantity>0 AND sale_id IS NULL)
    OR (kind='ADJUSTMENT' AND sale_id IS NULL)
  );

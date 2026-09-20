ALTER TABLE cash_movements ADD COLUMN reason TEXT;

ALTER TABLE cash_movements DISABLE TRIGGER USER;

UPDATE cash_movements
SET reason = CASE kind
  WHEN 'OPENING' THEN 'Fundo inicial'
  ELSE 'Venda em dinheiro'
END
WHERE reason IS NULL;

ALTER TABLE cash_movements ALTER COLUMN reason SET NOT NULL;

ALTER TABLE cash_movements ENABLE TRIGGER USER;

ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_kind_check;
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_amount_cents_check;
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_check;

ALTER TABLE cash_movements
  ADD CONSTRAINT cash_movements_kind_check CHECK(kind IN('OPENING','SALE','SUPPLY','WITHDRAWAL')),
  ADD CONSTRAINT cash_movements_amount_cents_check CHECK(amount_cents BETWEEN -100000000 AND 100000000),
  ADD CONSTRAINT cash_movements_check CHECK(
    (kind='SALE' AND sale_id IS NOT NULL AND amount_cents>0)
    OR (kind='OPENING' AND sale_id IS NULL AND amount_cents>=0)
    OR (kind='SUPPLY' AND sale_id IS NULL AND amount_cents>0)
    OR (kind='WITHDRAWAL' AND sale_id IS NULL AND amount_cents<0)
  );

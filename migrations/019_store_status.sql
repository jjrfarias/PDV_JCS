-- Loja desativada some dos seletores e deixa de operar; todo o histórico permanece.
-- Exclusão definitiva não existe: vendas, caixas e estoque são registros imutáveis.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1));

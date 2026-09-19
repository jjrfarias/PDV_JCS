import { one, run } from './postgres.mjs';

export class PostgresOperations {
  constructor(client) { this.client = client; }

  async lock(tenantId, key) {
    // Serialize only retries of this tenant/key, including before an operation row exists.
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['pdv-operation', tenantId, key])]);
  }

  async find(tenantId, key) {
    return one(this.client,
      'SELECT * FROM operations WHERE tenant_id=$1 AND key=$2', [tenantId, key]);
  }

  async save({ tenantId, key, userId, storeId, kind, payloadHash, response }) {
    return run(this.client, `INSERT INTO operations
      (tenant_id,key,user_id,store_id,kind,payload_hash,response_json,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, key, userId, storeId, kind, payloadHash, JSON.stringify(response), new Date().toISOString()]);
  }
}
